// supabase/functions/shopify-proxy/index.ts

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SHOPIFY_STORE = 'dw30vw-wm.myshopify.com'
const SHOPIFY_ACCESS_TOKEN = Deno.env.get('SHOPIFY_ACCESS_TOKEN')
const SHOPIFY_API_VERSION = '2025-01'

// Ubicaciones para la automatización de stock pickup.
// Bvar España = stock físico real; Pick-UP = unidades comprometidas esperando retiro.
const LOCATION_ORIGEN_ID = Deno.env.get('SHOPIFY_LOCATION_ORIGEN_ID') || '81875665036' // Bvar España
const LOCATION_PICKUP_ID = Deno.env.get('SHOPIFY_LOCATION_PICKUP_ID') || '86714679436' // Pick-UP

const gidLocation = (id: string) => `gid://shopify/Location/${id}`
const gidInventoryItem = (id: number | string) => `gid://shopify/InventoryItem/${id}`

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-shopify-topic, x-shopify-hmac-sha256, x-shopify-shop-domain',
}

interface ShopifyAddress {
  first_name?: string
  last_name?: string
  name?: string
  address1: string
  address2?: string
  city: string
  province: string
  province_code: string
  zip: string
  country: string
  latitude?: number
  longitude?: number
  phone?: string
}

interface ShopifyOrder {
  id: number
  name: string
  order_number: number
  email?: string
  contact_email?: string | null
  phone?: string
  customer?: {
    id?: number
    first_name: string
    last_name: string
    phone: string
    email: string | null
  }
  shipping_address?: ShopifyAddress
  billing_address?: ShopifyAddress
  line_items?: ShopifyLineItem[]
  shipping_lines?: ShopifyShippingLine[]
  total_price?: string
  subtotal_price?: string
  total_shipping_price_set?: {
    shop_money: {
      amount: string
    }
  }
  financial_status?: string
  fulfillment_status?: string | null
  tags?: string
  note?: string
  created_at?: string
}

interface ShopifyDiscountAllocation {
  amount: string
  amount_set?: {
    shop_money: { amount: string; currency_code: string }
    presentment_money: { amount: string; currency_code: string }
  }
  discount_application_index: number
}

interface ShopifyLineItem {
  id: number
  title: string
  name: string
  sku: string
  variant_id: number
  variant_title: string
  quantity: number
  current_quantity?: number
  price: string
  product_id: number
  discount_allocations?: ShopifyDiscountAllocation[]
}

interface ShopifyShippingLine {
  id: number
  title: string
  price: string
  code: string
  source: string
}

// Cantidad real del item después de ediciones de Shopify.
function cantidadEfectiva(item: ShopifyLineItem): number {
  return item.current_quantity !== undefined ? item.current_quantity : item.quantity
}

function calcularPrecioNetoUnitario(item: ShopifyLineItem): number {
  const precioBruto = parseFloat(item.price)
  const descuentoTotal = (item.discount_allocations || []).reduce(
    (sum, d) => sum + parseFloat(d.amount || '0'), 0
  )

  if (item.quantity <= 0) return precioBruto
  if (descuentoTotal === 0) return precioBruto

  const netoUnitario = (precioBruto * item.quantity - descuentoTotal) / item.quantity
  const redondeado = Math.round(netoUnitario * 100) / 100

  console.log(`💰 Precio neto: $${item.price} x${item.quantity} - $${descuentoTotal} desc = $${redondeado}/u`)
  return redondeado
}

// Refetch del pedido por ID. SOLO se usa para orders/edited (cuyo body no trae la orden completa).
// OJO: la API enmascara la PII (customer/billing/shipping vienen vacíos), por eso para
// create/updated usamos el body del webhook que SÍ trae la PII completa.
async function fetchPedidoShopify(orderId: number | string): Promise<ShopifyOrder | null> {
  const fetchUrl = `https://${SHOPIFY_STORE}/admin/api/${SHOPIFY_API_VERSION}/orders/${orderId}.json`
  const response = await fetch(fetchUrl, {
    method: 'GET',
    headers: {
      'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN!,
      'Content-Type': 'application/json',
    },
  })

  if (!response.ok) {
    const errorText = await response.text()
    console.error(`Error refetcheando pedido ${orderId}: ${response.status} - ${errorText}`)
    return null
  }

  const data = await response.json()
  return data.order || null
}

// ==================== HELPERS SHOPIFY (AUTOMATIZACIÓN PICKUP) ====================

async function shopifyGraphQL(query: string, variables: Record<string, unknown>) {
  const response = await fetch(
    `https://${SHOPIFY_STORE}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
    {
      method: 'POST',
      headers: {
        'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN!,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query, variables }),
    }
  )

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`GraphQL HTTP ${response.status}: ${errorText}`)
  }

  const data = await response.json()
  if (data.errors && data.errors.length > 0) {
    throw new Error(`GraphQL errors: ${JSON.stringify(data.errors)}`)
  }
  return data.data
}

// Fulfillment orders del pedido (REST). Traen inventory_item_id y fulfillable_quantity
// por line item: es la fuente confiable de QUÉ va a descontar Shopify al cumplir
// (refleja ediciones, ítems removidos, kits y variantes con SKU duplicado de Easify).
async function obtenerFulfillmentOrdersShopify(orderId: number | string): Promise<any[]> {
  const url = `https://${SHOPIFY_STORE}/admin/api/${SHOPIFY_API_VERSION}/orders/${orderId}/fulfillment_orders.json`
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN!,
      'Content-Type': 'application/json',
    },
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`Error obteniendo fulfillment_orders del pedido ${orderId}: ${response.status} - ${errorText}`)
  }

  const data = await response.json()
  return data.fulfillment_orders || []
}

// Conecta un inventory item a Pick-UP (con cantidad 0) para que inventoryMoveQuantities
// pueda moverle stock. Best-effort: si ya estaba activo, Shopify devuelve userErrors
// que ignoramos.
async function activarInventarioEnPickup(inventoryItemId: number | string): Promise<void> {
  const query = `mutation act($inventoryItemId: ID!, $locationId: ID!) {
    inventoryActivate(inventoryItemId: $inventoryItemId, locationId: $locationId) {
      inventoryLevel { id }
      userErrors { field message }
    }
  }`
  try {
    const data = await shopifyGraphQL(query, {
      inventoryItemId: gidInventoryItem(inventoryItemId),
      locationId: gidLocation(LOCATION_PICKUP_ID),
    })
    const userErrors = data?.inventoryActivate?.userErrors || []
    if (userErrors.length > 0) {
      console.warn(`inventoryActivate item ${inventoryItemId} en Pick-UP: ${JSON.stringify(userErrors)}`)
    }
  } catch (error) {
    console.warn(`No se pudo activar inventario item ${inventoryItemId} en Pick-UP: ${(error as Error).message}`)
  }
}

// ==================== AUTOMATIZACIÓN: STOCK BVAR ESPAÑA → PICK-UP ====================
// Cuando entra un pedido pickup, las N unidades de cada item se mueven de Bvar España
// a Pick-UP al momento de la venta. Así Bvar España refleja la salida física desde el
// minuto cero y Pick-UP acumula lo "comprometido" hasta el retiro (donde el fulfillment
// lo descuenta y vuelve a 0). El flujo de un click del server (marcarListoParaRetirar)
// queda como red de seguridad: su chequeo de available en Pick-UP hace que no vuelva a
// transferir lo que ya movió esta función.
//
// Idempotencia: tabla pickup_stock_moves (UNIQUE por shopify_order_id). Cada ejecución
// calcula el DELTA entre lo que el pedido necesita hoy (fulfillment orders abiertas) y
// lo ya registrado como movido. Eso hace que reintentos de webhook no dupliquen, y que
// orders/edited ajuste solo la diferencia (en ambas direcciones).
async function moverStockPickup(supabase: any, shopifyOrder: ShopifyOrder) {
  const orderId = String(shopifyOrder.id)
  console.log(`🏪 PICKUP: evaluando movimiento de stock para pedido #${shopifyOrder.name} (${orderId})`)

  const { data: registro, error: errReg } = await supabase
    .from('pickup_stock_moves')
    .select('*')
    .eq('shopify_order_id', orderId)
    .maybeSingle()

  if (errReg) {
    throw new Error(`Error leyendo pickup_stock_moves: ${errReg.message}`)
  }

  if (registro?.estado === 'cerrado') {
    console.log('⏭️ Registro cerrado (pedido ya retirado) — no se ajusta stock')
    return { ok: true, movido: false, motivo: 'registro cerrado' }
  }

  // GUARDA CRÍTICA: si el pedido ya está fulfilled, el retiro ya descontó las unidades
  // de Pick-UP. Cualquier ajuste acá (p.ej. el orders/updated que dispara el propio
  // fulfillment) "devolvería" stock que ya salió y Pick-UP quedaría negativo de nuevo.
  if (shopifyOrder.fulfillment_status === 'fulfilled') {
    if (registro) {
      await supabase
        .from('pickup_stock_moves')
        .update({ estado: 'cerrado', updated_at: new Date().toISOString() })
        .eq('id', registro.id)
    }
    console.log('🔒 Pedido ya fulfilled — registro cerrado, sin movimientos')
    return { ok: true, movido: false, motivo: 'pedido ya fulfilled' }
  }

  let registroId = registro?.id ?? null
  if (!registro) {
    // Insert-first: el UNIQUE de shopify_order_id frena ejecuciones concurrentes
    // (orders/create y orders/updated suelen llegar con segundos de diferencia).
    const { data: insertado, error: errIns } = await supabase
      .from('pickup_stock_moves')
      .insert({
        shopify_order_id: orderId,
        numero_pedido: String(shopifyOrder.order_number),
        items: [],
        estado: 'procesando',
      })
      .select()
      .single()

    if (errIns) {
      if (errIns.code === '23505') {
        console.log('⏭️ Otra ejecución ya está procesando este pedido — skip')
        return { ok: true, movido: false, motivo: 'en proceso por otra ejecución' }
      }
      throw new Error(`Error insertando en pickup_stock_moves: ${errIns.message}`)
    }
    registroId = insertado.id
  }

  // Cantidades que el pedido necesita HOY, según sus fulfillment orders abiertas.
  const fos = await obtenerFulfillmentOrdersShopify(orderId)
  const fosAbiertas = fos.filter((fo: any) => fo.status === 'open' || fo.status === 'in_progress')
  // Si Shopify marcó FOs como pick_up usamos solo esas; si el pickup es una tarifa de
  // envío "Pick-Up" común (FO asignada a Bvar España), caemos a todas las abiertas.
  const fosPickup = fosAbiertas.filter((fo: any) => fo.delivery_method?.method_type === 'pick_up')
  const fosACubrir = fosPickup.length > 0 ? fosPickup : fosAbiertas

  const necesario = new Map<number, number>()
  for (const fo of fosACubrir) {
    for (const li of fo.line_items || []) {
      if (!li.inventory_item_id) continue
      const qty = Number(li.fulfillable_quantity ?? li.quantity ?? 0)
      if (qty <= 0) continue
      necesario.set(li.inventory_item_id, (necesario.get(li.inventory_item_id) || 0) + qty)
    }
  }

  const yaMovido = new Map<number, number>()
  for (const it of registro?.items || []) {
    yaMovido.set(Number(it.inventory_item_id), Number(it.cantidad) || 0)
  }

  // Devoluciones (delta negativo, por edición del pedido) solo si el pedido sigue 100%
  // sin fulfillment: con fulfillment parcial no podemos saber si esas unidades ya salieron.
  const permitirDevolucion = !shopifyOrder.fulfillment_status

  const changes: any[] = []
  const movidoFinal = new Map(yaMovido)
  const itemIds = new Set([...necesario.keys(), ...yaMovido.keys()])

  for (const itemId of itemIds) {
    const requerido = necesario.get(itemId) || 0
    const movido = yaMovido.get(itemId) || 0
    const delta = requerido - movido

    // inventoryMoveQuantities NO sirve entre sucursales distintas — la transferencia se
    // expresa como par de deltas atómicos (-N origen / +N destino) vía inventoryAdjustQuantities.
    if (delta > 0) {
      await activarInventarioEnPickup(itemId)
      changes.push(
        { inventoryItemId: gidInventoryItem(itemId), locationId: gidLocation(LOCATION_ORIGEN_ID), delta: -delta },
        { inventoryItemId: gidInventoryItem(itemId), locationId: gidLocation(LOCATION_PICKUP_ID), delta },
      )
      movidoFinal.set(itemId, requerido)
      console.log(`  → Mover ${delta} u. del item ${itemId} a Pick-UP (necesita ${requerido}, movido ${movido})`)
    } else if (delta < 0 && permitirDevolucion) {
      changes.push(
        { inventoryItemId: gidInventoryItem(itemId), locationId: gidLocation(LOCATION_PICKUP_ID), delta },
        { inventoryItemId: gidInventoryItem(itemId), locationId: gidLocation(LOCATION_ORIGEN_ID), delta: -delta },
      )
      movidoFinal.set(itemId, requerido)
      console.log(`  ← Devolver ${-delta} u. del item ${itemId} a Bvar España (edición del pedido)`)
    } else if (delta < 0) {
      console.warn(`  ⚠️ Item ${itemId}: habría que devolver ${-delta} u. pero hay fulfillment parcial — revisar a mano`)
    }
  }

  if (changes.length > 0) {
    const mutation = `mutation TransferToPickup($input: InventoryAdjustQuantitiesInput!) {
      inventoryAdjustQuantities(input: $input) {
        userErrors { field message }
      }
    }`

    const data = await shopifyGraphQL(mutation, {
      input: {
        reason: 'correction',
        name: 'available',
        referenceDocumentUri: `gid://shopify/Order/${orderId}`,
        changes,
      },
    })

    const userErrors = data?.inventoryAdjustQuantities?.userErrors || []
    if (userErrors.length > 0) {
      throw new Error(`inventoryAdjustQuantities userErrors: ${JSON.stringify(userErrors)}`)
    }
    console.log(`✅ Stock movido (${changes.length} cambio(s)) para pedido #${shopifyOrder.name}`)
  } else {
    console.log('✓ Sin diferencias de stock para mover (idempotente)')
  }

  const itemsFinales = [...movidoFinal.entries()]
    .filter(([, cantidad]) => cantidad > 0)
    .map(([inventory_item_id, cantidad]) => ({ inventory_item_id, cantidad }))

  const { error: errUpd } = await supabase
    .from('pickup_stock_moves')
    .update({ items: itemsFinales, estado: 'movido', updated_at: new Date().toISOString() })
    .eq('id', registroId)

  if (errUpd) {
    throw new Error(`Error actualizando pickup_stock_moves: ${errUpd.message}`)
  }

  return { ok: true, movido: changes.length > 0, cambios: changes.length }
}

serve(async (req) => {
  console.log('=== REQUEST RECIBIDO ===')
  console.log('Method:', req.method)
  console.log('URL:', req.url)
  console.log('Headers:', Object.fromEntries(req.headers.entries()))

  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const url = new URL(req.url)
    const path = url.pathname

    console.log('Path:', path)

    if (path.includes('/webhook') && req.method === 'POST') {
      const topic = req.headers.get('x-shopify-topic')

      console.log('Topic:', topic)

      if (topic === 'orders/create' || topic === 'orders/updated' || topic === 'orders/edited') {
        console.log(`Webhook recibido: ${topic}`)

        const webhookPayload = await req.json()

        let shopifyOrder: ShopifyOrder

        if (topic === 'orders/edited') {
          // El body de orders/edited es { order_edit: {...} } sin la orden completa.
          // Refetcheamos por ID para tener los line_items actualizados.
          // (La PII vendrá vacía, pero el update protege los datos ya guardados.)
          const orderId = webhookPayload.order_edit?.order_id || webhookPayload.id
          console.log(`orders/edited → refetcheando pedido ${orderId} para line_items actualizados...`)
          const fetched = await fetchPedidoShopify(orderId)
          if (!fetched) {
            return new Response(
              JSON.stringify({ error: 'No se pudo obtener el pedido desde Shopify' }),
              { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
            )
          }
          shopifyOrder = fetched
        } else {
          // orders/create y orders/updated: el body ES la orden completa con PII + current_quantity.
          shopifyOrder = webhookPayload as ShopifyOrder
        }

        console.log('Pedido completo:', JSON.stringify(shopifyOrder, null, 2))
        console.log(`Pedido #${shopifyOrder.name} - ID: ${shopifyOrder.id}`)
        console.log(`Estado financiero: ${shopifyOrder.financial_status}`)

        if (shopifyOrder.financial_status !== 'paid') {
          console.log(`⏭️ Pedido #${shopifyOrder.name} ignorado - Estado: ${shopifyOrder.financial_status}`)
          return new Response(
            JSON.stringify({
              success: true,
              skipped: true,
              mensaje: `Pedido ignorado - estado financiero: ${shopifyOrder.financial_status}`
            }),
            { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          )
        }

        const result = await procesarPedidoShopify(shopifyOrder)

        return new Response(
          JSON.stringify(result),
          {
            status: result.success ? 200 : 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          }
        )
      }

      return new Response(
        JSON.stringify({ error: 'Webhook topic no reconocido' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const { action, orderNumber, orderId, tag, note, trackingNumber, trackingCompany } = await req.json()

    console.log(`Accion recibida: ${action}`)

    if (action === 'reprocessOrder') {
      console.log(`Re-procesando pedido #${orderNumber}`)

      const searchUrl = `https://${SHOPIFY_STORE}/admin/api/${SHOPIFY_API_VERSION}/orders.json?name=%23${orderNumber}&status=any`
      const searchResponse = await fetch(searchUrl, {
        method: 'GET',
        headers: {
          'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN!,
          'Content-Type': 'application/json',
        },
      })

      console.log(`Shopify status: ${searchResponse.status}`)

      if (!searchResponse.ok) {
        const errorText = await searchResponse.text()
        console.error('Error Shopify:', errorText)
        return new Response(
          JSON.stringify({ error: `Error al buscar pedido en Shopify: ${searchResponse.status}` }),
          { status: searchResponse.status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }

      const searchData = await searchResponse.json()
      console.log(`Pedidos encontrados: ${searchData.orders?.length ?? 0}`)

      if (!searchData.orders || searchData.orders.length === 0) {
        return new Response(
          JSON.stringify({ error: `Pedido #${orderNumber} no encontrado en Shopify` }),
          { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }

      // NOTA: la API (search/get) puede devolver la PII enmascarada. Para pedidos que
      // ya existen en BD, el update protege los datos. Para pedidos nuevos vía reprocess,
      // la PII puede quedar vacía (limitación de la API; el flujo normal es el webhook).
      const shopifyOrder: ShopifyOrder = searchData.orders[0]

      if (shopifyOrder.financial_status !== 'paid') {
        return new Response(
          JSON.stringify({ error: `Pedido #${orderNumber} no está pagado (estado: ${shopifyOrder.financial_status})` }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }

      const result = await procesarPedidoShopify(shopifyOrder)

      return new Response(
        JSON.stringify(result),
        {
          status: result.success ? 200 : 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        }
      )
    }

    if (action === 'searchOrder') {
      console.log(`Buscando pedido #${orderNumber}`)

      const searchUrl = `https://${SHOPIFY_STORE}/admin/api/${SHOPIFY_API_VERSION}/orders.json?name=%23${orderNumber}&status=any`

      const response = await fetch(searchUrl, {
        method: 'GET',
        headers: {
          'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN!,
          'Content-Type': 'application/json',
        },
      })

      if (!response.ok) {
        const errorText = await response.text()
        console.error('Error de Shopify:', errorText)
        return new Response(
          JSON.stringify({ error: `Error de Shopify: ${response.status}`, details: errorText }),
          { status: response.status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }

      const data = await response.json()

      if (data.orders && data.orders.length > 0) {
        console.log(`Pedido encontrado: ${data.orders[0].name}`)
        return new Response(
          JSON.stringify({ order: data.orders[0] }),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }

      console.log('Pedido no encontrado')
      return new Response(
        JSON.stringify({ order: null }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    if (action === 'addTag') {
      console.log(`Agregando etiqueta "${tag}" al pedido #${orderNumber}`)

      const searchUrl = `https://${SHOPIFY_STORE}/admin/api/${SHOPIFY_API_VERSION}/orders.json?name=%23${orderNumber}&status=any`
      const searchResponse = await fetch(searchUrl, {
        method: 'GET',
        headers: {
          'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN!,
          'Content-Type': 'application/json',
        },
      })

      if (!searchResponse.ok) {
        return new Response(
          JSON.stringify({ error: 'Error al buscar pedido' }),
          { status: searchResponse.status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }

      const searchData = await searchResponse.json()

      if (!searchData.orders || searchData.orders.length === 0) {
        return new Response(
          JSON.stringify({ error: 'Pedido no encontrado' }),
          { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }

      const order = searchData.orders[0]
      const currentTags = order.tags ? order.tags.split(', ') : []

      if (!currentTags.includes(tag)) {
        currentTags.push(tag)
      }

      const newTags = currentTags.join(', ')

      const updateUrl = `https://${SHOPIFY_STORE}/admin/api/${SHOPIFY_API_VERSION}/orders/${order.id}.json`
      const updateResponse = await fetch(updateUrl, {
        method: 'PUT',
        headers: {
          'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN!,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          order: {
            id: order.id,
            tags: newTags
          }
        })
      })

      if (!updateResponse.ok) {
        const errorText = await updateResponse.text()
        console.error('Error al actualizar etiquetas:', errorText)
        return new Response(
          JSON.stringify({ error: 'Error al agregar etiqueta', details: errorText }),
          { status: updateResponse.status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }

      console.log('Etiqueta agregada exitosamente')
      return new Response(
        JSON.stringify({ success: true }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    if (action === 'addNote') {
      console.log(`Agregando nota al pedido ID: ${orderId}`)

      const updateUrl = `https://${SHOPIFY_STORE}/admin/api/${SHOPIFY_API_VERSION}/orders/${orderId}.json`

      const response = await fetch(updateUrl, {
        method: 'PUT',
        headers: {
          'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN!,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          order: {
            id: orderId,
            note: note
          }
        })
      })

      if (!response.ok) {
        const errorText = await response.text()
        console.error('Error al agregar nota:', errorText)
        return new Response(
          JSON.stringify({ error: 'Error al agregar nota', details: errorText }),
          { status: response.status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }

      console.log('Nota agregada exitosamente')
      return new Response(
        JSON.stringify({ success: true }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    if (action === 'fulfillOrder') {
      console.log(`Marcando pedido como preparado - ID: ${orderId}`)

      const orderUrl = `https://${SHOPIFY_STORE}/admin/api/${SHOPIFY_API_VERSION}/orders/${orderId}.json`
      const orderResponse = await fetch(orderUrl, {
        method: 'GET',
        headers: {
          'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN!,
          'Content-Type': 'application/json',
        },
      })

      if (!orderResponse.ok) {
        return new Response(
          JSON.stringify({ error: 'Error al obtener información del pedido' }),
          { status: orderResponse.status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }

      const orderData = await orderResponse.json()
      const order = orderData.order

      const lineItems = order.line_items
        .filter((item: any) => !item.fulfillment_status || item.fulfillment_status === null)
        .map((item: any) => ({
          id: item.id,
          quantity: item.quantity
        }))

      if (lineItems.length === 0) {
        console.log('El pedido ya esta completamente preparado')
        return new Response(
          JSON.stringify({ error: 'El pedido ya está completamente preparado' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }

      const fulfillUrl = `https://${SHOPIFY_STORE}/admin/api/${SHOPIFY_API_VERSION}/orders/${orderId}/fulfillments.json`

      const fulfillmentData: any = {
        fulfillment: {
          line_items: lineItems,
          notify_customer: true
        }
      }

      if (trackingNumber) {
        fulfillmentData.fulfillment.tracking_info = {
          number: trackingNumber,
          company: trackingCompany || 'UES - Correo Uruguayo'
        }
      }

      const fulfillResponse = await fetch(fulfillUrl, {
        method: 'POST',
        headers: {
          'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN!,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(fulfillmentData)
      })

      if (!fulfillResponse.ok) {
        const errorText = await fulfillResponse.text()
        console.error('Error al crear fulfillment:', errorText)
        return new Response(
          JSON.stringify({ error: 'Error al marcar como preparado', details: errorText }),
          { status: fulfillResponse.status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }

      const fulfillData = await fulfillResponse.json()
      console.log('Pedido marcado como preparado exitosamente')

      return new Response(
        JSON.stringify({ success: true, fulfillment: fulfillData.fulfillment }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    return new Response(
      JSON.stringify({ error: 'Acción no reconocida' }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (error: any) {
    console.error('Error general:', error)
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})

function detectarTipoEnvio(shopifyOrder: ShopifyOrder): { esExpress: boolean; tipoEnvio: string } {
  const shippingLines = shopifyOrder.shipping_lines || []

  for (const line of shippingLines) {
    const titulo = (line.title || '').toLowerCase()
    const codigo = (line.code || '').toLowerCase()

    if (titulo.includes('express') || codigo.includes('express')) {
      console.log(`⚡ ENVÍO EXPRESS detectado: "${line.title}"`)
      return { esExpress: true, tipoEnvio: 'estandar' }
    }

    if (titulo.includes('pick-up') || titulo.includes('pick up') || titulo.includes('pickup')) {
      console.log(`🏪 PICK-UP detectado: "${line.title}"`)
      return { esExpress: false, tipoEnvio: 'pickup_local' }
    }

    if (titulo.includes('recibilo')) {
      console.log(`⚡ RECIBILO HOY detectado: "${line.title}"`)
      return { esExpress: false, tipoEnvio: 'recibilo_hoy' }
    }
  }

  console.log('📦 Envío estándar')
  return { esExpress: false, tipoEnvio: 'estandar' }
}

async function procesarPedidoShopify(shopifyOrder: ShopifyOrder) {
  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    const { esExpress: esEnvioExpress, tipoEnvio } = detectarTipoEnvio(shopifyOrder)
    console.log(`=== TIPO DE ENVÍO: ${tipoEnvio.toUpperCase()} | Express: ${esEnvioExpress} ===`)

    console.log('=== PASO 1: Mapeando productos desde Shopify ===')
    const productosResult = await mapearProductosShopify(supabase, shopifyOrder.line_items || [])

    if (!productosResult.success) {
      console.error('ERROR en mapeo de productos:', productosResult.error)
      return { success: false, error: productosResult.error }
    }

    console.log('Productos mapeados exitosamente:', JSON.stringify(productosResult.items, null, 2))

    console.log('=== PASO 2: Creando/actualizando pedido en base de datos ===')
    const pedido = await crearPedidoEnDB(supabase, shopifyOrder, productosResult.items, esEnvioExpress, tipoEnvio)

    console.log('=== PASO 3: Agregando tags en Shopify ===')
    try {
      await agregarTagShopifyDirecto(shopifyOrder.id, 'ETIQUETA CREADA')
      console.log('✅ Tag "ETIQUETA CREADA" agregado en Shopify')

      if (esEnvioExpress) {
        await agregarTagShopifyDirecto(shopifyOrder.id, 'ENVIO EXPRESS')
        console.log('✅ Tag "ENVIO EXPRESS" agregado en Shopify')
      }
      if (tipoEnvio === 'pickup_local') {
        await agregarTagShopifyDirecto(shopifyOrder.id, 'PICK-UP')
        console.log('✅ Tag "PICK-UP" agregado en Shopify')
      } else if (tipoEnvio === 'recibilo_hoy') {
        await agregarTagShopifyDirecto(shopifyOrder.id, 'RECIBILO HOY')
        console.log('✅ Tag "RECIBILO HOY" agregado en Shopify')
      }
    } catch (errorTag) {
      console.error('⚠️ Error al agregar tag en Shopify:', errorTag)
    }

    let resultadoStockPickup: any = null
    if (tipoEnvio === 'pickup_local') {
      console.log('=== PASO 4: Moviendo stock Bvar España → Pick-UP (pedido pickup) ===')
      try {
        resultadoStockPickup = await moverStockPickup(supabase, shopifyOrder)
      } catch (errorMove: any) {
        // No tumbamos el webhook: el pedido ya quedó creado en BD. El próximo webhook
        // del pedido (updated/edited) reintenta el delta pendiente, y el tag deja el
        // problema visible en el admin para resolverlo a mano si persiste.
        console.error('⚠️ Error moviendo stock a Pick-UP:', errorMove)
        resultadoStockPickup = { ok: false, error: errorMove.message }
        try {
          await agregarTagShopifyDirecto(shopifyOrder.id, 'ERROR STOCK PICKUP')
        } catch (_) {
          // best-effort
        }
      }
    }

    console.log('=== PEDIDO PROCESADO EXITOSAMENTE ===')
    console.log('ID del pedido:', pedido.id)
    console.log('Numero de pedido:', pedido.numero_pedido)
    console.log('Express:', esEnvioExpress)

    return {
      success: true,
      pedido_id: pedido.id,
      numero_pedido: pedido.numero_pedido,
      es_envio_express: esEnvioExpress,
      stock_pickup: resultadoStockPickup,
      mensaje: `Pedido procesado exitosamente${esEnvioExpress ? ' (EXPRESS)' : ''} con tag en Shopify`
    }

  } catch (error: any) {
    console.error('ERROR COMPLETO procesando pedido:', error)
    console.error('Stack trace:', error.stack)
    return { success: false, error: error.message, stack: error.stack }
  }
}

async function mapearProductosShopify(supabase: any, lineItems: ShopifyLineItem[]) {
  console.log(`Procesando ${lineItems.length} line items de Shopify...`)
  console.log('Line items recibidos:', JSON.stringify(lineItems, null, 2))

  // Filtrar items eliminados vía order editing (current_quantity = 0)
  const lineItemsActivos = lineItems.filter(item => {
    const qty = cantidadEfectiva(item)
    if (qty <= 0) {
      console.log(`🗑️ Item eliminado en Shopify (current_quantity=0): "${item.name}" SKU: ${item.sku}`)
      return false
    }
    return true
  })

  console.log(`Items activos después de filtrar eliminados: ${lineItemsActivos.length}`)

  const items: any[] = []
  const consumidoPorKit: Record<string, number> = {}
  let productoColorKit: { item: ShopifyLineItem; producto: any } | null = null

  for (const item of lineItemsActivos) {
    const nombre = (item.name || item.title || '').toLowerCase()
    const qty = cantidadEfectiva(item)

    console.log(`🔍 Analizando: "${item.name}" | SKU: ${item.sku || '(sin SKU)'} | Cant: ${qty} | Precio bruto: $${item.price} | Precio neto: $${calcularPrecioNetoUnitario(item)}`)

    if (nombre.includes('express') && (!item.sku || item.sku.trim() === '')) {
      console.log(`⚡ Saltando line_item de envío express: "${item.name}"`)
      continue
    }

    if (nombre.includes('kit')) {
      console.log(`✅ KIT detectado por nombre: "${item.name}"`)

      if (item.sku && item.sku.trim() !== '') {
        const { data: productoColor } = await supabase
          .from('productos')
          .select('id, nombre, sku, precio, es_kit, categoria')
          .ilike('sku', item.sku.trim())
          .maybeSingle()

        if (productoColor) {
          productoColorKit = { item, producto: productoColor }
          console.log(`  🎨 Color del kit: "${productoColor.nombre}" (SKU: ${item.sku})`)
        } else {
          console.warn(`  ⚠️ SKU del color no encontrado en BD: ${item.sku}`)
          productoColorKit = { item, producto: null }
        }
      } else {
        console.warn(`  ⚠️ Kit sin SKU de color`)
        productoColorKit = { item, producto: null }
      }
      break
    }
  }

  if (productoColorKit) {
    console.log('=== PROCESANDO COMO KIT ===')

    const { data: kitBase } = await supabase
      .from('productos')
      .select('id, nombre, sku, precio')
      .eq('sku', 'KITSTARTER')
      .eq('es_kit', true)
      .maybeSingle()

    if (!kitBase) {
      console.error('❌ KITSTARTER no encontrado en BD')
      return { success: false, error: 'No se encontró el producto KITSTARTER en la base de datos' }
    }

    const { data: componentesRaw, error: errorComp } = await supabase
      .from('kit_componentes')
      .select(`
        id, kit_id, producto_id, cantidad, es_opcional,
        productos:productos!kit_componentes_producto_id_fkey(
          id, nombre, sku, stock, costo_compra, categoria
        )
      `)
      .eq('kit_id', kitBase.id)
      .eq('es_opcional', false)

    if (errorComp) {
      return { success: false, error: `Error cargando componentes del kit: ${errorComp.message}` }
    }

    const componentesKit: any[] = componentesRaw || []
    const kitQty = cantidadEfectiva(productoColorKit.item)
    const precioNetoKit = calcularPrecioNetoUnitario(productoColorKit.item)

    console.log(`Kit base: ${kitBase.nombre} (ID: ${kitBase.id})`)
    console.log(`Precio neto del kit: $${precioNetoKit} (bruto: $${productoColorKit.item.price})`)
    console.log(`Componentes obligatorios: ${componentesKit.length}`)
    for (const c of componentesKit) {
      console.log(`  - ${c.productos?.nombre || '?'} | SKU: ${c.productos?.sku || '?'} | Cant: ${c.cantidad}`)
    }
    if (productoColorKit.producto) {
      console.log(`Color opcional: ${productoColorKit.producto.nombre} (ID: ${productoColorKit.producto.id})`)
    }

    items.push({
      producto_id: kitBase.id,
      cantidad: kitQty,
      precio_unitario: precioNetoKit,
      es_opcional: false,
      es_kit: true,
      sku: 'KITSTARTER',
      componentes_obligatorios: componentesKit,
      producto_opcional_id: productoColorKit.producto?.id || null
    })

    if (productoColorKit.item.sku && productoColorKit.item.sku.trim() !== '') {
      const skuColor = productoColorKit.item.sku.trim().toUpperCase()
      consumidoPorKit[skuColor] = (consumidoPorKit[skuColor] || 0) + kitQty
      console.log(`✓ Color del kit registrado: ${skuColor} consume ${kitQty} unidad(es)`)
    }

    for (const comp of componentesKit) {
      const compSku = String(comp.productos?.sku || '').trim().toUpperCase()
      if (compSku) {
        const cantComp = comp.cantidad * kitQty
        consumidoPorKit[compSku] = (consumidoPorKit[compSku] || 0) + cantComp
        console.log(`✓ Componente obligatorio registrado: ${compSku} consume ${cantComp} unidad(es)`)
      }
    }

    for (const item of lineItemsActivos) {
      if (!item.sku || item.sku.trim() === '') continue
      if (item.sku === 'ENVIO') continue

      const nombreItem = (item.name || item.title || '').toLowerCase()

      if (nombreItem.includes('kit')) {
        console.log(`⏭️ Saltando line_item del kit: ${item.name}`)
        continue
      }

      if (nombreItem.includes('express') && item.sku.trim() === '') {
        console.log(`⏭️ Saltando line_item de envío express: ${item.name}`)
        continue
      }

      const qty = cantidadEfectiva(item)
      const skuNorm = item.sku.trim().toUpperCase()
      const yaConsumido = consumidoPorKit[skuNorm] || 0
      const cantidadExtra = qty - yaConsumido

      if (cantidadExtra <= 0) {
        console.log(`⏭️ SKU ${item.sku} completamente consumido por kit (qty pedida: ${qty}, consumida por kit: ${yaConsumido})`)
        continue
      }

      const precioNeto = calcularPrecioNetoUnitario(item)
      console.log(`Procesando producto extra: ${item.name} | SKU: ${item.sku} | Qty extra: ${cantidadExtra} | Precio neto: $${precioNeto}`)

      const { data: producto } = await supabase
        .from('productos')
        .select('id, nombre, sku, precio, categoria')
        .ilike('sku', item.sku.trim())
        .maybeSingle()

      if (!producto) {
        console.warn(`⚠️ Producto extra no encontrado: ${item.name} (SKU: ${item.sku})`)
        continue
      }

      const precioBD = producto.precio || 0
      const esPrecioManual = Math.abs(precioNeto - precioBD) > 0.01

      items.push({
        producto_id: producto.id,
        cantidad: cantidadExtra,
        precio_unitario: precioNeto,
        precio_manual: esPrecioManual ? precioNeto : null,
        es_opcional: false,
        sku: item.sku
      })

      consumidoPorKit[skuNorm] = (consumidoPorKit[skuNorm] || 0) + cantidadExtra
      console.log(`✓ Producto extra agregado: ${item.sku} (x${cantidadExtra}) a $${precioNeto}`)
    }

  } else {
    console.log('=== PRODUCTOS REGULARES ===')

    const skusProcesados = new Set<string>()

    for (const item of lineItemsActivos) {
      if (!item.sku || item.sku.trim() === '' || item.sku === 'ENVIO') continue
      if (skusProcesados.has(item.sku)) continue

      const nombreItem = (item.name || item.title || '').toLowerCase()
      if (nombreItem.includes('express') && (!item.sku || item.sku.trim() === '')) {
        console.log(`⚡ Saltando line_item de envío express: "${item.name}"`)
        continue
      }

      const qty = cantidadEfectiva(item)
      const precioNeto = calcularPrecioNetoUnitario(item)
      console.log(`Procesando: ${item.name} | SKU: ${item.sku} | Qty: ${qty} | Precio neto: $${precioNeto} (bruto: $${item.price})`)

      const { data: producto } = await supabase
        .from('productos')
        .select('id, nombre, sku, precio, categoria')
        .ilike('sku', item.sku.trim())
        .maybeSingle()

      if (!producto) {
        console.warn(`⚠️ Producto no encontrado: ${item.name} (SKU: ${item.sku})`)
        continue
      }

      const precioBD = producto.precio || 0
      const esPrecioManual = Math.abs(precioNeto - precioBD) > 0.01

      items.push({
        producto_id: producto.id,
        cantidad: qty,
        precio_unitario: precioNeto,
        precio_manual: esPrecioManual ? precioNeto : null,
        es_opcional: false,
        sku: item.sku
      })

      skusProcesados.add(item.sku)
    }
  }

  console.log(`=== MAPEO COMPLETADO: ${items.length} items ===`)
  console.log('Items finales:', JSON.stringify(items.map((i: any) => ({ sku: i.sku, es_kit: i.es_kit || false, cantidad: i.cantidad, precio_unitario: i.precio_unitario })), null, 2))

  if (items.length === 0) {
    return { success: false, error: 'No se encontraron productos válidos' }
  }

  return { success: true, items }
}

async function crearPedidoEnDB(
  supabase: any,
  shopifyOrder: ShopifyOrder,
  items: any[],
  esEnvioExpress: boolean,
  tipoEnvio: string = 'estandar'
) {
  let fecha: string
  if (shopifyOrder.created_at) {
    fecha = shopifyOrder.created_at.split('T')[0]
    console.log(`Usando fecha de Shopify: ${fecha} (original: ${shopifyOrder.created_at})`)
  } else {
    fecha = new Date().toISOString().split('T')[0]
    console.log(`Usando fecha actual: ${fecha}`)
  }

  const costoEnvio = parseFloat(
    shopifyOrder.total_shipping_price_set?.shop_money?.amount || '0'
  )

  // Fallback shipping_address → billing_address (pick-up deja shipping en null)
  const direccionFuente = shopifyOrder.shipping_address || shopifyOrder.billing_address

  if (!shopifyOrder.shipping_address && shopifyOrder.billing_address) {
    console.log('📍 shipping_address es null, usando billing_address (probablemente pick-up)')
  } else if (!direccionFuente) {
    console.warn('⚠️ Sin shipping_address ni billing_address en el pedido')
  }

  const direccion = direccionFuente
    ? `${direccionFuente.address1 || ''}${
        direccionFuente.address2 ? ' ' + direccionFuente.address2 : ''
      }`.trim()
    : ''

  const latitud = direccionFuente?.latitude ?? null
  const longitud = direccionFuente?.longitude ?? null

  // Nombre + apellido con fallback en cascada
  const firstName =
    shopifyOrder.customer?.first_name ||
    shopifyOrder.billing_address?.first_name ||
    shopifyOrder.shipping_address?.first_name ||
    ''

  const lastName =
    shopifyOrder.customer?.last_name ||
    shopifyOrder.billing_address?.last_name ||
    shopifyOrder.shipping_address?.last_name ||
    ''

  const clienteNombreCompleto = `${firstName} ${lastName}`.trim()

  let emailCliente = shopifyOrder.customer?.email || shopifyOrder.email || shopifyOrder.contact_email || ''

  if (!emailCliente && shopifyOrder.customer?.id) {
    console.log('⚠️ Email no encontrado, buscando en perfil del cliente...')
    try {
      const customerUrl = `https://${SHOPIFY_STORE}/admin/api/${SHOPIFY_API_VERSION}/customers/${shopifyOrder.customer.id}.json`
      const response = await fetch(customerUrl, {
        method: 'GET',
        headers: {
          'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN!,
          'Content-Type': 'application/json',
        },
      })
      if (response.ok) {
        const customerData = await response.json()
        if (customerData.customer?.email) {
          emailCliente = customerData.customer.email
          console.log(`✅ Email encontrado: ${emailCliente}`)
        }
      }
    } catch (error) {
      console.error('Error al buscar email del cliente:', error)
    }
  }

  const clienteTelefono =
    shopifyOrder.customer?.phone ||
    shopifyOrder.phone ||
    shopifyOrder.shipping_address?.phone ||
    shopifyOrder.billing_address?.phone ||
    ''

  console.log(`👤 Cliente: ${clienteNombreCompleto || '(vacío)'} | 📧 ${emailCliente || '(vacío)'} | 📞 ${clienteTelefono || '(vacío)'}`)
  console.log(`📍 Dirección: ${direccion || '(vacía)'} | ${direccionFuente?.city || '(sin ciudad)'} | ${direccionFuente?.province || '(sin provincia)'} | ${direccionFuente?.zip || '(sin zip)'}`)

  let notasPedido = `Pedido automatico de Shopify - ID: ${shopifyOrder.id}`
  if (esEnvioExpress) {
    notasPedido += ' | ⚡ ENVÍO EXPRESS'
  }

  // pedidoData para INSERT (pedido nuevo): usa todos los valores tal cual.
  const pedidoData: any = {
    fecha_pedido: fecha,
    numero_pedido: shopifyOrder.order_number.toString(),
    cliente_nombre: clienteNombreCompleto || 'Cliente Shopify',
    cliente_email: emailCliente,
    cliente_telefono: clienteTelefono,
    departamento: direccionFuente?.province || '',
    localidad: direccionFuente?.city || '',
    direccion_envio: direccion,
    codigo_postal: direccionFuente?.zip || '',
    latitud: latitud,
    longitud: longitud,
    estado: 'pendiente',
    descuento: 0,
    notas: notasPedido,
    es_envio_express: esEnvioExpress,
    tipo_envio: tipoEnvio
  }

  console.log('=== INSERTANDO PEDIDO EN BD ===')
  console.log(`Fecha: ${fecha} | Express: ${esEnvioExpress}`)

  let pedido: any
  const { data: pedidoInsertado, error: errorPedido } = await supabase
    .from('pedidos')
    .insert(pedidoData)
    .select()
    .single()

  if (errorPedido) {
    if (errorPedido.code === '23505') {
      console.log(`♻️ Pedido #${shopifyOrder.order_number} ya existe, actualizando contenido...`)

      const { data: pedidoExistente, error: errBusqueda } = await supabase
        .from('pedidos')
        .select('*')
        .eq('numero_pedido', String(shopifyOrder.order_number))
        .single()

      if (errBusqueda || !pedidoExistente) {
        console.error('ERROR buscando pedido existente:', errBusqueda)
        throw errBusqueda || new Error('Pedido existente no encontrado')
      }

      if (pedidoExistente.estado && pedidoExistente.estado !== 'pendiente') {
        console.log(`⚠️ Pedido #${shopifyOrder.order_number} en estado "${pedidoExistente.estado}", no se actualiza`)
        return pedidoExistente
      }

      // ====================================================================
      // UPDATE protegido: NO sobreescribimos la PII con valores vacíos.
      // Esto cubre el caso orders/edited (refetch API sin PII): se actualizan
      // los items/stock pero se conservan nombre/email/dirección originales.
      // ====================================================================
      const pedidoDataUpdate: any = {
        fecha_pedido: fecha,
        estado: 'pendiente',
        notas: notasPedido,
        es_envio_express: esEnvioExpress,
        tipo_envio: tipoEnvio
      }

      // Solo incluir campos PII si traen valor real (no vacío)
      if (clienteNombreCompleto) pedidoDataUpdate.cliente_nombre = clienteNombreCompleto
      if (emailCliente) pedidoDataUpdate.cliente_email = emailCliente
      if (clienteTelefono) pedidoDataUpdate.cliente_telefono = clienteTelefono
      if (direccionFuente?.province) pedidoDataUpdate.departamento = direccionFuente.province
      if (direccionFuente?.city) pedidoDataUpdate.localidad = direccionFuente.city
      if (direccion) pedidoDataUpdate.direccion_envio = direccion
      if (direccionFuente?.zip) pedidoDataUpdate.codigo_postal = direccionFuente.zip
      if (latitud !== null) pedidoDataUpdate.latitud = latitud
      if (longitud !== null) pedidoDataUpdate.longitud = longitud

      console.log('Campos a actualizar:', JSON.stringify(Object.keys(pedidoDataUpdate)))

      await revertirItemsPedido(supabase, pedidoExistente.id)

      const { data: pedidoActualizado, error: errUpd } = await supabase
        .from('pedidos')
        .update(pedidoDataUpdate)
        .eq('id', pedidoExistente.id)
        .select()
        .single()

      if (errUpd) {
        console.error('ERROR actualizando pedido:', errUpd)
        throw errUpd
      }

      pedido = pedidoActualizado
      console.log(`✓ Pedido #${shopifyOrder.order_number} actualizado (ID ${pedido.id})`)
    } else {
      console.error('ERROR creando pedido:', errorPedido)
      throw errorPedido
    }
  } else {
    pedido = pedidoInsertado
    console.log(`PEDIDO CREADO EN BD: ID ${pedido.id} - Fecha: ${fecha} - Express: ${esEnvioExpress}`)
  }

  const stockYaDescontado = new Set<string>()
  const contadorKits: Record<string, number> = {}

  console.log('=== INSERTANDO ITEMS DEL PEDIDO ===')

  for (const item of items) {

    if (item.es_kit) {
      console.log(`Procesando kit: ${item.sku}`)

      const { data: productoKit } = await supabase
        .from('productos')
        .select('nombre, precio')
        .eq('id', item.producto_id)
        .single()

      const nombreKit = productoKit?.nombre || item.sku

      if (!contadorKits[nombreKit]) {
        contadorKits[nombreKit] = 0
      }
      contadorKits[nombreKit]++
      const identificadorKit = `${nombreKit}#${contadorKits[nombreKit]}`
      console.log(`📦 Identificador del kit: ${identificadorKit}`)

      const precioShopify = item.precio_unitario
      const precioBD = productoKit?.precio || 0
      const esPrecioManual = Math.abs(precioShopify - precioBD) > 0.01

      const { error: errorItemKit } = await supabase
        .from('pedido_items')
        .insert({
          pedido_id: pedido.id,
          producto_id: item.producto_id,
          cantidad: item.cantidad,
          precio_unitario: precioShopify,
          precio_venta_manual: esPrecioManual ? precioShopify : null
        })

      if (errorItemKit) {
        console.error('ERROR insertando kit:', errorItemKit)
        throw errorItemKit
      }
      console.log(`✓ Kit insertado en pedido_items a $${precioShopify}`)

      for (const comp of item.componentes_obligatorios) {
        const productoId = String(comp.producto_id)
        const cantidadRequerida = comp.cantidad * item.cantidad
        const claveStock = `${productoId}-kit`

        if (stockYaDescontado.has(claveStock)) {
          console.log(`  ⚠️ Stock ya descontado: ${comp.productos?.nombre}, saltando`)
          continue
        }

        const { data: prodFresco } = await supabase
          .from('productos')
          .select('stock, costo_compra, nombre')
          .eq('id', productoId)
          .single()

        if (!prodFresco) {
          console.warn(`  ⚠️ Componente no encontrado: ID ${productoId}`)
          continue
        }

        const nuevoStock = (prodFresco.stock || 0) - cantidadRequerida
        await supabase.from('productos').update({ stock: nuevoStock }).eq('id', productoId)

        await supabase.from('movimientos_stock').insert({
          producto_id: productoId,
          tipo: 'venta',
          cantidad: -cantidadRequerida,
          costo_unitario: prodFresco.costo_compra || 0,
          costo_total: (prodFresco.costo_compra || 0) * cantidadRequerida,
          referencia_id: pedido.id,
          notas: `Kit: ${identificadorKit}`,
          fecha_movimiento: new Date().toISOString()
        })

        stockYaDescontado.add(claveStock)
        console.log(`  ✓ ${prodFresco.nombre}: ${prodFresco.stock} → ${nuevoStock} (-${cantidadRequerida})`)
      }

      if (item.producto_opcional_id) {
        const opcId = String(item.producto_opcional_id)
        const claveStockOpc = `${opcId}-kit`

        if (!stockYaDescontado.has(claveStockOpc)) {
          const { data: prodOpc } = await supabase
            .from('productos')
            .select('nombre, stock, costo_compra')
            .eq('id', opcId)
            .single()

          if (prodOpc) {
            const cantOpc = 1 * item.cantidad
            const nuevoStockOpc = (prodOpc.stock || 0) - cantOpc

            await supabase.from('productos').update({ stock: nuevoStockOpc }).eq('id', opcId)

            await supabase.from('movimientos_stock').insert({
              producto_id: opcId,
              tipo: 'venta',
              cantidad: -cantOpc,
              costo_unitario: prodOpc.costo_compra || 0,
              costo_total: (prodOpc.costo_compra || 0) * cantOpc,
              referencia_id: pedido.id,
              notas: `Kit: ${identificadorKit} (opcional: ${prodOpc.nombre})`,
              fecha_movimiento: new Date().toISOString()
            })

            stockYaDescontado.add(claveStockOpc)
            console.log(`  ✓ ${prodOpc.nombre}: ${prodOpc.stock} → ${nuevoStockOpc} (-${cantOpc})`)
          }
        }
      }

    } else {
      console.log(`Procesando producto regular: ${item.sku}`)

      const prodId = String(item.producto_id)

      if (stockYaDescontado.has(`${prodId}-kit`)) {
        console.log(`⏭️ ${item.sku} ya descontado como componente de kit, saltando`)
        continue
      }

      const { data: prod } = await supabase
        .from('productos')
        .select('nombre, stock, costo_compra, precio')
        .eq('id', prodId)
        .single()

      if (!prod) continue

      const precioShopify = item.precio_unitario
      const precioBD = prod.precio || 0
      const esPrecioManual = Math.abs(precioShopify - precioBD) > 0.01

      const { error: errorItem } = await supabase
        .from('pedido_items')
        .insert({
          pedido_id: pedido.id,
          producto_id: prodId,
          cantidad: item.cantidad,
          precio_unitario: precioShopify,
          precio_venta_manual: esPrecioManual ? precioShopify : null
        })

      if (errorItem) {
        console.error('ERROR insertando item:', errorItem)
        throw errorItem
      }

      const nuevoStock = (prod.stock || 0) - item.cantidad
      await supabase.from('productos').update({ stock: nuevoStock }).eq('id', prodId)

      await supabase.from('movimientos_stock').insert({
        producto_id: prodId,
        tipo: 'venta',
        cantidad: -item.cantidad,
        costo_unitario: prod.costo_compra || 0,
        costo_total: (prod.costo_compra || 0) * item.cantidad,
        referencia_id: pedido.id,
        notas: `Venta Shopify numero ${shopifyOrder.order_number}`,
        fecha_movimiento: new Date().toISOString()
      })

      stockYaDescontado.add(`${prodId}-regular`)
      console.log(`✓ ${prod.nombre}: ${prod.stock} → ${nuevoStock} (-${item.cantidad}) a $${precioShopify}`)
    }
  }

  if (costoEnvio > 0 && !esEnvioExpress) {
    console.log(`=== AGREGANDO ENVÍO ESTÁNDAR: $${costoEnvio} ===`)

    const { data: productoEnvio } = await supabase
      .from('productos')
      .select('id, nombre')
      .eq('sku', 'ENVIO')
      .maybeSingle()

    if (productoEnvio) {
      await supabase.from('pedido_items').insert({
        pedido_id: pedido.id,
        producto_id: productoEnvio.id,
        cantidad: 1,
        precio_unitario: costoEnvio,
        precio_venta_manual: null
      })
      console.log(`✓ Envío estándar agregado: $${costoEnvio}`)
    } else {
      console.warn('⚠️ Producto ENVIO no encontrado en BD')
    }
  } else if (esEnvioExpress) {
    console.log(`⚡ Pedido EXPRESS - No se agrega producto ENVIO estándar (costo shipping Shopify: $${costoEnvio})`)
  }

  console.log('=== TODOS LOS ITEMS PROCESADOS ===')
  return pedido
}

async function agregarTagShopifyDirecto(orderId: number, tag: string): Promise<void> {
  console.log(`Agregando tag "${tag}" al pedido ID ${orderId} en Shopify...`)

  const getUrl = `https://${SHOPIFY_STORE}/admin/api/${SHOPIFY_API_VERSION}/orders/${orderId}.json`
  const getResponse = await fetch(getUrl, {
    method: 'GET',
    headers: {
      'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN!,
      'Content-Type': 'application/json',
    },
  })

  if (!getResponse.ok) {
    const errorText = await getResponse.text()
    throw new Error(`Error al obtener pedido: ${getResponse.status} - ${errorText}`)
  }

  const orderData = await getResponse.json()
  const order = orderData.order

  const currentTags = order.tags ? order.tags.split(', ').filter((t: string) => t.trim() !== '') : []

  if (currentTags.includes(tag)) {
    console.log(`Tag "${tag}" ya existe`)
    return
  }

  currentTags.push(tag)
  const newTags = currentTags.join(', ')

  const updateResponse = await fetch(getUrl, {
    method: 'PUT',
    headers: {
      'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN!,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ order: { id: orderId, tags: newTags } })
  })

  if (!updateResponse.ok) {
    const errorText = await updateResponse.text()
    throw new Error(`Error al actualizar tags: ${updateResponse.status} - ${errorText}`)
  }

  console.log(`✅ Tag "${tag}" agregado exitosamente`)
}

async function revertirItemsPedido(supabase: any, pedidoId: string | number) {
  console.log(`=== REVIRTIENDO ITEMS DEL PEDIDO ${pedidoId} ===`)

  const { data: movimientos } = await supabase
    .from('movimientos_stock')
    .select('id, producto_id, cantidad')
    .eq('referencia_id', pedidoId)
    .eq('tipo', 'venta')

  for (const mov of movimientos || []) {
    const { data: prod } = await supabase
      .from('productos')
      .select('stock, nombre')
      .eq('id', mov.producto_id)
      .single()

    if (!prod) continue

    const stockRestaurado = (prod.stock || 0) - mov.cantidad
    await supabase.from('productos').update({ stock: stockRestaurado }).eq('id', mov.producto_id)
    console.log(`  ↩️ ${prod.nombre}: ${prod.stock} → ${stockRestaurado} (revertido ${mov.cantidad})`)
  }

  await supabase.from('movimientos_stock').delete().eq('referencia_id', pedidoId).eq('tipo', 'venta')
  await supabase.from('pedido_items').delete().eq('pedido_id', pedidoId)

  console.log(`✓ Items y movimientos previos eliminados`)
}

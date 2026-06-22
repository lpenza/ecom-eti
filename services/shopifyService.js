const axios = require('axios');
require('dotenv').config();

class ShopifyService {
  constructor() {
    this.domain = process.env.SHOPIFY_DOMAIN;
    this.accessToken = process.env.SHOPIFY_ACCESS_TOKEN;
    this.baseUrl = `https://${this.domain}/admin/api/2024-01`;
  }

  // Obtener headers
  getHeaders() {
    return {
      'X-Shopify-Access-Token': this.accessToken,
      'Content-Type': 'application/json'
    };
  }

  // Obtener órdenes
  async obtenerOrdenes(params = {}) {
    try {
      const defaultParams = {
        status: 'any',
        limit: 250,
        financial_status: 'paid,pending',
        ...params
      };

      const response = await axios.get(`${this.baseUrl}/orders.json`, {
        headers: this.getHeaders(),
        params: defaultParams
      });

      return response.data.orders;
    } catch (error) {
      throw new Error(`Error obteniendo órdenes de Shopify: ${error.message}`);
    }
  }

  // Obtener órdenes sin procesar
  async obtenerOrdenesSinProcesar() {
    return this.obtenerOrdenes({
      fulfillment_status: 'unfulfilled'
    });
  }

  // Obtener carritos abandonados de las últimas 72 horas con al menos 1h de antigüedad
  async obtenerCarritosAbandonados() {
    try {
      const desde72h = new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString();
      console.log('[Shopify] ▶ Consultando checkouts abandonados desde:', desde72h);

      const response = await axios.get(`${this.baseUrl}/checkouts.json`, {
        headers: this.getHeaders(),
        params: {
          created_at_min: desde72h,
          status: 'open',
          limit: 250,
        },
      });

      const checkouts = response.data.checkouts || [];

      // Filtrar: al menos 1 hora de abandono y que tenga productos
      const hace1h = Date.now() - 60 * 60 * 1000;
      return checkouts.filter(c => {
        const actualizado = new Date(c.updated_at).getTime();
        return actualizado < hace1h && (c.line_items || []).length > 0;
      });
    } catch (error) {
      throw new Error(`Error obteniendo carritos abandonados de Shopify: ${error.message}`);
    }
  }

  // Obtener datos completos de un cliente por su ID
  async obtenerCliente(customerId) {
    try {
      const response = await axios.get(`${this.baseUrl}/customers/${customerId}.json`, {
        headers: this.getHeaders(),
      });
      return response.data.customer || null;
    } catch (err) {
      console.warn(`[Shopify] obtenerCliente(${customerId}) falló: ${err.response?.status} ${err.message}`);
      return null;
    }
  }

  // Extrae el teléfono de un objeto customer de Shopify, chequeando todos los niveles posibles
  extraerTelefonoCliente(cliente) {
    if (!cliente) return null;
    return (
      cliente.phone ||
      cliente.default_address?.phone ||
      (cliente.addresses || []).map(a => a.phone).find(Boolean) ||
      null
    );
  }

  // Buscar orden por número de pedido (ej: 1658 → id interno de Shopify)
  async obtenerIdPorNumeroPedido(numeroPedido) {
    try {
      const response = await axios.get(`${this.baseUrl}/orders.json`, {
        headers: this.getHeaders(),
        params: { name: `#${numeroPedido}`, status: 'any', fields: 'id,name,order_number' }
      });
      const orders = response.data.orders || [];
      return orders[0]?.id || null;
    } catch (error) {
      if (error.response?.status === 401) {
        throw new Error(
          `Autenticación rechazada por Shopify (401) — verificar SHOPIFY_ACCESS_TOKEN y SHOPIFY_DOMAIN en el archivo .env`
        );
      }
      throw new Error(`Error buscando orden #${numeroPedido}: ${error.message}`);
    }
  }

  // Obtener orden específica
  async obtenerOrden(orderId) {
    try {
      const response = await axios.get(`${this.baseUrl}/orders/${orderId}.json`, {
        headers: this.getHeaders()
      });

      return response.data.order;
    } catch (error) {
      throw new Error(`Error obteniendo orden ${orderId}: ${error.message}`);
    }
  }

  // Obtener fulfillment_orders de una orden (API moderna 2022-07+)
  async obtenerFulfillmentOrders(orderId) {
    const response = await axios.get(
      `${this.baseUrl}/orders/${orderId}/fulfillment_orders.json`,
      { headers: this.getHeaders() }
    );
    return response.data.fulfillment_orders || [];
  }

  // Marcar orden como cumplida usando la Fulfillment Orders API (2024-01)
  // options: { trackingUrl, trackingCompany } sobrescriben los defaults (UES env var).
  async marcarComoCumplida(orderId, trackingNumber = null, notifyCustomer = true, options = {}) {
    try {
      // Obtener los fulfillment_orders abiertos para esta orden
      const fulfillmentOrders = await this.obtenerFulfillmentOrders(orderId);
      const openFOs = fulfillmentOrders.filter((fo) => fo.status === 'open' || fo.status === 'in_progress');

      if (openFOs.length === 0) {
        throw new Error('No hay fulfillment_orders abiertos para esta orden');
      }

      // Resolver tracking URL: prioridad al override (ej: MarcoPostal), si no UES env var.
      const trackingUrl = options.trackingUrl
        ?? (process.env.UES_TRACKING_URL_TEMPLATE
            ? process.env.UES_TRACKING_URL_TEMPLATE.replace('{tracking}', encodeURIComponent(String(trackingNumber || '')))
            : null);
      const trackingCompany = options.trackingCompany || null;

      const body = {
        fulfillment: {
          line_items_by_fulfillment_order: openFOs.map((fo) => ({
            fulfillment_order_id: fo.id,
          })),
          tracking_info: {
            number: trackingNumber || '',
            ...(trackingUrl ? { url: trackingUrl } : {}),
            ...(trackingCompany ? { company: trackingCompany } : {}),
          },
          notify_customer: notifyCustomer,
        },
      };

      const response = await axios.post(
        `${this.baseUrl}/fulfillments.json`,
        body,
        { headers: this.getHeaders() }
      );

      return response.data.fulfillment;
    } catch (error) {
      const shopifyBody = error.response?.data;
      const httpStatus = error.response?.status;
      const detalle = shopifyBody
        ? JSON.stringify(shopifyBody)
        : error.message;
      throw new Error(
        `Error marcando orden como cumplida (HTTP ${httpStatus ?? 'N/A'}): ${detalle}`
      );
    }
  }

  // Resolver la locación de retiro (con "Local pickup" habilitado) y cachearla.
  // Prioridad: env SHOPIFY_PICKUP_LOCATION_ID (numérico o GID); si no, autodetecta
  // la primera locación activa con localPickupSettingsV2 definido.
  async obtenerLocationPickup() {
    if (this._pickupLocation) return this._pickupLocation;

    const configurado = process.env.SHOPIFY_PICKUP_LOCATION_ID;
    if (configurado) {
      const numericId = String(configurado).replace('gid://shopify/Location/', '').trim();
      this._pickupLocation = { id: numericId, gid: `gid://shopify/Location/${numericId}` };
      return this._pickupLocation;
    }

    const query = `query {
      locations(first: 50, includeInactive: false) {
        edges { node { id name localPickupSettingsV2 { pickupTime } } }
      }
    }`;

    const response = await axios.post(
      `https://${this.domain}/admin/api/2024-01/graphql.json`,
      { query },
      { headers: this.getHeaders() }
    );

    const edges = response.data?.data?.locations?.edges || [];
    const pickupNode = edges.map((e) => e.node).find((n) => n?.localPickupSettingsV2);
    if (!pickupNode) {
      throw new Error(
        'No se encontró ninguna locación con "Local pickup" habilitado en Shopify. ' +
        'Habilite el retiro en una sucursal o configure SHOPIFY_PICKUP_LOCATION_ID en el .env'
      );
    }

    const numericId = String(pickupNode.id).replace('gid://shopify/Location/', '');
    this._pickupLocation = { id: numericId, gid: pickupNode.id };
    return this._pickupLocation;
  }

  // Conecta un inventory item a una locación (con cantidad 0) para que quede "stockeado"
  // ahí. Es requisito para que fulfillmentOrderMove pueda trasladar el FO al punto de
  // retiro (sin esto devuelve "None of the items are stocked at the new location").
  // No suma stock (qty 0) ni cambia el total vendible. Best-effort: si ya estaba activo,
  // Shopify devuelve userErrors que ignoramos.
  async activarInventarioEnLocation(inventoryItemId, locationGid) {
    const query = `mutation act($inventoryItemId: ID!, $locationId: ID!) {
      inventoryActivate(inventoryItemId: $inventoryItemId, locationId: $locationId) {
        inventoryLevel { id }
        userErrors { field message }
      }
    }`;
    try {
      const response = await axios.post(
        `https://${this.domain}/admin/api/2024-01/graphql.json`,
        {
          query,
          variables: {
            inventoryItemId: `gid://shopify/InventoryItem/${inventoryItemId}`,
            locationId: locationGid,
          },
        },
        { headers: this.getHeaders() }
      );
      const userErrors = response.data?.data?.inventoryActivate?.userErrors || [];
      if (userErrors.length > 0) {
        console.warn(`inventoryActivate item ${inventoryItemId} en retiro: ${JSON.stringify(userErrors)}`);
      }
    } catch (error) {
      console.warn(`No se pudo activar inventario item ${inventoryItemId} en retiro: ${error.message}`);
    }
  }

  // Consultar el "available" de un inventory item en una locación. Devuelve null si el
  // item no tiene nivel en esa locación.
  async obtenerAvailableEnLocation(inventoryItemId, locationGid) {
    const query = `query nivelPickup($inventoryItemId: ID!, $locationId: ID!) {
      inventoryItem(id: $inventoryItemId) {
        inventoryLevel(locationId: $locationId) {
          quantities(names: ["available"]) { name quantity }
        }
      }
    }`;
    const response = await axios.post(
      `https://${this.domain}/admin/api/2024-01/graphql.json`,
      {
        query,
        variables: {
          inventoryItemId: `gid://shopify/InventoryItem/${inventoryItemId}`,
          locationId: locationGid,
        },
      },
      { headers: this.getHeaders() }
    );
    const quantities = response.data?.data?.inventoryItem?.inventoryLevel?.quantities;
    if (!Array.isArray(quantities)) return null;
    return quantities.find((q) => q.name === 'available')?.quantity ?? null;
  }

  // Transferir el stock available de los items de un fulfillment_order desde su sucursal
  // de origen (Bvar España) hacia el punto de retiro, con inventoryMoveQuantities.
  // Así, cuando el pedido se cumple en Pick-UP, el descuento sale de unidades reales y
  // Pick-UP vuelve a 0 (en vez de acumular negativos), y Bvar España refleja la salida
  // física. Idempotencia: si Pick-UP ya tiene available para el item (reintento tras un
  // fallo parcial), solo se transfiere el faltante; los negativos históricos no se tocan.
  // Devuelve [{ inventoryItemId, cantidad }] con lo efectivamente transferido.
  async transferirStockAPickup(fo, pickup, shopifyOrderId) {
    const origenLocationId = String(fo.assigned_location_id || fo.assigned_location?.location_id || '');
    if (!origenLocationId) {
      throw new Error(`Fulfillment_order ${fo.id} sin assigned_location_id — no se puede transferir stock`);
    }

    // Agrupar cantidades por inventory item (puede haber 2 line items del mismo item).
    const porItem = new Map();
    for (const li of fo.line_items || []) {
      if (!li.inventory_item_id) continue;
      const qty = Number(li.fulfillable_quantity ?? li.quantity ?? 0);
      if (qty <= 0) continue;
      porItem.set(li.inventory_item_id, (porItem.get(li.inventory_item_id) || 0) + qty);
    }

    // inventoryMoveQuantities NO sirve acá: solo mueve entre estados de la MISMA
    // sucursal ("The quantities can't be moved between different locations").
    // La transferencia entre sucursales se hace con inventoryAdjustQuantities en una
    // sola operación atómica: -N available en el origen y +N available en Pick-UP.
    const changes = [];
    const transferencias = [];
    for (const [inventoryItemId, necesario] of porItem) {
      const available = await this.obtenerAvailableEnLocation(inventoryItemId, pickup.gid);
      const yaCubierto = Math.min(Math.max(available ?? 0, 0), necesario);
      const aTransferir = necesario - yaCubierto;
      if (aTransferir <= 0) continue;
      changes.push(
        {
          inventoryItemId: `gid://shopify/InventoryItem/${inventoryItemId}`,
          locationId: `gid://shopify/Location/${origenLocationId}`,
          delta: -aTransferir,
        },
        {
          inventoryItemId: `gid://shopify/InventoryItem/${inventoryItemId}`,
          locationId: pickup.gid,
          delta: aTransferir,
        }
      );
      transferencias.push({ inventoryItemId, cantidad: aTransferir });
    }

    if (changes.length === 0) return transferencias;

    const query = `mutation TransferToPickup($input: InventoryAdjustQuantitiesInput!) {
      inventoryAdjustQuantities(input: $input) {
        userErrors { field message }
      }
    }`;

    const response = await axios.post(
      `https://${this.domain}/admin/api/2024-01/graphql.json`,
      {
        query,
        variables: {
          input: {
            reason: 'correction',
            name: 'available',
            referenceDocumentUri: `gid://shopify/Order/${shopifyOrderId}`,
            changes,
          },
        },
      },
      { headers: this.getHeaders() }
    );

    const data = response.data;
    const userErrors = data?.data?.inventoryAdjustQuantities?.userErrors || [];
    const topErrors = data?.errors || [];
    if (userErrors.length > 0 || topErrors.length > 0) {
      throw new Error(
        `Error transfiriendo stock al punto de retiro (FO ${fo.id}) — ` +
        `userErrors: ${JSON.stringify(userErrors)} | errors: ${JSON.stringify(topErrors)}`
      );
    }

    return transferencias;
  }

  // Crear el fulfillment final del pickup ("retirado") SIN notificar al cliente.
  // No reutiliza marcarComoCumplida porque esa inyecta tracking URL de UES.
  async marcarRetirado(orderId, fulfillmentOrderGids) {
    const body = {
      fulfillment: {
        line_items_by_fulfillment_order: fulfillmentOrderGids.map((gid) => ({
          fulfillment_order_id: Number(String(gid).replace('gid://shopify/FulfillmentOrder/', '')),
        })),
        notify_customer: false,
      },
    };

    const response = await axios.post(
      `${this.baseUrl}/fulfillments.json`,
      body,
      { headers: this.getHeaders() }
    );

    return response.data.fulfillment;
  }

  // Trasladar un fulfillment_order al punto de retiro (equivale al "transferir a lugar de
  // retiro" del admin de Shopify). Requiere que los items ya estén activados/stockeados en
  // la locación destino (lo hace marcarListoParaRetirar antes de llamar acá).
  // Devuelve el GID del fulfillment_order resultante.
  async moverFulfillmentOrder(fo, newLocationGid) {
    const query = `mutation moverFO($id: ID!, $newLocationId: ID!) {
      fulfillmentOrderMove(id: $id, newLocationId: $newLocationId) {
        movedFulfillmentOrder { id status }
        userErrors { field message }
      }
    }`;

    const response = await axios.post(
      `https://${this.domain}/admin/api/2024-01/graphql.json`,
      {
        query,
        variables: {
          id: `gid://shopify/FulfillmentOrder/${fo.id}`,
          newLocationId: newLocationGid,
        },
      },
      { headers: this.getHeaders() }
    );

    const data = response.data;
    const result = data?.data?.fulfillmentOrderMove;
    const userErrors = result?.userErrors || [];
    const topErrors = data?.errors || [];
    if (userErrors.length > 0 || topErrors.length > 0) {
      throw new Error(
        `Error trasladando fulfillment_order ${fo.id} al punto de retiro — ` +
        `userErrors: ${JSON.stringify(userErrors)} | errors: ${JSON.stringify(topErrors)}`
      );
    }

    const movedGid = result?.movedFulfillmentOrder?.id;
    if (!movedGid) {
      throw new Error(`fulfillmentOrderMove no devolvió movedFulfillmentOrder para ${fo.id}`);
    }
    return movedGid;
  }

  // Flujo completo de pickup en un solo click:
  //   1) transfiere el stock available de los items desde Bvar España a Pick-UP
  //      (inventoryMoveQuantities) — así el descuento final sale de unidades reales;
  //   2) traslada el fulfillment_order a Pick-UP (Shopify exige que esté en una locación
  //      con local pickup para poder prepararlo);
  //   3) lo marca "listo para retirar" (fulfillmentOrderLineItemsPreparedForPickup) →
  //      ÚNICA notificación que recibe el cliente;
  //   4) crea el fulfillment final "retirado" SIN notificar (el dueño no tiene forma de
  //      saber cuándo el cliente retira) → Pick-UP descuenta y queda en 0, pedido FULFILLED.
  // Si el paso 4 falla, no se aborta: el pedido ya quedó listo/notificado — se reporta
  // retiradoOk:false para cerrarlo a mano en el admin.
  async marcarListoParaRetirar(orderId) {
    try {
      const pickup = await this.obtenerLocationPickup();

      const fulfillmentOrders = await this.obtenerFulfillmentOrders(orderId);
      const openFOs = fulfillmentOrders.filter((fo) => fo.status === 'open' || fo.status === 'in_progress');

      if (openFOs.length === 0) {
        throw new Error('No hay fulfillment_orders abiertos para esta orden');
      }

      // Pasos 1-2: transferir stock y trasladar cada FO que no esté ya en Pick-UP.
      const targetFoGids = [];
      const transferencias = [];
      for (const fo of openFOs) {
        const currentLocationId = String(fo.assigned_location_id || fo.assigned_location?.location_id || '');
        if (currentLocationId === String(pickup.id)) {
          // Ya trasladado (a mano o por ejecución previa) — no transferir de nuevo.
          targetFoGids.push(`gid://shopify/FulfillmentOrder/${fo.id}`);
          continue;
        }

        const inventoryItemIds = [
          ...new Set((fo.line_items || []).map((li) => li.inventory_item_id).filter(Boolean)),
        ];
        for (const invId of inventoryItemIds) {
          await this.activarInventarioEnLocation(invId, pickup.gid);
        }

        const movidas = await this.transferirStockAPickup(fo, pickup, orderId);
        transferencias.push(...movidas);

        const movedGid = await this.moverFulfillmentOrder(fo, pickup.gid);
        targetFoGids.push(movedGid);
      }

      // Paso 3: marcar listo para retirar (única notificación al cliente).
      const lineItemsByFulfillmentOrder = targetFoGids.map((gid) => ({
        fulfillmentOrderId: gid,
      }));

      const query = `mutation prep($input: FulfillmentOrderLineItemsPreparedForPickupInput!) {
        fulfillmentOrderLineItemsPreparedForPickup(input: $input) {
          userErrors { field message }
        }
      }`;

      const response = await axios.post(
        `https://${this.domain}/admin/api/2024-01/graphql.json`,
        { query, variables: { input: { lineItemsByFulfillmentOrder } } },
        { headers: this.getHeaders() }
      );

      const data = response.data;
      const userErrors = data?.data?.fulfillmentOrderLineItemsPreparedForPickup?.userErrors || [];
      const topErrors = data?.errors || [];
      if (userErrors.length > 0 || topErrors.length > 0) {
        throw new Error(
          `userErrors: ${JSON.stringify(userErrors)} | errors: ${JSON.stringify(topErrors)}`
        );
      }

      // Paso 4: cerrar como "retirado" sin notificación (best-effort).
      let retiradoOk = true;
      let retiradoError = null;
      try {
        await this.marcarRetirado(orderId, targetFoGids);
      } catch (err) {
        retiradoOk = false;
        retiradoError = err.response?.data ? JSON.stringify(err.response.data) : err.message;
      }

      return { ok: true, fulfillmentOrderIds: targetFoGids, transferencias, retiradoOk, retiradoError };
    } catch (error) {
      const shopifyBody = error.response?.data;
      const httpStatus = error.response?.status;
      const detalle = shopifyBody ? JSON.stringify(shopifyBody) : error.message;
      throw new Error(
        `Error marcando orden como lista para retirar (HTTP ${httpStatus ?? 'N/A'}): ${detalle}`
      );
    }
  }

  // Actualizar número de seguimiento
  async actualizarTracking(orderId, fulfillmentId, trackingNumber, trackingUrl = null) {
    try {
      const update = {
        fulfillment: {
          tracking_number: trackingNumber
        }
      };

      if (trackingUrl) {
        update.fulfillment.tracking_url = trackingUrl;
      }

      const response = await axios.put(
        `${this.baseUrl}/orders/${orderId}/fulfillments/${fulfillmentId}.json`,
        update,
        { headers: this.getHeaders() }
      );

      return response.data.fulfillment;
    } catch (error) {
      throw new Error(`Error actualizando tracking: ${error.message}`);
    }
  }

  // Obtener productos
  async obtenerProductos() {
    try {
      const response = await axios.get(`${this.baseUrl}/products.json`, {
        headers: this.getHeaders(),
        params: { limit: 250 }
      });

      return response.data.products;
    } catch (error) {
      throw new Error(`Error obteniendo productos: ${error.message}`);
    }
  }

  // Agregar un tag a una orden de Shopify (no duplica si ya existe)
  async agregarTagAOrden(orderId, tag) {
    try {
      const response = await axios.get(
        `${this.baseUrl}/orders/${orderId}.json`,
        { headers: this.getHeaders(), params: { fields: 'id,tags' } }
      );
      const currentTags = response.data.order?.tags || '';
      const tagsArray = currentTags.split(',').map((t) => t.trim()).filter(Boolean);
      if (tagsArray.includes(tag)) return; // ya tiene el tag
      tagsArray.push(tag);
      await axios.put(
        `${this.baseUrl}/orders/${orderId}.json`,
        { order: { id: orderId, tags: tagsArray.join(', ') } },
        { headers: this.getHeaders() }
      );
    } catch (error) {
      const status = error.response?.status;
      throw new Error(`Error agregando tag "${tag}" a orden ${orderId} (HTTP ${status ?? 'N/A'}): ${error.message}`);
    }
  }

  // Obtener clientes
  async obtenerClientes() {
    try {
      const response = await axios.get(`${this.baseUrl}/customers.json`, {
        headers: this.getHeaders(),
        params: { limit: 250 }
      });

      return response.data.customers;
    } catch (error) {
      throw new Error(`Error obteniendo clientes: ${error.message}`);
    }
  }

  // Buscar productos del catálogo (con sus variantes) para armar un pedido manual desde
  // el panel de atención al cliente. Devuelve solo productos activos, con el id numérico de
  // cada variante (lo que necesita la Draft Orders API en line_items.variant_id).
  async buscarProductosParaPedido(termino = '') {
    const q = String(termino || '').trim();
    // Sintaxis de búsqueda de Shopify: texto libre + filtro de estado activo.
    const queryString = q ? `${q} status:active` : 'status:active';

    const query = `query buscarProductos($q: String!) {
      products(first: 20, query: $q, sortKey: RELEVANCE) {
        edges {
          node {
            id
            title
            status
            featuredImage { url }
            totalInventory
            variants(first: 50) {
              edges {
                node {
                  id
                  title
                  sku
                  price
                  availableForSale
                  inventoryQuantity
                }
              }
            }
          }
        }
      }
    }`;

    const response = await axios.post(
      `${this.baseUrl}/graphql.json`,
      { query, variables: { q: queryString } },
      { headers: this.getHeaders() }
    );

    const topErrors = response.data?.errors;
    if (Array.isArray(topErrors) && topErrors.length > 0) {
      throw new Error(`Error buscando productos en Shopify: ${JSON.stringify(topErrors)}`);
    }

    const edges = response.data?.data?.products?.edges || [];
    return edges.map((e) => {
      const p = e.node;
      const variantes = (p.variants?.edges || []).map((ve) => {
        const v = ve.node;
        return {
          id: String(v.id).replace('gid://shopify/ProductVariant/', ''),
          titulo: v.title === 'Default Title' ? '' : v.title,
          sku: v.sku || '',
          precio: v.price,
          disponible: Boolean(v.availableForSale),
          stock: typeof v.inventoryQuantity === 'number' ? v.inventoryQuantity : null,
        };
      });
      return {
        id: String(p.id).replace('gid://shopify/Product/', ''),
        titulo: p.title,
        imagen: p.featuredImage?.url || null,
        variantes,
      };
    });
  }

  // Crear un borrador de pedido (Draft Order) y devolver el link de checkout (invoice_url).
  // Ese link es lo que atención al cliente le pasa a la persona para que complete el pago.
  // lineItems: [{ variantId, quantity }] (catálogo) o [{ title, price, quantity }] (custom).
  async crearDraftOrderCheckout({ lineItems = [], email = '', nombre = '', telefono = '', nota = '' } = {}) {
    const items = (Array.isArray(lineItems) ? lineItems : [])
      .map((li) => {
        const quantity = Math.max(1, parseInt(li.quantity, 10) || 1);
        if (li.variantId) {
          return { variant_id: Number(String(li.variantId).replace('gid://shopify/ProductVariant/', '')), quantity };
        }
        const title = String(li.title || '').trim();
        if (!title) return null;
        return { title, price: String(li.price ?? '0'), quantity };
      })
      .filter(Boolean);

    if (items.length === 0) {
      throw new Error('No hay ítems válidos para crear el pedido');
    }

    // El teléfono y el nombre del contacto van en la nota porque el draft order sin dirección
    // completa no persiste esos datos sueltos; el email sí queda asociado para el invoice.
    const notasExtra = [];
    if (nombre) notasExtra.push(`Cliente: ${nombre}`);
    if (telefono) notasExtra.push(`Tel: ${telefono}`);
    if (nota) notasExtra.push(String(nota).trim());

    const draft = {
      line_items: items,
      tags: 'Atención al cliente',
    };
    if (email) draft.email = String(email).trim();
    if (notasExtra.length > 0) draft.note = notasExtra.join(' · ');

    try {
      const response = await axios.post(
        `${this.baseUrl}/draft_orders.json`,
        { draft_order: draft },
        { headers: this.getHeaders() }
      );

      const draftOrder = response.data?.draft_order;
      if (!draftOrder?.invoice_url) {
        throw new Error('Shopify no devolvió un link de checkout (invoice_url) para el pedido');
      }

      return {
        id: draftOrder.id,
        name: draftOrder.name,
        checkoutUrl: draftOrder.invoice_url,
        total: draftOrder.total_price,
        currency: draftOrder.currency,
        status: draftOrder.status,
      };
    } catch (error) {
      const shopifyBody = error.response?.data;
      const httpStatus = error.response?.status;
      const detalle = shopifyBody ? JSON.stringify(shopifyBody) : error.message;
      throw new Error(`Error creando pedido en Shopify (HTTP ${httpStatus ?? 'N/A'}): ${detalle}`);
    }
  }

  // Crear nota en orden
  async agregarNota(orderId, nota) {
    try {
      const response = await axios.put(
        `${this.baseUrl}/orders/${orderId}.json`,
        {
          order: {
            id: orderId,
            note: nota
          }
        },
        { headers: this.getHeaders() }
      );

      return response.data.order;
    } catch (error) {
      throw new Error(`Error agregando nota: ${error.message}`);
    }
  }
}

module.exports = new ShopifyService();

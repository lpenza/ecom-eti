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

  // Devuelve las órdenes de las últimas `horas` horas con los campos de contacto
  // necesarios para cruzar carritos abandonados con compras ya concretadas.
  // Se usa para detectar recuperados por checkout_token Y por contacto (email /
  // teléfono / nombre+apellido), porque el cliente puede terminar la compra desde
  // otro dispositivo o checkout y el token no coincide.
  async obtenerOrdenesRecientes(horas = 72) {
    const desde = new Date(Date.now() - horas * 60 * 60 * 1000).toISOString();
    const MAX_PAGINAS = 20; // tope de seguridad: 20 × 250 = 5000 órdenes
    const fields = 'id,checkout_token,checkout_id,created_at,email,contact_email,phone,customer,shipping_address,billing_address';
    try {
      const ordenes = [];
      // Primera página con los filtros; las siguientes se piden con la URL que
      // Shopify devuelve en el header Link (paginación por cursor: al usar
      // page_info NO se pueden reenviar los otros filtros, solo el limit).
      let url = `${this.baseUrl}/orders.json`;
      let params = {
        status: 'any',
        created_at_min: desde,
        limit: 250,
        fields,
      };

      for (let pagina = 0; pagina < MAX_PAGINAS && url; pagina++) {
        const response = await axios.get(url, { headers: this.getHeaders(), params });
        ordenes.push(...(response.data.orders || []));

        // Buscar el link "next" en el header Link para seguir paginando
        const linkHeader = response.headers?.link || response.headers?.Link || '';
        const next = linkHeader.split(',').find(p => p.includes('rel="next"'));
        const match = next && next.match(/<([^>]+)>/);
        url = match ? match[1] : null;
        params = undefined; // el page_info ya viene embebido en la URL "next"
      }

      return ordenes;
    } catch (err) {
      // Propagamos el error: quien envía mensajes DEBE poder distinguir "no hay
      // órdenes" de "no pude consultar", para no escribirle a quien ya compró.
      console.warn(`[Shopify] obtenerOrdenesRecientes falló: ${err.message}`);
      throw new Error(`No se pudieron obtener las órdenes recientes de Shopify: ${err.message}`);
    }
  }

  // Devuelve un Set con los checkout_token de las órdenes de las últimas 72h.
  // Sirve para saber qué carritos abandonados ya se RECUPERARON (se convirtieron en orden).
  async obtenerTokensRecuperados() {
    const desde72h = new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString();
    try {
      const response = await axios.get(`${this.baseUrl}/orders.json`, {
        headers: this.getHeaders(),
        params: {
          status: 'any',
          created_at_min: desde72h,
          limit: 250,
          fields: 'id,checkout_token,checkout_id',
        },
      });
      const tokens = new Set();
      for (const orden of response.data.orders || []) {
        if (orden.checkout_token) tokens.add(orden.checkout_token);
      }
      return tokens;
    } catch (err) {
      console.warn(`[Shopify] obtenerTokensRecuperados falló: ${err.message}`);
      return new Set(); // ante error, no bloqueamos el flujo (devolvemos vacío)
    }
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

  // ── Stock por SKU (colores "NC") ─────────────────────────────────────────────
  // Resolver la locación principal de venta/despacho (Bvar España) y cachearla.
  // Prioridad: env SHOPIFY_STOCK_LOCATION_ID (numérico o GID); si no, autodetecta
  // la primera locación activa que despacha inventario (shipsInventory=true).
  async obtenerLocationPrincipal() {
    if (this._mainLocation) return this._mainLocation;

    const configurado = process.env.SHOPIFY_STOCK_LOCATION_ID;
    if (configurado) {
      const numericId = String(configurado).replace('gid://shopify/Location/', '').trim();
      this._mainLocation = { id: numericId, gid: `gid://shopify/Location/${numericId}` };
      return this._mainLocation;
    }

    const query = `query {
      locations(first: 50, includeInactive: false) {
        edges { node { id name isActive shipsInventory fulfillsOnlineOrders } }
      }
    }`;
    const response = await axios.post(
      `https://${this.domain}/admin/api/2024-01/graphql.json`,
      { query },
      { headers: this.getHeaders() }
    );
    const nodes = (response.data?.data?.locations?.edges || []).map((e) => e.node);
    const principal = nodes.find((n) => n?.isActive && n?.shipsInventory) || nodes[0];
    if (!principal) {
      throw new Error('No se encontró ninguna locación activa en Shopify para el stock');
    }
    const numericId = String(principal.id).replace('gid://shopify/Location/', '');
    this._mainLocation = { id: numericId, gid: principal.id };
    return this._mainLocation;
  }

  // Leer el stock "available" en la locación principal de todas las variantes cuyo SKU
  // empieza por un prefijo (por defecto "NC"). Devuelve un mapa
  //   sku -> { available, inventoryItemId }
  // Como Easify Inventory Sync mantiene iguales todas las variantes que comparten SKU,
  // basta con quedarnos con una por SKU (guardamos su inventoryItemId para poder escribir).
  async obtenerStockPorPrefijoSku(prefijo = 'NC') {
    // Acepta un prefijo (string) o varios (array o "NC,BSA,MRT"). Normalizamos a lista.
    const prefijos = (Array.isArray(prefijo) ? prefijo : String(prefijo || 'NC').split(','))
      .map((p) => String(p || '').trim())
      .filter(Boolean);
    if (prefijos.length === 0) prefijos.push('NC');
    const location = await this.obtenerLocationPrincipal();

    const query = `query stockPorSku($q: String!, $cursor: String, $loc: ID!) {
      productVariants(first: 250, after: $cursor, query: $q) {
        pageInfo { hasNextPage endCursor }
        edges {
          node {
            sku
            title
            product { title }
            inventoryItem {
              id
              inventoryLevel(locationId: $loc) {
                quantities(names: ["available"]) { name quantity }
              }
            }
          }
        }
      }
    }`;

    const porSku = new Map();
    let cursor = null;
    let paginas = 0;
    do {
      const response = await axios.post(
        `https://${this.domain}/admin/api/2024-01/graphql.json`,
        { query, variables: { q: prefijos.map((p) => `sku:${p}*`).join(' OR '), cursor, loc: location.gid } },
        { headers: this.getHeaders() }
      );
      const topErrors = response.data?.errors;
      if (Array.isArray(topErrors) && topErrors.length > 0) {
        throw new Error(`Error leyendo stock por SKU en Shopify: ${JSON.stringify(topErrors)}`);
      }
      const conn = response.data?.data?.productVariants;
      for (const edge of conn?.edges || []) {
        const v = edge.node;
        const sku = String(v.sku || '').trim();
        // La búsqueda sku:NC* puede traer coincidencias parciales; filtramos por prefijo real.
        const skuUpper = sku.toUpperCase();
        if (!sku || !prefijos.some((p) => skuUpper.startsWith(p.toUpperCase()))) continue;
        const inventoryItemId = String(v.inventoryItem?.id || '').replace('gid://shopify/InventoryItem/', '');
        const available = (v.inventoryItem?.inventoryLevel?.quantities || [])
          .find((q) => q.name === 'available')?.quantity ?? 0;
        // Nombre para dar de alta el producto si todavía no existe en la BD.
        const productTitle = String(v.product?.title || '').trim();
        const variantTitle = String(v.title || '').trim();
        const nombre = [productTitle, variantTitle && variantTitle.toLowerCase() !== 'default title' ? variantTitle : '']
          .filter(Boolean)
          .join(' - ') || sku;
        if (!porSku.has(sku)) {
          porSku.set(sku, { available, inventoryItemId, nombre });
        }
      }
      cursor = conn?.pageInfo?.hasNextPage ? conn.pageInfo.endCursor : null;
      paginas += 1;
    } while (cursor && paginas < 20);

    return porSku;
  }

  // Fijar el stock "available" (absoluto) de un SKU en la locación principal. Ajusta TODAS
  // las variantes/inventory items que comparten ese SKU (varios productos: kit, set, etc.)
  // para dejarlas todas en el mismo valor. No dependemos de Easify Inventory Sync para
  // igualarlas (puede no ser instantáneo), lo hacemos explícitamente.
  // Devuelve { sku, anterior, nuevo, variantes, ajustadas }.
  async fijarStockDisponiblePorSku(sku, cantidad) {
    const skuLimpio = String(sku || '').trim();
    if (!skuLimpio) throw new Error('SKU requerido');
    const nuevo = Number(cantidad);
    if (!Number.isFinite(nuevo)) throw new Error('Cantidad de stock inválida');

    const location = await this.obtenerLocationPrincipal();

    // Buscar TODAS las variantes con ese SKU exacto y su available actual en la locación.
    const query = `query buscarVariantes($q: String!, $cursor: String, $loc: ID!) {
      productVariants(first: 250, after: $cursor, query: $q) {
        pageInfo { hasNextPage endCursor }
        edges {
          node {
            sku
            inventoryItem {
              id
              inventoryLevel(locationId: $loc) {
                quantities(names: ["available"]) { name quantity }
              }
            }
          }
        }
      }
    }`;

    const items = []; // { inventoryItemId, available }
    let cursor = null;
    let paginas = 0;
    do {
      const response = await axios.post(
        `https://${this.domain}/admin/api/2024-01/graphql.json`,
        { query, variables: { q: `sku:${skuLimpio}`, cursor, loc: location.gid } },
        { headers: this.getHeaders() }
      );
      const topErrors = response.data?.errors;
      if (Array.isArray(topErrors) && topErrors.length > 0) {
        throw new Error(`Error buscando variantes del SKU "${skuLimpio}": ${JSON.stringify(topErrors)}`);
      }
      const conn = response.data?.data?.productVariants;
      for (const edge of conn?.edges || []) {
        const v = edge.node;
        // La búsqueda sku:XXX puede traer coincidencias parciales; exigimos SKU exacto.
        if (String(v.sku || '').trim() !== skuLimpio) continue;
        const inventoryItemId = String(v.inventoryItem?.id || '').replace('gid://shopify/InventoryItem/', '');
        if (!inventoryItemId) continue;
        const available = (v.inventoryItem?.inventoryLevel?.quantities || [])
          .find((q) => q.name === 'available')?.quantity ?? 0;
        items.push({ inventoryItemId, available });
      }
      cursor = conn?.pageInfo?.hasNextPage ? conn.pageInfo.endCursor : null;
      paginas += 1;
    } while (cursor && paginas < 20);

    if (items.length === 0) {
      throw new Error(`No se encontró ninguna variante en Shopify con SKU "${skuLimpio}"`);
    }

    // Un cambio por inventory item para llevar cada uno al valor absoluto objetivo.
    const changes = [];
    for (const it of items) {
      const delta = nuevo - it.available;
      if (delta === 0) continue;
      changes.push({
        inventoryItemId: `gid://shopify/InventoryItem/${it.inventoryItemId}`,
        locationId: location.gid,
        delta,
      });
    }

    const anterior = items[0].available; // valor representativo (antes del ajuste)

    if (changes.length === 0) {
      return { sku: skuLimpio, anterior, nuevo, variantes: items.length, ajustadas: 0 };
    }

    const mutation = `mutation fijarStock($input: InventoryAdjustQuantitiesInput!) {
      inventoryAdjustQuantities(input: $input) {
        userErrors { field message }
      }
    }`;
    const mutResponse = await axios.post(
      `https://${this.domain}/admin/api/2024-01/graphql.json`,
      {
        query: mutation,
        variables: {
          input: {
            reason: 'correction',
            name: 'available',
            changes,
          },
        },
      },
      { headers: this.getHeaders() }
    );
    const userErrors = mutResponse.data?.data?.inventoryAdjustQuantities?.userErrors || [];
    const topErrors = mutResponse.data?.errors || [];
    if (userErrors.length > 0 || topErrors.length > 0) {
      throw new Error(
        `Error fijando stock del SKU "${skuLimpio}" en Shopify — ` +
        `userErrors: ${JSON.stringify(userErrors)} | errors: ${JSON.stringify(topErrors)}`
      );
    }

    return { sku: skuLimpio, anterior, nuevo, variantes: items.length, ajustadas: changes.length };
  }

  // ── Alta de un color nuevo en todos los productos NC ──────────────────────────
  // Estas llamadas usan 2025-01: productVariantsBulkCreate con optionValues,
  // inventoryQuantities y media no existen con esa forma en 2024-01.
  async graphql2025(query, variables = {}) {
    const response = await axios.post(
      `https://${this.domain}/admin/api/2025-01/graphql.json`,
      { query, variables },
      { headers: this.getHeaders() }
    );
    const topErrors = response.data?.errors;
    if (Array.isArray(topErrors) && topErrors.length > 0) {
      throw new Error(`Shopify GraphQL: ${JSON.stringify(topErrors)}`);
    }
    return response.data?.data;
  }

  // Productos que tienen al menos una variante con SKU del prefijo (hoy: kits,
  // sets y "agregá tus tonos"). De cada uno devuelve lo que hace falta para
  // clonar una variante: nombre de la opción de color, precio, precio tachado y
  // política de inventario (se copian de la primera variante del prefijo; en
  // todos los productos actuales son iguales entre variantes).
  async listarProductosConPrefijoSku(prefijo = 'NC') {
    const pref = String(prefijo).trim().toUpperCase();
    const query = `query productosNC($q: String!, $cursor: String) {
      products(first: 50, after: $cursor, query: $q) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id title status
          options { name linkedMetafield { namespace key } }
          variants(first: 250) {
            nodes { sku title price compareAtPrice inventoryPolicy taxable }
          }
        }
      }
    }`;

    const productos = [];
    let cursor = null;
    let paginas = 0;
    do {
      const data = await this.graphql2025(query, { q: `sku:${pref}*`, cursor });
      const conn = data?.products;
      for (const p of conn?.nodes || []) {
        const variantes = p.variants?.nodes || [];
        const delPrefijo = variantes.filter((v) => String(v.sku || '').trim().toUpperCase().startsWith(pref));
        if (delPrefijo.length === 0) continue;
        const base = delPrefijo[0];
        productos.push({
          id: p.id,
          titulo: p.title,
          estado: p.status,
          // Hoy todos tienen una sola opción ("Color"); si algún producto tuviera
          // más, clonar la variante necesitaría elegir el resto de los valores.
          opciones: (p.options || []).map((o) => o.name),
          // La opción Color está vinculada al metaobjeto shopify--color-pattern: el valor
          // nuevo no se crea por nombre sino apuntando a una entrada de ese metaobjeto.
          opcionVinculada: Boolean(p.options?.[0]?.linkedMetafield),
          precio: base.price,
          precioTachado: base.compareAtPrice,
          politica: base.inventoryPolicy,
          taxable: base.taxable,
          cantidadVariantes: variantes.length,
          skus: variantes.map((v) => String(v.sku || '').trim().toUpperCase()).filter(Boolean),
          nombresColor: variantes.map((v) => String(v.title || '').trim().toLowerCase()),
        });
      }
      cursor = conn?.pageInfo?.hasNextPage ? conn.pageInfo.endCursor : null;
      paginas += 1;
    } while (cursor && paginas < 20);

    return productos;
  }

  // ── Entradas de color (metaobjeto shopify--color-pattern) ──
  // Cada color de la tienda es una entrada compartida por todos los productos.
  // Campos obligatorios: nombre, color base y patrón, ambos de la taxonomía de
  // Shopify (los ids de TaxonomyValue son fijos).
  static COLORES_BASE = [
    { id: 'gid://shopify/TaxonomyValue/6', nombre: 'Beige' },
    { id: 'gid://shopify/TaxonomyValue/1', nombre: 'Negro' },
    { id: 'gid://shopify/TaxonomyValue/2', nombre: 'Azul' },
    { id: 'gid://shopify/TaxonomyValue/657', nombre: 'Bronce' },
    { id: 'gid://shopify/TaxonomyValue/7', nombre: 'Marrón' },
    { id: 'gid://shopify/TaxonomyValue/17', nombre: 'Transparente' },
    { id: 'gid://shopify/TaxonomyValue/4', nombre: 'Dorado' },
    { id: 'gid://shopify/TaxonomyValue/8', nombre: 'Gris' },
    { id: 'gid://shopify/TaxonomyValue/9', nombre: 'Verde' },
    { id: 'gid://shopify/TaxonomyValue/2865', nombre: 'Multicolor' },
    { id: 'gid://shopify/TaxonomyValue/15', nombre: 'Azul marino' },
    { id: 'gid://shopify/TaxonomyValue/10', nombre: 'Naranja' },
    { id: 'gid://shopify/TaxonomyValue/11', nombre: 'Rosa' },
    { id: 'gid://shopify/TaxonomyValue/12', nombre: 'Violeta' },
    { id: 'gid://shopify/TaxonomyValue/13', nombre: 'Rojo' },
    { id: 'gid://shopify/TaxonomyValue/16', nombre: 'Oro rosa' },
    { id: 'gid://shopify/TaxonomyValue/5', nombre: 'Plateado' },
    { id: 'gid://shopify/TaxonomyValue/3', nombre: 'Blanco' },
    { id: 'gid://shopify/TaxonomyValue/14', nombre: 'Amarillo' },
  ];

  // Los que ya usa la tienda (Solid en 80 de 84 colores); el primero es el default.
  static PATRONES = [
    { id: 'gid://shopify/TaxonomyValue/2874', nombre: 'Liso' },
    { id: 'gid://shopify/TaxonomyValue/2870', nombre: 'Puntos' },
    { id: 'gid://shopify/TaxonomyValue/2871', nombre: 'Floral' },
    { id: 'gid://shopify/TaxonomyValue/24478', nombre: 'Animal' },
    { id: 'gid://shopify/TaxonomyValue/24509', nombre: 'Otro' },
  ];

  // Busca la entrada de color por nombre (sin distinguir mayúsculas). Si alguien
  // ya la creó a mano en Shopify, se reutiliza en vez de duplicarla.
  async buscarColorShopify(nombre) {
    const buscado = String(nombre || '').trim().toLowerCase();
    let cursor = null;
    let paginas = 0;
    do {
      const data = await this.graphql2025(`query coloresShopify($cursor: String) {
        metaobjects(type: "shopify--color-pattern", first: 250, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes { id displayName hex: field(key: "color") { value } base: field(key: "color_taxonomy_reference") { value } }
        }
      }`, { cursor });
      const conn = data?.metaobjects;
      const hallado = (conn?.nodes || []).find((n) => String(n.displayName || '').trim().toLowerCase() === buscado);
      if (hallado) {
        const baseIds = (() => { try { return JSON.parse(hallado.base?.value || '[]'); } catch { return []; } })();
        return {
          id: hallado.id,
          nombre: hallado.displayName,
          hex: hallado.hex?.value || null,
          colorBase: baseIds.map((id) => ShopifyService.COLORES_BASE.find((c) => c.id === id)?.nombre || id),
        };
      }
      cursor = conn?.pageInfo?.hasNextPage ? conn.pageInfo.endCursor : null;
      paginas += 1;
    } while (cursor && paginas < 10);
    return null;
  }

  async crearColorShopify({ nombre, colorBase, patron, hex }) {
    const bases = (Array.isArray(colorBase) ? colorBase : [colorBase]).filter(Boolean);
    if (!bases.every((id) => ShopifyService.COLORES_BASE.some((c) => c.id === id)) || bases.length === 0) {
      throw new Error('Color base inválido');
    }
    const patronId = patron || ShopifyService.PATRONES[0].id;
    if (!ShopifyService.PATRONES.some((p) => p.id === patronId)) throw new Error('Patrón inválido');

    const fields = [
      { key: 'label', value: nombre },
      { key: 'color_taxonomy_reference', value: JSON.stringify(bases) },
      { key: 'pattern_taxonomy_reference', value: patronId },
    ];
    if (hex && /^#[0-9a-f]{6}$/i.test(hex)) fields.push({ key: 'color', value: hex.toLowerCase() });

    const data = await this.graphql2025(`mutation crearColor($metaobject: MetaobjectCreateInput!) {
      metaobjectCreate(metaobject: $metaobject) {
        metaobject { id handle displayName }
        userErrors { field message code }
      }
    }`, { metaobject: { type: 'shopify--color-pattern', fields } });
    const res = data?.metaobjectCreate;
    if (res?.userErrors?.length) {
      throw new Error(`No se pudo crear el color en Shopify: ${res.userErrors.map((e) => e.message).join('; ')}`);
    }
    return res.metaobject;
  }

  // Sube una imagen a Shopify (staged upload) y devuelve la URL que después se
  // usa como `originalSource` al crear las variantes. Se sube una sola vez y se
  // reutiliza en todos los productos.
  async subirImagenStaged(buffer, filename, mimeType) {
    const FormData = require('form-data');
    const data = await this.graphql2025(`mutation staged($input: [StagedUploadInput!]!) {
      stagedUploadsCreate(input: $input) {
        stagedTargets { url resourceUrl parameters { name value } }
        userErrors { field message }
      }
    }`, {
      input: [{
        resource: 'IMAGE',
        filename,
        mimeType,
        httpMethod: 'POST',
        fileSize: String(buffer.length),
      }],
    });
    const res = data?.stagedUploadsCreate;
    if (res?.userErrors?.length) {
      throw new Error(`Shopify stagedUploadsCreate: ${JSON.stringify(res.userErrors)}`);
    }
    const target = res?.stagedTargets?.[0];
    if (!target) throw new Error('Shopify no devolvió destino para subir la imagen');

    const form = new FormData();
    for (const p of target.parameters) form.append(p.name, p.value);
    form.append('file', buffer, { filename, contentType: mimeType });
    await axios.post(target.url, form, { headers: form.getHeaders(), maxBodyLength: Infinity });
    return target.resourceUrl;
  }

  // Crea la variante de un color en UN producto, con el stock inicial en la
  // locación principal y la foto del color. Precio, tachado y política se
  // copian del producto (ver listarProductosConPrefijoSku).
  async crearVarianteColor(producto, { nombre, sku, stock, imagenSrc, colorId }) {
    if (producto.opcionVinculada && !colorId) {
      throw new Error('Falta la entrada de color de Shopify para vincular la variante');
    }
    const location = await this.obtenerLocationPrincipal();
    // Con la opción vinculada, la variante no puede crear el valor: tiene que
    // existir antes en la opción del producto y la variante lo referencia por id.
    const valorOpcion = producto.opcionVinculada
      ? await this.asegurarValorColor(producto.id, colorId)
      : { optionName: producto.opciones[0], name: nombre };
    const variante = {
      optionValues: [valorOpcion],
      price: producto.precio,
      compareAtPrice: producto.precioTachado,
      inventoryPolicy: producto.politica,
      taxable: producto.taxable,
      inventoryItem: { sku, tracked: true },
      inventoryQuantities: [{ locationId: location.gid, availableQuantity: Number(stock) || 0 }],
    };
    if (imagenSrc) variante.mediaSrc = [imagenSrc];

    const data = await this.graphql2025(`mutation nuevaVariante($productId: ID!, $variants: [ProductVariantsBulkInput!]!, $media: [CreateMediaInput!]) {
      productVariantsBulkCreate(productId: $productId, variants: $variants, media: $media) {
        productVariants { id title sku }
        userErrors { field message }
      }
    }`, {
      productId: producto.id,
      variants: [variante],
      media: imagenSrc ? [{ originalSource: imagenSrc, mediaContentType: 'IMAGE', alt: nombre }] : null,
    });
    const res = data?.productVariantsBulkCreate;
    if (res?.userErrors?.length) {
      throw new Error(res.userErrors.map((e) => e.message).join('; '));
    }
    return res?.productVariants?.[0] || null;
  }

  // Devuelve { optionId, id } del valor de la opción Color vinculado a la entrada
  // de color (la variante necesita los dos);
  // si el producto todavía no lo tiene, lo agrega (sin crear variantes). Un
  // intento anterior que falló después de este paso deja el valor ya creado:
  // por eso primero se busca.
  async asegurarValorColor(productId, colorId) {
    const buscarEn = (opciones) => {
      for (const o of opciones || []) {
        const v = (o.optionValues || []).find((x) => x.linkedMetafieldValue === colorId);
        if (v) return { optionId: o.id, id: v.id };
      }
      return null;
    };

    const data = await this.graphql2025(`query opcionColor($id: ID!) {
      product(id: $id) { options { id name optionValues { id name linkedMetafieldValue } } }
    }`, { id: productId });
    const opciones = data?.product?.options || [];
    const existente = buscarEn(opciones);
    if (existente) return existente;

    const d = await this.graphql2025(`mutation agregarValor($productId: ID!, $option: OptionUpdateInput!, $optionValuesToAdd: [OptionValueCreateInput!]) {
      productOptionUpdate(productId: $productId, option: $option, optionValuesToAdd: $optionValuesToAdd, variantStrategy: LEAVE_AS_IS) {
        product { options { id name optionValues { id name linkedMetafieldValue } } }
        userErrors { field message code }
      }
    }`, {
      productId,
      option: { id: opciones[0].id },
      optionValuesToAdd: [{ linkedMetafieldValue: colorId }],
    });
    const res = d?.productOptionUpdate;
    if (res?.userErrors?.length) {
      throw new Error(`No se pudo agregar el color a la opción: ${res.userErrors.map((e) => e.message).join('; ')}`);
    }
    const nuevo = buscarEn(res?.product?.options);
    if (!nuevo) throw new Error('Shopify no devolvió el valor de color agregado');
    return nuevo;
  }

  // ── Cambio de foto de un color existente ─────────────────────────────────────

  // Variantes con el SKU exacto, agrupadas por producto, con la foto actual.
  async productosConSku(sku) {
    const skuUp = String(sku || '').trim().toUpperCase();
    const data = await this.graphql2025(`query variantesSku($q: String!) {
      productVariants(first: 50, query: $q) {
        nodes {
          id sku title
          product { id title status }
          media(first: 1) { nodes { ... on MediaImage { image { url } } } }
        }
      }
    }`, { q: `sku:${skuUp}` });

    const porProducto = new Map();
    for (const v of data?.productVariants?.nodes || []) {
      // La búsqueda sku:XXX puede traer coincidencias parciales; exigimos SKU exacto.
      if (String(v.sku || '').trim().toUpperCase() !== skuUp) continue;
      if (!porProducto.has(v.product.id)) {
        porProducto.set(v.product.id, {
          id: v.product.id,
          titulo: v.product.title,
          estado: v.product.status,
          color: v.title,
          fotoActual: v.media?.nodes?.[0]?.image?.url || null,
        });
      }
    }
    return [...porProducto.values()];
  }

  // Cambia la foto de las variantes de un SKU dentro de UN producto:
  //   1. suelta la foto vieja de la variante,
  //   2. crea la nueva y se la asigna,
  //   3. la ubica en la galería donde estaba la vieja,
  //   4. saca la vieja del producto. Con fileUpdate (no productDeleteMedia) el
  //      archivo queda en Contenido → Archivos: sirve de respaldo.
  // Una foto vieja que usa OTRA variante (ej. "French Pure" y "French-Pure-Old"
  // comparten imagen) no se saca del producto.
  async reemplazarFotoVariantes(productId, sku, imagenSrc, alt) {
    const skuUp = String(sku || '').trim().toUpperCase();
    const data = await this.graphql2025(`query fotosProducto($id: ID!) {
      product(id: $id) {
        media(first: 250) { nodes { id } }
        variants(first: 250) { nodes { id sku media(first: 5) { nodes { id } } } }
      }
    }`, { id: productId });

    const variantes = data?.product?.variants?.nodes || [];
    const objetivo = variantes.filter((v) => String(v.sku || '').trim().toUpperCase() === skuUp);
    if (objetivo.length === 0) throw new Error(`El producto no tiene variantes con SKU ${skuUp}`);

    const viejas = new Set(objetivo.flatMap((v) => v.media.nodes.map((m) => m.id)));
    const usadasPorOtras = new Set(
      variantes.filter((v) => !objetivo.includes(v)).flatMap((v) => v.media.nodes.map((m) => m.id))
    );
    const aQuitar = [...viejas].filter((id) => !usadasPorOtras.has(id));
    const galeria = (data?.product?.media?.nodes || []).map((m) => m.id);
    const posicion = galeria.findIndex((id) => viejas.has(id));

    const conFoto = objetivo.filter((v) => v.media.nodes.length > 0);
    const variantMedia = conFoto.map((v) => ({ variantId: v.id, mediaIds: v.media.nodes.map((m) => m.id) }));

    if (variantMedia.length > 0) {
      const d = await this.graphql2025(`mutation detach($productId: ID!, $variantMedia: [ProductVariantDetachMediaInput!]!) {
        productVariantDetachMedia(productId: $productId, variantMedia: $variantMedia) {
          userErrors { field message }
        }
      }`, { productId, variantMedia });
      const errs = d?.productVariantDetachMedia?.userErrors || [];
      if (errs.length) throw new Error(`No se pudo soltar la foto vieja: ${errs.map((e) => e.message).join('; ')}`);
    }

    let nuevaId = null;
    try {
      const d = await this.graphql2025(`mutation cambiarFoto($productId: ID!, $variants: [ProductVariantsBulkInput!]!, $media: [CreateMediaInput!]) {
        productVariantsBulkUpdate(productId: $productId, variants: $variants, media: $media) {
          productVariants { id media(first: 1) { nodes { id } } }
          userErrors { field message }
        }
      }`, {
        productId,
        variants: objetivo.map((v) => ({ id: v.id, mediaSrc: [imagenSrc] })),
        media: [{ originalSource: imagenSrc, mediaContentType: 'IMAGE', alt }],
      });
      const res = d?.productVariantsBulkUpdate;
      if (res?.userErrors?.length) throw new Error(res.userErrors.map((e) => e.message).join('; '));
      nuevaId = res?.productVariants?.[0]?.media?.nodes?.[0]?.id || null;
    } catch (err) {
      // Sin la foto nueva, la variante quedaría sin ninguna: se le devuelve la vieja.
      if (variantMedia.length > 0) {
        await this.graphql2025(`mutation append($productId: ID!, $variantMedia: [ProductVariantAppendMediaInput!]!) {
          productVariantAppendMedia(productId: $productId, variantMedia: $variantMedia) {
            userErrors { field message }
          }
        }`, { productId, variantMedia }).catch(() => {});
      }
      throw new Error(`No se pudo asignar la foto nueva (se restauró la anterior): ${err.message}`);
    }

    const avisos = [];
    // La media nueva entra al final de la galería; se la lleva al lugar de la vieja.
    if (nuevaId && posicion >= 0) {
      try {
        const d = await this.graphql2025(`mutation reordenar($id: ID!, $moves: [MoveInput!]!) {
          productReorderMedia(id: $id, moves: $moves) { mediaUserErrors { field message } }
        }`, { id: productId, moves: [{ id: nuevaId, newPosition: String(posicion) }] });
        const errs = d?.productReorderMedia?.mediaUserErrors || [];
        if (errs.length) avisos.push(`No se pudo reordenar la galería: ${errs.map((e) => e.message).join('; ')}`);
      } catch (err) {
        avisos.push(`No se pudo reordenar la galería: ${err.message}`);
      }
    }

    if (aQuitar.length > 0) {
      try {
        const d = await this.graphql2025(`mutation quitarDelProducto($files: [FileUpdateInput!]!) {
          fileUpdate(files: $files) { userErrors { field message code } }
        }`, { files: aQuitar.map((id) => ({ id, referencesToRemove: [productId] })) });
        const errs = d?.fileUpdate?.userErrors || [];
        if (errs.length) avisos.push(`La foto vieja quedó en la galería: ${errs.map((e) => e.message).join('; ')}`);
      } catch (err) {
        avisos.push(`La foto vieja quedó en la galería: ${err.message}`);
      }
    }

    return {
      variantes: objetivo.length,
      quitadas: aQuitar.length,
      conservadas: viejas.size - aQuitar.length,
      avisos,
    };
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

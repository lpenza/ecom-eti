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
  async marcarComoCumplida(orderId, trackingNumber = null) {
    try {
      // Obtener los fulfillment_orders abiertos para esta orden
      const fulfillmentOrders = await this.obtenerFulfillmentOrders(orderId);
      const openFOs = fulfillmentOrders.filter((fo) => fo.status === 'open' || fo.status === 'in_progress');

      if (openFOs.length === 0) {
        throw new Error('No hay fulfillment_orders abiertos para esta orden');
      }

      const trackingUrl = process.env.UES_TRACKING_URL_TEMPLATE
        ? process.env.UES_TRACKING_URL_TEMPLATE.replace('{tracking}', encodeURIComponent(String(trackingNumber || '')))
        : null;

      const body = {
        fulfillment: {
          line_items_by_fulfillment_order: openFOs.map((fo) => ({
            fulfillment_order_id: fo.id,
          })),
          tracking_info: {
            number: trackingNumber || '',
            ...(trackingUrl ? { url: trackingUrl } : {}),
          },
          notify_customer: true,
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

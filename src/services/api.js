// Servicio API centralizado para todas las llamadas HTTP

const API_BASE = '/api';

/**
 * Wrapper para fetch con manejo de errores
 */
async function fetchAPI(url, options = {}) {
  try {
    const response = await fetch(`${API_BASE}${url}`, {
      headers: {
        'Content-Type': 'application/json',
        ...options.headers
      },
      ...options
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ message: 'Error desconocido' }));
      throw new Error(error.message || `HTTP ${response.status}`);
    }

    return await response.json();
  } catch (error) {
    console.error(`❌ Error en API ${url}:`, error);
    throw error;
  }
}

/**
 * Obtener todos los pedidos
 */
export async function obtenerPedidos() {
  const data = await fetchAPI('/pedidos');
  // Asegurar que siempre devolvemos un array
  return Array.isArray(data) ? data : [];
}

/**
 * Obtener pedidos finalizados para reclamos
 */
export async function obtenerPedidosFinalizados() {
  const data = await fetchAPI('/pedidos-finalizados');
  return Array.isArray(data) ? data : [];
}

/**
 * Sincronizar pedidos desde Shopify
 */
export async function sincronizarShopify() {
  return await fetchAPI('/sync-shopify', { method: 'POST' });
}

/**
 * Ejecutar fulfillment Shopify para pedidos con etiqueta generada
 */
export async function ejecutarFulfillmentShopify(pedidoIds = null) {
  return await fetchAPI('/fulfillment-shopify', {
    method: 'POST',
    body: JSON.stringify({ pedidoIds })
  });
}

/**
 * Reenviar notificacion de tracking para un pedido
 */
export async function notificarTrackingPedido(pedidoId, options = {}) {
  return await fetchAPI(`/notificar-tracking/${pedidoId}`, {
    method: 'POST',
    body: JSON.stringify({
      sendEmail: options.sendEmail !== false,
      sendWhatsApp: options.sendWhatsApp !== false
    })
  });
}

/**
 * Marcar pedido como notificado (para envios manuales de WhatsApp)
 */
export async function marcarPedidoNotificado(pedidoId) {
  return await fetchAPI(`/marcar-notificado/${pedidoId}`, {
    method: 'POST'
  });
}

/**
 * Generar etiqueta para un pedido
 */
export async function generarEtiqueta(pedidoId, payloadOverrides = null) {
  return await fetchAPI(`/generar-etiqueta/${pedidoId}`, {
    method: 'POST',
    body: JSON.stringify({ payloadOverrides })
  });
}

/**
 * Generar etiqueta de reclamo asociada a un pedido existente
 */
export async function generarEtiquetaReclamo(pedidoId, notas = '') {
  return await fetchAPI(`/reclamos/${pedidoId}/generar-etiqueta`, {
    method: 'POST',
    body: JSON.stringify({ notas })
  });
}

/**
 * Generar etiqueta de colaboracion (sin pedido Shopify)
 */
export async function generarEtiquetaColaboracion(data) {
  return await fetchAPI('/colaboraciones/generar-etiqueta', {
    method: 'POST',
    body: JSON.stringify(data || {})
  });
}

/**
 * Obtener pedidos candidatos para follow-up comercial
 */
export async function obtenerPedidosFollowUp({ days = 15, from = '', to = '', estado = '', pedido = '' } = {}) {
  const params = new URLSearchParams();
  params.set('days', String(days));
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  if (estado) params.set('estado', estado);
  if (pedido) params.set('pedido', pedido);

  return await fetchAPI(`/followup/pedidos?${params.toString()}`, { method: 'GET' });
}

export async function actualizarEstadoCliente(customerId, state) {
  return await fetchAPI(`/customers/${encodeURIComponent(customerId)}/state`, {
    method: 'PATCH',
    body: JSON.stringify({ state }),
  });
}

export async function obtenerNotasCliente(customerId) {
  return await fetchAPI(`/customers/${encodeURIComponent(customerId)}/notes`, {
    method: 'GET',
  });
}

export async function agregarNotaCliente(customerId, content) {
  return await fetchAPI(`/customers/${encodeURIComponent(customerId)}/notes`, {
    method: 'POST',
    body: JSON.stringify({ content }),
  });
}

/**
 * Obtener datos de un pedido específico
 */
export async function obtenerPedido(pedidoId) {
  return await fetchAPI(`/pedidos/${pedidoId}`);
}

/**
 * Login en UES
 */
export async function loginUES() {
  return await fetchAPI('/ues/login', { method: 'POST' });
}

/**
 * Verificar estado de autenticación UES
 */
export async function checkUESStatus() {
  return await fetchAPI('/ues/status', { method: 'GET' });
}

/**
 * Obtener preview exacta de payloads que se enviaran a UES
 */
export async function obtenerPayloadPreviewUES(pedidoId) {
  return await fetchAPI(`/ues/payload-preview/${pedidoId}`, { method: 'GET' });
}

export async function obtenerCatalogoDepartamentosUES() {
  return await fetchAPI('/ues/catalog/departamentos', { method: 'GET' });
}

export async function obtenerCatalogoLocalidadesUES(departamentoId) {
  const query = departamentoId ? `?departamento_id=${encodeURIComponent(departamentoId)}` : '';
  return await fetchAPI(`/ues/catalog/localidades${query}`, { method: 'GET' });
}

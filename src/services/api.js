// Servicio API centralizado para todas las llamadas HTTP

const API_BASE = '/api';

function getAuthHeaders() {
  const token = localStorage.getItem('velinne_token');
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export async function login(email, password) {
  const response = await fetch(`${API_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Error al iniciar sesión');
  return data;
}

export async function verifyToken() {
  const token = localStorage.getItem('velinne_token');
  if (!token) return null;
  const response = await fetch(`${API_BASE}/auth/me`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) return null;
  const data = await response.json();
  return data.user;
}

/**
 * Wrapper para fetch con manejo de errores
 */
async function fetchAPI(url, options = {}) {
  try {
    const response = await fetch(`${API_BASE}${url}`, {
      headers: {
        'Content-Type': 'application/json',
        ...getAuthHeaders(),
        ...options.headers
      },
      ...options
    });

    if (!response.ok) {
      // Intentar extraer error de JSON y, si falla, usar texto crudo
      let errorData = null;
      let fallbackText = '';

      try {
        errorData = await response.json();
      } catch {
        fallbackText = await response.text().catch(() => '');
      }

      const message =
        errorData?.message ||
        errorData?.error ||
        fallbackText ||
        `HTTP ${response.status}`;

      const error = new Error(message);
      error.response = errorData || { raw: fallbackText }; // Incluir datos completos del error
      error.status = response.status;
      throw error;
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
 * Obtener cola de pedidos para armado de operario (incluye pickup/express/estandar)
 */
export async function obtenerPedidosArmado() {
  const data = await fetchAPI('/pedidos-armado', { method: 'GET' });
  return Array.isArray(data?.data) ? data.data : [];
}

/**
 * Obtener pedidos finalizados para reclamos
 */
export async function obtenerPedidosFinalizados() {
  const data = await fetchAPI('/pedidos-finalizados');
  return Array.isArray(data) ? data : [];
}

/**
 * Obtener pedidos con total=0 (candidatos para reclamo)
 */
export async function obtenerPedidosParaReclamo() {
  const data = await fetchAPI('/pedidos-para-reclamo');
  return Array.isArray(data) ? data : [];
}

/**
 * Sincronizar pedidos desde Shopify
 */
export async function sincronizarShopify() {
  return await fetchAPI('/sync-shopify', { method: 'POST' });
}

/**
 * ⚠️ TEMPORAL: Reprocesar pedido de Shopify que no entró por webhook
 * Cuando ya no se necesite, eliminar esta función y el panel en App.jsx
 */
export async function reprocesarPedidoShopify(orderNumber) {
  return await fetchAPI('/reprocess-shopify-order', {
    method: 'POST',
    body: JSON.stringify({ orderNumber }),
  });
}

/**
 * Ejecutar fulfillment Shopify para pedidos con etiqueta generada
 */
export async function ejecutarFulfillmentShopify(pedidoIds = null, trackingTemplate = null) {
  return await fetchAPI('/fulfillment-shopify', {
    method: 'POST',
    body: JSON.stringify({ pedidoIds, trackingTemplate })
  });
}

/**
 * Generar link de WhatsApp con tracking
 */
export async function generarLinkWhatsApp(pedido, trackingTemplate) {
  return await fetchAPI(`/generar-link-whatsapp`, {
    method: 'POST',
    body: JSON.stringify({ pedido, trackingTemplate })
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
 * Marcar etiqueta como impresa
 */
export async function marcarEtiquetaImpresa(pedidoId) {
  return await fetchAPI(`/marcar-impresa/${pedidoId}`, { method: 'POST' });
}

/**
 * Marcar/desmarcar pedido como pendiente de contacto con cliente
 */
export async function actualizarRevisionContacto(pedidoId, { pendiente, motivo = '' } = {}) {
  return await fetchAPI(`/pedidos/${pedidoId}/revision-contacto`, {
    method: 'POST',
    body: JSON.stringify({ pendiente, motivo }),
  });
}

/**
 * Registrar que ya se contactó un pedido en pendientes de contacto
 */
export async function marcarRevisionContactoContactado(pedidoId) {
  return await fetchAPI(`/pedidos/${pedidoId}/revision-contacto/contactado`, {
    method: 'POST',
  });
}

/**
 * Enviar email masivo a pedidos pendientes de contacto
 */
export async function enviarEmailMasivoPendientesContacto({ pedidoIds = null, subjectTemplate = '', htmlTemplate = '', onlyWithoutPhone = true } = {}) {
  return await fetchAPI('/pedidos/revision-contacto/email-masivo', {
    method: 'POST',
    body: JSON.stringify({ pedidoIds, subjectTemplate, htmlTemplate, onlyWithoutPhone }),
  });
}

/**
 * Descartar etiqueta generada y devolver el pedido a validacion
 */
export async function descartarEtiqueta(pedidoId) {
  return await fetchAPI(`/descartar-etiqueta/${pedidoId}`, {
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

export async function consolidarEtiquetaExistente(pedidoId, data = {}) {
  return await fetchAPI(`/etiquetas/consolidar/${pedidoId}`, {
    method: 'POST',
    body: JSON.stringify(data || {}),
  });
}

/**
 * Generar etiqueta de reclamo asociada a un pedido existente
 */
export async function generarEtiquetaReclamo(pedidoId, notas = '', payloadOverrides = null) {
  return await fetchAPI(`/reclamos/${pedidoId}/generar-etiqueta`, {
    method: 'POST',
    body: JSON.stringify({ notas, payloadOverrides })
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

export async function marcarFollowupEnviado(pedidoId) {
  return await fetchAPI(`/pedidos/${pedidoId}/marcar-followup`, { method: 'POST' });
}

export async function obtenerFeedbackDashboard({ days = 30, from = '', to = '' } = {}) {
  const params = new URLSearchParams();
  params.set('days', String(days));
  if (from) params.set('from', from);
  if (to) params.set('to', to);

  return await fetchAPI(`/feedback/dashboard?${params.toString()}`, { method: 'GET' });
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
 * Geocodificar dirección del pedido con Google Maps y resolver localidad UES.
 * @param {string} pedidoId
 * @param {string|number|null} departamentoId - ID numérico del departamento ya seleccionado en el form
 */
export async function geocodificarPedido(pedidoId, departamentoId = null) {
  return await fetchAPI(`/pedidos/${pedidoId}/geocodificar`, {
    method: 'POST',
    body: JSON.stringify({ departamento_id: departamentoId }),
  });
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

export async function obtenerPuntosRetiroUES(localidadId) {
  const query = localidadId ? `?localidad_id=${encodeURIComponent(localidadId)}` : '';
  return await fetchAPI(`/ues/catalog/puntos-retiro${query}`, { method: 'GET' });
}

export async function combinarPdfsEtiquetas(pdfUrls = []) {
  return await fetchAPI('/ues/combinar-pdfs', {
    method: 'POST',
    body: JSON.stringify({ pdfUrls })
  });
}

/**
 * Regenerar caché de contexto UES (departamentos y localidades)
 */
export async function regenerarCacheUES() {
  return await fetchAPI('/ues/regenerar-cache', { method: 'POST' });
}

/**
 * Obtener estado del caché UES
 */
export async function obtenerEstadoCacheUES() {
  return await fetchAPI('/ues/cache-status');
}

// ==================== PLANTILLAS ====================

/**
 * Obtener todas las plantillas
 */
export async function obtenerPlantillas() {
  const response = await fetchAPI('/templates', { method: 'GET' });
  return response.data || [];
}

/**
 * Crear una nueva plantilla
 */
export async function crearPlantilla(plantilla) {
  const response = await fetchAPI('/templates', {
    method: 'POST',
    body: JSON.stringify(plantilla)
  });
  return response.data;
}

/**
 * Actualizar una plantilla existente
 */
export async function actualizarPlantilla(id, cambios) {
  const response = await fetchAPI(`/templates/${id}`, {
    method: 'PUT',
    body: JSON.stringify(cambios)
  });
  return response.data;
}

/**
 * Eliminar una plantilla
 */
export async function eliminarPlantilla(id) {
  return await fetchAPI(`/templates/${id}`, { method: 'DELETE' });
}

/**
 * Establecer plantilla activa
 */
export async function activarPlantilla(id) {
  const response = await fetchAPI(`/templates/${id}/activate`, { method: 'POST' });
  return response.data;
}

/**
 * Inicializar plantillas por defecto
 */
export async function inicializarPlantillas() {
  const response = await fetchAPI('/templates/initialize', { method: 'POST' });
  return response.data || [];
}

// ==================== MARCAR DESPACHADOS BULK ====================

/**
 * Marcar múltiples pedidos como despachados (estado despachado + tag en Shopify)
 */
export async function marcarDespachados(pedidoIds) {
  return await fetchAPI('/marcar-despachados-bulk', {
    method: 'POST',
    body: JSON.stringify({ pedidoIds }),
  });
}

/**
 * Marcar pedidos como procesados SIN hacer fulfillment en Shopify.
 * Usado para pickup_local, recibilo_hoy, o despachados con fulfillment ya hecho.
 */
export async function marcarProcesados(pedidoIds) {
  return await fetchAPI('/marcar-procesados-bulk', {
    method: 'POST',
    body: JSON.stringify({ pedidoIds }),
  });
}

/**
 * Marcar pedidos como armados (estado intermedio) para que aparezcan en Despachados.
 */
export async function marcarArmados(pedidoIds) {
  return await fetchAPI('/marcar-armados-bulk', {
    method: 'POST',
    body: JSON.stringify({ pedidoIds }),
  });
}

/**
 * Obtener line_items de un pedido desde Shopify por su numero_pedido
 */
export async function obtenerDetallePedido(numeroPedido) {
  return await fetchAPI(`/pedido-detalle/${encodeURIComponent(numeroPedido)}`);
}

// ==================== PEDIDOS DESPACHADOS / PROCESADOS ====================

/**
 * Obtener pedidos despachados (sin fulfillment Shopify aún)
 */
export async function obtenerPedidosDespachados() {
  const data = await fetchAPI('/pedidos-despachados', { method: 'GET' });
  return Array.isArray(data?.data) ? data.data : [];
}

/**
 * Obtener pedidos procesados (fulfillment enviado a Shopify)
 */
export async function obtenerPedidosEnviados() {
  const data = await fetchAPI('/pedidos-enviados', { method: 'GET' });
  return Array.isArray(data?.data) ? data.data : [];
}

// ==================== RECLAMOS PENDIENTES ====================

/**
 * Obtener reclamos pendientes de notificar al cliente
 */
export async function obtenerReclamosPendientes() {
  const data = await fetchAPI('/reclamos-pendientes', { method: 'GET' });
  return Array.isArray(data?.data) ? data.data : [];
}

// ==================== PICK-UP / RECIBILO HOY ====================

export async function obtenerPedidosPickup() {
  const data = await fetchAPI('/pedidos-pickup', { method: 'GET' });
  return Array.isArray(data?.data) ? data.data : [];
}

export async function obtenerPedidosRecibilo() {
  const data = await fetchAPI('/pedidos-recibilo', { method: 'GET' });
  return Array.isArray(data?.data) ? data.data : [];
}

export async function buscarEtiquetaDrive(numeroPedido) {
  return await fetchAPI(`/drive-etiqueta/${encodeURIComponent(numeroPedido)}`, { method: 'GET' });
}

export async function guardarLinkDriveEnPedido(pedidoId, linkDrive) {
  return await fetchAPI(`/pedidos/${pedidoId}/guardar-link-drive`, {
    method: 'POST',
    body: JSON.stringify({ linkDrive }),
  });
}

/**
 * Descarga varios PDFs de Drive y los devuelve como un único Blob PDF.
 * @param {string[]} links - Array de links de Google Drive
 */
export async function mergePedidosPDF(links) {
  const response = await fetch(`${API_BASE}/drive-etiquetas/merge-pdf`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ links }),
  });
  if (!response.ok) {
    let msg = 'Error al generar PDF unificado';
    try { const j = await response.json(); msg = j.error || msg; } catch (_) {}
    throw new Error(msg);
  }
  return response.blob();
}

// ==================== BOT WHATSAPP ====================

export async function obtenerBotContacts(params = {}) {
  const query = new URLSearchParams();
  Object.entries(params || {}).forEach(([k, v]) => {
    if (v !== undefined && v !== null && String(v).trim() !== '') {
      query.set(k, String(v));
    }
  });

  const suffix = query.toString() ? `?${query.toString()}` : '';
  const data = await fetchAPI(`/bot/contacts${suffix}`, { method: 'GET' });
  return Array.isArray(data) ? data : [];
}

export async function obtenerBotContactHistory(contactId) {
  const data = await fetchAPI(`/bot/contacts/${encodeURIComponent(contactId)}/history`, { method: 'GET' });
  return Array.isArray(data) ? data : [];
}

export async function actualizarBotContactControl(contactId, payload = {}) {
  return await fetchAPI(`/bot/contacts/${encodeURIComponent(contactId)}/control`, {
    method: 'PATCH',
    body: JSON.stringify(payload || {}),
  });
}


export async function obtenerMisPedidosArmados(desde, hasta) {
  const params = new URLSearchParams();
  if (desde) params.append('desde', desde);
  if (hasta) params.append('hasta', hasta);
  return await fetchAPI(`/mis-pedidos-armados?${params}`);
}

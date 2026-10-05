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
 * Obtener URL de auto-login a StockPlanner (admin → cuenta dueño; armador/"user" → cuenta acotada a /transito).
 * El backend inicia sesión contra Supabase y devuelve la URL con los tokens en el hash.
 */
export async function obtenerStockPlannerSSO() {
  return fetchAPI('/admin/stockplanner-sso');
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
 * Igual que fetchAPI, pero para endpoints que informan progreso en vivo
 * (ver progresoNdjson en server.js): llama a onProgreso con cada paso
 * ({ mensaje, hechos, total, item? }) y devuelve la respuesta final.
 */
async function fetchAPIConProgreso(url, options = {}, onProgreso) {
  const response = await fetch(`${API_BASE}${url}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'X-Progreso': 'ndjson',
      ...getAuthHeaders(),
      ...options.headers,
    },
  });

  // Validaciones previas al primer paso: JSON común.
  if (!(response.headers.get('content-type') || '').includes('ndjson')) {
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      const error = new Error(data?.message || data?.error || `HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return data;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let final = null;
  const procesar = (linea) => {
    if (!linea.trim()) return;
    const evento = JSON.parse(linea);
    if (evento.tipo === 'progreso') onProgreso?.(evento);
    else final = evento;
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lineas = buffer.split('\n');
    buffer = lineas.pop();
    lineas.forEach(procesar);
  }
  procesar(buffer + decoder.decode());

  if (!final) throw new Error('Se cortó la conexión antes de terminar. Revisá qué quedó creado antes de reintentar.');
  if (final.tipo === 'error') throw new Error(final.error || 'Error en el servidor');
  return final;
}

// ==================== EMAILS (buzón de la empresa) ====================

/** Alias que el usuario puede leer/usar como remitente. */
export async function obtenerEmailAliases() {
  return fetchAPI('/emails/aliases');
}

/** Lista la bandeja. folder: 'inbox' (recibidos) | 'sent' (enviados). */
export async function obtenerEmails({ alias = 'all', limit = 30, folder = 'inbox' } = {}) {
  const params = new URLSearchParams({ alias, limit: String(limit), folder });
  return fetchAPI(`/emails?${params.toString()}`);
}

/** Detalle de un correo por UID. folder: 'inbox' | 'sent'. */
export async function obtenerEmail(uid, folder = 'inbox') {
  const params = new URLSearchParams({ folder });
  return fetchAPI(`/emails/${encodeURIComponent(uid)}?${params.toString()}`);
}

/** Enviar un correo (respuesta o nuevo). */
export async function enviarEmail(payload) {
  return fetchAPI('/emails/send', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

/** Descargar un adjunto de un correo (devuelve un Blob). */
export async function descargarAdjunto(uid, attachmentId, folder = 'inbox') {
  const params = new URLSearchParams({ folder });
  const res = await fetch(
    `${API_BASE}/emails/${encodeURIComponent(uid)}/attachments/${encodeURIComponent(attachmentId)}?${params.toString()}`,
    { headers: { ...getAuthHeaders() } }
  );
  if (!res.ok) throw new Error('No se pudo descargar el adjunto');
  return res.blob();
}

/** Firmas por alias (objeto { alias: html }). */
export async function obtenerFirmasEmail() {
  return fetchAPI('/emails/firmas');
}

/** Guardar la firma de un alias (solo admin). */
export async function guardarFirmaEmail(alias, html) {
  return fetchAPI(`/emails/firmas/${encodeURIComponent(alias)}`, {
    method: 'PUT',
    body: JSON.stringify({ html }),
  });
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
 * Traer ventas de MercadoLibre al panel (y bajar las etiquetas de Mercado Envíos).
 */
export async function sincronizarMercadoLibre(horas = 72) {
  return await fetchAPI('/mercadolibre/sincronizar', {
    method: 'POST',
    body: JSON.stringify({ horas }),
  });
}

/**
 * Estado de la conexión con MercadoLibre (configurado / conectado / motivo).
 */
export async function obtenerEstadoMercadoLibre() {
  return await fetchAPI('/mercadolibre/estado');
}

/**
 * Link de autorización OAuth de MercadoLibre (solo admin).
 */
export async function obtenerAuthUrlMercadoLibre() {
  return await fetchAPI('/mercadolibre/auth-url');
}

/**
 * Descargar/refrescar la etiqueta de Mercado Envíos de un pedido.
 */
export async function obtenerEtiquetaMercadoLibre(pedidoId, forzar = false) {
  return await fetchAPI(`/mercadolibre/etiqueta/${pedidoId}${forzar ? '?forzar=1' : ''}`);
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
 * Preview del email de contacto de un pedido (remitente, asunto y cuerpo con firma), sin enviar
 */
export async function previewEmailContacto(pedidoId, { subjectTemplate = '', htmlTemplate = '' } = {}) {
  return await fetchAPI(`/pedidos/${pedidoId}/revision-contacto/email-preview`, {
    method: 'POST',
    body: JSON.stringify({ subjectTemplate, htmlTemplate }),
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

export async function generarEtiquetaMarcoPostal(pedidoId) {
  return await fetchAPI(`/generar-etiqueta-marcopostal/${pedidoId}`, { method: 'POST' });
}

// MarcoPostal Web (sesión + CSRF): preview + generación
export async function previewGuiaMarcoPostal(pedidoIdOrNumero) {
  return await fetchAPI(`/marcopostal/preview-guia/${pedidoIdOrNumero}`, { method: 'POST' });
}

export async function generarGuiaMarcoPostalWeb(pedidoIdOrNumero, payloadOverrides = null) {
  return await fetchAPI(`/marcopostal/generar-guia-web/${pedidoIdOrNumero}`, {
    method: 'POST',
    body: JSON.stringify({ payloadOverrides }),
  });
}

// Asocia manualmente un guiaId existente de MarcoPostal a un pedido (renderiza
// el PDF y guarda tracking + link en BD).
export async function asociarGuiaMarcoPostal(pedidoIdOrNumero, guiaId) {
  return await fetchAPI(`/marcopostal/asociar-guia/${pedidoIdOrNumero}`, {
    method: 'POST',
    body: JSON.stringify({ guiaId }),
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

export async function reintentarFollowup(pedidoId) {
  return await fetchAPI(`/pedidos/${pedidoId}/reintentar-followup`, { method: 'POST' });
}

export async function obtenerFeedbackDashboard({ days = 30, from = '', to = '' } = {}) {
  const params = new URLSearchParams();
  params.set('days', String(days));
  if (from) params.set('from', from);
  if (to) params.set('to', to);

  return await fetchAPI(`/feedback/dashboard?${params.toString()}`, { method: 'GET' });
}

export async function obtenerColorTrends({ desde, hasta, contexto = 'todos', granularidad = 'dia', comparativa = true } = {}) {
  const params = new URLSearchParams();
  if (desde) params.set('desde', desde);
  if (hasta) params.set('hasta', hasta);
  if (contexto) params.set('contexto', contexto);
  if (granularidad) params.set('granularidad', granularidad);
  if (comparativa) params.set('comparativa', '1');
  return await fetchAPI(`/analytics/color-trends?${params.toString()}`, { method: 'GET' });
}

export async function refrescarColorTrends({ desde = null, hasta = null } = {}) {
  return await fetchAPI('/analytics/color-trends/refresh', {
    method: 'POST',
    body: JSON.stringify({ desde, hasta }),
  });
}

export async function analizarRazonesCompra(force = false) {
  const qs = force ? '?refresh=true' : '';
  return await fetchAPI(`/feedback/purchase-reasons${qs}`, { method: 'GET' });
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

// ==================== GUÍA DE ATENCIÓN — CASOS AGREGADOS DESDE EL PANEL ====================

/** Casos que el equipo agregó desde el panel (complementan los casos curados en código). */
export async function obtenerAtencionFaqCasos() {
  const response = await fetchAPI('/atencion-faq/casos', { method: 'GET' });
  return response;
}

export async function crearAtencionFaqCaso(caso) {
  const response = await fetchAPI('/atencion-faq/casos', {
    method: 'POST',
    body: JSON.stringify(caso),
  });
  return response.data;
}

export async function actualizarAtencionFaqCaso(id, cambios) {
  const response = await fetchAPI(`/atencion-faq/casos/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify(cambios),
  });
  return response.data;
}

export async function eliminarAtencionFaqCaso(id) {
  return await fetchAPI(`/atencion-faq/casos/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

// ── Carritos Abandonados ──────────────────────────────────────────────────────

export async function obtenerCarritosAbandonados() {
  return await fetchAPI('/carritos-abandonados');
}

export async function sincronizarCarritosAbandonados() {
  return await fetchAPI('/carritos-abandonados/sincronizar', { method: 'POST' });
}

export async function probarMensajeCarrito(cartId, msgNum) {
  return await fetchAPI(`/carritos-abandonados/${cartId}/probar-mensaje`, {
    method: 'POST',
    body: JSON.stringify({ msgNum }),
  });
}

export async function crearCarritoManual({ telefono, nombre, cartUrl }) {
  return await fetchAPI('/carritos-abandonados/manual', {
    method: 'POST',
    body: JSON.stringify({ telefono, nombre, cartUrl }),
  });
}

// Reconcilia con Shopify (marca recuperados los que ya compraron) y devuelve la
// cola de carritos pendientes de contactar. No envía mensajes.
export async function revisarColaCarritos() {
  return await fetchAPI('/carritos-abandonados/revisar-cola', { method: 'POST' });
}

// Envía el link (próximo paso del flujo) a todos los carritos en cola.
export async function enviarLinkPendientes(limite) {
  return await fetchAPI('/carritos-abandonados/enviar-pendientes', {
    method: 'POST',
    body: JSON.stringify(limite ? { limite } : {}),
  });
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
 * Revertir pedidos a "Etiqueta Generada" (deshace un despacho/procesado hecho sin querer).
 * Conserva la etiqueta y el tracking; limpia estado/notificación/retiro.
 */
export async function revertirAEtiquetaGenerada(pedidoIds) {
  return await fetchAPI('/revertir-a-etiqueta-generada-bulk', {
    method: 'POST',
    body: JSON.stringify({ pedidoIds }),
  });
}

/**
 * Marcar pedidos como armados (estado intermedio) para que aparezcan en Despachados.
 */
export async function marcarArmados(pedidoIds, idsSecundarios = []) {
  return await fetchAPI('/marcar-armados-bulk', {
    method: 'POST',
    body: JSON.stringify({ pedidoIds, idsSecundarios }),
  });
}

/**
 * Obtener line_items de un pedido desde Shopify por su numero_pedido
 */
export async function obtenerDetallePedido(numeroPedido) {
  return await fetchAPI(`/pedido-detalle/${encodeURIComponent(numeroPedido)}`);
}

/**
 * Vista de atención al cliente: todos los pedidos con estado y motivo de contacto.
 * q opcional busca por número, nombre, email o teléfono.
 */
export async function obtenerPedidosAtencion(q = '') {
  const qs = q ? `?q=${encodeURIComponent(q)}` : '';
  return await fetchAPI(`/atencion/pedidos${qs}`);
}

/**
 * Buscar productos del catálogo de Shopify para armar un pedido manual desde atención.
 */
export async function buscarProductosAtencion(q = '') {
  const qs = q ? `?q=${encodeURIComponent(q)}` : '';
  return await fetchAPI(`/atencion/productos${qs}`);
}

/**
 * Crear un pedido en Shopify (Draft Order) y obtener el link de checkout.
 * payload: { lineItems: [{ variantId, quantity } | { title, price, quantity }], email, nombre, telefono, nota }
 */
export async function crearPedidoAtencion(payload) {
  return await fetchAPI('/atencion/crear-pedido', {
    method: 'POST',
    body: JSON.stringify(payload || {}),
  });
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
 * Cancelar la programación de los pickups diferidos (sin ids: todos los agendados).
 */
export async function cancelarPickupsProgramados(pedidoIds = null) {
  return await fetchAPI('/pickups-programados/cancelar', {
    method: 'POST',
    body: JSON.stringify({ pedidoIds }),
  });
}

/**
 * Marcar/desmarcar un pedido despachado como retirado por la cadetería.
 * Guarda fecha/hora (UY) y quién marcó en la BD; al desmarcar limpia el registro.
 */
export async function marcarRetiroCadeteria(pedidoId, retirado) {
  return await fetchAPI(`/pedidos/${pedidoId}/cadeteria`, {
    method: 'POST',
    body: JSON.stringify({ retirado }),
  });
}

/**
 * Buscar pedidos con etiqueta generada (no despachados) para la vista de cadetería.
 */
export async function buscarEtiquetasCadeteria(q) {
  const data = await fetchAPI(`/cadeteria/buscar-etiquetas?q=${encodeURIComponent(q)}`, { method: 'GET' });
  return Array.isArray(data?.data) ? data.data : [];
}

/**
 * Registrar una entrega sin despacho (cadetería se lleva un pedido en Etiqueta Generada).
 * Requiere motivo. Queda registrado para seguimiento del administrador.
 */
export async function registrarEntregaSinDespacho(pedidoId, motivo) {
  return await fetchAPI('/cadeteria/entrega-sin-despacho', {
    method: 'POST',
    body: JSON.stringify({ pedidoId, motivo }),
  });
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

// ==================== BÚSQUEDA PEDIDOS ====================

export async function buscarPedidos(q) {
  const data = await fetchAPI(`/pedidos/buscar?q=${encodeURIComponent(q)}`, { method: 'GET' });
  return Array.isArray(data?.data) ? data.data : [];
}

// ==================== REENVÍOS ====================

export async function obtenerPedidosReenvio() {
  const data = await fetchAPI('/pedidos-reenvio', { method: 'GET' });
  return Array.isArray(data?.data) ? data.data : [];
}

export async function crearReenvio(pedidoId, datos) {
  return await fetchAPI(`/pedidos/${pedidoId}/crear-reenvio`, {
    method: 'POST',
    body: JSON.stringify(datos),
  });
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


// ==================== STOCK COLORES "NC" (ARMADOR) ====================

/**
 * Listar productos NC con su stock actual (tabla productos).
 */
export async function obtenerStockNC() {
  const data = await fetchAPI('/armador/stock-nc', { method: 'GET' });
  return Array.isArray(data?.data) ? data.data : [];
}

/**
 * Sincronizar el stock de los productos NC desde Shopify hacia la tabla productos.
 */
export async function sincronizarStockNC() {
  return await fetchAPI('/armador/stock-nc/sincronizar', { method: 'POST' });
}

/**
 * Guardar un conteo físico de un producto NC: lo fija en Shopify (available) y en productos.
 */
export async function actualizarStockNC(id, sku, stock) {
  return await fetchAPI('/armador/stock-nc/actualizar', {
    method: 'POST',
    body: JSON.stringify({ id, sku, stock }),
  });
}

/**
 * Plan del alta de un color NC nuevo: qué productos de Shopify y qué familias de
 * ML se tocarían (y cuáles se saltean porque ya lo tienen). No escribe nada.
 */
export async function planNuevoColorNC(nombre, sku) {
  return await fetchAPI('/armador/stock-nc/nuevo-color/plan', {
    method: 'POST',
    body: JSON.stringify({ nombre, sku }),
  });
}

/**
 * Alta de un color NC nuevo: crea la variante en los productos de Shopify
 * elegidos, las publicaciones en las familias de ML elegidas y el producto en la BD.
 * `imagen` es { base64, mimeType, filename }. `colorShopify` ({ colorBase, patron, hex })
 * sólo hace falta cuando el color todavía no existe en los colores de Shopify.
 */
export async function crearNuevoColorNC({ nombre, sku, stock, imagen, productosShopify, familiasML, colorShopify }, onProgreso) {
  return await fetchAPIConProgreso('/armador/stock-nc/nuevo-color', {
    method: 'POST',
    body: JSON.stringify({ nombre, sku, stock, imagen, productosShopify, familiasML, colorShopify }),
  }, onProgreso);
}

/**
 * Plan del cambio de foto de un color NC: productos de Shopify y publicaciones
 * de ML que lo tienen, con su foto actual. No escribe nada.
 */
export async function planFotoColorNC(sku) {
  return await fetchAPI('/armador/stock-nc/foto/plan', {
    method: 'POST',
    body: JSON.stringify({ sku }),
  });
}

/**
 * Cambia la foto de un color NC en los productos de Shopify y las publicaciones
 * de ML elegidos. `imagen` es { base64, mimeType, filename }.
 */
export async function cambiarFotoColorNC({ sku, imagen, productosShopify, publicacionesML }, onProgreso) {
  return await fetchAPIConProgreso('/armador/stock-nc/foto', {
    method: 'POST',
    body: JSON.stringify({ sku, imagen, productosShopify, publicacionesML }),
  }, onProgreso);
}

/**
 * Comparación tienda (Shopify) vs depósito (StockPlanner) de los colores. Sólo admin.
 */
export async function obtenerStockTiendaVsDeposito() {
  const data = await fetchAPI('/admin/stock-nc/deposito', { method: 'GET' });
  if (data && data.success === false) throw new Error(data.error || 'Error leyendo el depósito');
  return Array.isArray(data?.data) ? data.data : [];
}

/**
 * Pedidos de StockPlanner que están en depósito (con lo que queda por trasladar). Sólo admin.
 */
export async function obtenerPedidosEnDeposito() {
  const data = await fetchAPI('/admin/stock-nc/deposito/pedidos', { method: 'GET' });
  return Array.isArray(data?.data) ? data.data : [];
}

/**
 * Historial de traslados depósito → tienda (los más nuevos primero).
 */
export async function obtenerHistorialTraslados(limit = 50) {
  const data = await fetchAPI(`/admin/stock-nc/deposito/traslados?limit=${limit}`, { method: 'GET' });
  return Array.isArray(data?.data) ? data.data : [];
}

/**
 * Vista previa del traslado de un pedido: líneas con lo que queda, stock en tienda y venta diaria.
 */
export async function obtenerPreviewTraslado(pedidoId) {
  const data = await fetchAPI(`/admin/stock-nc/deposito/pedidos/${pedidoId}/traslado`, { method: 'GET' });
  return data?.data || null;
}

/**
 * Trasladar del depósito a la tienda: `lines` = [{ id (línea del pedido), units }].
 */
export async function trasladarDepositoATienda(pedidoId, pct, lines) {
  return await fetchAPI(`/admin/stock-nc/deposito/pedidos/${pedidoId}/traslado`, {
    method: 'POST',
    body: JSON.stringify({ pct, lines }),
  });
}

// ==================== STOCK OTROS ARTÍCULOS (base coat, top coat, tratamientos) ====================
// Misma mecánica que stock NC (arriba), acotada a otra lista de prefijos de SKU en el backend.

/**
 * Listar "otros artículos" (base coat, top coat, tratamientos) con su stock actual.
 */
export async function obtenerStockOtros() {
  const data = await fetchAPI('/armador/stock-otros', { method: 'GET' });
  return Array.isArray(data?.data) ? data.data : [];
}

/**
 * Sincronizar el stock de "otros artículos" desde Shopify hacia la tabla productos.
 */
export async function sincronizarStockOtros() {
  return await fetchAPI('/armador/stock-otros/sincronizar', { method: 'POST' });
}

/**
 * Guardar un conteo físico de un "otro artículo": mismo endpoint que stock NC
 * (fija el valor en Shopify y en productos por id, sin importar la categoría).
 */
export async function actualizarStockOtros(id, sku, stock) {
  return await actualizarStockNC(id, sku, stock);
}

export async function obtenerMisPedidosArmados(desde, hasta) {
  const params = new URLSearchParams();
  if (desde) params.append('desde', desde);
  if (hasta) params.append('hasta', hasta);
  return await fetchAPI(`/mis-pedidos-armados?${params}`);
}


// ==================== CONTROL DE FACTURACIÓN (UES / MARCOPOSTAL) ====================

/**
 * Sube un Excel de facturación del courier. Con `guardar: false` sólo devuelve el
 * reporte (dry-run) para revisarlo antes de persistirlo.
 */
export async function cargarLiquidacionFacturacion({ filename, contenidoBase64, periodoDesde, periodoHasta, guardar = false, forzar = false, levantesCantidad = null }) {
  return await fetchAPI('/facturacion/cargar', {
    method: 'POST',
    body: JSON.stringify({ filename, contenidoBase64, periodoDesde, periodoHasta, guardar, forzar, levantesCantidad }),
  });
}

export async function obtenerLiquidacionesFacturacion(proveedor = null) {
  const query = proveedor ? `?proveedor=${encodeURIComponent(proveedor)}` : '';
  const data = await fetchAPI(`/facturacion/liquidaciones${query}`);
  return Array.isArray(data?.liquidaciones) ? data.liquidaciones : [];
}

export async function obtenerReporteFacturacion(liquidacionId) {
  return await fetchAPI(`/facturacion/liquidaciones/${liquidacionId}`);
}

export async function eliminarLiquidacionFacturacion(liquidacionId) {
  return await fetchAPI(`/facturacion/liquidaciones/${liquidacionId}`, { method: 'DELETE' });
}

export async function marcarRevisionLineaFacturacion(lineaId, estado, nota = null) {
  return await fetchAPI(`/facturacion/lineas/${lineaId}/revision`, {
    method: 'PATCH',
    body: JSON.stringify({ estado, nota }),
  });
}

export async function obtenerConfigFacturacion() {
  return await fetchAPI('/facturacion/config');
}

export async function guardarTarifaFacturacion(tarifa) {
  return await fetchAPI('/facturacion/tarifas', {
    method: 'PUT',
    body: JSON.stringify({ tarifa }),
  });
}

export async function guardarParametrosFacturacion(parametros) {
  return await fetchAPI('/facturacion/parametros', {
    method: 'PUT',
    body: JSON.stringify({ parametros }),
  });
}

// ── Notificaciones del panel lateral ────────────────────────────────────────

export async function obtenerNotificaciones(limit = 50) {
  return await fetchAPI(`/notificaciones?limit=${limit}`);
}

export async function marcarNotificacionLeida(id) {
  return await fetchAPI(`/notificaciones/${id}/leida`, { method: 'POST' });
}

export async function marcarTodasNotificacionesLeidas() {
  return await fetchAPI('/notificaciones/leer-todas', { method: 'POST' });
}

// Estado del levante automático (lun/mié/vie 12:30 UY) y disparo manual.
export async function obtenerEstadoLevanteAutomatico() {
  return await fetchAPI('/ues/levante-automatico');
}

export async function ejecutarLevanteAutomatico() {
  return await fetchAPI('/ues/levante-automatico/ejecutar', { method: 'POST' });
}

// ── Meta Ads ────────────────────────────────────────────────────────────────

export async function obtenerCuentasMetaAds() {
  return fetchAPI('/meta-ads/cuentas');
}

export async function obtenerCampaniasMetaAds({ cuenta, datePreset, filtro }) {
  const q = new URLSearchParams({ cuenta: cuenta || '', datePreset, filtro });
  return fetchAPI(`/meta-ads/campanias?${q}`);
}

export async function obtenerConjuntosMetaAds(campaniaId, { datePreset, filtro }) {
  const q = new URLSearchParams({ datePreset, filtro });
  return fetchAPI(`/meta-ads/campanias/${campaniaId}/conjuntos?${q}`);
}

export async function obtenerAnunciosMetaAds(conjuntoId, { datePreset, filtro }) {
  const q = new URLSearchParams({ datePreset, filtro });
  return fetchAPI(`/meta-ads/conjuntos/${conjuntoId}/anuncios?${q}`);
}

export async function cambiarEstadoMetaAds(id, estado, nombre) {
  return fetchAPI(`/meta-ads/${id}/estado`, { method: 'POST', body: JSON.stringify({ estado, nombre }) });
}

// cambio = { monto } (monto nuevo en la moneda de la cuenta) o { porcentaje } (+20, -15...)
export async function cambiarPresupuestoMetaAds(id, cambio) {
  return fetchAPI(`/meta-ads/${id}/presupuesto`, { method: 'POST', body: JSON.stringify(cambio) });
}

export async function duplicarMetaAds(id, tipo) {
  return fetchAPI(`/meta-ads/${id}/duplicar`, { method: 'POST', body: JSON.stringify({ tipo }) });
}

export async function obtenerParametrosMetaAds() {
  return fetchAPI('/meta-ads/parametros');
}

export async function guardarParametrosMetaAds(parametros) {
  return fetchAPI('/meta-ads/parametros', { method: 'PUT', body: JSON.stringify({ parametros }) });
}

// ── Meta Ads: piloto con aprobación ─────────────────────────────────────────

export async function obtenerInicioMetaAds() {
  return fetchAPI('/meta-ads/piloto/inicio');
}

// vista: 'pendientes' | 'historial'
export async function obtenerPropuestasMetaAds(vista = 'pendientes') {
  return fetchAPI(`/meta-ads/propuestas?vista=${vista}`);
}

export async function aprobarPropuestaMetaAds(id) {
  return fetchAPI(`/meta-ads/propuestas/${id}/aprobar`, { method: 'POST', body: JSON.stringify({}) });
}

export async function rechazarPropuestaMetaAds(id, motivo) {
  return fetchAPI(`/meta-ads/propuestas/${id}/rechazar`, { method: 'POST', body: JSON.stringify({ motivo }) });
}

export async function obtenerJobsMetaAds() {
  return fetchAPI('/meta-ads/jobs');
}

export async function ejecutarJobMetaAds(job) {
  return fetchAPI(`/meta-ads/jobs/${job}/ejecutar`, { method: 'POST', body: JSON.stringify({}) });
}

export async function obtenerActividadMetaAds(dias = 7) {
  return fetchAPI(`/meta-ads/actividad?dias=${dias}`);
}

export async function obtenerTandasMetaAds(fresco = false) {
  return fetchAPI(`/meta-ads/tandas${fresco ? '?fresco=1' : ''}`);
}

// Ángulo o VELn para un archivo de Drive que no los trae en la carpeta/nombre.
export async function asignarCreativoMetaAds(fileId, { angulo, veln }) {
  return fetchAPI(`/meta-ads/creativos/${encodeURIComponent(fileId)}/asignacion`, { method: 'PUT', body: JSON.stringify({ angulo, veln }) });
}

// Miniatura de Drive como blob (el endpoint pide el token, así que no sirve un <img src> directo).
export async function obtenerMiniaturaCreativo(fileId) {
  const response = await fetch(`${API_BASE}/meta-ads/creativos/${encodeURIComponent(fileId)}/miniatura`, { headers: getAuthHeaders() });
  if (!response.ok) return null;
  return response.blob();
}

// job: 'reporte' | 'auditoria' | 'ganadores'
export async function obtenerReportesMetaAds(job) {
  return fetchAPI(`/meta-ads/reportes?job=${job}`);
}

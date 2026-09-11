const axios = require('axios');
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const logService = require('./logService');
require('dotenv').config();

const API_BASE = 'https://api.mercadolibre.com';
const AUTH_BASE = process.env.ML_AUTH_BASE || 'https://auth.mercadolibre.com.uy';
const OUTPUT_DIR = path.join(__dirname, '..', 'public', 'etiquetas-mercadolibre');
const PUBLIC_URL_BASE = '/etiquetas-mercadolibre';

// Modos de envío en los que la etiqueta la emite MercadoLibre (Mercado Envíos).
// El resto ('custom', 'not_specified', me1 viejo) son envíos por nuestra cuenta:
// entran al flujo normal de UES / Marco Postal como cualquier pedido de Shopify.
const LOGISTIC_TYPES_ME = new Set([
  'drop_off', 'xd_drop_off', 'cross_docking', 'self_service', 'fulfillment',
]);

class MercadoLibreService {
  constructor() {
    this.clientId = process.env.ML_CLIENT_ID;
    this.clientSecret = process.env.ML_CLIENT_SECRET;
    this.redirectUri = process.env.ML_REDIRECT_URI;
    // Cache en memoria del token; la fuente de verdad es la tabla ml_config.
    this.cache = null;
    this.refreshPromise = null;
  }

  configurado() {
    return Boolean(this.clientId && this.clientSecret && this.redirectUri);
  }

  // ── OAuth ──────────────────────────────────────────────────────────────────

  // URL a la que mandamos al dueño de la cuenta para que autorice la app.
  // `state` viaja de ida y vuelta: lo usamos para validar el callback.
  urlAutorizacion(state = '') {
    if (!this.configurado()) {
      throw new Error('Faltan ML_CLIENT_ID / ML_CLIENT_SECRET / ML_REDIRECT_URI en el .env');
    }
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
    });
    if (state) params.set('state', state);
    return `${AUTH_BASE}/authorization?${params.toString()}`;
  }

  // Canje del `code` del callback por el primer par de tokens.
  async canjearCodigo(code) {
    const { data } = await axios.post(`${API_BASE}/oauth/token`, new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: this.clientId,
      client_secret: this.clientSecret,
      code,
      redirect_uri: this.redirectUri,
    }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });

    const guardado = await this.guardarTokens(data);
    logService.success(`[ML] Cuenta conectada (seller ${guardado.seller_id})`);
    return guardado;
  }

  // El refresh_token de ML es de UN SOLO USO: cada refresh devuelve uno nuevo.
  // Si no lo persistimos, la conexión se corta y hay que reautorizar a mano.
  async refrescarToken() {
    // Un solo refresh a la vez: si dos requests ven el token vencido al mismo
    // tiempo y ambos refrescan, el segundo usa un refresh_token ya quemado.
    if (this.refreshPromise) return await this.refreshPromise;

    this.refreshPromise = (async () => {
      const supabaseService = require('./supabaseService');
      const config = await supabaseService.obtenerConfigML();
      if (!config?.refresh_token) {
        throw new Error('MercadoLibre no está conectado (falta refresh_token). Autorizá la app desde el panel.');
      }

      try {
        const { data } = await axios.post(`${API_BASE}/oauth/token`, new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: this.clientId,
          client_secret: this.clientSecret,
          refresh_token: config.refresh_token,
        }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });

        return await this.guardarTokens(data, config);
      } catch (err) {
        const detalle = err.response?.data?.message || err.message;
        logService.error(`[ML] No se pudo refrescar el token: ${detalle}`);
        throw new Error(`No se pudo refrescar el token de MercadoLibre: ${detalle}`);
      }
    })();

    try {
      return await this.refreshPromise;
    } finally {
      this.refreshPromise = null;
    }
  }

  async guardarTokens(data, previo = null) {
    const supabaseService = require('./supabaseService');
    const registro = {
      seller_id: String(data.user_id || previo?.seller_id || ''),
      access_token: data.access_token,
      refresh_token: data.refresh_token || previo?.refresh_token,
      // Margen de 5 min para no usar un token que vence mientras viaja el request.
      expires_at: new Date(Date.now() + ((data.expires_in || 21600) - 300) * 1000).toISOString(),
    };
    const guardado = await supabaseService.guardarConfigML(registro);
    this.cache = guardado;
    return guardado;
  }

  // Devuelve un access_token válido, refrescando si hace falta.
  async getAccessToken() {
    if (!this.configurado()) {
      throw new Error('MercadoLibre no está configurado (faltan credenciales en el .env)');
    }
    if (this.cache?.access_token && new Date(this.cache.expires_at) > new Date()) {
      return this.cache.access_token;
    }

    const supabaseService = require('./supabaseService');
    const config = await supabaseService.obtenerConfigML();
    if (config?.access_token && config.expires_at && new Date(config.expires_at) > new Date()) {
      this.cache = config;
      return config.access_token;
    }

    const renovado = await this.refrescarToken();
    return renovado.access_token;
  }

  async getSellerId() {
    if (this.cache?.seller_id) return this.cache.seller_id;
    const supabaseService = require('./supabaseService');
    const config = await supabaseService.obtenerConfigML();
    if (config?.seller_id) {
      this.cache = { ...(this.cache || {}), ...config };
      return config.seller_id;
    }
    throw new Error('MercadoLibre no está conectado (falta seller_id)');
  }

  // Estado para mostrar en el panel: conectado / no conectado / no configurado.
  async estado() {
    if (!this.configurado()) {
      return {
        configurado: false,
        conectado: false,
        motivo: 'Faltan ML_CLIENT_ID / ML_CLIENT_SECRET / ML_REDIRECT_URI',
      };
    }
    try {
      const supabaseService = require('./supabaseService');
      const config = await supabaseService.obtenerConfigML();
      if (!config?.refresh_token) {
        return { configurado: true, conectado: false, motivo: 'La app todavía no fue autorizada' };
      }
      const me = await this.request('GET', '/users/me');
      return {
        configurado: true,
        conectado: true,
        sellerId: String(me.id),
        nickname: me.nickname,
        expiraEn: config.expires_at,
      };
    } catch (err) {
      return { configurado: true, conectado: false, motivo: err.message };
    }
  }

  // ── Cliente HTTP ───────────────────────────────────────────────────────────

  // Un 401 puede pasar aunque el token figure vigente (revocación, reloj corrido):
  // refrescamos una vez y reintentamos.
  async request(method, url, { params, data, responseType, reintento = false } = {}) {
    const token = await this.getAccessToken();
    try {
      const resp = await axios({
        method,
        url: url.startsWith('http') ? url : `${API_BASE}${url}`,
        headers: { Authorization: `Bearer ${token}` },
        params,
        data,
        responseType,
        timeout: 30000,
      });
      return resp.data;
    } catch (err) {
      if (err.response?.status === 401 && !reintento) {
        await this.refrescarToken();
        return await this.request(method, url, { params, data, responseType, reintento: true });
      }
      const detalle = err.response?.data?.message || err.response?.data?.error || err.message;
      throw new Error(`ML ${method} ${url}: ${detalle}`);
    }
  }

  // ── Ventas ─────────────────────────────────────────────────────────────────

  // Ventas pagas de las últimas `horas`. ML pagina de a 50 y tiene un tope duro
  // de 1000 resultados por búsqueda; con la ventana de horas nunca se llega.
  async obtenerVentasRecientes(horas = 72) {
    const sellerId = await this.getSellerId();
    const desde = new Date(Date.now() - horas * 60 * 60 * 1000).toISOString();
    const ventas = [];
    const LIMIT = 50;
    const MAX_PAGINAS = 20;

    for (let pagina = 0; pagina < MAX_PAGINAS; pagina++) {
      const data = await this.request('GET', '/orders/search', {
        params: {
          seller: sellerId,
          'order.date_created.from': desde,
          sort: 'date_desc',
          limit: LIMIT,
          offset: pagina * LIMIT,
        },
      });
      const lote = data.results || [];
      ventas.push(...lote);
      if (lote.length < LIMIT) break;
    }

    // Sólo las pagas: las que están 'payment_required' todavía no son una venta.
    return ventas.filter((o) => o.status === 'paid' || o.status === 'partially_paid');
  }

  async obtenerVenta(orderId) {
    return await this.request('GET', `/orders/${orderId}`);
  }

  async obtenerEnvio(shipmentId) {
    return await this.request('GET', `/shipments/${shipmentId}`);
  }

  // Órdenes de un carrito (varias ventas que viajan en un mismo paquete).
  async obtenerPack(packId) {
    return await this.request('GET', `/packs/${packId}`);
  }

  // Todas las ventas de un carrito, completas. El webhook avisa por UNA venta;
  // sin esto, sincronizar el paquete perdería los ítems de las hermanas.
  async obtenerVentasDelPack(packId) {
    const pack = await this.obtenerPack(packId);
    const ids = (pack?.orders || []).map((o) => o.id).filter(Boolean);
    if (ids.length === 0) return [];
    return await Promise.all(ids.map((id) => this.obtenerVenta(id)));
  }

  // ── Normalización a la forma de `pedidos` ──────────────────────────────────

  // Convierte una venta de ML (+ su envío, si tiene) al shape que usa la tabla
  // `pedidos`. Devuelve también el diagnóstico de si la etiqueta la pone ML.
  async normalizarVenta(orden) {
    const shipmentId = orden.shipping?.id ? String(orden.shipping.id) : null;
    let envio = null;
    if (shipmentId) {
      try {
        envio = await this.obtenerEnvio(shipmentId);
      } catch (err) {
        // Un envío que todavía no existe no puede frenar el alta del pedido:
        // el próximo sync lo completa.
        logService.warning(`[ML] No se pudo leer el envío ${shipmentId}: ${err.message}`);
      }
    }

    const dir = envio?.receiver_address || {};
    const comprador = orden.buyer || {};
    const logisticType = envio?.logistic_type || null;
    const shippingMode = envio?.mode || orden.shipping?.shipping_mode || null;
    const etiquetaLaPoneML = LOGISTIC_TYPES_ME.has(String(logisticType));

    const calle = [dir.street_name, dir.street_number].filter(Boolean).join(' ').trim();

    // ML enmascara el teléfono del comprador en los envíos de Mercado Envíos
    // (devuelve "XXXXXXX"). Guardarlo sería peor que dejarlo vacío: el panel lo
    // tomaría como un contacto válido para WhatsApp.
    const enmascarado = (t) => !t || /^[x\s\-().]+$/i.test(String(t));
    const candidatoTel = dir.receiver_phone
      || [comprador.phone?.area_code, comprador.phone?.number].filter(Boolean).join('');
    const telefono = enmascarado(candidatoTel) ? '' : String(candidatoTel).trim();

    const items = (orden.order_items || []).map((it) => ({
      id: String(it.item?.id || ''),
      title: it.item?.title || '',
      variant_title: (it.item?.variation_attributes || [])
        .map((a) => `${a.name}: ${a.value_name}`).join(' / ') || null,
      quantity: it.quantity || 1,
      sku: it.item?.seller_sku || it.item?.seller_custom_field || null,
    }));

    return {
      ml_order_id: String(orden.id),
      ml_pack_id: orden.pack_id ? String(orden.pack_id) : null,
      ml_shipment_id: shipmentId,
      ml_logistic_type: logisticType,
      ml_shipping_mode: shippingMode,
      ml_items: items,
      etiquetaLaPoneML,
      // Columna genérica de tracking del panel (el nombre es histórico: nació con UES).
      numero_seguimiento_ues: envio?.tracking_number || null,
      cliente_nombre: dir.receiver_name
        || `${comprador.first_name || ''} ${comprador.last_name || ''}`.trim()
        || comprador.nickname
        || '',
      cliente_email: comprador.email || '',
      cliente_telefono: telefono,
      direccion_envio: calle || dir.address_line || '',
      // ML manda piso/apto y referencias en `comment`, aparte de la calle. Va a
      // su propia columna: mezclarlo con direccion_envio rompe el parseo del
      // courier. `delivery_preference` NO se suma: es sólo "residential"/"business".
      ml_referencia: dir.comment || null,
      localidad: dir.city?.name || '',
      departamento: dir.state?.name || '',
      codigo_postal: dir.zip_code || '',
      created_at: orden.date_created || new Date().toISOString(),
    };
  }

  // ── Etiqueta de Mercado Envíos ("la carpeta") ──────────────────────────────

  // ML entrega la etiqueta en 2 hojas: la 1ª es la etiqueta (A4 apaisada) y la 2ª
  // el remito, que no se imprime. Además, el resto del sistema (UES y Marco Postal)
  // produce SIEMPRE 1 hoja A4 vertical; si no igualamos el formato, al imprimir un
  // lote mezclado la de ML sale girada y descuadrada.
  //
  // Resultado: una sola página A4 vertical con el contenido de la hoja 1 rotado
  // 90° y escalado para entrar centrado.
  async normalizarEtiqueta(bytes) {
    const { PDFDocument, degrees } = require('pdf-lib');

    const origen = await PDFDocument.load(bytes, { ignoreEncryption: true });
    if (origen.getPageCount() === 0) throw new Error('El PDF de ML no tiene páginas');

    const salida = await PDFDocument.create();
    const [hoja] = await salida.embedPdf(origen, [0]); // sólo la primera hoja

    const A4_ANCHO = 595.28;
    const A4_ALTO = 841.89;
    const pagina = salida.addPage([A4_ANCHO, A4_ALTO]);

    const { width: w, height: h } = hoja;

    if (w > h) {
      // Apaisada → rotamos 90° para dejarla vertical como las demás. Al rotar, el
      // alto original pasa a ocupar el ancho de la hoja y viceversa.
      const escala = Math.min(A4_ANCHO / h, A4_ALTO / w);
      const anchoFinal = h * escala;   // huella horizontal ya rotada
      const altoFinal = w * escala;    // huella vertical ya rotada
      pagina.drawPage(hoja, {
        // drawPage rota en sentido antihorario alrededor de (x, y), así que el
        // ancla va en la esquina derecha del hueco donde queremos el contenido.
        x: (A4_ANCHO - anchoFinal) / 2 + anchoFinal,
        y: (A4_ALTO - altoFinal) / 2,
        width: w * escala,
        height: h * escala,
        rotate: degrees(90),
      });
    } else {
      // Ya viene vertical: sólo escalamos y centramos.
      const escala = Math.min(A4_ANCHO / w, A4_ALTO / h);
      pagina.drawPage(hoja, {
        x: (A4_ANCHO - w * escala) / 2,
        y: (A4_ALTO - h * escala) / 2,
        width: w * escala,
        height: h * escala,
      });
    }

    return Buffer.from(await salida.save());
  }

  // Baja el PDF de la etiqueta de ML y lo deja en public/ para que el panel lo
  // previsualice, lo imprima y lo combine con el resto igual que las de UES/MP.
  // Idempotente: si el archivo ya está, no vuelve a pedirlo.
  async descargarEtiqueta(shipmentId, { forzar = false } = {}) {
    if (!shipmentId) throw new Error('shipmentId requerido');

    const id = String(shipmentId).trim();
    const outFile = path.join(OUTPUT_DIR, `${id}.pdf`);
    const publicUrl = `${PUBLIC_URL_BASE}/${id}.pdf`;

    // Un PDF cacheado que no esté normalizado (bajado antes de este cambio) se
    // arregla sin volver a pedirlo a ML: alcanza con re-procesar los bytes.
    if (!forzar && fsSync.existsSync(outFile)) {
      if (await this.estaNormalizada(outFile)) return publicUrl;
      try {
        const viejo = await fs.readFile(outFile);
        await fs.writeFile(outFile, await this.normalizarEtiqueta(viejo));
        logService.info('[ML] Etiqueta cacheada re-normalizada a 1 hoja A4', { shipmentId: id });
        return publicUrl;
      } catch (err) {
        logService.warning(`[ML] No se pudo re-normalizar ${id}, se vuelve a bajar: ${err.message}`);
      }
    }

    await fs.mkdir(OUTPUT_DIR, { recursive: true });
    const crudo = await this.descargarEtiquetasCombinadas([id]);
    const bytes = await this.normalizarEtiqueta(crudo);
    await fs.writeFile(outFile, bytes);
    logService.info('[ML] Etiqueta descargada y normalizada', { shipmentId: id, publicUrl });
    return publicUrl;
  }

  // Combina en un solo PDF las etiquetas de varios envíos. ML acepta hasta 50
  // shipment_ids por llamada y devuelve el PDF ya paginado.
  async descargarEtiquetasCombinadas(shipmentIds = []) {
    const ids = [...new Set(shipmentIds.map((s) => String(s).trim()).filter(Boolean))];
    if (ids.length === 0) throw new Error('Sin envíos para imprimir');

    // `response_type=pdf` devuelve la etiqueta lista para imprimir, en el formato
    // configurado en ML (100x150 o A4).
    const buffer = await this.request('GET', '/shipment_labels', {
      params: { shipment_ids: ids.slice(0, 50).join(','), response_type: 'pdf' },
      responseType: 'arraybuffer',
    });

    const bytes = Buffer.from(buffer);
    // Un error de ML puede llegar como JSON con status 200; sin esta guarda
    // guardaríamos basura con extensión .pdf.
    if (bytes.slice(0, 4).toString() !== '%PDF') {
      throw new Error(`ML no devolvió un PDF (envíos ${ids.join(',')}): ${bytes.slice(0, 200).toString()}`);
    }
    return bytes;
  }

  // ¿El PDF cacheado ya está en el formato del resto (1 hoja A4 vertical)?
  async estaNormalizada(rutaPdf) {
    try {
      const { PDFDocument } = require('pdf-lib');
      const doc = await PDFDocument.load(await fs.readFile(rutaPdf), { ignoreEncryption: true });
      if (doc.getPageCount() !== 1) return false;
      const { width, height } = doc.getPage(0).getSize();
      return height > width;
    } catch {
      return false; // ilegible → que se regenere
    }
  }

  // Ruta local de una etiqueta ya descargada (la usa el combinador de PDFs).
  rutaEtiquetaLocal(shipmentId) {
    return path.join(OUTPUT_DIR, `${String(shipmentId).trim()}.pdf`);
  }
}

module.exports = new MercadoLibreService();
module.exports.LOGISTIC_TYPES_ME = LOGISTIC_TYPES_ME;

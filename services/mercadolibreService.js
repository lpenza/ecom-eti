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
// Marca (en el Subject del PDF) del formato actual de las etiquetas normalizadas.
const ETIQUETA_FORMATO = 'velinne-etiqueta-ml-v2';
// Una etiqueta bajada hace menos que esto se considera al día (evita pedirla
// dos veces cuando el visor y la descarga/impresión llegan seguidos).
const ETIQUETA_FRESCA_MS = 60 * 1000;

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
    // Índice SKU → publicaciones (ver obtenerIndicePublicaciones). Vive en memoria:
    // si el proceso reinicia se reconstruye solo en el primer push.
    this.indicePublicaciones = null;
    this.indicePublicacionesAt = 0;
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
  async request(method, url, { params, data, responseType, headers, reintento = false } = {}) {
    const token = await this.getAccessToken();
    try {
      const resp = await axios({
        method,
        url: url.startsWith('http') ? url : `${API_BASE}${url}`,
        headers: { ...headers, Authorization: `Bearer ${token}` },
        params,
        data,
        responseType,
        timeout: 30000,
      });
      return resp.data;
    } catch (err) {
      if (err.response?.status === 401 && !reintento) {
        await this.refrescarToken();
        return await this.request(method, url, { params, data, responseType, headers, reintento: true });
      }
      // Las validaciones de /items vienen en `cause`: sin ellas el error dice sólo
      // "Validation error" y no se sabe qué campo falló.
      const causas = (err.response?.data?.cause || [])
        .filter((c) => c?.type !== 'warning')
        .map((c) => c.message || c.code)
        .filter(Boolean);
      const detalle = [err.response?.data?.message || err.response?.data?.error || err.message, ...causas].join(' | ');
      const error = new Error(`ML ${method} ${url}: ${detalle}`);
      error.causas = err.response?.data?.cause || [];
      throw error;
    }
  }

  // ── Ventas ─────────────────────────────────────────────────────────────────

  // Todas las ventas de las últimas `horas`, en cualquier estado. ML pagina de a
  // 50 y tiene un tope duro de 1000 resultados por búsqueda; con la ventana de
  // horas nunca se llega.
  async buscarVentas(horas = 72) {
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

    return ventas;
  }

  // Sólo las pagas: las que están 'payment_required' todavía no son una venta.
  async obtenerVentasRecientes(horas = 72) {
    const ventas = await this.buscarVentas(horas);
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

  // ── Catálogo y stock ───────────────────────────────────────────────────────

  // El SKU puede venir en tres lugares según cómo se cargó la publicación:
  // seller_custom_field, seller_sku, o el atributo SELLER_SKU.
  skuDePublicacion(obj) {
    if (!obj) return null;
    const directo = obj.seller_custom_field || obj.seller_sku;
    if (directo) return String(directo).trim();
    const attr = (obj.attributes || []).find((a) => a.id === 'SELLER_SKU');
    const valor = attr?.value_name || attr?.values?.[0]?.name;
    return valor ? String(valor).trim() : null;
  }

  // Todas las publicaciones activas, aplanadas a "unidades vendibles": un ítem
  // simple es una unidad; un ítem con variaciones es una unidad por variación,
  // que es el nivel al que ML lleva el stock.
  // `estados` incluye 'paused' a propósito: ML pausa sola cualquier publicación que
  // llega a stock 0. Si sólo miráramos las activas, un producto agotado parecería
  // no existir en ML — y al reponer stock nunca se le empujaría la cantidad nueva,
  // que es justo lo que la devuelve a estar publicada.
  async listarUnidadesPublicadas({ estados = ['active', 'paused'] } = {}) {
    const sellerId = await this.getSellerId();

    const ids = [];
    for (const estado of estados) {
      for (let offset = 0; offset < 2000; offset += 50) {
        const r = await this.request('GET', `/users/${sellerId}/items/search`, {
          params: { limit: 50, offset, status: estado },
        });
        const lote = r.results || [];
        ids.push(...lote);
        if (lote.length < 50) break;
      }
    }

    const unidades = [];
    // El multiget acepta 20 ids por llamada.
    for (let i = 0; i < ids.length; i += 20) {
      const r = await this.request('GET', '/items', {
        params: {
          ids: ids.slice(i, i + 20).join(','),
          attributes: 'id,title,family_name,status,permalink,available_quantity,seller_custom_field,attributes,variations',
        },
      });
      for (const fila of r) {
        if (fila.code !== 200 || !fila.body) continue;
        const it = fila.body;
        const variaciones = it.variations || [];
        if (variaciones.length === 0) {
          unidades.push({
            itemId: it.id,
            variationId: null,
            titulo: it.title,
            familia: it.family_name || null,
            estado: it.status,
            permalink: it.permalink || null,
            sku: this.skuDePublicacion(it),
            cantidadML: it.available_quantity,
          });
        } else {
          for (const v of variaciones) {
            unidades.push({
              itemId: it.id,
              variationId: v.id,
              titulo: it.title,
              permalink: it.permalink || null,
              sku: this.skuDePublicacion(v) || this.skuDePublicacion(it),
              cantidadML: v.available_quantity,
            });
          }
        }
      }
    }
    return unidades;
  }

  // Compara lo publicado en ML contra el stock de `productos`. SOLO LECTURA:
  // no escribe en ML ni en la base. Es la foto que alimenta el reporte y, más
  // adelante, la decisión de qué empujar.
  //
  // Criterio acordado para SKU con varias publicaciones: cada una lleva el stock
  // real completo (no se reparte), así que el objetivo de todas es el mismo.
  async compararStock(prefijos = ['NC', 'BSA', 'MRT', 'BSJ']) {
    const supabaseService = require('./supabaseService');
    const [unidades, productos] = await Promise.all([
      this.listarUnidadesPublicadas(),
      supabaseService.listarProductosPorPrefijoSku(prefijos),
    ]);

    const porSku = new Map(productos.map((p) => [String(p.sku).trim().toUpperCase(), p]));
    const publicacionesPorSku = {};
    const filas = [];
    const sinSku = [];
    const skuDesconocido = [];

    for (const u of unidades) {
      if (!u.sku) { sinSku.push(u); continue; }
      const clave = u.sku.toUpperCase();
      const producto = porSku.get(clave);
      if (!producto) { skuDesconocido.push(u); continue; }

      publicacionesPorSku[clave] = (publicacionesPorSku[clave] || 0) + 1;
      filas.push({
        ...u,
        sku: producto.sku,
        nombre: producto.nombre,
        stockNuestro: Number(producto.stock || 0),
        diferencia: Number(u.cantidadML || 0) - Number(producto.stock || 0),
      });
    }

    // Cuántas publicaciones tiene cada SKU: con el criterio "stock completo en
    // todas", un SKU con 3 publicaciones ofrece 3× su stock real.
    filas.forEach((f) => { f.publicacionesDelSku = publicacionesPorSku[f.sku.toUpperCase()]; });

    // Trim obligatorio: hay SKU cargados con espacios al final ("NC250120 "), y
    // sin normalizar el mismo producto aparecía a la vez publicado y sin publicar.
    const skusPublicados = new Set(filas.map((f) => String(f.sku).trim().toUpperCase()));
    const sinPublicar = productos.filter((p) => !skusPublicados.has(String(p.sku).trim().toUpperCase()));

    return {
      generadoAt: new Date().toISOString(),
      filas,
      sinSku,
      skuDesconocido,
      sinPublicar: sinPublicar.map((p) => ({ sku: p.sku, nombre: p.nombre, stock: p.stock })),
      totales: {
        publicaciones: unidades.length,
        mapeadas: filas.length,
        skusUnicos: skusPublicados.size,
        skusDuplicados: Object.values(publicacionesPorSku).filter((n) => n > 1).length,
        unidadesEnML: filas.reduce((s, f) => s + Number(f.cantidadML || 0), 0),
        unidadesNuestras: [...skusPublicados].reduce((s, k) => s + Number(porSku.get(k)?.stock || 0), 0),
        conDiferencia: filas.filter((f) => f.diferencia !== 0).length,
        mlOfreceDeMas: filas.filter((f) => f.diferencia > 0).length,
        mlOfreceDeMenos: filas.filter((f) => f.diferencia < 0).length,
      },
    };
  }

  // Índice SKU → publicaciones, cacheado en memoria. Sin esto, empujar el stock
  // de UN SKU obligaba a releer las 166 publicaciones (≈19 llamadas a ML) para
  // después descartar casi todas. Con el índice, un push puntual cuesta una
  // llamada por publicación.
  //
  // Se reconstruye solo cuando está vencido (1 h por defecto) o cuando se pide un
  // SKU que no figura — que es lo que pasa cuando se publica algo nuevo.
  async obtenerIndicePublicaciones({ forzar = false, maxEdadMs = 60 * 60 * 1000 } = {}) {
    const vencido = !this.indicePublicaciones
      || (Date.now() - this.indicePublicacionesAt) > maxEdadMs;
    if (forzar || vencido) {
      const unidades = await this.listarUnidadesPublicadas();
      const mapa = new Map();
      for (const u of unidades) {
        if (!u.sku) continue;
        const clave = String(u.sku).trim().toUpperCase();
        if (!mapa.has(clave)) mapa.set(clave, []);
        mapa.get(clave).push({
          itemId: u.itemId,
          variationId: u.variationId,
          cantidadML: u.cantidadML,
        });
      }
      this.indicePublicaciones = mapa;
      this.indicePublicacionesAt = Date.now();
    }
    return this.indicePublicaciones;
  }

  // Empuja cantidades a las publicaciones de SKU puntuales, usando el índice.
  // `cantidadesPorSku` es un objeto { SKU: cantidadAbsoluta }.
  async empujarStockDeSkus(cantidadesPorSku = {}, { pausaMs = 120 } = {}) {
    const skus = Object.keys(cantidadesPorSku);
    if (skus.length === 0) return { aplicados: [], fallados: [], sinPublicacion: [] };

    let indice = await this.obtenerIndicePublicaciones();
    // Un SKU que no figura puede ser una publicación nueva: se refresca el índice
    // una sola vez antes de darlo por inexistente.
    const faltaAlguno = skus.some((s) => !indice.has(String(s).trim().toUpperCase()));
    if (faltaAlguno) indice = await this.obtenerIndicePublicaciones({ forzar: true });

    const aplicados = [];
    const fallados = [];
    const sinPublicacion = [];

    for (const sku of skus) {
      const clave = String(sku).trim().toUpperCase();
      const publicaciones = indice.get(clave);
      if (!publicaciones || publicaciones.length === 0) { sinPublicacion.push(sku); continue; }

      const objetivo = Math.max(0, Math.trunc(Number(cantidadesPorSku[sku]) || 0));
      for (const pub of publicaciones) {
        // ML descuenta sola la publicación donde se vendió, así que muchas veces
        // ya está en el valor correcto y la escritura sobra.
        if (Number(pub.cantidadML) === objetivo) continue;
        try {
          await this.fijarStockPublicacion(pub.itemId, pub.variationId, objetivo);
          aplicados.push({ sku: String(sku).trim(), itemId: pub.itemId, antes: pub.cantidadML, ahora: objetivo });
          pub.cantidadML = objetivo; // el índice queda al día sin releer nada
        } catch (err) {
          fallados.push({ sku: String(sku).trim(), itemId: pub.itemId, objetivo, error: err.message });
        }
        if (pausaMs > 0) await new Promise((r) => setTimeout(r, pausaMs));
      }
    }
    return { aplicados, fallados, sinPublicacion };
  }

  // Fija la cantidad disponible de UNA publicación. Siempre valor absoluto:
  // ML descuenta su propio stock al vender, así que mandar diferencias descuenta
  // dos veces.
  async fijarStockPublicacion(itemId, variationId, cantidad) {
    const qty = Math.max(0, Math.trunc(Number(cantidad) || 0));
    if (variationId) {
      await this.request('PUT', `/items/${itemId}`, {
        data: { variations: [{ id: variationId, available_quantity: qty }] },
      });
    } else {
      await this.request('PUT', `/items/${itemId}`, { data: { available_quantity: qty } });
    }
    return qty;
  }

  // Empuja el stock real a todas las publicaciones que estén desfasadas.
  // Criterio acordado: cada publicación de un SKU lleva el stock COMPLETO (no se
  // reparte entre las publicaciones del mismo SKU).
  //
  // `simular: true` calcula todo sin escribir nada en ML.
  async ajustarStockEnML({ simular = false, excluirSkus = [], soloSkus = null, pausaMs = 120 } = {}) {
    const comparacion = await this.compararStock();
    const excluidos = new Set(excluirSkus.map((s) => String(s).trim().toUpperCase()));
    // `soloSkus` acota la corrida a los SKU que acaban de cambiar: el cron corto
    // empuja sólo lo que se movió en vez de reescribir todo el catálogo.
    const incluidos = soloSkus
      ? new Set(soloSkus.map((s) => String(s).trim().toUpperCase()))
      : null;

    const aCambiar = comparacion.filas.filter((f) => {
      const clave = String(f.sku).trim().toUpperCase();
      if (excluidos.has(clave)) return false;
      if (incluidos && !incluidos.has(clave)) return false;
      return Number(f.cantidadML) !== Number(f.stockNuestro);
    });

    const aplicados = [];
    const fallados = [];
    const omitidos = comparacion.filas.length - aCambiar.length;

    for (const f of aCambiar) {
      if (simular) {
        aplicados.push({ ...f, nuevaCantidad: f.stockNuestro, simulado: true });
        continue;
      }
      try {
        const qty = await this.fijarStockPublicacion(f.itemId, f.variationId, f.stockNuestro);
        aplicados.push({ sku: f.sku, nombre: f.nombre, itemId: f.itemId, antes: f.cantidadML, ahora: qty });
      } catch (err) {
        fallados.push({ sku: f.sku, itemId: f.itemId, antes: f.cantidadML, objetivo: f.stockNuestro, error: err.message });
      }
      // ML limita el ritmo de escritura; una pausa corta evita los 429.
      if (pausaMs > 0) await new Promise((r) => setTimeout(r, pausaMs));
    }

    return {
      simulado: simular,
      total: comparacion.filas.length,
      intentados: aCambiar.length,
      aplicados,
      fallados,
      omitidos,
      estadoPrevio: comparacion,
    };
  }

  // ── Alta de un color nuevo ─────────────────────────────────────────────────

  // En ML cada color es una publicación suelta (sin variaciones), agrupadas por
  // `family_name`: "Uñas De Gel…", "Kit Inicial…", "Kit Studio…". Devuelve una
  // entrada por familia con una publicación que sirve de plantilla para clonar
  // (se prefiere una activa) y los SKU que ya tiene la familia.
  async familiasPorPrefijo(prefijo = 'NC') {
    const pref = String(prefijo).trim().toUpperCase();
    const unidades = await this.listarUnidadesPublicadas();
    const familias = new Map();
    for (const u of unidades) {
      if (u.variationId || !u.familia || !u.sku) continue;
      if (!u.sku.toUpperCase().startsWith(pref)) continue;
      if (!familias.has(u.familia)) familias.set(u.familia, { familia: u.familia, plantilla: null, skus: [] });
      const f = familias.get(u.familia);
      f.skus.push(u.sku.toUpperCase());
      if (!f.plantilla || (f.plantilla.estado !== 'active' && u.estado === 'active')) {
        f.plantilla = { itemId: u.itemId, titulo: u.titulo, estado: u.estado };
      }
    }
    return [...familias.values()];
  }

  // Sube una foto al repositorio de imágenes de ML y devuelve su id, para usarla
  // en varias publicaciones sin volver a subirla.
  async subirFoto(buffer, filename, mimeType) {
    const FormData = require('form-data');
    const form = new FormData();
    form.append('file', buffer, { filename, contentType: mimeType });
    const r = await this.request('POST', '/pictures/items/upload', {
      data: form,
      headers: form.getHeaders(),
    });
    if (!r?.id) throw new Error('ML no devolvió id para la foto subida');
    return r.id;
  }

  // Atributos que ML calcula solo: mandarlos en el alta da error de "read only".
  static ATRIBUTOS_CALCULADOS = new Set(['IS_HIGHLIGHT_BRAND', 'IS_TOM_BRAND']);
  // Atributos que llevan el nombre del color según la categoría (gel suelto vs kit).
  static ATRIBUTOS_COLOR = new Set(['COLOR', 'PATTERN_NAME', 'GELS_COLOR']);

  // Arma el cuerpo de la publicación nueva a partir de la plantilla: mismo
  // precio, categoría, envío, garantía y fotos 2..N (las de la familia); cambian
  // el color, el SKU, la foto 1 (que es la del color) y la cantidad.
  armarPublicacionColor(plantilla, { nombre, sku, stock, fotoId }) {
    const C = MercadoLibreService;
    const atributos = (plantilla.attributes || [])
      .filter((a) => !C.ATRIBUTOS_CALCULADOS.has(a.id))
      .map((a) => {
        if (a.id === 'SELLER_SKU') return { id: a.id, value_name: sku };
        // El color nuevo no está en la lista de valores de ML: va como texto libre.
        if (C.ATRIBUTOS_COLOR.has(a.id)) return { id: a.id, value_name: nombre };
        if (a.value_id === '-1') return { id: a.id, value_id: '-1' };
        return a.value_id ? { id: a.id, value_id: a.value_id } : { id: a.id, value_name: a.value_name };
      });

    const fotosFamilia = (plantilla.pictures || []).slice(1).map((p) => ({ id: p.id }));

    return {
      family_name: plantilla.family_name,
      category_id: plantilla.category_id,
      price: plantilla.price,
      currency_id: plantilla.currency_id,
      available_quantity: Math.max(1, Math.trunc(Number(stock) || 0)),
      buying_mode: plantilla.buying_mode,
      listing_type_id: plantilla.listing_type_id,
      condition: plantilla.condition,
      channels: plantilla.channels,
      pictures: [{ id: fotoId }, ...fotosFamilia],
      attributes: atributos,
      sale_terms: (plantilla.sale_terms || []).map((t) => (
        t.value_id ? { id: t.id, value_id: t.value_id } : { id: t.id, value_name: t.value_name }
      )),
      shipping: {
        mode: plantilla.shipping?.mode,
        local_pick_up: plantilla.shipping?.local_pick_up,
        free_shipping: plantilla.shipping?.free_shipping,
      },
    };
  }

  // Clona la plantilla como publicación del color nuevo (y su descripción, si
  // tiene). Con `validar: true` usa /items/validate: ML revisa el cuerpo
  // completo pero no publica nada.
  async crearPublicacionColor(plantillaId, datos, { validar = false } = {}) {
    const plantilla = await this.request('GET', `/items/${plantillaId}`);
    const cuerpo = this.armarPublicacionColor(plantilla, datos);

    if (validar) {
      const titulo = `${plantilla.family_name} ${datos.nombre}`;
      try {
        await this.request('POST', '/items/validate', { data: cuerpo });
        return { validado: true, titulo, avisos: [] };
      } catch (err) {
        // /items/validate responde 400 aunque sólo haya warnings (p.ej. "User has
        // not mode me1", que es de la cuenta y sale en cualquier publicación).
        // El alta real publica igual, así que sólo los errores cuentan.
        const causas = err.causas || [];
        if (causas.length === 0 || causas.some((c) => c?.type !== 'warning')) throw err;
        return { validado: true, titulo, avisos: causas.map((c) => c.message || c.code) };
      }
    }

    const item = await this.request('POST', '/items', { data: cuerpo });

    let descripcion = null;
    try {
      descripcion = await this.request('GET', `/items/${plantillaId}/description`);
    } catch (_) { /* las plantillas de kit no tienen descripción */ }
    if (descripcion?.plain_text) {
      try {
        await this.request('POST', `/items/${item.id}/description`, { data: { plain_text: descripcion.plain_text } });
      } catch (err) {
        logService.warning(`ML: publicación ${item.id} creada sin descripción`, { error: err.message });
      }
    }

    // El índice SKU → publicaciones quedó viejo: el próximo push lo reconstruye.
    this.indicePublicaciones = null;
    return { itemId: item.id, titulo: item.title, permalink: item.permalink, estado: item.status };
  }

  // ── Cambio de foto de un color existente ───────────────────────────────────

  // Publicaciones simples (sin variaciones) de un SKU, con su foto 1 actual.
  // Se fuerza el índice: justo antes de cambiar fotos no sirve uno de hace una hora.
  async publicacionesDeSku(sku) {
    const indice = await this.obtenerIndicePublicaciones({ forzar: true });
    const ids = (indice.get(String(sku).trim().toUpperCase()) || [])
      .filter((p) => !p.variationId)
      .map((p) => p.itemId);
    if (ids.length === 0) return [];

    const out = [];
    for (let i = 0; i < ids.length; i += 20) {
      const r = await this.request('GET', '/items', {
        params: { ids: ids.slice(i, i + 20).join(','), attributes: 'id,title,status,permalink,pictures' },
      });
      for (const fila of r) {
        if (fila.code !== 200 || !fila.body) continue;
        const it = fila.body;
        out.push({
          itemId: it.id,
          titulo: it.title,
          estado: it.status,
          permalink: it.permalink,
          fotoActual: it.pictures?.[0]?.secure_url || it.pictures?.[0]?.url || null,
          fotos: (it.pictures || []).length,
        });
      }
    }
    return out;
  }

  // Reemplaza la foto 1 (la del color) y deja las demás como están. La foto
  // vieja no se borra: sigue en el repositorio de imágenes de ML.
  async reemplazarFotoPrincipal(itemId, fotoId) {
    const item = await this.request('GET', `/items/${itemId}`);
    const resto = (item.pictures || []).slice(1).map((p) => ({ id: p.id }));
    await this.request('PUT', `/items/${itemId}`, { data: { pictures: [{ id: fotoId }, ...resto] } });
    return { fotoAnteriorId: item.pictures?.[0]?.id || null };
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

  // ML entrega la etiqueta en 2 hojas: la 1ª es una A4 apaisada con la etiqueta
  // (derecha, ~88×140mm) en la esquina superior izquierda y el resto en blanco; la
  // 2ª es el remito, que no se imprime. UES y Marco Postal producen SIEMPRE 1 hoja
  // A4 vertical con la etiqueta ocupando casi toda la hoja (~180×285mm), así que
  // recortamos sólo la etiqueta y la escalamos para que salga del mismo tamaño.
  //
  // Resultado: una sola página A4 vertical con la etiqueta centrada y ampliada.
  async normalizarEtiqueta(bytes) {
    const { PDFDocument } = require('pdf-lib');

    const origen = await PDFDocument.load(bytes, { ignoreEncryption: true });
    if (origen.getPageCount() === 0) throw new Error('El PDF de ML no tiene páginas');

    const hojaOrigen = origen.getPage(0); // sólo la primera hoja
    const { width: w, height: h } = hojaOrigen.getSize();

    // Zona de la etiqueta dentro de la A4 apaisada (puntos, origen abajo-izq.),
    // medida sobre etiquetas reales y con unos puntos de aire. Se escala por si
    // la hoja no mide exactamente 842×595. Si ML ya la manda vertical (formato
    // 10×15 configurado en la cuenta) se usa la hoja entera.
    const recorte = w > h
      ? {
          left: (20 / 841.89) * w,
          right: (305 / 841.89) * w,
          bottom: (136 / 595.28) * h,
          top: (576 / 595.28) * h,
        }
      : { left: 0, right: w, bottom: 0, top: h };

    const salida = await PDFDocument.create();
    const etiqueta = await salida.embedPage(hojaOrigen, recorte);

    const A4_ANCHO = 595.28;
    const A4_ALTO = 841.89;
    const MARGEN = 14; // ~5mm, igual que el aire que dejan UES / Marco Postal
    const pagina = salida.addPage([A4_ANCHO, A4_ALTO]);

    const ew = recorte.right - recorte.left;
    const eh = recorte.top - recorte.bottom;
    const escala = Math.min((A4_ANCHO - 2 * MARGEN) / ew, (A4_ALTO - 2 * MARGEN) / eh);
    pagina.drawPage(etiqueta, {
      x: (A4_ANCHO - ew * escala) / 2,
      y: (A4_ALTO - eh * escala) / 2,
      width: ew * escala,
      height: eh * escala,
    });

    // Marca de versión: permite distinguir los PDFs cacheados con el formato
    // viejo (A4 pero con la etiqueta chica y girada) y regenerarlos.
    salida.setSubject(ETIQUETA_FORMATO);
    return Buffer.from(await salida.save());
  }

  // Baja el PDF de la etiqueta de ML y lo deja en public/ para que el panel lo
  // previsualice, lo imprima y lo combine con el resto igual que las de UES/MP.
  //
  // - Por defecto es idempotente: si el archivo ya está, no vuelve a pedirlo
  //   (lo usan el sync/cron, que sólo necesitan que exista).
  // - `fresca`: ML regenera la etiqueta cuando cambia el envío (fecha de
  //   despacho, ruta, entrega), así que al mostrarla o imprimirla se pide la
  //   versión actual para que coincida con la web de ML. Si ML ya no la entrega
  //   (envío despachado) o falla, se usa la cacheada.
  // - `forzar`: la vuelve a pedir y falla si ML no responde.
  async descargarEtiqueta(shipmentId, { forzar = false, fresca = false } = {}) {
    if (!shipmentId) throw new Error('shipmentId requerido');

    const id = String(shipmentId).trim();
    const clave = `${id}|${forzar ? 'f' : fresca ? 'r' : 'c'}`;
    // Visor + descarga + impresión suelen pedir la misma etiqueta a la vez:
    // comparten una sola descarga en curso.
    if (this._etiquetasEnCurso?.has(clave)) return this._etiquetasEnCurso.get(clave);
    this._etiquetasEnCurso = this._etiquetasEnCurso || new Map();
    const p = this._descargarEtiqueta(id, { forzar, fresca })
      .finally(() => this._etiquetasEnCurso.delete(clave));
    this._etiquetasEnCurso.set(clave, p);
    return p;
  }

  async _descargarEtiqueta(id, { forzar, fresca }) {
    const outFile = path.join(OUTPUT_DIR, `${id}.pdf`);
    const publicUrl = `${PUBLIC_URL_BASE}/${id}.pdf`;

    const habiaCache = fsSync.existsSync(outFile);
    const estado = habiaCache ? await this.estadoCache(outFile) : null;

    if (!forzar && estado === 'ok') {
      if (!fresca) return publicUrl;
      // Recién bajada (p. ej. el visor y enseguida la descarga): no hace falta
      // volver a pedirla.
      const edadMs = Date.now() - fsSync.statSync(outFile).mtimeMs;
      if (edadMs < ETIQUETA_FRESCA_MS) return publicUrl;
    }

    // Un PDF cacheado crudo (2 hojas de ML) se arregla sin volver a pedirlo:
    // alcanza con re-procesar los bytes. Uno normalizado con el formato viejo ya
    // no conserva el original completo, así que ése se vuelve a bajar.
    if (!forzar && !fresca && estado === 'crudo') {
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
    let crudo;
    try {
      crudo = await this.descargarEtiquetasCombinadas([id]);
    } catch (err) {
      // ML deja de entregar la etiqueta cuando el envío ya salió: mejor la
      // cacheada que nada.
      if (!forzar && habiaCache) {
        logService.warning(`[ML] No se pudo actualizar la etiqueta ${id}, se usa la cacheada: ${err.message}`);
        if (estado === 'crudo') {
          try {
            await fs.writeFile(outFile, await this.normalizarEtiqueta(await fs.readFile(outFile)));
          } catch (_) { /* se sirve tal cual */ }
        }
        return publicUrl;
      }
      throw err;
    }
    const bytes = await this.normalizarEtiqueta(crudo);
    // Escritura atómica: el visor puede estar leyendo el archivo anterior.
    const tmp = `${outFile}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, bytes);
    await fs.rename(tmp, outFile);
    logService.info('[ML] Etiqueta descargada y normalizada', { shipmentId: id, publicUrl, fresca });
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

  // Estado de un PDF cacheado: 'ok' (formato actual), 'crudo' (tal cual lo manda
  // ML, se puede re-procesar) o 'viejo' (normalizado con un formato anterior o
  // ilegible → hay que volver a bajarlo).
  async estadoCache(rutaPdf) {
    try {
      const { PDFDocument } = require('pdf-lib');
      const doc = await PDFDocument.load(await fs.readFile(rutaPdf), { ignoreEncryption: true });
      if (doc.getSubject() === ETIQUETA_FORMATO) return 'ok';
      const { width, height } = doc.getPage(0).getSize();
      const esA4Vertical = doc.getPageCount() === 1 && Math.abs(width - 595.28) < 2 && Math.abs(height - 841.89) < 2;
      return esA4Vertical ? 'viejo' : 'crudo';
    } catch {
      return 'viejo';
    }
  }

  // Ruta local de una etiqueta ya descargada (la usa el combinador de PDFs).
  rutaEtiquetaLocal(shipmentId) {
    return path.join(OUTPUT_DIR, `${String(shipmentId).trim()}.pdf`);
  }
}

module.exports = new MercadoLibreService();
module.exports.LOGISTIC_TYPES_ME = LOGISTIC_TYPES_ME;

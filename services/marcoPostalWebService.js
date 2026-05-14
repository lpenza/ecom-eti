const axios = require('axios');
const { CookieJar } = require('tough-cookie');
const { wrapper } = require('axios-cookiejar-support');
const qs = require('querystring');
const logService = require('./logService');
const supabaseService = require('./supabaseService');
const { parseAddress } = require('./direccionParserService');
const googleMapsService = require('./googleMapsService');
require('dotenv').config();

const BASE_URL = process.env.MARCO_POSTAL_WEB_URL || 'https://marcopostal.epresis.com';
const USER = process.env.MARCO_POSTAL_USER || '';
const PASSWORD = process.env.MARCO_POSTAL_PASSWORD || '';
const CLIENTE_ID = process.env.MARCO_POSTAL_CLIENTE_ID || '1869';

const SESSION_TTL_MS = 20 * 60 * 1000; // 20 min
const CATALOG_TTL_MS = 30 * 60 * 1000; // 30 min

// Constantes del payload (campos fijos del form nueva-guia-v2 para nuestro flujo).
const SUCURSAL_ID = process.env.MARCO_POSTAL_SUCURSAL_ID || '314';
const TIPO_OPERACION_ID = process.env.MARCO_POSTAL_TIPO_OPERACION_ID || '25'; // ENTREGA PAQUETERIA
const SECTOR = process.env.MARCO_POSTAL_SECTOR || 'PAQUETERIA';
const PAGO_EN = process.env.MARCO_POSTAL_PAGO_EN || 'ORIGEN';
const SERVICIO_ID = process.env.MARCO_POSTAL_SERVICIO_ID || '28'; // E-COMMERCE DÍA

// Pickup en MarcoPostal: cliente retira en oficina MP de Villa Muñoz.
const PICKUP_SERVICIO_ID = process.env.MARCO_POSTAL_PICKUP_SERVICIO_ID || '9';
const PICKUP_LOCALIDAD = process.env.MARCO_POSTAL_PICKUP_LOCALIDAD || 'VILLA MUÑOZ, RETIRO';
const PICKUP_CP = process.env.MARCO_POSTAL_PICKUP_CP || '11800';
const PICKUP_PROVINCIA = process.env.MARCO_POSTAL_PICKUP_PROVINCIA || 'MONTEVIDEO';
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';

class MarcoPostalWebService {
  constructor() {
    this.jar = new CookieJar();
    this.http = wrapper(
      axios.create({
        baseURL: BASE_URL,
        jar: this.jar,
        withCredentials: true,
        maxRedirects: 5,
        timeout: 30000,
        validateStatus: (s) => s < 400 || s === 419 || s === 302,
        headers: {
          'User-Agent': USER_AGENT,
          'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
          'Accept-Encoding': 'gzip, deflate, br',
          'sec-ch-ua': '"Chromium";v="148", "Google Chrome";v="148", "Not/A)Brand";v="99"',
          'sec-ch-ua-mobile': '?0',
          'sec-ch-ua-platform': '"Windows"',
          'Sec-Fetch-Dest': 'document',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Site': 'none',
          'Sec-Fetch-User': '?1',
          'Upgrade-Insecure-Requests': '1',
        },
      })
    );
    this.csrfToken = null;
    this.csrfTimestamp = 0;
    this.sucursalCache = null;
    this.sucursalCacheAt = 0;
  }

  async getSucursalActiva() {
    if (this.sucursalCache && Date.now() - this.sucursalCacheAt < CATALOG_TTL_MS) {
      return this.sucursalCache;
    }
    const list = await this.getSucursales();
    const arr = Array.isArray(list) ? list : list?.data || [];
    const target = arr.find((s) => String(s.id) === String(SUCURSAL_ID)) || arr[0];
    if (!target) throw new Error(`No se encontró sucursal id=${SUCURSAL_ID}`);
    this.sucursalCache = target;
    this.sucursalCacheAt = Date.now();
    return target;
  }

  isSessionFresh() {
    return this.csrfToken && Date.now() - this.csrfTimestamp < SESSION_TTL_MS;
  }

  extractCsrfFromHtml(html) {
    if (!html || typeof html !== 'string') return null;
    // <meta name="csrf-token" content="...">
    const meta = html.match(/<meta\s+name=["']csrf-token["']\s+content=["']([^"']+)["']/i);
    if (meta) return meta[1];
    // <input ... name="_token" value="...">
    const input = html.match(/name=["']_token["']\s+value=["']([^"']+)["']/i);
    if (input) return input[1];
    return null;
  }

  // Envuelve un await axios y enriquece el error con URL + status si falla.
  async safeRequest(label, fn) {
    try {
      return await fn();
    } catch (err) {
      const status = err.response?.status;
      const url = err.config?.url || err.request?.path || '?';
      const baseURL = err.config?.baseURL || BASE_URL;
      const fullUrl = url.startsWith('http') ? url : `${baseURL}${url}`;
      const body =
        typeof err.response?.data === 'string'
          ? err.response.data.slice(0, 300)
          : err.response?.data
          ? JSON.stringify(err.response.data).slice(0, 300)
          : null;
      const enriched = new Error(
        `MarcoPostal HTTP ${status || '?'} en ${label} (${fullUrl})` +
          (body ? ` — body: ${body}` : '')
      );
      enriched.cause = err;
      enriched.status = status;
      enriched.url = fullUrl;
      throw enriched;
    }
  }

  async login() {
    if (!USER || !PASSWORD) {
      throw new Error(
        'Faltan credenciales: configurar MARCO_POSTAL_USER y MARCO_POSTAL_PASSWORD en .env'
      );
    }

    logService.info('MarcoPostal Web — iniciando login', { user: USER });

    // 1) GET /login para obtener token inicial y setear cookies XSRF/sesión
    const loginPage = await this.safeRequest('GET /login', () =>
      this.http.get('/login', { headers: { Accept: 'text/html' } })
    );

    if (loginPage.status >= 400) {
      throw new Error(`No se pudo obtener /login (HTTP ${loginPage.status})`);
    }

    const initialToken = this.extractCsrfFromHtml(loginPage.data);
    if (!initialToken) {
      throw new Error('No se encontró _token/csrf-token en /login');
    }

    // 2) POST /login con credenciales
    const body = qs.stringify({
      _token: initialToken,
      email: USER,
      username: USER, // por si el form usa cualquiera de los dos
      password: PASSWORD,
      remember: 'on',
    });

    const loginResp = await this.safeRequest('POST /login', () =>
      this.http.post('/login', body, {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          Accept: 'text/html,application/xhtml+xml',
          Origin: BASE_URL,
          Referer: `${BASE_URL}/login`,
        },
      })
    );

    // Si vuelve al login, las credenciales son inválidas
    const finalUrl = loginResp.request?.res?.responseUrl || '';
    if (finalUrl.endsWith('/login') && loginResp.status === 200) {
      throw new Error('Login falló: credenciales inválidas o sesión rechazada');
    }

    // 3) GET a nueva-guia-v2 para tomar el csrf-token del contexto donde se hacen
    //    los XHR. El token de /login puede no servir para los endpoints de guias.
    const dash = await this.safeRequest('GET /guias/nueva-guia-v2', () =>
      this.http.get('/guias/nueva-guia-v2', { headers: { Accept: 'text/html' } })
    );
    const dashFinalUrl = dash.request?.res?.responseUrl || '';
    if (dashFinalUrl.includes('/login')) {
      throw new Error('Login falló: redirige a /login al pedir nueva-guia-v2');
    }
    const token = this.extractCsrfFromHtml(dash.data);
    if (!token) {
      throw new Error('Login OK pero no se encontró csrf-token en nueva-guia-v2');
    }

    this.csrfToken = token;
    this.csrfTimestamp = Date.now();

    const cookies = await this.jar.getCookies(BASE_URL);
    const cookieNames = cookies.map((c) => c.key);
    logService.info('MarcoPostal Web — login exitoso', {
      tokenLen: token.length,
      cookies: cookieNames,
    });

    return token;
  }

  async refreshCsrf() {
    logService.info('MarcoPostal Web — refrescando CSRF');
    const resp = await this.safeRequest('GET /guias/nueva-guia-v2 (refresh)', () =>
      this.http.get('/guias/nueva-guia-v2', { headers: { Accept: 'text/html' } })
    );
    const finalUrl = resp.request?.res?.responseUrl || '';
    if (finalUrl.includes('/login')) {
      // Sesión expirada → re-login completo
      return await this.login();
    }
    const token = this.extractCsrfFromHtml(resp.data);
    if (!token) {
      throw new Error('No se pudo refrescar csrf-token desde /guias/nueva-guia-v2');
    }
    this.csrfToken = token;
    this.csrfTimestamp = Date.now();
    return token;
  }

  async ensureSession() {
    if (!this.isSessionFresh()) {
      if (this.csrfToken) {
        // Tenemos token pero pudo haber rotado / sesión todavía viva → intentar refresh
        try {
          await this.refreshCsrf();
          return;
        } catch (err) {
          logService.warning('MarcoPostal Web — refreshCsrf falló, re-login', {
            error: err.message,
          });
        }
      }
      await this.login();
    }
  }

  // POST form-url-encoded a un endpoint XHR del sitio. Agrega _token automáticamente.
  async postForm(pathUrl, fields = {}, { retry = true } = {}) {
    await this.ensureSession();

    const body = qs.stringify({ _token: this.csrfToken, ...fields });

    let resp;
    try {
      resp = await this.http.post(pathUrl, body, {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          Accept: 'application/json, text/javascript, */*; q=0.01',
          'X-Requested-With': 'XMLHttpRequest',
          Origin: BASE_URL,
          Referer: `${BASE_URL}/guias/nueva-guia-v2`,
        },
      });
    } catch (err) {
      const status = err.response?.status;
      if (retry && status === 419) {
        await this.refreshCsrf();
        return await this.postForm(pathUrl, fields, { retry: false });
      }
      // MP a veces devuelve 500 cuando la sesión está corrupta o el cookie expiró.
      // Forzamos re-login completo y reintentamos una vez.
      if (retry && status === 500) {
        logService.warning('MarcoPostal Web — 500, intentando re-login y reintentar', { pathUrl });
        this.csrfToken = null;
        this.csrfTimestamp = 0;
        this.sucursalCache = null;
        await this.login();
        return await this.postForm(pathUrl, fields, { retry: false });
      }
      throw err;
    }

    // 419 = CSRF mismatch / Page Expired
    if (resp.status === 419 && retry) {
      logService.warning('MarcoPostal Web — 419, refrescando CSRF y reintentando');
      await this.refreshCsrf();
      return await this.postForm(pathUrl, fields, { retry: false });
    }

    // Si redirigió a /login, sesión murió
    const finalUrl = resp.request?.res?.responseUrl || '';
    if (finalUrl.includes('/login') && retry) {
      logService.warning('MarcoPostal Web — redirect a /login, re-autenticando');
      await this.login();
      return await this.postForm(pathUrl, fields, { retry: false });
    }

    return resp.data;
  }

  // ── Catálogos ──────────────────────────────────────────────────────────────
  async getClientesServicios(clienteId = CLIENTE_ID) {
    return await this.postForm('/clientes/gestion/getClientesServiciosJSON', {
      cliente_id: clienteId,
    });
  }

  async getSucursales(clienteId = CLIENTE_ID) {
    return await this.postForm('/sucursales/getSucursalesFromClienteJSON', {
      cliente_id: clienteId,
    });
  }

  async getCecos(clienteId = CLIENTE_ID) {
    return await this.postForm('/cecos/getCecosFromCliente', {
      cliente_id: clienteId,
    });
  }

  // Busca localidades/barrios para un departamento. id=MONTEVIDEO en mayúsculas.
  async buscarLocalidad(deptoId, search) {
    return await this.postForm('/sucursales/localidades', {
      id: String(deptoId || 'MONTEVIDEO').toUpperCase(),
      search: search || '',
    });
  }

  // ── Resolución del barrio MarcoPostal del destinatario ─────────────────────
  // Flujo:
  //   1. Si el pedido ya tiene barrio_google_maps cacheado, usarlo.
  //   2. Si tiene lat/lng, hacer reverse geocoding para obtener barrio + CP.
  //   3. Fallback al pedido.localidad (string libre de Shopify).
  //   4. Lookup en localidades_ues (mapeo MP cacheado) usando el CP para desempatar.
  //   5. Si no aparece, búsqueda runtime en MarcoPostal.
  async resolverLocalidadDestino(pedido) {
    let barrio = pedido.barrio_google_maps || null;
    let cp = pedido.codigo_postal ? String(pedido.codigo_postal).trim() : null;
    let geoSource = null;

    if (!barrio && pedido.latitud && pedido.longitud) {
      const geo = await googleMapsService.reverseGeocodeAsync(pedido.latitud, pedido.longitud);
      if (geo?.exitoso) {
        barrio = geo.barrio || geo.localidad || null;
        cp = geo.codigoPostal || cp;
        geoSource = 'reverse-geocode';
      }
    }

    if (!barrio) barrio = pedido.localidad;
    const localidad = barrio;

    if (!localidad) {
      return { source: 'none', marcopostal_nombre: '', marcopostal_id: null, marcopostal_cp: cp || '', geoSource };
    }

    // 1) Tabla localidades_ues mapeada
    const fromTable = await supabaseService.buscarBarrioMarcoPostalPorNombre(localidad, { codigoPostal: cp });
    if (fromTable && fromTable.marcopostal_id) {
      return {
        source: 'table',
        geoSource,
        marcopostal_nombre: fromTable.marcopostal_nombre || '',
        marcopostal_id: fromTable.marcopostal_id,
        marcopostal_cp: fromTable.marcopostal_cp || cp || '',
        localidadOriginal: localidad,
      };
    }

    // 2) Fallback runtime: buscar en MarcoPostal por palabra clave
    const STOP = new Set(['de', 'la', 'el', 'los', 'las', 'y', 'del', 'al']);
    const words = String(localidad)
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .split(/[\s,]+/)
      .filter((w) => w && !STOP.has(w));
    const searchKey = words.find((w) => w.length >= 5) || words[0] || localidad;

    try {
      const resp = await this.buscarLocalidad('MONTEVIDEO', searchKey);
      const items = Array.isArray(resp?.items) ? resp.items : [];
      if (items.length > 0) {
        const pick = (cp && items.find((it) => String(it.cp).trim() === cp)) || items[0];
        return {
          source: 'runtime',
          geoSource,
          marcopostal_nombre: pick.nombre,
          marcopostal_id: String(pick.id),
          marcopostal_cp: pick.cp || cp || '',
          localidadOriginal: localidad,
          alternativas: items.slice(0, 5).map((it) => ({ id: it.id, nombre: it.nombre, cp: it.cp })),
        };
      }
    } catch (err) {
      logService.warning('MarcoPostal Web — fallback runtime falló', { error: err.message, localidad });
    }

    // 3) Fallback final: si el pedido tiene CP, buscar por CP como keyword.
    // Cubre el caso típico donde Shopify devuelve "Montevideo" como localidad (el
    // departamento) y el barrio MarcoPostal real (Malvín, Pocitos, etc.) hay que
    // inferirlo del código postal.
    if (cp) {
      try {
        const resp = await this.buscarLocalidad('MONTEVIDEO', cp);
        const items = Array.isArray(resp?.items) ? resp.items : [];
        const pick = items.find((it) => String(it.cp).trim() === cp) || items[0];
        if (pick) {
          return {
            source: 'runtime',
            geoSource,
            marcopostal_nombre: pick.nombre,
            marcopostal_id: String(pick.id),
            marcopostal_cp: pick.cp || cp,
            localidadOriginal: localidad,
            alternativas: items.slice(0, 5).map((it) => ({ id: it.id, nombre: it.nombre, cp: it.cp })),
          };
        }
      } catch (err) {
        logService.warning('MarcoPostal Web — fallback por CP falló', { error: err.message, cp });
      }
    }

    return {
      source: 'unresolved',
      geoSource,
      marcopostal_nombre: localidad,
      marcopostal_id: null,
      marcopostal_cp: cp || '',
      localidadOriginal: localidad,
    };
  }

  formatFechaHoy() {
    const d = new Date();
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const yyyy = d.getFullYear();
    return `${dd}/${mm}/${yyyy}`;
  }

  // ── Construye el body form-url-encoded esperado por /guias/store_multiitems ─
  async buildPayload(pedido) {
    await this.ensureSession();
    const sucursal = await this.getSucursalActiva();
    const cliente = sucursal?.cliente || {};
    const direccion = parseAddress(pedido.direccion_envio || '');
    const destino = await this.resolverLocalidadDestino(pedido);

    const sender = {
      sender_empresa: cliente.empresa || cliente.nombre_fantasia || sucursal.razonSocial || '',
      sender_remitente: cliente.contacto || '',
      sender_cuit: cliente.cuit || cliente.documento || '',
      sender_calle: sucursal.calle || '',
      sender_altura: sucursal.altura || '',
      sender_piso: sucursal.piso || '',
      sender_dpto: sucursal.dpto || '',
      sender_provincia: (sucursal.provincia || 'MONTEVIDEO').toUpperCase(),
      sender_localidad: (sucursal.localidad || 'POCITOS').toUpperCase(),
      sender_cp: String(sucursal.cp || ''),
    };

    const fields = {
      // Campos vacíos pero presentes en el form original
      cobertura_id: '',
      retiro_id: '',
      palabra_clave: '',
      fecha_hora: this.formatFechaHoy(),
      cliente_id: CLIENTE_ID,
      sucursal_id: SUCURSAL_ID,
      deposito: '',
      ceco_id: '',
      is_urgente: '0',
      is_intersucursal: '0',
      nota_pedido_id: '',
      codigo: '',
      constancia_retiro: '',
      rto_cliente: '',
      guiaAgente: '',
      contrareembolso: '',
      valor_declarado: '',
      kms: '',
      lote: '',
      nro_precinto: '',
      tipo_operacion_id: TIPO_OPERACION_ID,
      sector: SECTOR,
      pago_en: PAGO_EN,
      canal: '',
      sender_remitente_select: '',
      ...sender,
      sender_tipo_iva: '',
      sender_email: '',
      sender_celular: '',
      sender_fecha_servicio: '',
      sender_hora_desde: '',
      sender_hora_hasta: '',
      sender_other_info: '',
      nroSocio: '',
      is_search_function: '1',
      empresa: '',
      // Datos del destinatario
      apellido_nombre: pedido.cliente_nombre || '',
      tipo_doc: '',
      documento: '',
      apellido_nombre_autorizado: '',
      documento_autorizado: '',
      comprador_tipo_iva: '',
      cuit: '',
      calle: direccion.calle || pedido.direccion_envio || '',
      altura: direccion.numeroPuerta || '',
      piso: direccion.apartamento || '',
      dpto: '',
      provincia: 'MONTEVIDEO',
      localidad: destino.marcopostal_nombre || '',
      cp: String(destino.marcopostal_cp || pedido.codigo_postal || ''),
      email: pedido.cliente_email || '',
      // Sólo mandamos celular si tiene al menos 6 dígitos. Valores como "-", "N/A"
      // o cadenas sin dígitos quedan como string vacío.
      celular: (() => {
        const raw = String(pedido.cliente_telefono || '').trim();
        const digits = raw.replace(/\D/g, '');
        return digits.length >= 6 ? raw : '';
      })(),
      fecha_servicio: '',
      hora_desde: '',
      hora_hasta: '',
      other_info: direccion.observaciones || '',
      obs1: String(pedido.numero_pedido || pedido.id || ''),
      obs2: '',
      obs3: '',
      obs4: '',
      datosenvios_observaciones: '',
      cadena_frio: '0',
      servicio_id: SERVICIO_ID,
      envio_segurizado: '0',
      // Producto/bulto: 1 bulto sin peso ni dimensiones (igual que el fetch real)
      'bulto[]': '1',
      'peso[]': '0',
      'alto[]': '0',
      'largo[]': '0',
      'ancho[]': '0',
      'volumetrico[]': '0.00',
      'peso_final[]': '0',
      'precio[]': '',
      'descripcion[]': '',
      'sku[]': '',
      'sku2[]': '',
      'info1[]': '',
      'info2[]': '',
      'tracking_producto[]': '',
      bultos_reales: '1',
      volumetrico_estimado: '',
      total_bultos: '',
      total_peso: '',
      bulto_por_peso_final: '',
      total_peso_excedente: '',
      flete: '',
      seguro: '',
      retiro_importe_exceso: '',
      totalFlete: '',
    };

    return { fields, resolved: { destino, sucursal: { id: sucursal.id, codigo: sucursal.codigo_sucursal, descripcion: sucursal.descripcion }, cliente: { id: cliente.id, empresa: cliente.empresa } } };
  }

  // ── Pickup ─────────────────────────────────────────────────────────────────
  // Construye el payload para retiro en oficina MarcoPostal (servicio_id=9).
  // El destinatario NO tiene dirección de entrega — la persona va a la oficina MP.
  async buildPayloadPickup(pedido) {
    await this.ensureSession();
    const sucursal = await this.getSucursalActiva();
    const cliente = sucursal?.cliente || {};

    const sender = {
      sender_empresa: cliente.empresa || cliente.nombre_fantasia || sucursal.razonSocial || '',
      sender_remitente: cliente.contacto || '',
      sender_cuit: cliente.cuit || cliente.documento || '',
      sender_calle: sucursal.calle || '',
      sender_altura: sucursal.altura || '',
      sender_piso: sucursal.piso || '',
      sender_dpto: sucursal.dpto || '',
      sender_provincia: (sucursal.provincia || 'MONTEVIDEO').toUpperCase(),
      sender_localidad: (sucursal.localidad || 'POCITOS').toUpperCase(),
      sender_cp: String(sucursal.cp || ''),
    };

    // Celular del destinatario — sólo si tiene 6+ dígitos.
    const celularRaw = String(pedido.cliente_telefono || pedido.telefono || '').trim();
    const celularDigits = celularRaw.replace(/\D/g, '');
    const celular = celularDigits.length >= 6 ? celularRaw : '';
    if (!celular) {
      logService.warning('MarcoPostal Pickup — celular vacío post-validación', {
        pedidoId: pedido.id,
        numeroPedido: pedido.numero_pedido,
        rawCliente: pedido.cliente_telefono,
        rawAlt: pedido.telefono,
      });
    }

    const fields = {
      cobertura_id: '',
      retiro_id: '',
      palabra_clave: '',
      fecha_hora: this.formatFechaHoy(),
      cliente_id: CLIENTE_ID,
      sucursal_id: SUCURSAL_ID,
      deposito: '',
      ceco_id: '',
      is_urgente: '0',
      is_intersucursal: '0',
      nota_pedido_id: '',
      codigo: '',
      constancia_retiro: '',
      rto_cliente: '',
      guiaAgente: '',
      contrareembolso: '',
      valor_declarado: '',
      kms: '',
      lote: '',
      nro_precinto: '',
      tipo_operacion_id: TIPO_OPERACION_ID,
      sector: SECTOR,
      pago_en: PAGO_EN,
      canal: '',
      sender_remitente_select: '',
      ...sender,
      sender_tipo_iva: '',
      sender_email: '',
      sender_celular: '',
      sender_fecha_servicio: '',
      sender_hora_desde: '',
      sender_hora_hasta: '',
      sender_other_info: '',
      nroSocio: '',
      is_search_function: '1',
      empresa: '',
      apellido_nombre: pedido.cliente_nombre || '',
      tipo_doc: '',
      documento: '',
      apellido_nombre_autorizado: '',
      documento_autorizado: '',
      comprador_tipo_iva: '',
      cuit: '',
      // Dirección de entrega VACÍA — el cliente retira en oficina MP.
      calle: '',
      altura: '',
      piso: '',
      dpto: '',
      provincia: PICKUP_PROVINCIA,
      localidad: PICKUP_LOCALIDAD,
      cp: PICKUP_CP,
      email: pedido.cliente_email || '',
      celular,
      fecha_servicio: '',
      hora_desde: '',
      hora_hasta: '',
      other_info: '',
      obs1: String(pedido.numero_pedido || pedido.id || ''),
      obs2: '',
      obs3: '',
      obs4: '',
      datosenvios_observaciones: '',
      cadena_frio: '0',
      servicio_id: PICKUP_SERVICIO_ID, // 9 = PickUp
      envio_segurizado: '0',
      'bulto[]': '1',
      'peso[]': '0',
      'alto[]': '0',
      'largo[]': '0',
      'ancho[]': '0',
      'volumetrico[]': '0.00',
      'peso_final[]': '0',
      'precio[]': '',
      'descripcion[]': '',
      'sku[]': '',
      'sku2[]': '',
      'info1[]': '',
      'info2[]': '',
      'tracking_producto[]': '',
      bultos_reales: '1',
      volumetrico_estimado: '',
      total_bultos: '',
      total_peso: '',
      bulto_por_peso_final: '',
      total_peso_excedente: '',
      flete: '',
      seguro: '',
      retiro_importe_exceso: '',
      totalFlete: '',
    };

    return {
      fields,
      resolved: {
        modo: 'pickup',
        puntoRetiro: { localidad: PICKUP_LOCALIDAD, cp: PICKUP_CP, provincia: PICKUP_PROVINCIA },
        sucursal: { id: sucursal.id, codigo: sucursal.codigo_sucursal, descripcion: sucursal.descripcion },
        cliente: { id: cliente.id, empresa: cliente.empresa },
      },
    };
  }

  async previewGuiaPickup(pedido) {
    const built = await this.buildPayloadPickup(pedido);
    const f = built.fields;
    const summary = {
      modo: 'pickup',
      destinatario: {
        nombre: f.apellido_nombre,
        email: f.email,
        celular: f.celular,
      },
      puntoRetiro: {
        provincia: f.provincia,
        localidad: f.localidad,
        cp: f.cp,
      },
      envio: {
        fecha: f.fecha_hora,
        servicio_id: f.servicio_id,
        tipo_operacion_id: f.tipo_operacion_id,
        sector: f.sector,
        pago_en: f.pago_en,
        referencia: f.obs1,
        cliente_id: f.cliente_id,
        sucursal_id: f.sucursal_id,
      },
      remitente: {
        empresa: f.sender_empresa,
        contacto: f.sender_remitente,
        direccion: `${f.sender_calle} ${f.sender_altura} ${f.sender_piso}`.trim(),
        localidad: f.sender_localidad,
        provincia: f.sender_provincia,
        cp: f.sender_cp,
      },
    };
    return { summary, resolved: built.resolved, payload: built.fields };
  }

  async generarGuiaPickup(pedido, payloadOverrides = {}) {
    const built = await this.buildPayloadPickup(pedido);
    const finalFields = { ...built.fields, ...(payloadOverrides || {}) };

    logService.info('MarcoPostal Web — generarGuiaPickup POST', {
      pedidoId: pedido.id,
      numeroPedido: pedido.numero_pedido,
      servicio: finalFields.servicio_id,
      puntoRetiro: finalFields.localidad,
    });

    const data = await this.postForm('/guias/store_multiitems', finalFields);

    if (data && typeof data === 'object' && data.success === false) {
      throw new Error(data.message || data.error || 'MarcoPostal rechazó la guía pickup');
    }

    let guiaId =
      data?.id ||
      data?.guia ||
      data?.numero_guia ||
      data?.guia_id ||
      data?.data?.id ||
      data?.data?.guia ||
      null;
    if (guiaId != null) {
      const cleaned = String(guiaId).trim().replace(/\s+/g, '');
      guiaId = cleaned || null;
    }
    if (!guiaId) {
      logService.warning('MarcoPostal Web — pickup respuesta sin guiaId', { data });
    }

    return { guiaId, raw: data, resolved: built.resolved };
  }

  // Descarga el HTML de la etiqueta. URL exacta:
  //   /guias/remito/imprimir-guia?url=ETIQUETA_100X150_HTML&guia_id=%20<guiaId>
  async obtenerEtiquetaHtml(guiaId) {
    await this.ensureSession();
    const path = `/guias/remito/imprimir-guia?url=ETIQUETA_100X150_HTML&guia_id=%20${encodeURIComponent(guiaId)}`;
    const resp = await this.http.get(path, {
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        Referer: `${BASE_URL}/guias/nueva-guia-v2`,
      },
    });
    if (resp.status >= 400) {
      throw new Error(`Etiqueta no disponible (HTTP ${resp.status})`);
    }
    return resp.data;
  }

  // POST /guias/store_multiitems con el payload final. Acepta overrides editados en el modal.
  async generarGuia(pedido, payloadOverrides = {}) {
    const built = await this.buildPayload(pedido);
    const finalFields = { ...built.fields, ...(payloadOverrides || {}) };

    logService.info('MarcoPostal Web — generarGuia POST', {
      pedidoId: pedido.id,
      numeroPedido: pedido.numero_pedido,
      destino: finalFields.localidad,
      cp: finalFields.cp,
    });

    const data = await this.postForm('/guias/store_multiitems', finalFields);

    // El response puede ser JSON con la guía o un objeto con código de error.
    if (data && typeof data === 'object' && data.success === false) {
      throw new Error(data.message || data.error || 'MarcoPostal rechazó la guía');
    }

    // Extraer número/id de guía del response (estructura a confirmar con primer envío real).
    let guiaId =
      data?.id ||
      data?.guia ||
      data?.numero_guia ||
      data?.guia_id ||
      data?.data?.id ||
      data?.data?.guia ||
      null;

    // Sanitizar: MP a veces devuelve con espacios o caracteres no numéricos.
    if (guiaId != null) {
      const cleaned = String(guiaId).trim().replace(/\s+/g, '');
      guiaId = cleaned || null;
    }

    if (!guiaId) {
      logService.warning('MarcoPostal Web — respuesta sin guiaId, devuelvo raw', { data });
    }

    return { guiaId, raw: data, resolved: built.resolved };
  }

  async previewGuia(pedido) {
    const built = await this.buildPayload(pedido);
    // Agrupar campos para una vista más amigable
    const f = built.fields;
    const summary = {
      remitente: {
        empresa: f.sender_empresa,
        contacto: f.sender_remitente,
        cuit: f.sender_cuit,
        direccion: `${f.sender_calle} ${f.sender_altura} ${f.sender_piso}`.trim(),
        localidad: f.sender_localidad,
        provincia: f.sender_provincia,
        cp: f.sender_cp,
      },
      destinatario: {
        nombre: f.apellido_nombre,
        email: f.email,
        celular: f.celular,
        calle: f.calle,
        altura: f.altura,
        piso: f.piso,
        provincia: f.provincia,
        localidad: f.localidad,
        cp: f.cp,
        observaciones: f.other_info,
      },
      envio: {
        fecha: f.fecha_hora,
        servicio_id: f.servicio_id,
        tipo_operacion_id: f.tipo_operacion_id,
        sector: f.sector,
        pago_en: f.pago_en,
        referencia: f.obs1,
        cliente_id: f.cliente_id,
        sucursal_id: f.sucursal_id,
      },
      bulto: {
        bultos: 1,
        peso: f.peso_final?.[0] || f['peso_final[]'],
      },
    };
    return { summary, resolved: built.resolved, payload: built.fields };
  }

  // Diagnóstico para el endpoint /api/marcopostal/test-login
  async testLogin() {
    await this.ensureSession();
    const cookies = await this.jar.getCookies(BASE_URL);
    const masked = (t) => (t ? `${t.slice(0, 6)}…${t.slice(-4)} (len=${t.length})` : null);
    return {
      authenticated: true,
      csrfToken: masked(this.csrfToken),
      sessionAgeMs: Date.now() - this.csrfTimestamp,
      cookies: cookies.map((c) => ({
        name: c.key,
        domain: c.domain,
        path: c.path,
        secure: !!c.secure,
        httpOnly: !!c.httpOnly,
        expires: c.expires === 'Infinity' ? null : c.expires,
      })),
      clienteId: CLIENTE_ID,
    };
  }
}

module.exports = new MarcoPostalWebService();

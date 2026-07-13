const axios = require('axios');
require('dotenv').config();

// Códigos de idioma español que Meta puede usar para aprobar una plantilla.
// Meta exige que el `language.code` del envío coincida EXACTO con el de la
// plantilla aprobada; si no, devuelve 132001 ("no existe en esa traducción").
// Como no siempre sabemos con qué variante se aprobó (es, es_AR, es_ES…),
// probamos el idioma configurado primero y, ante un 132001, reintentamos con
// estas variantes hasta que una funcione. Así el envío admite cualquier español.
const SPANISH_LANG_FALLBACKS = ['es_AR', 'es', 'es_ES', 'es_MX', 'es_LA', 'es_419', 'es_US', 'es_CO', 'es_CL', 'es_PE'];

// Código de error de Meta: la plantilla existe pero NO en el idioma solicitado.
const META_ERR_TEMPLATE_LANG_MISSING = 132001;

// Recuerda, por nombre de plantilla, con qué código de idioma aceptó Meta el
// envío, para que los siguientes mensajes del mismo ciclo vayan directo al
// idioma correcto sin repetir intentos fallidos.
const idiomaResueltoPorPlantilla = new Map();

// Normaliza teléfono uruguayo al formato internacional sin '+'.
// UY: el 0 inicial es prefijo nacional y NO va en el formato internacional.
//   095806208  → 59895806208   (no 598095806208)
function normalizarTelefono(tel) {
  let limpio = String(tel || '').replace(/\D/g, '');
  if (!limpio) return null;
  if (limpio.startsWith('598')) return limpio;          // ya en formato internacional
  if (limpio.startsWith('0')) limpio = limpio.slice(1); // quitar el 0 nacional
  return `598${limpio}`;
}

/**
 * Construye el array de componentes para la API de Meta/Kommo.
 *
 * Plantillas que manejamos:
 *
 *  TEMPLATE_1 ("intento_abandonado_v1")
 *    - Body:   {{1}} = Nombre del cliente
 *    - Button: botón URL dinámico = URL del carrito abandonado
 *
 *  TEMPLATE_2 ("intento_carrito_abandonado_1")
 *    - Body:   {{1}} = Nombre del cliente
 *    (sin botón, URL queda fija o se incluye en el body si la plantilla la tiene)
 */
// Extrae el sufijo dinámico de la URL del carrito para el botón de Meta.
// El botón en Meta es "https://velinneuy.com/{{1}}", así que el parámetro
// debe ser todo lo que va DESPUÉS del dominio (path + query).
function sufijoUrlCarrito(cartUrl) {
  try {
    const u = new URL(cartUrl);
    return u.pathname.replace(/^\//, '') + u.search; // ej: "730.../checkouts/ac/TOKEN/recover?key=...&locale=es-UY"
  } catch {
    return null;
  }
}

function buildComponents(templateName, { nombre, cartUrl }) {
  // Ambas plantillas (carrito_abandonado_1 y _2) tienen:
  //   - BODY con {{1}} = nombre del cliente
  //   - BUTTON URL dinámico "FINALIZAR MI PEDIDO" → link de recuperación del carrito
  const components = [
    {
      type: 'body',
      parameters: [
        { type: 'text', text: nombre || 'Cliente' },
      ],
    },
  ];

  const sufijo = sufijoUrlCarrito(cartUrl);
  if (sufijo) {
    components.push({
      type: 'button',
      sub_type: 'url',
      index: '0',
      parameters: [{ type: 'text', text: sufijo }],
    });
  }

  return components;
}

class KommoWhatsAppService {
  constructor() {
    // Dominio de la cuenta — usado para todos los endpoints REST de Kommo
    this.accountDomain = process.env.KOMMO_ACCOUNT_DOMAIN || 'velinneuy.kommo.com';
    this.token         = process.env.KOMMO_API_TOKEN;
    this.secretKey     = process.env.KOMMO_SECRET_KEY;
    this.wabaId        = process.env.KOMMO_WABA_ID; // WhatsApp Business Account ID

    // ── WhatsApp Cloud API de Meta (envío real) ──────────────────────────────
    this.metaPhoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID; // ID del número (NO el WABA ID)
    this.metaToken         = process.env.WHATSAPP_ACCESS_TOKEN;    // token de acceso de Meta
    this.metaApiVersion    = process.env.WHATSAPP_API_VERSION || 'v21.0';
    // Debe coincidir EXACTO con el idioma con que la plantilla está aprobada en Meta.
    // Las plantillas carrito_abandonado_*_v2 están en "Spanish (ARG)" = es_AR.
    // Un desajuste acá provoca el error 132001 (template no existe en esa traducción).
    this.templateLang      = process.env.WA_TEMPLATE_LANG || 'es_AR';
  }

  // ¿Está configurado el envío real por Meta?
  get metaConfigurado() {
    return Boolean(this.metaPhoneNumberId && this.metaToken);
  }

  get baseUrl() {
    return `https://${this.accountDomain}/api/v4`;
  }

  get headers() {
    return {
      Authorization: `Bearer ${this.token}`,
      'Content-Type': 'application/json',
    };
  }

  // Busca contacto en Kommo por teléfono
  async buscarContacto(telefono) {
    const phone = normalizarTelefono(telefono);
    if (!phone) return null;
    try {
      const res = await axios.get(`${this.baseUrl}/contacts`, {
        headers: this.headers,
        params: { query: phone, limit: 1 },
      });
      return res.data?._embedded?.contacts?.[0] || null;
    } catch {
      return null;
    }
  }

  // Crea contacto en Kommo
  async crearContacto({ nombre, telefono, email }) {
    const phone = normalizarTelefono(telefono);
    const body = [{
      name: nombre || 'Cliente',
      custom_fields_values: [
        { field_code: 'PHONE', values: [{ value: phone, enum_code: 'MOB' }] },
        ...(email ? [{ field_code: 'EMAIL', values: [{ value: email }] }] : []),
      ],
    }];
    const res = await axios.post(`${this.baseUrl}/contacts`, body, { headers: this.headers });
    return res.data?._embedded?.contacts?.[0] || null;
  }

  // Obtiene o crea contacto
  async obtenerOCrearContacto({ nombre, telefono, email }) {
    const existente = await this.buscarContacto(telefono);
    if (existente) return existente;
    return this.crearContacto({ nombre, telefono, email });
  }

  /**
   * Envía un template de WhatsApp vía Kommo Marketing Messages API.
   *
   * @param {string} telefono     - Teléfono del destinatario (formato UY o internacional)
   * @param {string} templateName - Nombre técnico de la plantilla (snake_case como en Meta)
   * @param {string} nombre       - Nombre del cliente para {{1}}
   * @param {string} cartUrl      - URL del carrito abandonado (para el botón dinámico)
   * @param {string} [language]   - Código de idioma (default: 'es')
   */
  // Orden de códigos de idioma a intentar para una plantilla. Si el idioma pedido
  // es un español, devolvemos TODAS las variantes (empezando por el conocido-bueno
  // en cache y por el pedido) para tolerar cualquier "tipo de español" de Meta. Si
  // es otro idioma, respetamos solo ese (sin reintentos de variantes).
  ordenIdiomas(templateName, language) {
    const pedido = language || this.templateLang;
    const esEspanol = /^es(_|-|$)/i.test(pedido);
    if (!esEspanol) return [pedido];

    const cacheado = idiomaResueltoPorPlantilla.get(templateName);
    // Dedup preservando orden: cache → pedido → variantes de español
    return [...new Set([cacheado, pedido, ...SPANISH_LANG_FALLBACKS].filter(Boolean))];
  }

  // POST crudo a la Cloud API de Meta con un idioma concreto.
  async postTemplate({ phone, templateName, lang, components }) {
    const url = `https://graph.facebook.com/${this.metaApiVersion}/${this.metaPhoneNumberId}/messages`;
    const body = {
      messaging_product: 'whatsapp',
      to: phone,
      type: 'template',
      template: { name: templateName, language: { code: lang }, components },
    };
    return axios.post(url, body, {
      headers: { Authorization: `Bearer ${this.metaToken}`, 'Content-Type': 'application/json' },
    });
  }

  async enviarTemplate({ telefono, templateName, nombre, cartUrl, language }) {
    const phone = normalizarTelefono(telefono);
    if (!phone) throw new Error(`Teléfono inválido: ${telefono}`);

    const components = buildComponents(templateName, { nombre, cartUrl });
    const langs = this.ordenIdiomas(templateName, language);

    // Si no hay credenciales de Meta, seguimos en modo STUB (no envía nada)
    if (!this.metaConfigurado) {
      const lang = langs[0];
      const payload = { to: phone, template: { name: templateName, language: { code: lang }, components } };
      console.log(`[KommoWA] 📤 STUB (sin credenciales Meta) → ${phone} | template: "${templateName}" (${lang})`);
      console.log(`[KommoWA] Payload listo:`, JSON.stringify(payload, null, 2));
      return { success: true, stub: true, phone, templateName, payload };
    }

    // ── Envío real vía WhatsApp Cloud API de Meta ───────────────────────────────
    // Probamos cada idioma candidato; SOLO reintentamos ante 132001 (la plantilla
    // no existe en ese idioma). Cualquier otro error corta de inmediato.
    let ultimoError = null;
    for (const lang of langs) {
      try {
        const res = await this.postTemplate({ phone, templateName, lang, components });
        idiomaResueltoPorPlantilla.set(templateName, lang); // cache para próximos envíos
        const messageId = res.data?.messages?.[0]?.id || null;
        console.log(`[KommoWA] ✅ Enviado → ${phone} | template: "${templateName}" (${lang}) | msgId: ${messageId}`);
        return { success: true, stub: false, phone, templateName, lang, messageId };
      } catch (err) {
        ultimoError = err;
        const metaError = err.response?.data?.error;
        const quedanVariantes = lang !== langs[langs.length - 1];
        if (metaError?.code === META_ERR_TEMPLATE_LANG_MISSING && quedanVariantes) {
          idiomaResueltoPorPlantilla.delete(templateName); // el cache ya no aplica
          console.warn(`[KommoWA] ⚠️ "${templateName}" no existe en "${lang}" (132001) — reintento con otra variante de español`);
          continue;
        }
        break; // otro error (o ya no quedan variantes): no reintentar
      }
    }

    const metaError = ultimoError?.response?.data?.error;
    const detalle = metaError ? `${metaError.code} - ${metaError.message}` : ultimoError?.message;
    console.error(`[KommoWA] ❌ Error enviando a ${phone}: ${detalle}`);
    throw new Error(`Meta WhatsApp API: ${detalle}`);
  }
}

module.exports = new KommoWhatsAppService();

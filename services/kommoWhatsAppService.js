const axios = require('axios');
require('dotenv').config();

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
    this.templateLang      = process.env.WA_TEMPLATE_LANG || 'es'; // debe coincidir con Meta
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
  async enviarTemplate({ telefono, templateName, nombre, cartUrl, language }) {
    const phone = normalizarTelefono(telefono);
    if (!phone) throw new Error(`Teléfono inválido: ${telefono}`);

    const lang = language || this.templateLang;
    const components = buildComponents(templateName, { nombre, cartUrl });

    // Si no hay credenciales de Meta, seguimos en modo STUB (no envía nada)
    if (!this.metaConfigurado) {
      const payload = { to: phone, template: { name: templateName, language: { code: lang }, components } };
      console.log(`[KommoWA] 📤 STUB (sin credenciales Meta) → ${phone} | template: "${templateName}"`);
      console.log(`[KommoWA] Payload listo:`, JSON.stringify(payload, null, 2));
      return { success: true, stub: true, phone, templateName, payload };
    }

    // ── Envío real vía WhatsApp Cloud API de Meta ───────────────────────────────
    const url = `https://graph.facebook.com/${this.metaApiVersion}/${this.metaPhoneNumberId}/messages`;
    const body = {
      messaging_product: 'whatsapp',
      to: phone,
      type: 'template',
      template: { name: templateName, language: { code: lang }, components },
    };

    try {
      const res = await axios.post(url, body, {
        headers: { Authorization: `Bearer ${this.metaToken}`, 'Content-Type': 'application/json' },
      });
      const messageId = res.data?.messages?.[0]?.id || null;
      console.log(`[KommoWA] ✅ Enviado → ${phone} | template: "${templateName}" | msgId: ${messageId}`);
      return { success: true, stub: false, phone, templateName, messageId };
    } catch (err) {
      const metaError = err.response?.data?.error;
      const detalle = metaError ? `${metaError.code} - ${metaError.message}` : err.message;
      console.error(`[KommoWA] ❌ Error enviando a ${phone}: ${detalle}`);
      throw new Error(`Meta WhatsApp API: ${detalle}`);
    }
  }
}

module.exports = new KommoWhatsAppService();

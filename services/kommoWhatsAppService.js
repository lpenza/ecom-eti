const axios = require('axios');
require('dotenv').config();

// Normaliza teléfono uruguayo al formato internacional sin '+'
function normalizarTelefono(tel) {
  const limpio = String(tel || '').replace(/\D/g, '');
  if (!limpio) return null;
  return limpio.startsWith('598') ? limpio : `598${limpio}`;
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
function buildComponents(templateName, { nombre, cartUrl }) {
  const template1 = process.env.WA_TEMPLATE_CARRITO_1;
  const hayBoton  = templateName === template1;

  const components = [
    {
      type: 'body',
      parameters: [
        { type: 'text', text: nombre || 'Cliente' },
      ],
    },
  ];

  if (hayBoton && cartUrl) {
    // El botón URL en Meta espera solo el sufijo dinámico de la URL.
    // Si la URL base de la plantilla en Meta es "https://tienda.com/" el sufijo es el resto.
    // Como usamos la URL completa de Shopify, pasamos la URL entera como sufijo dinámico.
    components.push({
      type: 'button',
      sub_type: 'url',
      index: '0',
      parameters: [{ type: 'text', text: cartUrl }],
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
  async enviarTemplate({ telefono, templateName, nombre, cartUrl, language = 'es' }) {
    const phone = normalizarTelefono(telefono);
    if (!phone) throw new Error(`Teléfono inválido: ${telefono}`);

    const components = buildComponents(templateName, { nombre, cartUrl });

    // ── STUB ──────────────────────────────────────────────────────────────────
    // Cuando Kommo habilite el endpoint de Marketing Messages API, reemplazá
    // este bloque por el axios.post real. El body ya está armado arriba.
    //
    // Lo que sabemos del cuerpo de la request:
    //   {
    //     to: phone,                         // ej: "59899123456"
    //     waba_id: this.wabaId,              // "1216288176881002"
    //     template: {
    //       name: templateName,              // "intento_abandonado_v1"
    //       language: { code: language },    // { code: "es" }
    //       components,                      // array armado por buildComponents()
    //     }
    //   }
    //
    // El endpoint de Kommo para marketing messages es algo como:
    //   POST https://velinneuy.kommo.com/api/v4/... (ver docs Kommo MM API)
    //
    // Referencia: https://www.kommo.com/support/messenger-apps/marketing-messages-api/
    // ─────────────────────────────────────────────────────────────────────────

    const payload = {
      to: phone,
      waba_id: this.wabaId,
      template: { name: templateName, language: { code: language }, components },
    };

    console.log(`[KommoWA] 📤 STUB → ${phone} | template: "${templateName}"`);
    console.log(`[KommoWA] Payload listo:`, JSON.stringify(payload, null, 2));

    return { success: true, stub: true, phone, templateName, payload };
  }
}

module.exports = new KommoWhatsAppService();

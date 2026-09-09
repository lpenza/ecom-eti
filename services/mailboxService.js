/**
 * Servicio de buzón (lectura de correos) — Hostinger Mail REST API.
 *
 * Modelo de correo de Velinne (Hostinger):
 *   - Hay un único buzón "madre": info@velinneuy.com.
 *   - ventas@velinneuy.com y los demás son ALIAS: todo cae en la bandeja de info@.
 *
 * LECTURA: usamos la REST API oficial (https://api.mail.hostinger.com) con token
 * Bearer. Para acotar a un alias (ej. atención sólo ve ventas@) filtramos por el
 * destinatario con el endpoint de búsqueda (campos To/Cc del servidor).
 *
 * ENVÍO: se hace por SMTP (services/emailService.js), NO por esta API. La API de
 * envío manda siempre desde el buzón autenticado (info@) y no deja fijar el
 * remitente; SMTP sí permite From = alias (ventas@), lo que mantiene vivo el hilo
 * del alias para que atención siga viendo las respuestas del cliente.
 *
 * Config (variables de entorno):
 *   HOSTINGER_MAIL_TOKEN     (requerido) token Bearer del panel de Hostinger.
 *   HOSTINGER_MAILBOX_ID     (opcional)  resourceId del buzón; si falta se resuelve vía /me.
 *   HOSTINGER_MAIL_BASE      (opcional)  default https://api.mail.hostinger.com
 *   HOSTINGER_MAIL_FOLDER    (opcional)  default INBOX
 */
const axios = require('axios');
const https = require('https');

// Conexión persistente: reutiliza el socket TLS entre requests (evita rehacer el
// handshake en cada llamada, que es lo que más latencia agregaba).
const keepAliveAgent = new https.Agent({ keepAlive: true, maxSockets: 10 });

// Alias conocidos (override con MAIL_ALIASES, separados por coma).
const MAIL_MADRE = String(process.env.MAIL_MADRE || 'info@velinneuy.com').toLowerCase().trim();
const MAIL_ALIASES = String(
  process.env.MAIL_ALIASES
  || `${MAIL_MADRE},ventas@velinneuy.com,consultas@velinneuy.com,facturacion@velinneuy.com`
)
  .split(',')
  .map((s) => s.toLowerCase().trim())
  .filter(Boolean);

// Alias que puede ver/usar el rol atención al cliente.
const MAIL_ALIASES_ATENCION = String(process.env.MAIL_ALIASES_ATENCION || 'consultas@velinneuy.com')
  .split(',')
  .map((s) => s.toLowerCase().trim())
  .filter(Boolean);

const BASE = String(process.env.HOSTINGER_MAIL_BASE || 'https://api.mail.hostinger.com').replace(/\/+$/, '');
const FOLDER = process.env.HOSTINGER_MAIL_FOLDER || 'INBOX';
let cachedMailboxId = process.env.HOSTINGER_MAILBOX_ID || null;
let cachedSentFolder = process.env.HOSTINGER_SENT_FOLDER || null;

function client() {
  const token = process.env.HOSTINGER_MAIL_TOKEN;
  if (!token) {
    throw new Error('Falta HOSTINGER_MAIL_TOKEN (token de la API de correo de Hostinger).');
  }
  return axios.create({
    baseURL: BASE,
    timeout: 20000,
    httpsAgent: keepAliveAgent,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
  });
}

// Convierte errores de axios en Error con mensaje legible de la API.
function toApiError(error, contexto) {
  const status = error?.response?.status;
  const apiMsg = error?.response?.data?.message
    || error?.response?.data?.error
    || (typeof error?.response?.data === 'string' ? error.response.data : '')
    || error.message;
  const e = new Error(`${contexto}: ${apiMsg}${status ? ` (HTTP ${status})` : ''}`);
  e.status = status;
  return e;
}

// Busca recursivamente en la respuesta de /me un resourceId de buzón, prefiriendo
// el que corresponda al buzón madre (info@).
function scanForMailboxId(root, preferAddress) {
  const idKeys = ['mailboxResourceId', 'resourceId', 'resource_id', 'id'];
  const addrKeys = ['email', 'address', 'mailbox', 'username', 'name'];
  let fallback = null;

  const visit = (node) => {
    if (!node || typeof node !== 'object') return null;
    if (Array.isArray(node)) {
      for (const it of node) { const r = visit(it); if (r) return r; }
      return null;
    }
    let id = null;
    let addr = null;
    for (const k of Object.keys(node)) {
      const v = node[k];
      if (!id && idKeys.includes(k) && typeof v === 'string') id = v;
      if (!addr && addrKeys.includes(k) && typeof v === 'string') addr = v.toLowerCase();
    }
    if (id) {
      if (addr && preferAddress && addr === preferAddress) return id;
      if (!fallback) fallback = id;
    }
    for (const k of Object.keys(node)) { const r = visit(node[k]); if (r) return r; }
    return null;
  };

  return visit(root) || fallback;
}

async function resolveMailboxId() {
  if (cachedMailboxId) return cachedMailboxId;
  try {
    const { data } = await client().get('/api/v1/me');
    const found = scanForMailboxId(data?.data ?? data, MAIL_MADRE);
    if (!found) {
      throw new Error(
        'No se pudo resolver el mailboxResourceId desde /me. Definí HOSTINGER_MAILBOX_ID. '
        + `Respuesta: ${JSON.stringify(data).slice(0, 400)}`
      );
    }
    cachedMailboxId = found;
    return found;
  } catch (error) {
    if (error?.response) throw toApiError(error, 'No se pudo consultar /me');
    throw error;
  }
}

function normalizeAddress(addr) {
  if (!addr) return null;
  return {
    name: String(addr.name || '').trim(),
    address: String(addr.address || '').toLowerCase().trim(),
  };
}

function normalizeAddressList(list) {
  if (!Array.isArray(list)) return [];
  return list.map(normalizeAddress).filter(Boolean);
}

// ¿Alguno de los destinatarios (To/Cc) coincide con uno de los alias permitidos?
function matchesAnyAlias(recipients, aliases) {
  if (!Array.isArray(aliases) || aliases.length === 0) return true; // sin restricción
  const wanted = new Set(aliases.map((a) => String(a).toLowerCase().trim()));
  return recipients.some((r) => r && wanted.has(r.address));
}

// Alias del buzón por el que entró el correo (el primer MAIL_ALIASES presente en
// To/Cc). Sirve para mostrar un flag "vino a ventas@ / info@" en la bandeja.
function detectAlias(to, cc) {
  const recipients = [...(to || []), ...(cc || [])];
  const dirs = new Set(recipients.map((r) => r && r.address).filter(Boolean));
  return MAIL_ALIASES.find((a) => dirs.has(a)) || null;
}

// Detecta la carpeta de Enviados por su atributo SPECIAL-USE (\Sent).
async function resolveSentFolder() {
  if (cachedSentFolder) return cachedSentFolder;
  const mb = await resolveMailboxId();
  try {
    const { data } = await client().get(`/api/v1/mailboxes/${mb}/folders`);
    const folders = data?.data || [];
    const sent = folders.find((f) => f.specialUse === '\\Sent')
      || folders.find((f) => /^sent$|enviad/i.test(String(f.name || '')));
    cachedSentFolder = sent?.path || 'INBOX.Sent';
  } catch {
    cachedSentFolder = 'INBOX.Sent';
  }
  return cachedSentFolder;
}

// tipo: 'inbox' (default) | 'sent'. Devuelve el path real (URL-encoded).
async function resolveFolder(tipo) {
  const path = tipo === 'sent' ? await resolveSentFolder() : FOLDER;
  return encodeURIComponent(path);
}

function mapSummary(m, tipo = 'inbox') {
  const from = normalizeAddress(m.from);
  const to = normalizeAddressList(m.to);
  const cc = normalizeAddressList(m.cc);
  // En Enviados el alias relevante es el remitente; en Recibidos, el destinatario.
  const alias = tipo === 'sent'
    ? (from && MAIL_ALIASES.includes(from.address) ? from.address : null)
    : detectAlias(to, cc);
  return {
    uid: m.uid,
    from,
    to,
    cc,
    subject: String(m.subject || '(sin asunto)'),
    date: m.date || new Date().toISOString(),
    seen: m.unseen === undefined ? true : !m.unseen,
    messageId: m.messageId || null,
    alias,
  };
}

/**
 * Lista los últimos mensajes de la bandeja de entrada.
 * @param {string|null} alias  Si se pasa, sólo mensajes dirigidos a ese alias (To o Cc). null = toda la bandeja.
 * @param {number} limit        Cantidad máxima de mensajes (default 30, máx 100).
 */
async function listMessages({ alias = null, limit = 30, tipo = 'inbox' } = {}) {
  const max = Math.min(Math.max(Number(limit) || 30, 1), 100);
  const mb = await resolveMailboxId();
  const c = client();
  const folder = await resolveFolder(tipo);
  const base = `/api/v1/mailboxes/${mb}/folders/${folder}/messages`;

  try {
    let raw = [];
    if (alias) {
      // En Recibidos el alias está en To/Cc; en Enviados, en From.
      const queries = tipo === 'sent' ? [{ from: alias }] : [{ to: alias }, { cc: alias }];
      const results = await Promise.all(
        queries.map((body) =>
          c.post(`${base}/search`, body, { params: { perPage: max, sort: '-date' } })
            .then((r) => r.data?.data || [])
            .catch(() => [])
        )
      );
      const vistos = new Set();
      for (const arr of results) {
        for (const m of arr) {
          if (!vistos.has(m.uid)) { vistos.add(m.uid); raw.push(m); }
        }
      }
    } else {
      const r = await c.get(base, { params: { perPage: max, sort: '-date' } });
      raw = r.data?.data || [];
    }

    return raw
      .map((m) => mapSummary(m, tipo))
      .sort((a, b) => new Date(b.date) - new Date(a.date))
      .slice(0, max);
  } catch (error) {
    if (error?.response) throw toApiError(error, 'Error al leer la bandeja');
    throw error;
  }
}

/**
 * Trae un mensaje completo (cuerpo HTML/texto) por UID.
 * @param {number} uid
 * @param {string[]|null} restrictTo  Si se pasa, el mensaje debe estar dirigido a alguno de esos alias; si no, { forbidden: true }.
 * @param {boolean} markSeen          Marca el mensaje como leído (default true).
 */
async function getMessage({ uid, restrictTo = null, markSeen = true, tipo = 'inbox' } = {}) {
  const numericUid = Number(uid);
  if (!Number.isFinite(numericUid)) return null;

  const mb = await resolveMailboxId();
  const c = client();
  const folder = await resolveFolder(tipo);
  const base = `/api/v1/mailboxes/${mb}/folders/${folder}/messages/${numericUid}`;

  try {
    // Metadata y cuerpo en paralelo: ahorra un round-trip completo al abrir.
    const [metaR, textR] = await Promise.all([
      c.get(base).catch((e) => {
        if (e?.response?.status === 404) return null;
        throw e;
      }),
      c.get(`${base}/text`).catch(() => null),
    ]);
    if (!metaR) return null;

    const m = metaR.data?.data;
    if (!m) return null;

    const from = normalizeAddress(m.from);
    const to = normalizeAddressList(m.to);
    const cc = normalizeAddressList(m.cc);

    // Control de acceso por alias. En Recibidos se valida contra To/Cc; en
    // Enviados, contra el remitente (el alias con el que se envió).
    if (Array.isArray(restrictTo) && restrictTo.length > 0) {
      const campos = tipo === 'sent' ? [from] : [...to, ...cc];
      if (!matchesAnyAlias(campos, restrictTo)) {
        return { forbidden: true };
      }
    }

    const body = textR?.data?.data || {};

    // Marcar como leído en segundo plano (no bloquea la respuesta al usuario).
    if (markSeen && m.unseen) {
      c.patch(base, { addFlags: ['\\Seen'] }).catch(() => { /* noop */ });
    }

    const alias = tipo === 'sent'
      ? (from && MAIL_ALIASES.includes(from.address) ? from.address : null)
      : detectAlias(to, cc);

    return {
      uid: numericUid,
      from,
      to,
      cc,
      subject: String(m.subject || '(sin asunto)'),
      date: m.date || new Date().toISOString(),
      messageId: m.messageId || null,
      references: m.inReplyTo || m.messageId || null,
      alias,
      html: body.html || null,
      text: body.text || '',
    };
  } catch (error) {
    if (error?.response) throw toApiError(error, 'Error al leer el correo');
    throw error;
  }
}

// Devuelve el MIME crudo (message/rfc822) de un mensaje. Útil para inspeccionar
// cabeceras (DKIM-Signature, Authentication-Results, etc.).
async function getMessageSource({ uid, tipo = 'inbox' } = {}) {
  const numericUid = Number(uid);
  if (!Number.isFinite(numericUid)) return null;
  const mb = await resolveMailboxId();
  const c = client();
  const folder = await resolveFolder(tipo);
  const url = `/api/v1/mailboxes/${mb}/folders/${folder}/messages/${numericUid}/source`;
  try {
    const r = await c.get(url, { responseType: 'text', headers: { Accept: 'message/rfc822' } });
    return typeof r.data === 'string' ? r.data : String(r.data || '');
  } catch (error) {
    if (error?.response) throw toApiError(error, 'Error al leer el source del correo');
    throw error;
  }
}

module.exports = {
  listMessages,
  getMessage,
  getMessageSource,
  MAIL_MADRE,
  MAIL_ALIASES,
  MAIL_ALIASES_ATENCION,
};

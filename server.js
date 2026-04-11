const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs').promises;
const axios = require('axios');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(bodyParser.json({ charset: 'utf-8' }));
app.use(express.static('public'));

// Asegurar respuestas en UTF-8
app.use((req, res, next) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  next();
});

// Importar servicios
const supabaseService = require('./services/supabaseService');
const uesService = require('./services/uesService');
const shopifyService = require('./services/shopifyService');
const { generarLinkWhatsApp } = require('./services/notificationService');
const emailService = require('./services/emailService');
const logService = require('./services/logService');

// Estado global para cache UES
let uesCacheStatus = {
  ready: false,
  lastUpdate: null,
  error: null,
  departamentos: 0
};

const REDIS_REST_URL = String(process.env.REDIS_REST_URL || process.env.UPSTASH_REDIS_REST_URL || '').trim().replace(/\/+$/, '');
const REDIS_REST_TOKEN = String(process.env.REDIS_REST_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '').trim();
const BOT_REDIS_PREFIX = String(process.env.BOT_REDIS_PREFIX || 'velinne_memory').trim();

function buildRedisHeaders() {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };

  if (REDIS_REST_TOKEN) {
    headers.Authorization = REDIS_REST_TOKEN.startsWith('Bearer ')
      ? REDIS_REST_TOKEN
      : `Bearer ${REDIS_REST_TOKEN}`;
  }

  return headers;
}

async function redisScan(pattern, cursor = '0', count = 500) {
  const encodedPattern = encodeURIComponent(pattern);
  const response = await axios.get(
    `${REDIS_REST_URL}/scan/${cursor}/match/${encodedPattern}/count/${count}`,
    { headers: buildRedisHeaders(), timeout: 15000, validateStatus: () => true }
  );

  if (response.status >= 400) {
    const error = new Error(response?.data?.error || `Redis scan error (${response.status})`);
    error.status = response.status;
    throw error;
  }

  const result = response?.data?.result;
  if (!Array.isArray(result) || result.length < 2) return { cursor: '0', keys: [] };
  return {
    cursor: String(result[0] || '0'),
    keys: Array.isArray(result[1]) ? result[1] : [],
  };
}

async function redisPipeline(commands = []) {
  const response = await axios.post(
    `${REDIS_REST_URL}/pipeline`,
    commands,
    { headers: buildRedisHeaders(), timeout: 15000, validateStatus: () => true }
  );

  if (response.status >= 400) {
    const error = new Error(response?.data?.error || `Redis pipeline error (${response.status})`);
    error.status = response.status;
    throw error;
  }

  return Array.isArray(response.data) ? response.data : [];
}

async function listBotRedisKeys() {
  if (!REDIS_REST_URL) {
    const error = new Error('REDIS_REST_URL no configurado');
    error.status = 503;
    throw error;
  }

  const pattern = `${BOT_REDIS_PREFIX}:*@*`;
  let cursor = '0';
  const found = [];

  do {
    const page = await redisScan(pattern, cursor, 500);
    cursor = page.cursor;
    found.push(...page.keys);
  } while (cursor !== '0' && found.length < 10000);

  return found;
}

function canonicalizeBotMode(rawMode) {
  const normalized = String(rawMode || '').trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === 'human_taken') return 'paused';
  if (normalized === 'bot_active' || normalized === 'paused' || normalized === 'blacklist') return normalized;
  return null;
}

function parseBotRedisValue(key, rawValue) {
  if (!rawValue) return null;

  let parsed;
  try {
    parsed = typeof rawValue === 'string' ? JSON.parse(rawValue) : rawValue;
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== 'object') return null;

  const withoutPrefix = key.startsWith(`${BOT_REDIS_PREFIX}:`)
    ? key.slice(BOT_REDIS_PREFIX.length + 1)
    : key;
  const atIdx = withoutPrefix.indexOf('@');
  const contactId = atIdx >= 0 ? withoutPrefix.slice(0, atIdx) : withoutPrefix;
  const phoneNumber = String(
    parsed.phone_number
    || parsed.phone
    || parsed.customer_phone
    || contactId
    || ''
  ).trim();
  const customerName = String(
    parsed.customer_name
    || parsed.name
    || parsed.cliente_nombre
    || ''
  ).trim();
  const history = Array.isArray(parsed.history) ? parsed.history : [];
  const lastMessageAt = history.length > 0 ? history[history.length - 1]?.at || null : null;
  const requiresHumanLastTime = Boolean(parsed.requires_human_last_time);

  const controlRaw = parsed.control && typeof parsed.control === 'object' ? parsed.control : {};
  const mode = canonicalizeBotMode(parsed.mode || controlRaw.mode);
  const botEnabledRaw = typeof parsed.bot_enabled === 'boolean'
    ? parsed.bot_enabled
    : (typeof controlRaw.bot_enabled === 'boolean' ? controlRaw.bot_enabled : null);
  const blacklistedRaw = typeof parsed.blacklisted === 'boolean'
    ? parsed.blacklisted
    : Boolean(controlRaw.blacklisted);
  const reasonRaw = typeof parsed.reason === 'string'
    ? parsed.reason
    : String(controlRaw.reason || '');
  const updatedAtRaw = parsed.updated_at || controlRaw.updated_at || null;
  const updatedByRaw = parsed.updated_by || controlRaw.updated_by || null;

  return {
    id: contactId,
    contact_id: contactId,
    phone: phoneNumber,
    phone_number: phoneNumber,
    customer_name: customerName,
    name: customerName,
    key,
    stage: parsed.stage || null,
    last_intent: parsed.last_intent || null,
    last_subintent: parsed.last_subintent || null,
    customer_state: parsed.customer_state || null,
    interest_product: parsed.interest_product || null,
    profile_summary: parsed.profile_summary || null,
    pending_action: parsed.pending_action || null,
    requires_human_last_time: requiresHumanLastTime,
    history,
    last_message_at: lastMessageAt,
    control: {
      mode,
      bot_enabled: typeof botEnabledRaw === 'boolean' ? botEnabledRaw : !requiresHumanLastTime,
      blacklisted: Boolean(blacklistedRaw),
      reason: String(reasonRaw || ''),
      updated_at: updatedAtRaw,
      updated_by: updatedByRaw,
    },
  };
}

async function loadBotContactsFromRedis() {
  const keys = await listBotRedisKeys();
  if (keys.length === 0) return [];

  const commands = keys.map((k) => ['GET', k]);
  const rawResults = await redisPipeline(commands);

  const contacts = [];
  for (let i = 0; i < keys.length; i += 1) {
    const parsed = parseBotRedisValue(keys[i], rawResults[i]?.result || null);
    if (parsed) contacts.push(parsed);
  }

  contacts.sort((a, b) => {
    const atA = new Date(a.last_message_at || 0).getTime();
    const atB = new Date(b.last_message_at || 0).getTime();
    return atB - atA;
  });

  return contacts;
}

async function findRedisKeyByContactId(contactId) {
  const normalized = String(contactId || '').trim();
  if (!normalized) return null;

  const strictPattern = `${BOT_REDIS_PREFIX}:${normalized}@*`;
  let cursor = '0';
  do {
    const strict = await redisScan(strictPattern, cursor, 200);
    if (strict.keys.length > 0) return strict.keys[0];
    cursor = strict.cursor;
  } while (cursor !== '0');

  const fallbackPattern = `${BOT_REDIS_PREFIX}:*${normalized}*@*`;
  cursor = '0';
  do {
    const fallback = await redisScan(fallbackPattern, cursor, 200);
    if (fallback.keys.length > 0) return fallback.keys[0];
    cursor = fallback.cursor;
  } while (cursor !== '0');

  return null;
}

async function botControlRequest(method, endpoint, { params = undefined, data = undefined } = {}) {
  // Implementación explícita: solo Redis/Upstash como fuente real.
  if (method.toLowerCase() === 'get' && endpoint === '/contacts') {
    return await loadBotContactsFromRedis();
  }

  const historyMatch = endpoint.match(/^\/contacts\/([^/]+)\/history$/);
  if (method.toLowerCase() === 'get' && historyMatch) {
    const contactId = decodeURIComponent(historyMatch[1]);
    const key = await findRedisKeyByContactId(contactId);
    if (!key) return [];

    const results = await redisPipeline([['GET', key]]);
    const parsed = parseBotRedisValue(key, results?.[0]?.result || null);
    return Array.isArray(parsed?.history) ? parsed.history : [];
  }

  const controlMatch = endpoint.match(/^\/contacts\/([^/]+)\/control$/);
  if (method.toLowerCase() === 'patch' && controlMatch) {
    const contactId = decodeURIComponent(controlMatch[1]);
    logService.info('Bot control PATCH recibido', {
      contactId,
      requestedMode: data?.mode || null,
      hasReason: typeof data?.reason === 'string',
    });

    const key = await findRedisKeyByContactId(contactId);
    if (!key) {
      logService.warning('Bot control PATCH sin key Redis', { contactId });
      const error = new Error('Contacto no encontrado en Redis');
      error.status = 404;
      throw error;
    }

    logService.info('Bot control key encontrada', { contactId, key });

    const getResult = await redisPipeline([['GET', key]]);
    const currentRaw = getResult?.[0]?.result || null;
    let current = {};
    try {
      current = currentRaw ? JSON.parse(currentRaw) : {};
    } catch {
      logService.warning('Bot control JSON inválido en Redis, se recrea control', { contactId, key });
      current = {};
    }

    const mode = canonicalizeBotMode(data?.mode);
    const controlFromMemory = current.control && typeof current.control === 'object' ? current.control : {};
    const currentMode = canonicalizeBotMode(current.mode || controlFromMemory.mode);
    const currentBotEnabled = typeof current.bot_enabled === 'boolean'
      ? current.bot_enabled
      : (typeof controlFromMemory.bot_enabled === 'boolean' ? controlFromMemory.bot_enabled : null);
    const currentBlacklisted = typeof current.blacklisted === 'boolean'
      ? current.blacklisted
      : Boolean(controlFromMemory.blacklisted);
    const currentReason = typeof current.reason === 'string'
      ? current.reason
      : String(controlFromMemory.reason || '');
    const currentUpdatedAt = current.updated_at || controlFromMemory.updated_at || null;
    const currentUpdatedBy = current.updated_by || controlFromMemory.updated_by || null;

    const controlPrev = {
      mode: currentMode,
      bot_enabled: typeof currentBotEnabled === 'boolean' ? currentBotEnabled : !Boolean(current.requires_human_last_time),
      blacklisted: currentBlacklisted,
      reason: currentReason,
      updated_at: currentUpdatedAt,
      updated_by: currentUpdatedBy,
    };
    const controlNext = {
      ...controlPrev,
      ...(typeof data?.reason === 'string' ? { reason: data.reason } : {}),
      ...(mode ? { mode } : {}),
      ...(mode ? { bot_enabled: mode === 'bot_active', blacklisted: mode === 'blacklist' } : {}),
      ...(typeof data?.blacklisted === 'boolean' ? { blacklisted: data.blacklisted } : {}),
      updated_at: new Date().toISOString(),
      updated_by: 'panel',
    };

    if (typeof data?.blacklisted === 'boolean' && data.blacklisted) {
      controlNext.bot_enabled = false;
    }

    const nextRequiresHumanLastTime =
      typeof data?.blacklisted === 'boolean'
        ? (data.blacklisted ? true : Boolean(current.requires_human_last_time))
        : (mode ? mode !== 'bot_active' : Boolean(current.requires_human_last_time));

    const nextBlacklistedFlag =
      typeof data?.blacklisted === 'boolean'
        ? data.blacklisted
        : (mode ? mode === 'blacklist' : Boolean(current.blacklisted));

    const nextMemoryValue = {
      ...current,
      requires_human_last_time: nextRequiresHumanLastTime,
      blacklisted: nextBlacklistedFlag,
      mode: controlNext.mode || null,
      bot_enabled: controlNext.bot_enabled,
      reason: controlNext.reason,
      updated_at: controlNext.updated_at,
      updated_by: controlNext.updated_by,
    };

    if (Object.prototype.hasOwnProperty.call(nextMemoryValue, 'control')) {
      delete nextMemoryValue.control;
    }

    const setResult = await redisPipeline([['SET', key, JSON.stringify(nextMemoryValue)]]);
    const memorySetReply = setResult?.[0]?.result || null;

    if (setResult?.[0]?.error) {
      const pipelineError = setResult?.[0]?.error || 'unknown';
      const err = new Error(`Redis SET error: ${pipelineError}`);
      err.status = 503;
      throw err;
    }

    const verifyResult = await redisPipeline([['GET', key]]);
    let verifyParsed = null;
    try {
      verifyParsed = verifyResult?.[0]?.result ? JSON.parse(verifyResult[0].result) : null;
    } catch {
      verifyParsed = null;
    }

    logService.info('Bot control PATCH persistido', {
      contactId,
      key,
      mode: controlNext.mode || null,
      bot_enabled: controlNext.bot_enabled,
      blacklisted: controlNext.blacklisted,
      requires_human_last_time: nextRequiresHumanLastTime,
      memorySetReply,
      verify_blacklisted: verifyParsed?.blacklisted ?? null,
      verify_requires_human_last_time: verifyParsed?.requires_human_last_time ?? null,
      verify_mode: verifyParsed?.mode ?? null,
      verify_bot_enabled: verifyParsed?.bot_enabled ?? null,
    });

    return {
      success: true,
      contact_id: contactId,
      key,
      redis_set_result: memorySetReply,
      requires_human_last_time: nextRequiresHumanLastTime,
      control: controlNext,
    };
  }

  const error = new Error('Operación no soportada para bot control Redis');
  error.status = 400;
  throw error;
}

function normalizeBotContactsPayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.contacts)) return payload.contacts;
  return [];
}

function normalizeBotHistoryPayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.history)) return payload.history;
  return [];
}

const CONTACT_REVIEW_FILE = path.join(__dirname, 'pedido_revision_contacto.json');

async function leerRevisionContacto() {
  try {
    const raw = await fs.readFile(CONTACT_REVIEW_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (error) {
    if (error?.code === 'ENOENT') return {};
    throw error;
  }
}

async function guardarRevisionContacto(data) {
  await fs.writeFile(CONTACT_REVIEW_FILE, JSON.stringify(data || {}, null, 2), 'utf-8');
}

// Rutas
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Diagnóstico de conexión con Shopify
app.get('/api/shopify/test', async (req, res) => {
  const domain = process.env.SHOPIFY_DOMAIN || '';
  const token = process.env.SHOPIFY_ACCESS_TOKEN || '';
  const tokenPreview = token ? `${token.slice(0, 10)}...${token.slice(-4)}` : '(no configurado)';

  try {
    const response = await axios.get(
      `https://${domain}/admin/api/2024-01/shop.json`,
      { headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' } }
    );
    res.json({
      ok: true,
      domain,
      tokenPreview,
      shopName: response.data?.shop?.name,
      shopEmail: response.data?.shop?.email,
    });
  } catch (error) {
    const status = error.response?.status;
    const body = error.response?.data;
    res.status(200).json({
      ok: false,
      domain,
      tokenPreview,
      httpStatus: status,
      error: status === 401
        ? 'Token inválido o revocado — generá un nuevo token en Shopify Admin → Apps → tu app → API credentials'
        : status === 404
        ? 'Dominio no encontrado — verificar SHOPIFY_DOMAIN en .env'
        : error.message,
      shopifyResponse: body || null,
    });
  }
});

// Obtener pedidos activos (pendientes + etiqueta generada, excluye procesados)
app.get('/api/pedidos', async (req, res) => {
  try {
    console.log('📥 GET /api/pedidos - Obteniendo pedidos...');
    const [pedidos, revisionesContacto] = await Promise.all([
      supabaseService.obtenerPedidosActivos(),
      leerRevisionContacto(),
    ]);
    
    console.log(`📊 Pedidos obtenidos: ${pedidos ? pedidos.length : 0}`);
    
    // Asegurar que siempre devolvemos un array
    const pedidosArray = Array.isArray(pedidos) ? pedidos : [];
    const pedidosConRevision = pedidosArray.map((pedido) => {
      const revision = revisionesContacto?.[pedido.id] || null;
      return {
        ...pedido,
        revision_contacto_pendiente: Boolean(revision),
        revision_contacto_motivo: revision?.motivo || '',
        revision_contacto_fecha: revision?.fecha || null,
        revision_contacto_ultimo_contacto_at: revision?.ultimo_contacto_at || null,
        revision_contacto_ultimo_contacto_canal: revision?.ultimo_contacto_canal || null,
      };
    });
    
    console.log(`✅ Enviando ${pedidosConRevision.length} pedidos al cliente`);
    res.json(pedidosConRevision);
  } catch (error) {
    console.error('❌ Error en /api/pedidos:', error.message);
    logService.error('Error al obtener pedidos', error);
    // En caso de error, devolver array vacío en lugar de objeto
    res.status(500).json([]);
  }
});

app.post('/api/pedidos/:pedidoId/revision-contacto', async (req, res) => {
  try {
    const { pedidoId } = req.params;
    const { pendiente, motivo } = req.body || {};

    if (typeof pendiente !== 'boolean') {
      return res.status(400).json({ success: false, error: 'Campo pendiente inválido' });
    }

    const pedido = await supabaseService.obtenerPedido(pedidoId);
    if (!pedido) {
      return res.status(404).json({ success: false, error: 'Pedido no encontrado' });
    }

    const revisiones = await leerRevisionContacto();

    if (pendiente) {
      const motivoLimpio = String(motivo || '').trim();
      if (!motivoLimpio) {
        return res.status(400).json({ success: false, error: 'Debe indicar un motivo para revisión de contacto' });
      }

      revisiones[pedidoId] = {
        motivo: motivoLimpio,
        fecha: new Date().toISOString(),
        ultimo_contacto_at: revisiones[pedidoId]?.ultimo_contacto_at || null,
        ultimo_contacto_canal: revisiones[pedidoId]?.ultimo_contacto_canal || null,
      };
    } else {
      delete revisiones[pedidoId];
    }

    await guardarRevisionContacto(revisiones);

    logService.info(`Revisión de contacto actualizada para pedido ${pedidoId}`, {
      pendiente,
      motivo: pendiente ? String(motivo || '').trim() : null,
    });

    return res.json({
      success: true,
      pedidoId,
      revision_contacto_pendiente: pendiente,
      revision_contacto_motivo: pendiente ? String(motivo || '').trim() : '',
      revision_contacto_fecha: pendiente ? revisiones[pedidoId]?.fecha || null : null,
      revision_contacto_ultimo_contacto_at: pendiente ? revisiones[pedidoId]?.ultimo_contacto_at || null : null,
      revision_contacto_ultimo_contacto_canal: pendiente ? revisiones[pedidoId]?.ultimo_contacto_canal || null : null,
    });
  } catch (error) {
    logService.error('Error actualizando revisión de contacto', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/bot/contacts', async (req, res) => {
  try {
    const payload = await botControlRequest('get', '/contacts', { params: req.query || {} });
    return res.json(normalizeBotContactsPayload(payload));
  } catch (error) {
    logService.error('Error al obtener contactos bot', error);
    return res.status(error.status || 503).json({
      success: false,
      error: error.message || 'No se pudo obtener contactos del bot',
    });
  }
});

app.get('/api/bot/contacts/:contactId/history', async (req, res) => {
  try {
    const { contactId } = req.params;
    if (!String(contactId || '').trim()) {
      return res.status(400).json({ success: false, error: 'contactId requerido' });
    }

    const payload = await botControlRequest('get', `/contacts/${encodeURIComponent(contactId)}/history`);
    return res.json(normalizeBotHistoryPayload(payload));
  } catch (error) {
    logService.error('Error al obtener historial de contacto bot', error);
    return res.status(error.status || 503).json({
      success: false,
      error: error.message || 'No se pudo obtener historial del contacto',
    });
  }
});

app.patch('/api/bot/contacts/:contactId/control', async (req, res) => {
  try {
    const { contactId } = req.params;
    if (!String(contactId || '').trim()) {
      return res.status(400).json({ success: false, error: 'contactId requerido' });
    }

    const payload = await botControlRequest(
      'patch',
      `/contacts/${encodeURIComponent(contactId)}/control`,
      { data: req.body || {} }
    );

    return res.json(payload || { success: true });
  } catch (error) {
    logService.error('Error al actualizar control de contacto bot', error);
    return res.status(error.status || 503).json({
      success: false,
      error: error.message || 'No se pudo actualizar control del contacto',
    });
  }
});

app.post('/api/pedidos/:pedidoId/revision-contacto/contactado', async (req, res) => {
  try {
    const { pedidoId } = req.params;

    const pedido = await supabaseService.obtenerPedido(pedidoId);
    if (!pedido) {
      return res.status(404).json({ success: false, error: 'Pedido no encontrado' });
    }

    const revisiones = await leerRevisionContacto();
    const actual = revisiones[pedidoId];
    if (!actual) {
      return res.status(400).json({ success: false, error: 'El pedido no está marcado como pendiente de contacto' });
    }

    const ahora = new Date().toISOString();
    revisiones[pedidoId] = {
      ...actual,
      ultimo_contacto_at: ahora,
      ultimo_contacto_canal: 'whatsapp',
    };

    await guardarRevisionContacto(revisiones);

    logService.info(`Contacto registrado para pedido ${pedidoId}`, {
      ultimo_contacto_at: ahora,
    });

    return res.json({
      success: true,
      pedidoId,
      revision_contacto_ultimo_contacto_at: ahora,
      revision_contacto_ultimo_contacto_canal: 'whatsapp',
    });
  } catch (error) {
    logService.error('Error registrando contacto de revisión', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/pedidos/revision-contacto/email-masivo', async (req, res) => {
  try {
    const {
      pedidoIds = null,
      subjectTemplate = 'Seguimiento de tu pedido #{{numero_pedido}}',
      htmlTemplate = '',
      onlyWithoutPhone = true,
    } = req.body || {};

    const [pedidosActivos, revisiones] = await Promise.all([
      supabaseService.obtenerPedidosActivos(),
      leerRevisionContacto(),
    ]);

    const idsFiltrados = Array.isArray(pedidoIds) && pedidoIds.length > 0
      ? new Set(pedidoIds.map((id) => String(id)))
      : null;

    const candidatos = (Array.isArray(pedidosActivos) ? pedidosActivos : []).filter((pedido) => {
      const revision = revisiones?.[pedido.id];
      if (!revision) return false;
      if (idsFiltrados && !idsFiltrados.has(String(pedido.id))) return false;

      const email = String(pedido.cliente_email || '').trim();
      if (!email) return false;

      if (onlyWithoutPhone) {
        const phoneDigits = String(pedido.cliente_telefono || '').replace(/\D/g, '');
        return phoneDigits.length < 8;
      }

      return true;
    });

    if (candidatos.length === 0) {
      return res.json({
        success: true,
        count: 0,
        sent: 0,
        failed: 0,
        data: [],
        message: 'No hay pedidos pendientes de contacto con email para enviar',
      });
    }

    const resultados = [];

    for (const pedido of candidatos) {
      try {
        const revision = revisiones[pedido.id] || {};
        const { subject, html } = emailService.renderMail({
          pedido,
          subjectTemplate,
          htmlTemplate,
          motivoContacto: revision?.motivo || '',
        });

        const envio = await emailService.enviarCorreo({
          to: String(pedido.cliente_email || '').trim(),
          subject,
          html,
        });

        const ahora = new Date().toISOString();
        revisiones[pedido.id] = {
          ...revision,
          ultimo_contacto_at: ahora,
          ultimo_contacto_canal: 'email',
        };

        resultados.push({
          pedidoId: pedido.id,
          email: pedido.cliente_email,
          success: true,
          messageId: envio.messageId,
        });
      } catch (error) {
        resultados.push({
          pedidoId: pedido.id,
          email: pedido.cliente_email,
          success: false,
          error: error.message,
        });
      }
    }

    await guardarRevisionContacto(revisiones);

    const sent = resultados.filter((r) => r.success).length;
    const failed = resultados.length - sent;

    logService.info(`Email masivo pendientes contacto: ${sent} enviados, ${failed} errores`, {
      count: resultados.length,
    });

    return res.json({
      success: true,
      count: resultados.length,
      sent,
      failed,
      data: resultados,
    });
  } catch (error) {
    logService.error('Error enviando email masivo de pendientes de contacto', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// Obtener pedidos con total=0 (candidatos para reclamo)
app.get('/api/pedidos-para-reclamo', async (req, res) => {
  try {
    const pedidos = await supabaseService.obtenerPedidosParaReclamo();
    res.json(Array.isArray(pedidos) ? pedidos : []);
  } catch (error) {
    logService.error('Error al obtener pedidos para reclamo', error);
    res.status(500).json([]);
  }
});

// Obtener pedidos finalizados para reclamos
app.get('/api/pedidos-finalizados', async (req, res) => {
  try {
    console.log('📥 GET /api/pedidos-finalizados - Obteniendo pedidos finalizados...');
    const pedidos = await supabaseService.obtenerPedidosParaFollowUp('enviado');

    const pedidosArray = Array.isArray(pedidos) ? pedidos : [];
    console.log(`✅ Enviando ${pedidosArray.length} pedidos finalizados al cliente`);
    res.json(pedidosArray);
  } catch (error) {
    console.error('❌ Error en /api/pedidos-finalizados:', error.message);
    logService.error('Error al obtener pedidos finalizados', error);
    res.status(500).json([]);
  }
});

// Obtener estado del caché UES
app.get('/api/ues/cache-status', (req, res) => {
  res.json(uesCacheStatus);
});

// Login en UES
app.post('/api/ues/login', async (req, res) => {
  try {
    console.log('🔐 Intentando login en UES...');
    const token = await uesService.autenticarManual();
    logService.info('Login exitoso en UES');
    
    // Verificar y actualizar caché automáticamente después del login
    uesService.verificarYActualizarCache().catch(err => {
      logService.warning('No se pudo verificar caché después del login', err);
    });
    
    res.json({ success: true, token: token ? 'authenticated' : null });
  } catch (error) {
    logService.error('Error al hacer login en UES', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Estado de autenticación UES
app.get('/api/ues/status', (req, res) => {
  const isAuthenticated = uesService.token != null;
  res.json({ authenticated: isAuthenticated });
});

// Vista previa de payloads UES (sin enviar a UES)
app.get('/api/ues/payload-preview/:pedidoId', async (req, res) => {
  try {
    const { pedidoId } = req.params;

    if (!pedidoId) {
      return res.status(400).json({ success: false, error: 'ID de pedido requerido' });
    }

    const pedido = await supabaseService.obtenerPedido(pedidoId);
    if (!pedido) {
      return res.status(404).json({ success: false, error: 'Pedido no encontrado' });
    }

    const preview = await uesService.construirPayloadsUes(pedido);
    res.json({ success: true, data: preview });
  } catch (error) {
    // Distinguir entre errores de validación (datos incorrectos) y errores del sistema
    if (error.isValidationError) {
      logService.warning('Error de validación en preview payload UES', { 
        error: error.message,
        field: error.field,
        value: error.originalValue 
      });
      
      // Parsear dirección de todas formas para enviar al frontend
      const pedido = await supabaseService.obtenerPedido(req.params.pedidoId);
      const { parseAddress } = require('./services/direccionParserService');
      const direccionParseada = pedido ? parseAddress(pedido.direccion_envio || '') : null;
      
      return res.status(400).json({ 
        success: false, 
        error: error.message,
        field: error.field,
        value: error.originalValue,
        type: 'validation',
        direccionParseada: direccionParseada, // Enviar dirección parseada incluso en error
      });
    }
    
    // Error del sistema (500)
    logService.error('Error al construir preview payload UES', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/ues/catalog/departamentos', async (req, res) => {
  try {
    const data = await supabaseService.obtenerDepartamentosUes();
    res.json({ success: true, data });
  } catch (error) {
    logService.error('Error obteniendo catalogo de departamentos UES', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/ues/catalog/localidades', async (req, res) => {
  try {
    const departamentoId = req.query.departamento_id || null;
    const data = await supabaseService.obtenerLocalidadesUes(departamentoId);
    res.json({ success: true, data });
  } catch (error) {
    logService.error('Error obteniendo catalogo de localidades UES', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Obtener puntos de retiro UES para una localidad
app.get('/api/ues/catalog/puntos-retiro', async (req, res) => {
  try {
    const puntosRetiro = await uesService.obtenerPuntosRetiro();
    res.json({ success: true, data: puntosRetiro });
  } catch (error) {
    logService.error('Error obteniendo puntos de retiro UES', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Regenerar caché de contexto UES (manual)
app.post('/api/ues/regenerar-cache', async (req, res) => {
  try {
    const resultado = await uesService.regenerarCacheContexto();
    logService.info('Caché UES regenerado manualmente');
    res.json({ 
      success: true, 
      message: `Caché actualizado con ${resultado.departamentos} departamentos`,
      ...resultado
    });
  } catch (error) {
    logService.error('Error regenerando caché UES', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Sincronizar con Shopify (alias para React)
app.post('/api/sync-shopify', async (req, res) => {
  try {
    const [ordenes, existingIds] = await Promise.all([
      shopifyService.obtenerOrdenes(),
      supabaseService.obtenerShopifyOrderIds(),
    ]);
    const ordenesNuevas = ordenes.filter((o) => !existingIds.has(String(o.id)));
    const resultado = await supabaseService.sincronizarOrdenes(ordenes);
    logService.info(`Sincronizados ${resultado.length} pedidos desde Shopify (${ordenesNuevas.length} nuevos)`);
    // Agregar tag "ETIQUETA CREADA" a pedidos nuevos (best-effort)
    for (const orden of ordenesNuevas) {
      shopifyService.agregarTagAOrden(orden.id, 'ETIQUETA CREADA').catch((e) =>
        logService.warning(`No se pudo agregar tag a orden ${orden.id}: ${e.message}`)
      );
    }
    res.json({ success: true, count: resultado.length });
  } catch (error) {
    logService.error('Error al sincronizar Shopify', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Sincronizar con Shopify (ruta legacy)
app.post('/api/sincronizar-shopify', async (req, res) => {
  try {
    const [ordenes, existingIds] = await Promise.all([
      shopifyService.obtenerOrdenes(),
      supabaseService.obtenerShopifyOrderIds(),
    ]);
    const ordenesNuevas = ordenes.filter((o) => !existingIds.has(String(o.id)));
    const resultado = await supabaseService.sincronizarOrdenes(ordenes);
    logService.info(`Sincronizados ${resultado.length} pedidos desde Shopify (${ordenesNuevas.length} nuevos)`);
    for (const orden of ordenesNuevas) {
      shopifyService.agregarTagAOrden(orden.id, 'ETIQUETA CREADA').catch((e) =>
        logService.warning(`No se pudo agregar tag a orden ${orden.id}: ${e.message}`)
      );
    }
    res.json({ success: true, data: resultado });
  } catch (error) {
    logService.error('Error al sincronizar Shopify', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

async function handleFulfillmentShopify(req, res) {
  try {
    const { pedidoIds } = req.body || {};

    let pedidos = [];
    if (Array.isArray(pedidoIds) && pedidoIds.length > 0) {
      const pedidosEncontrados = await Promise.all(
        pedidoIds.map((pedidoId) => supabaseService.obtenerPedido(pedidoId))
      );
      pedidos = pedidosEncontrados.filter(Boolean);
    } else {
      pedidos = await supabaseService.obtenerPedidosParaFulfillment();
    }

    const candidatos = pedidos.filter(
      (p) => (p.shopify_order_id || p.numero_pedido) && p.numero_seguimiento_ues
    );

    const resultados = [];

    for (const pedido of candidatos) {
      try {
        // Resolver shopify_order_id si no está guardado en DB
        let shopifyOrderId = pedido.shopify_order_id;
        if (!shopifyOrderId && pedido.numero_pedido) {
          logService.info(`Resolviendo shopify_order_id para pedido #${pedido.numero_pedido}...`);
          shopifyOrderId = await shopifyService.obtenerIdPorNumeroPedido(pedido.numero_pedido);
          if (!shopifyOrderId) {
            throw new Error(`No se encontró la orden #${pedido.numero_pedido} en Shopify`);
          }
          logService.info(`shopify_order_id resuelto: ${shopifyOrderId} para pedido #${pedido.numero_pedido}`);
          // Persistir para no tener que buscarlo de nuevo
          supabaseService.actualizarPedido(pedido.id, { shopify_order_id: String(shopifyOrderId) }).catch(() => {});
        }

        logService.info(`Fulfillment pedido #${pedido.numero_pedido} | shopifyOrderId=${shopifyOrderId} | tracking=${pedido.numero_seguimiento_ues}`);

        const fulfillment = await shopifyService.marcarComoCumplida(
          shopifyOrderId,
          pedido.numero_seguimiento_ues
        );

        await supabaseService.actualizarPedido(pedido.id, {
          estado: 'enviado',
          notificacion_enviada_at: new Date().toISOString(),
        });

        logService.info(`✅ Fulfillment OK pedido #${pedido.numero_pedido} | fulfillmentId=${fulfillment?.id || 'N/A'}`);

        // Tag DESPACHADO en Shopify (best-effort)
        shopifyService.agregarTagAOrden(shopifyOrderId, 'DESPACHADO').catch((e) =>
          logService.warning(`No se pudo agregar tag DESPACHADO a orden ${shopifyOrderId}: ${e.message}`)
        );

        resultados.push({
          pedidoId: pedido.id,
          shopifyOrderId,
          success: true,
          fulfillmentId: fulfillment?.id || null,
          pedido: pedido // Devolver pedido completo para generar links de WhatsApp
        });
      } catch (error) {
        logService.error(`❌ Fulfillment FALLÓ pedido #${pedido.numero_pedido} | shopifyOrderId=${pedido.shopify_order_id || 'N/A'} | tracking=${pedido.numero_seguimiento_ues}`, {
          mensaje: error.message,
          stack: error.stack,
        });
        resultados.push({
          pedidoId: pedido.id,
          numeroPedido: pedido.numero_pedido,
          shopifyOrderId: pedido.shopify_order_id || null,
          success: false,
          error: error.message,
        });
      }
    }

    const successCount = resultados.filter((r) => r.success).length;
    const failCount = resultados.length - successCount;

    // Identificar pedidos sin email para notificar por WhatsApp
    const pedidosSinEmail = resultados
      .filter(r => r.success && r.pedido && !(r.pedido.cliente_email || r.pedido.email))
      .map(r => ({
        id: r.pedido.id,
        numero_pedido: r.pedido.numero_pedido,
        cliente_nombre: r.pedido.cliente_nombre,
        cliente_telefono: r.pedido.cliente_telefono || r.pedido.telefono || '',
        tracking: r.pedido.numero_seguimiento_ues,
        numero_seguimiento_ues: r.pedido.numero_seguimiento_ues,
        cliente_email: r.pedido.cliente_email || r.pedido.email || ''
      }));

    logService.info(`Fulfillment Shopify ejecutado: ${successCount} OK, ${failCount} error. ${pedidosSinEmail.length} sin email requieren WhatsApp`);

    res.json({
      success: true,
      count: resultados.length,
      successCount,
      failCount,
      data: resultados,
      pedidosSinEmail // Frontend abrirá WhatsApp solo para estos
    });
  } catch (error) {
    logService.error('Error en fulfillment Shopify', error);
    res.status(500).json({ success: false, error: error.message });
  }
}

// Ejecutar fulfillment en Shopify para pedidos con etiqueta generada
app.post('/api/fulfillment-shopify', handleFulfillmentShopify);

// Alias legacy con typo historico (.NET): fullfilment
app.post('/api/fullfilment-shopify', handleFulfillmentShopify);

// Generar link de WhatsApp con tracking (simplificado - no envía por API)
app.post('/api/generar-link-whatsapp', async (req, res) => {
  try {
    const { pedido, trackingTemplate } = req.body;
    const telefono = pedido?.cliente_telefono || pedido?.telefono || '';
    
    if (!pedido || !telefono) {
      return res.status(400).json({ error: 'Datos de pedido incompletos o sin teléfono' });
    }

    const resultado = generarLinkWhatsApp({
      ...pedido,
      telefono,
    }, trackingTemplate);
    
    if (resultado.success) {
      res.json({ success: true, url: resultado.url, phone: resultado.phone });
    } else {
      res.status(500).json({ success: false, error: resultado.error });
    }
  } catch (error) {
    logService.error('Error al generar link de WhatsApp', error);
    res.status(500).json({ error: error.message });
  }
});

// Descartar etiqueta generada para volver a validacion manual
app.post('/api/descartar-etiqueta/:pedidoId', async (req, res) => {
  try {
    const { pedidoId } = req.params;

    const pedido = await supabaseService.obtenerPedido(pedidoId);
    if (!pedido) {
      return res.status(404).json({ success: false, error: 'Pedido no encontrado' });
    }

    if (!pedido.etiqueta_generada) {
      return res.status(400).json({ success: false, error: 'El pedido no tiene una etiqueta generada para descartar' });
    }

    if (pedido.notificacion_enviada_at || String(pedido.estado || '').toLowerCase() === 'enviado') {
      return res.status(400).json({ success: false, error: 'No se puede descartar una etiqueta de un pedido ya notificado o enviado' });
    }

    const actualizado = await supabaseService.actualizarPedido(pedidoId, {
      estado: 'pendiente',
      etiqueta_generada: false,
      numero_seguimiento_ues: null,
      link_etiqueta_drive: null,
    });

    logService.info(`Etiqueta descartada para pedido ${pedidoId}`, {
      numero_pedido: pedido.numero_pedido,
      tracking_anterior: pedido.numero_seguimiento_ues || null,
    });

    res.json({
      success: true,
      pedido: actualizado,
      message: `Pedido #${pedido.numero_pedido || pedidoId} devuelto a validacion`,
    });
  } catch (error) {
    logService.error('Error al descartar etiqueta', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Marcar pedido como notificado (para envios manuales de WhatsApp)
app.post('/api/marcar-notificado/:pedidoId', async (req, res) => {
  try {
    const { pedidoId } = req.params;

    const pedido = await supabaseService.obtenerPedido(pedidoId);
    if (!pedido) {
      return res.status(404).json({ success: false, error: 'Pedido no encontrado' });
    }

    await supabaseService.actualizarPedido(pedidoId, {
      notificacion_enviada_at: new Date().toISOString(),
      estado: 'enviado',
    });

    logService.info(`Pedido ${pedidoId} marcado como notificado y enviado (WhatsApp manual)`);

    // Agregar tag DESPACHADO en Shopify (best-effort)
    if (pedido.shopify_order_id) {
      shopifyService.agregarTagAOrden(pedido.shopify_order_id, 'DESPACHADO').catch((e) =>
        logService.warning(`No se pudo agregar tag DESPACHADO a orden ${pedido.shopify_order_id}: ${e.message}`)
      );
    }

    res.json({
      success: true,
      pedidoId,
      notificacion_enviada_at: new Date().toISOString(),
    });
  } catch (error) {
    logService.error('Error al marcar pedido como notificado', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Marcar etiqueta como impresa
app.post('/api/marcar-impresa/:pedidoId', async (req, res) => {
  try {
    const { pedidoId } = req.params;
    await supabaseService.actualizarPedido(pedidoId, { etiqueta_impresa: true });
    logService.info(`Etiqueta marcada como impresa para pedido ${pedidoId}`);
    res.json({ success: true, pedidoId });
  } catch (error) {
    logService.error('Error al marcar etiqueta como impresa', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Panel de follow-up: pedidos a contactar segun dias transcurridos
app.get('/api/followup/pedidos', async (req, res) => {
  try {
    const days = Math.max(parseInt(req.query.days || '15', 10) || 15, 1);
    const from = String(req.query.from || '').trim();
    const to = String(req.query.to || '').trim();
    const estado = String(req.query.estado || '').trim().toLowerCase();
    const pedido = String(req.query.pedido || '').trim();

    const fromDate = from ? new Date(`${from}T00:00:00`) : null;
    const toDate = to ? new Date(`${to}T23:59:59`) : null;

    const pedidos = pedido
      ? await supabaseService.buscarPedidosPorNumero(pedido)
      : await supabaseService.obtenerPedidosParaFollowUp(estado);
    const ahora = new Date();

    const enrich = pedidos.map((pedido) => {
      const baseDate = new Date(pedido.notificacion_enviada_at || pedido.created_at);
      const followUpDate = new Date(baseDate);
      followUpDate.setDate(followUpDate.getDate() + days);

      const diasTranscurridos = Math.floor((ahora - baseDate) / (1000 * 60 * 60 * 24));
      const customerId = supabaseService.buildCustomerKey(pedido);

      return {
        ...pedido,
        customer_id: customerId,
        followup_base_date: baseDate.toISOString(),
        followup_target_date: followUpDate.toISOString(),
        followup_days_elapsed: diasTranscurridos,
      };
    });

    const filtrados = pedido
      ? enrich
      : enrich.filter((pedido) => {
          const fechaObjetivo = new Date(pedido.followup_target_date);
          if (fromDate && fechaObjetivo < fromDate) return false;
          if (toDate && fechaObjetivo > toDate) return false;
          return true;
        });

    const customerIds = filtrados.map((p) => p.customer_id);
    const statesByCustomer = await supabaseService.obtenerEstadosClientes(customerIds);

    const withState = filtrados.map((pedido) => {
      const persistedState = statesByCustomer[pedido.customer_id]?.state;
      return {
        ...pedido,
        customer_state: persistedState || 'neutral',
      };
    });

    res.json({
      success: true,
      days,
      estado: estado || null,
      pedido: pedido || null,
      prioritizedByPedido: Boolean(pedido),
      count: withState.length,
      data: withState,
    });
  } catch (error) {
    logService.error('Error en follow-up diario', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

const VALID_CUSTOMER_STATES = new Set(['happy', 'neutral', 'issue', 'repeat']);

app.patch('/api/customers/:customerId/state', async (req, res) => {
  try {
    const customerId = String(req.params.customerId || '').trim();
    const state = String(req.body?.state || '').trim().toLowerCase();

    if (!customerId) {
      return res.status(400).json({ success: false, error: 'customerId requerido' });
    }
    if (!VALID_CUSTOMER_STATES.has(state)) {
      return res.status(400).json({ success: false, error: 'Estado invalido' });
    }

    const saved = await supabaseService.guardarEstadoCliente(customerId, state);
    return res.json({ success: true, data: saved });
  } catch (error) {
    logService.error('Error guardando estado de cliente', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/customers/:customerId/notes', async (req, res) => {
  try {
    const customerId = String(req.params.customerId || '').trim();
    if (!customerId) {
      return res.status(400).json({ success: false, error: 'customerId requerido' });
    }

    const notes = await supabaseService.obtenerNotasCliente(customerId);
    return res.json({ success: true, count: notes.length, data: notes });
  } catch (error) {
    logService.error('Error obteniendo notas de cliente', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/customers/:customerId/notes', async (req, res) => {
  try {
    const customerId = String(req.params.customerId || '').trim();
    const content = String(req.body?.content || '').trim();

    if (!customerId) {
      return res.status(400).json({ success: false, error: 'customerId requerido' });
    }
    if (!content) {
      return res.status(400).json({ success: false, error: 'Contenido requerido' });
    }

    const note = await supabaseService.agregarNotaCliente(customerId, content);
    return res.status(201).json({ success: true, data: note });
  } catch (error) {
    logService.error('Error agregando nota de cliente', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// Generar etiqueta UES (con ID en URL para React)
app.post('/api/generar-etiqueta/:pedidoId', async (req, res) => {
  try {
    const { pedidoId } = req.params;
    const { payloadOverrides } = req.body || {};

    const tipoEntrega = String(payloadOverrides?.tipoEntrega || 'domicilio').toLowerCase();
    const isPickup = tipoEntrega === 'pickup';
    const puntoRetiroId = isPickup ? String(payloadOverrides?.puntoRetiroId || '').trim() : null;
    const puntoRetiroNombre = isPickup ? String(payloadOverrides?.puntoRetiroNombre || '').trim() : null;

    logService.info('🧾 /api/generar-etiqueta/:pedidoId request', {
      pedidoId,
      tipoEntrega,
      puntoRetiroId,
      observacionesOverride: payloadOverrides?.payloadDireccion?.observaciones || '',
      referenciaOverride: payloadOverrides?.payloadEnvio?.referencia || '',
      comentarioOverride: payloadOverrides?.guia?.comentario || '',
    });
    
    if (!pedidoId) {
      return res.status(400).json({ success: false, error: 'ID de pedido requerido' });
    }

    const pedido = await supabaseService.obtenerPedido(pedidoId);
    
    if (!pedido) {
      return res.status(404).json({ success: false, error: 'Pedido no encontrado' });
    }

    logService.info(`Generando etiqueta para pedido ${pedidoId}`);

    // Generar etiqueta en UES
    const etiqueta = await uesService.generarEtiqueta(pedido, payloadOverrides || null);

    const updateBase = {
      estado: 'pendiente',
      numero_seguimiento_ues: etiqueta.numeroSeguimiento,
      link_etiqueta_drive: etiqueta.urlPdf,
      etiqueta_generada: true,
      etiqueta_impresa: false,
    };

    // Persistir tipo de entrega elegido (domicilio/pickup) y punto de retiro si aplica.
    const updateExtended = {
      ...updateBase,
      tipo_entrega_ues: isPickup ? 'pickup' : 'domicilio',
      punto_retiro_ues_id: isPickup ? puntoRetiroId : null,
      punto_retiro_ues_nombre: isPickup ? puntoRetiroNombre : null,
    };

    try {
      await supabaseService.actualizarPedido(pedidoId, updateExtended);
    } catch (updateError) {
      const msg = String(updateError?.message || '').toLowerCase();
      const missingColumn = msg.includes('column') && msg.includes('does not exist');

      if (!missingColumn) throw updateError;

      logService.warning('Columnas pickup aún no disponibles en pedidos; guardando sin metadata pickup', {
        pedidoId,
        error: updateError.message,
      });
      await supabaseService.actualizarPedido(pedidoId, updateBase);
    }

    const pdfMissingWarning = !etiqueta.urlPdf
      ? 'UES generó la etiqueta pero no devolvió el PDF en este momento'
      : null;

    logService.info(`Etiqueta generada exitosamente para pedido ${pedidoId}: ${etiqueta.numeroSeguimiento}`);
    logService.info('🧾 Resultado generación etiqueta', {
      pedidoId,
      tracking: etiqueta.numeroSeguimiento,
      pdfUrl: etiqueta.urlPdf,
      traceId: etiqueta.traceId || null,
    });
    if (pdfMissingWarning) {
      logService.warning('Etiqueta generada sin PDF disponible', {
        pedidoId,
        tracking: etiqueta.numeroSeguimiento,
        traceId: etiqueta.traceId || null,
      });
    }
    
    // Respuesta en formato que React espera
    res.json({ 
      success: true, 
      pedidoId,
      tracking: etiqueta.numeroSeguimiento,
      pdfUrl: etiqueta.urlPdf,
      tipoEntrega: isPickup ? 'pickup' : 'domicilio',
      puntoRetiroId: isPickup ? puntoRetiroId : null,
      warning: pdfMissingWarning,
      traceId: etiqueta.traceId || null,
    });
  } catch (error) {
    // Distinguir entre errores de validación (datos incorrectos) y errores del sistema
    if (error.isValidationError) {
      logService.warning('Error de validación al generar etiqueta', { 
        error: error.message,
        field: error.field,
        value: error.originalValue,
        pedidoId 
      });
      return res.status(400).json({ 
        success: false, 
        error: error.message,
        field: error.field,
        value: error.originalValue,
        type: 'validation'
      });
    }
    
    // Error del sistema (500)
    logService.error('Error al generar etiqueta', { 
      error: error.message,
      stack: error.stack 
    });
    res.status(500).json({ 
      success: false, 
      error: error.message,
      details: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

app.post('/api/etiquetas/consolidar/:pedidoId', async (req, res) => {
  try {
    const { pedidoId } = req.params;
    const {
      sourcePedidoId = null,
      tracking = null,
      pdfUrl = null,
      tipoEntrega = 'domicilio',
      puntoRetiroId = null,
      puntoRetiroNombre = null,
    } = req.body || {};

    if (!pedidoId) {
      return res.status(400).json({ success: false, error: 'ID de pedido requerido' });
    }

    const pedido = await supabaseService.obtenerPedido(pedidoId);
    if (!pedido) {
      return res.status(404).json({ success: false, error: 'Pedido no encontrado' });
    }

    const sourcePedido = sourcePedidoId
      ? await supabaseService.obtenerPedido(sourcePedidoId)
      : null;

    const trackingFinal = String(
      tracking
      || sourcePedido?.numero_seguimiento_ues
      || ''
    ).trim();

    if (!trackingFinal) {
      return res.status(400).json({ success: false, error: 'tracking requerido para consolidar' });
    }

    const pdfUrlFinal = String(
      pdfUrl
      || sourcePedido?.link_etiqueta_drive
      || ''
    ).trim() || null;

    const isPickup = String(tipoEntrega || 'domicilio').toLowerCase() === 'pickup';
    const updateBase = {
      estado: 'pendiente',
      numero_seguimiento_ues: trackingFinal,
      link_etiqueta_drive: pdfUrlFinal,
      etiqueta_generada: true,
      etiqueta_impresa: false,
    };

    const updateExtended = {
      ...updateBase,
      tipo_entrega_ues: isPickup ? 'pickup' : 'domicilio',
      punto_retiro_ues_id: isPickup ? String(puntoRetiroId || '').trim() || null : null,
      punto_retiro_ues_nombre: isPickup ? String(puntoRetiroNombre || '').trim() || null : null,
    };

    try {
      await supabaseService.actualizarPedido(pedidoId, updateExtended);
    } catch (updateError) {
      const msg = String(updateError?.message || '').toLowerCase();
      const missingColumn = msg.includes('column') && msg.includes('does not exist');
      if (!missingColumn) throw updateError;
      await supabaseService.actualizarPedido(pedidoId, updateBase);
    }

    logService.info('Etiqueta consolidada aplicada a pedido', {
      pedidoId,
      sourcePedidoId,
      tracking: updateBase.numero_seguimiento_ues,
      pdfUrl: updateBase.link_etiqueta_drive,
      tipoEntrega: isPickup ? 'pickup' : 'domicilio',
    });

    return res.json({
      success: true,
      pedidoId,
      sourcePedidoId,
      tracking: updateBase.numero_seguimiento_ues,
      pdfUrl: updateBase.link_etiqueta_drive,
    });
  } catch (error) {
    logService.error('Error consolidando etiqueta en pedido', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// Generar etiqueta UES (ruta legacy con body)
app.post('/api/generar-etiqueta', async (req, res) => {
  try {
    const { pedidoId, payloadOverrides } = req.body || {};
    
    if (!pedidoId) {
      return res.status(400).json({ success: false, error: 'ID de pedido requerido' });
    }

    const pedido = await supabaseService.obtenerPedido(pedidoId);
    
    if (!pedido) {
      return res.status(404).json({ success: false, error: 'Pedido no encontrado' });
    }

    logService.info(`Generando etiqueta para pedido ${pedidoId}`);

    // Generar etiqueta en UES
    const etiqueta = await uesService.generarEtiqueta(pedido, payloadOverrides || null);
    
    // Actualizar pedido en Supabase
    await supabaseService.actualizarPedido(pedidoId, {
      estado: 'pendiente',
      numero_seguimiento_ues: etiqueta.numeroSeguimiento,
      link_etiqueta_drive: etiqueta.urlPdf,
      etiqueta_generada: true,
      etiqueta_impresa: false
    });

    logService.info(`Etiqueta generada exitosamente para pedido ${pedidoId}: ${etiqueta.numeroSeguimiento}`);
    res.json({ success: true, data: etiqueta });
  } catch (error) {
    // Distinguir entre errores de validación (datos incorrectos) y errores del sistema
    if (error.isValidationError) {
      logService.warning('Error de validación al generar etiqueta', { 
        error: error.message,
        field: error.field,
        value: error.originalValue,
        pedidoId: req.body?.pedidoId 
      });
      return res.status(400).json({ 
        success: false, 
        error: error.message,
        field: error.field,
        value: error.originalValue,
        type: 'validation'
      });
    }
    
    // Error del sistema (500)
    logService.error('Error al generar etiqueta', { 
      error: error.message,
      stack: error.stack 
    });
    res.status(500).json({ 
      success: false, 
      error: error.message,
      details: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

// Generar múltiples etiquetas
app.post('/api/generar-etiquetas-masivo', async (req, res) => {
  try {
    const { pedidoIds } = req.body;
    const resultados = [];
    
    for (const pedidoId of pedidoIds) {
      try {
        const pedido = await supabaseService.obtenerPedido(pedidoId);
        const etiqueta = await uesService.generarEtiqueta(pedido);
        
        await supabaseService.actualizarPedido(pedidoId, {
          estado: 'pendiente',
          numero_seguimiento_ues: etiqueta.numeroSeguimiento,
          link_etiqueta_drive: etiqueta.urlPdf,
          etiqueta_generada: true,
          etiqueta_impresa: false
        });
        
        resultados.push({ pedidoId, success: true, etiqueta });
      } catch (error) {
        // Incluir más información si es un error de validación
        const errorInfo = {
          pedidoId, 
          success: false, 
          error: error.message
        };
        
        if (error.isValidationError) {
          errorInfo.errorType = 'validation';
          errorInfo.field = error.field;
          errorInfo.value = error.originalValue;
          logService.warning(`Error de validación en pedido ${pedidoId}`, { field: error.field, value: error.originalValue });
        } else {
          logService.error(`Error en pedido ${pedidoId}`, error);
        }
        
        resultados.push(errorInfo);
      }
    }
    
    logService.info(`Procesados ${resultados.length} pedidos en modo masivo`);
    res.json({ success: true, data: resultados });
  } catch (error) {
    logService.error('Error en generación masiva', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Combinar múltiples etiquetas PDF en un único archivo
app.post('/api/ues/combinar-pdfs', async (req, res) => {
  try {
    const { pdfUrls } = req.body || {};

    if (!Array.isArray(pdfUrls) || pdfUrls.length === 0) {
      return res.status(400).json({ success: false, error: 'pdfUrls debe ser un array con al menos una URL' });
    }

    const urlsValidas = pdfUrls.filter((url) => typeof url === 'string' && url.trim());
    if (urlsValidas.length === 0) {
      return res.status(400).json({ success: false, error: 'No hay URLs de PDF válidas para combinar' });
    }

    const { PDFDocument } = require('pdf-lib');
    const mergedPdf = await PDFDocument.create();

    for (const url of urlsValidas) {
      const response = await axios.get(url, { responseType: 'arraybuffer', timeout: 30000 });
      const sourcePdf = await PDFDocument.load(response.data);
      const pageIndices = sourcePdf.getPageIndices();
      const copiedPages = await mergedPdf.copyPages(sourcePdf, pageIndices);
      copiedPages.forEach((page) => mergedPdf.addPage(page));
    }

    const mergedBytes = await mergedPdf.save();
    const generatedDir = path.join(__dirname, 'public', 'generated');
    await fs.mkdir(generatedDir, { recursive: true });

    const fileName = `etiquetas-combinadas-${Date.now()}.pdf`;
    const filePath = path.join(generatedDir, fileName);
    await fs.writeFile(filePath, Buffer.from(mergedBytes));

    return res.json({
      success: true,
      pdfUrl: `/generated/${fileName}`,
      count: urlsValidas.length,
    });
  } catch (error) {
    logService.error('Error combinando PDFs de etiquetas', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

const COLAB_SEQ_PATH = path.join(__dirname, 'data', 'colaboraciones-seq.json');

async function getNextColReference() {
  await fs.mkdir(path.dirname(COLAB_SEQ_PATH), { recursive: true });

  let current = 0;
  try {
    const raw = await fs.readFile(COLAB_SEQ_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    current = Number(parsed?.next || 0);
  } catch (error) {
    current = 0;
  }

  const next = current + 1;
  await fs.writeFile(
    COLAB_SEQ_PATH,
    JSON.stringify({ next }, null, 2),
    'utf8'
  );

  return `COL${current}`;
}

// Generar etiqueta para reclamo asociado a pedido existente
app.post('/api/reclamos/:pedidoId/generar-etiqueta', async (req, res) => {
  try {
    const { pedidoId } = req.params;
    const { notas = '', payloadOverrides = null } = req.body || {};

    logService.info('🔄 Generando etiqueta RCL - Datos recibidos:', {
      pedidoId,
      notas,
      tieneOverrides: !!payloadOverrides,
      overrides: payloadOverrides
    });

    const pedido = await supabaseService.obtenerPedido(pedidoId);
    if (!pedido) {
      return res.status(404).json({ success: false, error: 'Pedido no encontrado' });
    }

    const referencia = `RCL${pedido.numero_pedido || pedido.id}`;
    
    // Combinar overrides del usuario (datos editados) con los defaults del reclamo
    const defaultOverrides = {
      payloadEnvio: { referencia },
      guia: { comentario: '' },
      payloadDireccion: {
        observaciones: notas || '',
      },
    };

    // Si el usuario editó datos, combinar con los defaults
    const finalOverrides = payloadOverrides ? {
      payloadDireccion: {
        ...payloadOverrides.payloadDireccion,
        // Asegurar que las observaciones incluyen las notas originales + las del reclamo
        observaciones: payloadOverrides.payloadDireccion?.observaciones || defaultOverrides.payloadDireccion.observaciones
      },
      payloadEnvio: {
        ...payloadOverrides.payloadEnvio,
        referencia
      },
      guia: {
        ...payloadOverrides.guia,
        comentario: payloadOverrides.guia?.comentario || ''
      }
    } : defaultOverrides;

    logService.info('🔄 Overrides finales construidos para RCL:', finalOverrides);
    logService.info('🧾 RCL observaciones/ref/comentario finales', {
      pedidoId,
      observacionesFinal: finalOverrides?.payloadDireccion?.observaciones || '',
      referenciaFinal: finalOverrides?.payloadEnvio?.referencia || '',
      comentarioFinal: finalOverrides?.guia?.comentario || '',
    });

    const etiqueta = await uesService.generarEtiqueta(pedido, finalOverrides);

    logService.info(`Etiqueta de reclamo generada para pedido ${pedidoId}: ${referencia}`);

    // Persistir datos del reclamo en el pedido original
    try {
      await supabaseService.actualizarPedido(pedidoId, {
        es_reclamo: true,
        etiqueta_generada: true,
        numero_seguimiento_ues: etiqueta.numeroSeguimiento || null,
        link_etiqueta_drive: etiqueta.urlPdf || null,
        notificacion_enviada_at: null,
      });
      logService.info(`Reclamo ${referencia} persistido en pedido ${pedidoId}`);
    } catch (dbError) {
      logService.warning('No se pudo persistir el reclamo en DB (etiqueta generada igual)', {
        error: dbError.message,
        referencia,
        pedidoId,
      });
    }

    res.json({
      success: true,
      tipo: 'reclamo',
      pedidoId,
      referencia,
      tracking: etiqueta.numeroSeguimiento,
      pdfUrl: etiqueta.urlPdf,
      traceId: etiqueta.traceId || null,
    });
  } catch (error) {
    // Distinguir entre errores de validación (datos incorrectos) y errores del sistema
    if (error.isValidationError) {
      logService.warning('Error de validación al generar etiqueta de reclamo', { 
        error: error.message,
        field: error.field,
        value: error.originalValue,
        pedidoId: req.params?.pedidoId 
      });
      return res.status(400).json({ 
        success: false, 
        error: error.message,
        field: error.field,
        value: error.originalValue,
        type: 'validation'
      });
    }
    
    // Error del sistema (500)
    logService.error('Error al generar etiqueta de reclamo', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Obtener reclamos pendientes de notificación
app.get('/api/reclamos-pendientes', async (req, res) => {
  try {
    const reclamos = await supabaseService.obtenerReclamosPendientes();
    logService.info(`Reclamos pendientes devueltos: ${reclamos.length}`);
    res.json({ success: true, data: reclamos });
  } catch (error) {
    logService.error('Error al obtener reclamos pendientes', error);
    res.status(500).json({ success: false, data: [], error: error.message });
  }
});

// Obtener pedidos ya procesados/enviados
app.get('/api/pedidos-enviados', async (req, res) => {
  try {
    const pedidos = await supabaseService.obtenerPedidosEnviados();
    res.json({ success: true, data: pedidos });
  } catch (error) {
    logService.error('Error al obtener pedidos enviados', error);
    res.status(500).json({ success: false, data: [], error: error.message });
  }
});

// Generar etiqueta para colaboracion (sin pedido Shopify)
app.post('/api/colaboraciones/generar-etiqueta', async (req, res) => {
  try {
    const {
      cliente_nombre,
      cliente_email = '',
      cliente_telefono = '',
      direccion_envio,
      localidad,
      departamento,
      codigo_postal = '',
      notas = '',
    } = req.body || {};

    if (!cliente_nombre || !direccion_envio || !localidad || !departamento) {
      return res.status(400).json({
        success: false,
        error: 'Faltan campos requeridos: cliente_nombre, direccion_envio, localidad, departamento',
      });
    }

    const referencia = await getNextColReference();

    const pedidoColaboracion = {
      id: referencia,
      numero_pedido: referencia,
      cliente_nombre,
      cliente_email,
      cliente_telefono,
      direccion_envio,
      localidad,
      departamento,
      codigo_postal,
      notas,
    };

    const payloadOverrides = {
      payloadEnvio: { referencia },
      guia: { comentario: referencia },
    };

    const etiqueta = await uesService.generarEtiqueta(pedidoColaboracion, payloadOverrides);

    logService.info(`Etiqueta de colaboracion generada: ${referencia}`);

    res.json({
      success: true,
      tipo: 'colaboracion',
      referencia,
      tracking: etiqueta.numeroSeguimiento,
      pdfUrl: etiqueta.urlPdf,
    });
  } catch (error) {
    // Distinguir entre errores de validación (datos incorrectos) y errores del sistema
    if (error.isValidationError) {
      logService.warning('Error de validación al generar etiqueta de colaboración', { 
        error: error.message,
        field: error.field,
        value: error.originalValue
      });
      return res.status(400).json({ 
        success: false, 
        error: error.message,
        field: error.field,
        value: error.originalValue,
        type: 'validation'
      });
    }
    
    // Error del sistema (500)
    logService.error('Error al generar etiqueta de colaboracion', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Descargar etiqueta
app.get('/api/descargar-etiqueta/:pedidoId', async (req, res) => {
  try {
    const { pedidoId } = req.params;
    const pedido = await supabaseService.obtenerPedido(pedidoId);
    
    if (!pedido || !pedido.url_etiqueta) {
      return res.status(404).json({ success: false, error: 'Etiqueta no encontrada' });
    }

    const pdfBuffer = await uesService.descargarEtiqueta(pedido.url_etiqueta);
    
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="etiqueta_${pedidoId}.pdf"`);
    res.send(pdfBuffer);
  } catch (error) {
    logService.error('Error al descargar etiqueta', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Geocodificar pedido individual con Google Maps y guardar resultados
// Geocodificar dirección del pedido con Google Maps y resolver localidad UES
app.post('/api/pedidos/:pedidoId/geocodificar', async (req, res) => {
  try {
    const googleMapsService = require('./services/googleMapsService');
    const pedido = await supabaseService.obtenerPedido(req.params.pedidoId);
    if (!pedido) {
      return res.status(404).json({ success: false, error: 'Pedido no encontrado' });
    }

    // El frontend puede enviar el departamento_id ya seleccionado en el form
    const departamentoIdOverride = req.body?.departamento_id ? String(req.body.departamento_id) : null;
    const departamentoNombre = pedido.departamento || pedido.direccion_departamento;

    let geoResult;

    // Prioridad 1: reverse geocoding con lat/lng guardados en la BD (más preciso para barrios)
    if (pedido.latitud && pedido.longitud) {
      console.log(`🌍 [geocodificar] Pedido ${pedido.id} | reverse geocoding lat: ${pedido.latitud}, lng: ${pedido.longitud}`);
      geoResult = await googleMapsService.reverseGeocodeAsync(pedido.latitud, pedido.longitud);
    }

    // Prioridad 2: geocoding por dirección si no hay coordenadas o falló el reverse
    if (!geoResult?.exitoso) {
      const direccion = pedido.direccion_envio || pedido.direccion_calle || '';
      const ciudad = pedido.direccion_ciudad || departamentoNombre || 'Montevideo';

      if (!direccion) {
        return res.json({ success: false, error: 'El pedido no tiene dirección ni coordenadas' });
      }

      console.log(`🌍 [geocodificar] Pedido ${pedido.id} | geocoding por dirección: "${direccion}, ${ciudad}"`);
      geoResult = await googleMapsService.geocodeAsync(direccion, ciudad, 'Uruguay');
    }

    console.log(`🌍 [geocodificar] Google Maps resultado:`, {
      exitoso: geoResult.exitoso,
      barrio: geoResult.barrio,
      localidad: geoResult.localidad,
      departamento: geoResult.departamento,
      direccionFormateada: geoResult.direccionFormateada,
    });

    if (!geoResult.exitoso) {
      return res.json({ success: false, error: 'Google Maps no pudo obtener la ubicación' });
    }

    const localidadParaBuscar = geoResult.barrio || geoResult.localidad;
    if (!localidadParaBuscar) {
      return res.json({
        success: false,
        error: 'Google Maps no retornó barrio ni localidad para esta dirección',
        google: { barrio: geoResult.barrio, localidad: geoResult.localidad, direccionFormateada: geoResult.direccionFormateada },
      });
    }

    console.log(`🔎 [geocodificar] Buscando en UES | localidad: "${localidadParaBuscar}" | departamento_id: ${departamentoIdOverride || '(por nombre: ' + departamentoNombre + ')'}`);

    const localidadUes = await supabaseService.buscarLocalidadUesPorId(
      localidadParaBuscar,
      departamentoIdOverride || departamentoNombre
    );

    console.log(`✅ [geocodificar] Localidad UES encontrada:`, localidadUes);

    res.json({
      success: true,
      data: {
        ues_id: localidadUes.ues_id,
        departamento_id: localidadUes.departamento_id,
        nombre: localidadUes.nombre,
        barrioGoogleMaps: geoResult.barrio,
        localidadGoogleMaps: geoResult.localidad,
        direccionFormateada: geoResult.direccionFormateada,
      },
    });
  } catch (error) {
    logService.error('Error al geocodificar pedido', error);
    const isValidation = error.isValidationError || error.name === 'ValidationError';
    res.status(isValidation ? 400 : 500).json({ success: false, error: error.message });
  }
});

// Validar dirección con Google Maps
app.post('/api/validar-direccion', async (req, res) => {
  try {
    const { direccion } = req.body;
    const axios = require('axios');
    
    const response = await axios.get('https://maps.googleapis.com/maps/api/geocode/json', {
      params: {
        address: direccion,
        key: process.env.GOOGLE_MAPS_API_KEY
      }
    });
    
    res.json({ success: true, data: response.data });
  } catch (error) {
    logService.error('Error al validar dirección', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Obtener estadísticas
app.get('/api/estadisticas', async (req, res) => {
  try {
    const stats = await supabaseService.obtenerEstadisticas();
    res.json({ success: true, data: stats });
  } catch (error) {
    logService.error('Error al obtener estadísticas', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== RUTAS DE PLANTILLAS ====================

// Obtener todas las plantillas
app.get('/api/templates', async (req, res) => {
  try {
    const plantillas = await supabaseService.obtenerPlantillas();
    res.json({ success: true, data: plantillas });
  } catch (error) {
    logService.error('Error al obtener plantillas', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Crear una nueva plantilla
app.post('/api/templates', async (req, res) => {
  try {
    const { name, content, is_active } = req.body;

    if (!name || !content) {
      return res.status(400).json({ 
        success: false, 
        error: 'Nombre y contenido son requeridos' 
      });
    }

    const plantilla = await supabaseService.crearPlantilla({
      name,
      content,
      is_active: is_active || false
    });

    logService.info(`Plantilla creada: ${name}`);
    res.status(201).json({ success: true, data: plantilla });
  } catch (error) {
    logService.error('Error al crear plantilla', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Actualizar una plantilla existente
app.put('/api/templates/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const cambios = req.body;

    if (!id) {
      return res.status(400).json({ 
        success: false, 
        error: 'ID de plantilla requerido' 
      });
    }

    const plantilla = await supabaseService.actualizarPlantilla(id, cambios);
    
    logService.info(`Plantilla actualizada: ${id}`);
    res.json({ success: true, data: plantilla });
  } catch (error) {
    logService.error('Error al actualizar plantilla', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Eliminar una plantilla
app.delete('/api/templates/:id', async (req, res) => {
  try {
    const { id } = req.params;

    if (!id) {
      return res.status(400).json({ 
        success: false, 
        error: 'ID de plantilla requerido' 
      });
    }

    await supabaseService.eliminarPlantilla(id);
    
    logService.info(`Plantilla eliminada: ${id}`);
    res.json({ success: true, message: 'Plantilla eliminada' });
  } catch (error) {
    logService.error('Error al eliminar plantilla', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Establecer plantilla activa
app.post('/api/templates/:id/activate', async (req, res) => {
  try {
    const { id } = req.params;

    if (!id) {
      return res.status(400).json({ 
        success: false, 
        error: 'ID de plantilla requerido' 
      });
    }

    const plantilla = await supabaseService.establecerPlantillaActiva(id);
    
    logService.info(`Plantilla activada: ${plantilla.name}`);
    res.json({ success: true, data: plantilla });
  } catch (error) {
    logService.error('Error al activar plantilla', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Inicializar plantillas por defecto (se llama automáticamente en el arranque)
app.post('/api/templates/initialize', async (req, res) => {
  try {
    await supabaseService.inicializarPlantillasDefecto();
    const plantillas = await supabaseService.obtenerPlantillas();
    
    res.json({ 
      success: true, 
      message: 'Plantillas inicializadas',
      data: plantillas 
    });
  } catch (error) {
    logService.error('Error al inicializar plantillas', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Iniciar servidor
app.listen(PORT, async () => {
  console.log(`🚀 VELINNE Server corriendo en http://localhost:${PORT}`);
  logService.info(`Servidor iniciado en puerto ${PORT}`);
  
  // Inicializar plantillas por defecto al arrancar el servidor
  supabaseService.inicializarPlantillasDefecto().catch(err => {
    logService.error('Error al inicializar plantillas por defecto', err);
  });

  // Regenerar caché de UES en background (NO bloquea startup)
  console.log('🔄 Iniciando regeneración de caché UES en background...');
  
  // Ejecutar en background sin await
  (async () => {
    try {
      await uesService.autenticarManual();
      const contexto = await uesService.obtenerContextoUES();
      
      await fs.writeFile(
        path.join(__dirname, 'ues_getContext.json'),
        JSON.stringify(contexto, null, 2)
      );
      
      const cantDepts = contexto.departamentos_localidades?.length || 0;
      console.log(`✅ Caché UES regenerado: ${cantDepts} departamentos`);
      logService.info('Caché de UES actualizado exitosamente', { departamentos: cantDepts });
      
      // Actualizar estado global
      uesCacheStatus = {
        ready: true,
        lastUpdate: new Date().toISOString(),
        error: null,
        departamentos: cantDepts
      };
    } catch (error) {
      console.log('⚠️ No se pudo regenerar caché UES:', error.message);
      logService.warning('No se pudo actualizar caché UES en background', { error: error.message });
      
      // Actualizar estado global con error
      uesCacheStatus = {
        ready: false,
        lastUpdate: new Date().toISOString(),
        error: error.message,
        departamentos: 0
      };
    }
  })().catch(err => {
    logService.error('Error no capturado en regeneración de caché UES', err);
  });
});

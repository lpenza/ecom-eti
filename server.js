const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs').promises;
const axios = require('axios');
const { google } = require('googleapis');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const JWT_SECRET = process.env.JWT_SECRET || 'velinne-jwt-secret-2024';
const JWT_EXPIRES_IN = '8h';

// ── Google Drive helper (Service Account) ───────────────────────────────────
function buildDriveClient() {
  const saKey = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!saKey) return null;
  try {
    const credentials = JSON.parse(saKey);
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/drive.readonly'],
    });
    return google.drive({ version: 'v3', auth });
  } catch (e) {
    console.error('[Drive] Error parseando GOOGLE_SERVICE_ACCOUNT_KEY:', e.message);
    return null;
  }
}
const driveClient = buildDriveClient();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(bodyParser.json({ charset: 'utf-8' }));
app.use(express.static('public'));
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, 'dist')));
}

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

// ── Auth Middleware ──────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, error: 'No autorizado' });
  }
  const token = authHeader.slice(7);
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload;
    next();
  } catch {
    return res.status(401).json({ success: false, error: 'Token inválido o expirado' });
  }
}

function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ success: false, error: 'Requiere rol administrador' });
  }
  next();
}

// ── Login endpoint ───────────────────────────────────────────────────────────
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ success: false, error: 'Email y contraseña requeridos' });
    }

    const user = await supabaseService.buscarUsuarioPorEmail(email);
    if (!user) {
      return res.status(401).json({ success: false, error: 'Credenciales inválidas' });
    }

    const passwordOk = await bcrypt.compare(password, user.password_hash);
    if (!passwordOk) {
      return res.status(401).json({ success: false, error: 'Credenciales inválidas' });
    }

    const token = jwt.sign(
      { id: user.id, email: user.email, nombre: user.nombre, role: user.role },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN }
    );

    logService.info(`Login exitoso: ${user.email} (${user.role})`);
    res.json({ success: true, token, user: { id: user.id, email: user.email, nombre: user.nombre, role: user.role } });
  } catch (err) {
    logService.error('Error en login', err);
    res.status(500).json({ success: false, error: 'Error interno' });
  }
});

// Verificar token activo
app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ success: true, user: req.user });
});

// ── Endpoints Admin ──────────────────────────────────────────────────────────

// Listar usuarios con su monto_por_pedido
app.get('/api/admin/usuarios', requireAuth, requireAdmin, async (req, res) => {
  try {
    const usuarios = await supabaseService.listarUsuarios();
    res.json({ success: true, usuarios });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Crear nuevo usuario
app.post('/api/admin/usuarios', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { email, nombre, password, role } = req.body;
    if (!email || !nombre || !password || !role) {
      return res.status(400).json({ success: false, error: 'email, nombre, contraseña y rol son requeridos' });
    }
    if (!['admin', 'user'].includes(role)) {
      return res.status(400).json({ success: false, error: 'Rol inválido' });
    }
    const passwordHash = await bcrypt.hash(password, 10);
    const usuario = await supabaseService.crearUsuario({ email: email.toLowerCase().trim(), nombre, password_hash: passwordHash, role });
    logService.info(`Admin ${req.user.email} creó usuario ${email} (${role})`);
    res.json({ success: true, usuario: { id: usuario.id, email: usuario.email, nombre: usuario.nombre, role: usuario.role } });
  } catch (err) {
    const msg = err.message?.includes('duplicate') || err.message?.includes('unique') ? 'Ya existe un usuario con ese email' : err.message;
    res.status(400).json({ success: false, error: msg });
  }
});

// Actualizar monto_por_pedido de un usuario
app.put('/api/admin/usuarios/:id/monto', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { monto_por_pedido } = req.body;
    if (monto_por_pedido === undefined || isNaN(Number(monto_por_pedido))) {
      return res.status(400).json({ success: false, error: 'monto_por_pedido inválido' });
    }
    await supabaseService.actualizarMontoPorPedido(id, Number(monto_por_pedido));
    logService.info(`Admin ${req.user.email} actualizó monto de usuario ${id} a ${monto_por_pedido}`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Reporte: pedidos despachados por usuario en un rango de fechas
app.get('/api/admin/reporte', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { desde, hasta } = req.query;
    const reporte = await supabaseService.reportePedidosPorUsuario(desde, hasta);
    res.json({ success: true, reporte });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Inicializar usuarios por defecto ─────────────────────────────────────────
async function initializeDefaultUsers() {
  try {
    const count = await supabaseService.contarUsuarios();
    if (count > 0) return;

    const adminPass = process.env.ADMIN_PASSWORD || 'admin123';
    const userPass = process.env.USER_PASSWORD || 'usuario123';

    const [adminHash, userHash] = await Promise.all([
      bcrypt.hash(adminPass, 10),
      bcrypt.hash(userPass, 10),
    ]);

    await supabaseService.insertarUsuarios([
      { email: 'admin@velinne.com', nombre: 'Administrador', password_hash: adminHash, role: 'admin' },
      { email: 'usuario@velinne.com', nombre: 'Usuario', password_hash: userHash, role: 'user' },
    ]);

    logService.info('Usuarios por defecto creados: admin@velinne.com / usuario@velinne.com');
    console.log('✅ Usuarios por defecto creados (ver .env para contraseñas)');
  } catch (err) {
    logService.warning('No se pudieron crear usuarios por defecto (tabla puede no existir aún)', { error: err.message });
  }
}

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

    const nextRequiresHumanLastTime = mode
      ? mode !== 'bot_active'
      : Boolean(current.requires_human_last_time);

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

// Obtener pedidos para armado de operario (con etiqueta generada, sin distinguir tipo de envio)
app.get('/api/pedidos-armado', requireAuth, async (req, res) => {
  try {
    const pedidos = await supabaseService.obtenerPedidosParaArmado();
    res.json({ success: true, data: pedidos });
  } catch (error) {
    logService.error('Error en /api/pedidos-armado', error);
    res.status(500).json({ success: false, data: [], error: error.message });
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

// ⚠️ TEMPORAL: Reprocesar pedido de Shopify que no entró por webhook (ej: transferencia bancaria)
// Cuando ya no se necesite, comentar o eliminar este endpoint
app.post('/api/reprocess-shopify-order', async (req, res) => {
  try {
    const { orderNumber } = req.body || {};
    if (!orderNumber) {
      return res.status(400).json({ success: false, error: 'Se requiere orderNumber' });
    }

    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_KEY;

    if (!supabaseUrl || !supabaseKey) {
      return res.status(500).json({ success: false, error: 'SUPABASE_URL o SUPABASE_KEY no configurados' });
    }

    const response = await fetch(`${supabaseUrl}/functions/v1/shopify-proxy`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${supabaseKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ action: 'reprocessOrder', orderNumber: String(orderNumber) }),
    });

    const data = await response.json();
    res.status(response.ok ? 200 : 500).json(data);
  } catch (error) {
    logService.error('Error al reprocesar pedido Shopify', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Sincronizar con Shopify (alias para React)
app.post('/api/sync-shopify', async (req, res) => {
  try {
    const [ordenes, existingNums] = await Promise.all([
      shopifyService.obtenerOrdenes(),
      supabaseService.obtenerShopifyOrderIds(),
    ]);
    const ordenesNuevas = ordenes.filter((o) => !existingNums.has(String(o.order_number)));
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
    const [ordenes, existingNums] = await Promise.all([
      shopifyService.obtenerOrdenes(),
      supabaseService.obtenerShopifyOrderIds(),
    ]);
    const ordenesNuevas = ordenes.filter((o) => !existingNums.has(String(o.order_number)));
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
      (p) => p.numero_pedido && p.numero_seguimiento_ues
    );

    const resultados = [];

    for (const pedido of candidatos) {
      try {
        // Resolver shopify_order_id interno de Shopify usando numero_pedido
        logService.info(`Resolviendo ID Shopify para pedido #${pedido.numero_pedido}...`);
        const shopifyOrderId = await shopifyService.obtenerIdPorNumeroPedido(pedido.numero_pedido);
        if (!shopifyOrderId) {
          throw new Error(`No se encontró la orden #${pedido.numero_pedido} en Shopify`);
        }
        logService.info(`ID Shopify resuelto: ${shopifyOrderId} para pedido #${pedido.numero_pedido}`);

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
        logService.error(`❌ Fulfillment FALLÓ pedido #${pedido.numero_pedido} | tracking=${pedido.numero_seguimiento_ues}`, {
          mensaje: error.message,
          stack: error.stack,
        });
        resultados.push({
          pedidoId: pedido.id,
          numeroPedido: pedido.numero_pedido,
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
app.post('/api/marcar-notificado/:pedidoId', requireAuth, async (req, res) => {
  try {
    const { pedidoId } = req.params;

    const pedido = await supabaseService.obtenerPedido(pedidoId);
    if (!pedido) {
      return res.status(404).json({ success: false, error: 'Pedido no encontrado' });
    }

    await supabaseService.actualizarPedido(pedidoId, {
      notificacion_enviada_at: new Date().toISOString(),
      estado: 'despachado',
    });

    logService.info(`Pedido ${pedidoId} marcado como notificado y despachado (WhatsApp manual)`);

    // Agregar tag DESPACHADO en Shopify (best-effort, resolviendo shopify_order_id si es necesario)
    ;(async () => {
      try {
        if (pedido.numero_pedido) {
          const shopifyOrderId = await shopifyService.obtenerIdPorNumeroPedido(pedido.numero_pedido);
          if (shopifyOrderId) {
            await shopifyService.agregarTagAOrden(shopifyOrderId, 'DESPACHADO');
          }
        }
      } catch (e) {
        logService.warning(`No se pudo agregar tag DESPACHADO al pedido #${pedido.numero_pedido}: ${e.message}`);
      }
    })();

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

// Marcar múltiples pedidos como despachados (tag DESPACHADO en Shopify + estado enviado)
app.post('/api/marcar-despachados-bulk', requireAuth, async (req, res) => {
  try {
    const { pedidoIds } = req.body;
    if (!Array.isArray(pedidoIds) || pedidoIds.length === 0) {
      return res.status(400).json({ success: false, error: 'pedidoIds requerido' });
    }

    const ahora = new Date().toISOString();
    const despachadorNombre = req.user.nombre;
    const resultados = await Promise.all(
      pedidoIds.map(async (pedidoId) => {
        try {
          const pedido = await supabaseService.obtenerPedido(pedidoId);
          if (!pedido) return { pedidoId, success: false, error: 'No encontrado' };

          // Pickup y recibilo no usan tracking UES — pueden despacharse sin él
          const esEspecial = pedido.tipo_envio === 'pickup_local' || pedido.tipo_envio === 'recibilo_hoy';

          if (!esEspecial && (!pedido.numero_seguimiento_ues || !String(pedido.numero_seguimiento_ues).trim())) {
            return {
              pedidoId,
              numeroPedido: pedido.numero_pedido,
              success: false,
              error: 'Sin número de seguimiento — generá la etiqueta antes de despachar',
              sinTracking: true,
            };
          }

          await supabaseService.actualizarPedido(pedidoId, {
            estado: 'despachado',
            notificacion_enviada_at: ahora,
            despachado_por_nombre: despachadorNombre,
          });

          // Agregar tag DESPACHADO en Shopify (best-effort)
          if (pedido.numero_pedido) {
            shopifyService.obtenerIdPorNumeroPedido(pedido.numero_pedido)
              .then((shopifyId) => {
                if (shopifyId) shopifyService.agregarTagAOrden(shopifyId, 'DESPACHADO');
              })
              .catch((e) => logService.warning(`Tag DESPACHADO fallido para #${pedido.numero_pedido}: ${e.message}`));
          }

          return { pedidoId, numeroPedido: pedido.numero_pedido, success: true };
        } catch (e) {
          return { pedidoId, success: false, error: e.message };
        }
      })
    );

    const ok = resultados.filter((r) => r.success).length;
    logService.info(`Marcados como despachados: ${ok}/${pedidoIds.length}`);
    res.json({ success: true, ok, total: pedidoIds.length, resultados });
  } catch (error) {
    logService.error('Error en marcar-despachados-bulk', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Marcar pedidos como procesados SIN hacer fulfillment en Shopify
// Usado para pickup_local y recibilo_hoy, o despachados que ya tienen fulfillment hecho
app.post('/api/marcar-procesados-bulk', requireAuth, async (req, res) => {
  try {
    const { pedidoIds } = req.body;
    if (!Array.isArray(pedidoIds) || pedidoIds.length === 0) {
      return res.status(400).json({ success: false, error: 'pedidoIds requerido' });
    }

    const resultados = await Promise.all(
      pedidoIds.map(async (pedidoId) => {
        try {
          // Reutilizamos los campos de trazabilidad existentes para que aparezca en "Mis Pedidos Armados".
          await supabaseService.actualizarPedido(pedidoId, {
            estado: 'enviado',
            notificacion_enviada_at: new Date().toISOString(),
          });
          return { pedidoId, success: true };
        } catch (err) {
          logService.warning(`No se pudo marcar como procesado pedido ${pedidoId}: ${err.message}`);
          return { pedidoId, success: false, error: err.message };
        }
      })
    );

    const ok = resultados.filter((r) => r.success).length;
    logService.info(`Marcados como procesados: ${ok}/${pedidoIds.length}`);
    res.json({ success: true, ok, total: pedidoIds.length, resultados });
  } catch (error) {
    logService.error('Error en marcar-procesados-bulk', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Marcar pedidos como ARMADOS (estado intermedio) para el flujo de operario.
// Debe hacer solo lo necesario para que figuren en Despachados, sin efectos extra.
app.post('/api/marcar-armados-bulk', requireAuth, async (req, res) => {
  try {
    const { pedidoIds, idsSecundarios = [] } = req.body;
    if (!Array.isArray(pedidoIds) || pedidoIds.length === 0) {
      return res.status(400).json({ success: false, error: 'pedidoIds requerido' });
    }

    const despachadorNombre = req.user?.nombre || req.user?.email || null;
    const armadoAt = new Date().toISOString();

    // Primarios: cuentan para comisión del armador
    const resultadosPrimarios = await Promise.all(
      pedidoIds.map(async (pedidoId) => {
        try {
          await supabaseService.actualizarPedido(pedidoId, {
            estado: 'despachado',
            despachado_por_nombre: despachadorNombre,
            armado_at: armadoAt,
            notificacion_enviada_at: null,
          });
          return { pedidoId, success: true };
        } catch (err) {
          logService.warning(`No se pudo marcar como armado pedido ${pedidoId}: ${err.message}`);
          return { pedidoId, success: false, error: err.message };
        }
      })
    );

    // Secundarios: mismo tracking que un primario, no cuentan para comisión
    if (idsSecundarios.length > 0) {
      await Promise.all(
        idsSecundarios.map(async (pedidoId) => {
          try {
            await supabaseService.actualizarPedido(pedidoId, {
              estado: 'despachado',
              despachado_por_nombre: null,
              armado_at: armadoAt,
              notificacion_enviada_at: null,
            });
          } catch (err) {
            logService.warning(`No se pudo marcar secundario como armado pedido ${pedidoId}: ${err.message}`);
          }
        })
      );
    }

    const ok = resultadosPrimarios.filter((r) => r.success).length;
    logService.info(`Marcados como armados: ${ok}/${pedidoIds.length} (+ ${idsSecundarios.length} secundarios sin comisión)`);
    res.json({ success: true, ok, total: pedidoIds.length, resultados: resultadosPrimarios });
  } catch (error) {
    logService.error('Error en marcar-armados-bulk', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Obtener detalle de una orden (line_items) desde Shopify por numero_pedido
app.get('/api/pedido-detalle/:numeroPedido', requireAuth, async (req, res) => {
  try {
    const { numeroPedido } = req.params;
    const shopifyOrderId = await shopifyService.obtenerIdPorNumeroPedido(numeroPedido);
    if (!shopifyOrderId) {
      return res.status(404).json({ success: false, error: `Orden #${numeroPedido} no encontrada en Shopify` });
    }
    const orden = await shopifyService.obtenerOrden(shopifyOrderId);
    const lineItems = (orden.line_items || []).map((item) => ({
      id: item.id,
      title: item.title,
      variant_title: item.variant_title || null,
      quantity: item.quantity,
      sku: item.sku || null,
    }));
    res.json({ success: true, lineItems });
  } catch (error) {
    logService.error('Error obteniendo detalle de pedido', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Pedidos armados por el usuario autenticado (para su propia pantalla)
app.get('/api/mis-pedidos-armados', requireAuth, async (req, res) => {
  try {
    const { desde, hasta } = req.query;
    const resultado = await supabaseService.obtenerPedidosArmadosPorUsuario(
      req.user.nombre, desde, hasta
    );
    res.json({ success: true, ...resultado });
  } catch (err) {
    logService.error('Error en mis-pedidos-armados', err);
    res.status(500).json({ success: false, error: err.message });
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

function normalizePhoneKey(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (!digits) return '';
  return digits.length >= 8 ? digits.slice(-8) : digits;
}

function classifyFeedbackState(rawState) {
  const state = String(rawState || '').trim().toLowerCase();
  const positive = new Set(['happy', 'satisfied', 'feliz', 'ok']);
  const negative = new Set(['issue', 'repeat', 'upset', 'frustrated', 'anxious', 'molesta']);

  if (positive.has(state)) return 'positive';
  if (negative.has(state)) return 'negative';
  return 'neutral';
}

function mapToTopList(counterMap, limit = 8) {
  return Object.entries(counterMap)
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

function normalizeLabel(raw) {
  const value = String(raw || '').trim().toLowerCase();
  if (!value) return 'sin_clasificar';
  if (['null', 'undefined', 'none', 'n/a', 'na', '-'].includes(value)) return 'sin_clasificar';
  return value;
}

function classifyPendingAction(rawAction) {
  const action = normalizeLabel(rawAction);
  if (!action || action === 'sin_clasificar') return null;

  if (action.includes('precio') || action.includes('price')) return 'objecion_precio';
  if (action.includes('envio') || action.includes('entrega') || action.includes('delivery')) return 'friccion_envio';
  if (action.includes('calidad') || action.includes('quality')) return 'objecion_calidad';
  return action;
}

const LABEL_DICTIONARY = {
  general: { label: 'Consulta general', action: 'Revisar FAQ inicial y bienvenida' },
  greeting: { label: 'Saludo inicial', action: 'Responder con menu guiado corto' },
  purchase_intent: { label: 'Intención de compra', action: 'Priorizar cierre y oferta activa' },
  colors_designs: { label: 'Dudas por colores/diseños', action: 'Mostrar comparativa de tonos y packs' },
  shipping_question: { label: 'Duda de envío', action: 'Aclarar plazos por zona y costo final' },
  order_status: { label: 'Seguimiento de pedido', action: 'Automatizar status con tracking claro' },
  post_purchase_support: { label: 'Soporte post compra', action: 'Escalar casos de uso complejos' },
  payment_issue: { label: 'Problema de pago', action: 'Verificar pasarela y confirmacion manual' },
  complaint: { label: 'Reclamo', action: 'Activar protocolo de recuperacion' },
  delivery_delay: { label: 'Demora de entrega', action: 'Comunicacion proactiva de demora' },
  returns: { label: 'Cambio/devolución', action: 'Ofrecer ruta de solucion y tiempos' },
  wants_multiple_colors: { label: 'Quiere varios colores', action: 'Empujar bundle multicolor' },
  payment_confirmed_but_not_order: { label: 'Pago confirmado sin orden', action: 'Caso crítico: revisar checkout y conciliacion' },
  does_not_understand_product: { label: 'No entiende el producto', action: 'Agregar demo rápida de uso' },
  product_expectation_mismatch: { label: 'Expectativa de producto no cumplida', action: 'Alinear promesa comercial y contenido' },
  color_durability_issue: { label: 'Problema de durabilidad del color', action: 'Auditar calidad y guia de aplicacion' },
  uv_lamp_safety: { label: 'Duda sobre seguridad lampara UV', action: 'Publicar respuesta tecnica simple' },
  missing_items: { label: 'Faltan items en pedido', action: 'Abrir reposicion inmediata' },
  missing_item: { label: 'Falta un item en pedido', action: 'Abrir reposicion inmediata' },
  follow_up: { label: 'Seguimiento pendiente', action: 'Disparar secuencia de re-contacto' },
  objection: { label: 'Objeción de compra', action: 'Responder con prueba social y oferta' },
  product_inquiry: { label: 'Consulta de producto', action: 'Mostrar ficha tecnica completa' },
  tracking_request: { label: 'Solicitud de rastreo', action: 'Proporcionar link de tracking en tiempo real' },
};

function computeInsights(tops, hotOverview) {
  const insights = [];

  // Analizar quejas, dolores, acciones pendientes para calcular impacto
  const queju_count = (tops.quejas || []).reduce((sum, item) => sum + item.count, 0);
  const dolor_count = (tops.dolores || []).reduce((sum, item) => sum + item.count, 0);
  const pendiente_count = (tops.pendientes || []).reduce((sum, item) => sum + item.count, 0);

  const requires_human = hotOverview.requiresHuman || 0;

  // Si hay quejas/dolores, agregarlos como insights con impacto ponderado
  if (queju_count > 0) {
    insights.push({
      label: 'Quejas activas detectadas',
      count: queju_count,
      severity: queju_count >= 10 ? 'Alta' : queju_count >= 5 ? 'Media' : 'Baja',
      action: 'Revisar lista de quejas y activar protocolo de recuperacion',
    });
  }

  if (dolor_count > 0) {
    insights.push({
      label: 'Puntos de dolor frecuentes',
      count: dolor_count,
      severity: dolor_count >= 15 ? 'Alta' : dolor_count >= 8 ? 'Media' : 'Baja',
      action: 'Anadir puntos de dolor a FAQ y mejorar respuestas automaticas',
    });
  }

  if (requires_human > 0 && (requires_human / hotOverview.contacts) > 0.3) {
    insights.push({
      label: 'Alto requerimiento de intervención humana',
      count: requires_human,
      severity: 'Alta',
      action: 'Revisar limites de automatizacion y escalar training del bot',
    });
  }

  if (pendiente_count > 0) {
    insights.push({
      label: 'Acciones pendientes sin resolver',
      count: pendiente_count,
      severity: pendiente_count >= 20 ? 'Alta' : pendiente_count >= 10 ? 'Media' : 'Baja',
      action: 'Crear plan de resolucion con timeline y dueño',
    });
  }

  // Limitar a Top 4 insights ordenados por severidad (Alta > Media > Baja) y luego por count desc
  const severityOrder = { Alta: 0, Media: 1, Baja: 2 };
  return insights
    .sort((a, b) => {
      const severityDiff = severityOrder[a.severity] - severityOrder[b.severity];
      return severityDiff !== 0 ? severityDiff : b.count - a.count;
    })
    .slice(0, 4);
}

app.get('/api/feedback/dashboard', async (req, res) => {
  try {
    const now = new Date();
    const requestedDays = Math.max(parseInt(req.query.days || '30', 10) || 30, 1);
    const fromParam = String(req.query.from || '').trim();
    const toParam = String(req.query.to || '').trim();

    const fromDate = fromParam
      ? new Date(`${fromParam}T00:00:00`)
      : new Date(now.getTime() - (requestedDays * 24 * 60 * 60 * 1000));
    const toDate = toParam
      ? new Date(`${toParam}T23:59:59`)
      : now;

    const fromIso = fromDate.toISOString();
    const toIso = toDate.toISOString();

    const pedidosCampana = await supabaseService.obtenerPedidosFeedbackCampana({
      from: fromIso,
      to: toIso,
    });

    const customerIds = Array.from(new Set(
      pedidosCampana
        .map((p) => supabaseService.buildCustomerKey(p))
        .filter(Boolean)
    ));
    const [statesByCustomer, notesByCustomer] = await Promise.all([
      supabaseService.obtenerEstadosClientes(customerIds),
      supabaseService.obtenerNotasBatch(customerIds),
    ]);

    let botContacts = [];
    let redisWarning = null;
    try {
      botContacts = await loadBotContactsFromRedis();
    } catch (error) {
      redisWarning = error.message || 'No se pudo leer Redis';
      botContacts = [];
    }

    const contactByPhone = new Map();
    for (const contact of botContacts) {
      const key = normalizePhoneKey(contact.phone_number || contact.phone || contact.id);
      if (!key) continue;

      const currentTs = new Date(contact.last_message_at || 0).getTime() || 0;
      const prev = contactByPhone.get(key);
      const prevTs = prev ? (new Date(prev.last_message_at || 0).getTime() || 0) : 0;
      if (!prev || currentTs >= prevTs) {
        contactByPhone.set(key, contact);
      }
    }

    const timelineByDate = {};
    const campaign = {
      sent: 0,
      responded: 0,
      ok: 0,
      notOk: 0,
      noResponse: 0,
    };

    for (const pedido of pedidosCampana) {
      const sentAt = new Date(pedido.followup_enviado_at || 0);
      if (Number.isNaN(sentAt.getTime())) continue;

      const dayKey = sentAt.toISOString().slice(0, 10);
      if (!timelineByDate[dayKey]) {
        timelineByDate[dayKey] = {
          date: dayKey,
          sent: 0,
          responded: 0,
          ok: 0,
          notOk: 0,
          noResponse: 0,
        };
      }

      const pedidoCustomerId = supabaseService.buildCustomerKey(pedido);
      const stateRecord = statesByCustomer[pedidoCustomerId] || null;
      const stateFromDb = stateRecord?.state || 'neutral';
      const phoneKey = normalizePhoneKey(pedido.cliente_telefono);
      const matchedContact = phoneKey ? contactByPhone.get(phoneKey) : null;
      const lastMessageAt = new Date(matchedContact?.last_message_at || 0);
      const respondedByRedis = !Number.isNaN(lastMessageAt.getTime()) && lastMessageAt.getTime() >= sentAt.getTime();
      const stateUpdatedAt = new Date(stateRecord?.updated_at || 0);
      const respondedByState = !Number.isNaN(stateUpdatedAt.getTime()) && stateUpdatedAt.getTime() >= sentAt.getTime();
      const responded = respondedByRedis || respondedByState;

      const stateSource = stateFromDb || matchedContact?.customer_state || 'neutral';
      const classified = classifyFeedbackState(stateSource);

      campaign.sent += 1;
      timelineByDate[dayKey].sent += 1;

      if (responded) {
        campaign.responded += 1;
        timelineByDate[dayKey].responded += 1;
      } else {
        campaign.noResponse += 1;
        timelineByDate[dayKey].noResponse += 1;
      }

      if (classified === 'positive') {
        campaign.ok += 1;
        timelineByDate[dayKey].ok += 1;
      }
      if (classified === 'negative') {
        campaign.notOk += 1;
        timelineByDate[dayKey].notOk += 1;
      }
    }

    const campaignSentiment = {
      positive: 0,
      neutral: 0,
      negative: 0,
    };

    const hotSentiment = {
      positive: 0,
      neutral: 0,
      negative: 0,
    };

    const hotOverview = {
      contacts: botContacts.length,
      activeLast24h: 0,
      requiresHuman: 0,
      paused: 0,
      blacklisted: 0,
      botActive: 0,
    };

    const topIntentsCounter = {};
    const topSubintentsCounter = {};
    const stageCounter = {};
    const pendingActionCounter = {};

    const doubtCounter = {};
    const complaintCounter = {};
    const painCounter = {};
    const reasonCounter = {};

    const doubtIntents = new Set(['product_inquiry', 'tracking_request', 'order_status', 'general', 'post_purchase', 'shipping_question', 'colors_designs']);
    const complaintIntents = new Set(['complaint', 'delivery_delay', 'returns', 'post_purchase_support', 'payment_issue']);
    const painIntents = new Set(['objection', 'payment_issue']);
    const reasonIntents = new Set(['purchase_intent']);
    const complaintSubintents = new Set([
      'delivery_delay',
      'product_expectation_mismatch',
      'color_durability_issue',
      'missing_items',
      'missing_item',
      'damaged_product',
      'wrong_product',
      'payment_confirmed_but_not_order',
    ]);

    const nowTs = now.getTime();
    const dayMs = 24 * 60 * 60 * 1000;

    for (const contact of botContacts) {
      const bucket = classifyFeedbackState(contact?.customer_state);
      hotSentiment[bucket] += 1;

      const lastMessageAtTs = new Date(contact?.last_message_at || 0).getTime();
      if (!Number.isNaN(lastMessageAtTs) && lastMessageAtTs > 0 && (nowTs - lastMessageAtTs) <= dayMs) {
        hotOverview.activeLast24h += 1;
      }

      if (Boolean(contact?.requires_human_last_time)) hotOverview.requiresHuman += 1;

      const mode = String(contact?.control?.mode || '').toLowerCase();
      const blacklisted = Boolean(contact?.control?.blacklisted) || mode === 'blacklist';
      const paused = mode === 'paused';

      if (blacklisted) {
        hotOverview.blacklisted += 1;
      } else if (paused) {
        hotOverview.paused += 1;
      } else {
        hotOverview.botActive += 1;
      }

      const intent = normalizeLabel(contact?.last_intent);
      const subintent = normalizeLabel(contact?.last_subintent);
      const stage = normalizeLabel(contact?.stage);

      topIntentsCounter[intent] = (topIntentsCounter[intent] || 0) + 1;
      if (subintent !== 'sin_clasificar') {
        topSubintentsCounter[subintent] = (topSubintentsCounter[subintent] || 0) + 1;
      }
      stageCounter[stage] = (stageCounter[stage] || 0) + 1;

      const pendingActionClass = classifyPendingAction(contact?.pending_action);
      if (pendingActionClass) {
        pendingActionCounter[pendingActionClass] = (pendingActionCounter[pendingActionClass] || 0) + 1;
      }

      const label = subintent !== 'sin_clasificar' ? subintent : intent;

      if (doubtIntents.has(intent)) {
        doubtCounter[label] = (doubtCounter[label] || 0) + 1;
      }
      if (complaintIntents.has(intent) || complaintSubintents.has(subintent)) {
        complaintCounter[label] = (complaintCounter[label] || 0) + 1;
      }
      if (painIntents.has(intent) || subintent.includes('objection') || complaintSubintents.has(subintent)) {
        painCounter[label] = (painCounter[label] || 0) + 1;
      }
      if (reasonIntents.has(intent) || stage === 'ready_to_buy') {
        const reasonLabel = String(contact?.interest_product || '').trim() || label;
        reasonCounter[reasonLabel] = (reasonCounter[reasonLabel] || 0) + 1;
      }
    }

    campaignSentiment.positive = campaign.ok;
    campaignSentiment.negative = campaign.notOk;
    campaignSentiment.neutral = Math.max(campaign.sent - campaign.ok - campaign.notOk, 0);

    const timeline = Object.values(timelineByDate).sort((a, b) => a.date.localeCompare(b.date));

    // Construir lista de contactos de campaña — deduplicada por customerId
    // (un cliente puede tener varios pedidos con followup enviado; se conserva el más reciente)
    const contactMapBuild = new Map();
    for (const pedido of pedidosCampana) {
      const customerId = supabaseService.buildCustomerKey(pedido);
      const stateRecord = statesByCustomer[customerId] || null;
      const phoneKey = normalizePhoneKey(pedido.cliente_telefono);
      const matchedContact = phoneKey ? contactByPhone.get(phoneKey) : null;

      const stateFromDb = stateRecord?.state || null;
      const stateFromRedis = matchedContact?.customer_state || null;
      const state = stateFromDb || stateFromRedis || 'neutral';

      const sentAt = new Date(pedido.followup_enviado_at || 0);
      const lastMessageAtTs = new Date(matchedContact?.last_message_at || 0).getTime();
      const stateUpdatedAtTs = new Date(stateRecord?.updated_at || 0).getTime();
      const respondedByRedis = !Number.isNaN(lastMessageAtTs) && lastMessageAtTs >= sentAt.getTime();
      const respondedByState = !Number.isNaN(stateUpdatedAtTs) && stateUpdatedAtTs >= sentAt.getTime();

      const entry = {
        customerId,
        name: pedido.cliente_nombre || matchedContact?.customer_name || '—',
        phone: pedido.cliente_telefono || null,
        followupSentAt: pedido.followup_enviado_at || null,
        responded: !!(respondedByRedis || respondedByState),
        state,
        stateUpdatedAt: stateRecord?.updated_at || null,
        stateSource: stateFromDb ? 'db' : stateFromRedis ? 'redis' : null,
        notes: notesByCustomer[customerId] || [],
        profileSummary: matchedContact?.profile_summary || null,
        lastMessageAt: matchedContact?.last_message_at || null,
        requiresHuman: !!matchedContact?.requires_human_last_time,
        stage: matchedContact?.stage || null,
        orderCount: 1,
      };

      const existing = contactMapBuild.get(customerId);
      if (!existing) {
        contactMapBuild.set(customerId, entry);
      } else {
        // Conservar el más reciente; acumular orderCount
        existing.orderCount += 1;
        const existingTs = new Date(existing.followupSentAt || 0).getTime();
        const newTs = new Date(entry.followupSentAt || 0).getTime();
        if (newTs > existingTs) {
          contactMapBuild.set(customerId, { ...entry, orderCount: existing.orderCount });
        }
      }
    }
    const campaignContacts = Array.from(contactMapBuild.values());

    // Agregar insights computados
    const topsList = {
      intents: mapToTopList(topIntentsCounter),
      subintents: mapToTopList(topSubintentsCounter),
      stages: mapToTopList(stageCounter),
      pendientes: mapToTopList(pendingActionCounter),
      dudas: mapToTopList(doubtCounter),
      quejas: mapToTopList(complaintCounter),
      dolores: mapToTopList(painCounter),
      razonesCompra: mapToTopList(reasonCounter),
    };

    const computedInsights = computeInsights(topsList, hotOverview);

    return res.json({
      success: true,
      range: {
        from: fromIso,
        to: toIso,
        days: requestedDays,
      },
      dictionary: LABEL_DICTIONARY,
      campaignFeedback: {
        kpis: campaign,
        sentiment: campaignSentiment,
        timeline,
        contacts: campaignContacts,
        criteria: {
          responded: 'Redis last_message_at >= followup_enviado_at OR customer_states.updated_at >= followup_enviado_at',
          ok: 'customer_states.state in [happy, satisfied, feliz, ok]',
          notOk: 'customer_states.state in [issue, repeat, upset, frustrated, anxious, molesta]',
        },
      },
      hotRedis: {
        overview: hotOverview,
        sentiment: hotSentiment,
        insights: computedInsights,
        tops: topsList,
        criteria: {
          dudas: 'last_intent in [product_inquiry, tracking_request, order_status, general, post_purchase, shipping_question, colors_designs]',
          quejas: 'last_intent in [complaint, delivery_delay, returns, post_purchase_support, payment_issue] OR subintent de reclamo',
          dolores: 'last_intent in [objection, payment_issue] OR subintent de reclamo/objection OR pending_action clasificada',
          razonesCompra: 'last_intent = purchase_intent OR stage = ready_to_buy, usando interest_product cuando existe',
        },
      },
      compatibility: {
        kpis: {
          campaign,
          sentiment: hotSentiment,
          botContacts: botContacts.length,
        },
      },
      tops: {
        dudas: mapToTopList(doubtCounter),
        quejas: mapToTopList(complaintCounter),
        dolores: mapToTopList(painCounter),
        razonesCompra: mapToTopList(reasonCounter),
      },
      warnings: {
        redis: redisWarning,
      },
    });
  } catch (error) {
    logService.error('Error generando dashboard de feedback', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// ── Razones de compra: clasificación por diccionario (sin API externa) ────────

// Normaliza texto para comparar: minúsculas + sin tildes
function normalizarParaMatch(str) {
  return String(str || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Diccionario: cada categoría tiene sus palabras/frases clave
// Orden importa: las más específicas van primero (mayor prioridad)
const MOTIVACION_DICT = [
  {
    categoria: 'se come o muerde las uñas',
    keywords: [
      'come las una', 'muerde las una', 'comerse las una', 'morderse las una',
      'se come las', 'se muerde las', 'las muerde', 'se come la una',
      'onicofagia', 'habito de comer', 'deja de comer', 'dejar de comer',
      'parar de comerse', 'dejar el habito de', 'comido las unas',
    ],
  },
  {
    categoria: 'cambiar hábitos',
    keywords: [
      'cambiar el habito', 'cambiar habito', 'dejar el habito', 'dejar la costumbre',
      'dejar de morderse', 'dejar de comerse', 'ansiedad', 'nervios', 'estres',
      'cuando se estresa', 'cuando se pone nerviosa', 'vicio', 'habito nervioso',
      'habito de ansiedad',
    ],
  },
  {
    categoria: 'uñas dañadas o débiles',
    keywords: [
      'danada', 'daniada', 'debil', 'quebradiz', 'maltratad', 'fragil',
      'se rompen', 'se quiebran', 'se parten', 'muy blanda', 'amarilla',
      'daño del gel', 'dano del gel', 'daño por gel', 'dano por gel',
      'daño del acrilico', 'por el gel anterior', 'mal del gel',
      'lastimada', 'deteriorada', 'estropeada', 'daño previo',
    ],
  },
  {
    categoria: 'uñas cortas o que no crecen',
    keywords: [
      'no le crecen', 'no crecen', 'no le crece', 'no crece',
      'quiere alargar', 'alargar las una', 'alargar la una',
      'mas largas', 'tener largo', 'sin largo', 'extension de una',
      'extensiones', 'elongar', 'no tiene largo', 'unas cortas',
    ],
  },
  {
    categoria: 'prolijas para el trabajo',
    keywords: [
      'para el trabajo', 'para trabajar', 'laboral', 'para la oficina',
      'presentacion laboral', 'presentarse bien', 'entorno profesional',
      'trabajo de', 'para su trabajo', 'manos prolijas para',
      'veterinaria', 'enfermera', 'medica', 'doctora', 'maestra',
      'docente', 'administrativa', 'cajera', 'recepcionista',
    ],
  },
  {
    categoria: 'ocasión especial',
    keywords: [
      'casamiento', 'boda', 'quince anos', 'quinceañera', 'quinceanera',
      'cumpleanos', 'evento', 'fiesta', 'graduacion', 'egresada',
      'baile', 'prom', 'primera comunion', 'ceremonia', 'fotografia',
      'sesion de fotos', 'sesion foto', 'viaje', 'vacaciones',
    ],
  },
  {
    categoria: 'regalo o sorpresa',
    keywords: [
      'regalo', 'regalar', 'sorpresa', 'obsequio',
      'para su mama', 'para mi mama', 'para su hija', 'para mi hija',
      'para su amiga', 'para mi amiga', 'para su hermana',
      'dia de la madre', 'navidad', 'san valentin', 'dia de la mujer',
      'cumple de su', 'cumple de mi',
    ],
  },
  {
    categoria: 'curiosidad o exploración',
    keywords: [
      'curiosidad', 'quiere conocer', 'quiere probar', 'primera vez',
      'nunca uso', 'nunca habia usado', 'vio en instagram', 'vio en redes',
      'le recomendaron', 'le comentaron', 'escucho de', 'vio en tiktok',
      'alguien le dijo', 'le hablo de', 'interesada en conocer',
    ],
  },
  {
    categoria: 'cuidado y estética',
    keywords: [
      'cuidar las unas', 'cuidado de las unas', 'estetica',
      'diseños', 'disenios', 'colores', 'decoracion', 'esmaltado',
      'manicura', 'manicure', 'tratamiento', 'fortalecer',
      'hidratacion', 'aceite de cuticula', 'cuticula',
      'unas bonitas', 'unas lindas', 'manos bonitas', 'manos lindas',
      'verse bien', 'lucir bien',
    ],
  },
];

// Extrae la oración del resumen más relevante para la categoría detectada
function extraerOracion(texto, keywords) {
  const oraciones = texto.split(/(?<=[.!?])\s+|,\s+(?=[A-ZÁÉÍÓÚ])/);
  const normalTexto = normalizarParaMatch(texto);

  let mejorOracion = '';
  let mejorPuntaje = 0;

  for (const oracion of oraciones) {
    const normOracion = normalizarParaMatch(oracion);
    const puntaje = keywords.filter((kw) => normOracion.includes(kw)).length;
    if (puntaje > mejorPuntaje) {
      mejorPuntaje = puntaje;
      mejorOracion = oracion.trim();
    }
  }

  // Si ninguna oración matcheó, devolver la primera oración del resumen
  if (!mejorOracion) {
    mejorOracion = oraciones[0]?.trim() || texto.slice(0, 120);
  }

  return mejorOracion.length > 140 ? mejorOracion.slice(0, 137) + '…' : mejorOracion;
}

// Clasifica un contacto usando el diccionario. Sin llamadas externas.
function clasificarContacto(contact) {
  const raw = (contact.profile_summary || '').trim();
  const normalizado = normalizarParaMatch(raw);

  let mejorCategoria = 'otro';
  let mejorPuntaje = 0;
  let mejorKeywords = [];

  for (const { categoria, keywords } of MOTIVACION_DICT) {
    const hits = keywords.filter((kw) => normalizado.includes(kw));
    if (hits.length > mejorPuntaje) {
      mejorPuntaje = hits.length;
      mejorCategoria = categoria;
      mejorKeywords = hits;
    }
  }

  return {
    categoria: mejorCategoria,
    motivacion: extraerOracion(raw, mejorKeywords),
  };
}

let purchaseReasonsCache = null;
let purchaseReasonsCacheTime = 0;
const PURCHASE_REASONS_CACHE_MS = 30 * 60 * 1000;

app.get('/api/feedback/purchase-reasons', async (req, res) => {
  try {
    const forceRefresh = req.query.refresh === 'true';
    const cacheValid =
      purchaseReasonsCache &&
      Date.now() - purchaseReasonsCacheTime < PURCHASE_REASONS_CACHE_MS;

    if (!forceRefresh && cacheValid) {
      return res.json({ success: true, data: purchaseReasonsCache, cached: true });
    }

    // 1. Cargar contactos desde Redis
    const botContacts = await loadBotContactsFromRedis();
    const withSummary = botContacts.filter(
      (c) => c.profile_summary && c.profile_summary.trim().length > 20
    );

    if (withSummary.length === 0) {
      return res.json({
        success: true,
        data: { motivations: [], categories: {}, totalAnalyzed: 0 },
        cached: false,
      });
    }

    // 2. Clasificar cada contacto con el diccionario (instantáneo, sin API)
    const motivations = withSummary.map((c) => {
      const { categoria, motivacion } = clasificarContacto(c);
      return {
        phone: String(c.phone || '').slice(-4),
        name: c.customer_name || c.name || '',
        motivation: motivacion,
        categoria,
        stage: c.stage || null,
      };
    });

    // 3. Agregar por categoría
    const categories = {};
    for (const m of motivations) {
      const cat = m.categoria || 'otro';
      if (!categories[cat]) categories[cat] = { count: 0, examples: [] };
      categories[cat].count++;
      if (categories[cat].examples.length < 5) categories[cat].examples.push(m.motivation);
    }

    const data = { motivations, categories, totalAnalyzed: motivations.length };
    purchaseReasonsCache = data;
    purchaseReasonsCacheTime = Date.now();

    return res.json({ success: true, data, cached: false });
  } catch (error) {
    logService.error('Error analizando razones de compra', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

const VALID_CUSTOMER_STATES = new Set(['happy', 'neutral', 'issue', 'repeat', 'no_lo_uso']);

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

// Marcar follow-up como enviado (persiste en DB)
app.post('/api/pedidos/:pedidoId/marcar-followup', async (req, res) => {
  try {
    const { pedidoId } = req.params;
    if (!pedidoId) {
      return res.status(400).json({ success: false, error: 'pedidoId requerido' });
    }
    const data = await supabaseService.marcarFollowupEnviado(pedidoId);
    return res.json({ success: true, data });
  } catch (error) {
    logService.error('Error marcando follow-up como enviado', error);
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
      // Si se regenera etiqueta, debe volver al flujo de "Etiquetas Generadas".
      notificacion_enviada_at: null,
      despachado_por_nombre: null,
      armado_at: null,
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
app.get('/api/pedidos-despachados', async (req, res) => {
  try {
    const pedidos = await supabaseService.obtenerPedidosDespachados();
    res.json({ success: true, data: pedidos });
  } catch (error) {
    logService.error('Error al obtener pedidos despachados', error);
    res.status(500).json({ success: false, data: [], error: error.message });
  }
});

app.get('/api/pedidos-enviados', async (req, res) => {
  try {
    const pedidos = await supabaseService.obtenerPedidosEnviados();
    res.json({ success: true, data: pedidos });
  } catch (error) {
    logService.error('Error al obtener pedidos enviados', error);
    res.status(500).json({ success: false, data: [], error: error.message });
  }
});

// ── Pedidos Pick-UP ──────────────────────────────────────────────────────────
app.get('/api/pedidos-pickup', async (req, res) => {
  try {
    const pedidos = await supabaseService.obtenerPedidosPickup();
    res.json({ success: true, data: pedidos });
  } catch (error) {
    logService.error('Error al obtener pedidos pickup', error);
    res.status(500).json({ success: false, data: [], error: error.message });
  }
});

// ── Pedidos Recibilo Hoy ─────────────────────────────────────────────────────
app.get('/api/pedidos-recibilo', async (req, res) => {
  try {
    const pedidos = await supabaseService.obtenerPedidosRecibilo();
    res.json({ success: true, data: pedidos });
  } catch (error) {
    logService.error('Error al obtener pedidos recibilo', error);
    res.status(500).json({ success: false, data: [], error: error.message });
  }
});

// ── Buscar etiqueta en Google Drive por número de pedido ────────────────────
const DRIVE_FOLDER_ID = process.env.DRIVE_ETIQUETAS_FOLDER_ID || '1lp7dpwdCg49nvqbGhW0efvXGV49q2lWQ';

app.get('/api/drive-etiqueta/:numeroPedido', async (req, res) => {
  const { numeroPedido } = req.params;
  const folderUrl = `https://drive.google.com/drive/folders/${DRIVE_FOLDER_ID}`;

  // ── Opción A: Service Account (accede a carpetas privadas) ─────────────────
  if (driveClient) {
    try {
      const query = `'${DRIVE_FOLDER_ID}' in parents and name contains '${numeroPedido}' and trashed = false`;
      const response = await driveClient.files.list({
        q: query,
        fields: 'files(id,name,webViewLink,webContentLink,mimeType)',
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
        pageSize: 5,
      });

      const files = response.data.files || [];
      if (files.length === 0) {
        return res.json({ success: false, fallbackUrl: folderUrl, error: `No se encontró etiqueta para pedido ${numeroPedido}` });
      }

      const pdf = files.find((f) => f.mimeType === 'application/pdf') || files[0];
      const previewUrl  = `https://drive.google.com/file/d/${pdf.id}/preview`;
      const downloadUrl = `https://drive.google.com/uc?export=download&id=${pdf.id}`;
      return res.json({ success: true, fileId: pdf.id, name: pdf.name, previewUrl, downloadUrl, webViewLink: pdf.webViewLink });
    } catch (error) {
      logService.error(`[Drive SA] Error buscando etiqueta para pedido ${numeroPedido}`, error);
      return res.json({ success: false, fallbackUrl: folderUrl, error: error.message });
    }
  }

  // ── Opción B: API Key pública (solo funciona si la carpeta es pública) ─────
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    return res.json({ success: false, fallbackUrl: folderUrl, error: 'GOOGLE_API_KEY no configurada' });
  }

  try {
    const query = `'${DRIVE_FOLDER_ID}' in parents and name contains '${numeroPedido}' and trashed = false`;
    const response = await axios.get('https://www.googleapis.com/drive/v3/files', {
      params: {
        q: query,
        key: apiKey,
        fields: 'files(id,name,webViewLink,webContentLink,mimeType)',
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
        pageSize: 5,
      },
    });

    const files = response.data.files || [];
    if (files.length === 0) {
      return res.json({ success: false, fallbackUrl: folderUrl, error: `No se encontró etiqueta para pedido ${numeroPedido}` });
    }

    const pdf = files.find((f) => f.mimeType === 'application/pdf') || files[0];
    const previewUrl  = `https://drive.google.com/file/d/${pdf.id}/preview`;
    const downloadUrl = `https://drive.google.com/uc?export=download&id=${pdf.id}`;
    return res.json({ success: true, fileId: pdf.id, name: pdf.name, previewUrl, downloadUrl, webViewLink: pdf.webViewLink });
  } catch (error) {
    logService.error(`[Drive API Key] Error buscando etiqueta para pedido ${numeroPedido}`, error);
    return res.json({ success: false, fallbackUrl: folderUrl, error: error.message });
  }
});

// ── Merge PDF: descarga y une varios PDFs de Drive en uno solo ──────────────
app.post('/api/drive-etiquetas/merge-pdf', async (req, res) => {
  const { links } = req.body;
  if (!Array.isArray(links) || links.length === 0) {
    return res.status(400).json({ success: false, error: 'No se enviaron links' });
  }
  if (!driveClient) {
    return res.status(503).json({ success: false, error: 'Drive Service Account no configurado' });
  }

  const { PDFDocument } = require('pdf-lib');

  function extractFileId(url) {
    if (!url) return null;
    const m1 = String(url).match(/\/d\/([^/?#]+)/);
    if (m1) return m1[1];
    const m2 = String(url).match(/[?&]id=([^&]+)/);
    return m2 ? m2[1] : null;
  }

  try {
    const mergedPdf = await PDFDocument.create();
    let merged = 0;

    for (const link of links) {
      const fileId = extractFileId(link);
      if (!fileId) { logService.warning(`[MergePDF] Link inválido: ${link}`); continue; }

      try {
        const resp = await driveClient.files.get(
          { fileId, alt: 'media' },
          { responseType: 'arraybuffer' }
        );
        const pdfDoc = await PDFDocument.load(Buffer.from(resp.data), { ignoreEncryption: true });
        const pages  = await mergedPdf.copyPagesFrom(pdfDoc, pdfDoc.getPageIndices());
        pages.forEach((p) => mergedPdf.addPage(p));
        merged++;
      } catch (err) {
        logService.warning(`[MergePDF] No se pudo descargar fileId ${fileId}: ${err.message}`);
      }
    }

    if (merged === 0) {
      return res.status(404).json({ success: false, error: 'No se pudo descargar ningún PDF de Drive' });
    }

    const bytes = await mergedPdf.save();
    const filename = `etiquetas-${new Date().toISOString().slice(0,10)}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', bytes.length);
    res.send(Buffer.from(bytes));
  } catch (error) {
    logService.error('[MergePDF] Error generando PDF unificado', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ── Guardar link de Drive en pedido ─────────────────────────────────────────
app.post('/api/pedidos/:pedidoId/guardar-link-drive', async (req, res) => {
  const { pedidoId } = req.params;
  const { linkDrive } = req.body;
  try {
    const updated = await supabaseService.guardarLinkDrivePedido(pedidoId, linkDrive);
    res.json({ success: true, data: updated });
  } catch (error) {
    logService.error(`Error guardando link Drive en pedido ${pedidoId}`, error);
    res.status(500).json({ success: false, error: error.message });
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

if (process.env.NODE_ENV === 'production') {
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'dist', 'index.html'));
  });
}

// Iniciar servidor
app.listen(PORT, async () => {
  console.log(`🚀 VELINNE Server corriendo en http://localhost:${PORT}`);
  logService.info(`Servidor iniciado en puerto ${PORT}`);
  
  // Inicializar plantillas por defecto al arrancar el servidor
  supabaseService.inicializarPlantillasDefecto().catch(err => {
    logService.error('Error al inicializar plantillas por defecto', err);
  });

  // Crear usuarios por defecto si no existen
  initializeDefaultUsers().catch(err => {
    logService.error('Error al inicializar usuarios por defecto', err);
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

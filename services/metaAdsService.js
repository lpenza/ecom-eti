const axios = require('axios');
require('dotenv').config();

// ── Meta Marketing API (campañas / conjuntos / anuncios) ─────────────────────
// Usa la misma Graph API que el envío de WhatsApp, pero necesita un token con
// los permisos `ads_read` + `ads_management` (el usuario de sistema de WhatsApp
// sólo tiene whatsapp_business_*). Si META_ADS_ACCESS_TOKEN no está, probamos
// con WHATSAPP_ACCESS_TOKEN por si se le agregaron esos permisos.

const API_VERSION = process.env.META_ADS_API_VERSION || process.env.WHATSAPP_API_VERSION || 'v21.0';
const GRAPH = `https://graph.facebook.com/${API_VERSION}`;

function token() {
  return process.env.META_ADS_ACCESS_TOKEN || process.env.WHATSAPP_ACCESS_TOKEN || '';
}

// Cuenta publicitaria por defecto (con o sin el prefijo "act_").
function cuentaPorDefecto() {
  const id = String(process.env.META_AD_ACCOUNT_ID || '').trim();
  if (!id) return null;
  return id.startsWith('act_') ? id : `act_${id}`;
}

// Meta expresa los presupuestos en la unidad mínima de la moneda (centavos),
// salvo estas monedas que no tienen decimales (offset 1).
const MONEDAS_SIN_DECIMALES = new Set(['CLP', 'COP', 'CRC', 'HUF', 'ISK', 'IDR', 'JPY', 'KRW', 'PYG', 'TWD', 'VND']);
function offsetMoneda(moneda) {
  return MONEDAS_SIN_DECIMALES.has(String(moneda || '').toUpperCase()) ? 1 : 100;
}

// Presets de fecha que acepta el panel (los mismos nombres que usa Meta).
const DATE_PRESETS = new Set(['today', 'yesterday', 'last_3d', 'last_7d', 'last_14d', 'last_30d', 'this_month', 'last_month', 'maximum']);

const CAMPOS_INSIGHTS = 'spend,impressions,reach,clicks,inline_link_clicks,ctr,cpc,cpm,frequency,actions,action_values,purchase_roas';

class MetaAdsError extends Error {
  constructor(message, { status, code, detalle } = {}) {
    super(message);
    this.status = status || 500;
    this.code = code;
    this.detalle = detalle;
  }
}

function errorDeMeta(err) {
  const e = err.response?.data?.error;
  if (!e) return new MetaAdsError(err.message);
  // 190 = token inválido/vencido; 200/10/294 = faltan permisos de ads.
  const sinPermiso = [10, 200, 294].includes(e.code) || /permission/i.test(e.message || '');
  const mensaje = e.code === 190
    ? 'El token de Meta Ads es inválido o venció'
    : sinPermiso
      // Si Meta explica el motivo (ej. el usuario no es anunciante de la cuenta), mostramos eso.
      ? (e.error_user_title || 'El token de Meta no tiene permisos de anuncios (ads_read / ads_management)')
      : (e.error_user_msg || e.message || 'Error de Meta');
  return new MetaAdsError(mensaje, {
    status: e.code === 190 || sinPermiso ? 403 : 400,
    code: e.code,
    detalle: e.error_user_msg || e.error_user_title || e.message,
  });
}

// ── Límites de la API (Rulebook 4.1) ─────────────────────────────────────────
// Meta informa el consumo en headers. Guardamos el mayor porcentaje visto para
// que los jobs puedan frenar antes de llegar al límite (error 17).
let usoApi = { porcentaje: 0, en: 0 };

function registrarUso(headers = {}) {
  let max = 0;
  const visitar = (o) => {
    if (Array.isArray(o)) o.forEach(visitar);
    else if (o && typeof o === 'object') {
      for (const k of ['call_count', 'total_cputime', 'total_time', 'acc_id_util_pct']) {
        if (Number.isFinite(Number(o[k]))) max = Math.max(max, Number(o[k]));
      }
      Object.values(o).forEach(v => { if (v && typeof v === 'object') visitar(v); });
    }
  };
  for (const h of ['x-business-use-case-usage', 'x-app-usage', 'x-ad-account-usage']) {
    if (!headers[h]) continue;
    try { visitar(JSON.parse(headers[h])); } catch { /* formato inesperado: se ignora */ }
  }
  usoApi = { porcentaje: max, en: Date.now() };
}

// Uso reciente (últimos 5 minutos, la ventana con la que mide Meta).
function usoApiActual() {
  return Date.now() - usoApi.en < 5 * 60 * 1000 ? usoApi.porcentaje : 0;
}

async function graphGet(ruta, params = {}) {
  if (!token()) throw new MetaAdsError('Falta configurar META_ADS_ACCESS_TOKEN', { status: 503 });
  try {
    const res = await axios.get(`${GRAPH}/${ruta}`, {
      params: { access_token: token(), ...params },
      timeout: 30000,
    });
    registrarUso(res.headers);
    return res.data;
  } catch (err) {
    throw errorDeMeta(err);
  }
}

// GET que sigue la paginación de Meta hasta traer todo (con un tope de páginas
// por si alguna cuenta tiene miles de objetos).
async function graphGetTodo(ruta, params = {}, maxPaginas = 10) {
  const primera = await graphGet(ruta, { limit: 200, ...params });
  const datos = [...(primera.data || [])];
  let siguiente = primera.paging?.next;
  for (let i = 1; siguiente && i < maxPaginas; i++) {
    try {
      const res = await axios.get(siguiente, { timeout: 30000 });
      registrarUso(res.headers);
      datos.push(...(res.data.data || []));
      siguiente = res.data.paging?.next;
    } catch (err) {
      throw errorDeMeta(err);
    }
  }
  return datos;
}

// Meta a veces rechaza páginas grandes de insights ("reduce the amount of
// data"): se reintenta con páginas más chicas.
async function graphGetTodoAchicando(ruta, params, maxPaginas) {
  for (const limite of [params.limit || 500, 150, 50]) {
    try {
      return await graphGetTodo(ruta, { ...params, limit: limite }, Math.ceil(maxPaginas * ((params.limit || 500) / limite)));
    } catch (err) {
      if (!/reduce the amount of data/i.test(`${err.message} ${err.detalle || ''}`) || limite === 50) throw err;
    }
  }
  return [];
}

async function graphPost(ruta, body = {}) {
  if (!token()) throw new MetaAdsError('Falta configurar META_ADS_ACCESS_TOKEN', { status: 503 });
  try {
    const params = new URLSearchParams({ access_token: token() });
    for (const [k, v] of Object.entries(body)) {
      if (v === undefined || v === null) continue;
      params.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
    }
    const res = await axios.post(`${GRAPH}/${ruta}`, params, { timeout: 60000 });
    registrarUso(res.headers);
    return res.data;
  } catch (err) {
    throw errorDeMeta(err);
  }
}

// ── Normalización de métricas ────────────────────────────────────────────────

const TIPOS_COMPRA = ['purchase', 'omni_purchase', 'offsite_conversion.fb_pixel_purchase'];

// Meta repite la misma compra bajo varios action_type; tomamos el primero que
// aparezca en orden de preferencia para no contarla dos veces.
function valorAccion(lista, tipos) {
  if (!Array.isArray(lista)) return 0;
  for (const tipo of tipos) {
    const a = lista.find(x => x.action_type === tipo);
    if (a) return Number(a.value) || 0;
  }
  return 0;
}

function normalizarInsights(insights) {
  const i = insights?.data?.[0];
  if (!i) return null;
  const gasto = Number(i.spend) || 0;
  const compras = valorAccion(i.actions, TIPOS_COMPRA);
  const valorCompras = valorAccion(i.action_values, TIPOS_COMPRA);
  const roasMeta = valorAccion(i.purchase_roas, TIPOS_COMPRA);
  return {
    gasto,
    impresiones: Number(i.impressions) || 0,
    alcance: Number(i.reach) || 0,
    clics: Number(i.inline_link_clicks ?? i.clicks) || 0,
    ctr: Number(i.ctr) || 0,
    cpc: Number(i.cpc) || 0,
    cpm: Number(i.cpm) || 0,
    frecuencia: Number(i.frequency) || 0,
    compras,
    valorCompras,
    cpa: compras > 0 ? gasto / compras : null,
    roas: roasMeta || (gasto > 0 && valorCompras > 0 ? valorCompras / gasto : null),
    agregarAlCarrito: valorAccion(i.actions, ['add_to_cart', 'omni_add_to_cart', 'offsite_conversion.fb_pixel_add_to_cart']),
    iniciarPago: valorAccion(i.actions, ['initiate_checkout', 'omni_initiated_checkout', 'offsite_conversion.fb_pixel_initiate_checkout']),
  };
}

function normalizarPresupuesto(obj, offset) {
  const diario = obj.daily_budget != null ? Number(obj.daily_budget) / offset : null;
  const total = obj.lifetime_budget != null && Number(obj.lifetime_budget) > 0 ? Number(obj.lifetime_budget) / offset : null;
  return {
    presupuestoDiario: diario && diario > 0 ? diario : null,
    presupuestoTotal: total,
    presupuestoRestante: obj.budget_remaining != null ? Number(obj.budget_remaining) / offset : null,
  };
}

function campoInsights(datePreset) {
  const preset = DATE_PRESETS.has(datePreset) ? datePreset : 'last_7d';
  return `insights.date_preset(${preset}){${CAMPOS_INSIGHTS}}`;
}

// Filtro por estado: 'activas' = lo que está entregando o por entregar;
// 'todas' = todo menos archivado/borrado. Se manda como `effective_status`
// (no como `filtering`, que Meta ignora en los edges /adsets y /ads).
function filtroEstado(filtro) {
  const estados = filtro === 'activas'
    ? ['ACTIVE', 'IN_PROCESS', 'WITH_ISSUES', 'PENDING_REVIEW', 'PREAPPROVED', 'PENDING_BILLING_INFO']
    : ['ACTIVE', 'PAUSED', 'IN_PROCESS', 'WITH_ISSUES', 'CAMPAIGN_PAUSED', 'ADSET_PAUSED', 'PENDING_REVIEW', 'DISAPPROVED', 'PREAPPROVED', 'PENDING_BILLING_INFO'];
  return JSON.stringify(estados);
}

// ── Cuentas ──────────────────────────────────────────────────────────────────

const ESTADOS_CUENTA = { 1: 'Activa', 2: 'Deshabilitada', 3: 'Con deuda', 7: 'En revisión', 9: 'En período de gracia', 100: 'Cierre pendiente', 101: 'Cerrada' };

const cacheMoneda = new Map(); // act_id → moneda

// Junta las cuentas propias del usuario con las que ve a través de sus
// Business Managers (propias o compartidas como cliente): la cuenta con la que
// pauta Velinne llega como "client_ad_account" del BM, no por /me/adaccounts.
async function listarCuentas() {
  const campos = 'id,name,account_status,currency,timezone_name,amount_spent';
  const porId = new Map();
  for (const c of await graphGetTodo('me/adaccounts', { fields: campos })) porId.set(c.id, c);
  const negocios = await graphGetTodo('me/businesses', { fields: 'id' }).catch(() => []);
  for (const b of negocios) {
    for (const edge of ['owned_ad_accounts', 'client_ad_accounts']) {
      const lista = await graphGetTodo(`${b.id}/${edge}`, { fields: campos }).catch(() => []);
      for (const c of lista) if (!porId.has(c.id)) porId.set(c.id, c);
    }
  }
  // Un usuario de sistema no lista las cuentas que tiene asignadas: la de
  // META_AD_ACCOUNT_ID se pide directo para que siempre esté disponible.
  const porDefecto = cuentaPorDefecto();
  if (porDefecto && !porId.has(porDefecto)) {
    const c = await graphGet(porDefecto, { fields: campos }).catch(() => null);
    if (c) porId.set(c.id, c);
  }
  // Las activas con más gasto histórico primero.
  const cuentas = [...porId.values()].sort((a, b) =>
    (b.account_status === 1) - (a.account_status === 1) || Number(b.amount_spent || 0) - Number(a.amount_spent || 0));
  for (const c of cuentas) cacheMoneda.set(c.id, c.currency);
  return {
    porDefecto: porDefecto && cuentas.some(c => c.id === porDefecto) ? porDefecto : (cuentas[0]?.id || null),
    cuentas: cuentas.map(c => ({
      id: c.id,
      nombre: c.name,
      estado: ESTADOS_CUENTA[c.account_status] || String(c.account_status),
      activa: c.account_status === 1,
      moneda: c.currency,
      zonaHoraria: c.timezone_name,
    })),
  };
}

async function monedaDeCuenta(cuentaId) {
  if (cacheMoneda.has(cuentaId)) return cacheMoneda.get(cuentaId);
  const c = await graphGet(cuentaId, { fields: 'currency' });
  cacheMoneda.set(cuentaId, c.currency);
  return c.currency;
}

// Cuenta dueña de una campaña / conjunto / anuncio (para saber la moneda).
async function monedaDeObjeto(id) {
  const o = await graphGet(id, { fields: 'account_id' });
  return monedaDeCuenta(`act_${o.account_id}`);
}

function validarCuenta(cuentaId) {
  const id = String(cuentaId || '').trim() || cuentaPorDefecto();
  if (!id || !/^act_\d+$/.test(id)) throw new MetaAdsError('Cuenta publicitaria inválida', { status: 400 });
  return id;
}

function validarIdObjeto(id) {
  if (!/^\d+$/.test(String(id || ''))) throw new MetaAdsError('ID inválido', { status: 400 });
  return String(id);
}

// ── Listados ─────────────────────────────────────────────────────────────────

async function listarCampanias(cuentaId, { datePreset, filtro } = {}) {
  const cuenta = validarCuenta(cuentaId);
  const moneda = await monedaDeCuenta(cuenta);
  const offset = offsetMoneda(moneda);
  const campanias = await graphGetTodo(`${cuenta}/campaigns`, {
    fields: [
      'id', 'name', 'status', 'effective_status', 'objective', 'buying_type', 'bid_strategy',
      'daily_budget', 'lifetime_budget', 'budget_remaining', 'start_time', 'stop_time', 'created_time',
      campoInsights(datePreset),
    ].join(','),
    effective_status: filtroEstado(filtro),
  });
  return {
    moneda,
    campanias: campanias.map(c => ({
      id: c.id,
      nombre: c.name,
      estado: c.status,
      estadoEfectivo: c.effective_status,
      objetivo: c.objective,
      estrategiaPuja: c.bid_strategy || null,
      inicio: c.start_time || null,
      fin: c.stop_time || null,
      // CBO (Advantage+ campaign budget): el presupuesto vive en la campaña.
      presupuestoEnCampania: Boolean(Number(c.daily_budget) || Number(c.lifetime_budget)),
      ...normalizarPresupuesto(c, offset),
      metricas: normalizarInsights(c.insights),
    })),
  };
}

async function listarConjuntos(campaniaId, { datePreset, filtro } = {}) {
  const id = validarIdObjeto(campaniaId);
  const moneda = await monedaDeObjeto(id);
  const offset = offsetMoneda(moneda);
  const conjuntos = await graphGetTodo(`${id}/adsets`, {
    fields: [
      'id', 'name', 'status', 'effective_status', 'optimization_goal', 'billing_event', 'bid_strategy', 'bid_amount',
      'daily_budget', 'lifetime_budget', 'budget_remaining', 'start_time', 'end_time', 'learning_stage_info',
      campoInsights(datePreset),
    ].join(','),
    effective_status: filtroEstado(filtro),
  });
  return {
    moneda,
    conjuntos: conjuntos.map(s => ({
      id: s.id,
      nombre: s.name,
      estado: s.status,
      estadoEfectivo: s.effective_status,
      optimizacion: s.optimization_goal,
      estrategiaPuja: s.bid_strategy || null,
      inicio: s.start_time || null,
      fin: s.end_time || null,
      aprendizaje: s.learning_stage_info?.status || null, // LEARNING | SUCCESS | FAIL
      ...normalizarPresupuesto(s, offset),
      metricas: normalizarInsights(s.insights),
    })),
  };
}

async function listarAnuncios(conjuntoId, { datePreset, filtro } = {}) {
  const id = validarIdObjeto(conjuntoId);
  const moneda = await monedaDeObjeto(id);
  const anuncios = await graphGetTodo(`${id}/ads`, {
    fields: [
      'id', 'name', 'status', 'effective_status', 'created_time',
      'creative{id,title,body,thumbnail_url,image_url,object_type}',
      'preview_shareable_link',
      campoInsights(datePreset),
    ].join(','),
    effective_status: filtroEstado(filtro),
  });
  return {
    moneda,
    anuncios: anuncios.map(a => ({
      id: a.id,
      nombre: a.name,
      estado: a.status,
      estadoEfectivo: a.effective_status,
      creado: a.created_time,
      miniatura: a.creative?.thumbnail_url || a.creative?.image_url || null,
      titulo: a.creative?.title || null,
      texto: a.creative?.body || null,
      tipoCreativo: a.creative?.object_type || null,
      linkVistaPrevia: a.preview_shareable_link || null,
      metricas: normalizarInsights(a.insights),
    })),
  };
}

// ── Acciones ─────────────────────────────────────────────────────────────────

// Prende (ACTIVE) o apaga (PAUSED) una campaña, conjunto o anuncio.
async function cambiarEstado(id, estado) {
  const objId = validarIdObjeto(id);
  if (!['ACTIVE', 'PAUSED'].includes(estado)) throw new MetaAdsError('Estado inválido (ACTIVE o PAUSED)', { status: 400 });
  await graphPost(objId, { status: estado });
  const o = await graphGet(objId, { fields: 'status,effective_status' });
  return { id: objId, estado: o.status, estadoEfectivo: o.effective_status };
}

// Cambia el presupuesto de una campaña (CBO) o conjunto. Se le pasa el monto
// nuevo en la moneda de la cuenta, o un porcentaje de escalado (+20, -15...).
// Respeta el tipo de presupuesto que ya tenga (diario o total).
async function cambiarPresupuesto(id, { monto, porcentaje } = {}) {
  const objId = validarIdObjeto(id);
  const o = await graphGet(objId, { fields: 'daily_budget,lifetime_budget,account_id,name' });
  const moneda = await monedaDeCuenta(`act_${o.account_id}`);
  const offset = offsetMoneda(moneda);

  const diario = Number(o.daily_budget) || 0;
  const total = Number(o.lifetime_budget) || 0;
  const campo = diario > 0 ? 'daily_budget' : total > 0 ? 'lifetime_budget' : null;
  if (!campo) {
    throw new MetaAdsError('Este objeto no tiene presupuesto propio (el presupuesto está en la campaña o en los conjuntos)', { status: 400 });
  }
  const actual = campo === 'daily_budget' ? diario : total;

  let nuevo;
  if (monto != null && monto !== '') {
    const m = Number(monto);
    if (!Number.isFinite(m) || m <= 0) throw new MetaAdsError('Monto inválido', { status: 400 });
    nuevo = Math.round(m * offset);
  } else if (porcentaje != null && porcentaje !== '') {
    const p = Number(porcentaje);
    if (!Number.isFinite(p) || p <= -90 || p > 500) throw new MetaAdsError('Porcentaje inválido (entre -90 y +500)', { status: 400 });
    nuevo = Math.round(actual * (1 + p / 100));
  } else {
    throw new MetaAdsError('Indicá monto o porcentaje', { status: 400 });
  }
  if (nuevo === actual) throw new MetaAdsError('El presupuesto nuevo es igual al actual', { status: 400 });

  await graphPost(objId, { [campo]: nuevo });
  return {
    id: objId,
    nombre: o.name,
    tipo: campo === 'daily_budget' ? 'diario' : 'total',
    moneda,
    anterior: actual / offset,
    nuevo: nuevo / offset,
    variacionPct: actual > 0 ? ((nuevo - actual) / actual) * 100 : null,
  };
}

// Duplica un conjunto o campaña (escalado horizontal). La copia queda PAUSADA
// para revisarla antes de prenderla. deep_copy copia también los hijos.
async function duplicar(id, { tipo, renombrarSufijo = ' - copia' } = {}) {
  const objId = validarIdObjeto(id);
  if (!['campania', 'conjunto', 'anuncio'].includes(tipo)) throw new MetaAdsError('Tipo inválido', { status: 400 });
  const body = {
    status_option: 'PAUSED',
    rename_options: { rename_suffix: renombrarSufijo },
  };
  if (tipo !== 'anuncio') body.deep_copy = true;
  const r = await graphPost(`${objId}/copies`, body);
  const nuevoId = r.copied_campaign_id || r.copied_adset_id || r.copied_ad_id || null;
  return { id: objId, nuevoId };
}

// ── Lecturas masivas para los jobs del piloto ────────────────────────────────

// Insights de toda la cuenta a un nivel (campaign | adset | ad) en una sola
// consulta paginada, en vez de una llamada por entidad (Rulebook 4.1).
// rango: { since, until } (YYYY-MM-DD) o { preset }.
async function insightsPorNivel(cuentaId, nivel, rango) {
  const cuenta = validarCuenta(cuentaId);
  const params = { level: nivel, fields: `campaign_id,campaign_name,adset_id,adset_name,ad_id,ad_name,${CAMPOS_INSIGHTS}`, limit: 500 };
  if (rango?.preset) params.date_preset = rango.preset;
  else params.time_range = JSON.stringify({ since: rango.since, until: rango.until });
  const filas = await graphGetTodoAchicando(`${cuenta}/insights`, params, 20);
  const porId = new Map();
  for (const f of filas) {
    const id = nivel === 'ad' ? f.ad_id : nivel === 'adset' ? f.adset_id : f.campaign_id;
    porId.set(id, {
      ...normalizarInsights({ data: [f] }),
      nombres: { campania: f.campaign_name || null, conjunto: f.adset_name || null, anuncio: f.ad_name || null },
      ids: { campania: f.campaign_id || null, conjunto: f.adset_id || null, anuncio: f.ad_id || null },
    });
  }
  return porId;
}

// Varios objetos por ID en una sola llamada (?ids=a,b,c).
async function obtenerVarios(ids, campos, extra = {}) {
  const lista = [...new Set(ids.filter(Boolean).map(validarIdObjeto))].slice(0, 50);
  if (!lista.length) return {};
  return graphGet('', { ids: lista.join(','), fields: campos, ...extra });
}

// Totales de la cuenta en un rango (para el CPA blended del Inicio y del gate).
async function insightsCuenta(cuentaId, rango) {
  const cuenta = validarCuenta(cuentaId);
  const params = { fields: CAMPOS_INSIGHTS };
  if (rango?.preset) params.date_preset = rango.preset;
  else params.time_range = JSON.stringify({ since: rango.since, until: rango.until });
  return normalizarInsights(await graphGet(`${cuenta}/insights`, params));
}

// Estructura de la cuenta con lo que necesitan las reglas: presupuestos,
// fechas, aprendizaje, audiencias de retargeting y creativo de cada anuncio.
async function estructuraCuenta(cuentaId, { soloActivas = true } = {}) {
  const cuenta = validarCuenta(cuentaId);
  const moneda = await monedaDeCuenta(cuenta);
  const offset = offsetMoneda(moneda);
  const efectivo = JSON.stringify(soloActivas
    ? ['ACTIVE', 'IN_PROCESS', 'WITH_ISSUES']
    : ['ACTIVE', 'PAUSED', 'IN_PROCESS', 'WITH_ISSUES', 'CAMPAIGN_PAUSED', 'ADSET_PAUSED']);
  const [campanias, conjuntos, anuncios] = await Promise.all([
    graphGetTodo(`${cuenta}/campaigns`, {
      fields: 'id,name,status,effective_status,objective,daily_budget,lifetime_budget,created_time,updated_time,start_time',
      effective_status: efectivo,
    }),
    graphGetTodo(`${cuenta}/adsets`, {
      fields: 'id,name,status,effective_status,campaign_id,daily_budget,lifetime_budget,created_time,updated_time,start_time,learning_stage_info,targeting{custom_audiences}',
      effective_status: efectivo,
    }, 20),
    graphGetTodo(`${cuenta}/ads`, {
      fields: 'id,name,status,effective_status,campaign_id,adset_id,created_time,creative{id,thumbnail_url,image_url}',
      effective_status: efectivo,
    }, 30),
  ]);
  const presupuesto = (o) => ({
    presupuestoDiario: Number(o.daily_budget) > 0 ? Number(o.daily_budget) / offset : null,
    presupuestoTotal: Number(o.lifetime_budget) > 0 ? Number(o.lifetime_budget) / offset : null,
  });
  return {
    moneda,
    campanias: campanias.map(c => ({
      id: c.id, nombre: c.name, estado: c.status, estadoEfectivo: c.effective_status, objetivo: c.objective,
      creado: c.created_time, actualizado: c.updated_time, inicio: c.start_time || null, ...presupuesto(c),
    })),
    conjuntos: conjuntos.map(x => ({
      id: x.id, nombre: x.name, estado: x.status, estadoEfectivo: x.effective_status, campaniaId: x.campaign_id,
      creado: x.created_time, actualizado: x.updated_time, inicio: x.start_time || null,
      aprendizaje: x.learning_stage_info?.status || null,
      audiencias: (x.targeting?.custom_audiences || []).map(a => a.name || a.id),
      ...presupuesto(x),
    })),
    anuncios: anuncios.map(a => ({
      id: a.id, nombre: a.name, estado: a.status, estadoEfectivo: a.effective_status,
      campaniaId: a.campaign_id, conjuntoId: a.adset_id, creado: a.created_time,
      creativoId: a.creative?.id || null, miniatura: a.creative?.thumbnail_url || a.creative?.image_url || null,
    })),
  };
}

// Anuncios de toda la cuenta (cualquier estado salvo borrado) cuyo nombre
// contiene el texto. Se usa para la idempotencia de la graduación.
async function buscarAnunciosPorNombre(cuentaId, texto) {
  const cuenta = validarCuenta(cuentaId);
  const filas = await graphGetTodo(`${cuenta}/ads`, {
    fields: 'id,name,effective_status,campaign{id,name},adset{id,name}',
    filtering: JSON.stringify([{ field: 'ad.name', operator: 'CONTAIN', value: texto }]),
  });
  return filas.map(a => ({
    id: a.id, nombre: a.name, estadoEfectivo: a.effective_status,
    campaniaId: a.campaign?.id, campaniaNombre: a.campaign?.name, conjuntoId: a.adset?.id, conjuntoNombre: a.adset?.name,
  }));
}

// Campañas (cualquier estado salvo borrado) cuyo nombre contiene el texto,
// con sus ad sets. Para encontrar la "CBO - PRE - SICH[n]" aunque esté pausada.
async function buscarCampaniasPorNombre(cuentaId, texto) {
  const cuenta = validarCuenta(cuentaId);
  const filas = await graphGetTodo(`${cuenta}/campaigns`, {
    fields: 'id,name,status,effective_status,daily_budget,adsets.limit(50){id,name,status,effective_status,optimization_goal,billing_event,promoted_object,targeting,attribution_spec}',
    filtering: JSON.stringify([{ field: 'campaign.name', operator: 'CONTAIN', value: texto }]),
  });
  return filas.map(c => ({
    id: c.id, nombre: c.name, estado: c.status, estadoEfectivo: c.effective_status,
    conjuntos: (c.adsets?.data || []).map(s => ({
      id: s.id, nombre: s.name, estado: s.status, estadoEfectivo: s.effective_status,
      plantilla: {
        optimization_goal: s.optimization_goal, billing_event: s.billing_event,
        promoted_object: s.promoted_object, targeting: s.targeting, attribution_spec: s.attribution_spec,
      },
    })),
  }));
}

async function obtenerObjeto(id, campos) {
  return graphGet(validarIdObjeto(id), { fields: campos });
}

// Insights de un objeto (campaña / ad set / anuncio, aunque esté pausado) en un rango.
async function insightsObjeto(id, rango) {
  const r = await graphGet(`${validarIdObjeto(id)}/insights`, {
    fields: CAMPOS_INSIGHTS,
    time_range: JSON.stringify({ since: rango.since, until: rango.until }),
  });
  return normalizarInsights(r);
}

// Insights semanales (time_increment=7) de toda la cuenta a un nivel: una fila
// por entidad y semana. Para saber quién fue ganador en algún momento.
// gastoMinimo filtra en Meta las filas con poco gasto (menos datos que bajar).
async function insightsSemanales(cuentaId, nivel, rango, { gastoMinimo = 0 } = {}) {
  const cuenta = validarCuenta(cuentaId);
  const filas = await graphGetTodoAchicando(`${cuenta}/insights`, {
    ...(gastoMinimo > 0 ? { filtering: JSON.stringify([{ field: 'spend', operator: 'GREATER_THAN', value: gastoMinimo }]) } : {}),
    level: nivel,
    fields: `campaign_id,campaign_name,adset_id,adset_name,ad_id,ad_name,${CAMPOS_INSIGHTS}`,
    time_range: JSON.stringify({ since: rango.since, until: rango.until }),
    time_increment: 7,
    limit: 500,
  }, 40);
  return filas.map(f => ({
    id: nivel === 'ad' ? f.ad_id : nivel === 'adset' ? f.adset_id : f.campaign_id,
    desde: f.date_start,
    hasta: f.date_stop,
    nombres: { campania: f.campaign_name || null, conjunto: f.adset_name || null, anuncio: f.ad_name || null },
    ids: { campania: f.campaign_id || null, conjunto: f.adset_id || null },
    ...normalizarInsights({ data: [f] }),
  }));
}

// Insights por anuncio con métricas de enganche del creativo (para el brief):
// hook (reproducciones de 3 s / impresiones), % visto y thruplays.
async function insightsCreativos(cuentaId, rango) {
  const cuenta = validarCuenta(cuentaId);
  const filas = await graphGetTodoAchicando(`${cuenta}/insights`, {
    level: 'ad',
    fields: `campaign_name,adset_name,ad_id,ad_name,${CAMPOS_INSIGHTS},video_p25_watched_actions,video_p50_watched_actions,video_p75_watched_actions,video_p100_watched_actions,video_thruplay_watched_actions,video_avg_time_watched_actions`,
    time_range: JSON.stringify({ since: rango.since, until: rango.until }),
    filtering: JSON.stringify([{ field: 'spend', operator: 'GREATER_THAN', value: 50 }]),
    limit: 200,
  }, 20);
  const primero = (lista) => Number((lista || [])[0]?.value || 0);
  return filas.map(f => {
    const m = normalizarInsights({ data: [f] });
    const vistas3s = (f.actions || []).find(a => a.action_type === 'video_view');
    const impresiones = m?.impresiones || 0;
    return {
      id: f.ad_id, anuncio: f.ad_name, conjunto: f.adset_name, campania: f.campaign_name, ...m,
      esVideo: Boolean(vistas3s || f.video_p25_watched_actions),
      hook: vistas3s && impresiones ? (Number(vistas3s.value) / impresiones) * 100 : null,
      vistoP25: impresiones ? (primero(f.video_p25_watched_actions) / impresiones) * 100 : null,
      vistoP50: impresiones ? (primero(f.video_p50_watched_actions) / impresiones) * 100 : null,
      vistoP100: impresiones ? (primero(f.video_p100_watched_actions) / impresiones) * 100 : null,
      thruplays: primero(f.video_thruplay_watched_actions),
      segundosPromedio: primero(f.video_avg_time_watched_actions) || null,
    };
  });
}

// Eventos del pixel/dataset sumados por tipo en un rango (salud de medición).
async function estadisticasPixel(pixelId, desdeIso, hastaIso) {
  const r = await graphGetTodo(`${validarIdObjeto(pixelId)}/stats`, {
    aggregation: 'event',
    start_time: Math.floor(new Date(desdeIso).getTime() / 1000),
    end_time: Math.floor(new Date(hastaIso).getTime() / 1000),
  }, 30);
  const totales = {};
  for (const bloque of r) {
    for (const e of bloque.data || []) totales[e.value] = (totales[e.value] || 0) + Number(e.count || 0);
  }
  return totales;
}

async function listarAudiencias(cuentaId) {
  const filas = await graphGetTodo(`${validarCuenta(cuentaId)}/customaudiences`, {
    fields: 'id,name,subtype,approximate_count_lower_bound,approximate_count_upper_bound,time_created,time_updated,lookalike_spec,delivery_status,operation_status',
  });
  return filas.map(a => ({
    id: a.id, nombre: a.name, subtipo: a.subtype,
    tamanio: Number(a.approximate_count_lower_bound) > 0 ? Number(a.approximate_count_lower_bound) : null,
    creada: a.time_created ? new Date(a.time_created * 1000).toISOString() : null,
    actualizada: a.time_updated ? new Date(a.time_updated * 1000).toISOString() : null,
    origenes: (a.lookalike_spec?.origin || []).map(o => o.id),
    ratio: a.lookalike_spec?.ratio ?? null,
  }));
}

async function crearLookalike(cuentaId, { origenId, ratio, pais = 'UY', nombre }) {
  const r = await graphPost(`${validarCuenta(cuentaId)}/customaudiences`, {
    name: nombre,
    subtype: 'LOOKALIKE',
    origin_audience_id: validarIdObjeto(origenId),
    lookalike_spec: { type: 'similarity', ratio, country: pais },
  });
  return r.id;
}

// Biblioteca de medios de la cuenta (para no volver a subir un VELn que ya
// está). Meta la devuelve de lo más nuevo a lo más viejo y tiene miles de
// archivos (~45 s completa): con unas pocas páginas alcanza para una tanda nueva.
async function listarBiblioteca(cuentaId, { paginas = 3 } = {}) {
  const cuenta = validarCuenta(cuentaId);
  const [imagenes, videos] = await Promise.all([
    graphGetTodo(`${cuenta}/adimages`, { fields: 'name,hash,created_time' }, paginas),
    graphGetTodo(`${cuenta}/advideos`, { fields: 'title,id,created_time' }, paginas),
  ]);
  return {
    imagenes: imagenes.map(i => ({ nombre: i.name || '', hash: i.hash, creado: i.created_time })),
    videos: videos.map(v => ({ nombre: v.title || '', id: v.id, creado: v.created_time })),
  };
}

// Sube una imagen (buffer) a la biblioteca. Devuelve el hash.
async function subirImagen(cuentaId, buffer, nombre) {
  const r = await graphPost(`${validarCuenta(cuentaId)}/adimages`, { bytes: buffer.toString('base64'), name: nombre });
  const img = Object.values(r.images || {})[0];
  if (!img?.hash) throw new MetaAdsError('Meta no devolvió el hash de la imagen subida');
  return img.hash;
}

// Sube un video (buffer) a la biblioteca con multipart. Devuelve el video_id.
async function subirVideo(cuentaId, buffer, nombre) {
  if (!token()) throw new MetaAdsError('Falta configurar META_ADS_ACCESS_TOKEN', { status: 503 });
  const FormData = require('form-data');
  const form = new FormData();
  form.append('access_token', token());
  form.append('title', nombre);
  form.append('name', nombre);
  form.append('source', buffer, { filename: nombre });
  try {
    const res = await axios.post(`https://graph-video.facebook.com/${API_VERSION}/${validarCuenta(cuentaId)}/advideos`, form, {
      headers: form.getHeaders(), maxBodyLength: Infinity, maxContentLength: Infinity, timeout: 10 * 60 * 1000,
    });
    registrarUso(res.headers);
    return res.data.id;
  } catch (err) {
    throw errorDeMeta(err);
  }
}

// Estado de procesamiento y miniatura de un video recién subido (el creativo
// de video exige una imagen de portada).
async function estadoVideo(videoId) {
  const v = await graphGet(validarIdObjeto(videoId), { fields: 'status,picture,thumbnails{uri,is_preferred}' });
  const preferida = (v.thumbnails?.data || []).find(t => t.is_preferred) || v.thumbnails?.data?.[0];
  return { listo: v.status?.video_status === 'ready', estado: v.status?.video_status, miniatura: preferida?.uri || v.picture || null };
}

// Configuración de un ad set de testeo existente y del creativo de su anuncio,
// para crear los nuevos iguales (targeting, pixel, atribución, página, copy).
async function plantillaDeConjunto(conjuntoId) {
  const s = await graphGet(validarIdObjeto(conjuntoId), {
    fields: 'name,targeting,promoted_object,optimization_goal,billing_event,bid_strategy,attribution_spec,destination_type,'
      + 'ads.limit(1){name,creative{object_story_spec,instagram_user_id,degrees_of_freedom_spec,url_tags}}',
  });
  const creativo = s.ads?.data?.[0]?.creative;
  if (!creativo?.object_story_spec) throw new MetaAdsError(`El ad set "${s.name}" no tiene un anuncio para usar de plantilla`, { status: 400 });
  return {
    conjuntoNombre: s.name,
    conjunto: {
      targeting: s.targeting, promoted_object: s.promoted_object, optimization_goal: s.optimization_goal,
      billing_event: s.billing_event, bid_strategy: s.bid_strategy, attribution_spec: s.attribution_spec,
      destination_type: s.destination_type,
    },
    creativo: {
      object_story_spec: creativo.object_story_spec,
      instagram_user_id: creativo.instagram_user_id || null,
      degrees_of_freedom_spec: creativo.degrees_of_freedom_spec || null,
      url_tags: creativo.url_tags || null,
    },
  };
}

async function crearCreativo(cuentaId, campos) {
  return (await graphPost(`${validarCuenta(cuentaId)}/adcreatives`, campos)).id;
}

// ── Escrituras usadas por el ejecutor de propuestas ──────────────────────────

async function crearAnuncio(cuentaId, { conjuntoId, creativoId, nombre, estado = 'PAUSED' }) {
  const r = await graphPost(`${validarCuenta(cuentaId)}/ads`, {
    name: nombre,
    adset_id: validarIdObjeto(conjuntoId),
    creative: { creative_id: validarIdObjeto(creativoId) },
    status: estado,
  });
  return r.id;
}

async function crearCampania(cuentaId, campos) {
  return (await graphPost(`${validarCuenta(cuentaId)}/campaigns`, campos)).id;
}

async function crearConjunto(cuentaId, campos) {
  return (await graphPost(`${validarCuenta(cuentaId)}/adsets`, campos)).id;
}

async function actualizarObjeto(id, campos) {
  return graphPost(validarIdObjeto(id), campos);
}

// Presupuesto diario exacto (en la moneda de la cuenta). Devuelve el estado
// efectivo después del cambio para detectar status_forced_to_paused.
async function fijarPresupuestoDiario(id, monto) {
  const objId = validarIdObjeto(id);
  const o = await graphGet(objId, { fields: 'account_id' });
  const offset = offsetMoneda(await monedaDeCuenta(`act_${o.account_id}`));
  await graphPost(objId, { daily_budget: Math.round(Number(monto) * offset) });
  const d = await graphGet(objId, { fields: 'daily_budget,status,effective_status' });
  return { presupuestoDiario: Number(d.daily_budget) / offset, estado: d.status, estadoEfectivo: d.effective_status };
}

module.exports = {
  MetaAdsError,
  usoApiActual,
  cuentaPorDefecto,
  insightsPorNivel,
  insightsCuenta,
  estructuraCuenta,
  buscarAnunciosPorNombre,
  buscarCampaniasPorNombre,
  obtenerObjeto,
  obtenerVarios,
  listarBiblioteca,
  insightsObjeto,
  insightsSemanales,
  insightsCreativos,
  estadisticasPixel,
  listarAudiencias,
  crearLookalike,
  subirImagen,
  subirVideo,
  estadoVideo,
  crearCreativo,
  plantillaDeConjunto,
  crearAnuncio,
  crearCampania,
  crearConjunto,
  actualizarObjeto,
  fijarPresupuestoDiario,
  configurado: () => Boolean(token()),
  listarCuentas,
  listarCampanias,
  listarConjuntos,
  listarAnuncios,
  cambiarEstado,
  cambiarPresupuesto,
  duplicar,
};

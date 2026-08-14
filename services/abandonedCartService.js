const { createClient } = require('@supabase/supabase-js');
const shopifyService = require('./shopifyService');
const kommoWhatsApp = require('./kommoWhatsAppService');
require('dotenv').config();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const HORA_MS = 60 * 60 * 1000;

// ─── Flujo de mensajes (parametrizable) ──────────────────────────────────────
// El flujo es una lista ORDENADA de pasos; cada paso define qué plantilla enviar
// y cuántas horas esperar ANTES de mandarlo (medido desde el abandono para el
// paso 1, o desde el envío del paso anterior para los siguientes).
//
// Se configura con la env var WA_FLOW (JSON). Ejemplo con 3 mensajes:
//   WA_FLOW='[{"template":"intento_abandonado_v1","demoraHoras":1},
//             {"template":"intento_carrito_abandonado_1","demoraHoras":12},
//             {"template":"intento_carrito_abandonado_2","demoraHoras":24}]'
//
// Si WA_FLOW no está seteada se usa el flujo por defecto (2 mensajes: 1h y 12h),
// que mantiene el comportamiento histórico. Las plantillas hay que crearlas y
// aprobarlas en Meta (Kommo → WhatsApp → Plantillas) antes de usarlas.
const FLUJO_DEFECTO = [
  { template: process.env.WA_TEMPLATE_CARRITO_1 || 'intento_abandonado_v1',        demoraHoras: 1 },
  { template: process.env.WA_TEMPLATE_CARRITO_2 || 'intento_carrito_abandonado_1', demoraHoras: 12 },
];

// Flujo desde env var WA_FLOW (o el default). Es el fallback cuando la tabla
// de configuración abandoned_cart_flow está vacía.
function obtenerFlujoEnv() {
  const raw = process.env.WA_FLOW;
  if (!raw) return FLUJO_DEFECTO;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) throw new Error('debe ser un array no vacío');
    return parsed.map((p, i) => {
      const template = String(p.template || '').trim();
      const demoraHoras = Number(p.demoraHoras);
      if (!template) throw new Error(`paso ${i + 1} sin "template"`);
      if (!Number.isFinite(demoraHoras) || demoraHoras < 0) throw new Error(`paso ${i + 1} con "demoraHoras" inválida`);
      return { template, demoraHoras };
    });
  } catch (err) {
    console.error(`[AbandonedCart] ⚠️ WA_FLOW inválido (${err.message}); uso flujo por defecto`);
    return FLUJO_DEFECTO;
  }
}

// Flujo EFECTIVO usado por el motor de envíos. Prioridad:
//   1. Tabla abandoned_cart_flow (editable desde Administración) — solo pasos activos
//   2. env var WA_FLOW / flujo por defecto
async function obtenerFlujo() {
  try {
    const { data, error } = await supabase
      .from('abandoned_cart_flow')
      .select('template, demora_horas')
      .eq('activo', true)
      .order('orden', { ascending: true });

    if (!error && Array.isArray(data) && data.length > 0) {
      return data.map(r => ({ template: r.template, demoraHoras: Number(r.demora_horas) }));
    }
  } catch (err) {
    console.error('[AbandonedCart] ⚠️ Error leyendo abandoned_cart_flow; uso WA_FLOW/default:', err.message);
  }
  return obtenerFlujoEnv();
}

// Devuelve la configuración del flujo para el editor de Administración (incluye
// pasos inactivos y de dónde sale la config: 'db' o 'env').
async function obtenerFlujoConfig() {
  const { data, error } = await supabase
    .from('abandoned_cart_flow')
    .select('*')
    .order('orden', { ascending: true });

  if (error) throw new Error(error.message);

  if (Array.isArray(data) && data.length > 0) {
    return {
      fuente: 'db',
      pasos: data.map(r => ({ template: r.template, demoraHoras: Number(r.demora_horas), activo: r.activo })),
    };
  }
  // Sin filas: devolvemos el flujo efectivo (env/default) como punto de partida editable
  return { fuente: 'env', pasos: obtenerFlujoEnv().map(p => ({ ...p, activo: true })) };
}

// Reemplaza por completo la configuración del flujo con la lista provista.
async function guardarFlujoConfig(pasos) {
  if (!Array.isArray(pasos) || pasos.length === 0) {
    throw new Error('El flujo debe tener al menos un mensaje');
  }

  const filas = pasos.map((p, i) => {
    const template = String(p.template || '').trim();
    const demora = Number(p.demoraHoras);
    if (!template) throw new Error(`El paso ${i + 1} no tiene plantilla`);
    if (!Number.isFinite(demora) || demora < 0) throw new Error(`El paso ${i + 1} tiene una demora inválida`);
    return { orden: i + 1, template, demora_horas: demora, activo: p.activo !== false, updated_at: new Date().toISOString() };
  });

  // Reemplazo total: borrar todo e insertar la lista nueva
  const { error: delErr } = await supabase.from('abandoned_cart_flow').delete().neq('id', 0);
  if (delErr) throw new Error(delErr.message);

  const { error: insErr } = await supabase.from('abandoned_cart_flow').insert(filas);
  if (insErr) throw new Error(insErr.message);

  console.log(`[AbandonedCart] 💾 Flujo actualizado: ${filas.length} pasos`);
  return obtenerFlujoConfig();
}

// Uruguay es GMT-3 fijo (sin horario de verano)
const URUGUAY_OFFSET_MS = -3 * HORA_MS;

// Hora "silenciosa": no enviar mensajes entre las 23:00 y las 09:00 hora Uruguay
const HORA_INICIO = 9;   // 09:00
const HORA_FIN    = 23;  // 23:00

// Retorna true si AHORA está en horario permitido de Uruguay
function esHorarioPermitido() {
  const ahoraUY = new Date(Date.now() + URUGUAY_OFFSET_MS);
  const hora = ahoraUY.getUTCHours(); // usando UTC porque ya sumamos el offset manualmente
  return hora >= HORA_INICIO && hora < HORA_FIN;
}



function primerNombre(nombreCompleto) {
  return String(nombreCompleto || '').trim().split(/\s+/)[0] || 'Cliente';
}

// ─── Captura de contactos vía Pixel de Shopify ───────────────────────────────
// La Admin API censura el PII del cliente (Protected Customer Data), así que el
// teléfono/email/nombre los captura un pixel en el checkout y los guardamos acá.
// Se cruzan con los checkouts por `checkout_token`.

async function guardarCheckoutCapturado({ checkout_token, email, phone, first_name, last_name }) {
  if (!checkout_token) throw new Error('checkout_token requerido');

  // Solo incluimos campos no vacíos para no pisar datos previos con nulls
  const fila = { checkout_token };
  if (email)      fila.email      = email;
  if (phone)      fila.phone      = phone;
  if (first_name) fila.first_name = first_name;
  if (last_name)  fila.last_name  = last_name;

  const { error } = await supabase
    .from('checkout_contacts')
    .upsert(fila, { onConflict: 'checkout_token' });

  if (error) throw new Error(error.message);
  return { ok: true, checkout_token, phone: phone || null };
}

// Busca el contacto capturado por el pixel para un checkout dado
async function buscarContactoCapturado(checkout) {
  const token = checkout.token;
  if (!token) return null;

  const { data, error } = await supabase
    .from('checkout_contacts')
    .select('*')
    .eq('checkout_token', token)
    .maybeSingle();

  if (error) {
    console.error('[AbandonedCart] Error buscando contacto capturado:', error.message);
    return null;
  }
  return data || null;
}

/**
 * Resuelve el contacto final de un checkout combinando todas las fuentes,
 * priorizando lo que capturó el pixel (lo que el cliente escribió en el checkout).
 */
function resolverContacto(checkout, clienteShopify, contactoCapturado) {
  const telefono = (
    contactoCapturado?.phone ||
    shopifyService.extraerTelefonoCliente(clienteShopify) ||
    checkout.phone ||
    checkout.shipping_address?.phone ||
    checkout.billing_address?.phone ||
    null
  );

  const email = (
    contactoCapturado?.email ||
    clienteShopify?.email ||
    checkout.email ||
    null
  );

  const nombrePixel    = `${contactoCapturado?.first_name || ''} ${contactoCapturado?.last_name || ''}`.trim();
  const nombreCliente  = `${clienteShopify?.first_name || ''} ${clienteShopify?.last_name || ''}`.trim();
  const nombreShipping = `${checkout.shipping_address?.first_name || ''} ${checkout.shipping_address?.last_name || ''}`.trim();
  const nombre = nombrePixel || nombreCliente || nombreShipping || email?.split('@')[0] || 'Cliente';

  return { telefono, email, nombre };
}

// ─── Cruce de contactos: carrito ↔ compra concretada ─────────────────────────
// Antes de mandar CUALQUIER mensaje hay que estar seguros de que el cliente no
// compró ya. El cruce se hace contra un índice de compras recientes con tres
// claves, en orden de confiabilidad:
//
//   token:<checkout_token>  el checkout se convirtió en orden (match exacto)
//   cust:<customer_id>      mismo cliente de Shopify, aunque haya usado otro checkout
//   mail:<email> / tel:<8 dígitos>  mismo contacto, aunque haya sido otro cliente
//
// IMPORTANTE — Protected Customer Data: la Admin API devuelve las órdenes y los
// customers con el PII censurado (email, phone, nombre y calle vienen vacíos)
// mientras la app no tenga aprobado el acceso a datos protegidos. Por eso el
// email/teléfono de una compra NO se lee de la orden: se recupera de
// `checkout_contacts` (lo que capturó el pixel en el checkout) cruzando por el
// `checkout_token` de la orden. Si algún día se aprueba el acceso al PII, los
// campos de la orden se usan igual y suman cobertura sin tocar nada.

// Ventana de órdenes a consultar. Alineada con los 7 días que muestra el panel,
// para poder reconciliar también carritos viejos que siguen en la DB y ya no
// vuelven en /checkouts.json.
const VENTANA_ORDENES_HORAS = 24 * 7;

// Una compra cuenta como recuperación de un carrito si ocurrió después del
// abandono. El margen tolera que checkout.updated_at se mueva alrededor del
// momento en que se creó la orden.
const MARGEN_COMPRA_MS = 6 * HORA_MS;

function normalizarEmail(email) {
  return String(email || '').trim().toLowerCase() || null;
}

// Últimos 8 dígitos: descarta prefijo de país / 0 inicial y ruido de formato
function normalizarTelefono(tel) {
  const digitos = String(tel || '').replace(/\D/g, '');
  return digitos.length >= 8 ? digitos.slice(-8) : null;
}

// Claves de identidad de un contacto, de la más confiable a la menos.
function clavesContacto({ token, customerId, emails = [], telefonos = [] }) {
  const claves = [];
  if (token) claves.push(`token:${token}`);
  if (customerId) claves.push(`cust:${customerId}`);
  for (const e of emails) {
    const n = normalizarEmail(e);
    if (n) claves.push(`mail:${n}`);
  }
  for (const t of telefonos) {
    const n = normalizarTelefono(t);
    if (n) claves.push(`tel:${n}`);
  }
  return [...new Set(claves)];
}

// Trae de `checkout_contacts` lo que capturó el pixel para una lista de tokens.
// Devuelve Map<checkout_token, {email, phone}>.
async function cargarContactosPorToken(tokens) {
  const mapa = new Map();
  const unicos = [...new Set((tokens || []).filter(Boolean))];
  const LOTE = 200;

  for (let i = 0; i < unicos.length; i += LOTE) {
    const { data, error } = await supabase
      .from('checkout_contacts')
      .select('checkout_token, email, phone')
      .in('checkout_token', unicos.slice(i, i + LOTE));

    // FAIL-CLOSED: sin estos contactos no podemos saber quién compró (el PII de
    // la orden viene censurado), así que el error se propaga y no se envía nada.
    if (error) throw new Error(`No se pudieron leer los contactos del pixel: ${error.message}`);
    for (const row of data || []) mapa.set(row.checkout_token, row);
  }

  return mapa;
}

// Índice Map<clave, timestamp de la compra más reciente con esa clave>.
function construirIndiceCompras(ordenes, contactosPorToken = new Map()) {
  const indice = new Map();
  let conPII = 0;
  let conPixel = 0;

  for (const o of ordenes || []) {
    const ts = o.created_at ? new Date(o.created_at).getTime() : Date.now();
    const capturado = o.checkout_token ? contactosPorToken.get(o.checkout_token) : null;
    if (capturado) conPixel++;

    const emailsOrden = [o.email, o.contact_email, o.customer?.email];
    const telefonosOrden = [o.phone, o.customer?.phone, o.shipping_address?.phone, o.billing_address?.phone];
    if (emailsOrden.some(Boolean) || telefonosOrden.some(Boolean)) conPII++;

    const claves = clavesContacto({
      token:      o.checkout_token,
      customerId: o.customer?.id,
      emails:     [...emailsOrden, capturado?.email],
      telefonos:  [...telefonosOrden, capturado?.phone],
    });

    for (const clave of claves) {
      if ((indice.get(clave) || 0) < ts) indice.set(clave, ts);
    }
  }

  const total = (ordenes || []).length;
  if (total > 0 && conPII === 0) {
    console.log('[AbandonedCart] ℹ️ Shopify censura el PII de las órdenes (Protected Customer Data): el cruce por email/teléfono usa los contactos del pixel');
  }

  return { indice, total, conPII, conPixel };
}

// ─── Segunda fuente: nuestra propia tabla de pedidos ─────────────────────────
// Shopify censura el PII, pero `pedidos` guarda el email y el teléfono reales
// del comprador. Sirve de red de seguridad: si el índice de Shopify no encontró
// la compra (por ejemplo porque el pixel no llegó a capturar ese checkout),
// buscamos igual un pedido nuestro reciente con el mismo contacto.
const VENTANA_PEDIDOS_LOCALES_HORAS = 24;

// Postgres devuelve las columnas `timestamp` sin zona horaria; siempre las
// guardamos en UTC, así que se lo indicamos explícitamente al parsear.
function parseFechaDB(valor) {
  if (!valor) return NaN;
  const s = String(valor);
  const tieneZona = /[Zz]$|[+-]\d{2}:?\d{2}$/.test(s);
  return new Date(tieneZona ? s : `${s}Z`).getTime();
}

// Índice Map<clave, timestamp> de los pedidos propios de las últimas `horas`.
async function construirIndicePedidosLocales(horas = VENTANA_PEDIDOS_LOCALES_HORAS) {
  const desde = new Date(Date.now() - horas * HORA_MS).toISOString();

  const { data, error } = await supabase
    .from('pedidos')
    .select('numero_pedido, cliente_email, cliente_telefono, created_at')
    .gte('created_at', desde);

  // FAIL-CLOSED: es una de las fuentes que decide si alguien ya compró.
  if (error) throw new Error(`No se pudieron leer los pedidos locales: ${error.message}`);

  const indice = new Map();
  for (const p of data || []) {
    const ts = parseFechaDB(p.created_at) || Date.now();
    const claves = clavesContacto({ emails: [p.cliente_email], telefonos: [p.cliente_telefono] });
    for (const clave of claves) {
      if ((indice.get(clave) || 0) < ts) indice.set(clave, ts);
    }
  }

  return { indice, total: (data || []).length };
}

// Si el contacto ya compró, devuelve { clave, ts, fuente }; si no, null.
// `abandonadoEn` (ISO o ms) descarta compras anteriores al abandono del carrito.
// Primero mira las órdenes de Shopify; si ahí no hay match, cae a los pedidos
// de nuestra DB de las últimas VENTANA_PEDIDOS_LOCALES_HORAS horas.
function buscarCompra(compras, claves, abandonadoEn) {
  const abandonoMs = abandonadoEn ? new Date(abandonadoEn).getTime() : NaN;

  const fuentes = [
    { nombre: 'shopify', indice: compras?.indice },
    { nombre: 'pedidos', indice: compras?.indiceLocal },
  ];

  for (const { nombre, indice } of fuentes) {
    if (!indice) continue;
    for (const clave of claves) {
      const ts = indice.get(clave);
      if (ts === undefined) continue;
      if (Number.isFinite(abandonoMs) && ts < abandonoMs - MARGEN_COMPRA_MS) continue; // compra vieja
      return { clave, ts, fuente: nombre };
    }
  }

  return null;
}

// Claves de un carrito, tomando datos del checkout de Shopify y/o de la fila en DB.
function clavesDeCarrito({ token, customerId, email, telefono }) {
  return clavesContacto({ token, customerId, emails: [email], telefonos: [telefono] });
}

// ─── Columna opcional shopify_customer_id ────────────────────────────────────
// Se agrega con sql/add_shopify_customer_id_to_abandoned_carts.sql. Mientras no
// esté aplicada, degradamos al cruce por token/email/teléfono en vez de romper.
let soportaCustomerId = true;

function esColumnaFaltante(error) {
  return !!error && (error.code === '42703' || /shopify_customer_id/i.test(error.message || ''));
}

// Upsert de un carrito que tolera que la columna shopify_customer_id no exista.
async function upsertCarrito(fila, select = '*') {
  const conCustomer = { ...fila };
  if (!soportaCustomerId) delete conCustomer.shopify_customer_id;

  let { data, error } = await supabase
    .from('abandoned_carts')
    .upsert(conCustomer, { onConflict: 'shopify_checkout_id' })
    .select(select)
    .single();

  if (error && esColumnaFaltante(error) && soportaCustomerId) {
    soportaCustomerId = false;
    console.warn('[AbandonedCart] ⚠️ Falta la columna shopify_customer_id (correr sql/add_shopify_customer_id_to_abandoned_carts.sql); sigo sin ella');
    const { shopify_customer_id, ...sinCustomer } = fila;
    ({ data, error } = await supabase
      .from('abandoned_carts')
      .upsert(sinCustomer, { onConflict: 'shopify_checkout_id' })
      .select(select)
      .single());
  }

  return { data, error };
}

/**
 * Prepara la verificación de compras, con dos fuentes independientes:
 *   1. Órdenes recientes de Shopify + contactos capturados por el pixel.
 *   2. Nuestra tabla `pedidos` de las últimas 24h (fallback: ahí el email y el
 *      teléfono no vienen censurados).
 *
 * Lanza si Shopify o Supabase no responden: quien envía mensajes DEBE poder
 * distinguir "no compró" de "no pude verificar".
 */
async function construirVerificacionCompras(horas = VENTANA_ORDENES_HORAS) {
  const ordenes = await shopifyService.obtenerOrdenesRecientes(horas);
  const contactosPorToken = await cargarContactosPorToken(ordenes.map(o => o.checkout_token));
  const compras = construirIndiceCompras(ordenes, contactosPorToken);

  const local = await construirIndicePedidosLocales();
  compras.indiceLocal = local.indice;
  compras.totalPedidosLocales = local.total;

  const porTipo = (indice, p) => [...indice.keys()].filter(k => k.startsWith(p)).length;
  console.log(
    `[AbandonedCart] 🧾 ${compras.total} órdenes ${horas}h → claves: ` +
    `${porTipo(compras.indice, 'token:')} token · ${porTipo(compras.indice, 'cust:')} cliente · ` +
    `${porTipo(compras.indice, 'mail:')} email · ${porTipo(compras.indice, 'tel:')} tel ` +
    `(pixel: ${compras.conPixel}/${compras.total}, PII de Shopify: ${compras.conPII}/${compras.total})`
  );
  console.log(
    `[AbandonedCart] 🗂 Fallback pedidos propios ${VENTANA_PEDIDOS_LOCALES_HORAS}h: ${local.total} pedidos → ` +
    `${porTipo(local.indice, 'mail:')} email · ${porTipo(local.indice, 'tel:')} tel`
  );

  return compras;
}

/**
 * Marca como recuperados los carritos que ya están en la DB, no figuran como
 * recuperados y cuyo contacto SÍ aparece en una compra reciente.
 *
 * Es imprescindible además del chequeo por checkout: /checkouts.json solo
 * devuelve los checkouts todavía abiertos, así que un carrito que se convirtió
 * en orden desaparece de Shopify y quedaría para siempre en la cola de envío.
 */
async function reconciliarRecuperadosDB(compras) {
  const desde = new Date(Date.now() - VENTANA_ORDENES_HORAS * HORA_MS).toISOString();

  let columnas = 'id, shopify_checkout_id, cliente_email, cliente_telefono, abandoned_at';
  if (soportaCustomerId) columnas += ', shopify_customer_id';

  let { data: carritos, error } = await supabase
    .from('abandoned_carts')
    .select(columnas)
    .not('recovered', 'is', true)
    .gte('abandoned_at', desde);

  if (error && esColumnaFaltante(error) && soportaCustomerId) {
    soportaCustomerId = false;
    ({ data: carritos, error } = await supabase
      .from('abandoned_carts')
      .select('id, shopify_checkout_id, cliente_email, cliente_telefono, abandoned_at')
      .not('recovered', 'is', true)
      .gte('abandoned_at', desde));
  }

  if (error) throw new Error(`No se pudo reconciliar carritos recuperados: ${error.message}`);

  const idsRecuperados = [];
  for (const c of carritos || []) {
    const claves = clavesDeCarrito({
      customerId: c.shopify_customer_id,
      email:      c.cliente_email,
      telefono:   c.cliente_telefono,
    });
    const compra = buscarCompra(compras, claves, c.abandoned_at);
    if (compra) {
      idsRecuperados.push(c.id);
      console.log(`[AbandonedCart] ✅ Ya compró (${compra.fuente}/${compra.clave}) → carrito ${c.shopify_checkout_id} marcado recuperado`);
    }
  }

  if (idsRecuperados.length > 0) {
    const { error: updErr } = await supabase
      .from('abandoned_carts')
      .update({ recovered: true })
      .in('id', idsRecuperados);
    if (updErr) throw new Error(`No se pudo marcar recuperados: ${updErr.message}`);
  }

  console.log(`[AbandonedCart] 🔄 Reconciliación DB: ${idsRecuperados.length}/${(carritos || []).length} carritos marcados como recuperados`);
  return idsRecuperados.length;
}

/**
 * Determina qué paso del flujo enviar a un carrito, respetando el orden y las
 * demoras configuradas en `flujo`. Los pasos se mandan de a uno y en secuencia.
 *
 * Retorna el número de paso (1-indexado) o null si no hay nada para enviar
 * todavía (la demora aún no se cumplió, o el flujo ya está completo).
 */
function determinarPaso(carrito, ahora, flujo) {
  const enviados = carrito.pasos_enviados || {};

  for (let i = 0; i < flujo.length; i++) {
    const paso = i + 1;
    if (enviados[paso]) continue; // ya enviado → mirar el siguiente

    // Primer paso pendiente. Tiempo de referencia: el abandono (paso 1) o el
    // momento en que se envió el paso anterior.
    const refIso = i === 0 ? carrito.abandoned_at : enviados[paso - 1];
    if (!refIso) return null; // el paso anterior aún no salió → esperar

    const transcurrido = ahora - new Date(refIso).getTime();
    return transcurrido >= flujo[i].demoraHoras * HORA_MS ? paso : null;
  }

  return null; // flujo completo
}

function buildParams(carrito) {
  return {
    nombre:  primerNombre(carrito.cliente_nombre),
    cartUrl: carrito.abandoned_checkout_url || '',
  };
}

async function procesarCarritosAbandonados() {
  const ahora = Date.now();

  // El ciclo SIEMPRE sincroniza los carritos desde Shopify. El ENVÍO de WhatsApp
  // solo ocurre en horario permitido Uruguay (09:00–23:00); fuera de eso, se
  // sincroniza igual pero no se manda nada.
  const enHorario = esHorarioPermitido();
  if (!enHorario) {
    const ahoraUY = new Date(Date.now() + URUGUAY_OFFSET_MS);
    console.log(`[AbandonedCart] 🌙 Fuera de horario Uruguay (${ahoraUY.getUTCHours()}:${String(ahoraUY.getUTCMinutes()).padStart(2,'0')} UY) — solo sincronizo, sin enviar`);
  }

  const flujo = await obtenerFlujo();
  console.log(`[AbandonedCart] ⏱ Iniciando ciclo de recuperación... (flujo de ${flujo.length} mensajes)`);

  // 1. Obtener carritos activos de Shopify (últimas 48h)
  let checkouts;
  try {
    checkouts = await shopifyService.obtenerCarritosAbandonados();
  } catch (err) {
    console.error('[AbandonedCart] ❌ Error obteniendo checkouts de Shopify:', err.message);
    return { procesados: 0, enviados: 0, error: err.message };
  }
  console.log(`[AbandonedCart] 🛒 ${checkouts.length} carritos recibidos de Shopify`);

  // Índice de compras recientes (token / cliente / email / teléfono) y limpieza
  // de los carritos que ya están en la DB y ya compraron.
  //
  // FAIL-CLOSED: si Shopify o Supabase no responden no podemos garantizar que el
  // cliente NO haya comprado, así que NO enviamos ningún mensaje este ciclo y
  // devolvemos `verificacionFallida` para que el llamador reintente en unos minutos.
  let compras;
  try {
    compras = await construirVerificacionCompras();
    await reconciliarRecuperadosDB(compras);
  } catch (err) {
    console.error(`[AbandonedCart] ⛔ No pude verificar compras recientes; NO envío este ciclo: ${err.message}`);
    return { procesados: checkouts.length, enviados: 0, error: err.message, verificacionFallida: true };
  }

  let enviados = 0;

  for (const checkout of checkouts) {
    // Enriquecer con datos del cliente via Shopify API + pixel
    const customerId = checkout.customer?.id;
    const clienteShopify = customerId ? await shopifyService.obtenerCliente(customerId) : null;
    const contactoCapturado = await buscarContactoCapturado(checkout);

    const { telefono, email: emailCliente, nombre: nombreCliente } =
      resolverContacto(checkout, clienteShopify, contactoCapturado);

    if (!telefono) {
      console.log(`[AbandonedCart] ⚠️ Sin teléfono → checkout ${checkout.id}`);
      continue;
    }

    // 2. Upsert en Supabase
    const { data: carrito, error: upsertErr } = await upsertCarrito({
      shopify_checkout_id:    String(checkout.id),
      shopify_customer_id:    customerId ? String(customerId) : null,
      abandoned_checkout_url: checkout.abandoned_checkout_url,
      cliente_nombre:         nombreCliente,
      cliente_email:          emailCliente,
      cliente_telefono:       telefono,
      total_price:            parseFloat(checkout.total_price || 0),
      currency:               checkout.currency || 'UYU',
      line_items:             checkout.line_items || [],
      abandoned_at:           checkout.updated_at,
      last_checked_at:        new Date().toISOString(),
    });

    if (upsertErr) {
      console.error(`[AbandonedCart] ❌ Upsert error ${checkout.id}:`, upsertErr.message);
      continue;
    }

    if (carrito.recovered) continue;

    // 2.b Antes de mandar CUALQUIER mensaje: si este checkout ya se convirtió en
    // orden, o si el mismo cliente/contacto compró después de abandonar (aunque
    // haya sido con otro checkout), lo damos por recuperado y no le escribimos.
    const compra = buscarCompra(
      compras,
      clavesDeCarrito({
        token:      checkout.token,
        customerId,
        email:      emailCliente,
        telefono,
      }),
      checkout.updated_at
    );

    if (compra) {
      console.log(`[AbandonedCart] ✅ Ya compró (${compra.fuente}/${compra.clave}) → ${checkout.id} — marcado recuperado, no se le escribe`);
      await supabase
        .from('abandoned_carts')
        .update({ recovered: true })
        .eq('shopify_checkout_id', String(checkout.id));
      continue;
    }

    // De acá en adelante es el ENVÍO. Fuera de horario el carrito ya quedó
    // sincronizado arriba, pero no mandamos ningún mensaje.
    if (!enHorario) continue;

    // 3. Determinar qué paso del flujo enviar
    const pasoNum = determinarPaso(carrito, ahora, flujo);
    if (!pasoNum) continue;

    // Interruptor de seguridad: si el envío automático no está activo,
    // sincronizamos los carritos pero NO mandamos WhatsApp.
    if (process.env.CARRITOS_ENVIO_ACTIVO !== 'true') {
      console.log(`[AbandonedCart] 🔌 Envío desactivado (CARRITOS_ENVIO_ACTIVO≠true) — Paso ${pasoNum} a ${carrito.cliente_telefono} OMITIDO`);
      continue;
    }

    const templateName = flujo[pasoNum - 1].template;
    const { nombre, cartUrl } = buildParams(carrito);

    // 4. Enviar vía Kommo WhatsApp
    try {
      await kommoWhatsApp.enviarTemplate({
        telefono: carrito.cliente_telefono,
        templateName,
        nombre,
        cartUrl,
      });

      // 5. Registrar envío en DB (merge sobre los pasos ya enviados)
      const pasosEnviados = { ...(carrito.pasos_enviados || {}), [pasoNum]: new Date().toISOString() };
      await supabase
        .from('abandoned_carts')
        .update({ pasos_enviados: pasosEnviados })
        .eq('shopify_checkout_id', carrito.shopify_checkout_id);

      enviados++;
      console.log(
        `[AbandonedCart] ✅ Paso ${pasoNum}/${flujo.length} → ${carrito.cliente_nombre} (${carrito.cliente_telefono}) | ${templateName}`
      );
    } catch (sendErr) {
      console.error(
        `[AbandonedCart] ❌ Error paso ${pasoNum} a ${carrito.cliente_telefono}:`,
        sendErr.message
      );
    }
  }

  console.log(`[AbandonedCart] 🏁 Ciclo finalizado. Enviados: ${enviados}/${checkouts.length}`);
  return { procesados: checkouts.length, enviados };
}

// Llamar cuando el cliente completa la compra para no seguir enviando mensajes
async function marcarComoRecuperado(shopifyCheckoutId) {
  const { error } = await supabase
    .from('abandoned_carts')
    .update({ recovered: true })
    .eq('shopify_checkout_id', String(shopifyCheckoutId));

  if (error) {
    console.error('[AbandonedCart] Error marcando como recuperado:', error.message);
  }
}

// Solo sincroniza carritos desde Shopify a la DB, sin enviar mensajes
async function sincronizarDesdeShopify() {
  console.log('[AbandonedCart] ▶ sincronizarDesdeShopify() iniciado');
  const checkouts = await shopifyService.obtenerCarritosAbandonados();
  console.log(`[AbandonedCart] ${checkouts.length} checkouts recibidos de Shopify`);

  // Índice de compras recientes (token / cliente / email / teléfono). Si falla,
  // se propaga: sin verificación no se puede armar una cola de envío confiable.
  const compras = await construirVerificacionCompras();

  // Los carritos que ya compraron dejan de aparecer en /checkouts.json, así que
  // hay que reconciliarlos contra la DB además de contra los checkouts abiertos.
  const reconciliadosDB = await reconciliarRecuperadosDB(compras);

  let nuevos = 0;
  let actualizados = 0;
  let conTelefono = 0;
  let sinTelefono = 0;
  let recuperados = 0;

  for (const checkout of checkouts) {
    // Obtener datos del cliente via API de Shopify
    const customerId = checkout.customer?.id;
    let cliente = null;

    if (customerId) {
      cliente = await shopifyService.obtenerCliente(customerId);
    }

    // Cruzar con lo capturado por el pixel (donde sí está el teléfono real)
    const contactoCapturado = await buscarContactoCapturado(checkout);
    const { telefono, email, nombre } = resolverContacto(checkout, cliente, contactoCapturado);

    // Recuperado si el checkout se volvió orden, o si el mismo cliente/contacto
    // compró después de haber abandonado este carrito.
    const compra = buscarCompra(
      compras,
      clavesDeCarrito({ token: checkout.token, customerId, email, telefono }),
      checkout.updated_at
    );
    const recuperado = !!compra;

    if (telefono) conTelefono++; else sinTelefono++;
    if (recuperado) recuperados++;

    console.log(`[Sync] checkout:${checkout.id} tel:${telefono || 'sin_telefono'} recuperado:${recuperado}${compra ? ` (${compra.fuente}/${compra.clave})` : ''} (pixel:${contactoCapturado ? 'sí' : 'no'})`);

    // Guardamos TODOS los carritos (con y sin teléfono) para verlos en el panel.
    // Los que no tienen teléfono quedan visibles pero no mensajeables.
    const fila = {
      shopify_checkout_id:    String(checkout.id),
      shopify_customer_id:    customerId ? String(customerId) : null,
      abandoned_checkout_url: checkout.abandoned_checkout_url,
      cliente_nombre:         nombre,
      cliente_email:          email,
      cliente_telefono:       telefono,
      total_price:            parseFloat(checkout.total_price || 0),
      currency:               checkout.currency || 'UYU',
      line_items:             checkout.line_items || [],
      abandoned_at:           checkout.updated_at,
      last_checked_at:        new Date().toISOString(),
    };
    // Solo seteamos recovered cuando lo detectamos, para no "des-recuperar" nada
    if (recuperado) fila.recovered = true;

    const { error, data } = await upsertCarrito(fila, 'id, created_at, updated_at');

    if (!error) {
      const isNew = data.created_at === data.updated_at;
      isNew ? nuevos++ : actualizados++;
    } else {
      console.error('[AbandonedCart] Upsert error:', error.message);
    }
  }

  console.log(`[AbandonedCart] Sync: ${nuevos} nuevos, ${actualizados} actualizados | ${conTelefono} con tel, ${sinTelefono} sin tel, ${recuperados} recuperados (+${reconciliadosDB} reconciliados en DB)`);
  return { total: checkouts.length, nuevos, actualizados, conTelefono, sinTelefono, recuperados, reconciliadosDB };
}

// Envía un mensaje de prueba de un paso del flujo a un carrito (por UUID de DB), ignorando restricción horaria
async function probarMensaje(cartId, pasoNum) {
  const flujo = await obtenerFlujo();
  const paso = flujo[pasoNum - 1];
  if (!paso) throw new Error(`Paso ${pasoNum} fuera del flujo (tiene ${flujo.length} pasos)`);

  const { data: carrito, error } = await supabase
    .from('abandoned_carts')
    .select('*')
    .eq('id', cartId)
    .single();

  if (error || !carrito) throw new Error('Carrito no encontrado');
  if (!carrito.cliente_telefono) throw new Error('El carrito no tiene teléfono registrado');
  // Última barrera antes de mandar: nunca escribirle a quien ya compró.
  if (carrito.recovered) throw new Error('El carrito ya fue recuperado (el cliente compró): no se envía');

  const templateName = paso.template;
  const nombre  = primerNombre(carrito.cliente_nombre);
  const cartUrl = carrito.abandoned_checkout_url || '';

  await kommoWhatsApp.enviarTemplate({ telefono: carrito.cliente_telefono, templateName, nombre, cartUrl });

  // Registrar en DB (merge sobre los pasos ya enviados)
  const pasosEnviados = { ...(carrito.pasos_enviados || {}), [pasoNum]: new Date().toISOString() };
  await supabase
    .from('abandoned_carts')
    .update({ pasos_enviados: pasosEnviados })
    .eq('id', cartId);

  console.log(`[AbandonedCart] 🧪 Prueba paso ${pasoNum} → ${carrito.cliente_nombre} (${carrito.cliente_telefono}) | ${templateName}`);
  return { carrito: carrito.cliente_nombre, telefono: carrito.cliente_telefono, templateName, paso: pasoNum };
}

// Crea un carrito de prueba manual en la DB para verificar que los mensajes llegan.
// Genera un shopify_checkout_id sintético y, si no se pasa link, un link aleatorio
// con el formato de una URL de recuperación de Shopify (path + query parseables).
async function crearCarritoManual({ telefono, nombre, cartUrl } = {}) {
  if (!telefono) throw new Error('Teléfono requerido');

  const rand = (n) => Math.random().toString(36).slice(2, 2 + n);
  const url = cartUrl ||
    `https://velinneuy.com/checkouts/cn/${rand(12)}/recover?key=${rand(16)}&locale=es-UY`;

  const fila = {
    shopify_checkout_id:    `manual-${Date.now()}`,
    abandoned_checkout_url: url,
    cliente_nombre:         nombre || 'Prueba',
    cliente_email:          null,
    cliente_telefono:       telefono,
    total_price:            0,
    currency:               'UYU',
    line_items:             [],
    abandoned_at:           new Date().toISOString(),
    last_checked_at:        new Date().toISOString(),
  };

  const { data, error } = await supabase
    .from('abandoned_carts')
    .upsert(fila, { onConflict: 'shopify_checkout_id' })
    .select()
    .single();

  if (error) throw new Error(error.message);
  console.log(`[AbandonedCart] 🧪 Carrito manual creado → ${telefono} | ${url}`);
  return data;
}

async function obtenerCarritosDB() {
  const desde7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const { data: carritos, error } = await supabase
    .from('abandoned_carts')
    .select('*')
    .gte('abandoned_at', desde7d)
    .order('abandoned_at', { ascending: false });

  if (error) throw error;

  const flujo = await obtenerFlujo();
  const totalPasos = flujo.length;
  const nEnviados = (c) => Object.keys(c.pasos_enviados || {}).length;

  const stats = {
    total:         carritos.length,
    sin_contactar: carritos.filter(c => nEnviados(c) === 0 && !c.recovered && c.cliente_telefono).length,
    en_flujo:      carritos.filter(c => nEnviados(c) > 0 && nEnviados(c) < totalPasos && !c.recovered).length,
    recuperados:   carritos.filter(c => c.recovered).length,
    sin_telefono:  carritos.filter(c => !c.cliente_telefono && !c.recovered).length,
  };

  return { carritos, stats, flujo };
}

// Próximo paso pendiente (1-indexado) de un carrito según el total de pasos del
// flujo, o null si ya recibió todos.
function proximoPasoPendiente(carrito, totalPasos) {
  const enviados = carrito.pasos_enviados || {};
  for (let n = 1; n <= totalPasos; n++) {
    if (!enviados[n]) return n;
  }
  return null;
}

/**
 * Revisa todos los carritos y arma la cola de envío:
 *  1. Sincroniza con Shopify → marca RECUPERADOS los que ya completaron la compra
 *     (por token de orden o por contacto que compró en las últimas 24h).
 *  2. Devuelve la "cola": carritos con teléfono, NO recuperados y con pasos del
 *     flujo pendientes, cada uno con el próximo paso que le toca.
 *
 * No envía nada: solo reconcilia y reporta a quién habría que escribirle.
 */
async function revisarYEncolar() {
  const sync = await sincronizarDesdeShopify(); // reconcilia recuperados desde Shopify

  const { carritos, flujo } = await obtenerCarritosDB();
  const totalPasos = flujo.length;
  const nEnviados = (c) => Object.keys(c.pasos_enviados || {}).length;

  const enCola = carritos
    .filter(c => c.cliente_telefono && !c.recovered && nEnviados(c) < totalPasos)
    .map(c => ({
      id:            c.id,
      nombre:        c.cliente_nombre,
      telefono:      c.cliente_telefono,
      pasosEnviados: nEnviados(c),
      proximoPaso:   proximoPasoPendiente(c, totalPasos),
    }));

  const resumen = {
    totalPasos,
    revisados:    carritos.length,
    yaCompraron:  carritos.filter(c => c.recovered).length,        // recuperados
    sinTelefono:  carritos.filter(c => !c.cliente_telefono && !c.recovered).length,
    enColaTotal:  enCola.length,
    enCola,
    sync,
  };

  console.log(`[AbandonedCart] 🔎 Revisión: ${resumen.revisados} revisados · ${resumen.yaCompraron} ya compraron · ${resumen.enColaTotal} en cola para enviar link`);
  return resumen;
}

/**
 * Envía el PRÓXIMO paso pendiente del flujo (normalmente el link de recuperación)
 * a TODOS los carritos en cola. Acción manual y explícita: ignora la restricción
 * horaria y el interruptor CARRITOS_ENVIO_ACTIVO. Antes de enviar vuelve a revisar
 * Shopify (vía revisarYEncolar) para no escribirle a quien ya compró.
 *
 * @param {number} [limite] - Máximo de carritos a los que enviar (para tandas/pruebas)
 */
async function enviarLinkAPendientes({ limite } = {}) {
  const { enCola } = await revisarYEncolar();

  // Deduplicar por teléfono: un mismo cliente puede tener varios checkouts
  // abandonados; solo le mandamos UNA vez (nos quedamos con el más reciente, que
  // viene primero porque la cola está ordenada por abandoned_at desc).
  const vistos = new Set();
  const unicos = [];
  let duplicados = 0;
  for (const item of enCola) {
    const key = normalizarTelefono(item.telefono);
    if (key && vistos.has(key)) { duplicados++; continue; }
    if (key) vistos.add(key);
    unicos.push(item);
  }
  if (duplicados) console.log(`[AbandonedCart] 🔁 ${duplicados} carritos duplicados por teléfono omitidos del envío`);

  const objetivos = Number.isFinite(limite) && limite > 0 ? unicos.slice(0, limite) : unicos;

  let enviados = 0;
  const errores = [];

  for (const item of objetivos) {
    if (!item.proximoPaso) continue;
    try {
      // probarMensaje ya envía el template + registra el paso en pasos_enviados,
      // así el carrito avanza en el flujo y no se le reenvía el mismo mensaje.
      await probarMensaje(item.id, item.proximoPaso);
      enviados++;
    } catch (err) {
      errores.push({ id: item.id, nombre: item.nombre, telefono: item.telefono, error: err.message });
      console.error(`[AbandonedCart] ❌ Envío en cola falló → ${item.telefono}: ${err.message}`);
    }
  }

  console.log(`[AbandonedCart] ✉️ Cola procesada: ${enviados}/${objetivos.length} enviados · ${errores.length} con error · ${duplicados} duplicados omitidos`);
  return { enCola: enCola.length, duplicados, intentados: objetivos.length, enviados, errores };
}

module.exports = {
  procesarCarritosAbandonados, marcarComoRecuperado, sincronizarDesdeShopify, probarMensaje,
  crearCarritoManual, obtenerCarritosDB, obtenerFlujo, obtenerFlujoConfig, guardarFlujoConfig,
  guardarCheckoutCapturado, revisarYEncolar, enviarLinkAPendientes,
  // Expuestas para diagnóstico/tests del cruce carrito ↔ compra
  construirVerificacionCompras, construirIndicePedidosLocales, reconciliarRecuperadosDB,
  buscarCompra, clavesDeCarrito,
};

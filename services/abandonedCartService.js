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

  // Tokens de carritos YA recuperados (convertidos en orden) — para no escribirle a quien ya compró
  const tokensRecuperados = await shopifyService.obtenerTokensRecuperados();
  console.log(`[AbandonedCart] 🧾 ${tokensRecuperados.size} órdenes recientes (carritos recuperados)`);

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
    const { data: carrito, error: upsertErr } = await supabase
      .from('abandoned_carts')
      .upsert(
        {
          shopify_checkout_id:    String(checkout.id),
          abandoned_checkout_url: checkout.abandoned_checkout_url,
          cliente_nombre:         nombreCliente,
          cliente_email:          emailCliente,
          cliente_telefono:       telefono,
          total_price:            parseFloat(checkout.total_price || 0),
          currency:               checkout.currency || 'UYU',
          line_items:             checkout.line_items || [],
          abandoned_at:           checkout.updated_at,
          last_checked_at:        new Date().toISOString(),
        },
        { onConflict: 'shopify_checkout_id' }
      )
      .select()
      .single();

    if (upsertErr) {
      console.error(`[AbandonedCart] ❌ Upsert error ${checkout.id}:`, upsertErr.message);
      continue;
    }

    if (carrito.recovered) continue;

    // 2.b Validar que el carrito NO se haya recuperado (orden creada con ese token)
    if (tokensRecuperados.has(checkout.token)) {
      console.log(`[AbandonedCart] ✅ Carrito recuperado (orden existe) → ${checkout.id} — marcado y omitido`);
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

  // Tokens de carritos ya recuperados (convertidos en orden)
  const tokensRecuperados = await shopifyService.obtenerTokensRecuperados();

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
    const recuperado = tokensRecuperados.has(checkout.token);

    if (telefono) conTelefono++; else sinTelefono++;
    if (recuperado) recuperados++;

    console.log(`[Sync] checkout:${checkout.id} tel:${telefono || 'sin_telefono'} recuperado:${recuperado} (pixel:${contactoCapturado ? 'sí' : 'no'})`);

    // Guardamos TODOS los carritos (con y sin teléfono) para verlos en el panel.
    // Los que no tienen teléfono quedan visibles pero no mensajeables.
    const fila = {
      shopify_checkout_id:    String(checkout.id),
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

    const { error, data } = await supabase
      .from('abandoned_carts')
      .upsert(fila, { onConflict: 'shopify_checkout_id' })
      .select('id, created_at, updated_at')
      .single();

    if (!error) {
      const isNew = data.created_at === data.updated_at;
      isNew ? nuevos++ : actualizados++;
    } else {
      console.error('[AbandonedCart] Upsert error:', error.message);
    }
  }

  console.log(`[AbandonedCart] Sync: ${nuevos} nuevos, ${actualizados} actualizados | ${conTelefono} con tel, ${sinTelefono} sin tel, ${recuperados} recuperados`);
  return { total: checkouts.length, nuevos, actualizados, conTelefono, sinTelefono, recuperados };
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
  const desde72h = new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString();
  const { data: carritos, error } = await supabase
    .from('abandoned_carts')
    .select('*')
    .gte('abandoned_at', desde72h)
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

module.exports = { procesarCarritosAbandonados, marcarComoRecuperado, sincronizarDesdeShopify, probarMensaje, crearCarritoManual, obtenerCarritosDB, obtenerFlujo, obtenerFlujoConfig, guardarFlujoConfig, guardarCheckoutCapturado };

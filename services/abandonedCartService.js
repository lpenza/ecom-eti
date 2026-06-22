const { createClient } = require('@supabase/supabase-js');
const shopifyService = require('./shopifyService');
const kommoWhatsApp = require('./kommoWhatsAppService');
require('dotenv').config();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Nombres técnicos de las plantillas — verificar en Kommo → WhatsApp → Plantillas
const TEMPLATE = {
  1: process.env.WA_TEMPLATE_CARRITO_1 || 'intento_abandonado_v1',
  2: process.env.WA_TEMPLATE_CARRITO_2 || 'intento_carrito_abandonado_1',
};

const HORA_MS = 60 * 60 * 1000;

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
 * Determina qué mensaje enviar según el estado del carrito:
 *
 *  Msg 1 → Carrito abandonado hace al menos 1h y msg1 todavía no fue enviado
 *  Msg 2 → Msg 1 ya fue enviado hace al menos 12h y msg2 todavía no fue enviado
 *
 * Retorna 1, 2, o null (nada que enviar).
 */
function determinarMensaje(carrito, ahora) {
  const desde_abandono = ahora - new Date(carrito.abandoned_at).getTime();

  // Msg 1: primer contacto, mínimo 1 hora después del abandono
  if (!carrito.msg1_sent_at && desde_abandono >= 1 * HORA_MS) {
    return 1;
  }

  // Msg 2: 12 horas después de que se envió el msg1
  if (carrito.msg1_sent_at && !carrito.msg2_sent_at) {
    const desde_msg1 = ahora - new Date(carrito.msg1_sent_at).getTime();
    if (desde_msg1 >= 12 * HORA_MS) {
      return 2;
    }
  }

  return null;
}

function buildParams(carrito) {
  return {
    nombre:  primerNombre(carrito.cliente_nombre),
    cartUrl: carrito.abandoned_checkout_url || '',
  };
}

async function procesarCarritosAbandonados() {
  const ahora = Date.now();

  // Respetar horario Uruguay: no enviar entre 23:00 y 09:00
  if (!esHorarioPermitido()) {
    const ahoraUY = new Date(Date.now() + URUGUAY_OFFSET_MS);
    console.log(`[AbandonedCart] 🌙 Fuera de horario Uruguay (${ahoraUY.getUTCHours()}:${String(ahoraUY.getUTCMinutes()).padStart(2,'0')} UY) — ciclo omitido`);
    return { procesados: 0, enviados: 0, razon: 'fuera_de_horario' };
  }

  console.log('[AbandonedCart] ⏱ Iniciando ciclo de recuperación...');

  // 1. Obtener carritos activos de Shopify (últimas 48h)
  let checkouts;
  try {
    checkouts = await shopifyService.obtenerCarritosAbandonados();
  } catch (err) {
    console.error('[AbandonedCart] ❌ Error obteniendo checkouts de Shopify:', err.message);
    return { procesados: 0, enviados: 0, error: err.message };
  }
  console.log(`[AbandonedCart] 🛒 ${checkouts.length} carritos recibidos de Shopify`);

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

    // 3. Determinar qué mensaje enviar
    const msgNum = determinarMensaje(carrito, ahora);
    if (!msgNum) continue;

    const templateName = TEMPLATE[msgNum];
    const { nombre, cartUrl } = buildParams(carrito);

    // 4. Enviar vía Kommo WhatsApp
    try {
      await kommoWhatsApp.enviarTemplate({
        telefono: carrito.cliente_telefono,
        templateName,
        nombre,
        cartUrl,
      });

      // 5. Registrar envío en DB
      await supabase
        .from('abandoned_carts')
        .update({ [`msg${msgNum}_sent_at`]: new Date().toISOString() })
        .eq('shopify_checkout_id', carrito.shopify_checkout_id);

      enviados++;
      console.log(
        `[AbandonedCart] ✅ Msg ${msgNum} → ${carrito.cliente_nombre} (${carrito.cliente_telefono}) | ${templateName}`
      );
    } catch (sendErr) {
      console.error(
        `[AbandonedCart] ❌ Error msg ${msgNum} a ${carrito.cliente_telefono}:`,
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

  let nuevos = 0;
  let actualizados = 0;
  let sinTelefono = 0;

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

    console.log(`[Sync] checkout:${checkout.id} token:${checkout.token} tel:${telefono || 'sin_telefono'} email:${email || 'null'} (pixel:${contactoCapturado ? 'sí' : 'no'})`);

    // Solo procesamos carritos con teléfono (necesario para WhatsApp)
    if (!telefono) {
      sinTelefono++;
      continue;
    }

    const { error, data } = await supabase
      .from('abandoned_carts')
      .upsert(
        {
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
        },
        { onConflict: 'shopify_checkout_id' }
      )
      .select('id, created_at, updated_at')
      .single();

    if (!error) {
      const isNew = data.created_at === data.updated_at;
      isNew ? nuevos++ : actualizados++;
    } else {
      console.error('[AbandonedCart] Upsert error:', error.message);
    }
  }

  console.log(`[AbandonedCart] Sync: ${nuevos} nuevos, ${actualizados} actualizados, ${sinTelefono} sin teléfono (omitidos)`);
  return { total: checkouts.length, nuevos, actualizados, sinTelefono };
}

// Envía un mensaje de prueba a un carrito específico (por UUID de DB), ignorando restricción horaria
async function probarMensaje(cartId, msgNum) {
  const { data: carrito, error } = await supabase
    .from('abandoned_carts')
    .select('*')
    .eq('id', cartId)
    .single();

  if (error || !carrito) throw new Error('Carrito no encontrado');
  if (!carrito.cliente_telefono) throw new Error('El carrito no tiene teléfono registrado');

  const templateName = TEMPLATE[msgNum];
  const nombre  = primerNombre(carrito.cliente_nombre);
  const cartUrl = carrito.abandoned_checkout_url || '';

  await kommoWhatsApp.enviarTemplate({ telefono: carrito.cliente_telefono, templateName, nombre, cartUrl });

  // Registrar en DB
  await supabase
    .from('abandoned_carts')
    .update({ [`msg${msgNum}_sent_at`]: new Date().toISOString() })
    .eq('id', cartId);

  console.log(`[AbandonedCart] 🧪 Prueba msg ${msgNum} → ${carrito.cliente_nombre} (${carrito.cliente_telefono})`);
  return { carrito: carrito.cliente_nombre, telefono: carrito.cliente_telefono, templateName };
}

async function obtenerCarritosDB() {
  const desde72h = new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString();
  const { data: carritos, error } = await supabase
    .from('abandoned_carts')
    .select('*')
    .gte('abandoned_at', desde72h)
    .order('abandoned_at', { ascending: false });

  if (error) throw error;

  const stats = {
    total:          carritos.length,
    sin_contactar:  carritos.filter(c => !c.msg1_sent_at && !c.recovered).length,
    esperando_msg2: carritos.filter(c => c.msg1_sent_at && !c.msg2_sent_at && !c.recovered).length,
    recuperados:    carritos.filter(c => c.recovered).length,
  };

  return { carritos, stats };
}

module.exports = { procesarCarritosAbandonados, marcarComoRecuperado, sincronizarDesdeShopify, probarMensaje, obtenerCarritosDB, guardarCheckoutCapturado };

// Arma el e-Ticket (CFE 101) de un pedido de Shopify para la API de Zensei.
//
// Reglas de VELINNE:
//   - Siempre e-Ticket a consumidor final (nadie pide factura con RUT).
//   - Los precios de la tienda INCLUYEN IVA 22%; la API de Zensei pide el precio
//     unitario SIN IVA y calcula el impuesto ella. Por eso cada línea se pasa a
//     neto dividiendo por 1,22, y se controla que el total que va a calcular
//     Zensei cierre al centésimo con lo que cobró Shopify.
//   - Los reembolsos se gestionan por fuera de la facturación electrónica: se
//     factura lo que se cobró originalmente, sin notas de crédito.
//
// Es una función pura (no llama a ninguna API) para poder mostrar el preview
// exactamente con los mismos números que después se emiten.

const TASA_IVA = 0.22;
const LARGO_MAX_DESCRIPCION = 80; // NomItem en el formato CFE de DGI

// Redondeos evitando el clásico 1.005 → 1.00 de coma flotante.
const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const r4 = (n) => Math.round((Number(n) + Number.EPSILON) * 10000) / 10000;

function num(valor) {
  const n = Number(valor);
  return Number.isFinite(n) ? n : 0;
}

function sumaAsignaciones(asignaciones) {
  return (asignaciones || []).reduce((s, a) => s + num(a.amount), 0);
}

function recortar(texto) {
  const t = String(texto || '').replace(/\s+/g, ' ').trim();
  return t.length > LARGO_MAX_DESCRIPCION ? `${t.slice(0, LARGO_MAX_DESCRIPCION - 1)}…` : t;
}

function descripcionLinea(li) {
  const variante = li.variant_title && li.variant_title !== 'Default Title' ? ` - ${li.variant_title}` : '';
  return recortar(`${li.title || li.name || 'Artículo'}${variante}`);
}

// Fecha de hoy en Uruguay (YYYY-MM-DD). La fecha del CFE es la de emisión, no la
// del pedido. Uruguay no tiene horario de verano, pero se usa la zona por nombre.
function fechaHoyUy(ahora = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Montevideo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(ahora);
}

// Máximo de días hacia atrás que se acepta como fecha de emisión (confirmado con
// el contador / Zensei). El CFE puede llevar la fecha en que entró el pedido
// sólo si no pasaron más de estos días.
const MAX_DIAS_ATRAS = 2;

// Fecha (YYYY-MM-DD, hora de Uruguay) en que se recibió el pedido en Shopify.
function fechaPedidoUy(order) {
  const cuando = order?.created_at || order?.processed_at;
  if (!cuando) return null;
  const d = new Date(cuando);
  return Number.isNaN(d.getTime()) ? null : fechaHoyUy(d);
}

// Días calendario entre dos fechas YYYY-MM-DD (b - a).
function diasEntre(a, b) {
  const [ya, ma, da] = a.split('-').map(Number);
  const [yb, mb, db] = b.split('-').map(Number);
  return Math.round((Date.UTC(yb, mb - 1, db) - Date.UTC(ya, ma - 1, da)) / 86400000);
}

// Fechas de emisión posibles para un pedido (o un grupo de pedidos del mismo
// cliente que van en un solo e-Ticket: ahí cuenta el más reciente, porque la
// venta se completa con la última orden). `pedidoPermitida` es false si el
// pedido tiene más de MAX_DIAS_ATRAS días: ahí sólo se puede emitir con hoy.
function opcionesFecha(orderOGrupo, ahora = new Date()) {
  const hoy = fechaHoyUy(ahora);
  const grupo = Array.isArray(orderOGrupo) ? orderOGrupo : [orderOGrupo];
  const fechasPedidos = grupo.map(fechaPedidoUy);
  const pedido = fechasPedidos.every(Boolean) ? fechasPedidos.sort().at(-1) : null;
  const dias = pedido ? diasEntre(pedido, hoy) : null;
  return {
    hoy,
    pedido,
    diasAtras: dias,
    maxDiasAtras: MAX_DIAS_ATRAS,
    pedidoPermitida: dias !== null && dias >= 0 && dias <= MAX_DIAS_ATRAS,
  };
}

// Valida una fecha de emisión pedida contra la ventana [hoy - MAX, hoy].
function validarFechaEmision(fecha, ahora = new Date()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(fecha || ''))) return 'Fecha de emisión inválida';
  const dias = diasEntre(fecha, fechaHoyUy(ahora));
  if (dias < 0) return 'La fecha de emisión no puede ser futura';
  if (dias > MAX_DIAS_ATRAS) return `La fecha de emisión puede tener como máximo ${MAX_DIAS_ATRAS} días de atraso`;
  return null;
}

// Total (neto + IVA) que da un neto gravado N. Como en el CFE de DGI, el IVA se
// calcula sobre el total neto gravado, no línea por línea.
const totalDeNeto = (n) => r2(n + r2(n * TASA_IVA));

// Neto gravado (2 decimales) cuyo neto + IVA da `objetivo`. Al subir el neto de a
// un centésimo el total sube 0,01 o 0,02, así que hay montos que no se alcanzan
// exacto (ej. $2.760: da 2.759,99 o 2.760,01). En ese caso devuelve el neto que
// queda justo por debajo y el resto se factura como "Redondeo" no facturable.
function netoParaTotal(objetivo) {
  const base = r2(objetivo / (1 + TASA_IVA));
  for (const d of [0, -0.01, 0.01, -0.02, 0.02, -0.03, 0.03]) {
    const n = r2(base + d);
    if (totalDeNeto(n) === objetivo) return { neto: n, resto: 0 };
  }
  let n = base;
  while (totalDeNeto(n) > objetivo) n = r2(n - 0.01);
  while (totalDeNeto(r2(n + 0.01)) <= objetivo) n = r2(n + 0.01);
  return { neto: n, resto: r2(objetivo - totalDeNeto(n)) };
}

// Precio unitario (4 decimales) tal que cantidad × unitario redondee
// exactamente al neto de línea buscado.
function unitarioParaNeto(neto, cantidad) {
  const u = r4(neto / cantidad);
  if (r2(cantidad * u) === neto) return u;
  for (const d of [0.0001, -0.0001, 0.0002, -0.0002, 0.0003, -0.0003]) {
    const v = r4(u + d);
    if (r2(cantidad * v) === neto) return v;
  }
  return u;
}

// Totales tal como los va a armar Zensei: neto gravado al 22%, su IVA y lo no
// facturable (redondeo) aparte.
function calcularTotales(items) {
  let gravado = 0;
  let noFacturable = 0;
  for (const it of items) {
    const neto = r2(it.qty * it.unitPrice);
    if (it.fiscalCategory === 'NON_BILLABLE') noFacturable += neto;
    else gravado += neto;
  }
  gravado = r2(gravado);
  noFacturable = r2(noFacturable);
  const iva = r2(gravado * TASA_IVA);
  return { neto: gravado, iva, noFacturable, total: r2(gravado + iva + noFacturable) };
}

// Reparte el neto gravado total entre las líneas en proporción a su bruto; los
// centésimos que sobran o faltan van a la línea más grande.
function fijarNetos(items, brutos, netoTotal) {
  const netos = brutos.map((b) => r2(b / (1 + TASA_IVA)));
  const desvio = r2(netoTotal - netos.reduce((s, n) => s + n, 0));
  if (desvio !== 0) {
    const mayor = brutos.indexOf(Math.max(...brutos));
    netos[mayor] = r2(netos[mayor] + desvio);
  }
  netos.forEach((n, i) => { items[i].unitPrice = unitarioParaNeto(n, items[i].qty); });
  return netos;
}

// ── Estado del pedido ────────────────────────────────────────────────────────
// `pre` identifica al pedido en los mensajes cuando el e-Ticket junta varios.
function revisarOrden(order, pre, avisos, bloqueos) {
  if (order.cancelled_at) bloqueos.push(pre + 'El pedido está cancelado en Shopify');
  const pago = order.financial_status;
  if (pago === 'refunded') {
    bloqueos.push(pre + 'El pedido está reembolsado por completo en Shopify');
  } else if (!['paid', 'partially_refunded'].includes(pago)) {
    bloqueos.push(pre + `El pago figura como "${pago || 'desconocido'}" en Shopify: se emite cuando esté pagado`);
  }
  if (pago === 'partially_refunded') {
    avisos.push(pre + 'Tiene un reembolso parcial: se factura el importe cobrado originalmente (los reembolsos van por fuera)');
  }
  if (order.currency && order.currency !== 'UYU') {
    bloqueos.push(pre + `El pedido está en ${order.currency}; este flujo emite sólo en pesos`);
  }
  // La tienda no cobra impuestos aparte (taxes_included: false y total_tax 0):
  // el precio es final y, por regla del negocio, ya incluye IVA. Sólo se frena
  // si Shopify SUMÓ un impuesto encima, porque ahí el total ya no es "con IVA".
  if (order.taxes_included === false && num(order.total_tax) > 0) {
    bloqueos.push(pre + 'Shopify le sumó impuestos al pedido por encima del precio: revisar la configuración de impuestos antes de emitir');
  }
  const tieneReembolsos = Array.isArray(order.refunds) && order.refunds.length > 0;
  if (!tieneReembolsos && order.current_total_price != null
      && r2(num(order.current_total_price)) !== r2(num(order.total_price))) {
    bloqueos.push(pre + 'El pedido fue editado después de la compra (cambió el total): revisarlo en Shopify antes de emitir');
  }
  if (num(order.total_tip_received) > 0) {
    avisos.push(pre + 'El pedido incluye propina: no forma parte del e-Ticket');
  }
}

// Líneas de producto y envío de un pedido. `pedido` (nombre en Shopify) queda en
// cada línea del preview cuando el e-Ticket junta varios pedidos.
function agregarLineas(order, pedido, items, lineas, avisos, bloqueos) {
  const pre = pedido ? `${pedido}: ` : '';
  // ── Líneas de producto ─────────────────────────────────────────────────────
  for (const li of order.line_items || []) {
    const cantidad = num(li.quantity);
    if (cantidad <= 0) continue;
    const descripcion = descripcionLinea(li);

    if (li.gift_card) {
      bloqueos.push(`${pre}"${descripcion}" es una tarjeta de regalo: no se factura como venta`);
      continue;
    }

    const descuento = r2(sumaAsignaciones(li.discount_allocations));
    const brutoLinea = r2(num(li.price) * cantidad - descuento);
    if (brutoLinea <= 0) {
      avisos.push(`${pre}"${descripcion}" sale sin cargo: no se incluye en el e-Ticket`);
      continue;
    }

    const item = {
      description: descripcion,
      qty: cantidad,
      unitPrice: 0, // lo fija fijarNetos para que cierre al centésimo
      taxRate: TASA_IVA,
      uniMed: 'UN',
    };
    const sku = String(li.sku || '').trim();
    if (sku) item.codItem = [{ tpoCod: 'INT1', cod: sku }];
    items.push(item);
    lineas.push({ tipo: 'producto', pedido, descripcion, sku: sku || null, cantidad, precioLista: num(li.price), descuento, brutoLinea });
  }

  // ── Envío ──────────────────────────────────────────────────────────────────
  for (const sl of order.shipping_lines || []) {
    const brutoEnvio = r2(num(sl.price) - sumaAsignaciones(sl.discount_allocations));
    if (brutoEnvio <= 0) continue;
    const descripcion = recortar(`Envío - ${sl.title || 'a domicilio'}`);
    items.push({
      description: descripcion,
      qty: 1,
      unitPrice: 0,
      taxRate: TASA_IVA,
      uniMed: 'UN',
    });
    lineas.push({ tipo: 'envio', pedido, descripcion, sku: null, cantidad: 1, precioLista: num(sl.price), descuento: r2(num(sl.price) - brutoEnvio), brutoLinea: brutoEnvio });
  }
}

/**
 * @param {object|object[]} entrada  Pedido completo de la REST Admin API de
 *   Shopify, o varios pedidos del MISMO cliente: van todos en un solo e-Ticket.
 * @param {object} [opts]
 * @param {string} [opts.fecha]  YYYY-MM-DD; por defecto hoy en Uruguay.
 * @returns {{ payload, idempotencyKey, lineas, totales, avisos, bloqueos }}
 *   bloqueos: motivos por los que NO se puede emitir. avisos: para revisar.
 */
function construirETicket(entrada, { fecha } = {}) {
  const avisos = [];
  const bloqueos = [];
  const orders = Array.isArray(entrada) ? entrada : [entrada];

  if (!orders.length || orders.some((o) => !o || !o.id)) {
    return { payload: null, idempotencyKey: null, lineas: [], totales: null, avisos, bloqueos: ['No se encontró el pedido en Shopify'] };
  }

  const items = [];
  const lineas = []; // mismo orden que items, con el detalle para el preview
  // Con varios pedidos cada aviso dice de cuál es.
  const varios = orders.length > 1;
  for (const order of orders) {
    const pre = varios ? `${order.name || `#${order.id}`}: ` : '';
    revisarOrden(order, pre, avisos, bloqueos);
    agregarLineas(order, varios ? (order.name || null) : null, items, lineas, avisos, bloqueos);
  }

  if (items.length === 0) bloqueos.push('El pedido no tiene líneas con importe para facturar');

  // ── Cuadre contra Shopify ──────────────────────────────────────────────────
  // El pedido se factura por lo que pagó el cliente, sin propina.
  const totalShopify = r2(orders.reduce((s, o) => s + num(o.total_price) - num(o.total_tip_received), 0));
  const brutos = lineas.map((l) => l.brutoLinea);
  let netos = [];
  if (items.length) {
    const sumaBrutos = r2(brutos.reduce((s, x) => s + x, 0));
    if (sumaBrutos !== totalShopify) {
      bloqueos.push(`Las líneas suman $${sumaBrutos.toFixed(2)} pero Shopify cobró $${totalShopify.toFixed(2)}: revisar descuentos o cargos del pedido`);
    }
    const { neto, resto } = netoParaTotal(sumaBrutos);
    netos = fijarNetos(items, brutos, neto);
    if (resto > 0) {
      items.push({
        description: 'Redondeo',
        qty: 1,
        unitPrice: resto,
        taxRate: 0,
        uniMed: 'UN',
        fiscalCategory: 'NON_BILLABLE',
      });
    }
  }
  const totales = calcularTotales(items);
  const diferencia = r2(totales.total - totalShopify);
  if (diferencia !== 0 && !bloqueos.some((b) => b.startsWith('Las líneas suman'))) {
    bloqueos.push(`El total del e-Ticket ($${totales.total.toFixed(2)}) no cierra con el de Shopify ($${totalShopify.toFixed(2)}): diferencia de $${diferencia.toFixed(2)}`);
  }

  // Detalle por línea para el preview. El IVA no se muestra por línea: en el CFE
  // se calcula sobre el total gravado (ver `totales`).
  lineas.forEach((l, i) => {
    l.unitarioNeto = items[i].unitPrice;
    l.neto = netos[i];
  });
  if (totales.noFacturable > 0) {
    lineas.push({ tipo: 'redondeo', descripcion: 'Redondeo (no facturable)', sku: null, cantidad: 1, precioLista: totales.noFacturable, descuento: 0, brutoLinea: totales.noFacturable, unitarioNeto: totales.noFacturable, neto: totales.noFacturable });
  }

  const payload = items.length
    ? {
        documentType: '101',
        currency: 'UYU',
        issueDate: fecha || fechaHoyUy(),
        items,
        channel: 'shopify',
      }
    : null;

  return {
    payload,
    // Fija por pedido (o por grupo de pedidos): reintentar con la misma clave
    // nunca duplica el comprobante.
    idempotencyKey: `shopify-${orders.map((o) => String(o.id)).sort().join('+')}`,
    pedidoShopify: orders.map((o) => o.name).filter(Boolean).join(' + ') || null,
    lineas,
    totales: { ...totales, totalShopify, diferencia },
    avisos,
    bloqueos,
  };
}

module.exports = { construirETicket, fechaHoyUy, fechaPedidoUy, opcionesFecha, validarFechaEmision, MAX_DIAS_ATRAS, TASA_IVA };

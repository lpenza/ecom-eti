// Prueba de cuadre del e-Ticket: miles de pedidos al azar (precios de la tienda,
// descuentos con y sin centavos, cantidades, envío) tienen que cerrar al
// centésimo con lo cobrado. Correr después de tocar services/comprobanteBuilder.js:
//   node scripts/test-comprobante-builder.js
const assert = require('assert');
const { construirETicket, opcionesFecha, validarFechaEmision } = require('../services/comprobanteBuilder');

const base = { id: 1, name: '#1', financial_status: 'paid', currency: 'UYU', taxes_included: false, total_tax: '0.00', refunds: [] };
const PRECIOS = [190, 290, 390, 490, 590, 690, 790, 830, 1490, 1890, 2550, 2680, 3470];
const rnd = (a, b) => a + Math.floor(Math.random() * (b - a + 1));

// Caso conocido: $2.760 no se puede expresar como neto + IVA redondeados.
const x = construirETicket({ ...base, line_items: [{ title: 'Set', price: '690', quantity: 4 }], shipping_lines: [], total_price: '2760', current_total_price: '2760' });
assert.deepStrictEqual(x.bloqueos, []);
assert.strictEqual(x.totales.total, 2760);
assert.strictEqual(x.totales.noFacturable, 0.01);

let casos = 0;
for (let k = 0; k < 20000; k++) {
  const lineas = [];
  let total = 0;
  for (let j = 0; j < rnd(1, 6); j++) {
    const precio = PRECIOS[rnd(0, PRECIOS.length - 1)];
    const cant = rnd(1, 4);
    let desc = Math.random() < 0.5 ? rnd(0, precio * cant - 1) : 0;
    if (desc && k % 2) desc += rnd(1, 99) / 100;
    lineas.push({ title: 'X', price: String(precio), quantity: cant, discount_allocations: desc ? [{ amount: desc.toFixed(2) }] : [] });
    total += precio * cant - desc;
  }
  const envio = Math.random() < 0.5 ? [{ title: 'UES', price: '195', discount_allocations: [] }] : [];
  if (envio.length) total += 195;
  const t = (Math.round(total * 100) / 100).toFixed(2);
  const r = construirETicket({ ...base, line_items: lineas, shipping_lines: envio, total_price: t, current_total_price: t });
  assert.deepStrictEqual(r.bloqueos, [], `no cerró: ${JSON.stringify(lineas)}`);
  assert.strictEqual(r.totales.diferencia, 0);
  assert.ok(r.totales.noFacturable <= 0.01);
  casos++;
}

// Dos pedidos del mismo cliente: un solo e-Ticket que cierra con la suma de lo
// cobrado, con una clave propia del grupo (no la de ninguno de los dos solos).
const p1 = { ...base, id: 20, name: '#1020', line_items: [{ title: 'Set', price: '690', quantity: 2 }], shipping_lines: [{ title: 'UES', price: '195' }], total_price: '1575', current_total_price: '1575', created_at: '2026-11-01T10:00:00-03:00' };
const p2 = { ...base, id: 10, name: '#1010', line_items: [{ title: 'Pieza', price: '490', quantity: 1 }], shipping_lines: [], total_price: '490', current_total_price: '490', created_at: '2026-10-31T10:00:00-03:00' };
const g = construirETicket([p1, p2]);
assert.deepStrictEqual(g.bloqueos, []);
assert.strictEqual(g.totales.total, 2065);
assert.strictEqual(g.totales.totalShopify, 2065);
assert.strictEqual(g.idempotencyKey, 'shopify-10+20');
assert.strictEqual(construirETicket(p1).idempotencyKey, 'shopify-20');
assert.strictEqual(g.pedidoShopify, '#1020 + #1010');
assert.deepStrictEqual(g.lineas.map((l) => l.pedido), ['#1020', '#1020', '#1010']);
// Si uno del grupo no está pago, se frena todo el e-Ticket y se dice cuál.
const gPend = construirETicket([p1, { ...p2, financial_status: 'pending' }]);
assert.ok(gPend.bloqueos.length === 1 && gPend.bloqueos[0].startsWith('#1010: '));
// La fecha "del pedido" de un grupo es la de su pedido más reciente.
assert.strictEqual(opcionesFecha([p2, p1], new Date('2026-11-02T15:00:00Z')).pedido, '2026-11-01');

// Pendiente de pago: no se emite.
assert.ok(construirETicket({ ...base, financial_status: 'pending', line_items: [{ title: 'X', price: '790', quantity: 1 }], total_price: '790', current_total_price: '790' }).bloqueos.length === 1);

// Fecha de emisión: la del pedido sólo hasta 2 días atrás (hora de Uruguay).
const ahora = new Date('2026-11-02T15:00:00Z');
assert.strictEqual(opcionesFecha({ created_at: '2026-10-31T23:30:00-03:00' }, ahora).pedidoPermitida, true);
assert.strictEqual(opcionesFecha({ created_at: '2026-11-01T02:30:00Z' }, ahora).pedido, '2026-10-31'); // 23:30 del 31 en UY
assert.strictEqual(opcionesFecha({ created_at: '2026-10-30T10:00:00-03:00' }, ahora).pedidoPermitida, false);
assert.strictEqual(validarFechaEmision('2026-10-31', ahora), null);
assert.ok(validarFechaEmision('2026-10-30', ahora));
assert.ok(validarFechaEmision('2026-11-03', ahora));

console.log(`OK: ${casos} pedidos al azar cierran al centésimo y la ventana de fechas se respeta`);

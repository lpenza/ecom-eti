// Reparto sugerido de un traslado depósito → tienda. Copia de
// StockPlanner/src/lib/deposit/allocate.ts (planTransfer): si cambia allá, actualizar acá
// para que la sugerencia sea la misma en las dos pantallas.
//
// Dado el % a trasladar de lo que queda en el depósito:
//   1. Los colores con FULL_TRANSFER_MAX unidades o menos pasan completos.
//   2. El resto del cupo se reparte según la venta diaria, en proporción a lo que a cada
//      color le falta para cubrir el horizonte (lead time + colchón) con lo que ya tiene.
//   3. Si sobra, nivela días de cobertura y después va a los colores sin ventas.
// Todo de a bloques de TRANSFER_STEP unidades, sin pasar nunca más de lo que hay.

export const FULL_TRANSFER_MAX = 10;
export const TRANSFER_STEP = 5;

/** Días de cobertura en la tienda; sin ventas = infinito. */
export function coverageDays(stock, velocity) {
  if (velocity <= 0) return Infinity;
  return Math.max(0, stock) / velocity;
}

/** Mismo criterio de salud que StockPlanner (computeStatus). */
export function computeStatus(daysRemaining, leadTimeDays, safetyBufferDays) {
  if (daysRemaining < leadTimeDays) return 'critico';
  if (daysRemaining < leadTimeDays + safetyBufferDays) return 'riesgo';
  if (daysRemaining > leadTimeDays * 3) return 'sobre';
  return 'bien';
}

/**
 * @param {{ lineId: string, remaining: number, shopStock: number, velocity: number }[]} candidates
 * @returns {{ units: Map<string, number>, target: number, total: number, forced: Set<string> }}
 */
export function planTransfer(candidates, pct, horizonDays = 56) {
  const units = new Map();
  const forced = new Set();
  const active = candidates.filter((c) => c.remaining > 0);
  const totalRemaining = active.reduce((s, c) => s + c.remaining, 0);
  const clampedPct = Math.min(100, Math.max(0, pct));
  const target = Math.round((totalRemaining * clampedPct) / 100);

  for (const c of candidates) units.set(c.lineId, 0);
  if (target <= 0) return { units, target: 0, total: 0, forced };

  let forcedTotal = 0;
  for (const c of active) {
    if (c.remaining <= FULL_TRANSFER_MAX) {
      units.set(c.lineId, c.remaining);
      forced.add(c.lineId);
      forcedTotal += c.remaining;
    }
  }

  const budget = Math.max(0, target - forcedTotal);
  const pool = active.filter((c) => !forced.has(c.lineId));

  const need = new Map();
  for (const c of pool) {
    if (c.velocity <= 0) continue;
    need.set(
      c.lineId,
      Math.min(c.remaining, Math.max(0, horizonDays * c.velocity - Math.max(0, c.shopStock)))
    );
  }

  function priority(c, cur) {
    const days = coverageDays(c.shopStock + cur, c.velocity);
    if (c.velocity > 0) {
      const n = need.get(c.lineId) ?? 0;
      if (cur < n) return [0, cur / n, days];
      return [1, days, 0];
    }
    return [2, -(c.remaining - cur), 0];
  }

  let assigned = 0;
  for (;;) {
    let best = null;
    let bestKey = null;
    for (const c of pool) {
      const cur = units.get(c.lineId) ?? 0;
      if (cur >= c.remaining) continue;
      const key = priority(c, cur);
      if (
        !bestKey ||
        key[0] < bestKey[0] ||
        (key[0] === bestKey[0] &&
          (key[1] < bestKey[1] || (key[1] === bestKey[1] && key[2] < bestKey[2])))
      ) {
        bestKey = key;
        best = c;
      }
    }
    if (!best) break;
    const cur = units.get(best.lineId) ?? 0;
    const chunk = Math.min(TRANSFER_STEP, best.remaining - cur);
    if (assigned + chunk - budget > chunk / 2) break;
    units.set(best.lineId, cur + chunk);
    assigned += chunk;
  }

  const total = [...units.values()].reduce((a, b) => a + b, 0);
  return { units, target, total, forced };
}

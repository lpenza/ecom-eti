// "Lectura rápida" de la pestaña Campañas: aplica los mismos umbrales del
// Rulebook que el job de pausa/escalado (services/metaAdsPilotoService.js),
// pero sobre las métricas del período elegido y sin las salvaguardas de
// tiempo (2 lecturas, cadencias, ventana de no tocar). Las propuestas
// formales, con todas las salvaguardas, son las de "Para revisar".

export const ACCIONES = {
  pausar:   { label: 'Pausar',            clase: 'bad',    orden: 0 },
  revisar:  { label: 'Revisar adentro',   clase: 'warn',   orden: 1 },
  escalar:  { label: 'Escalar',           clase: 'good',   orden: 1 },
  graduar:  { label: 'Graduar',           clase: 'good',   orden: 2 },
  ganador:  { label: 'Ganador',           clase: 'good',   orden: 3 },
  creativo: { label: 'Cambiar creativo',  clase: 'warn',   orden: 4 },
  mantener: { label: 'Mantener',          clase: 'accent', orden: 5 },
  esperar:  { label: 'Esperar',           clase: '',       orden: 6 },
};

const contiene = (texto, patron) => {
  if (!texto || !patron) return false;
  try { return new RegExp(patron, 'i').test(texto); } catch { return texto.toLowerCase().includes(patron.toLowerCase()); }
};

// Misma lógica que services/metaAdsParametros.js: tag en mayúsculas en el nombre.
export function ofertaDe(nombres, ofertas = []) {
  const texto = nombres.filter(Boolean).join(' ');
  const porLargo = [...ofertas].sort((a, b) => b.tag.length - a.tag.length);
  for (const o of porLargo) {
    const re = new RegExp(`(^|[^A-Z0-9+])${o.tag.replace(/[+]/g, '\\+')}([^A-Z0-9+]|$)`);
    if (re.test(texto)) return o;
  }
  return ofertas.find(o => o.defecto) || ofertas[0] || { tag: 'KIT', cpaObjetivo: 550, cpaMaximo: 850 };
}

const fmt = (n, dec = 0) => (n == null ? '—' : Number(n).toLocaleString('es-UY', { maximumFractionDigits: dec, minimumFractionDigits: dec }));

/**
 * Devuelve { accion, motivo, alertas[], cambio? } o null si el item está apagado.
 *   ctx.nombresPadres: nombres de campaña/ad set que lo contienen (oferta, testeo, retargeting).
 */
export function evaluar(item, nivel, p, ctx = {}) {
  const v = evaluarBase(item, nivel, p, ctx);
  // §2 granularidad: una campaña, o un ad set que puede tener varios anuncios,
  // no se pausa entero; hay que ver qué anuncio explica el problema. En testeo
  // cada ad set tiene un solo anuncio, así que ahí sí se pausa el ad set.
  const testeo = contiene([...(ctx.nombresPadres || []), item.nombre].join(' '), p?.patronTesteo);
  if (v?.accion === 'pausar' && (nivel === 'campania' || (nivel === 'conjunto' && !testeo))) {
    return { ...v, accion: 'revisar', motivo: `${v.motivo}: abrilo para ver qué ${nivel === 'campania' ? 'conjunto o anuncio' : 'anuncio'} lo explica` };
  }
  return v;
}

function evaluarBase(item, nivel, p, ctx) {
  if (!p || item.estado !== 'ACTIVE') return null;
  const nombres = [...(ctx.nombresPadres || []), item.nombre];
  const oferta = ofertaDe(nombres, p.ofertas);
  const testeo = contiene(nombres.join(' '), p.patronTesteo);
  const retargeting = contiene(nombres.join(' '), p.patronRetargeting);
  const m = item.metricas;
  const alertas = [];
  if (!m || m.gasto <= 0) return { accion: 'esperar', motivo: 'Sin gasto en el período', alertas };

  const cap = retargeting ? p.frecuenciaRetargeting : p.frecuenciaFrio;
  if (m.frecuencia > cap) alertas.push(`Frecuencia ${fmt(m.frecuencia, 1)} (tope ${fmt(cap, 1)})`);
  if (m.impresiones >= 1000 && m.ctr < p.ctrMinimo) alertas.push(`CTR ${fmt(m.ctr, 2)}% (mín. ${fmt(p.ctrMinimo, 1)}%)`);

  const gastoMinimo = p.gastoMinimoCpa * oferta.cpaObjetivo;
  const confianza = m.compras >= p.volumenMinimo || m.gasto >= gastoMinimo;
  const tienePresupuesto = (item.presupuestoDiario ?? item.presupuestoTotal) != null;

  if (m.compras === 0) {
    if (m.gasto >= gastoMinimo) return { accion: 'pausar', motivo: `$${fmt(m.gasto)} sin ventas (límite $${fmt(gastoMinimo)})`, alertas };
    if (m.frecuencia > cap) return { accion: 'pausar', motivo: `Frecuencia sobre el tope sin ventas`, alertas };
    return { accion: 'esperar', motivo: `Sin ventas: se evalúa al llegar a $${fmt(gastoMinimo)}`, alertas };
  }
  if (!confianza) return { accion: 'esperar', motivo: `Faltan datos: $${fmt(m.gasto)} de $${fmt(gastoMinimo)} o ${p.volumenMinimo} compras`, alertas };

  if (m.cpa > oferta.cpaMaximo) return { accion: 'pausar', motivo: `CPA $${fmt(m.cpa)} sobre el máximo de ${oferta.tag} ($${fmt(oferta.cpaMaximo)})`, alertas };
  if (m.roas != null && m.roas < p.roasPausa) return { accion: 'pausar', motivo: `ROAS ${fmt(m.roas, 2)} bajo ${fmt(p.roasPausa, 1)}`, alertas };
  if (m.roas == null) alertas.push('Meta no informó el valor de las compras: ROAS desconocido');

  const gana = m.cpa < oferta.cpaObjetivo && m.roas != null && m.roas > p.roasEscalado;
  if (gana) {
    const base = `CPA $${fmt(m.cpa)} bajo ${fmt(oferta.cpaObjetivo)} y ROAS ${fmt(m.roas, 2)}`;
    if (testeo) return { accion: 'graduar', motivo: `${base}: candidato a graduar`, alertas };
    if (tienePresupuesto && item.aprendizaje !== 'LEARNING') return { accion: 'escalar', motivo: `${base}: subir ${p.escaladoPct}%`, alertas, cambio: { porcentaje: p.escaladoPct } };
    if (tienePresupuesto) return { accion: 'mantener', motivo: `${base}, pero está aprendiendo`, alertas };
    return { accion: 'ganador', motivo: base, alertas };
  }
  if (!tienePresupuesto && nivel === 'anuncio' && alertas.length) return { accion: 'creativo', motivo: `CPA $${fmt(m.cpa)} dentro de rango pero el creativo se está gastando`, alertas };
  return { accion: 'mantener', motivo: `CPA $${fmt(m.cpa)} entre objetivo y máximo de ${oferta.tag}`, alertas };
}

// Análisis del piloto de Meta Ads (Fase 3). Reemplaza la parte numérica de:
//   velinne-ads-weekly-digest     → reporteSemanal       (Rulebook §8.1, §8.5, §3.1, §6.1, §8.6)
//   velinne-ads-decision-audit    → auditarDecisiones    (Rulebook §8.6)
//   velinne-winner-decline-audit  → ganadoresCaidos      (Rulebook §6.6)
// No ejecutan nada: devuelven datos, observaciones y propuestas que el piloto
// guarda en la bandeja (reencender ganadores, crear lookalikes).

const axios = require('axios');
const meta = require('./metaAdsService');
const supabaseService = require('./supabaseService');
const shopifyService = require('./shopifyService');
const { ofertaDe } = require('./metaAdsParametros');

const TZ = 'America/Montevideo';
const DIA_MS = 86400000;

function fechaUy(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}
function sumarDias(fechaIso, dias) {
  const d = new Date(`${fechaIso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}
const rangoDias = (desde, hasta) => ({ since: desde, until: hasta });
const pct = (a, b) => (a == null || b == null || b === 0 ? null : ((a - b) / b) * 100);
const fmt = (n, dec = 0) => (n == null || !Number.isFinite(n) ? '—' : Number(n).toLocaleString('es-UY', { maximumFractionDigits: dec, minimumFractionDigits: dec }));
const contiene = (texto, patron) => {
  if (!texto || !patron) return false;
  try { return new RegExp(patron, 'i').test(texto); } catch { return texto.toLowerCase().includes(patron.toLowerCase()); }
};

function verificarUsoApi() {
  const uso = meta.usoApiActual();
  if (uso >= 80) throw new Error(`Uso de la API de Meta en ${uso}%: se frena para no llegar al límite (Rulebook 4.1)`);
}

// ── Shopify ──────────────────────────────────────────────────────────────────

async function shopifyql(consulta) {
  const r = await axios.post(
    `https://${process.env.SHOPIFY_DOMAIN}/admin/api/2025-10/graphql.json`,
    { query: 'query($q: String!) { shopifyqlQuery(query: $q) { tableData { columns { name } rows } parseErrors } }', variables: { q: consulta } },
    { headers: { 'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN }, timeout: 30000 },
  );
  const q = r.data?.data?.shopifyqlQuery;
  if (r.data?.errors?.length) throw new Error(r.data.errors[0].message);
  if (q?.parseErrors?.length) throw new Error(`ShopifyQL: ${JSON.stringify(q.parseErrors)}`);
  return q?.tableData?.rows || [];
}

const num = (v) => (v == null || v === '' ? 0 : Number(v));

// Funnel de sesiones (Rulebook §8.5): 4 tasas de etapa, semana contra semana.
async function funnel(p) {
  const dias = await shopifyql('FROM sessions SHOW sessions, sessions_with_cart_additions, sessions_that_reached_checkout, sessions_that_completed_checkout, conversion_rate SINCE -14d UNTIL today TIMESERIES day');
  const hoy = fechaUy();
  const corte = sumarDias(hoy, -7);
  const sumar = (filas) => filas.reduce((a, d) => ({
    sesiones: a.sesiones + num(d.sessions),
    carrito: a.carrito + num(d.sessions_with_cart_additions),
    checkout: a.checkout + num(d.sessions_that_reached_checkout),
    compra: a.compra + num(d.sessions_that_completed_checkout),
  }), { sesiones: 0, carrito: 0, checkout: 0, compra: 0 });
  const tasas = (t) => ({
    ...t,
    sesionCarrito: t.sesiones ? (t.carrito / t.sesiones) * 100 : null,
    carritoCheckout: t.carrito ? (t.checkout / t.carrito) * 100 : null,
    checkoutCompra: t.checkout ? (t.compra / t.checkout) * 100 : null,
    conversion: t.sesiones ? (t.compra / t.sesiones) * 100 : null,
  });
  const actual = tasas(sumar(dias.filter(d => d.day >= corte && d.day < hoy)));
  const previa = tasas(sumar(dias.filter(d => d.day < corte)));
  const etapas = [
    ['sesionCarrito', 'Sesión → carrito'], ['carritoCheckout', 'Carrito → checkout'],
    ['checkoutCompra', 'Checkout → compra'], ['conversion', 'Conversión total'],
  ].map(([clave, label]) => ({ clave, label, actual: actual[clave], previa: previa[clave], variacion: pct(actual[clave], previa[clave]) }));
  const peor = etapas.slice(0, 3).filter(e => e.variacion != null).sort((a, b) => a.variacion - b.variacion)[0] || null;
  let dispositivos = [];
  try {
    dispositivos = (await shopifyql('FROM sessions SHOW sessions, conversion_rate GROUP BY session_device_type SINCE -7d UNTIL today'))
      .map(d => ({ tipo: d.session_device_type, sesiones: num(d.sessions), conversion: num(d.conversion_rate) * 100 }))
      .sort((a, b) => b.sesiones - a.sesiones);
  } catch { /* el desglose es complementario */ }
  return {
    actual, previa, etapas, peor, dispositivos,
    bajoPiso: actual.conversion != null && actual.conversion < p.conversionMinima,
    porDia: dias.map(d => ({ dia: d.day, sesiones: num(d.sessions), conversion: num(d.conversion_rate) * 100 })),
  };
}

// Variantes core (top-8 por ventas netas 90 días) y su stock real (§8.1).
async function inventarioCore(p) {
  const top = await shopifyql(`FROM sales SHOW net_sales, orders GROUP BY product_variant_title WHERE product_title = 'Kit de inicio Velinne®' SINCE -90d UNTIL today ORDER BY net_sales DESC LIMIT 8`);
  const d = await shopifyService.graphql2025(`query($id: ID!) { product(id: $id) { title variants(first: 250) { nodes { title inventoryQuantity } } } }`,
    { id: `gid://shopify/Product/${p.productoCoreId}` });
  const producto = d?.product || d?.data?.product;
  const stock = new Map((producto?.variants?.nodes || []).map(v => [v.title.trim().toLowerCase(), v.inventoryQuantity]));
  const core = top.map(t => {
    const s = stock.get(String(t.product_variant_title).trim().toLowerCase());
    return {
      variante: t.product_variant_title, ventas: num(t.net_sales), ordenes: num(t.orders),
      stock: s ?? null, estado: s == null ? 'sin_dato' : s <= 0 ? 'agotada' : s <= p.stockBajo ? 'bajo' : 'ok',
    };
  });
  return { producto: producto?.title || null, core, agotadas: core.filter(c => c.estado === 'agotada').length, bajas: core.filter(c => c.estado === 'bajo').length };
}

// ── Meta: pixel y audiencias ─────────────────────────────────────────────────

const EVENTOS_PIXEL = ['PageView', 'ViewContent', 'AddToCart', 'InitiateCheckout', 'AddPaymentInfo', 'Purchase'];

async function saludPixel(p) {
  const ahora = Date.now();
  const [actual, previa] = await Promise.all([
    meta.estadisticasPixel(p.pixelId, new Date(ahora - 7 * DIA_MS).toISOString(), new Date(ahora).toISOString()),
    meta.estadisticasPixel(p.pixelId, new Date(ahora - 14 * DIA_MS).toISOString(), new Date(ahora - 7 * DIA_MS).toISOString()),
  ]);
  // Alerta si un evento cae más de 20% con un piso de ruido de 50 eventos (Rulebook, monitor-pixel).
  const eventos = EVENTOS_PIXEL.map(e => {
    const a = actual[e] || 0; const b = previa[e] || 0;
    const variacion = pct(a, b);
    return { evento: e, actual: a, previa: b, variacion, alerta: b >= 50 && variacion != null && variacion < -20 };
  });
  return { eventos, alertas: eventos.filter(e => e.alerta) };
}

// Lookalikes (§3.1): semillas de engagement sanas sin un lookalike vigente (<90 días).
async function revisarAudiencias(cuenta, p) {
  const audiencias = await meta.listarAudiencias(cuenta);
  const lookalikes = audiencias.filter(a => a.subtipo === 'LOOKALIKE');
  const semillas = audiencias.filter(a => ['ENGAGEMENT', 'IG_BUSINESS'].includes(a.subtipo));
  const propuestas = [];
  const revisadas = semillas.map(s => {
    const suyos = lookalikes.filter(l => l.origenes.includes(s.id) || (l.nombre || '').includes(s.nombre));
    const masNuevo = suyos.map(l => l.actualizada || l.creada).filter(Boolean).sort().at(-1) || null;
    const dias = masNuevo ? Math.floor((Date.now() - new Date(masNuevo).getTime()) / DIA_MS) : null;
    const sana = (s.tamanio || 0) >= p.semillaMinima;
    const proponer = sana && (dias == null || dias > 90);
    if (proponer) propuestas.push(s);
    return { id: s.id, nombre: s.nombre, subtipo: s.subtipo, tamanio: s.tamanio, lookalikes: suyos.map(l => ({ nombre: l.nombre, ratio: l.ratio })), diasUltimo: dias, sana, proponer };
  });
  // Audiencias de pixel que no se actualizan (hallazgo del 11/07: congeladas en ~20 personas).
  const congeladas = audiencias.filter(a => a.subtipo === 'WEBSITE' && (a.tamanio == null || a.tamanio <= 100))
    .map(a => ({ nombre: a.nombre, tamanio: a.tamanio, actualizada: a.actualizada }));
  return { semillas: revisadas, propuestas, congeladas };
}

// ── reporte semanal ──────────────────────────────────────────────────────────

async function reporteSemanal(cuenta, p) {
  const hoy = fechaUy();
  const A = rangoDias(sumarDias(hoy, -7), sumarDias(hoy, -1));
  const B = rangoDias(sumarDias(hoy, -14), sumarDias(hoy, -8));
  const errores = {};
  const seguro = async (clave, fn) => { try { return await fn(); } catch (err) { errores[clave] = err.message; return null; } };

  const [cuentaA, cuentaB, campA, setA] = await Promise.all([
    meta.insightsCuenta(cuenta, A), meta.insightsCuenta(cuenta, B),
    meta.insightsPorNivel(cuenta, 'campaign', A), meta.insightsPorNivel(cuenta, 'adset', A),
  ]);
  verificarUsoApi();

  // Performance: semana contra semana y campañas fuera de umbral (con confianza, §2).
  const metricas = ['gasto', 'compras', 'cpa', 'roas', 'cpm', 'ctr', 'frecuencia'];
  const performance = {
    actual: cuentaA, previa: cuentaB,
    variaciones: Object.fromEntries(metricas.map(k => [k, pct(cuentaA?.[k], cuentaB?.[k])])),
    fueraDeRango: [...campA.values()].map(m => {
      const o = ofertaDe([m.nombres.campania], p.ofertas);
      const confianza = m.compras >= p.volumenMinimo || m.gasto >= p.gastoMinimoCpa * o.cpaObjetivo;
      const motivos = [];
      if (confianza && m.compras > 0 && m.cpa > o.cpaMaximo) motivos.push(`CPA ${fmt(m.cpa)} > ${fmt(o.cpaMaximo)}`);
      if (confianza && m.roas != null && m.roas < p.roasPausa) motivos.push(`ROAS ${fmt(m.roas, 2)} < ${fmt(p.roasPausa, 1)}`);
      if (confianza && m.compras === 0) motivos.push(`$${fmt(m.gasto)} sin ventas`);
      return { campania: m.nombres.campania, oferta: o.tag, gasto: m.gasto, cpa: m.cpa, roas: m.roas, motivos };
    }).filter(x => x.motivos.length).sort((a, b) => b.gasto - a.gasto),
  };

  const [pixel, embudo, inventario, audiencias] = await Promise.all([
    seguro('pixel', () => saludPixel(p)),
    seguro('funnel', () => funnel(p)),
    seguro('inventario', () => inventarioCore(p)),
    seguro('audiencias', () => revisarAudiencias(cuenta, p)),
  ]);

  // Testeo (§6.1): señales tempranas positivas. CTR sano y costo por carrito no
  // más de 50% peor que el promedio de los ad sets BROAD de las CBO.
  const broad = [...setA.values()].filter(m => /broad/i.test(m.nombres.conjunto || '') && !contiene(m.nombres.campania, p.patronTesteo) && m.agregarAlCarrito > 0);
  const costoCarritoBroad = broad.length ? broad.reduce((a, m) => a + m.gasto, 0) / broad.reduce((a, m) => a + m.agregarAlCarrito, 0) : null;
  const testeo = [...setA.values()].filter(m => contiene(m.nombres.campania, p.patronTesteo) && m.gasto > 0);
  const senales = testeo.map(m => {
    const o = ofertaDe([m.nombres.campania, m.nombres.conjunto], p.ofertas);
    const costoCarrito = m.agregarAlCarrito > 0 ? m.gasto / m.agregarAlCarrito : null;
    const confirmado = (m.compras >= p.volumenMinimo || m.gasto >= p.gastoMinimoCpa * o.cpaObjetivo) && m.compras > 0 && m.cpa < o.cpaObjetivo && m.roas > p.roasEscalado;
    const temprana = !confirmado && m.ctr >= p.ctrMinimo && costoCarrito != null && costoCarritoBroad != null && costoCarrito <= costoCarritoBroad * 1.5;
    return { conjunto: m.nombres.conjunto, campania: m.nombres.campania, gasto: m.gasto, ctr: m.ctr, compras: m.compras, cpa: m.cpa, roas: m.roas, costoCarrito, confirmado, temprana };
  }).filter(x => x.confirmado || x.temprana).sort((a, b) => Number(b.confirmado) - Number(a.confirmado) || b.gasto - a.gasto);

  // Acciones de la semana y elasticidad de los escalados (§3).
  const actividad = await seguro('actividad', () => supabaseService.listarActividadMetaAds({ desde: new Date(Date.now() - 45 * DIA_MS).toISOString(), limite: 2000 })) || [];
  const semana = actividad.filter(a => new Date(a.at) >= new Date(Date.now() - 7 * DIA_MS)
    && ['pausa', 'activacion', 'escalado', 'presupuesto', 'anuncio_creado', 'campania_creada', 'duplicado'].includes(a.tipo));
  const escalados = actividad.filter(a => a.tipo === 'escalado' && a.antes?.cpa > 0 && new Date(a.at) <= new Date(Date.now() - 3 * DIA_MS)).slice(0, 12);
  const elasticidad = [];
  for (const e of escalados) {
    verificarUsoApi();
    const dia = fechaUy(new Date(e.at));
    const desde = sumarDias(dia, 1);
    const hasta = [sumarDias(dia, 7), sumarDias(hoy, -1)].sort()[0];
    if (desde > hasta) continue;
    const despues = await seguro(`elasticidad:${e.entidad_id}`, () => meta.insightsObjeto(e.entidad_id, rangoDias(desde, hasta)));
    const subaPresupuesto = e.antes?.presupuesto && e.despues?.presupuesto ? pct(e.despues.presupuesto, e.antes.presupuesto) : null;
    elasticidad.push({
      entidad: e.entidad_nombre, fecha: dia, subaPresupuesto, cpaAntes: e.antes.cpa, cpaDespues: despues?.cpa ?? null,
      variacionCpa: pct(despues?.cpa, e.antes.cpa), dentro: despues?.cpa != null ? pct(despues.cpa, e.antes.cpa) <= p.elasticidadMaxPct : null,
    });
  }

  // Última auditoría de decisiones registrada (§8.6).
  const auditorias = await seguro('auditoria', () => supabaseService.listarActividadMetaAds({ tipos: ['corrida'], limite: 30, desde: new Date(Date.now() - 30 * DIA_MS).toISOString() })) || [];
  const ultimaAuditoria = auditorias.find(a => a.origen === 'auditoria' && a.despues?.extra);

  let pendientes = [];
  try { pendientes = await supabaseService.listarPropuestasMetaAds({ estados: ['pendiente'], limite: 300 }); } catch { /* sin tabla */ }

  return {
    generado: new Date().toISOString(),
    ventana: { actual: A, previa: B },
    pendientes: {
      total: pendientes.length,
      porTipo: pendientes.reduce((a, x) => ({ ...a, [x.tipo]: (a[x.tipo] || 0) + 1 }), {}),
      masViejas: pendientes.filter(x => Date.now() - new Date(x.creado_at).getTime() > 14 * DIA_MS).map(x => ({ titulo: x.titulo, dias: Math.floor((Date.now() - new Date(x.creado_at).getTime()) / DIA_MS) })),
    },
    performance,
    pixel,
    funnel: embudo,
    inventario,
    audiencias,
    testeo: { senales, costoCarritoBroad },
    auditoria: ultimaAuditoria ? {
      fecha: ultimaAuditoria.at,
      cuestionables: (ultimaAuditoria.despues.extra.resultados || []).filter(r => r.clasificacion !== 'acertada'),
      patrones: ultimaAuditoria.despues.extra.patrones || [],
    } : null,
    acciones: semana.map(a => ({ at: a.at, tipo: a.tipo, origen: a.origen, titulo: a.titulo, detalle: a.detalle })),
    elasticidad: {
      casos: elasticidad,
      promedioVariacionCpa: elasticidad.filter(x => x.variacionCpa != null).length
        ? elasticidad.filter(x => x.variacionCpa != null).reduce((a, x) => a + x.variacionCpa, 0) / elasticidad.filter(x => x.variacionCpa != null).length
        : null,
      fueraDeLimite: elasticidad.filter(x => x.dentro === false).length,
    },
    errores,
  };
}

// ── auditoría de decisiones (§8.6) ───────────────────────────────────────────

const CLASES = { acertada: '✅ Acertada', cuestionable: '⚠️ Cuestionable', contraproducente: '❌ Contraproducente' };

// Nombre y padres de una entidad sin saber su nivel: un anuncio tiene ad set y
// campaña, un ad set sólo campaña y una campaña ninguno (pedir un campo que el
// nivel no tiene da error #100).
async function infoEntidad(id) {
  for (const campos of ['name,campaign{id,name},adset{id,name}', 'name,campaign{id,name}', 'name']) {
    try {
      return await meta.obtenerObjeto(id, campos);
    } catch (err) {
      if (!/nonexisting field|#100/i.test(err.message || '')) throw err;
    }
  }
  throw new Error('No se pudo leer la entidad');
}

function segmento(p, campaniaNombre) {
  if (contiene(campaniaNombre, p.patronTesteo)) return 'testeo';
  if (contiene(campaniaNombre, p.patronRetargeting)) return 'retargeting';
  return 'frío';
}

async function auditarDecisiones(cuenta, p, { previas = [] } = {}) {
  const hoy = fechaUy();
  const ayer = sumarDias(hoy, -1);
  const yaAuditadas = new Set(previas.flatMap(a => (a.despues?.extra?.resultados || []).map(r => r.actividadId)));
  const desde = new Date(Date.now() - 21 * DIA_MS).toISOString();
  const hasta = new Date(Date.now() - 7 * DIA_MS);
  const acciones = (await supabaseService.listarActividadMetaAds({ desde, limite: 1000, tipos: ['pausa', 'escalado'] }))
    .filter(a => new Date(a.at) <= hasta && !yaAuditadas.has(a.id) && a.entidad_id)
    .slice(0, 15); // tope por corrida: cada acción son ~4 consultas (Rulebook 4.1)

  const cacheCuenta = new Map();
  const cuentaEn = async (r) => {
    const k = `${r.since}|${r.until}`;
    if (!cacheCuenta.has(k)) cacheCuenta.set(k, await meta.insightsCuenta(cuenta, r));
    return cacheCuenta.get(k);
  };

  const resultados = [];
  for (const a of acciones) {
    verificarUsoApi();
    const dia = fechaUy(new Date(a.at));
    const pre = rangoDias(sumarDias(dia, -7), sumarDias(dia, -1));
    const post = rangoDias(sumarDias(dia, 1), [sumarDias(dia, 7), ayer].sort()[0]);
    let info;
    try {
      info = await infoEntidad(a.entidad_id);
    } catch (err) {
      resultados.push({ actividadId: a.id, entidad: a.entidad_nombre, entidadId: a.entidad_id, accion: a.tipo, fecha: dia, clasificacion: 'cuestionable', etiqueta: CLASES.cuestionable, razon: `No se pudo leer la entidad en Meta (${err.message})`, capas: {} });
      continue;
    }
    // Padre: el ad set si es un anuncio, la campaña si es un ad set; una campaña se compara contra la cuenta.
    const padre = info.adset?.id && info.adset.id !== a.entidad_id ? { id: info.adset.id, nombre: info.adset.name, tipo: 'ad set' }
      : info.campaign?.id && info.campaign.id !== a.entidad_id ? { id: info.campaign.id, nombre: info.campaign.name, tipo: 'campaña' } : null;
    const [entPre, entPost, padPre, padPost, ctaPre, ctaPost] = await Promise.all([
      a.antes?.cpa != null ? Promise.resolve({ cpa: a.antes.cpa, roas: a.antes.roas ?? null, gasto: a.antes.gasto ?? null }) : meta.insightsObjeto(a.entidad_id, pre).catch(() => null),
      a.tipo === 'escalado' ? meta.insightsObjeto(a.entidad_id, post).catch(() => null) : Promise.resolve(null),
      padre ? meta.insightsObjeto(padre.id, pre).catch(() => null) : Promise.resolve(null),
      padre ? meta.insightsObjeto(padre.id, post).catch(() => null) : Promise.resolve(null),
      cuentaEn(pre), cuentaEn(post),
    ]);
    const o = ofertaDe([info.campaign?.name || info.name, info.adset?.name], p.ofertas);
    const tendCuenta = ctaPre?.cpa && ctaPost?.cpa ? ctaPost.cpa / ctaPre.cpa : 1;
    const tendPadre = padPre?.cpa && padPost?.cpa ? padPost.cpa / padPre.cpa : null;
    // Cuánto peor (o mejor) le fue al conjunto que a la cuenta en el mismo período.
    const relativo = tendPadre != null ? tendPadre / tendCuenta : null;

    let clasificacion; let razon;
    if (a.tipo === 'pausa') {
      const justificada = entPre && ((entPre.cpa != null && entPre.cpa > o.cpaMaximo) || (entPre.roas != null && entPre.roas < p.roasPausa) || (entPre.compras === 0 && (entPre.gasto || 0) > 0));
      if (relativo == null) {
        clasificacion = justificada ? 'acertada' : 'cuestionable';
        razon = justificada ? 'Estaba fuera de rango al pausarla; el conjunto no tiene compras suficientes antes y después para comparar' : 'Sin datos suficientes del conjunto para aislar el efecto';
      } else if (relativo >= 1.35) {
        clasificacion = 'contraproducente';
        razon = `Después de pausarla, el CPA del ${padre.tipo} empeoró ${fmt((tendPadre - 1) * 100)}% contra ${fmt((tendCuenta - 1) * 100)}% de la cuenta`;
      } else if (justificada && relativo <= 1.1) {
        clasificacion = 'acertada';
        razon = `Estaba fuera de rango y el ${padre.tipo} se sostuvo (${fmt((tendPadre - 1) * 100)}% vs cuenta ${fmt((tendCuenta - 1) * 100)}%)`;
      } else {
        clasificacion = 'cuestionable';
        razon = justificada ? `El ${padre.tipo} empeoró algo más que la cuenta (${fmt((tendPadre - 1) * 100)}% vs ${fmt((tendCuenta - 1) * 100)}%)` : 'Al pausarla no estaba claramente fuera de rango';
      }
    } else {
      const variacion = entPre?.cpa && entPost?.cpa ? pct(entPost.cpa, entPre.cpa) : null;
      if (entPost?.cpa != null && (entPost.cpa > o.cpaMaximo || (entPost.roas != null && entPost.roas < p.roasPausa))) {
        clasificacion = 'contraproducente';
        razon = `Después del escalado quedó fuera de rango: CPA ${fmt(entPost.cpa)} / ROAS ${fmt(entPost.roas, 2)}`;
      } else if (variacion != null && variacion <= p.elasticidadMaxPct) {
        clasificacion = 'acertada';
        razon = `El CPA varió ${fmt(variacion)}% (dentro de la elasticidad de ${p.elasticidadMaxPct}%)`;
      } else {
        clasificacion = 'cuestionable';
        razon = variacion != null ? `El CPA subió ${fmt(variacion)}%, más que la elasticidad aceptable (${p.elasticidadMaxPct}%)` : 'Sin datos posteriores suficientes';
      }
    }
    resultados.push({
      actividadId: a.id, entidad: a.entidad_nombre || info.name, entidadId: a.entidad_id, accion: a.tipo, fecha: dia,
      origen: a.origen, segmento: segmento(p, info.campaign?.name || info.name), campania: info.campaign?.name || info.name || null,
      clasificacion, etiqueta: CLASES[clasificacion], razon,
      capas: {
        entidad: { antes: entPre, despues: entPost },
        conjunto: padre ? { nombre: padre.nombre, antes: padPre, despues: padPost } : null,
        cuenta: { antes: ctaPre, despues: ctaPost },
      },
    });
  }

  // Patrones: el mismo tipo de decisión saliendo ⚠️/❌ 2+ veces (sumando auditorías previas).
  const historico = [...previas.flatMap(a => a.despues?.extra?.resultados || []), ...resultados];
  const conteo = {};
  for (const r of historico) {
    if (r.clasificacion === 'acertada') continue;
    const clave = `${r.accion === 'pausa' ? 'Pausas' : 'Escalados'} en ${r.segmento || 'frío'}`;
    conteo[clave] = (conteo[clave] || 0) + 1;
  }
  const patrones = Object.entries(conteo).filter(([, n]) => n >= 2).map(([tipo, veces]) => ({ tipo, veces }));
  return { resultados, patrones, auditables: acciones.length };
}

// ── ganadores caídos (§6.6) ──────────────────────────────────────────────────

async function estacionalidad(p, ventana) {
  // Conversión del sitio por día de los últimos ~100 días: ¿el mismo tramo del
  // mes (±3 días) ya vino flojo en 2+ de los meses anteriores?
  const filas = await shopifyql('FROM sessions SHOW sessions, conversion_rate SINCE -100d UNTIL today TIMESERIES day');
  const porDia = filas.map(f => ({ dia: f.day, conv: num(f.conversion_rate), ses: num(f.sessions) })).filter(f => f.ses > 0);
  const diaDelMes = (iso) => Number(iso.slice(8, 10));
  const desde = diaDelMes(ventana.since) - 3;
  const hasta = diaDelMes(ventana.until) + 3;
  const enTramo = (d) => (desde <= hasta ? (diaDelMes(d) >= desde && diaDelMes(d) <= hasta) : (diaDelMes(d) >= desde || diaDelMes(d) <= hasta));
  const meses = [...new Set(porDia.map(f => f.dia.slice(0, 7)))].filter(m => m < ventana.since.slice(0, 7)).slice(-3);
  let flojos = 0;
  const detalle = [];
  for (const m of meses) {
    const delMes = porDia.filter(f => f.dia.startsWith(m));
    const tramo = delMes.filter(f => enTramo(f.dia));
    if (!delMes.length || !tramo.length) continue;
    const prom = (xs) => xs.reduce((a, f) => a + f.conv, 0) / xs.length;
    const relacion = prom(tramo) / prom(delMes);
    if (relacion < 0.92) flojos++;
    detalle.push({ mes: m, relacion });
  }
  const tramoPasado = fechaUy() > sumarDias(ventana.until, 3);
  // Cuánto baja en promedio la conversión del sitio en ese tramo (en %).
  const bajones = detalle.filter(d => d.relacion < 0.92).map(d => (1 - d.relacion) * 100);
  const bajonPct = bajones.length ? bajones.reduce((a, x) => a + x, 0) / bajones.length : 0;
  return { confirmada: flojos >= 2, flojos, meses: detalle, tramoPasado, bajonPct };
}

async function ganadoresCaidos(cuenta, p, { actividad = [], inventario = null, pixel = null } = {}) {
  const hoy = fechaUy();
  const rango90 = rangoDias(sumarDias(hoy, -91), sumarDias(hoy, -1));
  const A = rangoDias(sumarDias(hoy, -7), sumarDias(hoy, -1));
  const [semSets, semAds] = await Promise.all([
    meta.insightsSemanales(cuenta, 'adset', rango90, { gastoMinimo: 300 }),
    meta.insightsSemanales(cuenta, 'ad', rango90, { gastoMinimo: 400 }),
  ]);
  verificarUsoApi();

  // Ganador = alguna semana con CPA < objetivo de su oferta y ROAS > escalado con volumen (§3/§6.6).
  const historial = new Map();
  for (const [nivel, filas] of [['conjunto', semSets], ['anuncio', semAds]]) {
    for (const f of filas) {
      const o = ofertaDe([f.nombres.campania, f.nombres.conjunto], p.ofertas);
      const gano = f.compras >= 3 && f.gasto >= o.cpaObjetivo && f.cpa < o.cpaObjetivo && f.roas != null && f.roas > p.roasEscalado;
      const k = `${nivel}:${f.id}`;
      if (!historial.has(k)) historial.set(k, { id: f.id, nivel, nombre: nivel === 'anuncio' ? f.nombres.anuncio : f.nombres.conjunto, campania: f.nombres.campania, oferta: o, semanas: [] });
      historial.get(k).semanas.push({ desde: f.desde, hasta: f.hasta, gano, cpa: f.cpa, roas: f.roas, gasto: f.gasto, compras: f.compras, frecuencia: f.frecuencia, ctr: f.ctr });
    }
  }
  const ganadores = [...historial.values()].filter(h => h.semanas.some(s => s.gano));
  if (!ganadores.length) return { casos: [], propuestas: [], observaciones: [] };

  // Estado actual de los ganadores, de a 50 por llamada.
  const estado = {};
  for (let i = 0; i < ganadores.length; i += 50) {
    Object.assign(estado, await meta.obtenerVarios(ganadores.slice(i, i + 50).map(g => g.id), 'effective_status,status,updated_time'));
  }
  const [setsA, adsA] = await Promise.all([meta.insightsPorNivel(cuenta, 'adset', A), meta.insightsPorNivel(cuenta, 'ad', A)]);

  const pausasRecientes = actividad.filter(a => a.tipo === 'pausa' && Date.now() - new Date(a.at).getTime() <= 30 * DIA_MS);
  const candidatos = [];
  for (const g of ganadores) {
    const e = estado[g.id];
    if (!e) continue;
    const m = (g.nivel === 'anuncio' ? adsA : setsA).get(g.id);
    const ultimaGanadora = g.semanas.filter(s => s.gano).map(s => s.hasta).sort().at(-1);
    const pausa = pausasRecientes.find(a => a.entidad_id === g.id);
    let caida = null;
    if (e.status === 'PAUSED' && (pausa || Date.now() - new Date(e.updated_time).getTime() <= 30 * DIA_MS)) {
      const fecha = pausa ? fechaUy(new Date(pausa.at)) : fechaUy(new Date(e.updated_time));
      caida = { tipo: 'pausado', fecha, ventana: rangoDias(sumarDias(fecha, -7), sumarDias(fecha, -1)), porPiloto: Boolean(pausa) };
    } else if (e.effective_status === 'ACTIVE' && m) {
      const confianza = m.compras >= p.volumenMinimo || m.gasto >= p.gastoMinimoCpa * g.oferta.cpaObjetivo;
      if (confianza && ((m.compras > 0 && m.cpa > g.oferta.cpaMaximo) || (m.roas != null && m.roas < p.roasPausa) || m.compras === 0)) {
        caida = { tipo: 'activo_fuera_de_rango', fecha: hoy, ventana: A };
      }
    }
    // Si la última semana ganadora es la más reciente, no cayó (todavía gana).
    if (caida && ultimaGanadora && ultimaGanadora >= caida.ventana.until) caida = null;
    if (caida) candidatos.push({ ...g, caida, actual: m || null, estadoMeta: e.effective_status, ultimaGanadora });
  }
  if (!candidatos.length) return { casos: [], propuestas: [], observaciones: [], ganadores: ganadores.length };

  // Diagnóstico (playbook del Rulebook): stock, medición, estacionalidad, cambios recientes.
  const coreAgotadas = (inventario?.core || []).filter(c => c.estado === 'agotada').map(c => c.variante);
  const purchase = pixel?.eventos?.find(x => x.evento === 'Purchase');
  const medicionRara = Boolean(purchase?.alerta);
  const casos = [];
  const propuestas = [];
  for (const c of candidatos) {
    verificarUsoApi();
    let est = null;
    try { est = await estacionalidad(p, c.caida.ventana); } catch { /* sin Shopify: se sigue sin este dato */ }
    const cambios = actividad.filter(a => a.entidad_id === c.id && a.tipo !== 'pausa'
      && new Date(a.at) >= new Date(new Date(c.caida.ventana.since).getTime() - 14 * DIA_MS) && new Date(a.at) <= new Date(c.caida.ventana.until));
    const ganadora = c.semanas.filter(s => s.gano).at(-1);
    const fatiga = c.actual && ganadora && ((c.actual.frecuencia > ganadora.frecuencia * 1.4) || (c.actual.ctr < ganadora.ctr * 0.7));
    // CPA al caer: el registrado al pausar (si lo pausó el piloto) o el actual.
    const pausaPropia = actividad.find(a => a.tipo === 'pausa' && a.entidad_id === c.id && a.antes?.cpa);
    const cpaCaida = pausaPropia?.antes?.cpa ?? c.actual?.cpa ?? null;
    const subaCpa = ganadora?.cpa && cpaCaida ? pct(cpaCaida, ganadora.cpa) : null;
    // Un bajón estacional chico no explica que el CPA se duplique (§6.6, corrida del 23/09).
    const explicaMagnitud = subaCpa == null || subaCpa <= Math.max(25, (est?.bajonPct || 0) * 3);
    let causa; let estadoCaso; let recomendacion;
    // El stock explica la caída si el anuncio es de una variante agotada o si
    // la falta es generalizada (3+ core); una sola agotada no alcanza para
    // atribuirle todas las caídas de la cuenta.
    const nombres = `${c.nombre} ${c.campania}`.toLowerCase();
    const agotadaPropia = coreAgotadas.filter(v => nombres.includes(v.toLowerCase()));
    const stockCausa = agotadaPropia.length > 0 || coreAgotadas.length >= 3;
    if (stockCausa) {
      causa = `Stock: ${agotadaPropia.length ? `la variante del anuncio está agotada (${agotadaPropia.join(', ')})` : `${coreAgotadas.length} variantes core agotadas (${coreAgotadas.join(', ')})`}`;
      estadoCaso = 'esperando';
      recomendacion = 'Reponer stock; se reevalúa cuando vuelvan a estar disponibles';
    } else if (medicionRara) {
      causa = `Medición: las compras del pixel cayeron ${fmt(-purchase.variacion)}% semana contra semana`;
      estadoCaso = 'ambigua';
      recomendacion = 'Revisar el pixel/CAPI antes de asumir que la caída es real';
    } else if (est?.confirmada && !explicaMagnitud) {
      causa = `Estacionalidad presente (el tramo baja ~${fmt(est.bajonPct)}% la conversión del sitio) pero no explica que el CPA subiera ${fmt(subaCpa)}%`;
      estadoCaso = 'ambigua';
      recomendacion = fatiga ? 'Probable fatiga: refrescar con una SICH nueva del mismo ángulo' : 'Revisar a mano';
    } else if (est?.confirmada && est.tramoPasado) {
      causa = `Estacionalidad: el mismo tramo del mes vino flojo en ${est.flojos} de los meses anteriores y ya pasó`;
      estadoCaso = 'resuelta';
      recomendacion = c.caida.tipo === 'pausado' ? 'Reencender al mismo presupuesto que tenía' : 'No hay nada que reactivar: se reevalúa en el próximo chequeo';
    } else if (est?.confirmada) {
      causa = `Estacionalidad: tramo del mes históricamente flojo (${est.flojos} meses), todavía no terminó`;
      estadoCaso = 'esperando';
      recomendacion = 'Esperar a que pase el tramo y reevaluar';
    } else if (fatiga) {
      causa = `Fatiga: frecuencia ${fmt(c.actual.frecuencia, 1)} (era ${fmt(ganadora.frecuencia, 1)}) · CTR ${fmt(c.actual.ctr, 2)}% (era ${fmt(ganadora.ctr, 2)}%)`;
      estadoCaso = 'ambigua';
      recomendacion = 'Refrescar con una SICH nueva del mismo ángulo';
    } else {
      causa = cambios.length ? `Coincide con cambios recientes: ${cambios.map(x => x.titulo).join('; ')}` : 'Sin causa clara identificada';
      estadoCaso = 'ambigua';
      recomendacion = 'Revisar a mano';
    }
    if (!stockCausa && coreAgotadas.length) causa += ` · además hay ${coreAgotadas.length} variante core agotada (${coreAgotadas.join(', ')})`;
    const caso = {
      id: c.id, nivel: c.nivel, nombre: c.nombre, campania: c.campania, oferta: c.oferta.tag,
      caida: c.caida, estadoMeta: c.estadoMeta, ultimaGanadora: c.ultimaGanadora,
      ganadora: ganadora ? { desde: ganadora.desde, hasta: ganadora.hasta, cpa: ganadora.cpa, roas: ganadora.roas, compras: ganadora.compras } : null,
      actual: c.actual ? { cpa: c.actual.cpa, roas: c.actual.roas, gasto: c.actual.gasto, compras: c.actual.compras, frecuencia: c.actual.frecuencia, ctr: c.actual.ctr } : null,
      estacionalidad: est, causa, estado: estadoCaso, recomendacion,
    };
    casos.push(caso);
    if (estadoCaso === 'resuelta' && c.caida.tipo === 'pausado') {
      propuestas.push({
        clave: `reencender:${c.id}`,
        job: 'ganadores',
        tipo: 'reencender',
        entidad_tipo: c.nivel,
        entidad_id: c.id,
        entidad_nombre: c.nombre,
        campania_nombre: c.campania,
        oferta: c.oferta.tag,
        titulo: `Reencender ${c.nombre}`,
        motivo: `Fue ganador (semana ${ganadora.desde}: CPA ${fmt(ganadora.cpa)} / ROAS ${fmt(ganadora.roas, 2)}) y cayó por una causa ya resuelta. ${causa}`,
        regla: '§6.6 · ganador caído',
        avisos: ['Vuelve al mismo presupuesto que tenía al pausarse (nunca escalado de entrada)'],
        prioridad: 30,
        payload: { estado: 'ACTIVE' },
        snapshot: { metricas: caso.actual, ganadora: caso.ganadora },
      });
    }
  }
  const observaciones = casos.filter(x => x.estado !== 'resuelta' || x.caida.tipo !== 'pausado')
    .map(x => ({ entidad: x.nombre, motivo: `Ganador caído (${x.estado === 'esperando' ? 'esperando resolución' : 'causa ambigua'}): ${x.causa}. ${x.recomendacion}` }));
  return { casos, propuestas, observaciones, ganadores: ganadores.length };
}

module.exports = { reporteSemanal, auditarDecisiones, ganadoresCaidos, inventarioCore, saludPixel, revisarAudiencias };

// Fase 4 del piloto de Meta Ads: las tareas que redactan o investigan, con
// la API de Claude. Reemplazan a:
//   velinne-ads-weekly-digest (pasos 7-7.4 y 9B) → generarBrief      (Rulebook §8.4)
//   velinne-ads-monthly-strategic                → generarMensual    (Rulebook §8, §8.4)
//   velinne-meta-policy-check                    → chequearPoliticas (Rulebook §5)
// Ninguna cambia nada sola: devuelven un informe y propuestas para la bandeja
// (crear la carpeta SICH, aprobar ideas, ajustar parámetros, enmiendas).

const meta = require('./metaAdsService');
const supabaseService = require('./supabaseService');
const ingesta = require('./metaAdsIngestaService');
const ia = require('./metaAdsIAService');
const { resumenRulebook } = require('./metaAdsRulebook');
const { DEFINICIONES, ofertaDe } = require('./metaAdsParametros');

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
const r1 = (n) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 10) / 10);
const r0 = (n) => (n == null || !Number.isFinite(n) ? null : Math.round(n));

// Claves numéricas que una propuesta de ajuste puede tocar (nunca IDs ni textos).
const CLAVES_AJUSTABLES = DEFINICIONES.filter(d => d.tipo !== 'texto').map(d => d.clave);

const SISTEMA_BASE = (p) => `Sos el analista de Meta Ads de Velinne. Escribís en español rioplatense, claro y directo, para el dueño del negocio (no para un técnico). Priorizá qué decisión se desprende de cada dato; no rellenes. Si algo no tiene evidencia suficiente, decilo.

Contexto de la cuenta y reglas vigentes:
${resumenRulebook(p)}`;

// ── brief creativo semanal (§8.4) ────────────────────────────────────────────

const RE_ANGULO = /ABO-Advantage\+ Audience - (.+?) - (VEL\d+|ADSET\d+)/i;

function agregarPorAngulo(filas, anguloDe) {
  const grupos = new Map();
  for (const f of filas) {
    const angulo = anguloDe(f);
    if (!angulo) continue;
    if (!grupos.has(angulo)) grupos.set(angulo, { angulo, anuncios: 0, gasto: 0, impresiones: 0, clics: 0, compras: 0, valor: 0, carritos: 0, vistas3s: 0, impVideo: 0, p25: 0, p100: 0, top: [] });
    const g = grupos.get(angulo);
    g.anuncios++; g.gasto += f.gasto; g.impresiones += f.impresiones; g.clics += f.clics; g.compras += f.compras;
    g.valor += f.valorCompras; g.carritos += f.agregarAlCarrito;
    if (f.esVideo && f.hook != null) {
      g.impVideo += f.impresiones; g.vistas3s += (f.hook / 100) * f.impresiones;
      g.p25 += ((f.vistoP25 || 0) / 100) * f.impresiones; g.p100 += ((f.vistoP100 || 0) / 100) * f.impresiones;
    }
    g.top.push({ anuncio: f.anuncio, gasto: r0(f.gasto), ctr: r1(f.ctr), hook: r1(f.hook), compras: f.compras });
  }
  return [...grupos.values()].map(g => ({
    angulo: g.angulo,
    anuncios: g.anuncios,
    gasto: r0(g.gasto),
    ctrEnlace: g.impresiones ? r1((g.clics / g.impresiones) * 100) : null,
    hook: g.impVideo ? r1((g.vistas3s / g.impVideo) * 100) : null,
    vistoAl25: g.impVideo ? r1((g.p25 / g.impVideo) * 100) : null,
    vistoCompleto: g.impVideo ? r1((g.p100 / g.impVideo) * 100) : null,
    compras: g.compras,
    cpa: g.compras ? r0(g.gasto / g.compras) : null,
    roas: g.gasto ? r1(g.valor / g.gasto) : null,
    costoCarrito: g.carritos ? r0(g.gasto / g.carritos) : null,
    mejores: g.top.sort((a, b) => b.gasto - a.gasto).slice(0, 3),
  })).sort((a, b) => b.gasto - a.gasto);
}

async function datosBrief(cuenta, p, actividad) {
  const hoy = fechaUy();
  const A = { since: sumarDias(hoy, -7), until: sumarDias(hoy, -1) };
  const B = { since: sumarDias(hoy, -14), until: sumarDias(hoy, -8) };
  const [actual, previa, anunciosVel, sich] = await Promise.all([
    meta.insightsCreativos(cuenta, A),
    meta.insightsCreativos(cuenta, B),
    meta.buscarAnunciosPorNombre(cuenta, 'VEL'),
    ingesta.angulosPorSich(p, 12),
  ]);
  // VELn → ángulo, sacado del nombre de su ad set de testeo (los anuncios
  // graduados a una CBO se llaman "VELn - CBO" y heredan el ángulo).
  const anguloPorVel = new Map();
  for (const a of anunciosVel) {
    const m = RE_ANGULO.exec(a.conjuntoNombre || '');
    if (m) anguloPorVel.set(m[2].toUpperCase(), m[1].trim());
  }
  const anguloDe = (f) => {
    const m = RE_ANGULO.exec(f.conjunto || '');
    if (m) return m[1].trim();
    const vel = /VEL\d+/i.exec(f.anuncio || '')?.[0]?.toUpperCase();
    return vel ? anguloPorVel.get(vel) || null : null;
  };
  const ideasAprobadas = actividad.filter(a => a.tipo === 'decision' && a.despues?.tipo === 'idea_aprobada' && !a.despues?.usada)
    .map(a => ({ angulo: a.despues.angulo, hipotesis: a.despues.hipotesis, fuente: a.despues.fuente || null }));
  return {
    ventana: { actual: A, previa: B },
    angulosActual: agregarPorAngulo(actual, anguloDe),
    angulosPrevia: agregarPorAngulo(previa, anguloDe).map(({ mejores, ...resto }) => resto),
    sinAngulo: actual.filter(f => !anguloDe(f)).sort((a, b) => b.gasto - a.gasto).slice(0, 8)
      .map(f => ({ anuncio: f.anuncio, campania: f.campania, gasto: r0(f.gasto), ctr: r1(f.ctr), hook: r1(f.hook), compras: f.compras })),
    tandasRecientes: sich.tandas,
    proximaSich: sich.proxima,
    ideasAprobadas,
  };
}

const SCHEMA_BRIEF = {
  type: 'object',
  additionalProperties: false,
  required: ['resumen', 'brief_editor', 'angulos_confirmados', 'ideas_especulativas'],
  properties: {
    resumen: { type: 'string', description: 'Análisis para el dueño en markdown: qué ángulos y hooks vienen funcionando y cuáles no, con números.' },
    brief_editor: { type: 'string', description: 'Brief en markdown para reenviar al editor de video. SIN CPA, ROAS, presupuestos ni datos de negocio.' },
    angulos_confirmados: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['angulo', 'hipotesis', 'razon'],
        properties: { angulo: { type: 'string' }, hipotesis: { type: 'string' }, razon: { type: 'string' } },
      },
    },
    ideas_especulativas: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['angulo', 'hipotesis', 'fuente'],
        properties: { angulo: { type: 'string' }, hipotesis: { type: 'string' }, fuente: { type: 'string' } },
      },
    },
  },
};

async function generarBrief(cuenta, p, actividad) {
  const datos = await datosBrief(cuenta, p, actividad);
  const sistema = SISTEMA_BASE(p);
  const prompt = `Armá el brief creativo semanal (Rulebook §8.4) con estos datos de los últimos 7 días contra los 7 anteriores, agrupados por ángulo. El ángulo es el tema del creativo; vive en la imagen o el video, no en el copy.

Cómo leerlos: ctrEnlace es el CTR de clics al sitio (más bajo que el CTR general de Meta). El CTR y el hook (reproducciones de 3 segundos sobre impresiones) miden qué tan bien engancha; el % visto mide si sostiene. Cruzalo con CPA/ROAS para ver si el enganche se traduce en ventas. Marcá explícitamente "buen hook, floja conversión" (CTR o hook altos, CPA malo) como algo distinto de un ganador real. Un ángulo con un ganador claro y sano NO necesita creativo nuevo sólo por existir.

Para cada ángulo decidí si necesita creativo nuevo esta semana, con una razón corta, y armá la lista de ángulos confirmados por datos, cada uno con una hipótesis concreta (qué hook, formato o mensaje probar y por qué, en términos de enganche, sin costos).

Si ningún ángulo califica, generá 1 o 2 ideas especulativas, cada una con una fuente declarada: un ángulo o formato que la cuenta todavía no probó (mirá las tandas recientes para no repetir), el paso del embudo más débil, o algo que estén haciendo marcas de referencia (Ohora, Maniko Nails, Polish Pops, Pinx Nails, Bright UY, Sassy Nails); podés buscar en la web para eso. No inventes métricas para una especulativa.

${datos.ideasAprobadas.length ? `Ideas especulativas ya aprobadas por el dueño, que entran como confirmadas en la próxima tanda: ${JSON.stringify(datos.ideasAprobadas)}` : ''}

Escribí dos cosas: (1) el análisis para el dueño, y (2) el brief para el editor de video, listo para reenviar, SIN CPA, ROAS, presupuestos ni ningún dato de negocio: sólo qué viene enganchando, qué probar la semana que viene y por qué, y referencias si las hay.

Datos:
${JSON.stringify(datos)}`;
  const informe = await ia.investigar({ sistema, prompt, web: true, maxBusquedas: 4, effort: 'high' });
  const { datos: salida, uso } = await ia.estructurar({
    sistema,
    instruccion: 'Pasá este informe al formato pedido. "resumen" es el análisis para el dueño y "brief_editor" el brief para el editor (sin costos). Copiá las hipótesis tal cual; no agregues ángulos que el informe no proponga.',
    texto: informe.texto,
    schema: SCHEMA_BRIEF,
  });
  return { ...salida, proximaSich: datos.proximaSich, ideasAprobadas: datos.ideasAprobadas, datos, fuentes: informe.fuentes, uso: ia.acumularUso(informe.uso, { input_tokens: uso.entrada, output_tokens: uso.salida }), modelo: informe.modelo };
}

// ── resumen estratégico mensual ──────────────────────────────────────────────

function mesAnterior(n = 1) {
  const [y, m] = fechaUy().split('-').map(Number);
  const inicio = new Date(Date.UTC(y, m - 1 - n, 1));
  const fin = new Date(Date.UTC(y, m - n, 0));
  return { since: inicio.toISOString().slice(0, 10), until: fin.toISOString().slice(0, 10), nombre: new Intl.DateTimeFormat('es-UY', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(inicio) };
}

const SCHEMA_MENSUAL = {
  type: 'object',
  additionalProperties: false,
  required: ['resumen', 'ajustes', 'recomendaciones'],
  properties: {
    resumen: { type: 'string', description: 'Resumen mensual en markdown, en el orden pedido.' },
    ajustes: {
      type: 'array',
      description: 'Cambios de parámetros que el informe propone explícitamente con datos que los respaldan.',
      items: {
        type: 'object', additionalProperties: false, required: ['clave', 'valor', 'razon'],
        properties: { clave: { type: 'string', enum: CLAVES_AJUSTABLES }, valor: { type: 'number' }, razon: { type: 'string' } },
      },
    },
    recomendaciones: { type: 'array', items: { type: 'string' } },
  },
};

async function generarMensual(cuenta, p, { ultimoReporte = null, ultimaAuditoria = null } = {}) {
  const mes = mesAnterior(1);
  const previo = mesAnterior(2);
  const [actual, anterior, campActual, campAnterior] = await Promise.all([
    meta.insightsCuenta(cuenta, mes), meta.insightsCuenta(cuenta, previo),
    meta.insightsPorNivel(cuenta, 'campaign', mes), meta.insightsPorNivel(cuenta, 'campaign', previo),
  ]);
  const campanias = [...campActual.values()].map(m => {
    const antes = [...campAnterior.values()].find(x => x.nombres.campania === m.nombres.campania);
    return { campania: m.nombres.campania, oferta: ofertaDe([m.nombres.campania], p.ofertas).tag, gasto: r0(m.gasto), compras: m.compras, cpa: r0(m.cpa), roas: r1(m.roas), cpaMesAnterior: r0(antes?.cpa), roasMesAnterior: r1(antes?.roas) };
  }).sort((a, b) => b.gasto - a.gasto).slice(0, 15);
  const resumirCuenta = (x) => x && ({ gasto: r0(x.gasto), compras: x.compras, cpa: r0(x.cpa), roas: r1(x.roas), cpm: r0(x.cpm), ctr: r1(x.ctr), frecuencia: r1(x.frecuencia) });
  const datos = {
    mes: mes.nombre, mesAnterior: previo.nombre,
    cuenta: { actual: resumirCuenta(actual), anterior: resumirCuenta(anterior) },
    campanias,
    elasticidad: ultimoReporte?.elasticidad || null,
    inventario: ultimoReporte?.inventario ? { agotadas: ultimoReporte.inventario.core.filter(c => c.estado === 'agotada').map(c => c.variante), bajas: ultimoReporte.inventario.core.filter(c => c.estado === 'bajo').map(c => c.variante) } : null,
    funnel: ultimoReporte?.funnel ? { etapas: ultimoReporte.funnel.etapas, peor: ultimoReporte.funnel.peor?.label } : null,
    patronesAuditoria: ultimaAuditoria?.patrones || [],
    parametrosActuales: Object.fromEntries(CLAVES_AJUSTABLES.map(k => [k, p[k]])),
  };
  const sistema = SISTEMA_BASE(p);
  const prompt = `Armá el resumen estratégico de ${mes.nombre} (más de fondo que el semanal: tendencias, referentes y recomendaciones; no repitas el detalle campaña por campaña).

1. Buscá en la web si Felipe Vergara (felipevergara.co) o Caro Dubi / Giver Solutions (carodubi.com) publicaron algo nuevo y aplicable en el último mes (frameworks, cambios de estrategia, novedades del algoritmo de Meta). Si hay algo, resumilo en 2-3 líneas y proponé cómo se traduce en un test concreto para Velinne. Si no hay nada relevante, decilo en una línea.
2. Buscá novedades de las marcas de referencia: internacionales Ohora, Maniko Nails, Polish Pops, Pinx Nails; regionales Bright UY (Uruguay) y Sassy Nails (Argentina). Si encontrás un ángulo o formato interesante, sumalo como sugerencia de test para el editor citando la marca. La Biblioteca de Anuncios de Meta no es accesible desde acá: no inventes anuncios que no hayas visto.
3. Calibración de elasticidad: con los escalados medidos, ¿el ${p.elasticidadMaxPct}% aceptable y la subida de ${p.escaladoPct}% por paso siguen bien o conviene ajustarlos? Proponé un valor sólo si hay 3 o más casos que lo respalden.
4. Recomendaciones de fondo: ¿conviene revisar la estructura de la cuenta (muy fragmentada, muchas campañas de gasto bajo sin resultados)?

Orden de salida: 1) Pendiente de tu decisión (ajustes propuestos; si no hay, decilo), 2) Panorama del mes (3-5 líneas), 3) Referentes, 4) Marcas de referencia, 5) Elasticidad, 6) Recomendaciones de fondo. Citá las fuentes web que uses.

Datos del mes:
${JSON.stringify(datos)}`;
  const informe = await ia.investigar({ sistema, prompt, web: true, maxBusquedas: 10, effort: 'high' });
  const { datos: salida, uso } = await ia.estructurar({
    sistema,
    instruccion: `Pasá este informe al formato pedido. En "ajustes" incluí sólo cambios de parámetros que el informe proponga explícitamente, con la clave exacta de esta lista: ${CLAVES_AJUSTABLES.join(', ')}. Si no propone ninguno, dejá la lista vacía.`,
    texto: informe.texto,
    schema: SCHEMA_MENSUAL,
  });
  return { ...salida, mes: mes.nombre, datos, fuentes: informe.fuentes, uso: ia.acumularUso(informe.uso, { input_tokens: uso.entrada, output_tokens: uso.salida }), modelo: informe.modelo };
}

// ── chequeo quincenal de políticas de Meta (§5) ──────────────────────────────

const SCHEMA_POLITICAS = {
  type: 'object',
  additionalProperties: false,
  required: ['resumen', 'novedades', 'ajustes'],
  properties: {
    resumen: { type: 'string', description: 'Resumen en markdown; si no hay novedades relevantes, una línea que lo diga.' },
    novedades: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['titulo', 'fecha', 'fuente', 'impacto', 'afecta_regla', 'regla', 'enmienda'],
        properties: {
          titulo: { type: 'string' }, fecha: { type: 'string' }, fuente: { type: 'string', description: 'URL' },
          impacto: { type: 'string', description: 'Qué cambia para un anunciante chico de e-commerce en Uruguay.' },
          afecta_regla: { type: 'boolean' },
          regla: { type: 'string', description: 'Sección o regla del Rulebook afectada; vacío si no afecta.' },
          enmienda: { type: 'string', description: 'Cambio concreto propuesto a la regla; vacío si no afecta.' },
        },
      },
    },
    ajustes: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['clave', 'valor', 'razon'],
        properties: { clave: { type: 'string', enum: CLAVES_AJUSTABLES }, valor: { type: 'number' }, razon: { type: 'string' } },
      },
    },
  },
};

async function chequearPoliticas(p) {
  const desde = sumarDias(fechaUy(), -16);
  const sistema = SISTEMA_BASE(p);
  const prompt = `Revisá si hubo anuncios o cambios relevantes de Meta desde el ${desde}: Meta Business Blog / Advertiser Help Center (producto o política publicitaria) y Advertising Standards / Transparency Center. Enfocate en lo que pueda afectar a un anunciante chico de e-commerce en Uruguay con campañas de ventas y retargeting (fase de aprendizaje, presupuestos, atribución, Advantage+, estructura recomendada, límites de API, políticas de contenido o de datos). Ignorá verticales que no aplican (política, vivienda, empleo, crédito).

Para cada novedad relevante: qué cambió, fecha, fuente, qué regla del Rulebook afecta (si afecta) y qué enmienda concreta proponés. No cambies nada vos: es una propuesta para que el dueño decida. Si no hay nada relevante, decilo en una línea. Esto no es un resumen de noticias: sólo lo que importa para esta cuenta.`;
  const informe = await ia.investigar({
    sistema, prompt, web: true, maxBusquedas: 10, effort: 'medium',
  });
  const { datos: salida, uso } = await ia.estructurar({
    sistema,
    instruccion: `Pasá este informe al formato pedido. "ajustes" sólo si una enmienda se traduce directamente en un cambio de parámetro de esta lista: ${CLAVES_AJUSTABLES.join(', ')}.`,
    texto: informe.texto,
    schema: SCHEMA_POLITICAS,
  });
  return { ...salida, desde, fuentes: informe.fuentes, uso: ia.acumularUso(informe.uso, { input_tokens: uso.entrada, output_tokens: uso.salida }), modelo: informe.modelo };
}

module.exports = { generarBrief, generarMensual, chequearPoliticas, datosBrief, CLAVES_AJUSTABLES };

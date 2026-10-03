// Piloto de Meta Ads con aprobación humana.
//
// Reemplaza a las tareas programadas que ejecutaban solas (velinne-ads-daily-check,
// velinne-ads-auto-graduate, velinne-dashboard-maintenance): los jobs de acá
// evalúan las reglas del Rulebook y generan PROPUESTAS. Nada se escribe en Meta
// hasta que un admin aprueba; al aprobar se revalida contra el estado real.
//
// Jobs:
//   pausa_escalado — Rulebook §2 (pausa), §3 (escalado), §6.1 (nivel temprano negativo de testeo)
//   graduacion     — Rulebook §6.2 (graduar ganador a su CBO + duplicar a retargeting)

const meta = require('./metaAdsService');
const supabaseService = require('./supabaseService');
const logService = require('./logService');
const { completar, ofertaDe } = require('./metaAdsParametros');
const ingesta = require('./metaAdsIngestaService');
const analisis = require('./metaAdsAnalisisService');
const estrategia = require('./metaAdsEstrategiaService');
const ia = require('./metaAdsIAService');
const { DEFINICIONES, limpiarParametros } = require('./metaAdsParametros');

const TZ = 'America/Montevideo';
const DIA_MS = 24 * 60 * 60 * 1000;
const USO_API_MAXIMO = 80; // Rulebook 4.1: frenar antes del 100%

// ── utilidades ───────────────────────────────────────────────────────────────

function fechaUy(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}
function sumarDias(fechaIso, dias) {
  const d = new Date(`${fechaIso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}
function diasDesde(iso) {
  return iso ? (Date.now() - new Date(iso).getTime()) / DIA_MS : Infinity;
}
const fmt = (n, dec = 0) => (n == null || !Number.isFinite(n) ? '—' : Number(n).toLocaleString('es-UY', { maximumFractionDigits: dec, minimumFractionDigits: dec }));
const contiene = (texto, patron) => {
  if (!texto || !patron) return false;
  try { return new RegExp(patron, 'i').test(texto); } catch { return texto.toLowerCase().includes(patron.toLowerCase()); }
};

async function cargarParametros() {
  try {
    const fila = await supabaseService.obtenerParametrosMetaAds();
    return completar(fila?.parametros);
  } catch {
    return completar({});
  }
}

// Ventanas de 7 días (Meta no incluye el día en curso):
//   A  = últimos 7 días completos         (lectura de hoy)
//   A2 = los 7 días que terminan anteayer  (lectura de ayer → "2 lecturas")
//   B  = los 7 días previos a A            (¿el problema ya venía de antes?)
function ventanas() {
  const hoy = fechaUy();
  return {
    A: { since: sumarDias(hoy, -7), until: sumarDias(hoy, -1) },
    A2: { since: sumarDias(hoy, -8), until: sumarDias(hoy, -2) },
    B: { since: sumarDias(hoy, -14), until: sumarDias(hoy, -8) },
    // "Vida" de los ad sets de testeo: alcanza con 6 meses (Meta acepta hasta 37).
    vidaHastaHoy: { since: sumarDias(hoy, -180), until: hoy },
    vidaHastaAyer: { since: sumarDias(hoy, -180), until: sumarDias(hoy, -1) },
  };
}

function verificarUsoApi() {
  const uso = meta.usoApiActual();
  if (uso >= USO_API_MAXIMO) {
    throw new Error(`Uso de la API de Meta en ${uso}%: se frena la corrida para no llegar al límite (Rulebook 4.1)`);
  }
}

// ── contexto común de las corridas ───────────────────────────────────────────

async function cargarContexto(cuentaId) {
  const cuenta = cuentaId || meta.cuentaPorDefecto();
  if (!cuenta) throw new Error('Falta META_AD_ACCOUNT_ID');
  const p = await cargarParametros();
  const v = ventanas();
  const estructura = await meta.estructuraCuenta(cuenta);
  verificarUsoApi();
  // Una consulta por nivel y ventana (no una por entidad).
  const [adA, adA2, adB, setA, setA2, setB, campA, setVida, setVidaAyer] = await Promise.all([
    meta.insightsPorNivel(cuenta, 'ad', v.A),
    meta.insightsPorNivel(cuenta, 'ad', v.A2),
    meta.insightsPorNivel(cuenta, 'ad', v.B),
    meta.insightsPorNivel(cuenta, 'adset', v.A),
    meta.insightsPorNivel(cuenta, 'adset', v.A2),
    meta.insightsPorNivel(cuenta, 'adset', v.B),
    meta.insightsPorNivel(cuenta, 'campaign', v.A),
    meta.insightsPorNivel(cuenta, 'adset', v.vidaHastaHoy),
    meta.insightsPorNivel(cuenta, 'adset', v.vidaHastaAyer),
  ]);
  let actividad = [];
  try {
    actividad = await supabaseService.listarActividadMetaAds({ desde: new Date(Date.now() - 45 * DIA_MS).toISOString(), limite: 2000 });
  } catch { /* sin tabla: las cadencias se evalúan sólo con fechas de Meta */ }

  const campaniaPorId = new Map(estructura.campanias.map(c => [c.id, c]));
  const anunciosPorConjunto = new Map();
  for (const a of estructura.anuncios) {
    if (!anunciosPorConjunto.has(a.conjuntoId)) anunciosPorConjunto.set(a.conjuntoId, []);
    anunciosPorConjunto.get(a.conjuntoId).push(a);
  }
  return {
    cuenta, p, v, estructura, actividad, campaniaPorId, anunciosPorConjunto,
    ins: { adA, adA2, adB, setA, setA2, setB, campA, setVida, setVidaAyer },
  };
}

// Última acción registrada sobre una entidad (opcionalmente de ciertos tipos).
function ultimaAccion(ctx, entidadId, tipos) {
  return ctx.actividad.find(a => a.entidad_id === entidadId && a.tipo !== 'corrida' && (!tipos || tipos.includes(a.tipo))) || null;
}

const esTesteo = (ctx, campania) => contiene(campania?.nombre, ctx.p.patronTesteo);
const esRetargeting = (ctx, campania) => contiene(campania?.nombre, ctx.p.patronRetargeting);
const activos = (lista) => (lista || []).filter(x => x.estadoEfectivo === 'ACTIVE');

// ── job: pausa y escalado (Rulebook §2, §3, §6.1) ────────────────────────────

function evaluarCriterioPausa(m, oferta, p) {
  if (!m || m.gasto <= 0) return null;
  const gastoMinimo = p.gastoMinimoCpa * oferta.cpaObjetivo;
  const confianza = m.compras >= p.volumenMinimo || m.gasto >= gastoMinimo;
  if (m.compras === 0 && m.gasto >= gastoMinimo) {
    return { regla: '§2 · sin resultados', motivo: `Gastó $${fmt(m.gasto)} sin ventas (límite $${fmt(gastoMinimo)})`, dosLecturas: false };
  }
  if (confianza && m.compras > 0 && m.cpa > oferta.cpaMaximo) {
    return { regla: '§2 · CPA máximo', motivo: `CPA $${fmt(m.cpa)} sobre el máximo de ${oferta.tag} ($${fmt(oferta.cpaMaximo)})`, dosLecturas: true };
  }
  if (confianza && m.roas != null && m.roas < p.roasPausa) {
    return { regla: '§2 · ROAS mínimo', motivo: `ROAS ${fmt(m.roas, 2)} bajo el mínimo de ${fmt(p.roasPausa, 1)}`, dosLecturas: true };
  }
  return null;
}

function evaluarFrecuencia(m, oferta, p, retargeting) {
  const cap = retargeting ? p.frecuenciaRetargeting : p.frecuenciaFrio;
  if (m && m.compras === 0 && m.frecuencia > cap && m.gasto >= oferta.cpaObjetivo * 0.5) {
    return { regla: '§2 · frecuencia', motivo: `Frecuencia ${fmt(m.frecuencia, 1)} (tope ${fmt(cap, 1)}) sin ventas`, dosLecturas: false };
  }
  return null;
}

// Nivel temprano negativo de testeo (§6.1): CTR crítico o sin progreso de embudo.
function evaluarTempranoNegativo(ctx, conjunto, oferta) {
  const { p } = ctx;
  const vida = ctx.ins.setVida.get(conjunto.id);
  if (!vida) return null;
  const compraRentable = vida.compras >= 1 && vida.cpa != null && vida.cpa <= oferta.cpaMaximo;
  if (compraRentable) return null;
  const checkpoint = (m, dias) => dias >= p.testeoCheckpointDias || (m && m.gasto >= oferta.cpaObjetivo * p.testeoCheckpointGastoPct / 100);
  const dias = diasDesde(conjunto.inicio || conjunto.creado);
  if (!checkpoint(vida, dias)) return null;

  if (vida.impresiones >= p.testeoImpresionesMin && vida.ctr < p.ctrMinimo) {
    return { regla: '§6.1 · temprano negativo (CTR)', motivo: `CTR ${fmt(vida.ctr, 2)}% con ${fmt(vida.impresiones)} impresiones, sin compra rentable` };
  }
  const sinEmbudo = (m) => m && m.agregarAlCarrito === 0 && m.iniciarPago === 0;
  if (sinEmbudo(vida)) {
    const ayer = ctx.ins.setVidaAyer.get(conjunto.id);
    if (sinEmbudo(ayer) && checkpoint(ayer, dias - 1)) {
      return { regla: '§6.1 · temprano negativo (embudo)', motivo: `0 carritos y 0 pagos iniciados en 2 lecturas ($${fmt(vida.gasto)} gastados)` };
    }
    return { observacion: `Sin carritos ni pagos iniciados: se confirma mañana (2ª lectura)` };
  }
  return null;
}

function clasificarSegmentoRtg(ctx, conjunto) {
  return conjunto.audiencias.some(a => contiene(a, ctx.p.patronIntencionAlta)) ? 'intención alta' : 'engagement general';
}

function evaluarPausasYEscalados(ctx) {
  const { p, estructura } = ctx;
  const propuestas = [];
  const observaciones = [];
  let evaluados = 0;
  let protegidos = 0;

  // ── pausas ──
  const candidatosPausa = [];
  for (const conjunto of estructura.conjuntos) {
    const campania = ctx.campaniaPorId.get(conjunto.campaniaId);
    const anunciosActivos = activos(ctx.anunciosPorConjunto.get(conjunto.id));
    if (!campania || conjunto.estadoEfectivo !== 'ACTIVE' || !anunciosActivos.length) continue; // sin entrega real
    const oferta = ofertaDe([campania.nombre, conjunto.nombre], p.ofertas);
    const testeo = esTesteo(ctx, campania);
    const retargeting = esRetargeting(ctx, campania);

    // Testeo: nivel temprano negativo (puede actuar antes de los 7 días).
    if (testeo) {
      evaluados++;
      const t = evaluarTempranoNegativo(ctx, conjunto, oferta);
      if (t?.observacion) observaciones.push({ entidad: conjunto.nombre, motivo: t.observacion });
      else if (t && !ultimaAccion(ctx, conjunto.id, ['pausa'])) {
        candidatosPausa.push({ nivel: 'conjunto', entidad: conjunto, campania, oferta, criterio: t, m: ctx.ins.setVida.get(conjunto.id), testeo, retargeting });
        continue;
      }
    }

    // Granularidad (§2): con 2+ anuncios activos se evalúa cada anuncio, nunca el ad set.
    const unidades = anunciosActivos.length >= 2
      ? anunciosActivos.map(a => ({ nivel: 'anuncio', entidad: a, mA: ctx.ins.adA.get(a.id), mA2: ctx.ins.adA2.get(a.id), mB: ctx.ins.adB.get(a.id), creado: a.creado }))
      : [{ nivel: 'conjunto', entidad: conjunto, mA: ctx.ins.setA.get(conjunto.id), mA2: ctx.ins.setA2.get(conjunto.id), mB: ctx.ins.setB.get(conjunto.id), creado: conjunto.inicio || conjunto.creado }];

    for (const u of unidades) {
      if (!u.mA) continue;
      evaluados++;
      if (diasDesde(u.creado) < p.noTocarDias) { protegidos++; continue; }
      const previa = ultimaAccion(ctx, u.entidad.id);
      if (previa && diasDesde(previa.at) < p.cadenciaAccionDias) { protegidos++; continue; }

      const criterio = evaluarCriterioPausa(u.mA, oferta, p) || evaluarFrecuencia(u.mA, oferta, p, retargeting);
      if (!criterio) continue;
      // Confirmación de caída súbita (§2): si la semana anterior estaba sana,
      // hace falta que ayer también se cumpliera el criterio (2ª lectura).
      if (criterio.dosLecturas) {
        const yaVenia = evaluarCriterioPausa(u.mB, oferta, p);
        const ayer = evaluarCriterioPausa(u.mA2, oferta, p);
        if (!yaVenia && !ayer) {
          observaciones.push({ entidad: u.entidad.nombre, motivo: `${criterio.motivo} — caída nueva, se confirma mañana` });
          continue;
        }
        criterio.motivo += yaVenia ? ' (ya venía de la semana anterior)' : ' (2ª lectura confirma)';
      }
      candidatosPausa.push({ nivel: u.nivel, entidad: u.entidad, campania, conjunto, oferta, criterio, m: u.mA, testeo, retargeting });
    }
  }

  // "Un cambio a la vez" por conjunto con aprendizaje compartido (§2): fuera de
  // testeo, por cada ad set (o CBO) se propone sólo el de más gasto.
  const porPadre = new Map();
  for (const c of candidatosPausa) {
    const padre = c.testeo ? `solo:${c.entidad.id}` : (c.nivel === 'anuncio' ? c.conjunto.id : (c.campania.presupuestoDiario ? c.campania.id : `solo:${c.entidad.id}`));
    if (!porPadre.has(padre)) porPadre.set(padre, []);
    porPadre.get(padre).push(c);
  }
  for (const grupo of porPadre.values()) {
    grupo.sort((a, b) => (b.m?.gasto || 0) - (a.m?.gasto || 0));
    const [c, ...diferidos] = grupo;
    for (const d of diferidos) observaciones.push({ entidad: d.entidad.nombre, motivo: `${d.criterio.motivo} — diferido: un cambio a la vez en el mismo conjunto` });

    const avisos = [];
    let prioridad = 30;
    // Peso dentro del conjunto (§2: <10% del gasto = Meta ya lo desprioriza).
    if (c.nivel === 'anuncio') {
      const total = ctx.ins.setA.get(c.conjunto.id)?.gasto || 0;
      const share = total > 0 ? (c.m.gasto / total) * 100 : null;
      if (share != null && share < 10) { avisos.push(`Es sólo el ${fmt(share)}% del gasto del ad set: Meta ya lo desprioriza`); prioridad = 60; }
    }
    // Piso de cobertura de retargeting por segmento (§2).
    if (c.retargeting && c.nivel === 'conjunto') {
      const segmento = clasificarSegmentoRtg(ctx, c.entidad);
      const otros = estructura.conjuntos.filter(s => s.id !== c.entidad.id && s.estadoEfectivo === 'ACTIVE'
        && esRetargeting(ctx, ctx.campaniaPorId.get(s.campaniaId))
        && activos(ctx.anunciosPorConjunto.get(s.id)).length
        && clasificarSegmentoRtg(ctx, s) === segmento);
      if (!otros.length) {
        avisos.push(`Es el único ad set de retargeting de ${segmento}: pausarlo deja ese público sin retargeting`);
        prioridad = 10;
      }
    }
    const nombreCampania = c.campania.nombre;
    propuestas.push({
      clave: `pausa:${c.entidad.id}`,
      job: 'pausa_escalado',
      tipo: 'pausa',
      entidad_tipo: c.nivel,
      entidad_id: c.entidad.id,
      entidad_nombre: c.entidad.nombre,
      campania_nombre: nombreCampania,
      oferta: c.oferta.tag,
      titulo: `Pausar ${c.nivel === 'anuncio' ? 'anuncio' : 'ad set'} ${c.entidad.nombre}`,
      motivo: c.criterio.motivo,
      regla: c.criterio.regla,
      avisos,
      prioridad,
      payload: { estado: 'PAUSED' },
      snapshot: { metricas: c.m, conjunto: c.conjunto?.nombre || null },
    });
  }

  // ── escalados (§3) ──
  // Unidad de presupuesto: la campaña si es CBO, el ad set si es ABO. Testeo no
  // se escala (sus ganadores se gradúan, ver job de graduación).
  const unidadesPresupuesto = [];
  for (const c of estructura.campanias) {
    if (c.estadoEfectivo !== 'ACTIVE' || esTesteo(ctx, c)) continue;
    if (c.presupuestoDiario) {
      const sets = estructura.conjuntos.filter(s => s.campaniaId === c.id && s.estadoEfectivo === 'ACTIVE');
      unidadesPresupuesto.push({ nivel: 'campania', entidad: c, campania: c, sets, m: ctx.ins.campA.get(c.id) });
    } else {
      for (const s of estructura.conjuntos.filter(x => x.campaniaId === c.id && x.estadoEfectivo === 'ACTIVE' && x.presupuestoDiario)) {
        unidadesPresupuesto.push({ nivel: 'conjunto', entidad: s, campania: c, sets: [s], m: ctx.ins.setA.get(s.id) });
      }
    }
  }
  for (const u of unidadesPresupuesto) {
    if (!u.m || !u.sets.some(s => activos(ctx.anunciosPorConjunto.get(s.id)).length)) continue;
    const oferta = ofertaDe([u.campania.nombre, u.nivel === 'conjunto' ? u.entidad.nombre : ''], p.ofertas);
    const m = u.m;
    const confianza = m.compras >= p.volumenMinimo || m.gasto >= p.gastoMinimoCpa * oferta.cpaObjetivo;
    if (!(confianza && m.compras > 0 && m.cpa < oferta.cpaObjetivo && m.roas != null && m.roas > p.roasEscalado)) continue;
    const etiqueta = `${u.entidad.nombre}: CPA $${fmt(m.cpa)} / ROAS ${fmt(m.roas, 2)}`;
    if (diasDesde(u.entidad.creado) < p.noTocarDias) { observaciones.push({ entidad: u.entidad.nombre, motivo: `${etiqueta} — candidato a escalar, pero tiene menos de ${p.noTocarDias} días` }); continue; }
    if (u.sets.some(s => s.aprendizaje === 'LEARNING')) { observaciones.push({ entidad: u.entidad.nombre, motivo: `${etiqueta} — en fase de aprendizaje, no se toca el presupuesto` }); continue; }
    const ultimoEscalado = ultimaAccion(ctx, u.entidad.id, ['escalado', 'presupuesto']);
    if (ultimoEscalado && diasDesde(ultimoEscalado.at) < p.escaladoCadenciaDias) {
      observaciones.push({ entidad: u.entidad.nombre, motivo: `${etiqueta} — último cambio de presupuesto hace ${fmt(diasDesde(ultimoEscalado.at), 1)} días (mín. ${p.escaladoCadenciaDias})` });
      continue;
    }
    // Elasticidad (§3): si el CPA subió más de lo aceptable tras el último escalado, sostener.
    const cpaPrevio = ultimoEscalado?.antes?.cpa;
    if (ultimoEscalado?.tipo === 'escalado' && cpaPrevio > 0 && diasDesde(ultimoEscalado.at) < 30) {
      const suba = ((m.cpa - cpaPrevio) / cpaPrevio) * 100;
      if (suba > p.elasticidadMaxPct) {
        observaciones.push({ entidad: u.entidad.nombre, motivo: `${etiqueta} — el CPA subió ${fmt(suba)}% desde el último escalado (máx. ${p.elasticidadMaxPct}%): sostener un ciclo más` });
        continue;
      }
    }
    const anterior = u.entidad.presupuestoDiario;
    const nuevo = Math.round(anterior * (1 + p.escaladoPct / 100));
    propuestas.push({
      clave: `escalado:${u.entidad.id}`,
      job: 'pausa_escalado',
      tipo: 'escalado',
      entidad_tipo: u.nivel,
      entidad_id: u.entidad.id,
      entidad_nombre: u.entidad.nombre,
      campania_nombre: u.campania.nombre,
      oferta: oferta.tag,
      titulo: `Escalar ${u.entidad.nombre}`,
      motivo: `CPA $${fmt(m.cpa)} bajo el objetivo de ${oferta.tag} ($${fmt(oferta.cpaObjetivo)}) y ROAS ${fmt(m.roas, 2)} con ${m.compras} compras`,
      regla: '§3 · escalado',
      avisos: [],
      prioridad: 20,
      payload: { anterior, nuevo, porcentaje: p.escaladoPct },
      snapshot: { metricas: m },
    });
  }

  return { propuestas, observaciones, evaluados, protegidos };
}

// ── job: graduación (Rulebook §6.2) ──────────────────────────────────────────

function numeroSich(nombre) {
  const m = /SICH\s*-?\s*(\d+)/i.exec(nombre || '');
  return m ? Number(m[1]) : null;
}

function mananaALas5() {
  const manana = sumarDias(fechaUy(), 1);
  return `${manana}T05:00:00-03:00`;
}

async function evaluarGraduaciones(ctx) {
  const { p, estructura, cuenta } = ctx;
  const propuestas = [];
  const observaciones = [];
  let evaluados = 0;

  // Candidatos confirmados: ad sets de testeo con entrega real que cumplen el
  // criterio de escalado de §3 (CPA < objetivo de su oferta, ROAS > escalado,
  // con volumen o gasto mínimo).
  const candidatos = [];
  for (const conjunto of estructura.conjuntos) {
    const campania = ctx.campaniaPorId.get(conjunto.campaniaId);
    if (!campania || !esTesteo(ctx, campania) || conjunto.estadoEfectivo !== 'ACTIVE') continue;
    const anuncio = activos(ctx.anunciosPorConjunto.get(conjunto.id))[0];
    if (!anuncio?.creativoId) continue;
    evaluados++;
    const oferta = ofertaDe([campania.nombre, conjunto.nombre], p.ofertas);
    const m = ctx.ins.setA.get(conjunto.id);
    if (!m) continue;
    const confianza = m.compras >= p.volumenMinimo || m.gasto >= p.gastoMinimoCpa * oferta.cpaObjetivo;
    if (confianza && m.compras > 0 && m.cpa < oferta.cpaObjetivo && m.roas != null && m.roas > p.roasEscalado) {
      candidatos.push({ conjunto, campania, anuncio, oferta, m });
    }
  }

  // Destinos de retargeting fijos (§6.2), leídos una vez.
  const destinosRtg = [];
  for (const [clave, prefijo] of [['rtgAdsetIntencionId', 'RTG-CarritoAbandonado-'], ['rtgAdsetEngagementId', 'RTG-']]) {
    const id = String(p[clave] || '').trim();
    if (!/^\d+$/.test(id)) continue;
    try {
      const s = await meta.obtenerObjeto(id, 'id,name,effective_status,campaign{id,name,effective_status}');
      destinosRtg.push({ id, nombre: s.name, prefijo, activo: s.effective_status === 'ACTIVE' && s.campaign?.effective_status === 'ACTIVE', estado: s.effective_status, campaniaNombre: s.campaign?.name });
    } catch (err) {
      observaciones.push({ entidad: `Ad set ${id}`, motivo: `No se pudo leer el destino de retargeting: ${err.message}` });
    }
  }

  const ultimaEdicionConjunto = (conjuntoId) => ctx.actividad.find(a => a.conjunto_id === conjuntoId && a.tipo === 'anuncio_creado') || null;
  const avisoCadencia = (conjuntoId, nombre) => {
    const ult = ultimaEdicionConjunto(conjuntoId);
    if (!ult) return null;
    const dias = diasDesde(ult.at);
    if (dias >= p.cadenciaAdsetDias) return null;
    const disponible = fechaUy(new Date(new Date(ult.at).getTime() + p.cadenciaAdsetDias * DIA_MS));
    return `Al ad set "${nombre}" se le agregó un anuncio hace ${fmt(dias, 1)} días: conviene esperar al ${disponible} para no reiniciar su aprendizaje`;
  };

  const cbosPorSich = new Map();
  for (const c of candidatos) {
    verificarUsoApi();
    const clave = c.anuncio.nombre.trim();
    const metricas = { cpa: c.m.cpa, roas: c.m.roas, compras: c.m.compras, gasto: c.m.gasto };
    const motivo = `CPA $${fmt(c.m.cpa)} / ROAS ${fmt(c.m.roas, 2)} con ${c.m.compras} compras en testeo (${c.oferta.tag})`;

    // §6.5: un ganador en una oferta distinta de la default (testeo cruzado) no
    // se gradúa ni se duplica solo: va a una CBO propia de esa oferta, a decidir.
    if (!c.oferta.defecto) {
      observaciones.push({ entidad: clave, motivo: `${motivo} — ganador en la oferta ${c.oferta.tag}: la CBO propia de esa oferta se decide a mano (§6.5)` });
      continue;
    }
    const sichTanda = numeroSich(c.campania.nombre) ?? numeroSich(c.conjunto.nombre);
    if (sichTanda == null) {
      observaciones.push({ entidad: clave, motivo: `${motivo} — candidato a graduar, pero no se pudo deducir la tanda SICH de "${c.campania.nombre}"` });
      continue;
    }

    // Idempotencia: ¿ya existe fuera de testeo con el nombre o los sufijos usados?
    const existentes = await meta.buscarAnunciosPorNombre(cuenta, clave);
    const fueraDeTesteo = existentes.filter(a => !contiene(a.campaniaNombre, p.patronTesteo));
    const graduadoFrio = fueraDeTesteo.some(a => [clave, `${clave} - CBO`, `${clave} - Copia`].includes(a.nombre)
      && !contiene(a.campaniaNombre, p.patronRetargeting));

    const sich = sichTanda;
    if (!graduadoFrio) {
      {
        if (!cbosPorSich.has(sich)) {
          const encontradas = await meta.buscarCampaniasPorNombre(cuenta, `SICH${sich}`);
          const re = new RegExp(`CBO\\s*-\\s*PRE\\s*-\\s*SICH\\s*${sich}(?!\\d)`, 'i');
          cbosPorSich.set(sich, encontradas.find(x => re.test(x.nombre)) || null);
        }
        const cbo = cbosPorSich.get(sich);
        if (cbo) {
          const broad = cbo.conjuntos.find(s => /broad/i.test(s.nombre)) || cbo.conjuntos[0];
          if (!broad) {
            observaciones.push({ entidad: clave, motivo: `"${cbo.nombre}" no tiene ad sets: revisar a mano` });
          } else {
            const avisos = [];
            const activo = broad.estadoEfectivo === 'ACTIVE' && cbo.estadoEfectivo === 'ACTIVE';
            if (!activo) avisos.push(`El destino no está entregando (campaña ${cbo.estadoEfectivo}, ad set ${broad.estadoEfectivo}): el anuncio se crea pero no sale a pauta hasta que lo actives`);
            const cad = avisoCadencia(broad.id, broad.nombre);
            if (cad) avisos.push(cad);
            propuestas.push({
              clave: `graduacion:${clave}:${broad.id}`,
              job: 'graduacion',
              tipo: 'graduacion',
              entidad_tipo: 'anuncio',
              entidad_id: c.anuncio.id,
              entidad_nombre: clave,
              campania_nombre: c.campania.nombre,
              oferta: c.oferta.tag,
              titulo: `Graduar ${clave} a ${cbo.nombre}`,
              motivo,
              regla: '§6.2 · graduación',
              avisos,
              prioridad: cad ? 45 : 25,
              payload: { conjuntoId: broad.id, conjuntoNombre: broad.nombre, campaniaDestino: cbo.nombre, creativoId: c.anuncio.creativoId, nombre: `${clave} - CBO`, activar: true },
              snapshot: { metricas },
            });
          }
        } else {
          // Primera graduación de la tanda: CBO nueva, pausada (§6.2: la activa el admin).
          const plantillas = await meta.buscarCampaniasPorNombre(cuenta, 'CBO - PRE - SICH');
          const plantilla = plantillas
            .filter(x => x.conjuntos.some(s => s.plantilla?.targeting))
            .sort((a, b) => (numeroSich(b.nombre) || 0) - (numeroSich(a.nombre) || 0))[0];
          const broadPlantilla = plantilla?.conjuntos.find(s => /broad/i.test(s.nombre)) || plantilla?.conjuntos[0];
          propuestas.push({
            clave: `crear_cbo:SICH${sich}`,
            job: 'graduacion',
            tipo: 'crear_cbo',
            entidad_tipo: 'anuncio',
            entidad_id: c.anuncio.id,
            entidad_nombre: clave,
            campania_nombre: c.campania.nombre,
            oferta: c.oferta.tag,
            titulo: `Crear "CBO - PRE - SICH${sich}" con ${clave}`,
            motivo: `${motivo}. Es el primer ganador de la tanda SICH ${sich}`,
            regla: '§6.2 · CBO nueva',
            avisos: [
              'La campaña nace pausada, programada para las 05:00 de mañana: la activás vos cuando quieras',
              plantilla ? `Configuración del ad set copiada de "${plantilla.nombre}"` : 'No se encontró una "CBO - PRE - SICH" de referencia para copiar la configuración',
            ],
            prioridad: 25,
            payload: {
              sich,
              nombreCampania: `CBO - PRE - SICH${sich}`,
              presupuesto: p.cboPresupuestoInicial,
              inicio: mananaALas5(),
              plantillaConjuntoId: broadPlantilla?.id || null,
              creativoId: c.anuncio.creativoId,
              nombreAnuncio: `${clave} - CBO`,
            },
            snapshot: { metricas },
          });
        }
      }
    }

    // Duplicación a retargeting (§6.2), cada destino por separado.
    for (const d of destinosRtg) {
      const nombre = `${d.prefijo}${clave}`;
      if (existentes.some(a => a.conjuntoId === d.id)) continue; // ya está en ese ad set
      const avisos = [];
      if (!d.activo) avisos.push(`"${d.nombre}" no está entregando (${d.estado}): el anuncio se crea pero no sale a pauta`);
      const cad = avisoCadencia(d.id, d.nombre);
      if (cad) avisos.push(cad);
      propuestas.push({
        clave: `duplicado_rtg:${clave}:${d.id}`,
        job: 'graduacion',
        tipo: 'duplicado_rtg',
        entidad_tipo: 'anuncio',
        entidad_id: c.anuncio.id,
        entidad_nombre: clave,
        campania_nombre: c.campania.nombre,
        oferta: c.oferta.tag,
        titulo: `Duplicar ${clave} a ${d.nombre}`,
        motivo,
        regla: '§6.2 · retargeting',
        avisos,
        prioridad: cad ? 50 : 30,
        payload: { conjuntoId: d.id, conjuntoNombre: d.nombre, campaniaDestino: d.campaniaNombre, creativoId: c.anuncio.creativoId, nombre, activar: true },
        snapshot: { metricas },
      });
    }
  }
  return { propuestas, observaciones, evaluados, protegidos: 0 };
}

// ── job: ingesta de tandas SICH (Rulebook §6.1, §6.4) ────────────────────────

// La ingesta no necesita los insights de toda la cuenta: contexto liviano.
async function contextoIngesta(cuentaId) {
  const cuenta = cuentaId || meta.cuentaPorDefecto();
  if (!cuenta) throw new Error('Falta META_AD_ACCOUNT_ID');
  return { cuenta, p: await cargarParametros() };
}

async function evaluarIngesta(ctx) {
  const { cuenta, p } = ctx;
  const [tandas, gate, testeo] = await Promise.all([
    ingesta.listarTandas(cuenta, p, { fresco: true }),
    ingesta.calcularGate(cuenta, p),
    meta.buscarCampaniasPorNombre(cuenta, p.patronTesteo),
  ]);
  const propuestas = [];
  const observaciones = [];
  let evaluados = 0;
  // Plantilla de respaldo: el ad set de testeo más nuevo de la tanda más alta.
  const respaldo = testeo
    .filter(c => c.conjuntos.length)
    .sort((a, b) => (numeroSich(b.nombre) || 0) - (numeroSich(a.nombre) || 0))[0];

  for (const t of tandas) {
    evaluados += t.items.length;
    const porEstado = (e) => t.items.filter(i => i.estado === e);
    if (porEstado('sin_veln').length) observaciones.push({ entidad: `SICH ${t.sich}`, motivo: `${porEstado('sin_veln').length} archivo(s) sin VELn en el nombre: asignalo en Creativos o renombralo en Drive` });
    if (porEstado('sin_angulo').length) observaciones.push({ entidad: `SICH ${t.sich}`, motivo: `${porEstado('sin_angulo').length} archivo(s) sueltos sin ángulo: asignalo en Creativos` });
    if (porEstado('sin_campania').length) observaciones.push({ entidad: `SICH ${t.sich}`, motivo: `${porEstado('sin_campania').length} creativo(s) listos pero falta crear la campaña "TESTEO - SICH ${t.sich}" en Ads Manager` });
    const listos = porEstado('listo');
    if (!listos.length || !t.campania) continue;

    const deLaTanda = testeo.find(c => c.id === t.campania.id);
    const plantillaConjuntoId = deLaTanda?.conjuntos[0]?.id || respaldo?.conjuntos[0]?.id || null;
    const avisos = [];
    if (gate.banda === 'roja') avisos.push(`Cuenta en banda roja (CPA $${fmt(gate.cpa)} sobre el máximo de $${fmt(gate.maximo)}): los ad sets se crean PAUSADOS y los activás a mano (§6.4)`);
    if (gate.banda === 'amarilla') avisos.push(`Cuenta en banda amarilla (CPA $${fmt(gate.cpa)}, objetivo $${fmt(gate.objetivo)}): presupuesto reducido a $${fmt(gate.presupuesto)}/día (§6.4)`);
    if (t.campania.estadoEfectivo !== 'ACTIVE') avisos.push(`La campaña "${t.campania.nombre}" está ${t.campania.estadoEfectivo}: los ad sets no van a entregar hasta que la actives`);
    if (!plantillaConjuntoId) avisos.push('No hay ningún ad set de testeo para copiar la configuración: la ejecución va a fallar');
    const angulos = [...new Set(listos.map(i => i.angulo))];
    const inicio = ingesta.proximoSabado5am();
    propuestas.push({
      clave: `ingesta:SICH${t.sich}`,
      job: 'ingesta',
      tipo: 'ingesta_tanda',
      entidad_tipo: 'campania',
      entidad_id: t.campania.id,
      entidad_nombre: `SICH ${t.sich}`,
      campania_nombre: t.campania.nombre,
      oferta: (p.ofertas.find(o => o.defecto) || p.ofertas[0]).tag,
      titulo: `Tanda SICH ${t.sich}: crear ${listos.length} ad set${listos.length === 1 ? '' : 's'} de testeo`,
      motivo: `${listos.length} creativo${listos.length === 1 ? '' : 's'} nuevo${listos.length === 1 ? '' : 's'} en Drive (${angulos.join(', ')}), ${gate.activar ? 'arrancan' : 'quedan listos para'} el sábado 05:00 a $${fmt(gate.presupuesto)}/día cada uno`,
      regla: '§6.1 · ingesta · §6.4 · gate',
      avisos,
      prioridad: gate.banda === 'roja' ? 40 : 35,
      payload: {
        sich: t.sich, campaniaId: t.campania.id, campaniaNombre: t.campania.nombre, inicio,
        presupuesto: gate.presupuesto, activar: gate.activar, plantillaConjuntoId,
        items: listos.map(i => ({ fileId: i.fileId, archivo: i.archivo, veln: i.veln, angulo: i.angulo, tipo: i.tipo, mime: i.mime })),
      },
      snapshot: { gate },
    });
  }
  return { propuestas, observaciones, evaluados, protegidos: 0, gate };
}

// ── jobs de análisis (Fase 3): reporte semanal, auditoría, ganadores caídos ──

async function contextoAnalisis(cuentaId) {
  const cuenta = cuentaId || meta.cuentaPorDefecto();
  if (!cuenta) throw new Error('Falta META_AD_ACCOUNT_ID');
  let actividad = [];
  try {
    actividad = await supabaseService.listarActividadMetaAds({ desde: new Date(Date.now() - 45 * DIA_MS).toISOString(), limite: 3000 });
  } catch { /* sin tabla */ }
  return { cuenta, p: await cargarParametros(), actividad };
}

// Reporte semanal (velinne-ads-weekly-digest, parte numérica) + propuestas de lookalike (§3.1).
async function evaluarReporte(ctx) {
  const reporte = await analisis.reporteSemanal(ctx.cuenta, ctx.p);
  const propuestas = (reporte.audiencias?.propuestas || []).map(sem => ({
    clave: `lookalike:${sem.id}`,
    job: 'reporte',
    tipo: 'crear_lookalike',
    entidad_tipo: 'audiencia',
    entidad_id: sem.id,
    entidad_nombre: sem.nombre,
    campania_nombre: null,
    oferta: null,
    titulo: `Crear lookalike ${ctx.p.lookalikeRatio}% de "${sem.nombre}"`,
    motivo: `Audiencia de engagement sana (~${fmt(sem.tamanio)} personas) sin un público similar creado o actualizado en los últimos 90 días`,
    regla: '§3.1 · lookalikes',
    avisos: ['Sólo crea la audiencia: usarla en un ad set de test es una decisión aparte'],
    prioridad: 60,
    payload: { origenId: sem.id, semilla: sem.nombre, ratio: ctx.p.lookalikeRatio / 100, pais: 'UY', nombre: `Público similar (${ctx.p.lookalikeRatio}%) - ${sem.nombre}` },
    snapshot: { tamanio: sem.tamanio },
  }));
  const observaciones = [];
  for (const e of reporte.pixel?.alertas || []) observaciones.push({ entidad: `Pixel · ${e.evento}`, motivo: `Cayó ${fmt(-e.variacion)}% semana contra semana (${e.previa} → ${e.actual})` });
  if (reporte.funnel?.bajoPiso) observaciones.push({ entidad: 'Conversión del sitio', motivo: `${fmt(reporte.funnel.actual.conversion, 2)}% bajo el piso de ${fmt(ctx.p.conversionMinima, 1)}%` });
  for (const c of (reporte.inventario?.core || []).filter(x => x.estado === 'agotada' || x.estado === 'bajo')) {
    observaciones.push({ entidad: `Stock · ${c.variante}`, motivo: c.estado === 'agotada' ? 'Variante core agotada' : `Stock bajo: ${c.stock} unidades` });
  }
  for (const pat of reporte.auditoria?.patrones || []) observaciones.push({ entidad: 'Auditoría', motivo: `Patrón: ${pat.tipo} salió cuestionable o contraproducente ${pat.veces} veces — candidato a ajuste de regla` });
  return { propuestas, observaciones, evaluados: 1, protegidos: 0, extra: reporte };
}

// Auditoría retrospectiva de decisiones (velinne-ads-decision-audit, §8.6).
async function evaluarAuditoria(ctx) {
  let previas = [];
  try {
    previas = (await supabaseService.listarActividadMetaAds({ tipos: ['corrida'], limite: 50, desde: new Date(Date.now() - 180 * DIA_MS).toISOString() }))
      .filter(a => a.origen === 'auditoria' && a.despues?.extra);
  } catch { /* sin tabla */ }
  const r = await analisis.auditarDecisiones(ctx.cuenta, ctx.p, { previas });
  const observaciones = [
    ...r.resultados.filter(x => x.clasificacion === 'contraproducente').map(x => ({ entidad: x.entidad, motivo: `${x.etiqueta}: ${x.razon}` })),
    ...r.patrones.map(pat => ({ entidad: 'Patrón', motivo: `${pat.tipo}: ${pat.veces} decisiones cuestionables o contraproducentes — candidato a ajuste de regla` })),
  ];
  return { propuestas: [], observaciones, evaluados: r.auditables, protegidos: 0, extra: r };
}

// Ganadores caídos (velinne-winner-decline-audit, §6.6).
async function evaluarGanadores(ctx) {
  const [inventario, pixel] = await Promise.all([
    analisis.inventarioCore(ctx.p).catch(() => null),
    analisis.saludPixel(ctx.p).catch(() => null),
  ]);
  const r = await analisis.ganadoresCaidos(ctx.cuenta, ctx.p, { actividad: ctx.actividad, inventario, pixel });
  return { propuestas: r.propuestas, observaciones: r.observaciones, evaluados: r.ganadores || 0, protegidos: 0, extra: { casos: r.casos, ganadores: r.ganadores || 0 } };
}

// ── jobs con Claude (Fase 4): brief creativo, resumen mensual, políticas ─────

function exigirIA() {
  if (!ia.configurado()) throw new Error('Falta ANTHROPIC_API_KEY: esta tarea redacta e investiga con la API de Claude');
}

const etiquetaParametro = (clave) => DEFINICIONES.find(d => d.clave === clave)?.label || clave;

function propuestasDeAjustes(job, ajustes, p, origen) {
  return (ajustes || [])
    .filter(a => DEFINICIONES.some(d => d.clave === a.clave && d.tipo !== 'texto') && Number.isFinite(a.valor) && a.valor >= 0 && a.valor !== p[a.clave])
    .map(a => ({
      clave: `ajuste:${a.clave}`,
      job,
      tipo: 'ajuste_parametro',
      entidad_tipo: 'parametro',
      entidad_id: a.clave,
      entidad_nombre: etiquetaParametro(a.clave),
      titulo: `Cambiar "${etiquetaParametro(a.clave)}" de ${p[a.clave]} a ${a.valor}`,
      motivo: a.razon,
      regla: origen,
      avisos: ['Cambia una regla del piloto: aplica desde el próximo chequeo'],
      prioridad: 55,
      payload: { clave: a.clave, anterior: p[a.clave], nuevo: a.valor },
      snapshot: {},
    }));
}

// Brief creativo semanal (weekly-digest, pasos 7-7.4 y el brief del editor).
async function evaluarBrief(ctx) {
  exigirIA();
  const r = await estrategia.generarBrief(ctx.cuenta, ctx.p, ctx.actividad);
  const propuestas = [];
  // Ángulos de la próxima SICH: confirmados por datos + ideas ya aprobadas; si
  // no hay ninguno, las especulativas (la carpeta se crea igual todas las semanas, §8.4).
  const angulos = [
    ...r.angulos_confirmados.map(a => ({ ...a, estado: 'confirmada' })),
    ...r.ideasAprobadas.map(a => ({ ...a, razon: 'Idea especulativa aprobada en el panel', estado: 'aprobada' })),
  ];
  const paraCarpeta = angulos.length ? angulos : r.ideas_especulativas.map(a => ({ ...a, razon: `Fuente: ${a.fuente}`, estado: 'especulativa' }));
  if (paraCarpeta.length) {
    propuestas.push({
      clave: 'crear_sich:proxima',
      job: 'brief',
      tipo: 'crear_sich',
      entidad_tipo: 'drive',
      entidad_id: null,
      entidad_nombre: `SICH ${r.proximaSich}`,
      titulo: `Crear la carpeta "SICH ${r.proximaSich}" en Drive con ${paraCarpeta.length} ángulo${paraCarpeta.length === 1 ? '' : 's'}`,
      motivo: paraCarpeta.map(a => a.angulo).join(' · '),
      regla: '§8.4 · brief creativo',
      avisos: [
        ...(angulos.length ? [] : ['Ningún ángulo calificó por datos: la carpeta lleva las ideas especulativas']),
        'La cuenta de servicio de Google tiene que ser Editor de la carpeta "VelinneUy/Lucho"',
      ],
      prioridad: 50,
      payload: { angulos: paraCarpeta },
      snapshot: {},
    });
  }
  if (angulos.length) {
    for (const idea of r.ideas_especulativas) {
      propuestas.push({
        clave: `idea:${idea.angulo.toLowerCase()}`,
        job: 'brief',
        tipo: 'aprobar_idea',
        entidad_tipo: 'idea',
        entidad_id: null,
        entidad_nombre: idea.angulo,
        titulo: `Idea especulativa: ${idea.angulo}`,
        motivo: idea.hipotesis,
        regla: '§8.4 · 🧪 especulativa',
        avisos: [`Fuente: ${idea.fuente}`, 'Si la aprobás, entra como ángulo de la próxima tanda SICH y al brief del editor'],
        prioridad: 65,
        payload: idea,
        snapshot: {},
      });
    }
  }
  return {
    propuestas,
    observaciones: [],
    evaluados: r.datos.angulosActual.length,
    protegidos: 0,
    extra: { resumen: r.resumen, brief_editor: r.brief_editor, angulos_confirmados: r.angulos_confirmados, ideas_especulativas: r.ideas_especulativas, proximaSich: r.proximaSich, angulos: r.datos.angulosActual, fuentes: r.fuentes, uso: r.uso, modelo: r.modelo },
  };
}

// Resumen estratégico mensual (monthly-strategic).
async function evaluarMensual(ctx) {
  exigirIA();
  let ultimoReporte = null; let ultimaAuditoria = null;
  try {
    const corridas = await supabaseService.listarActividadMetaAds({ tipos: ['corrida'], limite: 200, desde: new Date(Date.now() - 40 * DIA_MS).toISOString() });
    ultimoReporte = corridas.find(a => a.origen === 'reporte' && a.despues?.extra)?.despues.extra || null;
    ultimaAuditoria = corridas.find(a => a.origen === 'auditoria' && a.despues?.extra)?.despues.extra || null;
  } catch { /* sin tabla */ }
  const r = await estrategia.generarMensual(ctx.cuenta, ctx.p, { ultimoReporte, ultimaAuditoria });
  return {
    propuestas: propuestasDeAjustes('mensual', r.ajustes, ctx.p, '§8 · resumen mensual'),
    observaciones: r.recomendaciones.map(t => ({ entidad: 'Recomendación', motivo: t })),
    evaluados: 1,
    protegidos: 0,
    extra: { resumen: r.resumen, mes: r.mes, ajustes: r.ajustes, recomendaciones: r.recomendaciones, fuentes: r.fuentes, uso: r.uso, modelo: r.modelo },
  };
}

// Chequeo quincenal de políticas de Meta (meta-policy-check, §5).
async function evaluarPoliticas(ctx) {
  exigirIA();
  const r = await estrategia.chequearPoliticas(ctx.p);
  const enmiendas = r.novedades.filter(n => n.afecta_regla && n.enmienda).map(n => ({
    clave: `enmienda:${n.titulo.toLowerCase().slice(0, 80)}`,
    job: 'politicas',
    tipo: 'enmienda',
    entidad_tipo: 'regla',
    entidad_id: null,
    entidad_nombre: n.regla || 'Rulebook',
    titulo: `Enmienda: ${n.titulo}`,
    motivo: n.enmienda,
    regla: `§5 · ${n.regla || 'novedad de Meta'}`,
    avisos: [`${n.impacto}`, `Fuente: ${n.fuente}`],
    prioridad: 40,
    payload: n,
    snapshot: {},
  }));
  return {
    propuestas: [...enmiendas, ...propuestasDeAjustes('politicas', r.ajustes, ctx.p, '§5 · novedad de Meta')],
    observaciones: r.novedades.filter(n => !n.afecta_regla).map(n => ({ entidad: n.titulo, motivo: n.impacto })),
    evaluados: r.novedades.length,
    protegidos: 0,
    extra: { resumen: r.resumen, novedades: r.novedades, desde: r.desde, fuentes: r.fuentes, uso: r.uso, modelo: r.modelo },
  };
}

// ── sincronización de propuestas (reemplaza a velinne-dashboard-maintenance) ──

async function sincronizarPropuestas(job, nuevas, p) {
  const vence = new Date(Date.now() + p.vigenciaHoras * 60 * 60 * 1000).toISOString();
  const pendientes = await supabaseService.listarPropuestasMetaAds({ estados: ['pendiente'], job, limite: 1000 });
  const porClave = new Map(pendientes.map(x => [x.clave, x]));
  // Lo rechazado hace poco no se vuelve a proponer enseguida.
  const rechazadas = await supabaseService.listarPropuestasMetaAds({
    estados: ['rechazada'], job, limite: 1000,
    desde: new Date(Date.now() - p.cadenciaAccionDias * DIA_MS).toISOString(),
  });
  const rechazadasClaves = new Set(rechazadas.map(x => x.clave));

  let creadas = 0;
  let actualizadas = 0;
  let omitidas = 0;
  const vigentes = new Set();
  for (const n of nuevas) {
    vigentes.add(n.clave);
    const existente = porClave.get(n.clave);
    if (existente) {
      await supabaseService.actualizarPropuestaMetaAds(existente.id, {
        titulo: n.titulo, motivo: n.motivo, regla: n.regla, avisos: n.avisos, payload: n.payload,
        snapshot: n.snapshot, prioridad: n.prioridad, vence_at: vence,
      }, 'pendiente');
      actualizadas++;
    } else if (rechazadasClaves.has(n.clave)) {
      omitidas++;
    } else {
      await supabaseService.insertarPropuestaMetaAds({ ...n, vence_at: vence });
      creadas++;
    }
  }
  // Lo que ya no se cumple se cierra solo: no queda colgado en la bandeja.
  let cerradas = 0;
  for (const x of pendientes) {
    if (vigentes.has(x.clave)) continue;
    await supabaseService.actualizarPropuestaMetaAds(x.id, {
      estado: 'vencida', resuelto_por: 'sistema', resuelto_at: new Date().toISOString(),
      error: 'En la última corrida ya no cumplía el criterio',
    }, 'pendiente');
    cerradas++;
  }
  return { creadas, actualizadas, omitidas, cerradas };
}

// ── corridas ─────────────────────────────────────────────────────────────────

const JOBS = {
  pausa_escalado: { nombre: 'Pausa y escalado', evaluar: (ctx) => evaluarPausasYEscalados(ctx) },
  graduacion: { nombre: 'Graduación de ganadores', evaluar: (ctx) => evaluarGraduaciones(ctx) },
  ingesta: { nombre: 'Ingesta de creativos', evaluar: (ctx) => evaluarIngesta(ctx), contexto: contextoIngesta },
  ganadores: { nombre: 'Ganadores caídos', evaluar: (ctx) => evaluarGanadores(ctx), contexto: contextoAnalisis },
  auditoria: { nombre: 'Auditoría de decisiones', evaluar: (ctx) => evaluarAuditoria(ctx), contexto: contextoAnalisis },
  reporte: { nombre: 'Reporte semanal', evaluar: (ctx) => evaluarReporte(ctx), contexto: contextoAnalisis },
  brief: { nombre: 'Brief creativo', evaluar: (ctx) => evaluarBrief(ctx), contexto: contextoAnalisis, ia: true },
  mensual: { nombre: 'Resumen mensual', evaluar: (ctx) => evaluarMensual(ctx), contexto: contextoAnalisis, ia: true },
  politicas: { nombre: 'Políticas de Meta', evaluar: (ctx) => evaluarPoliticas(ctx), contexto: contextoAnalisis, ia: true },
};

// Apagados por ahora (pedido del 02/10): la ingesta depende de la cuenta de
// servicio de Google (Drive) y brief/mensual/políticas de la API de Anthropic.
// El código queda; para reactivarlos, sacarlos de este set.
const APAGADOS = new Set(['ingesta', 'brief', 'mensual', 'politicas']);
const jobActivo = (id) => Boolean(JOBS[id]) && !APAGADOS.has(id);

const enCurso = new Set();
const ultimaCorrida = {}; // job → resumen (en memoria, para el panel)

/**
 * Corre un job. Con dryRun no escribe nada (útil para probar sin tablas).
 * Devuelve { propuestas, observaciones, resumen }.
 */
async function correrJob(job, { origen = 'manual', usuario = null, dryRun = false, cuenta } = {}) {
  const def = JOBS[job];
  if (!def) throw new Error(`Job desconocido: ${job}`);
  if (!jobActivo(job)) throw Object.assign(new Error(`"${def.nombre}" está apagado por ahora`), { status: 400 });
  if (enCurso.has(job)) throw new Error(`"${def.nombre}" ya se está ejecutando`);
  enCurso.add(job);
  const inicio = Date.now();
  try {
    const ctx = def.contexto ? await def.contexto(cuenta) : await cargarContexto(cuenta);
    const r = await def.evaluar(ctx);
    let sync = null;
    if (!dryRun) sync = await sincronizarPropuestas(job, r.propuestas, ctx.p);
    const resumen = {
      job, nombre: def.nombre, at: new Date().toISOString(), origen, usuario,
      evaluados: r.evaluados, propuestas: r.propuestas.length, observaciones: r.observaciones.length,
      protegidos: r.protegidos, sync, duracionMs: Date.now() - inicio, usoApi: meta.usoApiActual(),
    };
    ultimaCorrida[job] = { ...resumen, detalleObservaciones: r.observaciones };
    if (!dryRun) {
      await supabaseService.registrarActividadMetaAds({
        tipo: 'corrida', origen: job, usuario,
        titulo: def.nombre,
        detalle: `${r.evaluados} evaluados · ${r.propuestas.length} propuestas (${sync.creadas} nuevas) · ${r.observaciones.length} en observación · ${r.protegidos} protegidos`
          + (sync.cerradas ? ` · ${sync.cerradas} cerradas por ya no aplicar` : ''),
        despues: { ...resumen, observaciones: r.observaciones.slice(0, 50), ...(r.extra ? { extra: r.extra } : {}) },
      }).catch(err => logService.error('Meta Ads: no se pudo registrar la corrida', { error: err.message }));
    }
    return { ...r, resumen };
  } catch (err) {
    ultimaCorrida[job] = { job, nombre: def.nombre, at: new Date().toISOString(), origen, error: err.message };
    if (!dryRun) {
      await supabaseService.registrarActividadMetaAds({
        tipo: 'error', origen: job, usuario, titulo: `${def.nombre} falló`, detalle: err.message,
      }).catch(() => {});
    }
    throw err;
  } finally {
    enCurso.delete(job);
  }
}

function estadoJobs() {
  return Object.entries(JOBS).filter(([id]) => jobActivo(id)).map(([id, def]) => ({
    id, nombre: def.nombre, enCurso: enCurso.has(id), ultima: ultimaCorrida[id] || null,
    ia: Boolean(def.ia), disponible: !def.ia || ia.configurado(),
  }));
}

// ── ejecución de propuestas aprobadas ────────────────────────────────────────

async function registrar(fila) {
  try { await supabaseService.registrarActividadMetaAds(fila); } catch (err) {
    logService.error('Meta Ads: no se pudo registrar actividad', { error: err.message });
  }
}

// Crea un ad set nuevo con los parámetros de §6.0 (multianunciante desactivado,
// "captar nuevos clientes"). Si Meta rechaza esos campos, lo crea sin ellos y
// devuelve el aviso para configurarlos a mano.
async function crearConjuntoNuevo(cuenta, campos) {
  try {
    const id = await meta.crearConjunto(cuenta, { ...campos, contextual_bundling_spec: { status: 'OPT_OUT' }, marketing_goal: 'NEW_CUSTOMER_ACQUISITION' });
    return { id, aviso: null };
  } catch (err) {
    if (!/contextual_bundling|marketing_goal/i.test(`${err.message} ${err.detalle || ''}`)) throw err;
    const id = await meta.crearConjunto(cuenta, campos);
    return { id, aviso: `Meta rechazó los parámetros de §6.0 (${err.detalle || err.message}): configurá "anuncios multianunciante" y "captar nuevos clientes" a mano` };
  }
}

// Creativo nuevo con la página, el copy y el CTA de la plantilla, apuntando al
// link de la oferta por defecto (Rulebook §6.1: el copy es fijo, el ángulo vive
// en la imagen o el video).
async function crearCreativoDesdePlantilla(cuenta, plantilla, { nombre, tipo, hash, videoId, miniatura, link }) {
  const base = plantilla.creativo.object_story_spec;
  const src = base.link_data || base.video_data || {};
  const texto = src.message;
  const titulo = base.link_data?.name ?? base.video_data?.title;
  const cta = { type: src.call_to_action?.type || 'SHOP_NOW', value: { link } };
  const spec = { page_id: base.page_id };
  if (tipo === 'imagen') spec.link_data = { link, message: texto, name: titulo, image_hash: hash, call_to_action: cta };
  else spec.video_data = { video_id: videoId, message: texto, title: titulo, image_url: miniatura, call_to_action: cta };
  const campos = { name: nombre, object_story_spec: spec };
  if (plantilla.creativo.instagram_user_id) campos.instagram_user_id = plantilla.creativo.instagram_user_id;
  if (plantilla.creativo.url_tags) campos.url_tags = plantilla.creativo.url_tags;
  // Las mejoras automáticas de Meta van desactivadas como en los creativos
  // actuales; si Meta no acepta la lista completa, se reintenta sin ella.
  if (plantilla.creativo.degrees_of_freedom_spec) {
    try {
      return await meta.crearCreativo(cuenta, { ...campos, degrees_of_freedom_spec: plantilla.creativo.degrees_of_freedom_spec });
    } catch (err) {
      if (!/degrees_of_freedom|creative_features/i.test(`${err.message} ${err.detalle || ''}`)) throw err;
    }
  }
  return meta.crearCreativo(cuenta, campos);
}

const esperar = (ms) => new Promise(r => setTimeout(r, ms));

async function ejecutarIngesta(prop, cuenta, usuario) {
  const pl = prop.payload || {};
  const p = await cargarParametros();
  if (!pl.plantillaConjuntoId) return { estado: 'fallida', error: 'No hay un ad set de testeo para copiar la configuración' };
  const plantilla = await meta.plantillaDeConjunto(pl.plantillaConjuntoId);
  const link = (p.ofertas.find(o => o.defecto) || p.ofertas[0]).link;
  // Si se aprueba tarde (pasado el sábado 05:00), arranca enseguida.
  const inicio = new Date(pl.inicio) > new Date(Date.now() + 10 * 60000) ? pl.inicio : new Date(Date.now() + 15 * 60000).toISOString();
  const estado = pl.activar ? 'ACTIVE' : 'PAUSED';
  const biblioteca = await meta.listarBiblioteca(cuenta, { paginas: 3 });
  const existentes = await meta.buscarAnunciosPorNombre(cuenta, 'VEL');

  const resultados = [];
  const avisos = new Set();
  for (const item of pl.items || []) {
    const r = { veln: item.veln, archivo: item.archivo };
    try {
      if (existentes.some(a => ingesta.reVel(item.veln).test(a.nombre))) {
        resultados.push({ ...r, estado: 'ya_existia' });
        continue;
      }
      // 1. Medio en la biblioteca de Meta (si no está, se baja de Drive y se sube).
      let hash = null; let videoId = null; let miniatura = null;
      if (item.tipo === 'imagen') {
        hash = biblioteca.imagenes.find(i => ingesta.reVel(item.veln).test(i.nombre))?.hash || null;
        if (!hash) { hash = await meta.subirImagen(cuenta, await ingesta.descargar(item.fileId), item.archivo); r.subido = true; }
      } else {
        videoId = biblioteca.videos.find(v => ingesta.reVel(item.veln).test(v.nombre))?.id || null;
        if (!videoId) { videoId = await meta.subirVideo(cuenta, await ingesta.descargar(item.fileId), item.archivo); r.subido = true; }
        // Meta procesa el video antes de poder usarlo (hasta ~5 min).
        for (let i = 0; i < 30; i++) {
          const v = await meta.estadoVideo(videoId);
          if (v.listo && v.miniatura) { miniatura = v.miniatura; break; }
          if (v.estado === 'error') throw new Error('Meta no pudo procesar el video');
          await esperar(10000);
        }
        if (!miniatura) throw new Error('El video sigue procesándose en Meta: reintentá en unos minutos');
      }
      // 2. Creativo, ad set y anuncio (Rulebook §6.1).
      const creativoId = await crearCreativoDesdePlantilla(cuenta, plantilla, { nombre: item.veln, tipo: item.tipo, hash, videoId, miniatura, link });
      const conjunto = await crearConjuntoNuevo(cuenta, {
        ...plantilla.conjunto,
        name: `ABO-Advantage+ Audience - ${item.angulo} - ${item.veln}`,
        campaign_id: pl.campaniaId,
        daily_budget: Math.round(pl.presupuesto * 100),
        start_time: inicio,
        status: estado,
      });
      if (conjunto.aviso) avisos.add(conjunto.aviso);
      const anuncioId = await meta.crearAnuncio(cuenta, { conjuntoId: conjunto.id, creativoId, nombre: item.veln, estado });
      const final = await meta.obtenerObjeto(anuncioId, 'effective_status');
      resultados.push({ ...r, estado: 'creado', conjuntoId: conjunto.id, anuncioId, estadoEfectivo: final.effective_status });
      await registrar({ origen: 'aprobacion', usuario, propuesta_id: prop.id, tipo: 'anuncio_creado', entidad_tipo: 'conjunto', entidad_id: conjunto.id,
        entidad_nombre: item.veln, conjunto_id: conjunto.id,
        titulo: `Testeo creado: ${item.veln}`,
        detalle: `${item.angulo} · ${pl.campaniaNombre} · $${fmt(pl.presupuesto)}/día · ${estado === 'ACTIVE' ? 'activo desde' : 'pausado, arranque'} ${inicio}${r.subido ? ' · subido desde Drive' : ''}`,
        despues: { conjuntoId: conjunto.id, anuncioId, creativoId, estadoEfectivo: final.effective_status } });
    } catch (err) {
      resultados.push({ ...r, estado: 'error', error: err.detalle ? `${err.message} — ${err.detalle}` : err.message });
    }
  }
  ingesta.invalidarCache();
  const creados = resultados.filter(x => x.estado === 'creado').length;
  const errores = resultados.filter(x => x.estado === 'error');
  const mensajes = [...avisos, ...errores.map(e => `${e.veln}: ${e.error}`)];
  return {
    estado: creados || resultados.some(x => x.estado === 'ya_existia') ? 'ejecutada' : 'fallida',
    resultado: { creados, resultados },
    error: mensajes.length ? mensajes.join(' · ') : null,
  };
}

// Devuelve { estado, resultado?, error? } — estado final de la propuesta.
async function ejecutar(prop, cuenta, usuario) {
  const pl = prop.payload || {};
  const base = { origen: 'aprobacion', usuario, propuesta_id: prop.id, entidad_tipo: prop.entidad_tipo };

  if (prop.tipo === 'pausa' || prop.tipo === 'reencender') {
    const actual = await meta.obtenerObjeto(prop.entidad_id, 'name,status,effective_status');
    const destino = prop.tipo === 'pausa' ? 'PAUSED' : 'ACTIVE';
    if (actual.status === destino) return { estado: 'desactualizada', error: `Ya está ${destino === 'PAUSED' ? 'pausado' : 'activo'}` };
    await meta.actualizarObjeto(prop.entidad_id, { status: destino });
    const despues = await meta.obtenerObjeto(prop.entidad_id, 'status,effective_status');
    await registrar({ ...base, tipo: prop.tipo === 'pausa' ? 'pausa' : 'activacion', entidad_id: prop.entidad_id, entidad_nombre: prop.entidad_nombre,
      titulo: `${prop.tipo === 'pausa' ? 'Pausado' : 'Reactivado'}: ${prop.entidad_nombre}`, detalle: `${prop.regla} · ${prop.motivo}`,
      antes: { estado: actual.status, ...(prop.snapshot?.metricas || {}) }, despues: { estado: despues.status, estadoEfectivo: despues.effective_status } });
    return { estado: 'ejecutada', resultado: { estado: despues.status, estadoEfectivo: despues.effective_status } };
  }

  if (prop.tipo === 'escalado') {
    const actual = await meta.obtenerObjeto(prop.entidad_id, 'daily_budget,account_id');
    const offset = 100; // UYU
    const presupuestoActual = Number(actual.daily_budget) / offset;
    if (Math.abs(presupuestoActual - pl.anterior) > 0.5) {
      return { estado: 'desactualizada', error: `El presupuesto cambió desde que se propuso ($${fmt(pl.anterior)} → $${fmt(presupuestoActual)})` };
    }
    const r = await meta.fijarPresupuestoDiario(prop.entidad_id, pl.nuevo);
    const forzado = r.estadoEfectivo !== 'ACTIVE';
    await registrar({ ...base, tipo: 'escalado', entidad_id: prop.entidad_id, entidad_nombre: prop.entidad_nombre,
      titulo: `Presupuesto ${prop.entidad_nombre}`, detalle: `$${fmt(pl.anterior)} → $${fmt(r.presupuestoDiario)} (+${pl.porcentaje}%) · ${prop.motivo}`,
      antes: { presupuesto: pl.anterior, cpa: prop.snapshot?.metricas?.cpa, roas: prop.snapshot?.metricas?.roas },
      despues: { presupuesto: r.presupuestoDiario, estadoEfectivo: r.estadoEfectivo } });
    return {
      estado: 'ejecutada',
      resultado: { presupuesto: r.presupuestoDiario, estadoEfectivo: r.estadoEfectivo },
      // status_forced_to_paused (§3): no se reintenta por API, se avisa.
      error: forzado ? `Meta dejó la entidad en ${r.estadoEfectivo} después del cambio: reactivala a mano desde Ads Manager` : null,
    };
  }

  if (prop.tipo === 'graduacion' || prop.tipo === 'duplicado_rtg') {
    const ya = await meta.buscarAnunciosPorNombre(cuenta, prop.entidad_nombre);
    if (ya.some(a => a.conjuntoId === pl.conjuntoId)) return { estado: 'desactualizada', error: `Ya existe un anuncio con "${prop.entidad_nombre}" en "${pl.conjuntoNombre}"` };
    const id = await meta.crearAnuncio(cuenta, { conjuntoId: pl.conjuntoId, creativoId: pl.creativoId, nombre: pl.nombre, estado: pl.activar ? 'ACTIVE' : 'PAUSED' });
    const despues = await meta.obtenerObjeto(id, 'status,effective_status');
    await registrar({ ...base, tipo: 'anuncio_creado', entidad_tipo: 'anuncio', entidad_id: id, entidad_nombre: pl.nombre, conjunto_id: pl.conjuntoId,
      titulo: `${prop.tipo === 'graduacion' ? 'Graduado' : 'Duplicado a retargeting'}: ${prop.entidad_nombre}`,
      detalle: `"${pl.nombre}" en "${pl.conjuntoNombre}" (${pl.campaniaDestino || ''}) · ${despues.effective_status}`,
      antes: prop.snapshot?.metricas || null, despues: { anuncioId: id, estado: despues.status, estadoEfectivo: despues.effective_status } });
    return {
      estado: 'ejecutada',
      resultado: { anuncioId: id, estadoEfectivo: despues.effective_status },
      error: despues.effective_status !== 'ACTIVE' ? `El anuncio quedó en ${despues.effective_status}: revisá que el ad set y la campaña estén activos` : null,
    };
  }

  if (prop.tipo === 'ingesta_tanda') return ejecutarIngesta(prop, cuenta, usuario);

  if (prop.tipo === 'crear_sich') {
    const p = await cargarParametros();
    const r = await ingesta.crearCarpetaSich(p, { angulos: pl.angulos || [] });
    // Las ideas aprobadas que entraron en esta tanda quedan marcadas como usadas.
    for (const a of (pl.angulos || []).filter(x => x.estado === 'aprobada')) {
      await registrar({ ...base, tipo: 'decision', entidad_tipo: 'idea', entidad_nombre: a.angulo, titulo: `Idea usada en SICH ${r.numero}: ${a.angulo}`,
        despues: { tipo: 'idea_aprobada', angulo: a.angulo, hipotesis: a.hipotesis, usada: true } });
    }
    await registrar({ ...base, tipo: 'decision', entidad_tipo: 'drive', entidad_nombre: `SICH ${r.numero}`, titulo: `Carpeta SICH ${r.numero} creada en Drive`,
      detalle: r.angulos.map(a => a.angulo).join(' · '), despues: r });
    ingesta.invalidarCache();
    return { estado: 'ejecutada', resultado: r };
  }

  if (prop.tipo === 'aprobar_idea' || prop.tipo === 'enmienda') {
    await registrar({ ...base, tipo: 'decision', entidad_tipo: prop.entidad_tipo, entidad_nombre: prop.entidad_nombre,
      titulo: prop.tipo === 'aprobar_idea' ? `Idea aprobada: ${prop.entidad_nombre}` : `Enmienda aprobada: ${prop.titulo.replace(/^Enmienda: /, '')}`,
      detalle: prop.motivo,
      despues: prop.tipo === 'aprobar_idea' ? { tipo: 'idea_aprobada', angulo: pl.angulo, hipotesis: pl.hipotesis, fuente: pl.fuente, usada: false } : { tipo: 'enmienda', ...pl } });
    return {
      estado: 'ejecutada',
      resultado: { registrado: true },
      error: prop.tipo === 'enmienda' ? 'Quedó registrada como decisión: si cambia una regla escrita, actualizá el Rulebook' : null,
    };
  }

  if (prop.tipo === 'ajuste_parametro') {
    const fila = await supabaseService.obtenerParametrosMetaAds();
    const actuales = { ...(fila?.parametros || {}) };
    const vigente = (await cargarParametros())[pl.clave];
    if (vigente !== pl.anterior) return { estado: 'desactualizada', error: `El parámetro ya cambió (ahora vale ${vigente})` };
    actuales[pl.clave] = pl.nuevo;
    await supabaseService.guardarParametrosMetaAds(limpiarParametros(actuales), usuario);
    await registrar({ ...base, tipo: 'decision', entidad_tipo: 'parametro', entidad_id: pl.clave, entidad_nombre: prop.entidad_nombre,
      titulo: `Parámetro cambiado: ${prop.entidad_nombre}`, detalle: `${pl.anterior} → ${pl.nuevo} · ${prop.motivo}`, antes: { valor: pl.anterior }, despues: { valor: pl.nuevo } });
    return { estado: 'ejecutada', resultado: { clave: pl.clave, valor: pl.nuevo } };
  }

  if (prop.tipo === 'crear_lookalike') {
    const existentes = await meta.listarAudiencias(cuenta);
    if (existentes.some(a => a.subtipo === 'LOOKALIKE' && a.origenes.includes(pl.origenId) && Date.now() - new Date(a.actualizada || a.creada).getTime() < 90 * DIA_MS)) {
      return { estado: 'desactualizada', error: 'Ya existe un lookalike reciente de esa audiencia' };
    }
    const id = await meta.crearLookalike(cuenta, { origenId: pl.origenId, ratio: pl.ratio, pais: pl.pais, nombre: pl.nombre });
    await registrar({ ...base, tipo: 'audiencia_creada', entidad_tipo: 'audiencia', entidad_id: id, entidad_nombre: pl.nombre,
      titulo: `Lookalike creado: ${pl.nombre}`, detalle: `Semilla "${pl.semilla}" · ${pl.ratio * 100}% · ${pl.pais}` });
    return { estado: 'ejecutada', resultado: { audienciaId: id } };
  }

  if (prop.tipo === 'crear_cbo') {
    const existentes = await meta.buscarCampaniasPorNombre(cuenta, pl.nombreCampania);
    if (existentes.some(c => c.nombre.trim() === pl.nombreCampania)) return { estado: 'desactualizada', error: `"${pl.nombreCampania}" ya existe` };
    if (!pl.plantillaConjuntoId) return { estado: 'fallida', error: 'No hay una CBO de referencia para copiar la configuración del ad set' };
    const plantilla = await meta.obtenerObjeto(pl.plantillaConjuntoId, 'optimization_goal,billing_event,promoted_object,targeting,attribution_spec');
    const campaniaId = await meta.crearCampania(cuenta, {
      name: pl.nombreCampania, objective: 'OUTCOME_SALES', buying_type: 'AUCTION', status: 'PAUSED',
      special_ad_categories: [], daily_budget: Math.round(pl.presupuesto * 100), bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
      start_time: pl.inicio,
    });
    const conjuntoBase = {
      name: 'BROAD', campaign_id: campaniaId, status: 'PAUSED', start_time: pl.inicio,
      optimization_goal: plantilla.optimization_goal, billing_event: plantilla.billing_event,
      promoted_object: plantilla.promoted_object, targeting: plantilla.targeting, attribution_spec: plantilla.attribution_spec,
    };
    const { id: conjuntoId, aviso } = await crearConjuntoNuevo(cuenta, conjuntoBase);
    const avisos = aviso ? [aviso] : [];
    const anuncioId = await meta.crearAnuncio(cuenta, { conjuntoId, creativoId: pl.creativoId, nombre: pl.nombreAnuncio, estado: 'ACTIVE' });
    await registrar({ ...base, tipo: 'campania_creada', entidad_tipo: 'campania', entidad_id: campaniaId, entidad_nombre: pl.nombreCampania, conjunto_id: conjuntoId,
      titulo: `CBO nueva: ${pl.nombreCampania}`, detalle: `Pausada, con "${pl.nombreAnuncio}" · presupuesto $${fmt(pl.presupuesto)}/día · arranque ${pl.inicio}`,
      despues: { campaniaId, conjuntoId, anuncioId } });
    await registrar({ ...base, tipo: 'anuncio_creado', entidad_tipo: 'anuncio', entidad_id: anuncioId, entidad_nombre: pl.nombreAnuncio, conjunto_id: conjuntoId,
      titulo: `Graduado: ${prop.entidad_nombre}`, detalle: `"${pl.nombreAnuncio}" en la CBO nueva "${pl.nombreCampania}"` });
    return { estado: 'ejecutada', resultado: { campaniaId, conjuntoId, anuncioId }, error: avisos.length ? avisos.join(' · ') : null };
  }

  return { estado: 'fallida', error: `Tipo de propuesta no soportado: ${prop.tipo}` };
}

async function aprobarPropuesta(id, usuario, cuentaId) {
  cacheInicio.clear();
  const cuenta = cuentaId || meta.cuentaPorDefecto();
  const prop = await supabaseService.obtenerPropuestaMetaAds(id);
  if (!prop) throw Object.assign(new Error('Propuesta inexistente'), { status: 404 });
  if (prop.estado !== 'pendiente') throw Object.assign(new Error(`La propuesta ya está ${prop.estado}`), { status: 409 });
  if (JOBS[prop.job] && !jobActivo(prop.job)) throw Object.assign(new Error('Esta propuesta viene de una función apagada por ahora'), { status: 409 });
  if (prop.vence_at && new Date(prop.vence_at) < new Date()) {
    await supabaseService.actualizarPropuestaMetaAds(id, { estado: 'vencida', resuelto_por: usuario, resuelto_at: new Date().toISOString(), error: 'Venció antes de aprobarse: reevaluá para recalcularla' }, 'pendiente');
    throw Object.assign(new Error('La propuesta venció: reevaluá para recalcularla con datos frescos'), { status: 409 });
  }
  // Se "toma" la propuesta antes de ejecutar para que no se apruebe dos veces.
  const tomada = await supabaseService.actualizarPropuestaMetaAds(id, { estado: 'aprobada', resuelto_por: usuario, resuelto_at: new Date().toISOString() }, 'pendiente');
  if (!tomada) throw Object.assign(new Error('Otra persona la resolvió recién'), { status: 409 });

  const terminar = async () => {
    let final;
    try {
      final = await ejecutar(prop, cuenta, usuario);
    } catch (err) {
      final = { estado: 'fallida', error: err.detalle ? `${err.message} — ${err.detalle}` : err.message };
      await registrar({ tipo: 'error', origen: 'aprobacion', usuario, propuesta_id: id, entidad_id: prop.entidad_id, entidad_nombre: prop.entidad_nombre, titulo: `Falló: ${prop.titulo}`, detalle: final.error });
    }
    return supabaseService.actualizarPropuestaMetaAds(id, { estado: final.estado, resultado: final.resultado || null, error: final.error || null });
  };
  // La ingesta descarga y sube archivos (puede tardar minutos): corre en segundo
  // plano y la propuesta queda "aprobada" (ejecutando) hasta que termina.
  if (prop.tipo === 'ingesta_tanda') {
    terminar().catch(err => logService.error('Meta Ads: ingesta en segundo plano', { error: err.message }));
    return tomada;
  }
  return terminar();
}

async function rechazarPropuesta(id, usuario, motivo) {
  const prop = await supabaseService.actualizarPropuestaMetaAds(id, {
    estado: 'rechazada', resuelto_por: usuario, resuelto_at: new Date().toISOString(), error: motivo || null,
  }, 'pendiente');
  if (!prop) throw Object.assign(new Error('La propuesta ya no está pendiente'), { status: 409 });
  await registrar({ tipo: 'rechazo', origen: 'aprobacion', usuario, propuesta_id: id, entidad_id: prop.entidad_id, entidad_nombre: prop.entidad_nombre,
    titulo: `Rechazado: ${prop.titulo}`, detalle: motivo || null });
  return prop;
}

// Acción manual desde el panel (prender/apagar/presupuesto/duplicar): queda en
// la actividad para que las cadencias la tengan en cuenta.
async function registrarAccionManual({ tipo, usuario, entidadId, entidadNombre, titulo, detalle, antes, despues }) {
  await registrar({ tipo, origen: 'manual', usuario, entidad_id: entidadId, entidad_nombre: entidadNombre, titulo, detalle, antes, despues });
}

// ── resumen para la pantalla Inicio ──────────────────────────────────────────

// Cache corto: el Inicio hace 3 consultas de insights a Meta (~10 s) y se
// visita seguido; los datos de 7 días no cambian en un par de minutos.
const cacheInicio = new Map(); // cuenta → { en, datos }
const CACHE_INICIO_MS = 3 * 60 * 1000;

async function resumenInicio(cuentaId, { fresco = false } = {}) {
  const cuenta = cuentaId || meta.cuentaPorDefecto();
  const enCache = cacheInicio.get(cuenta);
  if (!fresco && enCache && Date.now() - enCache.en < CACHE_INICIO_MS) return enCache.datos;
  const datos = await calcularResumenInicio(cuenta);
  cacheInicio.set(cuenta, { en: Date.now(), datos });
  return datos;
}

async function calcularResumenInicio(cuenta) {
  const p = await cargarParametros();
  const v = ventanas();
  // Los nombres vienen en los propios insights: no hace falta la estructura
  // completa de la cuenta (con cientos de campañas Meta la rechaza por tamaño).
  const [cuenta7, campanias7, ads7] = await Promise.all([
    meta.insightsCuenta(cuenta, v.A),
    meta.insightsPorNivel(cuenta, 'campaign', v.A),
    meta.insightsPorNivel(cuenta, 'ad', v.A),
  ]);

  // Objetivo y BK de cuenta ponderados por gasto de cada oferta (§6.4).
  let gastoTotal = 0; let sumaObj = 0; let sumaMax = 0;
  for (const m of campanias7.values()) {
    const o = ofertaDe([m.nombres.campania], p.ofertas);
    gastoTotal += m.gasto; sumaObj += m.gasto * o.cpaObjetivo; sumaMax += m.gasto * o.cpaMaximo;
  }
  const defecto = p.ofertas.find(o => o.defecto) || p.ofertas[0];
  const objetivo = gastoTotal > 0 ? sumaObj / gastoTotal : defecto.cpaObjetivo;
  const maximo = gastoTotal > 0 ? sumaMax / gastoTotal : defecto.cpaMaximo;
  const cpa = cuenta7?.cpa ?? null;
  const banda = cpa == null ? null : cpa <= objetivo ? 'verde' : cpa <= maximo ? 'amarilla' : 'roja';

  // Creativos que más invierten (7 días): detalle sólo de esos 5, en una llamada.
  const top = [...ads7.entries()].sort(([, x], [, y]) => y.gasto - x.gasto).slice(0, 5);
  // thumbnail_width/height: Meta devuelve por defecto miniaturas de 64px.
  const detalle = await meta.obtenerVarios(top.map(([id]) => id), 'created_time,effective_status,creative{thumbnail_url,image_url}', { thumbnail_width: 480, thumbnail_height: 600 }).catch(() => ({}));
  const creativos = top.map(([id, m]) => {
    const d = detalle[id] || {};
    const oferta = ofertaDe([m.nombres.campania, m.nombres.conjunto], p.ofertas);
    const testeo = contiene(m.nombres.campania, p.patronTesteo);
    const angulo = /ABO-Advantage\+ Audience - (.+?) - (VEL|ADSET)\d+/i.exec(m.nombres.conjunto || '')?.[1] || null;
    let etiqueta = 'Activo';
    if (m.compras === 0 && m.gasto < oferta.cpaObjetivo) etiqueta = 'Sin datos';
    else if (d.created_time && diasDesde(d.created_time) < p.noTocarDias) etiqueta = 'Protegido';
    else if (m.cpa != null && m.cpa < oferta.cpaObjetivo && m.roas > p.roasEscalado) etiqueta = 'Ganador';
    else if (testeo) etiqueta = 'En prueba';
    return {
      id, nombre: m.nombres.anuncio, angulo, etiqueta,
      miniatura: d.creative?.image_url || d.creative?.thumbnail_url || null, estadoEfectivo: d.effective_status || null,
      campania: m.nombres.campania, gasto: m.gasto, cpa: m.cpa, roas: m.roas, compras: m.compras,
      cpaNivel: m.cpa == null ? 'sin' : m.cpa <= oferta.cpaObjetivo ? 'bien' : m.cpa <= oferta.cpaMaximo ? 'medio' : 'mal',
    };
  });

  return { moneda: 'UYU', ventana: v.A, cuenta: { ...cuenta7, objetivo, maximo, banda }, creativos };
}

module.exports = {
  jobActivo,
  correrJob,
  estadoJobs,
  aprobarPropuesta,
  rechazarPropuesta,
  registrarAccionManual,
  resumenInicio,
  cargarParametros,
  JOBS,
};

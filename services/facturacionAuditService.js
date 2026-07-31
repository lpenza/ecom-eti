// Auditoría de las líneas de facturación de los couriers.
//
// Toma las líneas ya parseadas y valorizadas por facturacionParserService y les cuelga
// un array de `flags` con todo lo que hay que mirar: cobros duplicados dentro del mismo
// archivo, cobros que ya venían en la liquidación del mes anterior, guías que no
// corresponden a ningún pedido de la app, importes fuera de tarifa, etc.
//
// Además arma el resumen económico del período (neto/IVA/total por servicio y zona,
// gasto de PickUp que no está contemplado en el sistema de facturación del usuario, y
// la comparación contra el costo contable de referencia de Montevideo).

const supabaseService = require('./supabaseService');
const { redondear2, normalizarTexto } = require('./facturacionParserService');

// El servicio "PickUp" de MarcoPostal ($65 por retiro) es el gasto que hoy no está
// contemplado en el sistema de facturación. Se compara el nombre normalizado exacto:
// el servicio de UES "Entrega Pick Up Interior - Xpres" es una entrega común y NO va acá.
const esPickupMarcoPostal = (linea) => normalizarTexto(linea.servicio) === 'pickup';

// Cada flag tiene una etiqueta y una severidad que el panel usa para ordenar y colorear.
// `reclamable: true` = el importe de esa línea suma al monto a reclamarle al courier.
const FLAGS = {
  guia_repetida_en_archivo: {
    label: 'Guía repetida en el archivo',
    severidad: 'alta',
    reclamable: true,
  },
  duplicado_en_archivo: {
    label: 'Cobro duplicado de la orden',
    severidad: 'alta',
    reclamable: true,
  },
  // El primer cobro de una orden duplicada es el legítimo: se marca para que se vea al
  // lado del duplicado, pero no suma al monto a reclamar.
  tiene_duplicado: {
    label: 'Cobro original (tiene duplicado)',
    severidad: 'info',
    reclamable: false,
  },
  duplicado_historico: {
    label: 'Guía ya cobrada en otra liquidación',
    severidad: 'alta',
    reclamable: true,
  },
  orden_ya_cobrada_antes: {
    label: 'Orden ya cobrada en un período anterior',
    severidad: 'alta',
    reclamable: true,
  },
  sin_pedido: {
    label: 'Sin pedido en la app',
    severidad: 'alta',
    reclamable: true,
  },
  importe_fuera_de_tarifa: {
    label: 'Importe fuera de tarifa',
    severidad: 'media',
    reclamable: false,
  },
  zona_desconocida: {
    label: 'Zona sin clasificar',
    severidad: 'media',
    reclamable: false,
  },
  sin_tarifa: {
    label: 'Sin tarifa configurada',
    severidad: 'media',
    reclamable: false,
  },
  fuera_de_periodo: {
    label: 'Fuera del período declarado',
    severidad: 'media',
    reclamable: false,
  },
  sin_orden: {
    label: 'Sin número de orden',
    severidad: 'baja',
    reclamable: false,
  },
  reenvio_justificado: {
    label: 'Reenvío justificado',
    severidad: 'info',
    reclamable: false,
  },
  revisado: {
    label: 'Ya revisado antes',
    severidad: 'info',
    reclamable: false,
  },
};

const ESTADOS_RESUELTOS = ['justificado', 'acreditado'];

// ── Helpers ──────────────────────────────────────────────────────────────────────

function agregarFlag(linea, flag, detalle = null) {
  if (!linea.flags) linea.flags = [];
  if (linea.flags.some((f) => f.tipo === flag)) return;
  linea.flags.push({ tipo: flag, detalle, ...FLAGS[flag] });
}

function soloFecha(valor) {
  if (!valor) return null;
  const d = valor instanceof Date ? valor : new Date(valor);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

// Las órdenes de reenvío se generan como "RCL-2523" (ver crearReenvio en
// supabaseService): un cobro extra sobre esa orden base está justificado.
function ordenBase(orden) {
  if (!orden) return null;
  const m = String(orden).match(/^(?:RCL|COL)-(\d+)/i);
  return m ? m[1] : String(orden);
}

// ── Auditoría ────────────────────────────────────────────────────────────────────

/**
 * Audita las líneas de una liquidación.
 *
 * @param {object} params
 * @param {string} params.proveedor
 * @param {Array}  params.lineas líneas parseadas y valorizadas
 * @param {Date}   params.periodoDesde
 * @param {Date}   params.periodoHasta
 * @param {number} params.totalDeclarado total que trae el propio archivo (puede ser null)
 * @param {object} params.parametros { ivaTasa, costoContableMvd, zonasExtendidas }
 * @param {Array}  params.levantesDetectados días con levante en domicilio salidos del Excel (UES)
 * @param {number} params.cantidadFacturada levantes a facturar; si no se indica, se usan
 *        los registrados en la app
 * @param {number} params.liquidacionIdActual si se está re-auditando algo ya guardado,
 *        se excluye esa liquidación del histórico para no marcarse duplicada a sí misma
 * @returns {Promise<{lineas, resumen, avisos, levantes}>}
 */
async function auditarLineas({
  proveedor,
  lineas,
  periodoDesde = null,
  periodoHasta = null,
  totalDeclarado = null,
  parametros = {},
  levantesDetectados = [],
  cantidadFacturada = null,
  liquidacionIdActual = null,
}) {
  const ivaTasa = Number.isFinite(parametros.ivaTasa) ? parametros.ivaTasa : 0.22;
  const costoContableMvd = Number.isFinite(parametros.costoContableMvd)
    ? parametros.costoContableMvd
    : null;

  for (const linea of lineas) linea.flags = [];

  // ── 1. Duplicados dentro del propio archivo ───────────────────────────────────
  const porGuia = new Map();
  const porOrden = new Map();
  for (const linea of lineas) {
    if (!porGuia.has(linea.guia)) porGuia.set(linea.guia, []);
    porGuia.get(linea.guia).push(linea);

    if (linea.orden) {
      const base = ordenBase(linea.orden);
      if (!porOrden.has(base)) porOrden.set(base, []);
      porOrden.get(base).push(linea);
    }
  }

  // En los duplicados, el primer cobro (el más viejo) es el legítimo: el reclamo es por
  // los que vienen después. Por eso se ordena el grupo por fecha y sólo se marcan como
  // `duplicado_en_archivo` —que es lo reclamable— los cobros a partir del segundo.
  const porFecha = (a, b) => (a.fecha?.getTime() || 0) - (b.fecha?.getTime() || 0);

  for (const [guia, grupo] of porGuia) {
    if (grupo.length > 1) {
      const [, ...repetidas] = [...grupo].sort(porFecha);
      for (const linea of repetidas) {
        agregarFlag(linea, 'guia_repetida_en_archivo', `La guía ${guia} aparece ${grupo.length} veces en el archivo`);
      }
    }
  }

  for (const [orden, grupo] of porOrden) {
    const guias = [...new Set(grupo.map((l) => l.guia))];
    if (guias.length > 1) {
      const [primera, ...extras] = [...grupo].sort(porFecha);
      agregarFlag(
        primera,
        'tiene_duplicado',
        `La orden ${orden} se volvió a cobrar con ${extras.map((l) => l.guia).join(', ')}`
      );
      for (const linea of extras) {
        agregarFlag(
          linea,
          'duplicado_en_archivo',
          `La orden ${orden} ya se había cobrado con la guía ${primera.guia} (${soloFecha(primera.fecha) || 's/f'})`
        );
      }
    }
  }

  for (const linea of lineas) {
    if (!linea.orden) agregarFlag(linea, 'sin_orden');
  }

  // ── 2. Duplicados contra liquidaciones anteriores ─────────────────────────────
  const guias = [...porGuia.keys()];
  const ordenes = [...porOrden.keys()];

  const [historicoGuias, historicoOrdenes] = await Promise.all([
    supabaseService.buscarLineasFacturacionPorGuias(proveedor, guias),
    supabaseService.buscarLineasFacturacionPorOrdenes(proveedor, ordenes),
  ]);

  const esOtraLiquidacion = (h) => String(h.liquidacion_id) !== String(liquidacionIdActual);

  const histPorGuia = new Map();
  for (const h of historicoGuias.filter(esOtraLiquidacion)) {
    if (!histPorGuia.has(h.guia)) histPorGuia.set(h.guia, []);
    histPorGuia.get(h.guia).push(h);
  }

  const histPorOrden = new Map();
  for (const h of historicoOrdenes.filter(esOtraLiquidacion)) {
    const base = ordenBase(h.orden);
    if (!base) continue;
    if (!histPorOrden.has(base)) histPorOrden.set(base, []);
    histPorOrden.get(base).push(h);
  }

  for (const linea of lineas) {
    const previasGuia = histPorGuia.get(linea.guia) || [];
    if (previasGuia.length > 0) {
      const fechas = previasGuia.map((p) => soloFecha(p.fecha)).filter(Boolean);
      agregarFlag(
        linea,
        'duplicado_historico',
        `Esta guía ya figura en ${previasGuia.length} liquidación(es) anterior(es)${fechas.length ? ` (${fechas.join(', ')})` : ''}`
      );
    }

    const base = ordenBase(linea.orden);
    const previasOrden = (histPorOrden.get(base) || []).filter((p) => p.guia !== linea.guia);
    if (base && previasOrden.length > 0) {
      agregarFlag(
        linea,
        'orden_ya_cobrada_antes',
        `La orden ${base} ya se cobró antes con la guía ${previasOrden.map((p) => p.guia).join(', ')}`
      );
    }

    // Si esta guía u orden ya fue resuelta manualmente, no vuelve a molestar.
    const yaResuelta = [...previasGuia, ...previasOrden].some(
      (p) => ESTADOS_RESUELTOS.includes(p.revision_estado)
    );
    if (yaResuelta) agregarFlag(linea, 'revisado');
  }

  // ── 3. Cruce contra los pedidos de la app ─────────────────────────────────────
  const [pedidosPorTracking, pedidosPorNumero] = await Promise.all([
    supabaseService.buscarPedidosPorTrackings(guias),
    supabaseService.buscarPedidosPorNumeros(ordenes),
  ]);

  const mapaTracking = new Map(
    pedidosPorTracking.map((p) => [String(p.numero_seguimiento_ues).trim(), p])
  );
  // Un mismo número de orden puede tener el pedido original y sus reenvíos RCL-.
  const mapaNumero = new Map();
  for (const p of pedidosPorNumero) {
    const base = ordenBase(p.numero_pedido);
    if (!base) continue;
    if (!mapaNumero.has(base)) mapaNumero.set(base, []);
    mapaNumero.get(base).push(p);
  }

  for (const linea of lineas) {
    // Primero por guía (match exacto), después por número de orden: así una guía
    // regenerada a mano —que nunca quedó registrada en la app— igual se asocia al
    // pedido y no dispara `sin_pedido` de más.
    const porTracking = mapaTracking.get(linea.guia) || null;
    const base = ordenBase(linea.orden);
    const candidatosOrden = base ? (mapaNumero.get(base) || []) : [];
    const pedido = porTracking || candidatosOrden[0] || null;

    linea.pedidoId = pedido?.id || null;
    linea.pedidoNumero = pedido?.numero_pedido || null;
    linea.matchPor = porTracking ? 'guia' : (pedido ? 'orden' : null);

    if (!pedido) {
      // Los "Retiro sin Costo" son retiros del propio depósito: no tienen pedido y no
      // se cobran, así que no tiene sentido marcarlos.
      if (linea.importeNeto > 0) {
        agregarFlag(linea, 'sin_pedido', 'No hay ningún pedido con esta guía ni con este número de orden');
      }
    }

    // Si el duplicado corresponde a un reenvío/reclamo registrado en la app, está
    // justificado: se muestra aparte y no suma al monto a reclamar.
    const hayReenvio = candidatosOrden.some((p) => p.es_reenvio || p.es_reclamo);
    const esDuplicado = linea.flags.some(
      (f) => f.tipo === 'duplicado_en_archivo' || f.tipo === 'orden_ya_cobrada_antes'
    );
    if (esDuplicado && hayReenvio) {
      const rcl = candidatosOrden.find((p) => p.es_reenvio || p.es_reclamo);
      agregarFlag(linea, 'reenvio_justificado', `Hay un reenvío registrado en la app (${rcl.numero_pedido})`);
    }
  }

  // ── 4. Tarifas y período ──────────────────────────────────────────────────────
  const desde = soloFecha(periodoDesde);
  const hasta = soloFecha(periodoHasta);

  for (const linea of lineas) {
    if (linea.sinTarifa) {
      agregarFlag(linea, 'sin_tarifa', `No hay tarifa para el servicio "${linea.servicio || '—'}"`);
    } else if (
      linea.importeOrigen === 'archivo'
      && linea.tarifaEsperadaNeta !== null
      && redondear2(linea.importeNeto) !== redondear2(linea.tarifaEsperadaNeta)
    ) {
      agregarFlag(
        linea,
        'importe_fuera_de_tarifa',
        `Cobrado $${linea.importeNeto} neto, la tarifa de ${linea.servicio || '—'}`
        + `${linea.categoriaZona && linea.categoriaZona !== '*' ? ` (${linea.categoriaZona})` : ''}`
        + ` es $${linea.tarifaEsperadaNeta}`
      );
      // Zona cuyo importe no coincide con ninguna de las dos tarifas configuradas:
      // probablemente haya que sumarla a `mp_zonas_extendidas`.
      if (linea.zona) {
        agregarFlag(linea, 'zona_desconocida', `Revisar la clasificación de "${linea.zona}"`);
      }
    }

    const fechaLinea = soloFecha(linea.fecha);
    if (fechaLinea && ((desde && fechaLinea < desde) || (hasta && fechaLinea > hasta))) {
      agregarFlag(linea, 'fuera_de_periodo', `Fecha ${fechaLinea}, período ${desde} a ${hasta}`);
    }
  }

  // ── 5. Levantes de UES ────────────────────────────────────────────────────────
  const levantes = proveedor === 'ues'
    ? await construirLevantes({
      desde,
      hasta,
      detectados: levantesDetectados,
      costoUnitario: parametros.costoLevante,
      cantidadFacturada,
      ivaTasa,
    })
    : null;

  // ── 6. Resumen ────────────────────────────────────────────────────────────────
  const resumen = construirResumen({
    lineas,
    totalDeclarado,
    ivaTasa,
    costoContableMvd,
    levantes,
  });

  const avisos = [];
  if (totalDeclarado !== null && redondear2(totalDeclarado) !== resumen.totales.neto) {
    avisos.push({
      tipo: 'total_no_cuadra',
      mensaje: `El total del archivo ($${totalDeclarado}) no coincide con la suma de las líneas ($${resumen.totales.neto})`,
    });
  }
  if (levantes && levantes.enSistema !== levantes.enDetalle) {
    avisos.push({
      tipo: 'levantes_no_coinciden',
      mensaje: `Levantes: la app tiene ${levantes.enSistema} registrado(s) en el período pero el detalle de UES muestra ${levantes.enDetalle} día(s) con levante en domicilio.`
        + (levantes.faltanEnSistema.length
          ? ` Sin registrar en la app: ${levantes.faltanEnSistema.join(', ')}.`
          : '')
        + (levantes.faltanEnDetalle.length
          ? ` Registrados en la app pero sin envíos levantados ese día: ${levantes.faltanEnDetalle.join(', ')}.`
          : ''),
    });
  }

  return { lineas, resumen, avisos, levantes };
}

// ── Levantes ─────────────────────────────────────────────────────────────────────
// UES no cobra el levante como línea del Excel: lo factura por solicitud, en un PDF
// aparte. La cantidad de referencia sale de `ues_levantes` (lo que registró la app) y
// se contrasta con los días de "LEVANTE EN DOMICILIO" que aparecen en el detalle.
// `cantidadFacturada` permite ajustarla a lo que diga el PDF antes de guardar.
async function construirLevantes({ desde, hasta, detectados, costoUnitario, cantidadFacturada, ivaTasa }) {
  const registrados = desde && hasta
    ? await supabaseService.obtenerLevantesEnPeriodo(desde, hasta)
    : [];

  const diasSistema = registrados.map((l) => l.fecha_levante);
  const diasDetalle = detectados.map((d) => d.fecha);
  const setSistema = new Set(diasSistema);
  const setDetalle = new Set(diasDetalle);

  const cantidad = Number.isFinite(cantidadFacturada) ? cantidadFacturada : registrados.length;
  // El costo unitario viene con IVA incluido (igual que la tarifa de envío de UES).
  const unitario = Number.isFinite(costoUnitario) ? costoUnitario : 0;
  const total = redondear2(cantidad * unitario);
  const neto = redondear2(total / (1 + ivaTasa));

  return {
    enSistema: registrados.length,
    enDetalle: detectados.length,
    cantidad,
    costoUnitario: unitario,
    neto,
    iva: redondear2(total - neto),
    total,
    registrados,
    detectados,
    faltanEnSistema: diasDetalle.filter((d) => !setSistema.has(d)),
    faltanEnDetalle: diasSistema.filter((d) => !setDetalle.has(d)),
  };
}

// ── Resumen económico ────────────────────────────────────────────────────────────

function construirResumen({ lineas, totalDeclarado, ivaTasa, costoContableMvd, levantes = null }) {
  const acumular = (acc, l) => ({
    cantidad: acc.cantidad + 1,
    neto: redondear2(acc.neto + l.importeNeto),
    iva: redondear2(acc.iva + l.iva),
    total: redondear2(acc.total + l.importeTotal),
  });
  const vacio = { cantidad: 0, neto: 0, iva: 0, total: 0 };

  const totales = lineas.reduce(acumular, { ...vacio });

  // Desglose por servicio + categoría de zona.
  const desglose = new Map();
  for (const linea of lineas) {
    const clave = `${linea.servicio || 'Sin servicio'}|${linea.categoriaZona || '*'}`;
    const actual = desglose.get(clave) || {
      servicio: linea.servicio || 'Sin servicio',
      categoriaZona: linea.categoriaZona || '*',
      ...vacio,
    };
    desglose.set(clave, { ...actual, ...acumular(actual, linea) });
  }

  // PickUp: gasto que hoy no está contemplado en el sistema de facturación del usuario.
  const pickup = lineas.filter(esPickupMarcoPostal).reduce(acumular, { ...vacio });

  // Real vs contable: sólo los envíos de entrega a domicilio dentro de Montevideo.
  let realVsContable = null;
  if (costoContableMvd !== null) {
    const mvd = lineas.filter(
      (l) => l.categoriaZona === 'montevideo'
        && l.importeNeto > 0
        && !esPickupMarcoPostal(l)
    );
    if (mvd.length > 0) {
      const real = mvd.reduce(acumular, { ...vacio });
      const contable = redondear2(mvd.length * costoContableMvd);
      realVsContable = {
        cantidad: mvd.length,
        costoUnitarioContable: costoContableMvd,
        totalContable: contable,
        totalReal: real.total,
        diferencia: redondear2(contable - real.total),
      };
    }
  }

  // A reclamar: líneas con algún flag reclamable que sigan pendientes de revisión y no
  // estén justificadas por un reenvío registrado en la app.
  const aReclamarLineas = lineas.filter((l) => {
    const justificada = l.flags.some((f) => f.tipo === 'reenvio_justificado' || f.tipo === 'revisado');
    if (justificada) return false;
    if (l.revisionEstado && ESTADOS_RESUELTOS.includes(l.revisionEstado)) return false;
    return l.flags.some((f) => f.reclamable);
  });
  const aReclamar = aReclamarLineas.reduce(acumular, { ...vacio });

  // Contadores por flag, para los chips del panel.
  const porFlag = {};
  for (const linea of lineas) {
    for (const flag of linea.flags) {
      if (!porFlag[flag.tipo]) {
        porFlag[flag.tipo] = { tipo: flag.tipo, label: flag.label, severidad: flag.severidad, cantidad: 0 };
      }
      porFlag[flag.tipo].cantidad += 1;
    }
  }

  // `totales` es sólo la suma de las líneas de envío (es lo que tiene que cuadrar contra
  // el total declarado del archivo). El total general suma además los levantes, que UES
  // factura aparte y no vienen como línea en el Excel.
  const totalGeneral = {
    neto: redondear2(totales.neto + (levantes?.neto || 0)),
    iva: redondear2(totales.iva + (levantes?.iva || 0)),
    total: redondear2(totales.total + (levantes?.total || 0)),
  };

  return {
    ivaTasa,
    totales,
    totalGeneral,
    totalDeclarado,
    desglose: [...desglose.values()].sort((a, b) => b.total - a.total),
    pickup,
    realVsContable,
    levantes,
    aReclamar,
    flags: Object.values(porFlag).sort((a, b) => b.cantidad - a.cantidad),
  };
}

module.exports = { auditarLineas, FLAGS };

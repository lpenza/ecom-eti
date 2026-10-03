// Parámetros del piloto de Meta Ads. Los valores por defecto son los del
// Rulebook (sección "Parámetros configurables"); lo que se edita desde el panel
// se guarda en meta_ads_parametros y pisa estos valores.

const OFERTAS_DEFECTO = [
  // tag: cómo se reconoce la oferta en el nombre de campaña/ad set. Se buscan
  // de la más específica a la más general (STUDIO+2COL antes que STUDIO).
  { tag: 'KIT', nombre: 'Kit inicio + Lápiz', cpaObjetivo: 550, cpaMaximo: 850, link: 'https://velinneuy.com/products/velinne™-starter-kit', defecto: true },
  { tag: 'KIT+1COL', nombre: 'Kit inicio + 1 color + Lápiz', cpaObjetivo: 580, cpaMaximo: 900, link: 'https://velinneuy.com/products/kit-deluxe' },
  { tag: 'STUDIO', nombre: 'Kit Studio + 1 color', cpaObjetivo: 620, cpaMaximo: 950, link: 'https://velinneuy.com/products/kit-signature' },
  { tag: 'STUDIO+2COL', nombre: 'Kit Studio + 2 colores', cpaObjetivo: 620, cpaMaximo: 950, link: 'https://velinneuy.com/products/kit-luxury' },
  { tag: 'COLORES', nombre: 'Set de colores', cpaObjetivo: 450, cpaMaximo: 800, link: 'https://velinneuy.com/products/velinne™-set-de-colores' },
];

// grupo / clave / label / unidad / defecto / ayuda (+ tipo 'texto').
const DEFINICIONES = [
  { grupo: 'Rentabilidad', clave: 'roasPausa', label: 'ROAS mínimo de pausa', unidad: 'x', paso: 0.1, defecto: 2,
    ayuda: 'Debajo de esto (con datos suficientes) se propone pausar. Rulebook §2.' },
  { grupo: 'Rentabilidad', clave: 'roasEscalado', label: 'ROAS de escalado', unidad: 'x', paso: 0.1, defecto: 3,
    ayuda: 'Junto con CPA bajo el objetivo de la oferta, habilita escalar o graduar. Rulebook §3.' },
  { grupo: 'Rentabilidad', clave: 'ctrMinimo', label: 'CTR mínimo', unidad: '%', paso: 0.1, defecto: 1,
    ayuda: 'Señal secundaria: sola no pausa salvo en testeo (nivel temprano negativo).' },

  { grupo: 'Confianza', clave: 'volumenMinimo', label: 'Volumen mínimo', unidad: 'compras', paso: 1, defecto: 15,
    ayuda: 'Compras para confiar en el dato. Alternativa: el gasto mínimo de abajo (gana el que se cumpla).' },
  { grupo: 'Confianza', clave: 'gastoMinimoCpa', label: 'Gasto mínimo', unidad: '× CPA obj.', paso: 0.5, defecto: 2,
    ayuda: 'Gasto, en múltiplos del CPA objetivo de la oferta, a partir del cual se decide. Rulebook: 1-2×.' },
  { grupo: 'Confianza', clave: 'noTocarDias', label: 'Ventana de no tocar', unidad: 'días', paso: 1, defecto: 7,
    ayuda: 'Días desde la creación o el último cambio antes de evaluar una entidad.' },
  { grupo: 'Confianza', clave: 'cadenciaAccionDias', label: 'Cadencia por entidad', unidad: 'días', paso: 1, defecto: 5,
    ayuda: 'No proponer otra acción sobre la misma entidad antes de estos días.' },

  { grupo: 'Escalado', clave: 'escaladoPct', label: 'Subida por paso', unidad: '%', paso: 1, defecto: 15,
    ayuda: 'Siempre bajo 20% (más es "edición significativa" y reinicia el aprendizaje).' },
  { grupo: 'Escalado', clave: 'escaladoCadenciaDias', label: 'Cada cuántos días', unidad: 'días', paso: 1, defecto: 4,
    ayuda: 'Mínimo entre dos escalados de la misma entidad. Rulebook: 3-4 días.' },
  { grupo: 'Escalado', clave: 'elasticidadMaxPct', label: 'Elasticidad máxima', unidad: '%', paso: 1, defecto: 20,
    ayuda: 'Si el CPA subió más que esto tras el último escalado, se sostiene en vez de volver a subir.' },

  { grupo: 'Frecuencia', clave: 'frecuenciaFrio', label: 'Frecuencia máx. (frío)', unidad: 'veces', paso: 0.5, defecto: 3,
    ayuda: 'Con frecuencia mayor y sin ventas se propone pausar.' },
  { grupo: 'Frecuencia', clave: 'frecuenciaRetargeting', label: 'Frecuencia máx. (retargeting)', unidad: 'veces', paso: 0.5, defecto: 5,
    ayuda: 'Igual que la anterior, para campañas de retargeting.' },

  { grupo: 'Testeo', clave: 'testeoCheckpointDias', label: 'Checkpoint temprano', unidad: 'días', paso: 1, defecto: 3,
    ayuda: 'Días corridos para evaluar un ad set de testeo (o el gasto de abajo, lo primero). Rulebook §6.1.' },
  { grupo: 'Testeo', clave: 'testeoCheckpointGastoPct', label: 'Checkpoint por gasto', unidad: '% CPA obj.', paso: 5, defecto: 40,
    ayuda: 'Porcentaje del CPA objetivo gastado que habilita el checkpoint (~220 UYU en KIT).' },
  { grupo: 'Testeo', clave: 'testeoImpresionesMin', label: 'Impresiones mínimas', unidad: 'imp.', paso: 50, defecto: 300,
    ayuda: 'Piso para confiar en el CTR del nivel temprano negativo.' },

  { grupo: 'Ingesta', clave: 'testeoPresupuesto', label: 'Presupuesto por VELn', unidad: '$/día', paso: 10, defecto: 120,
    ayuda: 'Presupuesto de cada ad set de testeo nuevo con la cuenta en banda verde. Rulebook §6.1.' },
  { grupo: 'Ingesta', clave: 'testeoAmarillaPct', label: 'Presupuesto en banda amarilla', unidad: '%', paso: 5, defecto: 50,
    ayuda: 'Con el CPA de cuenta entre objetivo y máximo, los ad sets nuevos arrancan con este % del presupuesto. En banda roja se crean pausados. Rulebook §6.4.' },
  { grupo: 'Ingesta', clave: 'ingestaTandasRecientes', label: 'Tandas a revisar', unidad: 'SICH', paso: 1, defecto: 4,
    ayuda: 'Cuántas de las carpetas SICH más nuevas se revisan buscando creativos sin ad set.' },
  { grupo: 'Ingesta', clave: 'driveCarpetaCreativos', label: 'Carpeta de Drive con las SICH', tipo: 'texto', defecto: '11acpqIAPzpIbuCxDs1ESdOjo_z5-70X8',
    ayuda: 'ID de "VelinneUy/Lucho". Hay que compartirla con la cuenta de servicio de Google.' },

  { grupo: 'Reportes', clave: 'stockBajo', label: 'Stock bajo', unidad: 'unidades', paso: 1, defecto: 10,
    ayuda: 'Una variante core con este stock o menos se marca como stock bajo; en 0, agotada. Rulebook §8.1.' },
  { grupo: 'Reportes', clave: 'conversionMinima', label: 'Piso de conversión del sitio', unidad: '%', paso: 0.1, defecto: 1,
    ayuda: 'Conversión general de Shopify (sesiones → compra) debajo de la cual se marca alerta. Rulebook §8.5.' },
  { grupo: 'Reportes', clave: 'lookalikeRatio', label: 'Lookalike sugerido', unidad: '%', paso: 1, defecto: 1,
    ayuda: 'Porcentaje del público similar que se propone crear sobre audiencias de engagement sanas. Rulebook §3.1 (1-3%).' },
  { grupo: 'Reportes', clave: 'semillaMinima', label: 'Tamaño mínimo de semilla', unidad: 'personas', paso: 100, defecto: 1000,
    ayuda: 'Audiencias de engagement más chicas no se proponen como base de un lookalike.' },
  { grupo: 'Reportes', clave: 'pixelId', label: 'Pixel / dataset', tipo: 'texto', defecto: '4070583316532508',
    ayuda: 'MOXI_UY: se mide su volumen de eventos semana contra semana. Rulebook §7.' },
  { grupo: 'Reportes', clave: 'productoCoreId', label: 'Producto principal (Shopify)', tipo: 'texto', defecto: '8341323513996',
    ayuda: '"Kit de inicio Velinne®": de acá salen las variantes core y su stock. Rulebook §8.1.' },

  { grupo: 'Graduación', clave: 'cadenciaAdsetDias', label: 'Cadencia por ad set destino', unidad: 'días', paso: 1, defecto: 4,
    ayuda: 'Agregar anuncios a un ad set reinicia su aprendizaje: una edición cada estos días. Rulebook §6.2.' },
  { grupo: 'Graduación', clave: 'cboPresupuestoInicial', label: 'Presupuesto CBO nueva', unidad: '$/día', paso: 100, defecto: 1200,
    ayuda: 'Presupuesto con el que nace una "CBO - PRE - SICH[n]" (queda pausada).' },
  { grupo: 'Graduación', clave: 'rtgAdsetIntencionId', label: 'Ad set retargeting intención alta', tipo: 'texto', defecto: '120252811638910401',
    ayuda: 'ID de "RTG - Carrito Abandonado + Pago Iniciado 7D". Destino "RTG-CarritoAbandonado-[nombre]".' },
  { grupo: 'Graduación', clave: 'rtgAdsetEngagementId', label: 'Ad set retargeting engagement', tipo: 'texto', defecto: '120249825494090401',
    ayuda: 'ID de "Vid +10 Seg - … (90 días) - Copia". Destino "RTG-[nombre]".' },

  { grupo: 'Nombres', clave: 'patronTesteo', label: 'Campañas de testeo contienen', tipo: 'texto', defecto: 'TESTEO',
    ayuda: 'Se identifican por nombre, nunca por ID.' },
  { grupo: 'Nombres', clave: 'patronRetargeting', label: 'Campañas de retargeting contienen', tipo: 'texto', defecto: 'Retargeting',
    ayuda: 'Aplican la frecuencia de retargeting y el piso de cobertura.' },
  { grupo: 'Nombres', clave: 'patronIntencionAlta', label: 'Audiencias de intención alta contienen', tipo: 'texto', defecto: 'carrito|checkout|pago iniciado',
    ayuda: 'Palabras (separadas por |) que marcan una audiencia de retargeting como intención alta.' },

  { grupo: 'Propuestas', clave: 'vigenciaHoras', label: 'Vigencia de una propuesta', unidad: 'horas', paso: 1, defecto: 24,
    ayuda: 'Pasado este tiempo vence y la próxima corrida la recalcula con datos frescos.' },
];

const DEFECTOS = Object.fromEntries(DEFINICIONES.map(d => [d.clave, d.defecto]));

function limpiarOfertas(lista) {
  if (!Array.isArray(lista)) return null;
  const ofertas = [];
  for (const o of lista.slice(0, 20)) {
    const tag = String(o?.tag || '').trim().toUpperCase();
    const cpaObjetivo = Number(o?.cpaObjetivo);
    const cpaMaximo = Number(o?.cpaMaximo);
    if (!/^[A-Z0-9+_-]{1,20}$/.test(tag) || !(cpaObjetivo > 0) || !(cpaMaximo > 0)) continue;
    ofertas.push({
      tag,
      nombre: String(o.nombre || tag).slice(0, 80),
      cpaObjetivo,
      cpaMaximo,
      link: String(o.link || '').slice(0, 300),
      defecto: Boolean(o.defecto),
    });
  }
  if (!ofertas.length) return null;
  if (!ofertas.some(o => o.defecto)) ofertas[0].defecto = true;
  return ofertas;
}

// Datos que completa una persona para archivos de Drive que no los traen en
// el nombre o la carpeta: ángulo (archivos sueltos) y VELn. { fileId: { angulo, veln } }
function limpiarAsignaciones(entrada) {
  if (!entrada || typeof entrada !== 'object' || Array.isArray(entrada)) return null;
  const limpias = {};
  for (const [id, a] of Object.entries(entrada).slice(0, 500)) {
    if (!/^[\w-]{10,100}$/.test(id) || !a || typeof a !== 'object') continue;
    const angulo = typeof a.angulo === 'string' ? a.angulo.trim().slice(0, 60) : '';
    const veln = typeof a.veln === 'string' && /^VEL\d{1,5}$/i.test(a.veln.trim()) ? a.veln.trim().toUpperCase() : '';
    if (angulo || veln) limpias[id] = { ...(angulo ? { angulo } : {}), ...(veln ? { veln } : {}) };
  }
  return limpias;
}

// Valida lo que llega del panel: sólo claves conocidas y tipos correctos.
function limpiarParametros(entrada) {
  const limpios = {};
  for (const d of DEFINICIONES) {
    const v = entrada?.[d.clave];
    if (d.tipo === 'texto') {
      if (typeof v === 'string' && v.trim() && v.length <= 200) limpios[d.clave] = v.trim();
    } else if (typeof v === 'number' && Number.isFinite(v) && v >= 0) {
      limpios[d.clave] = v;
    }
  }
  if (limpios.escaladoPct > 18) limpios.escaladoPct = 18; // Rulebook: siempre bajo 20%
  const ofertas = limpiarOfertas(entrada?.ofertas);
  if (ofertas) limpios.ofertas = ofertas;
  const asignaciones = limpiarAsignaciones(entrada?.asignaciones);
  if (asignaciones) limpios.asignaciones = asignaciones;
  return limpios;
}

function completar(guardados) {
  const p = { ...DEFECTOS, ...limpiarParametros(guardados || {}) };
  p.ofertas = limpiarOfertas(guardados?.ofertas) || OFERTAS_DEFECTO;
  p.asignaciones = limpiarAsignaciones(guardados?.asignaciones) || {};
  return p;
}

// Oferta de una entidad según los tags en el nombre de su campaña / ad set.
// Sin tag = la oferta marcada por defecto (KIT). Distingue mayúsculas: el tag
// va en mayúsculas ("... - STUDIO"), así "COS - Anti - Studio - KIT" (Studio
// como parte del ángulo) sigue siendo KIT.
function ofertaDe(nombres, ofertas) {
  const texto = nombres.filter(Boolean).join(' ');
  const porLargo = [...ofertas].sort((a, b) => b.tag.length - a.tag.length);
  for (const o of porLargo) {
    const re = new RegExp(`(^|[^A-Z0-9+])${o.tag.replace(/[+]/g, '\\+')}([^A-Z0-9+]|$)`);
    if (re.test(texto)) return o;
  }
  return ofertas.find(o => o.defecto) || ofertas[0];
}

module.exports = { DEFINICIONES, OFERTAS_DEFECTO, DEFECTOS, completar, limpiarParametros, ofertaDe };

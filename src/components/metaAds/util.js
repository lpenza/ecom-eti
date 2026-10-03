// Formatos y textos compartidos por las pantallas de Meta Ads.

const TZ = 'America/Montevideo';

export const fmtNum = (n, dec = 0) => (n == null || !Number.isFinite(Number(n))
  ? '—'
  : Number(n).toLocaleString('es-UY', { maximumFractionDigits: dec, minimumFractionDigits: dec }));

export const fmtPlata = (n) => (n == null || !Number.isFinite(Number(n)) ? '—' : fmtNum(n, Number(n) >= 100 ? 0 : 2));

export function fmtHora(iso) {
  if (!iso) return '';
  return new Intl.DateTimeFormat('es-UY', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
}

export function fmtFecha(iso, opciones = { day: 'numeric', month: 'short' }) {
  if (!iso) return '';
  return new Intl.DateTimeFormat('es-UY', { timeZone: TZ, hourCycle: 'h23', ...opciones }).format(new Date(iso));
}

export function diaClave(iso) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
}

export function hoyLargo() {
  const s = new Intl.DateTimeFormat('es-UY', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long' }).format(new Date());
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// "hace 3 h", "hace 2 días"
export function hace(iso) {
  if (!iso) return '';
  const min = (Date.now() - new Date(iso).getTime()) / 60000;
  if (min < 1) return 'recién';
  if (min < 60) return `hace ${Math.round(min)} min`;
  const h = min / 60;
  if (h < 24) return `hace ${Math.round(h)} h`;
  const d = h / 24;
  return `hace ${Math.round(d)} ${Math.round(d) === 1 ? 'día' : 'días'}`;
}

// Días esperando una decisión (para marcar en rojo lo que lleva >14, como
// hacía velinne-dashboard-maintenance).
export const diasEsperando = (iso) => (iso ? Math.floor((Date.now() - new Date(iso).getTime()) / 86400000) : 0);

export const TIPOS = {
  pausa: { label: 'Pausa', icono: '⏸' },
  escalado: { label: 'Presupuesto · Escalado', icono: '↗' },
  graduacion: { label: 'Graduación', icono: '🎓' },
  duplicado_rtg: { label: 'Graduación · Retargeting', icono: '↻' },
  crear_cbo: { label: 'Graduación · CBO nueva', icono: '＋' },
  reencender: { label: 'Reencendido', icono: '▶' },
  ingesta_tanda: { label: 'Tanda · Testeo', icono: '＋' },
  crear_lookalike: { label: 'Audiencia · Lookalike', icono: '◎' },
  crear_sich: { label: 'Creativos · Nueva tanda SICH', icono: '▣' },
  aprobar_idea: { label: 'Creativos · Idea especulativa', icono: '🧪' },
  enmienda: { label: 'Rulebook · Enmienda', icono: '§' },
  ajuste_parametro: { label: 'Rulebook · Parámetro', icono: '⚙' },
};

export const ESTADOS_PROPUESTA = {
  pendiente: { label: 'Pendiente', clase: 'accent' },
  aprobada: { label: 'Ejecutando', clase: 'accent' },
  ejecutada: { label: 'Ejecutada', clase: 'good' },
  fallida: { label: 'Falló', clase: 'bad' },
  rechazada: { label: 'Rechazada', clase: '' },
  desactualizada: { label: 'Desactualizada', clase: 'warn' },
  vencida: { label: 'Ya no aplica', clase: '' },
};

export const ESTADOS_ENTIDAD = {
  ACTIVE: { label: 'Activa', clase: 'good' },
  PAUSED: { label: 'Pausada', clase: '' },
  CAMPAIGN_PAUSED: { label: 'Campaña pausada', clase: '' },
  ADSET_PAUSED: { label: 'Ad set pausado', clase: '' },
  IN_PROCESS: { label: 'Procesando', clase: 'accent' },
  WITH_ISSUES: { label: 'Con problemas', clase: 'warn' },
  PENDING_REVIEW: { label: 'En revisión', clase: 'accent' },
  PREAPPROVED: { label: 'Preaprobado', clase: 'accent' },
  DISAPPROVED: { label: 'Rechazado', clase: 'bad' },
  PENDING_BILLING_INFO: { label: 'Falta facturación', clase: 'bad' },
};

export const JOBS_INFO = {
  pausa_escalado: {
    descripcion: 'Evalúa pausas (CPA, ROAS, frecuencia, sin ventas), el nivel temprano negativo de testeo y escalados de presupuesto, con la ventana de no tocar, las 2 lecturas, la cadencia y el piso de cobertura de retargeting.',
    reemplaza: 'velinne-ads-daily-check',
    reglas: 'Rulebook §2, §3, §6.1',
  },
  ingesta: {
    descripcion: 'Revisa las carpetas SICH más nuevas de Drive, detecta imágenes y videos VELn que todavía no tienen ad set y propone crearlos en "TESTEO - SICH n" para el sábado 05:00, con el presupuesto que marque el gate de CPA de cuenta (verde, amarilla o roja). Al aprobar sube los archivos a Meta si hace falta.',
    reemplaza: 'velinne-ads-creative-ingest',
    reglas: 'Rulebook §6.1, §6.4',
  },
  ganadores: {
    descripcion: 'Busca entidades que fueron ganadoras en los últimos 90 días y cayeron (pausadas o fuera de rango), y diagnostica la causa: stock de variantes core, medición del pixel, estacionalidad del tramo del mes, fatiga y cambios recientes. Si la causa es clara y ya pasó, propone reencender al mismo presupuesto.',
    reemplaza: 'velinne-winner-decline-audit',
    reglas: 'Rulebook §6.6',
  },
  auditoria: {
    descripcion: 'Revisa las pausas y escalados de hace 7 a 21 días y los clasifica en acertada, cuestionable o contraproducente, comparando la entidad, su conjunto y la cuenta antes y después. Detecta patrones que se repiten como candidatos a ajustar una regla.',
    reemplaza: 'velinne-ads-decision-audit',
    reglas: 'Rulebook §8.6',
  },
  reporte: {
    descripcion: 'Arma el resumen semanal: pendientes, salud del pixel, performance contra la semana anterior, funnel de Shopify, stock de variantes core, audiencias (propone lookalikes), testeo y elasticidad de escalados. El brief creativo con IA queda para la Fase 4.',
    reemplaza: 'velinne-ads-weekly-digest',
    reglas: 'Rulebook §3.1, §8.1, §8.5',
  },
  brief: {
    descripcion: 'Con Claude: analiza enganche (CTR, hook de video, % visto) contra conversión por ángulo, decide qué ángulos necesitan creativo nuevo, propone ideas especulativas si ninguno califica y redacta el brief para el editor sin costos. Propone crear la carpeta SICH siguiente en Drive con un documento de hipótesis por ángulo.',
    reemplaza: 'velinne-ads-weekly-digest (brief y carpetas SICH)',
    reglas: 'Rulebook §8.4',
  },
  mensual: {
    descripcion: 'Con Claude y búsqueda web: compara el mes contra el anterior, revisa novedades de Felipe Vergara, Caro Dubi y las marcas de referencia, calibra la elasticidad de escalado y propone ajustes de parámetros para aprobar.',
    reemplaza: 'velinne-ads-monthly-strategic',
    reglas: 'Rulebook §8',
  },
  politicas: {
    descripcion: 'Con Claude y búsqueda web: revisa las novedades de producto y política de Meta de las últimas 2 semanas y propone enmiendas cuando una afecta una regla vigente. Nada se cambia sin aprobación.',
    reemplaza: 'velinne-meta-policy-check',
    reglas: 'Rulebook §5',
  },
  graduacion: {
    descripcion: 'Detecta ganadores confirmados de testeo y propone graduarlos a la CBO de su tanda SICH (o crearla, pausada) y duplicarlos a los 2 ad sets de retargeting, respetando la cadencia por ad set destino.',
    reemplaza: 'velinne-ads-auto-graduate',
    reglas: 'Rulebook §6.2',
  },
};

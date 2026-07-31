// Utilidades de fecha/hora para mostrar siempre en horario de Uruguay.
//
// Varias columnas de Supabase son `timestamp` (sin zona) pero se escriben con
// `new Date().toISOString()`, o sea que el valor guardado es UTC aunque el string
// vuelva sin la "Z". Si se parsea tal cual, el navegador lo toma como hora local
// y la hora sale corrida. Estas funciones normalizan eso antes de formatear.
//
// Usar SIEMPRE estos helpers en vez de `new Date(x).toLocaleString(...)` suelto.

export const TZ_UY = 'America/Montevideo';

const RE_ZONA       = /([zZ]|[+-]\d{2}:?\d{2})$/;
const RE_FECHA_SOLA = /^\d{4}-\d{2}-\d{2}$/;

// Parsea un timestamp a milisegundos forzando UTC cuando el string no trae zona.
// Las fechas sin hora ("2026-07-23") se anclan al mediodía UTC: así ninguna
// conversión de zona las corre al día anterior o siguiente.
export function parseTimestampUtc(value) {
  if (!value) return NaN;
  if (value instanceof Date) return value.getTime();
  const s = String(value).trim();
  if (RE_FECHA_SOLA.test(s)) return new Date(`${s}T12:00:00Z`).getTime();
  const conT = s.replace(' ', 'T');
  return new Date(RE_ZONA.test(s) ? conT : `${conT}Z`).getTime();
}

// Date ya normalizado, listo para formatear con timeZone. null si no es válido.
export function toDateUy(value) {
  const t = parseTimestampUtc(value);
  return Number.isFinite(t) ? new Date(t) : null;
}

// Año calendario en Uruguay (no el del navegador).
export function anioUy(date = new Date()) {
  return Number(
    new Intl.DateTimeFormat('en-CA', { timeZone: TZ_UY, year: 'numeric' }).format(date)
  );
}

// Formateo genérico en zona uruguaya. `fallback` es lo que se muestra si no hay dato.
export function formatUy(value, opts = {}, fallback = '—') {
  const d = toDateUy(value);
  if (!d) return fallback;
  return d.toLocaleString('es-UY', { timeZone: TZ_UY, ...opts });
}

// ── Presets ──────────────────────────────────────────────────────────────────

// 23/07, 20:37 — el año aparece sólo si no es el actual (para tablas angostas).
export function formatFechaHoraUy(value, fallback = '—') {
  const d = toDateUy(value);
  if (!d) return fallback;
  const opts = { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' };
  if (anioUy(d) !== anioUy()) opts.year = '2-digit';
  return formatUy(d, opts, fallback);
}

// 23/07/2026, 20:37
export function formatFechaHoraCompletaUy(value, fallback = '—') {
  return formatUy(value, {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  }, fallback);
}

// 23/07/2026
export function formatFechaUy(value, fallback = '—') {
  return formatUy(value, { day: '2-digit', month: '2-digit', year: 'numeric' }, fallback);
}

// 23/07/26
export function formatFechaCortaUy(value, fallback = '—') {
  return formatUy(value, { day: '2-digit', month: '2-digit', year: '2-digit' }, fallback);
}

// 23 jul — etiquetas de eje en gráficos, sin año.
export function formatDiaMesUy(value, fallback = '—') {
  return formatUy(value, { day: '2-digit', month: 'short' }, fallback);
}

// jueves, 23 de julio de 2026 — encabezados.
export function formatFechaLargaUy(value = new Date(), fallback = '—') {
  return formatUy(value, {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  }, fallback);
}

// "hace 2d 5h" / "hace 30m" a partir de un timestamp.
export function tiempoRelativoUy(value, fallback = '—') {
  const t = parseTimestampUtc(value);
  if (!Number.isFinite(t)) return fallback;
  const min  = Math.floor((Date.now() - t) / 60000);
  const hrs  = Math.floor(min / 60);
  const dias = Math.floor(hrs / 24);
  if (dias > 0) return `hace ${dias}d ${hrs % 24}h`;
  if (hrs > 0)  return `hace ${hrs}h ${min % 60}m`;
  return `hace ${min}m`;
}

// Fecha de hoy en Uruguay como "YYYY-MM-DD" (para inputs date y filtros).
export function hoyIsoUy() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ_UY, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

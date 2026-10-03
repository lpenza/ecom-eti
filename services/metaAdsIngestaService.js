// Ingesta de creativos de las carpetas "SICH n" de Drive (reemplaza a la tarea
// velinne-ads-creative-ingest, Rulebook §6.1 y §6.4).
//
// Calcula en vivo, sin registro propio, el estado de cada archivo de las
// tandas más nuevas cruzando Drive con los anuncios que ya existen en Meta:
//   creado       ya hay un anuncio VELn en una campaña de testeo
//   listo        tiene VELn, ángulo y campaña "TESTEO - SICH n": se puede crear
//   sin_campania falta crear la campaña "TESTEO - SICH n" (la crea el admin)
//   sin_veln     el nombre no trae VELn y nadie lo asignó
//   sin_angulo   archivo suelto (sin subcarpeta "A. ÁNGULO") y nadie lo asignó
// El job de ingesta convierte los "listo" de cada tanda en una propuesta.

const { google } = require('googleapis');
const meta = require('./metaAdsService');
const { ofertaDe } = require('./metaAdsParametros');

const TZ = 'America/Montevideo';
const FOLDER = 'application/vnd.google-apps.folder';

let driveCache = null;
let authCache = null;
function drive() {
  if (driveCache) return driveCache;
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!raw) throw new Error('Falta GOOGLE_SERVICE_ACCOUNT_KEY para leer Drive');
  let credenciales;
  try { credenciales = JSON.parse(raw); } catch { credenciales = JSON.parse(JSON.parse(raw)); }
  if (typeof credenciales === 'string') credenciales = JSON.parse(credenciales);
  authCache = new google.auth.GoogleAuth({ credentials: credenciales, scopes: ['https://www.googleapis.com/auth/drive.readonly'] });
  driveCache = google.drive({ version: 'v3', auth: authCache });
  return driveCache;
}

async function hijos(carpetaId) {
  const archivos = [];
  let pageToken;
  do {
    const r = await drive().files.list({
      q: `'${carpetaId}' in parents and trashed=false`,
      fields: 'nextPageToken, files(id,name,mimeType,modifiedTime,size,thumbnailLink)',
      pageSize: 200, pageToken, supportsAllDrives: true, includeItemsFromAllDrives: true,
    });
    archivos.push(...(r.data.files || []));
    pageToken = r.data.nextPageToken;
  } while (pageToken);
  return archivos;
}

const numeroSich = (nombre) => { const m = /SICH\s*-?\s*(\d+)/i.exec(nombre || ''); return m ? Number(m[1]) : null; };
const velDe = (nombre) => { const m = /VEL\s*-?\s*(\d{1,5})/i.exec(nombre || ''); return m ? `VEL${Number(m[1])}` : null; };
// "VEL33" no debe coincidir con "VEL330".
const reVel = (veln) => new RegExp(`(^|[^A-Z0-9])${veln}(?!\\d)`, 'i');

function anguloDeCarpeta(nombre) {
  const m = /^A\.\s*(.+)$/i.exec((nombre || '').trim());
  if (!m) return null;
  // "A. MALA EXPERIENCIA SALON" → "Mala Experiencia Salon" (como en los ad sets existentes).
  return m[1].trim().toLowerCase().replace(/(^|[\s-])(\p{L})/gu, (_, sep, l) => sep + l.toUpperCase());
}

function fechaUy(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

// Sábado siguiente a hoy, 05:00 de Uruguay (Rulebook §6.1: la tanda del viernes
// arranca el sábado 5am; se programa con el start_time del ad set).
function proximoSabado5am(desde = new Date()) {
  const hoy = fechaUy(desde);
  const d = new Date(`${hoy}T12:00:00Z`);
  const dow = d.getUTCDay(); // 0 domingo … 6 sábado
  d.setUTCDate(d.getUTCDate() + (((6 - dow + 7) % 7) || 7));
  return `${d.toISOString().slice(0, 10)}T05:00:00-03:00`;
}

// ── gate de CPA de cuenta (§6.4) ─────────────────────────────────────────────

async function calcularGate(cuenta, p) {
  const hoy = fechaUy();
  const d = (n) => { const x = new Date(`${hoy}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
  const rango = { since: d(-7), until: d(-1) };
  const [total, porCampania] = await Promise.all([
    meta.insightsCuenta(cuenta, rango),
    meta.insightsPorNivel(cuenta, 'campaign', rango),
  ]);
  let gasto = 0; let obj = 0; let max = 0;
  for (const m of porCampania.values()) {
    const o = ofertaDe([m.nombres.campania], p.ofertas);
    gasto += m.gasto; obj += m.gasto * o.cpaObjetivo; max += m.gasto * o.cpaMaximo;
  }
  const defecto = p.ofertas.find(o => o.defecto) || p.ofertas[0];
  const objetivo = gasto > 0 ? obj / gasto : defecto.cpaObjetivo;
  const maximo = gasto > 0 ? max / gasto : defecto.cpaMaximo;
  const cpa = total?.cpa ?? null;
  const banda = cpa == null || cpa <= objetivo ? 'verde' : cpa <= maximo ? 'amarilla' : 'roja';
  const presupuesto = banda === 'amarilla' ? Math.round(p.testeoPresupuesto * p.testeoAmarillaPct / 100) : p.testeoPresupuesto;
  return { banda, cpa, objetivo, maximo, presupuesto, activar: banda !== 'roja', ventana: rango };
}

// ── tandas ───────────────────────────────────────────────────────────────────

let cacheTandas = null; // { en, clave, datos }
const CACHE_MS = 2 * 60 * 1000;

async function listarTandas(cuenta, p, { fresco = false } = {}) {
  const clave = JSON.stringify([cuenta, p.driveCarpetaCreativos, p.ingestaTandasRecientes, p.asignaciones]);
  if (!fresco && cacheTandas?.clave === clave && Date.now() - cacheTandas.en < CACHE_MS) return cacheTandas.datos;

  const raiz = await hijos(p.driveCarpetaCreativos);
  const carpetas = raiz
    .filter(f => f.mimeType === FOLDER && numeroSich(f.name) != null)
    .map(f => ({ ...f, sich: numeroSich(f.name) }))
    .sort((a, b) => b.sich - a.sich)
    .slice(0, Math.max(1, p.ingestaTandasRecientes));

  // Campañas de testeo y anuncios VEL ya existentes: dos consultas para todo.
  const [testeo, anunciosVel] = await Promise.all([
    meta.buscarCampaniasPorNombre(cuenta, p.patronTesteo),
    meta.buscarAnunciosPorNombre(cuenta, 'VEL'),
  ]);
  // Un VELn ya usado en cualquier campaña (testeo, evento, CBO…) no se vuelve a
  // crear; si está en varias, se muestra primero la de testeo.
  const esTesteo = (a) => new RegExp(p.patronTesteo, 'i').test(a.campaniaNombre || '');
  const anunciosOrdenados = [...anunciosVel].sort((a, b) => esTesteo(b) - esTesteo(a));

  const tandas = [];
  for (const c of carpetas) {
    const campania = testeo.find(t => new RegExp(`SICH\\s*-?\\s*${c.sich}(?!\\d)`, 'i').test(t.nombre)) || null;
    const archivos = [];
    const recorrer = async (carpetaId, angulo) => {
      for (const f of await hijos(carpetaId)) {
        if (f.mimeType === FOLDER) {
          const a = anguloDeCarpeta(f.name);
          if (a) await recorrer(f.id, a);
          continue;
        }
        if (!/^(image|video)\//.test(f.mimeType)) continue; // guiones, hipótesis, etc.
        archivos.push({ ...f, anguloCarpeta: angulo });
      }
    };
    await recorrer(c.id, null);

    const items = archivos.map(f => {
      const asignado = p.asignaciones?.[f.id] || {};
      const veln = velDe(f.name) || asignado.veln || null;
      const angulo = f.anguloCarpeta || asignado.angulo || null;
      const anuncio = veln ? anunciosOrdenados.find(a => reVel(veln).test(a.nombre)) : null;
      let estado;
      if (anuncio) estado = 'creado';
      else if (!veln) estado = 'sin_veln';
      else if (!angulo) estado = 'sin_angulo';
      else if (!campania) estado = 'sin_campania';
      else estado = 'listo';
      return {
        fileId: f.id, archivo: f.name, mime: f.mimeType, tipo: f.mimeType.startsWith('video/') ? 'video' : 'imagen',
        tamanio: f.size ? Number(f.size) : null, modificado: f.modifiedTime,
        veln, velnAsignado: !velDe(f.name) && Boolean(asignado.veln),
        angulo, anguloAsignado: !f.anguloCarpeta && Boolean(asignado.angulo),
        estado,
        anuncio: anuncio ? { id: anuncio.id, nombre: anuncio.nombre, estadoEfectivo: anuncio.estadoEfectivo, conjuntoId: anuncio.conjuntoId, conjuntoNombre: anuncio.conjuntoNombre, campaniaNombre: anuncio.campaniaNombre, enTesteo: esTesteo(anuncio) } : null,
      };
    }).sort((a, b) => (a.veln || 'zzz').localeCompare(b.veln || 'zzz', 'es', { numeric: true }));

    tandas.push({
      sich: c.sich, carpeta: c.name, carpetaId: c.id, modificada: c.modifiedTime,
      campania: campania ? { id: campania.id, nombre: campania.nombre, estadoEfectivo: campania.estadoEfectivo } : null,
      items,
      conteo: items.reduce((acc, i) => ({ ...acc, [i.estado]: (acc[i.estado] || 0) + 1 }), {}),
    });
  }
  cacheTandas = { en: Date.now(), clave, datos: tandas };
  return tandas;
}

function invalidarCache() { cacheTandas = null; }

// Descarga el archivo de Drive (para subirlo a la biblioteca de Meta).
async function descargar(fileId) {
  const r = await drive().files.get({ fileId, alt: 'media', supportsAllDrives: true }, { responseType: 'arraybuffer' });
  return Buffer.from(r.data);
}

// Miniatura de Drive (la sirve el backend: el link de Drive pide autenticación).
async function miniatura(fileId) {
  const f = await drive().files.get({ fileId, fields: 'thumbnailLink', supportsAllDrives: true });
  if (!f.data.thumbnailLink) return null;
  const cliente = await authCache.getClient();
  const r = await cliente.request({ url: f.data.thumbnailLink.replace(/=s\d+$/, '=s400'), responseType: 'arraybuffer' });
  return { buffer: Buffer.from(r.data), tipo: r.headers['content-type'] || 'image/jpeg' };
}

// Ángulos ya trabajados en las últimas tandas (subcarpetas "A. ÁNGULO") y el
// número de la próxima SICH. Lo usa el brief para no repetir ideas.
async function angulosPorSich(p, cuantas = 12) {
  const raiz = await hijos(p.driveCarpetaCreativos);
  const carpetas = raiz.filter(f => f.mimeType === FOLDER && numeroSich(f.name) != null)
    .map(f => ({ ...f, sich: numeroSich(f.name) }))
    .sort((a, b) => b.sich - a.sich);
  const tandas = [];
  for (const c of carpetas.slice(0, cuantas)) {
    const subs = (await hijos(c.id)).filter(f => f.mimeType === FOLDER).map(f => anguloDeCarpeta(f.name)).filter(Boolean);
    tandas.push({ sich: c.sich, angulos: subs });
  }
  return { tandas, proxima: (carpetas[0]?.sich || 0) + 1 };
}

// Escritura en Drive (crear la carpeta de la próxima SICH). Usa un cliente con
// permiso de escritura; la cuenta de servicio tiene que ser Editor de la carpeta.
let driveEscrituraCache = null;
function driveEscritura() {
  if (driveEscrituraCache) return driveEscrituraCache;
  drive(); // valida y parsea las credenciales
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  let credenciales;
  try { credenciales = JSON.parse(raw); } catch { credenciales = JSON.parse(JSON.parse(raw)); }
  if (typeof credenciales === 'string') credenciales = JSON.parse(credenciales);
  const auth = new google.auth.GoogleAuth({ credentials: credenciales, scopes: ['https://www.googleapis.com/auth/drive'] });
  driveEscrituraCache = google.drive({ version: 'v3', auth });
  return driveEscrituraCache;
}

// Crea "SICH n" con una subcarpeta "A. ÁNGULO" por ángulo y un Google Doc
// "Hipótesis" adentro de cada una (Rulebook §8.4). Devuelve los links.
async function crearCarpetaSich(p, { angulos }) {
  const { proxima } = await angulosPorSich(p, 1); // número real al momento de crear
  const d = driveEscritura();
  const crear = async (nombre, padre, mimeType = FOLDER, contenido = null) => (await d.files.create({
    requestBody: { name: nombre, mimeType, parents: [padre] },
    ...(contenido ? { media: { mimeType: 'text/plain', body: contenido } } : {}),
    fields: 'id,webViewLink',
    supportsAllDrives: true,
  })).data;
  const sich = await crear(`SICH ${proxima}`, p.driveCarpetaCreativos);
  const creadas = [];
  for (const a of angulos) {
    const carpeta = await crear(`A. ${a.angulo.toUpperCase()}`, sich.id);
    const texto = [
      a.angulo.toUpperCase(),
      '',
      `Estado: ${a.estado === 'confirmada' ? '✅ Confirmada por datos' : '🧪 Especulativa — aprobada en el panel'}`,
      '',
      'Qué probar:',
      a.hipotesis,
      '',
      a.razon ? `Por qué:\n${a.razon}` : '',
      a.fuente ? `\nReferencia: ${a.fuente}` : '',
    ].join('\n');
    const doc = await crear('Hipótesis', carpeta.id, 'application/vnd.google-apps.document', texto);
    creadas.push({ angulo: a.angulo, carpeta: carpeta.webViewLink, documento: doc.webViewLink });
  }
  return { numero: proxima, link: sich.webViewLink, angulos: creadas };
}

module.exports = { angulosPorSich, crearCarpetaSich, listarTandas, calcularGate, proximoSabado5am, descargar, miniatura, invalidarCache, velDe, reVel };

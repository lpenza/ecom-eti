// Parser de los Excel de facturación que mandan los couriers.
//
// Cada proveedor manda un layout distinto y ninguno de los dos es estable:
//   - MarcoPostal: hoja única, encabezado en la fila 1, 76 columnas, y la ÚLTIMA fila
//     es un total (sólo trae "Importe", sin "Nro Guia").
//   - UES: hoja "Detalle1" con un título en la fila 1, una fila vacía y el encabezado
//     recién en la fila 3. No trae ninguna columna de importe: se valoriza por tarifa.
//
// Por eso nunca se mapea por índice de columna ni se asume en qué fila está el
// encabezado: se busca la primera fila que contenga las columnas clave y de ahí en
// adelante se lee todo por nombre.

const ExcelJS = require('exceljs');

// Uruguay no tiene horario de verano desde 2015, así que el offset es fijo. Las fechas
// de estos archivos vienen en hora local uruguaya (a diferencia de los timestamps de
// Supabase, que son UTC — por eso acá NO sirve el helper parseTimestampUtc del front).
const OFFSET_UY = '-03:00';

const PROVEEDORES = {
  MARCOPOSTAL: 'marcopostal',
  UES: 'ues',
};

// Columnas que identifican a cada proveedor (en minúsculas, sin tildes).
const FIRMA_MARCOPOSTAL = ['nro guia', 'importe'];
const FIRMA_UES = ['guia', 'referencia', 'fecha creacion'];

// ── Helpers de normalización ─────────────────────────────────────────────────────

// Minúsculas sin tildes y con espacios colapsados. Se usa tanto para encabezados como
// para nombres de servicio, porque los archivos traen "E-COMMERCE DÍA" con tilde y a
// veces con la codificación rota.
function normalizarTexto(valor) {
  if (valor === null || valor === undefined) return '';
  return String(valor)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

// ExcelJS devuelve objetos para celdas con fórmula, hipervínculo o texto enriquecido.
function valorCelda(cell) {
  if (!cell) return null;
  const v = cell.value;
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v;
  if (typeof v === 'object') {
    if (v.result !== undefined) return v.result;   // fórmula
    if (v.text !== undefined) return v.text;       // hipervínculo
    if (Array.isArray(v.richText)) return v.richText.map((t) => t.text).join('');
    return null;
  }
  return v;
}

function textoLimpio(valor) {
  if (valor === null || valor === undefined) return null;
  const s = String(valor).trim();
  return s === '' ? null : s;
}

function aNumero(valor) {
  if (valor === null || valor === undefined || valor === '') return null;
  if (typeof valor === 'number') return Number.isFinite(valor) ? valor : null;
  // Los archivos pueden traer "1.234,56" o "1234.56" según cómo lo exporten.
  const s = String(valor).trim().replace(/\s/g, '');
  const limpio = s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : s;
  const n = Number(limpio);
  return Number.isFinite(n) ? n : null;
}

// Redondeo a 2 decimales evitando el clásico 1.005 → 1.00 de coma flotante.
function redondear2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

// Fechas: los .xlsx guardan las fechas como Date en UTC, pero el valor que quiso
// escribir el courier es hora local uruguaya. Se reconstruye el instante correcto
// tomando los componentes UTC y anclándolos al offset de Uruguay.
function fechaDesdeExcel(valor) {
  if (valor === null || valor === undefined || valor === '') return null;

  if (valor instanceof Date) {
    if (Number.isNaN(valor.getTime())) return null;
    const iso = valor.toISOString().slice(0, 19); // YYYY-MM-DDTHH:mm:ss
    return new Date(`${iso}${OFFSET_UY}`);
  }

  // MarcoPostal exporta las fechas como texto: "2026-06-26 09:21:51".
  const s = String(valor).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (m) {
    const [, y, mes, d, hh = '00', mm = '00', ss = '00'] = m;
    return new Date(`${y}-${mes}-${d}T${hh}:${mm}:${ss}${OFFSET_UY}`);
  }
  // Formato DD/MM/YYYY por si alguna exportación cambia.
  m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (m) {
    const [, d, mes, y, hh = '00', mm = '00', ss = '00'] = m;
    return new Date(`${y}-${mes}-${d}T${hh}:${mm}:${ss}${OFFSET_UY}`);
  }
  return null;
}

// Número de orden: los archivos traen 2535, "#2706", " 2849 " y, en un caso real de
// MarcoPostal, texto libre ("retirar en dirección de entrega para dejar en pickup").
// UES además pisa la referencia con el comentario compuesto que arma
// construirComentarioEtiqueta() en uesService: "2898 | Casa" → hay que quedarse con la
// parte anterior al separador.
// Sólo se acepta lo que parece un número de pedido o un reenvío RCL-xxxx.
function normalizarOrden(valor) {
  const s = textoLimpio(valor);
  if (!s) return null;
  const sinNumeral = s.split('|')[0].replace(/^#+/, '').trim();
  if (/^\d{1,10}$/.test(sinNumeral)) return sinNumeral;
  const rcl = sinNumeral.match(/^(RCL|COL)-?(\d{1,10}(?:-\d+)?)$/i);
  if (rcl) return `${rcl[1].toUpperCase()}-${rcl[2]}`;
  return null;
}

// "Zona 6 ML" → 6. Devuelve null si la zona no viene o no tiene número.
function numeroZona(valor) {
  const s = textoLimpio(valor);
  if (!s) return null;
  const m = s.match(/(\d+)/);
  return m ? Number(m[1]) : null;
}

// ── Lectura genérica de la hoja ──────────────────────────────────────────────────

// Busca la fila de encabezado (dentro de las primeras filas) que contenga todas las
// columnas de `firma` y devuelve el mapa nombreNormalizado → número de columna.
function buscarEncabezado(worksheet, firma, maxFilas = 15) {
  const limite = Math.min(worksheet.rowCount, maxFilas);
  for (let fila = 1; fila <= limite; fila += 1) {
    const row = worksheet.getRow(fila);
    const mapa = {};
    row.eachCell({ includeEmpty: false }, (cell, col) => {
      const nombre = normalizarTexto(valorCelda(cell));
      if (nombre && !(nombre in mapa)) mapa[nombre] = col;
    });
    if (firma.every((c) => c in mapa)) return { fila, mapa };
  }
  return null;
}

// Detecta a qué proveedor pertenece el archivo recorriendo todas las hojas.
function detectarProveedor(workbook) {
  for (const ws of workbook.worksheets) {
    const mp = buscarEncabezado(ws, FIRMA_MARCOPOSTAL);
    if (mp) return { proveedor: PROVEEDORES.MARCOPOSTAL, worksheet: ws, encabezado: mp };
    const ues = buscarEncabezado(ws, FIRMA_UES);
    if (ues) return { proveedor: PROVEEDORES.UES, worksheet: ws, encabezado: ues };
  }
  return null;
}

// ── Parsers por proveedor ────────────────────────────────────────────────────────

function parseMarcoPostal(worksheet, encabezado, config) {
  const { mapa, fila: filaEncabezado } = encabezado;
  const leer = (row, nombre) => (mapa[nombre] ? valorCelda(row.getCell(mapa[nombre])) : null);

  const lineas = [];
  let totalDeclarado = null;

  for (let fila = filaEncabezado + 1; fila <= worksheet.rowCount; fila += 1) {
    const row = worksheet.getRow(fila);
    const guia = textoLimpio(leer(row, 'nro guia'));
    const importe = aNumero(leer(row, 'importe'));

    // La última fila del archivo es el total: trae importe pero no número de guía.
    if (!guia) {
      if (importe !== null) totalDeclarado = importe;
      continue;
    }

    const zona = textoLimpio(leer(row, 'zona destino'));
    const servicio = textoLimpio(leer(row, 'servicio'));
    const neto = importe === null ? 0 : importe;

    lineas.push({
      guia,
      orden: normalizarOrden(leer(row, 'obs 1')),
      fecha: fechaDesdeExcel(leer(row, 'fecha')),
      servicio,
      servicioNormalizado: normalizarTexto(servicio),
      estado: textoLimpio(leer(row, 'estado')),
      destinatario: textoLimpio(leer(row, 'destinatario')),
      localidad: textoLimpio(leer(row, 'localidad')),
      departamento: textoLimpio(leer(row, 'provincia')),
      zona,
      categoriaZona: clasificarZona(zona, config.zonasExtendidas),
      peso: aNumero(leer(row, 'peso')),
      importeNeto: neto,
      importeOrigen: 'archivo',
      importeArchivo: importe,
      filaExcel: fila,
      raw: {
        cp: textoLimpio(leer(row, 'cp')),
        obs1: textoLimpio(leer(row, 'obs 1')),
        codigoCliente: textoLimpio(leer(row, 'codigo cliente')),
        fechaUltimoEstado: textoLimpio(leer(row, 'fecha ultimo estado')),
      },
    });
  }

  return { lineas, totalDeclarado };
}

function parseUes(worksheet, encabezado, config) {
  const { mapa, fila: filaEncabezado } = encabezado;
  const leer = (row, nombre) => (mapa[nombre] ? valorCelda(row.getCell(mapa[nombre])) : null);

  const lineas = [];

  for (let fila = filaEncabezado + 1; fila <= worksheet.rowCount; fila += 1) {
    const row = worksheet.getRow(fila);
    const guia = textoLimpio(leer(row, 'guia'));
    if (!guia) continue;

    const servicio = textoLimpio(leer(row, 'servicio'));
    // La referencia es el número de pedido; si viene rota, el comentario de la guía
    // trae el mismo dato (UES lo copia ahí).
    const orden = normalizarOrden(leer(row, 'referencia'))
      || normalizarOrden(leer(row, 'comentario guia'));

    lineas.push({
      guia,
      orden,
      fecha: fechaDesdeExcel(leer(row, 'fecha creacion')),
      servicio,
      servicioNormalizado: normalizarTexto(servicio),
      estado: textoLimpio(leer(row, 'estado guia')),
      destinatario: textoLimpio(leer(row, 'destinatario')),
      localidad: textoLimpio(leer(row, 'localidad')),
      departamento: textoLimpio(leer(row, 'departamento')),
      zona: null,
      categoriaZona: '*',
      peso: aNumero(leer(row, 'peso a facturar')) ?? aNumero(leer(row, 'peso ues')),
      // UES no manda importe: lo pone la tarifa más abajo.
      importeNeto: null,
      importeOrigen: 'tarifa',
      importeArchivo: null,
      filaExcel: fila,
      // El evento de levante no se factura por línea (UES cobra por solicitud), pero
      // sirve para contar cuántos levantes hubo y contrastarlos con los de la app.
      levanteTipo: normalizarTexto(leer(row, 'act evento nombre')),
      levanteFecha: fechaDesdeExcel(leer(row, 'act evento fecha')),
      raw: {
        envio: textoLimpio(leer(row, 'envio')),
        caracterizacion: textoLimpio(leer(row, 'caracterizacion ues')),
        ultimoEvento: textoLimpio(leer(row, 'ultimo evento nombre')),
        levante: textoLimpio(leer(row, 'act evento nombre')),
        levanteUsuario: textoLimpio(leer(row, 'act evento usuario')),
        // Se guarda para poder recontar los levantes al reabrir una liquidación, cuando
        // ya no está el Excel original.
        levanteFecha: (() => {
          const f = fechaDesdeExcel(leer(row, 'act evento fecha'));
          return f ? f.toISOString() : null;
        })(),
      },
    });
  }

  return { lineas, totalDeclarado: null };
}

// Días en los que el chofer de UES pasó a retirar paquetes. Cada uno de esos días es
// una solicitud de levante facturable.
//
// Los "LEVANTE EN PICK UP" NO cuentan: en esos casos los paquetes se llevaron a una
// agencia (los levanta "Xpres 087 - Estación Axion" y similares, no un chofer), así que
// no hay solicitud de levante que cobrar.
function detectarLevantes(lineas) {
  const porDia = new Map();
  for (const linea of lineas) {
    if (linea.levanteTipo !== 'levante en domicilio') continue;
    const dia = linea.levanteFecha ? linea.levanteFecha.toISOString().slice(0, 10) : null;
    if (!dia) continue;
    if (!porDia.has(dia)) porDia.set(dia, { fecha: dia, guias: 0 });
    porDia.get(dia).guias += 1;
  }
  return [...porDia.values()].sort((a, b) => a.fecha.localeCompare(b.fecha));
}

// ── Tarifas e IVA ────────────────────────────────────────────────────────────────

// Zonas 3/9/10 de MarcoPostal se cobran a tarifa extendida; el resto es Montevideo.
// La lista viene del parámetro `mp_zonas_extendidas` para poder ajustarla sin deploy.
function clasificarZona(zona, zonasExtendidas = []) {
  const n = numeroZona(zona);
  if (n === null) return 'montevideo';
  return zonasExtendidas.includes(n) ? 'extendida' : 'montevideo';
}

// Busca la tarifa de lo más específico a lo más general.
function buscarTarifa(tarifas, proveedor, servicioNormalizado, categoriaZona) {
  const candidatas = tarifas.filter((t) => t.proveedor === proveedor && t.activo !== false);
  const coincide = (t, servicio, zona) =>
    (t.servicio === servicio || t.servicio === '*')
    && (t.categoria_zona === zona || t.categoria_zona === '*');

  const orden = [
    (t) => t.servicio === servicioNormalizado && t.categoria_zona === categoriaZona,
    (t) => t.servicio === servicioNormalizado && t.categoria_zona === '*',
    (t) => t.servicio === '*' && t.categoria_zona === categoriaZona,
    (t) => t.servicio === '*' && t.categoria_zona === '*',
  ];

  for (const test of orden) {
    const encontrada = candidatas.find(test);
    if (encontrada) return encontrada;
  }
  return candidatas.find((t) => coincide(t, servicioNormalizado, categoriaZona)) || null;
}

// Completa importeNeto/iva/importeTotal y deja anotada la tarifa esperada para que la
// auditoría pueda comparar sin volver a buscarla.
function valorizarLineas(lineas, { proveedor, tarifas, ivaTasa }) {
  for (const linea of lineas) {
    const tarifa = buscarTarifa(tarifas, proveedor, linea.servicioNormalizado, linea.categoriaZona);

    if (tarifa) {
      const importeTarifa = Number(tarifa.importe);
      linea.tarifaEsperadaNeta = tarifa.incluye_iva
        ? redondear2(importeTarifa / (1 + ivaTasa))
        : redondear2(importeTarifa);
    } else {
      linea.tarifaEsperadaNeta = null;
    }

    if (linea.importeNeto === null) {
      // Sin importe en el archivo (UES) → se valoriza con la tarifa.
      linea.importeNeto = linea.tarifaEsperadaNeta ?? 0;
      linea.importeOrigen = 'tarifa';
      linea.sinTarifa = !tarifa;
    }

    linea.importeNeto = redondear2(linea.importeNeto);
    linea.iva = redondear2(linea.importeNeto * ivaTasa);
    linea.importeTotal = redondear2(linea.importeNeto + linea.iva);
  }
  return lineas;
}

// ── API pública ──────────────────────────────────────────────────────────────────

/**
 * Parsea un Excel de UES o MarcoPostal y devuelve las líneas ya valorizadas.
 *
 * @param {Buffer} buffer contenido del .xlsx
 * @param {object} config { tarifas, ivaTasa, zonasExtendidas }
 * @returns {Promise<{proveedor, lineas, totalDeclarado, periodoDesde, periodoHasta, totales}>}
 */
async function parseArchivo(buffer, config = {}) {
  const ivaTasa = Number.isFinite(config.ivaTasa) ? config.ivaTasa : 0.22;
  const zonasExtendidas = Array.isArray(config.zonasExtendidas) ? config.zonasExtendidas : [3, 9, 10];
  const tarifas = Array.isArray(config.tarifas) ? config.tarifas : [];

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);

  const deteccion = detectarProveedor(workbook);
  if (!deteccion) {
    throw new Error(
      'No se reconoce el formato del archivo. Se esperaba un Excel de MarcoPostal '
      + '(con columnas "Nro Guia" e "Importe") o de UES (con "Guia", "Referencia" y "Fecha Creacion").'
    );
  }

  const { proveedor, worksheet, encabezado } = deteccion;
  const parseConfig = { zonasExtendidas };
  const { lineas, totalDeclarado } = proveedor === PROVEEDORES.MARCOPOSTAL
    ? parseMarcoPostal(worksheet, encabezado, parseConfig)
    : parseUes(worksheet, encabezado, parseConfig);

  if (lineas.length === 0) {
    throw new Error('El archivo no tiene ninguna línea con número de guía.');
  }

  valorizarLineas(lineas, { proveedor, tarifas, ivaTasa });

  const fechas = lineas.map((l) => l.fecha).filter(Boolean).sort((a, b) => a - b);

  const totales = lineas.reduce(
    (acc, l) => ({
      neto: redondear2(acc.neto + l.importeNeto),
      iva: redondear2(acc.iva + l.iva),
      conIva: redondear2(acc.conIva + l.importeTotal),
    }),
    { neto: 0, iva: 0, conIva: 0 }
  );

  return {
    proveedor,
    hoja: worksheet.name,
    lineas,
    totalDeclarado,
    periodoDesde: fechas[0] || null,
    periodoHasta: fechas[fechas.length - 1] || null,
    totales,
    levantesDetectados: proveedor === PROVEEDORES.UES ? detectarLevantes(lineas) : [],
  };
}

module.exports = {
  parseArchivo,
  detectarLevantes,
  PROVEEDORES,
  // Exportados para la auditoría y los tests.
  normalizarTexto,
  normalizarOrden,
  clasificarZona,
  buscarTarifa,
  redondear2,
  fechaDesdeExcel,
};

const fs = require('fs').promises;
const path = require('path');
const logService = require('./logService');

// Completa el "Recibo de entrega de producto" de MercadoPago para las ventas de
// ML "a coordinar con el vendedor". El formulario es siempre el mismo, así que
// vive en assets/ y acá sólo se le escriben encima los datos de la venta.
//
// Qué se completa y qué NO:
//   - Se completa lo que sabemos nosotros: artículo, número de operación y los
//     apodos de comprador y vendedor.
//   - Queda EN BLANCO la sección 1 (nombre, cédula, teléfono y dirección de
//     quien recibe), más "Lugar y fecha" y la firma: eso lo llena a mano la
//     persona que retira, en MarcoPostal. Es el propósito del documento.
//
// El PDF original no tiene campos de formulario (es plano), así que las
// posiciones son coordenadas medidas sobre la página A4 (595x842 pt, origen
// abajo a la izquierda).

const PLANTILLA = path.join(__dirname, '..', 'assets', 'conforme-entrega-ml.pdf');

const APODO_VENDEDOR = process.env.ML_APODO_VENDEDOR || 'VELINNE';

// y = línea del rótulo; x = dónde arranca el valor, después del rótulo impreso.
const CAMPOS = {
  articulo:   { x: 118, y: 476, size: 8,  max: 245 },
  // La celda del numero es angosta y el id de ML tiene 16 digitos: a 7pt se
  // cortaba el ultimo, y un numero de operacion truncado no sirve para nada.
  operacion:  { x: 482, y: 476, size: 6,  max: 62 },
  comprador:  { x: 168, y: 396, size: 10, max: 360 },
  vendedor:   { x: 162, y: 366, size: 10, max: 360 },
};

class ConformeEntregaService {
  constructor() {
    this.plantillaBytes = null;
  }

  async cargarPlantilla() {
    if (!this.plantillaBytes) this.plantillaBytes = await fs.readFile(PLANTILLA);
    return this.plantillaBytes;
  }

  // El formulario pide "letra mayúscula de imprenta", así que todo va en
  // mayúsculas. Helvetica (WinAnsi) no soporta cualquier carácter: se limpia lo
  // que no entra para que pdf-lib no tire al escribir un nombre con símbolos raros.
  normalizar(texto) {
    return String(texto || '')
      .toUpperCase()
      .replace(/[^\x20-\xFF]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // Recorta al ancho disponible: el formulario tiene celdas angostas (sobre todo
  // "Número de operación") y un texto largo se saldría de la caja.
  recortar(texto, font, size, maxAncho) {
    let t = texto;
    while (t.length > 1 && font.widthOfTextAtSize(t, size) > maxAncho) {
      t = t.slice(0, -1);
    }
    return font.widthOfTextAtSize(t, size) > maxAncho ? '' : t;
  }

  // `pedido` es la fila de la tabla pedidos. Devuelve el PDF ya completado.
  async generar(pedido) {
    const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

    const doc = await PDFDocument.load(await this.cargarPlantilla());
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.getPages()[0];

    // El nombre del producto identifica la entrega mucho mejor que el SKU, que
    // para quien retira (y para un reclamo) no dice nada.
    const articulo = (pedido.ml_items || [])
      .map((i) => `${i.quantity || 1}x ${i.title || i.sku || ''}`.trim())
      .join(' + ');

    // El número de operación es el id de la venta en ML, sin el prefijo ML- que
    // le ponemos nosotros: en el reclamo lo buscan por el número de ML.
    const operacion = String(pedido.ml_order_id || pedido.numero_pedido || '')
      .replace(/^ML-/i, '');

    const valores = {
      articulo,
      operacion,
      // El apodo del comprador lo guarda el sync cuando ML lo da; si no, el
      // nombre que vino con la venta, que es mejor que dejarlo vacío.
      comprador: pedido.ml_buyer_nickname || pedido.cliente_nombre || '',
      vendedor: APODO_VENDEDOR,
    };

    for (const [clave, pos] of Object.entries(CAMPOS)) {
      const texto = this.recortar(this.normalizar(valores[clave]), font, pos.size, pos.max);
      if (!texto) continue;
      page.drawText(texto, {
        x: pos.x,
        y: pos.y,
        size: pos.size,
        font,
        color: rgb(0, 0, 0),
      });
    }

    logService.info('Conforme de entrega generado', {
      pedido: pedido.numero_pedido,
      operacion,
    });
    return Buffer.from(await doc.save());
  }
}

module.exports = new ConformeEntregaService();
module.exports.CAMPOS = CAMPOS;

const axios = require('axios');
const { parseAddress } = require('./direccionParserService');
const logService = require('./logService');
require('dotenv').config();

const API_URL = process.env.MARCO_POSTAL_API_URL || 'https://marcopostal.epresis.com';
const API_TOKEN = process.env.MARCO_POSTAL_API_TOKEN || '';
const CODIGO_SUCURSAL = process.env.MARCO_POSTAL_CODIGO_SUCURSAL || '';
const CODIGO_SERVICIO_EXPRESS = process.env.MARCO_POSTAL_CODIGO_SERVICIO_EXPRESS || '';
const CODIGO_SERVICIO_PICKUP = process.env.MARCO_POSTAL_CODIGO_SERVICIO_PICKUP || '';
const VALOR_DECLARADO = parseFloat(process.env.MARCO_POSTAL_VALOR_DECLARADO || '0');
const PESO_DEFAULT = parseFloat(process.env.MARCO_POSTAL_PESO_DEFAULT || '1');
const PICKUP_LOCALIDAD = process.env.MARCO_POSTAL_PICKUP_LOCALIDAD || 'Villa muños, retiro';
const PICKUP_DEPARTAMENTO = process.env.MARCO_POSTAL_PICKUP_DEPARTAMENTO || 'Montevideo';
const PICKUP_CALLE = process.env.MARCO_POSTAL_PICKUP_CALLE || '';
const PICKUP_ALTURA = process.env.MARCO_POSTAL_PICKUP_ALTURA || '0';

function buildComprador(pedido, isPickup) {
  if (isPickup) {
    return {
      destinatario: pedido.cliente_nombre || 'Sin nombre',
      calle: PICKUP_CALLE,
      altura: parseInt(PICKUP_ALTURA, 10) || 0,
      localidad: PICKUP_LOCALIDAD,
      provincia: PICKUP_DEPARTAMENTO,
      cp: 11000,
      email: pedido.cliente_email || '',
      celular: pedido.cliente_telefono || '',
    };
  }

  const parsed = parseAddress(pedido.direccion_envio || '');
  return {
    destinatario: pedido.cliente_nombre || 'Sin nombre',
    calle: parsed.calle || pedido.direccion_envio || '',
    altura: parseInt(parsed.numeroPuerta, 10) || 0,
    localidad: pedido.localidad || '',
    provincia: pedido.departamento || '',
    cp: parseInt(pedido.codigo_postal, 10) || 0,
    email: pedido.cliente_email || '',
    celular: pedido.cliente_telefono || '',
    ...(parsed.apartamento ? { dpto: parsed.apartamento } : {}),
    ...(parsed.observaciones ? { info_adicional_1: parsed.observaciones } : {}),
  };
}

async function generarGuia(pedido) {
  const isPickup = pedido.tipo_envio === 'pickup_local';
  const isExpress = Boolean(pedido.es_envio_express);

  if (!isPickup && !isExpress) {
    throw new Error('El pedido no es express ni pickup');
  }

  const comprador = buildComprador(pedido, isPickup);
  const payload = {
    api_token: API_TOKEN,
    codigo_sucursal: CODIGO_SUCURSAL,
    codigo_servicio: isPickup ? CODIGO_SERVICIO_PICKUP : CODIGO_SERVICIO_EXPRESS,
    tipo_operacion: isPickup ? 'RETIRO' : 'ENTREGA PAQUETERIA',
    pago_en: 'ORIGEN',
    internacional: false,
    isInversa: false,
    is_urgente: false,
    fragil: false,
    valor_declarado: VALOR_DECLARADO,
    remito: String(pedido.numero_pedido || pedido.id),
    comprador,
    productos: [
      {
        bultos: 1,
        peso: PESO_DEFAULT,
        descripcion: 'Pedido Velinne',
        dimensiones: { alto: 10, largo: 20, profundidad: 10 },
      },
    ],
  };

  logService.info('Marco Postal — generarGuia payload', {
    pedidoId: pedido.id,
    tipo: isPickup ? 'pickup' : 'express',
    tipo_operacion: payload.tipo_operacion,
    localidad: comprador.localidad,
    provincia: comprador.provincia,
  });

  const response = await axios.post(`${API_URL}/api/v2/guias.json`, payload, {
    headers: { 'Content-Type': 'application/json' },
    timeout: 30000,
  });

  const data = response.data;

  if (!data?.guia) {
    logService.error('Marco Postal — respuesta sin número de guía', { data });
    throw new Error('Marco Postal no devolvió número de guía');
  }

  logService.info('Marco Postal — guía generada', {
    pedidoId: pedido.id,
    guia: data.guia,
    importe: data.importe,
  });

  return { guiaId: data.guia, importe: data.importe };
}

async function obtenerEtiquetaHtml(guiaId) {
  const payload = {
    api_token: API_TOKEN,
    tipo: 'fixed',
    nombre: 'ETIQUETA 100 X 150',
    ides: [guiaId],
  };

  logService.info('Marco Postal — obtenerEtiquetaHtml', { guiaId });

  const response = await axios.post(`${API_URL}/api/v2/print-etiquetas-custom`, payload, {
    headers: { 'Content-Type': 'application/json' },
    timeout: 30000,
  });

  return response.data;
}

module.exports = { generarGuia, obtenerEtiquetaHtml };

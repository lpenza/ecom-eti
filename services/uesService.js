const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const logService = require('./logService');
const supabaseService = require('./supabaseService');
const { parseAddress } = require('./direccionParserService');
require('dotenv').config();

// Determina la localidad a usar para resolver en UES, priorizando el barrio
// obtenido de Google Maps (especialmente útil para pedidos de Montevideo).
function determinarLocalidad(pedido) {
  const departamento = (pedido.departamento || '').trim().toLowerCase();

  // Prioridad 1: barrio detectado por Google Maps
  if (pedido.barrio_google_maps) {
    return pedido.barrio_google_maps;
  }

  // Prioridad 2: lógica original
  if (departamento !== 'montevideo') {
    // Si la localidad contiene dígitos (probable CP o código), usar localidad_detectada
    if (pedido.localidad && /\d/.test(pedido.localidad)) {
      return pedido.localidad_detectada || pedido.localidad;
    }
    return pedido.localidad;
  }

  return pedido.localidad;
}

class UESService {
  constructor() {
    this.baseUrl = 'https://sge.ues.com.uy'; // URL base de UES API
    this.serviceDispatcherUrl = 'https://sge.ues.com.uy:9443/UES_Paqueteria/service_dispacher';
    this.token = null;
    this.testMode = process.env.UES_TEST_MODE === 'true';
    this.ignoreSsl = process.env.UES_IGNORE_SSL === 'true';
    this.httpsAgent = this.ignoreSsl ? new https.Agent({ rejectUnauthorized: false }) : undefined;
  }

  // UES requiere un fingerprint del dispositivo al autenticar.
  getDeviceFingerprint() {
    const source = `velinne-js|${process.version}|${process.platform}|${process.arch}`;
    return crypto.createHash('sha256').update(source).digest('hex');
  }

  // Autenticación manual en UES (llamada por el usuario)
  async autenticarManual() {
    try {
      logService.info('Intentando autenticar en UES API...');
      
      const response = await axios.post(this.serviceDispatcherUrl, {
        user: process.env.UES_USUARIO,
        password: process.env.UES_PASSWORD,
        _login: true,
        device_fingerprint: this.getDeviceFingerprint()
      }, {
        headers: {
          'X-TOKEN': 'login',
          'Content-Type': 'application/json'
        },
        timeout: 10000, // 10 segundos de timeout
        httpsAgent: this.httpsAgent
      });

      if (response.data?.code === 'ERROR') {
        throw new Error(response.data.returned_message || 'Credenciales inválidas en UES');
      }

      this.token = response.headers['x-token'] || response.data?._token || response.data?.token || null;
      logService.info('Autenticación exitosa en UES');
      console.log('✅ Token UES obtenido correctamente');
      return this.token;
    } catch (error) {
      const errorMsg = error.response 
        ? `Error ${error.response.status}: ${JSON.stringify(error.response.data)}`
        : error.code === 'ENOTFOUND'
        ? 'No se puede conectar con la API de UES. Verifique la URL o la conexión a internet.'
        : error.message;
      
      logService.error('Error autenticando en UES', { 
        error: errorMsg,
        url: this.baseUrl,
        usuario: process.env.UES_USUARIO 
      });
      
      throw new Error(`Error autenticando en UES: ${errorMsg}`);
    }
  }

  // Autenticación en UES (solo devuelve token existente)
  async autenticar() {
    if (this.token) {
      return this.token;
    }
    throw new Error('Debe iniciar sesión en UES usando el botón "Login UES".');
  }

  // Obtener headers con autenticación
  async getHeaders() {
    if (!this.token) {
      await this.autenticar();
    }
    
    return {
      'X-TOKEN': this.token,
      'Content-Type': 'application/json'
    };
  }

  async dispatcherPost(payload, retryCount = 0) {
    const headers = await this.getHeaders();
    const response = await axios.post(this.serviceDispatcherUrl, payload, {
      headers,
      timeout: 30000,
      httpsAgent: this.httpsAgent
    });

    let responseData = response.data;
    if (typeof responseData === 'string') {
      const trimmed = responseData.trim();
      if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
        try {
          responseData = JSON.parse(trimmed);
        } catch (error) {
          // Si no parsea, mantener string original para logging.
        }
      }
    }
    
    // Detectar si el JWT expiró
    if (responseData?.code === 'ERROR' && responseData?.returned_message?.includes('JWT expired')) {
      if (retryCount === 0) {
        logService.info('JWT expirado, intentando re-autenticar automáticamente...');
        try {
          await this.autenticarManual();
          logService.info('Re-autenticación exitosa, reintentando operación...');
          // Reintentar la operación con el nuevo token
          return await this.dispatcherPost(payload, retryCount + 1);
        } catch (error) {
          logService.error('Error en re-autenticación automática', error);
          throw new Error('Sesión de UES expirada. Por favor haga click en "Login UES" nuevamente.');
        }
      } else {
        throw new Error('JWT expirado y no se pudo re-autenticar automáticamente');
      }
    }
    
    return responseData;
  }

  normalizarTextoEtiqueta(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  construirComentarioEtiqueta(referencia, observaciones) {
    const referenciaCorta = this.normalizarTextoEtiqueta(referencia);
    const observacionesLimpias = this.normalizarTextoEtiqueta(observaciones);
    const comentarioBase = referenciaCorta;

    if (!observacionesLimpias) {
      return comentarioBase;
    }

    if (!comentarioBase) {
      return observacionesLimpias;
    }

    return `${comentarioBase} | ${observacionesLimpias}`;
  }

  extraerNumeroSeguimiento(value) {
    if (!value) return null;

    const directCandidates = [
      value?.guias?.[0]?.numero,
      value?.guias?.[0]?.guia,
      value?.guia?.numero,
      value?.guia?.guia,
      value?.numero,
      value?.numero_seguimiento,
      value?.tracking,
      value?.tracking_number,
      value?.guia_numero,
      value?.codigo_barras,
      value?.barcode,
      value?.data?.guias?.[0]?.numero,
      value?.data?.guias?.[0]?.guia,
      value?.data?.guia?.numero,
      value?.data?.numero,
      value?.returned_data?.guias?.[0]?.numero,
      value?.returned_data?.guia?.numero,
      value?.returned_data?.numero,
    ];

    for (const candidate of directCandidates) {
      const normalized = String(candidate || '').trim();
      if (normalized) return normalized;
    }

    return null;
  }

  async resolverNumeroSeguimientoPorEnvio(envioId, traceId) {
    if (!envioId) return null;

    const payloadCandidates = [
      { service: 'getGuia', action: 'getByEnvio', envio_id: String(envioId) },
      { service: 'getGuia', action: 'getByEnvio', id_envio: String(envioId) },
      { service: 'getGuia', action: 'get', envio_id: String(envioId) },
      { service: 'getGuia', action: 'list', envio_id: String(envioId) },
      { service: 'getEnvio', id: String(envioId) },
      { service: 'getEnvio', envio_id: String(envioId) },
    ];

    for (const payload of payloadCandidates) {
      try {
        const resp = await this.dispatcherPost(payload);
        const numero = this.extraerNumeroSeguimiento(resp);
        if (numero) {
          logService.info(`[${traceId}] Numero de seguimiento resuelto por envio`, {
            envioId,
            payload,
            numero,
          });
          return numero;
        }
      } catch (error) {
        // Continuar con el siguiente candidato
      }
    }

    return null;
  }

  async resolverServicioPickupId(departamentoId) {
    const contextResp = await this.obtenerContextoUES();
    const servicios = Array.isArray(contextResp?.servicios) ? contextResp.servicios : [];
    const isMontevideo = String(departamentoId || '') === '1';

    const pickupServices = servicios.filter((service) => {
      const nombre = String(service?.nombre || '').toLowerCase();
      const entregaPickup = service?.es_entrega_pickup === true
        || String(service?.es_entrega_pickup || '') === '1'
        || String(service?.entrega_pickup || '') === '1'
        || nombre.includes('pick up')
        || nombre.includes('pickup')
        || nombre.includes('xpres');

      return entregaPickup;
    });

    const preferred = pickupServices.find((service) => {
      const nombre = String(service?.nombre || '').toLowerCase();
      const esMontevideo = service?.es_montevideo === true || String(service?.es_montevideo || '') === '1';
      const esInterior = nombre.includes('interior') || nombre.includes('xpres') || String(service?.es_montevideo || '') === '0';
      return isMontevideo ? esMontevideo && !nombre.includes('interior') : esInterior;
    }) || pickupServices[0];

    return preferred?.id ? String(preferred.id) : String(process.env.UES_SERVICIO_ID);
  }

  construirPayloadEnvio(pedido, direccionId, servicioDestino = 'direccion', puntoRetiroId = null, departamentoPickupId = null, servicioIdOverride = null) {
    const referencia = String(pedido.numero_pedido || '');

    const payload = {
      service: 'guardarEnvio',
      cliente_id: String(process.env.UES_CLIENTE_ID),
      servicio_destino: servicioDestino,
      referencia,
      remitente: String(process.env.UES_REMITENTE_ID),
      nombre_recibe: pedido.cliente_nombre || '',
      telefono_recibe: pedido.cliente_telefono || process.env.UES_TELEFONO_DEFAULT || '',
      email_recibe: pedido.cliente_email || process.env.UES_EMAIL_DEFAULT || '',
      servicio_id: String(servicioIdOverride || process.env.UES_SERVICIO_ID),
      direccion_remitente_id: String(process.env.UES_DIRECCION_REMITENTE_ID),
      guias: [
        {
          comentario: '',
          referencia,
          peso: '',
          ci: '',
          valor_declarado: '',
        },
      ],
    };

    // Si es envío a domicilio, usar dirección; si es pickup, usar punto_retiro_id
    if (servicioDestino === 'pickup' && puntoRetiroId) {
      const destinoPickup = Number(puntoRetiroId);
      payload.servicio_destino = 'pu';
      payload.pu_id = Number.isFinite(destinoPickup) ? destinoPickup : puntoRetiroId;
      payload.depto_pu = String(departamentoPickupId || '');
      delete payload.destino;
      delete payload.direccion_destinatario_id;
    } else {
      payload.destino = direccionId;
      payload.direccion_destinatario_id = direccionId;
    }

    return payload;
  }

  async obtenerPuntosRetiro() {
    try {
      logService.info('Obteniendo puntos de retiro desde contexto UES');

      const contextResp = await this.dispatcherPost({ service: 'getContext' });
      const agentes = Array.isArray(contextResp?.agentes) ? contextResp.agentes : [];

      // tipo_id 2 = "Pick Up", tipo_id 3 = "Xpres!", tipo_id 4 = "Agencia con Pick Up"
      const pickupAgentes = agentes.filter(
        (a) => (a.tipo_id === '2' || a.tipo_id === '3' || a.tipo_id === '4') && a.activo === '1'
      );

      // Deduplicar por direccion_id — mismo punto físico puede aparecer como tipo 2 y tipo 4
      const seenDireccionIds = new Set();
      const deduped = pickupAgentes.filter((a) => {
        if (!a.direccion_id || seenDireccionIds.has(a.direccion_id)) return false;
        seenDireccionIds.add(a.direccion_id);
        return true;
      });

      const result = deduped.map((a) => ({
        id: String(a.id),
        nombre: a.nombre || '',
        direccion: a.direccion_desc || '',
        localidad_id: a.localidad_id ? String(a.localidad_id) : null,
        departamento_id: a.departamento_id ? String(a.departamento_id) : null,
        horario: a.horario_atencion || '',
      }));

      logService.info(`Puntos de retiro obtenidos: ${result.length}`);
      return result;
    } catch (error) {
      logService.error('Error al obtener puntos de retiro de UES', error);
      return [];
    }
  }

  async construirPayloadsUes(pedido, direccionIdEnvio = null, skipLocalidadValidation = false) {
    const direccionParseada = parseAddress(pedido.direccion_envio || '');
    
    // Solo buscar localidad si no se indica saltarse la validación
    // (útil cuando vienen overrides del usuario con departamento/localidad ya definidos)
    let localidadUes;
    if (skipLocalidadValidation) {
      // Valores por defecto que serán sobrescritos por overrides
      localidadUes = {
        ues_id: '0',
        departamento_id: 0,
        nombre: 'Será sobrescrito por override'
      };
      logService.info('Saltando validación de localidad (vendrá de overrides del usuario)');
    } else {
      localidadUes = await supabaseService.buscarLocalidadUes(
        determinarLocalidad(pedido),
        pedido.departamento
      );
    }
    
    // Observaciones solo desde el parser de dirección (no usar pedido.notas)
    const observacionesDireccion = direccionParseada.observaciones || '';

    const payloadDireccion = {
      service: 'guardarDireccion',
      calle: direccionParseada.calle || pedido.direccion_envio || '',
      nro_puerta: direccionParseada.numeroPuerta || '',
      numero_apartamento: direccionParseada.apartamento || '',
      zip_code: pedido.codigo_postal || '',
      latitud: pedido.latitud || '',
      longitud: pedido.longitud || '',
      departamento_id: String(localidadUes.departamento_id),
      localidad_id: String(localidadUes.ues_id),
      cliente_id: 0,
      type: null,
      observaciones: observacionesDireccion,
    };

    const destinoPreview = direccionIdEnvio == null
      ? '<ID_DEVUELTO_POR_GUARDAR_DIRECCION>'
      : direccionIdEnvio;

    const payloadEnvio = this.construirPayloadEnvio(pedido, destinoPreview);

    return {
      direccionParseada,
      localidadUes,
      payloadDireccion,
      payloadEnvio,
    };
  }

  // Generar etiqueta de envío
  async generarEtiqueta(pedido, payloadOverrides = null) {
    try {
      const traceId = `ETQ-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      // Si está en modo de prueba, genera una etiqueta simulada
      if (this.testMode) {
        logService.info('Generando etiqueta en MODO DE PRUEBA');
        return await this.generarEtiquetaPrueba(pedido);
      }

      logService.info(`Generando etiqueta para pedido ${pedido.id} - Orden #${pedido.numero_pedido} [${traceId}]`);

      // Detectar si es envío a pickup o a domicilio
      const tipoEntrega = String(payloadOverrides?.tipoEntrega || 'domicilio').toLowerCase();
      const esPickup = tipoEntrega === 'pickup';

      logService.info(`[${traceId}] Tipo de entrega: ${tipoEntrega} (pickup: ${esPickup})`);

      // Si vienen overrides con departamento y localidad, saltarse la validación original
      const tieneLocalidadOverride = payloadOverrides?.payloadDireccion?.departamento_id && 
                                      payloadOverrides?.payloadDireccion?.localidad_id;
      
      const payloadsPreparados = await this.construirPayloadsUes(pedido, null, tieneLocalidadOverride || esPickup);
      logService.info('Dirección parseada:', payloadsPreparados.direccionParseada);
      if (!tieneLocalidadOverride && !esPickup) {
        logService.info('Localidad UES resuelta:', payloadsPreparados.localidadUes);
      }
      logService.info(`🧭 [${traceId}] Observaciones origen parser:`, {
        pedidoId: pedido.id,
        numeroPedido: pedido.numero_pedido,
        tipoEntrega: tipoEntrega,
        direccionEnvioOriginal: pedido.direccion_envio,
        observacionesParser: payloadsPreparados?.payloadDireccion?.observaciones || '',
        observacionesOverrideEntrada: payloadOverrides?.payloadDireccion?.observaciones || '',
        referenciaOverrideEntrada: payloadOverrides?.payloadEnvio?.referencia || '',
        comentarioGuiaOverrideEntrada: payloadOverrides?.guia?.comentario || '',
      });

      // Merge inteligente: solo sobrescribir valores que no estén vacíos del override
      const mergePayload = (base, override) => {
        if (!override) return base;
        const merged = { ...base };
        for (const key in override) {
          const value = override[key];
          
          // Campos que siempre deben sobrescribirse incluso si están vacíos
          const alwaysOverride = ['observaciones', 'comentario'];
          
          if (alwaysOverride.includes(key)) {
            merged[key] = value;
          } else if (value !== undefined && value !== null && value !== '') {
            // Sobrescribir solo si hay un valor válido
            merged[key] = value;
          }
          // Si el valor es vacío y no está en alwaysOverride, mantener el valor base
        }
        return merged;
      };

      let direccionId = null;
      let puntoRetiroId = null;
      let payloadDireccionFinal = payloadsPreparados.payloadDireccion;
      let servicioPickupId = null;

      // PASO 1: Guardar dirección SOLO si es envío a domicilio (no es pickup)
      if (!esPickup) {
        const payloadDireccion = mergePayload(
          payloadsPreparados.payloadDireccion,
          payloadOverrides?.payloadDireccion
        );
        payloadDireccionFinal = payloadDireccion;

        const obsFinal = String(payloadDireccion?.observaciones || '').trim();
        const obsPatternSospechoso = /^\/\d+\s*-?\s*$/i.test(obsFinal);

        logService.info('📦 Payload base (antes de merge):', payloadsPreparados.payloadDireccion);
        logService.info('✏️  Overrides recibidos:', payloadOverrides?.payloadDireccion);
        logService.info('🔀 Payload final (después de merge):', payloadDireccion);
        logService.info(`📌 [${traceId}] Observaciones final antes de guardarDireccion:`, {
          observacionesFinal: obsFinal,
          esSospechoso: obsPatternSospechoso,
        });
        if (obsPatternSospechoso) {
          logService.warning(`⚠️ [${traceId}] Observaciones con patrón sospechoso detectado`, {
            pedidoId: pedido.id,
            numeroPedido: pedido.numero_pedido,
            observacionesFinal: obsFinal,
            payloadDireccion,
          });
        }
        
        const direccionResp = await this.dispatcherPost(payloadDireccion);
        logService.info(`Respuesta guardarDireccion [${traceId}]:`, direccionResp);

        if (direccionResp?.code === 'ERROR' || !direccionResp?.id) {
          throw new Error(direccionResp?.msg || direccionResp?.returned_message || 'No se pudo crear direccion en UES');
        }

        direccionId = Number(direccionResp.id);
      } else {
        // Si es pickup, usar el ID del punto de retiro
        puntoRetiroId = payloadOverrides?.puntoRetiroId;
        if (!puntoRetiroId) {
          throw new Error('Pickup seleccionado pero no se proporcionó puntoRetiroId');
        }
        const departamentoPickupId = String(
          payloadOverrides?.payloadDireccion?.departamento_id
          || payloadsPreparados?.payloadDireccion?.departamento_id
          || ''
        );
        servicioPickupId = await this.resolverServicioPickupId(departamentoPickupId);
        logService.info(`[${traceId}] Enviando a pickup: puntoRetiroId=${puntoRetiroId}`);
      }

      // PASO 2: Guardar envío
      const basePayloadEnvio = this.construirPayloadEnvio(
        pedido, 
        direccionId, 
        esPickup ? 'pickup' : 'direccion',
        puntoRetiroId,
        payloadOverrides?.payloadDireccion?.departamento_id || payloadsPreparados?.payloadDireccion?.departamento_id || null,
        servicioPickupId
      );
      const payloadEnvio = mergePayload(basePayloadEnvio, payloadOverrides?.payloadEnvio);

      // Reglas finales de negocio para UES (workaround):
      // - referencia: usar override si existe (ej: RCLxxxx), si no número de pedido
      // - comentario guía: incluir referencia final + observaciones cortas
      //   porque UES puede sobrescribir guia.referencia con guia.comentario.
      const referenciaFinal = String(
        payloadOverrides?.payloadEnvio?.referencia || pedido?.numero_pedido || ''
      ).trim();
      const observacionesFinales = esPickup ? '' : String(payloadDireccionFinal?.observaciones || '').trim();
      const comentarioCompuesto = this.construirComentarioEtiqueta(
        referenciaFinal,
        observacionesFinales
      );
      payloadEnvio.referencia = referenciaFinal;

      if (!esPickup) {
        payloadEnvio.destino = direccionId;
        payloadEnvio.direccion_destinatario_id = direccionId;
      } else {
        const destinoPickup = Number(puntoRetiroId);
        payloadEnvio.servicio_destino = 'pu';
        payloadEnvio.pu_id = Number.isFinite(destinoPickup) ? destinoPickup : puntoRetiroId;
        payloadEnvio.depto_pu = String(
          payloadOverrides?.payloadDireccion?.departamento_id
          || payloadsPreparados?.payloadDireccion?.departamento_id
          || ''
        );
        payloadEnvio.servicio_id = String(servicioPickupId || payloadEnvio.servicio_id || '');
        delete payloadEnvio.destino;
        delete payloadEnvio.punto_retiro_id;
        delete payloadEnvio.direccion_destinatario_id;
      }

      if (Array.isArray(payloadEnvio.guias) && payloadEnvio.guias.length > 0) {
        payloadEnvio.guias[0] = mergePayload(
          payloadEnvio.guias[0],
          payloadOverrides?.guia
        );

        payloadEnvio.guias[0].referencia = referenciaFinal;
        payloadEnvio.guias[0].comentario = comentarioCompuesto;
      }

      logService.info(`🧭 [${traceId}] Mapeo final referencia/comentario`, {
        referenciaFinal: payloadEnvio.referencia,
        guiaReferenciaFinal: payloadEnvio?.guias?.[0]?.referencia || '',
        comentarioFinal: payloadEnvio?.guias?.[0]?.comentario || '',
        observacionesDireccionFinal: observacionesFinales,
        tipoEntrega: tipoEntrega,
      });

      logService.info(`📦 Payload guardarEnvio [${traceId}]:`, payloadEnvio);
      if (payloadOverrides) {
        logService.info(`Overrides aplicados (envío) [${traceId}]:`, payloadOverrides.payloadEnvio);
      }
      
      const envioResp = await this.dispatcherPost(payloadEnvio);
      logService.info(`Respuesta guardarEnvio [${traceId}]:`, envioResp);

      if (envioResp?.code === 'ERROR') {
        throw new Error(envioResp?.msg || envioResp?.returned_message || 'Error desconocido en guardarEnvio');
      }

      const envioId = envioResp?.id || null;
      let numeroSeguimiento = this.extraerNumeroSeguimiento(envioResp);

      if (!numeroSeguimiento && envioId) {
        numeroSeguimiento = await this.resolverNumeroSeguimientoPorEnvio(envioId, traceId);
      }

      if (!numeroSeguimiento) {
        const respKeys = envioResp && typeof envioResp === 'object' ? Object.keys(envioResp) : [];
        throw new Error(`guardarEnvio OK pero sin numero de seguimiento (keys: ${respKeys.join(',')})`);
      }

      // PASO 3: Obtener etiqueta usando el mismo llamado del .NET.
      // UES puede demorar unos segundos en propagar la guía recién creada —
      // esperamos antes de pedir el PDF, con hasta 3 reintentos.
      const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const MAX_PDF_INTENTOS = 3;
      const PDF_ESPERA_MS = 2000;
      let etiquetaResp = null;
      for (let intento = 1; intento <= MAX_PDF_INTENTOS; intento++) {
        logService.info(`[${traceId}] Esperando ${PDF_ESPERA_MS}ms antes de pedir PDF (intento ${intento}/${MAX_PDF_INTENTOS})...`);
        await delay(PDF_ESPERA_MS);
        etiquetaResp = await this.dispatcherPost({
          service: 'getGuia',
          action: 'getEtiqueta',
          numero: numeroSeguimiento,
        });
        logService.info(`Respuesta getGuia/getEtiqueta intento ${intento} [${traceId}]:`, etiquetaResp);
        if (etiquetaResp?.url) break;
        logService.warning(`[${traceId}] PDF no disponible en intento ${intento}${intento < MAX_PDF_INTENTOS ? ', reintentando...' : ', máximo de intentos alcanzado'}`);
      }

      const urlPdf = etiquetaResp?.url || null;

      return {
        envioId,
        numeroSeguimiento,
        urlPdf,
        codigoBarras: null,
        traceId,
      };
    } catch (error) {
      // Si falla por token expirado, exigir nuevo login manual.
      if (error.response?.status === 401) {
        logService.warn('Token expirado en UES, se requiere nuevo login manual.');
        this.token = null;
        throw new Error('Sesión UES expirada. Vuelve a presionar "Login UES".');
      }

      const errorMsg = error.response 
        ? `Error ${error.response.status}: ${JSON.stringify(error.response.data)}`
        : error.code === 'ENOTFOUND'
        ? 'No se puede conectar con la API de UES. Verifique la configuración.'
        : error.code === 'ETIMEDOUT'
        ? 'Tiempo de espera agotado al conectar con UES.'
        : error.message;
      
      logService.error('Error generando etiqueta UES', { 
        error: errorMsg,
        pedido: pedido.id 
      });
      
      throw new Error(`Error generando etiqueta UES: ${errorMsg}`);
    }
  }

  // Generar etiqueta de prueba (simulada)
  async generarEtiquetaPrueba(pedido) {
    try {
      const PDFLib = require('pdf-lib');
      const { PDFDocument, rgb, StandardFonts } = PDFLib;

      // Crear un PDF simple
      const pdfDoc = await PDFDocument.create();
      const page = pdfDoc.addPage([400, 600]);
      const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
      const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

      const { width, height } = page.getSize();
      
      // Título
      page.drawText('ETIQUETA DE ENVÍO - MODO PRUEBA', {
        x: 50,
        y: height - 50,
        size: 16,
        font: boldFont,
        color: rgb(0.95, 0, 0)
      });

      // Información del pedido
      page.drawText(`Orden: #${pedido.numero_orden || pedido.id}`, {
        x: 50, y: height - 100, size: 12, font: boldFont
      });

      page.drawText(`Cliente: ${pedido.cliente_nombre || 'Sin nombre'}`, {
        x: 50, y: height - 130, size: 10, font
      });

      page.drawText(`Dirección: ${pedido.direccion_calle || 'Sin dirección'}`, {
        x: 50, y: height - 150, size: 10, font
      });

      page.drawText(`Ciudad: ${pedido.direccion_ciudad || 'N/A'} - ${pedido.direccion_departamento || 'N/A'}`, {
        x: 50, y: height - 170, size: 10, font
      });

      page.drawText(`Teléfono: ${pedido.cliente_telefono || 'N/A'}`, {
        x: 50, y: height - 190, size: 10, font
      });

      // Número de seguimiento simulado
      const numeroSeguimiento = `UEST${Date.now()}`;
      page.drawText(`Seguimiento: ${numeroSeguimiento}`, {
        x: 50, y: height - 230, size: 14, font: boldFont
      });

      page.drawText(`Total: $${parseFloat(pedido.total || 0).toFixed(2)}`, {
        x: 50, y: height - 260, size: 12, font
      });

      // Nota importante
      page.drawText('IMPORTANTE: Esta es una etiqueta de prueba.', {
        x: 50, y: 100, size: 10, font: boldFont, color: rgb(0.95, 0, 0)
      });

      page.drawText('Configure las credenciales reales de UES para', {
        x: 50, y: 80, size: 9, font, color: rgb(0.5, 0, 0)
      });

      page.drawText('generar etiquetas de envío válidas.', {
        x: 50, y: 65, size: 9, font, color: rgb(0.5, 0, 0)
      });

      // Guardar PDF
      const pdfBytes = await pdfDoc.save();
      
      const rutaDescargas = process.env.RUTA_DESCARGAS;
      await fs.mkdir(rutaDescargas, { recursive: true });
      
      const nombreArchivo = `etiqueta_prueba_${pedido.id}_${Date.now()}.pdf`;
      const rutaArchivo = path.join(rutaDescargas, nombreArchivo);
      
      await fs.writeFile(rutaArchivo, pdfBytes);

      logService.info(`Etiqueta de prueba generada: ${rutaArchivo}`);

      return {
        envioId: `TEST-${pedido.id}`,
        numeroSeguimiento: numeroSeguimiento,
        urlPdf: rutaArchivo,
        codigoBarras: numeroSeguimiento
      };
    } catch (error) {
      logService.error('Error generando etiqueta de prueba', error);
      throw new Error(`Error generando etiqueta de prueba: ${error.message}`);
    }
  }

  // Obtener PDF de etiqueta
  async obtenerPdfEtiqueta(envioId, headers) {
    try {
      logService.info(`Descargando PDF de etiqueta para envío ${envioId}`);
      
      const response = await axios.get(
        `${this.baseUrl}/envios/${envioId}/etiqueta`,
        { 
          headers, 
          responseType: 'arraybuffer',
          timeout: 30000,
          httpsAgent: this.httpsAgent
        }
      );
      
      // Guardar PDF localmente
      const rutaDescargas = process.env.RUTA_DESCARGAS;
      await fs.mkdir(rutaDescargas, { recursive: true });
      
      const nombreArchivo = `etiqueta_${envioId}_${Date.now()}.pdf`;
      const rutaArchivo = path.join(rutaDescargas, nombreArchivo);
      
      await fs.writeFile(rutaArchivo, response.data);
      
      logService.info(`PDF guardado en: ${rutaArchivo}`);
      
      return rutaArchivo;
    } catch (error) {
      const errorMsg = error.response 
        ? `Error ${error.response.status}: ${JSON.stringify(error.response.data)}`
        : error.code === 'ENOTFOUND'
        ? 'No se puede conectar con la API de UES.'
        : error.code === 'ETIMEDOUT'
        ? 'Tiempo de espera agotado al descargar PDF.'
        : error.message;
      
      logService.error('Error obteniendo PDF', { error: errorMsg, envioId });
      throw new Error(`Error obteniendo PDF: ${errorMsg}`);
    }
  }

  // Descargar etiqueta existente
  async descargarEtiqueta(urlEtiqueta) {
    try {
      if (urlEtiqueta.startsWith('http')) {
        // Es una URL, descargar
        const response = await axios.get(urlEtiqueta, {
          responseType: 'arraybuffer',
          httpsAgent: this.httpsAgent
        });
        return response.data;
      } else {
        // Es una ruta local, leer archivo
        return await fs.readFile(urlEtiqueta);
      }
    } catch (error) {
      throw new Error(`Error descargando etiqueta: ${error.message}`);
    }
  }

  // Consultar estado de envío
  async consultarEstado(numeroSeguimiento) {
    try {
      const headers = await this.getHeaders();
      const response = await axios.get(
        `${this.baseUrl}/envios/tracking/${numeroSeguimiento}`,
        { headers, httpsAgent: this.httpsAgent }
      );
      
      return response.data;
    } catch (error) {
      throw new Error(`Error consultando estado: ${error.message}`);
    }
  }

  // Cancelar envío
  async cancelarEnvio(envioId) {
    try {
      const headers = await this.getHeaders();
      const response = await axios.post(
        `${this.baseUrl}/envios/${envioId}/cancelar`,
        {},
        { headers, httpsAgent: this.httpsAgent }
      );
      
      return response.data;
    } catch (error) {
      throw new Error(`Error cancelando envío: ${error.message}`);
    }
  }

  // Obtener contexto completo de UES (departamentos y localidades)
  // Este método consulta directamente a UES para obtener el catálogo actualizado
  async obtenerContextoUES() {
    try {
      logService.info('Obteniendo contexto actualizado desde UES API...');
      
      const response = await this.dispatcherPost({ service: 'getContext' });
      
      if (response.code === 'ERROR') {
        throw new Error(response.returned_message || 'Error obteniendo contexto de UES');
      }

      // Retornar el contexto completo (no solo departamentos_localidades)
      logService.info(`Contexto UES obtenido: ${response.departamentos_localidades?.length || 0} departamentos`);
      
      return response; // Retorna el objeto completo
    } catch (error) {
      logService.error('Error obteniendo contexto de UES', error);
      throw new Error(`No se pudo obtener el catálogo de UES: ${error.message}`);
    }
  }

  // Regenerar caché de contexto UES (guardar en archivo)
}

module.exports = new UESService();

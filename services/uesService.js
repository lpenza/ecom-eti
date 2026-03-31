const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const logService = require('./logService');
const supabaseService = require('./supabaseService');
const { parseAddress } = require('./direccionParserService');
require('dotenv').config();

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
    
    // Detectar si el JWT expiró
    if (response.data?.code === 'ERROR' && response.data?.returned_message?.includes('JWT expired')) {
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
    
    return response.data;
  }

  construirPayloadEnvio(pedido, direccionId) {
    return {
      service: 'guardarEnvio',
      cliente_id: String(process.env.UES_CLIENTE_ID),
      servicio_destino: 'direccion',
      referencia: String(pedido.numero_pedido || ''),
      remitente: String(process.env.UES_REMITENTE_ID),
      destino: direccionId,
      nombre_recibe: pedido.cliente_nombre || '',
      telefono_recibe: pedido.cliente_telefono || process.env.UES_TELEFONO_DEFAULT || '',
      email_recibe: pedido.cliente_email || process.env.UES_EMAIL_DEFAULT || '',
      servicio_id: String(process.env.UES_SERVICIO_ID),
      direccion_destinatario_id: direccionId,
      direccion_remitente_id: String(process.env.UES_DIRECCION_REMITENTE_ID),
      guias: [
        {
          comentario: String(pedido.numero_pedido || ''),
          peso: '',
          ci: '',
          valor_declarado: '',
        },
      ],
    };
  }

  async construirPayloadsUes(pedido, direccionIdEnvio = null) {
    const direccionParseada = parseAddress(pedido.direccion_envio || '');
    const localidadUes = await supabaseService.buscarLocalidadUes(pedido.localidad, pedido.departamento);
    const observacionesDireccion = [direccionParseada.observaciones, pedido.notas]
      .filter(Boolean)
      .join(' | ');

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
      // Si está en modo de prueba, genera una etiqueta simulada
      if (this.testMode) {
        logService.info('Generando etiqueta en MODO DE PRUEBA');
        return await this.generarEtiquetaPrueba(pedido);
      }

      logService.info(`Generando etiqueta para pedido ${pedido.id} - Orden #${pedido.numero_pedido}`);

      const payloadsPreparados = await this.construirPayloadsUes(pedido);
      logService.info('Dirección parseada:', payloadsPreparados.direccionParseada);
      logService.info('Localidad UES resuelta:', payloadsPreparados.localidadUes);

      const payloadDireccion = {
        ...payloadsPreparados.payloadDireccion,
        ...(payloadOverrides?.payloadDireccion || {}),
      };

      logService.info('Payload guardarDireccion:', payloadDireccion);
      const direccionResp = await this.dispatcherPost(payloadDireccion);
      logService.info('Respuesta guardarDireccion:', direccionResp);

      if (direccionResp?.code === 'ERROR' || !direccionResp?.id) {
        throw new Error(direccionResp?.msg || direccionResp?.returned_message || 'No se pudo crear direccion en UES');
      }

      const direccionId = Number(direccionResp.id);

      const payloadEnvio = {
        ...this.construirPayloadEnvio(pedido, direccionId),
        ...(payloadOverrides?.payloadEnvio || {}),
      };

      payloadEnvio.destino = direccionId;
      payloadEnvio.direccion_destinatario_id = direccionId;

      if (Array.isArray(payloadEnvio.guias) && payloadEnvio.guias.length > 0) {
        payloadEnvio.guias[0] = {
          ...payloadEnvio.guias[0],
          ...(payloadOverrides?.guia || {}),
        };
      }

      logService.info('Payload guardarEnvio:', payloadEnvio);
      const envioResp = await this.dispatcherPost(payloadEnvio);
      logService.info('Respuesta guardarEnvio:', envioResp);

      if (envioResp?.code === 'ERROR') {
        throw new Error(envioResp?.msg || envioResp?.returned_message || 'Error desconocido en guardarEnvio');
      }

      const envioId = envioResp?.id || null;
      const guia = Array.isArray(envioResp?.guias) && envioResp.guias.length > 0 ? envioResp.guias[0] : null;
      const numeroSeguimiento = guia?.numero || null;

      if (!numeroSeguimiento) {
        throw new Error('guardarEnvio OK pero sin numero de seguimiento en guias');
      }

      // 4) Obtener etiqueta usando el mismo llamado del .NET.
      const etiquetaResp = await this.dispatcherPost({
        service: 'getGuia',
        action: 'getEtiqueta',
        numero: numeroSeguimiento,
      });
      logService.info('Respuesta getGuia/getEtiqueta:', etiquetaResp);

      const urlPdf = etiquetaResp?.url || null;

      return {
        envioId,
        numeroSeguimiento,
        urlPdf,
        codigoBarras: null,
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
}

module.exports = new UESService();

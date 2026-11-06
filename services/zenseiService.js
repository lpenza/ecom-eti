// Cliente de la API de facturación de Zensei (CFE por API).
// Docs: https://app.zensei.uy/configuracion/api-docs (con sesión iniciada).
//
// app.zensei.uy es PRODUCCIÓN: todo lo que se emite acá es un comprobante real
// que va a DGI. Las keys de producción empiezan con zsk_live_; las de prueba
// (zsk_test_) hay que coordinarlas con soporte@zensei.uy.

const axios = require('axios');
require('dotenv').config();

// La emisión es sincrónica e incluye el envío a DGI: Zensei pide un timeout de
// al menos 60 s. Se deja margen.
const TIMEOUT_EMISION_MS = 90000;
const TIMEOUT_CONSULTA_MS = 30000;

// Mensajes de la tabla de errores de la documentación, en criollo.
const ERRORES = {
  'missing-api-key': 'Falta configurar ZENSEI_API_KEY',
  'invalid-api-key': 'La API key de Zensei no es válida (¿está bien copiada?)',
  'revoked-key': 'La API key de Zensei fue revocada: creá una nueva',
  'expired-key': 'La API key de Zensei venció: creá una nueva',
  'subscription-restricted': 'La suscripción de Zensei no permite emitir: regularizala desde Zensei',
  'insufficient-scope': 'La API key no tiene el permiso necesario (cfe:issue / cfe:read)',
  'company-mismatch': 'El tenantId/companyId no corresponde a la API key',
  'ip-not-allowed': 'La IP del servidor no está habilitada en la API key de Zensei',
  'not-yet-authorized': 'La empresa todavía no está habilitada por DGI para emitir',
  'request-in-progress': 'Zensei todavía está procesando este comprobante: esperá unos segundos y reintentá',
  'rate-limit-exceeded': 'Se superó el límite de Zensei (60 emisiones por minuto): esperá un minuto',
  'idempotency-key-required': 'Falta la clave de idempotencia',
  'not-found': 'El comprobante no existe en Zensei',
  'pdf-not-found': 'Zensei no pudo generar el PDF del comprobante',
};

class ZenseiService {
  constructor() {
    this.baseUrl = (process.env.ZENSEI_API_URL || 'https://app.zensei.uy/api').replace(/\/+$/, '');
    this.apiKey = process.env.ZENSEI_API_KEY || '';
    this.tenantId = process.env.ZENSEI_TENANT_ID || '';
    this.companyId = process.env.ZENSEI_COMPANY_ID || '';
    // Opcional: sin branchId Zensei usa la sucursal principal de la empresa.
    this.branchId = process.env.ZENSEI_BRANCH_ID || '';
  }

  configurado() {
    return Boolean(this.apiKey && this.tenantId && this.companyId);
  }

  faltantes() {
    return [
      !this.apiKey && 'ZENSEI_API_KEY',
      !this.tenantId && 'ZENSEI_TENANT_ID',
      !this.companyId && 'ZENSEI_COMPANY_ID',
    ].filter(Boolean);
  }

  ruta(sufijo = '') {
    return `${this.baseUrl}/v1/external/tenants/${encodeURIComponent(this.tenantId)}/companies/${encodeURIComponent(this.companyId)}${sufijo}`;
  }

  headers(extra = {}) {
    return { Authorization: `Bearer ${this.apiKey}`, ...extra };
  }

  // Texto legible para un error de Zensei. En validaciones de negocio `error`
  // ya viene como un mensaje descriptivo en español.
  mensajeError(status, data) {
    const codigo = typeof data === 'object' && data ? data.error : null;
    if (codigo && ERRORES[codigo]) return ERRORES[codigo];
    if (codigo) return String(codigo);
    if (typeof data === 'string' && data.trim()) return data.trim().slice(0, 300);
    return `Zensei respondió HTTP ${status}`;
  }

  /**
   * Emite un CFE. Nunca tira por respuestas HTTP de Zensei: devuelve
   * { ok, status, data, error, reintentable }. Sí distingue el caso en que no
   * hubo respuesta (timeout / red), que se marca reintentable: hay que volver a
   * mandar con la MISMA idempotencyKey para no emitir dos veces.
   */
  async emitirCfe(cuerpo, idempotencyKey) {
    if (!this.configurado()) {
      return { ok: false, status: 0, error: `Falta configurar ${this.faltantes().join(', ')} en el servidor`, reintentable: false };
    }
    if (!idempotencyKey) throw new Error('emitirCfe requiere idempotencyKey');

    const body = { ...cuerpo };
    if (this.branchId && !body.branchId && !body.branchCode) body.branchId = this.branchId;

    try {
      const res = await axios.post(this.ruta('/cfes'), body, {
        headers: this.headers({ 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey }),
        timeout: TIMEOUT_EMISION_MS,
        validateStatus: () => true,
      });
      if (res.status === 200 || res.status === 201) {
        return { ok: true, status: res.status, data: res.data };
      }
      return {
        ok: false,
        status: res.status,
        data: res.data,
        error: this.mensajeError(res.status, res.data),
        // 409 en curso, 429 y 5xx se reintentan con la misma clave.
        reintentable: res.status === 409 || res.status === 429 || res.status >= 500,
      };
    } catch (error) {
      const timeout = error.code === 'ECONNABORTED' || /timeout/i.test(error.message || '');
      return {
        ok: false,
        status: 0,
        error: timeout
          ? 'Zensei no respondió a tiempo. Puede que el comprobante se haya emitido igual: reintentá (no se duplica)'
          : `No se pudo conectar con Zensei: ${error.message}`,
        reintentable: true,
      };
    }
  }

  async obtenerCfe(cfeId) {
    const res = await axios.get(this.ruta(`/cfes/${encodeURIComponent(cfeId)}`), {
      headers: this.headers(),
      timeout: TIMEOUT_CONSULTA_MS,
      validateStatus: () => true,
    });
    if (res.status !== 200) {
      const err = new Error(this.mensajeError(res.status, res.data));
      err.status = res.status;
      throw err;
    }
    return res.data;
  }

  // Devuelve el PDF como Buffer (A4 o ticket, según lo configurado en Zensei).
  async obtenerPdf(cfeId) {
    const res = await axios.get(this.ruta(`/cfes/${encodeURIComponent(cfeId)}/pdf`), {
      headers: this.headers(),
      timeout: TIMEOUT_CONSULTA_MS,
      responseType: 'arraybuffer',
      validateStatus: () => true,
    });
    if (res.status !== 200) {
      let data = null;
      try { data = JSON.parse(Buffer.from(res.data).toString('utf8')); } catch (_) { /* no era JSON */ }
      const err = new Error(this.mensajeError(res.status, data));
      err.status = res.status;
      throw err;
    }
    return Buffer.from(res.data);
  }
}

module.exports = new ZenseiService();

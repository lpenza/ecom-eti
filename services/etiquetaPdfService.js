const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs').promises;
const logService = require('./logService');
const marcoPostalWebService = require('./marcoPostalWebService');

const OUTPUT_DIR = path.join(__dirname, '..', 'public', 'etiquetas-marcopostal');
const PUBLIC_URL_BASE = '/etiquetas-marcopostal';
const MP_BASE_URL = process.env.MARCO_POSTAL_WEB_URL || 'https://marcopostal.epresis.com';

class EtiquetaPdfService {
  constructor() {
    this.browser = null;
    this.launchPromise = null;
  }

  async getBrowser() {
    if (this.browser && this.browser.isConnected()) return this.browser;
    if (this.launchPromise) return await this.launchPromise;

    this.launchPromise = puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    }).then((b) => {
      this.browser = b;
      this.launchPromise = null;
      b.on('disconnected', () => {
        if (this.browser === b) this.browser = null;
      });
      return b;
    }).catch((err) => {
      this.launchPromise = null;
      throw err;
    });

    return await this.launchPromise;
  }

  async ensureOutputDir() {
    await fs.mkdir(OUTPUT_DIR, { recursive: true });
  }

  // Carga las cookies del jar de marcoPostalWebService en la page de Puppeteer
  // para que Chromium pueda resolver assets autenticados (CSS/JS/imgs) del dominio MP.
  async injectMarcoPostalCookies(page) {
    await marcoPostalWebService.ensureSession();
    const cookies = await marcoPostalWebService.jar.getCookies(MP_BASE_URL);
    if (!cookies || cookies.length === 0) return;

    const domain = new URL(MP_BASE_URL).hostname;
    const puppeteerCookies = cookies.map((c) => ({
      name: c.key,
      value: c.value,
      domain,
      path: c.path || '/',
      httpOnly: !!c.httpOnly,
      secure: !!c.secure,
      ...(c.expires && c.expires !== 'Infinity'
        ? { expires: Math.floor(new Date(c.expires).getTime() / 1000) }
        : {}),
    }));
    await page.setCookie(...puppeteerCookies);
  }

  // Renderiza la etiqueta de la guía a PDF (100x150mm) y la guarda localmente.
  // La URL pública (imprimir-guia) es un VISOR que contiene un iframe con el
  // contenido real. Si no entramos directo al iframe, el PDF sale en blanco.
  async renderEtiquetaMarcoPostal(guiaId) {
    if (!guiaId) throw new Error('guiaId requerido');

    await this.ensureOutputDir();
    const outFile = path.join(OUTPUT_DIR, `${guiaId}.pdf`);
    const publicUrl = `${PUBLIC_URL_BASE}/${guiaId}.pdf`;

    // URL exacta capturada: %20 (espacio) prefijado al guia_id
    const externalUrl = `${MP_BASE_URL}/guias/remito/imprimir-guia?url=ETIQUETA_100X150_HTML&guia_id=%20${encodeURIComponent(guiaId)}`;

    const browser = await this.getBrowser();
    const page = await browser.newPage();

    try {
      await this.injectMarcoPostalCookies(page);

      logService.info('EtiquetaPDF — abriendo visor', { guiaId, externalUrl });

      const resp = await page.goto(externalUrl, {
        waitUntil: 'networkidle0',
        timeout: 30000,
      });
      if (!resp || !resp.ok()) {
        throw new Error(`MarcoPostal devolvió HTTP ${resp ? resp.status() : 'sin respuesta'}`);
      }

      if (page.url().includes('/login')) {
        throw new Error('Sesión MarcoPostal expirada durante render PDF');
      }

      // El visor puede tener un <iframe> o el contenido directo en el body.
      // Probamos primero iframe; si no, renderizamos la página tal cual.
      const layout = await page.evaluate(() => {
        const iframe = document.querySelector('iframe');
        const bodyText = (document.body?.innerText || '').trim();
        return {
          iframeSrc: iframe ? iframe.src || iframe.getAttribute('src') : null,
          bodyTextLen: bodyText.length,
          bodyTextSnippet: bodyText.slice(0, 300),
          hasRemitente: /remitente/i.test(bodyText),
          hasDestinatario: /destinatario/i.test(bodyText),
        };
      });

      logService.info('EtiquetaPDF — layout del visor', {
        guiaId,
        iframe: !!layout.iframeSrc,
        bodyLen: layout.bodyTextLen,
        snippet: layout.bodyTextSnippet,
      });

      if (layout.iframeSrc) {
        const absoluteSrc = layout.iframeSrc.startsWith('http')
          ? layout.iframeSrc
          : `${MP_BASE_URL}${layout.iframeSrc.startsWith('/') ? '' : '/'}${layout.iframeSrc}`;
        logService.info('EtiquetaPDF — navegando al iframe interno', { iframeSrc: absoluteSrc });
        const innerResp = await page.goto(absoluteSrc, {
          waitUntil: 'networkidle0',
          timeout: 30000,
        });
        if (!innerResp || !innerResp.ok()) {
          throw new Error(`Iframe devolvió HTTP ${innerResp ? innerResp.status() : 'sin respuesta'}`);
        }
        if (page.url().includes('/login')) {
          throw new Error('Sesión MarcoPostal expirada al cargar iframe');
        }
      } else if (!layout.hasRemitente && !layout.hasDestinatario && layout.bodyTextLen < 100) {
        // Sin iframe Y sin contenido reconocible → la guiaId probablemente no existe en MP.
        throw new Error(
          `Visor sin contenido de etiqueta (guiaId="${guiaId}" inválido?). bodyLen=${layout.bodyTextLen}, snippet="${layout.bodyTextSnippet}"`
        );
      }
      // Si llegamos acá sin iframe pero con contenido REMITENTE/DESTINATARIO, renderizamos
      // la página tal cual.

      // Ocultar botones / navbar y resetear márgenes. Renderizamos en A4 para
      // que las etiquetas MarcoPostal coincidan con el formato UES (210x297mm).
      await page.addStyleTag({
        content: `
          @page { size: A4; margin: 0; }
          html, body { margin: 0 !important; padding: 0 !important; }
          button, .btn, .navbar, header, nav, .no-print,
          [onclick*="print"], [onclick*="close"] { display: none !important; }
        `,
      });
      await page.evaluate(() => {
        const sel = 'button, .btn, .navbar, header, nav, .no-print';
        document.querySelectorAll(sel).forEach((el) => el.remove());
      });

      // Pequeña espera para que terminen fuentes / imágenes embebidas del QR
      await new Promise((r) => setTimeout(r, 400));

      await page.pdf({
        path: outFile,
        format: 'A4',
        // Escala 1.9 → contenido queda ~180mm ancho × ~285mm alto: entra en A4
        // (210×297) con un pequeño margen y sin pasarse de página.
        scale: 1.9,
        margin: { top: '0mm', right: '0mm', bottom: '0mm', left: '0mm' },
        printBackground: true,
        preferCSSPageSize: false,
      });

      logService.info('EtiquetaPDF — PDF guardado', { guiaId, outFile, publicUrl });
      return publicUrl;
    } finally {
      try { await page.close(); } catch (_) {}
    }
  }

  async close() {
    if (this.browser) {
      try { await this.browser.close(); } catch (_) {}
      this.browser = null;
    }
  }
}

module.exports = new EtiquetaPdfService();

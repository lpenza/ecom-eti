const nodemailer = require('nodemailer');

function toBool(value, defaultValue = false) {
  if (value == null) return defaultValue;
  return String(value).trim().toLowerCase() === 'true';
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderTemplate(template, vars, { escapeValues = false } = {}) {
  const source = String(template || '');
  return source.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key) => {
    const value = vars[key] ?? '';
    return escapeValues ? escapeHtml(value) : String(value);
  });
}

function formatPrimerNombre(nombreCompleto) {
  if (!nombreCompleto) return '';
  return String(nombreCompleto).trim().split(/\s+/)[0] || '';
}

function buildTrackingUrl(trackingNumber) {
  return trackingNumber ? 'https://ues.com.uy/rastreo_paquete.html' : '';
}

function toHtmlBody(content) {
  const text = String(content || '').trim();
  const hasHtmlTags = /<\/?[a-z][\s\S]*>/i.test(text);

  if (hasHtmlTags) return text;

  // Si la plantilla se guarda como texto plano, convertir saltos de línea en <br>
  const asHtml = escapeHtml(text).replace(/\n/g, '<br>');
  return `<div style="font-family:Arial,Helvetica,sans-serif;line-height:1.5;color:#222;">${asHtml}</div>`;
}

class EmailService {
  constructor() {
    this.transporter = null;
  }

  getTransporter() {
    if (this.transporter) return this.transporter;

    const host = process.env.SMTP_HOST;
    const port = Number(process.env.SMTP_PORT || 587);
    const user = process.env.SMTP_USER;
    const pass = process.env.SMTP_PASS;
    const secure = toBool(process.env.SMTP_SECURE, port === 465);

    if (!host || !port || !user || !pass) {
      throw new Error('Configuración SMTP incompleta. Definí SMTP_HOST, SMTP_PORT, SMTP_USER y SMTP_PASS.');
    }

    this.transporter = nodemailer.createTransport({
      host,
      port,
      secure,
      auth: { user, pass },
    });

    return this.transporter;
  }

  renderMail({ pedido, subjectTemplate, htmlTemplate, motivoContacto = '' }) {
    const tracking = String(pedido?.numero_seguimiento_ues || '').trim();
    const vars = {
      cliente_nombre: formatPrimerNombre(pedido?.cliente_nombre),
      cliente_email: String(pedido?.cliente_email || '').trim(),
      numero_pedido: pedido?.numero_pedido || pedido?.id || '',
      direccion_envio: pedido?.direccion_envio || '',
      localidad: pedido?.localidad || '',
      departamento: pedido?.departamento || '',
      tracking,
      tracking_url: buildTrackingUrl(tracking),
      motivo_contacto: motivoContacto || pedido?.revision_contacto_motivo || '',
    };

    const subject = renderTemplate(subjectTemplate || 'Seguimiento de tu pedido #{{numero_pedido}}', vars, { escapeValues: false });
    const bodyTemplate = toHtmlBody(htmlTemplate || 'Hola {{cliente_nombre}},\n\nQueríamos contactarte por tu pedido #{{numero_pedido}}.');
    const html = renderTemplate(bodyTemplate, vars, { escapeValues: true });

    return { subject, html };
  }

  async enviarCorreo({ to, subject, html }) {
    const transporter = this.getTransporter();
    const from = process.env.SMTP_FROM || process.env.SMTP_USER;

    if (!from) {
      throw new Error('Falta SMTP_FROM o SMTP_USER para definir remitente');
    }

    const info = await transporter.sendMail({
      from,
      to,
      subject,
      html,
    });

    return {
      messageId: info.messageId,
      accepted: info.accepted || [],
      rejected: info.rejected || [],
    };
  }
}

module.exports = new EmailService();

const axios = require('axios');

function normalizePhoneForWhatsApp(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return '';

  if (digits.startsWith('598')) {
    return `+${digits}`;
  }

  // Fallback Uruguay por defecto
  if (digits.length >= 8) {
    return `+598${digits}`;
  }

  return '';
}

function buildTrackingUrl(trackingNumber) {
  const template = process.env.UES_TRACKING_URL_TEMPLATE || '';
  if (template && trackingNumber) {
    return template.replace('{tracking}', encodeURIComponent(String(trackingNumber)));
  }

  return trackingNumber ? `Tracking: ${trackingNumber}` : '';
}

class NotificationService {
  async sendTrackingEmail(pedido, trackingNumber, trackingUrl) {
    const to = String(pedido?.cliente_email || '').trim();
    if (!to) {
      return { attempted: false, success: false, skippedReason: 'Pedido sin email de cliente' };
    }

    const smtpHost = process.env.SMTP_HOST;
    const smtpPort = Number(process.env.SMTP_PORT || 587);
    const smtpUser = process.env.SMTP_USER;
    const smtpPass = process.env.SMTP_PASS;
    const from = process.env.SMTP_FROM || smtpUser;

    if (!smtpHost || !smtpUser || !smtpPass || !from) {
      return { attempted: false, success: false, skippedReason: 'SMTP no configurado' };
    }

    let nodemailer;
    try {
      nodemailer = require('nodemailer');
    } catch (error) {
      return {
        attempted: false,
        success: false,
        skippedReason: 'Dependencia nodemailer no instalada',
      };
    }

    try {
      const transporter = nodemailer.createTransport({
        host: smtpHost,
        port: smtpPort,
        secure: String(process.env.SMTP_SECURE || '').toLowerCase() === 'true' || smtpPort === 465,
        auth: {
          user: smtpUser,
          pass: smtpPass,
        },
      });

      const orderNumber = pedido?.numero_pedido || pedido?.numero_orden || pedido?.id;
      const subject = `Tu pedido ${orderNumber} ya fue despachado`;
      const text = [
        `Hola ${pedido?.cliente_nombre || 'cliente'},`,
        '',
        `Tu pedido ${orderNumber} ya fue despachado.`,
        `Numero de seguimiento: ${trackingNumber || '-'}`,
        trackingUrl ? `Seguimiento: ${trackingUrl}` : '',
        '',
        'Gracias por tu compra.',
      ].filter(Boolean).join('\n');

      const html = `
        <p>Hola ${pedido?.cliente_nombre || 'cliente'},</p>
        <p>Tu pedido <strong>${orderNumber}</strong> ya fue despachado.</p>
        <p><strong>Numero de seguimiento:</strong> ${trackingNumber || '-'}</p>
        ${trackingUrl ? `<p><a href="${trackingUrl}" target="_blank" rel="noreferrer">Ver seguimiento</a></p>` : ''}
        <p>Gracias por tu compra.</p>
      `;

      await transporter.sendMail({ from, to, subject, text, html });
      return { attempted: true, success: true };
    } catch (error) {
      return { attempted: true, success: false, error: error.message };
    }
  }

  async sendTrackingWhatsApp(pedido, trackingNumber, trackingUrl) {
    const toPhone = normalizePhoneForWhatsApp(pedido?.cliente_telefono);
    if (!toPhone) {
      return { attempted: false, success: false, skippedReason: 'Pedido sin telefono valido' };
    }

    const provider = String(process.env.WHATSAPP_PROVIDER || 'twilio').toLowerCase();

    if (provider === 'meta') {
      const token = process.env.WHATSAPP_META_TOKEN;
      const phoneNumberId = process.env.WHATSAPP_META_PHONE_NUMBER_ID;

      if (!token || !phoneNumberId) {
        return { attempted: false, success: false, skippedReason: 'WhatsApp Meta no configurado' };
      }

      try {
        const orderNumber = pedido?.numero_pedido || pedido?.numero_orden || pedido?.id;
        const bodyLines = [
          `Hola ${pedido?.cliente_nombre || ''}, tu pedido ${orderNumber} fue despachado.`,
          `Tracking: ${trackingNumber || '-'}`,
          trackingUrl || '',
        ].filter(Boolean);

        await axios.post(
          `https://graph.facebook.com/v21.0/${phoneNumberId}/messages`,
          {
            messaging_product: 'whatsapp',
            to: toPhone.replace('+', ''),
            type: 'text',
            text: {
              body: bodyLines.join('\n'),
            },
          },
          {
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
            },
            timeout: 20000,
          }
        );

        return { attempted: true, success: true };
      } catch (error) {
        return { attempted: true, success: false, error: error.message };
      }
    }

    const sid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    const from = process.env.TWILIO_WHATSAPP_FROM;

    if (!sid || !authToken || !from) {
      return { attempted: false, success: false, skippedReason: 'WhatsApp Twilio no configurado' };
    }

    try {
      const orderNumber = pedido?.numero_pedido || pedido?.numero_orden || pedido?.id;
      const bodyLines = [
        `Hola ${pedido?.cliente_nombre || ''}, tu pedido ${orderNumber} fue despachado.`,
        `Tracking: ${trackingNumber || '-'}`,
        trackingUrl || '',
      ].filter(Boolean);

      const form = new URLSearchParams();
      form.append('To', `whatsapp:${toPhone}`);
      form.append('From', from.startsWith('whatsapp:') ? from : `whatsapp:${from}`);
      form.append('Body', bodyLines.join('\n'));

      await axios.post(
        `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
        form,
        {
          auth: { username: sid, password: authToken },
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          timeout: 20000,
        }
      );

      return { attempted: true, success: true };
    } catch (error) {
      return { attempted: true, success: false, error: error.message };
    }
  }

  async notificarTracking(pedido, options = {}) {
    const trackingNumber = options.trackingNumber || pedido?.numero_seguimiento_ues || '';
    const trackingUrl = buildTrackingUrl(trackingNumber);

    const tieneEmail = Boolean(String(pedido?.cliente_email || '').trim());
    const tienePhone = Boolean(normalizePhoneForWhatsApp(pedido?.cliente_telefono));

    let email, whatsapp;
    let handledByShopifyEmail = false;

    if (tieneEmail) {
      // Si hay email, Shopify ya notifica al cliente (notify_customer=true)
      handledByShopifyEmail = true;
      email = {
        attempted: false,
        success: true,
        skippedReason: 'Notificacion por email gestionada por Shopify',
      };
      whatsapp = {
        attempted: false,
        success: false,
        skippedReason: 'Cliente con email, no se envia WhatsApp desde la app',
      };
    } else if (tienePhone) {
      // Sin email, pero con telefono: enviar por WhatsApp desde la app
      whatsapp = await this.sendTrackingWhatsApp(pedido, trackingNumber, trackingUrl);
      email = {
        attempted: false,
        success: false,
        skippedReason: 'Sin email, se usa WhatsApp como canal principal',
      };
    } else {
      // Sin email ni telefono valido: no hay canal de contacto
      email = {
        attempted: false,
        success: false,
        skippedReason: 'Pedido sin email de cliente',
      };
      whatsapp = {
        attempted: false,
        success: false,
        skippedReason: 'Pedido sin telefono valido',
      };
    }

    return {
      email,
      whatsapp,
      anySent: Boolean(whatsapp.success),
      handledByShopifyEmail,
      canal: handledByShopifyEmail ? 'shopify-email' : (tienePhone ? 'whatsapp' : 'ninguno'),
      trackingNumber,
      trackingUrl,
    };
  }
}

module.exports = new NotificationService();

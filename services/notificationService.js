/**
 * Servicio simplificado de WhatsApp - solo genera links de WhatsApp Web
 * No envía mensajes automáticamente, sino que genera URLs para abrir manualmente
 */

function formatPrimerNombre(nombreCompleto) {
  if (!nombreCompleto) return '';
  return String(nombreCompleto).trim().split(/\s+/)[0];
}

function buildTrackingUrl(trackingNumber) {
  return trackingNumber ? `https://ues.com.uy/rastreo_paquete.html` : '';
}

function renderTemplate(templateContent, pedido) {
  const trackingNumber = pedido?.numero_seguimiento_ues || pedido?.tracking || '';
  const trackingUrl = buildTrackingUrl(trackingNumber);
  
  if (!templateContent) {
    // Fallback message
    const orderNumber = pedido?.numero_pedido || pedido?.id;
    const primerNombre = formatPrimerNombre(pedido?.cliente_nombre);
    return `Hola ${primerNombre}!\n\nTu pedido #${orderNumber} fue despachado.\n\nTracking: ${trackingNumber}\nLink: ${trackingUrl}`;
  }

  const orderNumber = pedido?.numero_pedido || pedido?.id;
  const primerNombre = formatPrimerNombre(pedido?.cliente_nombre);
  
  return String(templateContent)
    .replace(/\{\{cliente_nombre\}\}/g, primerNombre)
    .replace(/\{\{numero_pedido\}\}/g, orderNumber || '')
    .replace(/\{\{tracking\}\}/g, trackingNumber || '')
    .replace(/\{\{tracking_url\}\}/g, trackingUrl || '');
}

function generarLinkWhatsApp(pedido, templateContent) {
  try {
    // Limpiar y normalizar teléfono
    const numeroLimpio = String(pedido?.telefono || '').replace(/\D/g, '');
    if (!numeroLimpio) {
      throw new Error('Pedido sin teléfono válido');
    }

    const numeroCompleto = numeroLimpio.startsWith('598') ? numeroLimpio : `598${numeroLimpio}`;
    
    // Renderizar mensaje con plantilla
    const mensaje = renderTemplate(templateContent, pedido);
    
    // Generar link de WhatsApp Web con URL encoding para emojis
    const whatsappUrl = `https://api.whatsapp.com/send?phone=${numeroCompleto}&text=${encodeURIComponent(mensaje)}`;
    
    return { success: true, url: whatsappUrl, phone: numeroCompleto };
  } catch (error) {
    console.error('❌ Error al generar link de WhatsApp:', error.message);
    return { success: false, error: error.message };
  }
}

module.exports = { generarLinkWhatsApp };


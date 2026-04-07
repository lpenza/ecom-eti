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

function formatDate(isoDate) {
  if (!isoDate) return '';
  const d = new Date(isoDate);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('es-UY');
}

function calcularDiasTranscurridos(pedido) {
  if (pedido?.followup_days_elapsed != null) {
    return String(pedido.followup_days_elapsed);
  }

  const createdAt = pedido?.created_at;
  if (!createdAt) return '';

  const inicio = new Date(createdAt);
  if (Number.isNaN(inicio.getTime())) return '';

  const diffMs = Date.now() - inicio.getTime();
  const dias = Math.max(0, Math.floor(diffMs / (1000 * 60 * 60 * 24)));
  return String(dias);
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

  const vars = {
    cliente_nombre: primerNombre,
    numero_pedido: orderNumber || '',
    tracking: trackingNumber || '',
    tracking_url: trackingUrl || '',
    dias_transcurridos: calcularDiasTranscurridos(pedido),
    fecha_objetivo: formatDate(pedido?.followup_target_date),
  };

  return String(templateContent).replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key) => {
    return vars[key] ?? '';
  });
}

function generarLinkWhatsApp(pedido, templateContent) {
  try {
    // Limpiar y normalizar teléfono
    const telefonoBase = pedido?.telefono || pedido?.cliente_telefono || '';
    const numeroLimpio = String(telefonoBase).replace(/\D/g, '');
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


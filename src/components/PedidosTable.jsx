import React from 'react';

function PedidosTable({ 
  pedidos, 
  selectedPedidos, 
  onToggleSelect, 
  onToggleSelectAll,
  onReenviarNotificacion,
  onContactarPendiente,
  onMarcarNotificado,
  onDescargarEtiqueta,
  onDescartarEtiqueta,
  fulfillmentPreview,
  channelPriority = 'email',
  showNotifyColumn = true,
  showTrackingColumn = true,
  activeTrackingTemplate,
  activeContactTemplate,
  modoPendienteContacto = false,
}) {
  const allSelected = pedidos.length > 0 && selectedPedidos.length === pedidos.length;

  const pedidosOrdenados = [...pedidos].sort((a, b) => {
    const numA = parseInt(String(a.numero_pedido || '').replace(/\D/g, ''), 10) || 0;
    const numB = parseInt(String(b.numero_pedido || '').replace(/\D/g, ''), 10) || 0;
    return numB - numA;
  });

  return (
    <div className="table-container">
      {fulfillmentPreview && (
        <div className="fulfillment-preview-banner">
          📨 Mostrando {pedidos.length} pedido(s) para enviar tracking — confirmá o cancelá arriba
        </div>
      )}
      <div className="table-scroll">
        <table className="pedidos-table">
          <thead>
            <tr>
              <th>
                <input 
                  type="checkbox" 
                  checked={allSelected}
                  onChange={onToggleSelectAll}
                />
              </th>
              <th>N° Orden</th>
              <th>Cliente</th>
              <th>Dirección</th>
              <th>Estado</th>
              {showTrackingColumn && <th>Seguimiento</th>}
              {showNotifyColumn && <th>Notificar</th>}
            </tr>
          </thead>
          <tbody>
            {pedidosOrdenados.length === 0 ? (
              <tr>
                <td colSpan={5 + (showTrackingColumn ? 1 : 0) + (showNotifyColumn ? 1 : 0)} className="table-empty-state">
                  No hay pedidos para mostrar
                </td>
              </tr>
            ) : (
              pedidosOrdenados.map(pedido => (
                <PedidoRow
                  key={pedido.id}
                  pedido={pedido}
                  isSelected={selectedPedidos.includes(pedido.id)}
                  onToggleSelect={() => onToggleSelect(pedido.id)}
                  onReenviarNotificacion={onReenviarNotificacion}
                  onContactarPendiente={onContactarPendiente}
                  onMarcarNotificado={onMarcarNotificado}
                  onDescargarEtiqueta={onDescargarEtiqueta}
                  onDescartarEtiqueta={onDescartarEtiqueta}
                  fulfillmentPreview={fulfillmentPreview}
                  channelPriority={channelPriority}
                  showNotifyColumn={showNotifyColumn}
                  showTrackingColumn={showTrackingColumn}
                  activeTrackingTemplate={activeTrackingTemplate}
                  activeContactTemplate={activeContactTemplate}
                  modoPendienteContacto={modoPendienteContacto}
                />
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function PedidoRow({ pedido, isSelected, onToggleSelect, onReenviarNotificacion, onContactarPendiente, onMarcarNotificado, onDescargarEtiqueta, onDescartarEtiqueta, fulfillmentPreview = false, channelPriority = 'email', showNotifyColumn = true, showTrackingColumn = true, activeTrackingTemplate, activeContactTemplate, modoPendienteContacto = false }) {
  const estadoClass = pedido.estado === 'procesado' ? 'badge-success' : 'badge-warning';
  const tieneRevisionContacto = Boolean(pedido.revision_contacto_pendiente);
  const estadoText = pedido.estado === 'procesado' ? 'Procesado' : 
                     pedido.estado === 'etiqueta_generada' ? 'Etiqueta Generada' : 
                     pedido.estado === 'enviado' ? 'Enviado' :
                     'Pendiente';

  const fueNotificado = Boolean(pedido.notificacion_enviada_at);
  const puedeDescartarEtiqueta = Boolean(pedido.etiqueta_generada) && !fueNotificado;
  const puedeDescargarEtiqueta = Boolean(String(pedido.link_etiqueta_drive || '').trim());
  const ultimoContactoAt = pedido.revision_contacto_ultimo_contacto_at || null;

  // Detectar si es pedido de WhatsApp en base a la prioridad configurada
  const tieneEmail = Boolean(String(pedido?.cliente_email || '').trim());
  const tienePhone = Boolean(String(pedido?.cliente_telefono || '').trim());
  const sinCanal = !tieneEmail && !tienePhone;
  
  let esWhatsApp = false;
  if (channelPriority === 'whatsapp') {
    // Prioridad WhatsApp: si tiene phone, usa wpp aunque tenga email
    esWhatsApp = tienePhone;
  } else {
    // Prioridad Email (default): solo usa wpp si NO tiene email
    esWhatsApp = !tieneEmail && tienePhone;
  }

  const handleNotificar = async () => {
    if (esWhatsApp) {
      console.log('🔵 Botón WhatsApp clickeado, pedido ID:', pedido.id);
      console.log('🔵 onMarcarNotificado disponible?', !!onMarcarNotificado);
      
      // Abrir WhatsApp con la plantilla activa de tracking
      const phoneNormalized = String(pedido.cliente_telefono || '')
        .replace(/\D/g, '')
        .replace(/^0+/, '');
      
      const phone = phoneNormalized.startsWith('598') 
        ? phoneNormalized 
        : `598${phoneNormalized}`;

      // Usar la plantilla activa de tracking
      const nombreCompleto = pedido.cliente_nombre || '';
      const primerNombre = nombreCompleto.trim().split(/\s+/)[0] || '';
      const trackingNumber = pedido.numero_seguimiento_ues || '';
      const trackingUrl = 'https://ues.com.uy/rastreo_paquete.html';

      // Renderizar la plantilla con las variables
      let mensaje = activeTrackingTemplate?.content || 
        `Hola ${primerNombre}!\n\nTu pedido ya está en camino.\n\n📦 Tracking: ${trackingNumber}\n🔗 ${trackingUrl}`;

      mensaje = mensaje
        .replace(/\{\{cliente_nombre\}\}/g, primerNombre)
        .replace(/\{\{numero_pedido\}\}/g, pedido.numero_pedido || '')
        .replace(/\{\{tracking\}\}/g, trackingNumber)
        .replace(/\{\{tracking_url\}\}/g, trackingUrl);
      
      const whatsappUrl = `https://api.whatsapp.com/send?phone=${phone}&text=${encodeURIComponent(mensaje)}`;
      window.open(whatsappUrl, '_blank');
      
      // Marcar como notificado
      if (onMarcarNotificado) {
        console.log('🔵 Llamando a onMarcarNotificado...');
        try {
          await onMarcarNotificado(pedido.id);
          console.log('✅ Pedido marcado como notificado exitosamente');
        } catch (error) {
          console.error('❌ Error al marcar como notificado:', error);
        }
      } else {
        console.warn('⚠️ onMarcarNotificado no está definido');
      }
    } else {
      // Comportamiento normal: llamar API
      onReenviarNotificacion?.(pedido.id);
    }
  };

  const handleContactoRapido = () => {
    onContactarPendiente?.(pedido.id);
  };

  const formatUltimoContacto = (iso) => {
    if (!iso) return '';
    const fecha = new Date(iso);
    if (Number.isNaN(fecha.getTime())) return '';
    return fecha.toLocaleString('es-UY', {
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  return (
    <tr className={fueNotificado ? 'pedidos-row-notified' : ''}>
      <td>
        <input 
          type="checkbox" 
          checked={isSelected}
          onChange={onToggleSelect}
        />
      </td>
      <td>
        <span className="pedido-number-cell">
          {fueNotificado && <span className="pedido-notified-check">✓</span>}
          <span>{pedido.numero_pedido || pedido.id?.substring(0, 8)}</span>
        </span>
      </td>
      <td>{pedido.cliente_nombre || 'Sin nombre'}</td>
      <td>{pedido.direccion_envio || 'Sin dirección'}</td>
      <td>
        <span className={`badge ${tieneRevisionContacto ? 'badge-danger' : estadoClass}`}>{tieneRevisionContacto ? 'Pendiente Contacto' : estadoText}</span>
      </td>
      {showTrackingColumn && <td>{pedido.numero_seguimiento_ues || '-'}</td>}
      {showNotifyColumn && (
        <td>
          <div className="pedido-actions-cell">
            {fueNotificado && (
              <span className="pedido-notified-label">
                Notificado ✓
              </span>
            )}
            {!fueNotificado && sinCanal ? (
              <span className="pedido-manual-review-label">
                ⚠️ Revision manual
              </span>
            ) : modoPendienteContacto ? (
              <>
                {tienePhone ? (
                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={handleContactoRapido}
                    title={`Abrir WhatsApp con plantilla: ${activeContactTemplate?.name || 'Mensaje por defecto'}`}
                  >
                    💬 Contactar
                  </button>
                ) : (
                  <span className="pedido-email-label" title="Se enviará por email masivo">
                    ✉️ Email
                  </span>
                )}
                {ultimoContactoAt && (
                  <span className="pedido-notified-label" title={`Ultimo contacto: ${formatUltimoContacto(ultimoContactoAt)}`}>
                    ✅ Contactado {formatUltimoContacto(ultimoContactoAt)}
                  </span>
                )}
              </>
            ) : esWhatsApp ? (
              <button
                className="btn btn-secondary btn-sm"
                onClick={handleNotificar}
                disabled={!pedido.numero_seguimiento_ues}
                title={!pedido.numero_seguimiento_ues ? 'Sin tracking para notificar' : 'Abrir WhatsApp con mensaje de tracking'}
              >
                💬 Notificar
              </button>
            ) : (
              <span className="pedido-email-label">
                📧 Shopify notifica
              </span>
            )}
            {puedeDescartarEtiqueta && !fulfillmentPreview && (
              <button
                className="btn btn-secondary btn-sm"
                onClick={() => onDescargarEtiqueta?.(pedido.id)}
                disabled={!puedeDescargarEtiqueta}
                title={puedeDescargarEtiqueta ? 'Descargar etiqueta generada' : 'Esta etiqueta no tiene PDF disponible'}
              >
                📄 Descargar
              </button>
            )}
            {puedeDescartarEtiqueta && !fulfillmentPreview && (
              <button
                className="btn btn-outline-danger btn-sm"
                onClick={() => onDescartarEtiqueta?.(pedido.id)}
                title="Descartar esta etiqueta y volver a validacion"
              >
                ↩️ Descartar
              </button>
            )}
          </div>
        </td>
      )}
    </tr>
  );
}

export default PedidosTable;

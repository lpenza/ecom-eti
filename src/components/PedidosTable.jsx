import React from 'react';

function PedidosTable({ 
  pedidos, 
  selectedPedidos, 
  onToggleSelect, 
  onToggleSelectAll,
  onReenviarNotificacion,
  onMarcarNotificado,
  fulfillmentPreview,
  channelPriority = 'email',
  showNotifyColumn = true,
  showTrackingColumn = true
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
                <td colSpan={showNotifyColumn && showTrackingColumn ? "7" : showNotifyColumn || showTrackingColumn ? "6" : "5"} className="table-empty-state">
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
                  onMarcarNotificado={onMarcarNotificado}
                  channelPriority={channelPriority}
                  showNotifyColumn={showNotifyColumn}
                  showTrackingColumn={showTrackingColumn}
                />
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function PedidoRow({ pedido, isSelected, onToggleSelect, onReenviarNotificacion, onMarcarNotificado, channelPriority = 'email', showNotifyColumn = true, showTrackingColumn = true }) {
  const estadoClass = pedido.estado === 'procesado' ? 'badge-success' : 'badge-warning';
  const estadoText = pedido.estado === 'procesado' ? 'Procesado' : 
                     pedido.estado === 'etiqueta_generada' ? 'Etiqueta Generada' : 
                     pedido.estado === 'enviado' ? 'Enviado' :
                     'Pendiente';

  const fueNotificado = Boolean(pedido.notificacion_enviada_at);

  // Detectar si es pedido de WhatsApp en base a la prioridad configurada
  const tieneEmail = Boolean(String(pedido?.cliente_email || '').trim());
  const tienePhone = Boolean(String(pedido?.cliente_telefono || '').trim());
  
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
      
      // Abrir WhatsApp con mensaje precargado
      const phoneNormalized = String(pedido.cliente_telefono || '')
        .replace(/\D/g, '')
        .replace(/^0+/, '');
      
      const phone = phoneNormalized.startsWith('598') 
        ? phoneNormalized 
        : `598${phoneNormalized}`;

      const nombre = pedido.cliente_nombre || '';
      const trackingNumber = pedido.numero_seguimiento_ues || '';
      const trackingUrl = 'https://ues.com.uy/rastreo_paquete.html';

      // Construir mensaje sin template literals para mejor compatibilidad de emojis
      const lineas = [
        'Hola ' + nombre + ' 💜 Te escribe Flor de Velinne 💅',
        '',
        '¡Tu pedido ya está en camino! 🚚✨',
        '',
        'Te dejo los datos para que puedas seguirlo cuando quieras:',
        '',
        '📦 Número de seguimiento: ' + trackingNumber,
        '🔗 Link de rastreo: ' + trackingUrl,
        '',
        '💅 Recomendación:',
        'Para una correcta aplicación y un mejor resultado, te recomendamos visitar nuestra guía paso a paso sobre cómo colocar las uñas en el siguiente enlace:',
        '👉 https://www.velinneuy.com/pages/como-aplicar',
        '',
        'Gracias por confiar en nosotras 💫',
        '¡Que lo disfrutes mucho! 💜'
      ];
      
      const mensaje = lineas.join('\n');
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
        <span className={`badge ${estadoClass}`}>{estadoText}</span>
      </td>
      {showTrackingColumn && <td>{pedido.numero_seguimiento_ues || '-'}</td>}
      {showNotifyColumn && (
        <td>
          {fueNotificado && (
            <span className="pedido-notified-label">
              Notificado ✓
            </span>
          )}
          {esWhatsApp ? (
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
        </td>
      )}
    </tr>
  );
}

export default PedidosTable;

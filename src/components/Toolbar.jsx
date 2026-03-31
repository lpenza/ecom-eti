import React from 'react';

function Toolbar({ onSincronizar, onValidar, onFulfillment, onConfirmarFulfillment, onCancelarFulfillment, fulfillmentPreviewCount, fulfillmentPreviewTotalCount, fulfillmentReadyCount, notifPreview, notifChannelFilter, onNotifChannelFilter, channelPriority, onChannelPriorityChange, pendingCount, uesAuthenticated }) {

  const handleChipClick = (canal) => {
    onNotifChannelFilter?.(notifChannelFilter === canal ? null : canal);
  };

  return (
    <div className="toolbar">
      <button className="btn btn-primary" onClick={onSincronizar}>
        1) 🔄 Sincronizar Shopify
      </button>
      <button 
        className="btn btn-success" 
        onClick={onValidar}
        disabled={pendingCount === 0 || !uesAuthenticated}
      >
        2) ✅ Validar Pedidos
      </button>

      {fulfillmentPreviewCount !== null ? (
        <>
          {notifPreview && (
            <div className="notif-preview-chips">
              <button
                type="button"
                className={`notif-chip notif-chip-email ${notifChannelFilter === 'email' ? 'notif-chip-active' : ''}`}
                onClick={() => handleChipClick('email')}
              >
                {channelPriority === 'email' ? '📧' : '📩'} {notifPreview.shopifyEmail} email {channelPriority === 'email' ? '(Shopify)' : '(app)'}
              </button>
              <button
                type="button"
                className={`notif-chip notif-chip-wpp ${notifChannelFilter === 'whatsapp' ? 'notif-chip-active' : ''}`}
                onClick={() => handleChipClick('whatsapp')}
              >
                💬 {notifPreview.whatsapp} WhatsApp
              </button>
              {notifPreview.noChannel > 0 && (
                <button
                  type="button"
                  className={`notif-chip notif-chip-none ${notifChannelFilter === 'noChannel' ? 'notif-chip-active' : ''}`}
                  onClick={() => handleChipClick('noChannel')}
                >
                  ⚠️ {notifPreview.noChannel} sin canal
                </button>
              )}
            </div>
          )}
          <button className="btn btn-success" onClick={onConfirmarFulfillment}>
            3) 📨 Confirmar Envio Tracking ({fulfillmentPreviewCount}/{fulfillmentPreviewTotalCount})
          </button>
          <button className="btn btn-secondary" onClick={onCancelarFulfillment}>
            ✗ Cancelar
          </button>
        </>
      ) : (
        <>
          <button className="btn btn-primary" onClick={onFulfillment} disabled={fulfillmentReadyCount === 0}>
            3) 📨 Enviar Tracking {fulfillmentReadyCount > 0 && `(${fulfillmentReadyCount})`}
          </button>
          
          {/* Control de prioridad de canal */}
          <div className="channel-priority-control">
            <label style={{ marginRight: '8px', fontSize: '0.9em' }}>Prioridad:</label>
            <button
              className={`btn btn-sm ${channelPriority === 'email' ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => onChannelPriorityChange?.('email')}
              title="Priorizar email (Shopify notifica automáticamente)"
            >
              📧 Email
            </button>
            <button
              className={`btn btn-sm ${channelPriority === 'whatsapp' ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => onChannelPriorityChange?.('whatsapp')}
              title="Priorizar WhatsApp (notificación manual)"
              style={{ marginLeft: '4px' }}
            >
              💬 WhatsApp
            </button>
          </div>
        </>
      )}
    </div>
  );
}

export default Toolbar;

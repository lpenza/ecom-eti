import React from 'react';

function Toolbar({ onSincronizar, onValidar, onFulfillment, onConfirmarFulfillment, onCancelarFulfillment, fulfillmentPreviewCount, fulfillmentPreviewTotalCount, fulfillmentReadyCount, notifPreview, notifChannelFilter, onNotifChannelFilter, channelPriority, onChannelPriorityChange, pendingCount, uesAuthenticated, activeTrackingTemplate, templates, onTrackingTemplateChange }) {

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
            <label className="channel-priority-label">Prioridad:</label>
            <button
              className={`btn btn-sm ${channelPriority === 'email' ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => onChannelPriorityChange?.('email')}
              title="Priorizar email (Shopify notifica automáticamente)"
            >
              📧 Email
            </button>
            <button
              className={`btn btn-sm channel-priority-option ${channelPriority === 'whatsapp' ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => onChannelPriorityChange?.('whatsapp')}
              title="Priorizar WhatsApp (notificación manual)"
            >
              💬 WhatsApp
            </button>
          </div>
          
          {/* Indicador de plantilla activa */}
          {activeTrackingTemplate && templates && templates.length > 0 && (
            <div className="active-template-selector">
              <label>📋 Plantilla:</label>
              <select 
                value={activeTrackingTemplate.id} 
                onChange={(e) => onTrackingTemplateChange?.(e.target.value)}
                className="template-selector"
              >
                {templates.map((template) => (
                  <option key={template.id} value={template.id}>
                    {template.name}
                  </option>
                ))}
              </select>
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default Toolbar;

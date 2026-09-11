import React from 'react';

function Toolbar({ onSincronizar, onValidar, onFulfillment, onConfirmarFulfillment, onCancelarFulfillment, fulfillmentPreviewCount, fulfillmentPreviewTotalCount, fulfillmentReadyCount, notifPreview, notifChannelFilter, onNotifChannelFilter, channelPriority, onChannelPriorityChange, pendingCount, uesAuthenticated, validarLabel = '1) ✅ Validar Pedidos', validarRequiereUes = true, activeTrackingTemplate, templates, onTrackingTemplateChange, onSincronizarML, mlEstado, soloMercadoLibre = false }) {

  const handleChipClick = (canal) => {
    onNotifChannelFilter?.(notifChannelFilter === canal ? null : canal);
  };

  // El botón de ML sólo aparece si hay credenciales cargadas. Si la app todavía
  // no fue autorizada, el clic abre el OAuth en vez de sincronizar.
  const mlVisible = Boolean(onSincronizarML && mlEstado?.configurado);
  const mlConectado = Boolean(mlEstado?.conectado);

  return (
    <div className="toolbar">
      {/* En la pestaña de ML no se valida ni se manda tracking: la etiqueta la
          emite MercadoLibre y es MercadoLibre quien le avisa al comprador. */}
      {!soloMercadoLibre && (
        <button
          className="btn btn-success"
          onClick={onValidar}
          disabled={pendingCount === 0 || (validarRequiereUes && !uesAuthenticated)}
        >
          {validarLabel}
        </button>
      )}

      {mlVisible && (
        <button
          className={`btn ${mlConectado ? 'btn-secondary' : 'btn-primary'}`}
          onClick={onSincronizarML}
          title={mlConectado
            ? `Traer ventas de MercadoLibre (${mlEstado.nickname || mlEstado.sellerId}) y bajar sus etiquetas`
            : `Conectar la cuenta de MercadoLibre — ${mlEstado?.motivo || 'sin autorizar'}`}
        >
          {mlConectado ? '🛒 Sincronizar ML' : '🔌 Conectar MercadoLibre'}
        </button>
      )}

      {/* Todo el bloque de tracking (enviar, prioridad de canal, plantilla)
          se oculta en la pestana de ML: a esos compradores les avisa ML. */}
      {!soloMercadoLibre && (fulfillmentPreviewCount !== null ? (
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
            2) 📨 Confirmar Envio Tracking ({fulfillmentPreviewCount}/{fulfillmentPreviewTotalCount})
          </button>
          <button className="btn btn-secondary" onClick={onCancelarFulfillment}>
            ✗ Cancelar
          </button>
        </>
      ) : (
        <>
          <button className="btn btn-primary" onClick={onFulfillment} disabled={fulfillmentReadyCount === 0}>
            2) 📨 Enviar Tracking {fulfillmentReadyCount > 0 && `(${fulfillmentReadyCount})`}
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
              <label>📋 Plantilla tracking:</label>
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
      ))}
    </div>
  );
}

export default Toolbar;

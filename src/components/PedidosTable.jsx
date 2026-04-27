import React, { useState } from 'react';

// Extrae file ID de un link de Drive y devuelve URLs de preview y descarga.
// Funciona con /file/d/{id}/view, /file/d/{id}/edit, webViewLink, etc.
function getDriveUrls(link) {
  if (!link) return null;
  const match = String(link).match(/\/d\/([^/?#]+)/);
  if (match) {
    const id = match[1];
    return {
      previewUrl: `https://drive.google.com/file/d/${id}/preview`,
      downloadUrl: `https://drive.google.com/uc?export=download&id=${id}`,
    };
  }
  // fallback: usar el link tal cual
  return { previewUrl: link, downloadUrl: link };
}

function groupPedidosByTracking(pedidos) {
  const trackingGroups = new Map();
  for (const p of pedidos) {
    const tracking = String(p.numero_seguimiento_ues || '').trim();
    if (!tracking) continue;
    if (!trackingGroups.has(tracking)) trackingGroups.set(tracking, []);
    trackingGroups.get(tracking).push(p);
  }
  const seen = new Set();
  const result = [];
  for (const p of pedidos) {
    const tracking = String(p.numero_seguimiento_ues || '').trim();
    if (!tracking) { result.push(p); continue; }
    if (seen.has(tracking)) continue;
    seen.add(tracking);
    const group = trackingGroups.get(tracking);
    if (group.length === 1) {
      result.push(p);
    } else {
      result.push({
        ...group[0],
        numero_pedido: group.map(g => g.numero_pedido).join(' / '),
        _mergedIds: group.map(g => g.id),
        _isDuplicateTracking: true,
      });
    }
  }
  return result;
}

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
  onProcesarDirecto,
  fulfillmentPreview,
  channelPriority = 'email',
  showNotifyColumn = true,
  showTrackingColumn = true,
  showProcesarButton = false,
  activeTrackingTemplate,
  activeContactTemplate,
  modoPendienteContacto = false,
  allowRedownload = false,
  groupByTracking = false,
}) {
  const [previewPedido, setPreviewPedido] = useState(null);
  // allSelected: true solo si TODOS los de la vista filtrada están seleccionados
  const allSelected = pedidos.length > 0 && pedidos.every(p => selectedPedidos.includes(p.id));

  const pedidosOrdenados = [...pedidos].sort((a, b) => {
    const numA = parseInt(String(a.numero_pedido || '').replace(/\D/g, ''), 10) || 0;
    const numB = parseInt(String(b.numero_pedido || '').replace(/\D/g, ''), 10) || 0;
    return numB - numA;
  });

  const pedidosToRender = groupByTracking ? groupPedidosByTracking(pedidosOrdenados) : pedidosOrdenados;

  const previewUrls = previewPedido ? getDriveUrls(previewPedido.link_etiqueta_drive) : null;

  return (
    <div className="table-container">
      {/* Modal de preview PDF */}
      {previewPedido && (
        <div className="de-modal-overlay" onClick={() => setPreviewPedido(null)}>
          <div className="de-modal" onClick={(e) => e.stopPropagation()}>
            <div className="de-modal-header">
              <span>📄 Etiqueta — Pedido #{previewPedido.numero_pedido}</span>
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                {previewUrls?.downloadUrl && (
                  <a
                    href={previewUrls.downloadUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="btn btn-primary btn-sm"
                  >
                    ⬇️ Descargar PDF
                  </a>
                )}
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={() => setPreviewPedido(null)}
                >
                  ✕ Cerrar
                </button>
              </div>
            </div>
            {previewUrls?.previewUrl
              ? <iframe src={previewUrls.previewUrl} className="de-modal-iframe" title="Etiqueta PDF" />
              : <p className="de-modal-empty">No hay URL de previsualización disponible.</p>
            }
          </div>
        </div>
      )}

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
                  onChange={() => onToggleSelectAll(pedidos)}
                  title={allSelected ? 'Deseleccionar todos' : 'Seleccionar todos los visibles'}
                />
              </th>
              <th>N° Orden</th>
              <th>Cliente</th>
              <th>Dirección</th>
              <th>Estado</th>
              {showTrackingColumn && <th>Seguimiento</th>}
              {showNotifyColumn && <th>Notificar</th>}
              {showProcesarButton && <th>Acción</th>}
            </tr>
          </thead>
          <tbody>
            {pedidosToRender.length === 0 ? (
              <tr>
                <td colSpan={5 + (showTrackingColumn ? 1 : 0) + (showNotifyColumn ? 1 : 0) + (showProcesarButton ? 1 : 0)} className="table-empty-state">
                  No hay pedidos para mostrar
                </td>
              </tr>
            ) : (
              pedidosToRender.map(pedido => {
                const isMerged = Boolean(pedido._mergedIds);
                const isSelected = isMerged
                  ? pedido._mergedIds.every(id => selectedPedidos.includes(id))
                  : selectedPedidos.includes(pedido.id);
                const handleToggle = isMerged
                  ? () => {
                      const allSel = pedido._mergedIds.every(id => selectedPedidos.includes(id));
                      pedido._mergedIds.forEach(id => {
                        const isSel = selectedPedidos.includes(id);
                        if (allSel && isSel) onToggleSelect(id);
                        else if (!allSel && !isSel) onToggleSelect(id);
                      });
                    }
                  : () => onToggleSelect(pedido.id);
                return (
                  <PedidoRow
                    key={pedido._mergedIds ? pedido._mergedIds.join('-') : pedido.id}
                    pedido={pedido}
                    isSelected={isSelected}
                    onToggleSelect={handleToggle}
                    onReenviarNotificacion={onReenviarNotificacion}
                    onContactarPendiente={onContactarPendiente}
                    onMarcarNotificado={onMarcarNotificado}
                    onDescargarEtiqueta={onDescargarEtiqueta}
                    onDescartarEtiqueta={onDescartarEtiqueta}
                    onPreviewEtiqueta={setPreviewPedido}
                    onProcesarDirecto={onProcesarDirecto}
                    fulfillmentPreview={fulfillmentPreview}
                    channelPriority={channelPriority}
                    showNotifyColumn={showNotifyColumn}
                    showTrackingColumn={showTrackingColumn}
                    showProcesarButton={showProcesarButton}
                    activeTrackingTemplate={activeTrackingTemplate}
                    activeContactTemplate={activeContactTemplate}
                    modoPendienteContacto={modoPendienteContacto}
                    allowRedownload={allowRedownload}
                  />
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function PedidoRow({
  pedido,
  isSelected,
  onToggleSelect,
  onReenviarNotificacion,
  onContactarPendiente,
  onMarcarNotificado,
  onDescargarEtiqueta,
  onDescartarEtiqueta,
  onPreviewEtiqueta,
  onProcesarDirecto,
  fulfillmentPreview = false,
  channelPriority = 'email',
  showNotifyColumn = true,
  showTrackingColumn = true,
  showProcesarButton = false,
  activeTrackingTemplate,
  activeContactTemplate,
  modoPendienteContacto = false,
  allowRedownload = false,
}) {
  const estadoClass = pedido.estado === 'procesado' ? 'badge-success' : 'badge-warning';
  const tieneRevisionContacto = Boolean(pedido.revision_contacto_pendiente);
  const estadoText = pedido.estado === 'procesado' ? 'Procesado' :
                     pedido.estado === 'etiqueta_generada' ? 'Etiqueta Generada' :
                     pedido.estado === 'enviado' ? 'Enviado' :
                     'Pendiente';

  const fueNotificado = Boolean(pedido.notificacion_enviada_at);
  const puedeDescartarEtiqueta = Boolean(pedido.etiqueta_generada) && !fueNotificado;
  const driveLink = String(pedido.link_etiqueta_drive || '').trim();
  const tieneEtiquetaDrive = Boolean(driveLink);
  const ultimoContactoAt = pedido.revision_contacto_ultimo_contacto_at || null;

  // Mostrar botones de etiqueta si: tiene etiqueta activa O se permite re-descarga
  const mostrarBotonesEtiqueta = (puedeDescartarEtiqueta || allowRedownload) && !fulfillmentPreview;

  const tieneEmail = Boolean(String(pedido?.cliente_email || '').trim());
  const tienePhone = Boolean(String(pedido?.cliente_telefono || '').trim());
  const sinCanal = !tieneEmail && !tienePhone;

  let esWhatsApp = false;
  if (channelPriority === 'whatsapp') {
    esWhatsApp = tienePhone;
  } else {
    esWhatsApp = !tieneEmail && tienePhone;
  }

  const handleNotificar = async () => {
    if (esWhatsApp) {
      console.log('🔵 Botón WhatsApp clickeado, pedido ID:', pedido.id);
      console.log('🔵 onMarcarNotificado disponible?', !!onMarcarNotificado);

      const phoneNormalized = String(pedido.cliente_telefono || '')
        .replace(/\D/g, '')
        .replace(/^0+/, '');

      const phone = phoneNormalized.startsWith('598')
        ? phoneNormalized
        : `598${phoneNormalized}`;

      const nombreCompleto = pedido.cliente_nombre || '';
      const primerNombre = nombreCompleto.trim().split(/\s+/)[0] || '';
      const trackingNumber = pedido.numero_seguimiento_ues || '';
      const trackingUrl = 'https://ues.com.uy/rastreo_paquete.html';

      let mensaje = activeTrackingTemplate?.content ||
        `Hola ${primerNombre}!\n\nTu pedido ya está en camino.\n\n📦 Tracking: ${trackingNumber}\n🔗 ${trackingUrl}`;

      mensaje = mensaje
        .replace(/\{\{cliente_nombre\}\}/g, primerNombre)
        .replace(/\{\{numero_pedido\}\}/g, pedido.numero_pedido || '')
        .replace(/\{\{tracking\}\}/g, trackingNumber)
        .replace(/\{\{tracking_url\}\}/g, trackingUrl);

      const whatsappUrl = `https://api.whatsapp.com/send?phone=${phone}&text=${encodeURIComponent(mensaje)}`;
      window.open(whatsappUrl, '_blank');

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

  const esReclamo = Boolean(pedido.es_reclamo);
  const esDuplicateTracking = Boolean(pedido._isDuplicateTracking);
  const rowClass = [
    fueNotificado ? 'pedidos-row-notified' : '',
    esReclamo ? 'pedidos-row-reclamo' : '',
    esDuplicateTracking ? 'pedidos-row-duplicate-tracking' : '',
  ].filter(Boolean).join(' ');

  return (
    <tr className={rowClass}>
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
          {esDuplicateTracking && (
            <span className="pedido-duplicate-tracking-badge" title="Estos pedidos comparten el mismo número de seguimiento">
              📦 mismo tracking
            </span>
          )}
          {esReclamo && <span className="pedido-reclamo-badge" title="Pedido con reclamo asociado">🔄 Reclamo</span>}
          {pedido.etiqueta_impresa && <span className="pedido-impresa-badge" title="Etiqueta ya impresa">🖨️</span>}
        </span>
      </td>
      <td>{pedido.cliente_nombre || 'Sin nombre'}</td>
      <td>{pedido.direccion_envio || 'Sin dirección'}</td>
      <td>
        <span className={`badge ${tieneRevisionContacto ? 'badge-danger' : estadoClass}`}>
          {tieneRevisionContacto ? 'Pendiente Contacto' : estadoText}
        </span>
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

            {/* Botones de etiqueta PDF */}
            {mostrarBotonesEtiqueta && (
              <>
                {tieneEtiquetaDrive ? (
                  <div style={{ display: 'flex', gap: '0.3rem' }}>
                    <button
                      className="btn btn-secondary btn-sm"
                      onClick={() => onPreviewEtiqueta?.(pedido)}
                      title="Ver etiqueta PDF en pantalla"
                    >
                      👁 Ver PDF
                    </button>
                    <button
                      className="btn btn-secondary btn-sm"
                      onClick={() => onDescargarEtiqueta?.(pedido.id)}
                      title="Descargar etiqueta PDF"
                    >
                      ⬇️
                    </button>
                  </div>
                ) : (
                  <button
                    className="btn btn-secondary btn-sm"
                    disabled
                    title="Esta etiqueta no tiene PDF disponible"
                  >
                    📄 Sin PDF
                  </button>
                )}
              </>
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

      {/* Columna Acción — solo en vista despachados */}
      {showProcesarButton && (
        <td>
          <button
            className="btn btn-success btn-sm"
            onClick={async () => {
              const ids = pedido._mergedIds || [pedido.id];
              try { await onProcesarDirecto?.(ids); }
              catch (e) { console.error('Error procesando pedido', ids, e); }
            }}
            title={pedido._mergedIds ? `Marcar ${pedido._mergedIds.length} pedidos como procesados` : 'Marcar como procesado (fulfillment ya hecho en Shopify)'}
          >
            ✅ Procesar
          </button>
        </td>
      )}
    </tr>
  );
}

export default PedidosTable;

import React, { useState } from 'react';
import { buscarEtiquetaDrive, guardarLinkDriveEnPedido } from '../services/api';

const DRIVE_FOLDER_URL = 'https://drive.google.com/drive/folders/1lp7dpwdCg49nvqbGhW0efvXGV49q2lWQ';

const ESTADO_LABELS = {
  pendiente:        { label: 'Pendiente',       cls: 'de-estado-pendiente',   icon: '🕐' },
  etiqueta_generada:{ label: 'Etiqueta lista',  cls: 'de-estado-etiqueta',    icon: '📄' },
  despachado:       { label: 'Despachado',       cls: 'de-estado-despachado',  icon: '🚀' },
  enviado:          { label: 'Procesado',        cls: 'de-estado-enviado',     icon: '✅' },
};

function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('es-UY', { day: '2-digit', month: '2-digit', year: '2-digit' });
}

export default function DeliveryEspecialTable({
  pedidos = [],
  tipo,                   // 'pickup_local' | 'recibilo_hoy'
  onMarcarDespachado,     // (pedidoId) => Promise
  onFulfillment,          // (pedidoId) => Promise
  onActualizar,           // () => void
  mostrarToast,
}) {
  const [driveState, setDriveState] = useState({}); // { [pedidoId]: { loading, previewUrl, downloadUrl, webViewLink, fallbackUrl, error } }
  const [previewPedidoId, setPreviewPedidoId] = useState(null);

  const tipoLabel = tipo === 'pickup_local' ? 'Pick-UP' : 'Recibilo Hoy';
  const tipoIcon  = tipo === 'pickup_local' ? '🏪' : '⚡';

  const pedidosOrdenados = [...pedidos].sort((a, b) => {
    const na = parseInt(String(a.numero_pedido || '').replace(/\D/g, ''), 10) || 0;
    const nb = parseInt(String(b.numero_pedido || '').replace(/\D/g, ''), 10) || 0;
    return nb - na;
  });

  const buscarEtiqueta = async (pedido) => {
    const id = pedido.id;
    setDriveState((s) => ({ ...s, [id]: { ...s[id], loading: true, error: null } }));
    try {
      const result = await buscarEtiquetaDrive(pedido.numero_pedido);
      if (result.success) {
        // Guardar link en DB para no buscar de nuevo
        await guardarLinkDriveEnPedido(id, result.webViewLink);
        setDriveState((s) => ({
          ...s,
          [id]: { loading: false, previewUrl: result.previewUrl, downloadUrl: result.downloadUrl, webViewLink: result.webViewLink },
        }));
        mostrarToast?.(`✅ Etiqueta encontrada: ${result.name}`, 'success');
        onActualizar?.();
      } else {
        setDriveState((s) => ({ ...s, [id]: { loading: false, fallbackUrl: result.fallbackUrl, error: result.error } }));
        mostrarToast?.(`⚠️ ${result.error || 'No encontrada'}. Abriendo carpeta Drive…`, 'warning');
        window.open(result.fallbackUrl || DRIVE_FOLDER_URL, '_blank');
      }
    } catch (err) {
      setDriveState((s) => ({ ...s, [id]: { loading: false, error: err.message } }));
      mostrarToast?.('Error buscando etiqueta en Drive', 'error');
    }
  };

  const getEtiquetaUrl = (pedido) => {
    // Prioridad: estado local → link en DB
    const local = driveState[pedido.id];
    if (local?.previewUrl) return { previewUrl: local.previewUrl, downloadUrl: local.downloadUrl };
    if (pedido.link_etiqueta_drive) {
      const match = pedido.link_etiqueta_drive.match(/\/d\/([^/]+)\//);
      if (match) {
        return {
          previewUrl: `https://drive.google.com/file/d/${match[1]}/preview`,
          downloadUrl: `https://drive.google.com/uc?export=download&id=${match[1]}`,
        };
      }
      return { previewUrl: pedido.link_etiqueta_drive, downloadUrl: pedido.link_etiqueta_drive };
    }
    return null;
  };

  return (
    <div className="de-wrapper">

      {/* Preview modal */}
      {previewPedidoId && (() => {
        const pedido = pedidos.find((p) => p.id === previewPedidoId);
        const urls   = pedido ? getEtiquetaUrl(pedido) : null;
        return (
          <div className="de-modal-overlay" onClick={() => setPreviewPedidoId(null)}>
            <div className="de-modal" onClick={(e) => e.stopPropagation()}>
              <div className="de-modal-header">
                <span>📄 Etiqueta — Pedido #{pedido?.numero_pedido}</span>
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  {urls?.downloadUrl && (
                    <a href={urls.downloadUrl} target="_blank" rel="noopener noreferrer"
                      className="btn btn-primary btn-sm">⬇️ Descargar PDF</a>
                  )}
                  <button className="btn btn-secondary btn-sm" onClick={() => setPreviewPedidoId(null)}>✕ Cerrar</button>
                </div>
              </div>
              {urls?.previewUrl
                ? <iframe src={urls.previewUrl} className="de-modal-iframe" title="Etiqueta PDF" />
                : <p className="de-modal-empty">No hay URL de previsualización disponible.</p>
              }
            </div>
          </div>
        );
      })()}

      {pedidosOrdenados.length === 0 ? (
        <div className="de-empty">
          <span style={{ fontSize: '2rem' }}>{tipoIcon}</span>
          <p>No hay pedidos {tipoLabel} pendientes.</p>
        </div>
      ) : (
        <div className="reclamos-table-wrapper">
          <table className="reclamos-table de-table">
            <thead>
              <tr>
                <th>N° Orden</th>
                <th>Cliente</th>
                <th>Teléfono</th>
                <th>Estado</th>
                <th>Fecha</th>
                <th>Etiqueta Drive</th>
                <th>Acciones</th>
              </tr>
            </thead>
            <tbody>
              {pedidosOrdenados.map((pedido) => {
                const ds      = driveState[pedido.id] || {};
                const urls    = getEtiquetaUrl(pedido);
                const estado  = pedido.estado || 'pendiente';
                const eLabel  = ESTADO_LABELS[estado] || { label: estado, cls: '', icon: '🔹' };
                const isDespachado = estado === 'despachado' || estado === 'enviado';

                return (
                  <tr key={pedido.id}>
                    <td><strong>#{pedido.numero_pedido}</strong></td>
                    <td>{pedido.cliente_nombre || '—'}</td>
                    <td>{pedido.cliente_telefono || pedido.cliente_email || '—'}</td>
                    <td>
                      <span className={`reclamo-estado-badge ${eLabel.cls}`}>
                        {eLabel.icon} {eLabel.label}
                      </span>
                    </td>
                    <td>{fmtDate(pedido.created_at)}</td>

                    {/* Etiqueta Drive */}
                    <td className="de-etiqueta-cell">
                      {urls ? (
                        <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap' }}>
                          <button className="btn btn-secondary btn-sm"
                            onClick={() => setPreviewPedidoId(pedido.id)}
                            title="Ver etiqueta en pantalla">
                            👁 Ver
                          </button>
                          <a href={urls.downloadUrl} target="_blank" rel="noopener noreferrer"
                            className="btn btn-secondary btn-sm" title="Descargar PDF">
                            ⬇️ PDF
                          </a>
                        </div>
                      ) : (
                        <button className="btn btn-primary btn-sm"
                          onClick={() => buscarEtiqueta(pedido)}
                          disabled={ds.loading}
                          title="Buscar etiqueta en Google Drive">
                          {ds.loading ? '⏳ Buscando…' : '🔍 Buscar en Drive'}
                        </button>
                      )}
                      {ds.error && !urls && (
                        <a href={ds.fallbackUrl || DRIVE_FOLDER_URL} target="_blank" rel="noopener noreferrer"
                          className="de-drive-fallback">📁 Abrir carpeta</a>
                      )}
                    </td>

                    {/* Acciones */}
                    <td className="reclamo-actions">
                      <button className={`btn btn-sm ${isDespachado ? 'btn-secondary' : 'btn-primary'}`}
                        disabled={isDespachado}
                        title={isDespachado ? 'Ya despachado' : 'Marcar como despachado'}
                        onClick={() => onMarcarDespachado?.(pedido.id)}>
                        🚀 Despachar
                      </button>
                      <button className={`btn btn-sm ${estado === 'enviado' ? 'btn-secondary' : 'btn-primary'}`}
                        disabled={estado === 'enviado'}
                        title={estado === 'enviado' ? 'Fulfillment ya enviado' : 'Enviar fulfillment a Shopify'}
                        onClick={() => onFulfillment?.(pedido.id)}>
                        🏪 Shopify
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

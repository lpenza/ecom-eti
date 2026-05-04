import React, { useState, useCallback } from 'react';
import { buscarEtiquetaDrive, guardarLinkDriveEnPedido, mergePedidosPDF } from '../services/api';

const DRIVE_FOLDER_URL = 'https://drive.google.com/drive/folders/1lp7dpwdCg49nvqbGhW0efvXGV49q2lWQ';

const ESTADO_LABELS = {
  pendiente:         { label: 'Pendiente',      cls: 'de-estado-pendiente',  icon: '🕐' },
  etiqueta_generada: { label: 'Etiqueta lista', cls: 'de-estado-etiqueta',   icon: '📄' },
  despachado:        { label: 'Despachado',      cls: 'de-estado-despachado', icon: '🚀' },
  enviado:           { label: 'Procesado',       cls: 'de-estado-enviado',    icon: '✅' },
};

function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('es-UY', { day: '2-digit', month: '2-digit', year: '2-digit' });
}

function extractDriveFileId(url) {
  if (!url) return null;
  const match = String(url).match(/\/d\/([^/?#]+)/);
  if (match) return match[1];
  const idMatch = String(url).match(/[?&]id=([^&]+)/);
  return idMatch ? idMatch[1] : null;
}

function buildDriveUrls(fileId) {
  return {
    previewUrl:  `https://drive.google.com/file/d/${fileId}/preview`,
    downloadUrl: `https://drive.google.com/uc?export=download&id=${fileId}`,
    webViewLink: `https://drive.google.com/file/d/${fileId}/view`,
  };
}

function groupByTracking(pedidos) {
  const normalize = (s) => String(s || '').trim().toLowerCase();
  const map = new Map();
  for (const p of pedidos) {
    // Agrupar por tracking si existe, sino por cliente+dirección
    const tracking = normalize(p.numero_seguimiento_ues);
    const key = tracking
      ? `tracking:${tracking}`
      : `dir:${normalize(p.cliente_nombre)}|${normalize(p.direccion_envio)}|${normalize(p.localidad)}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(p);
  }
  const result = [];
  for (const group of map.values()) {
    if (group.length === 1) { result.push(group[0]); continue; }
    result.push({
      ...group[0],
      numero_pedido: group.map(p => p.numero_pedido).join(' / '),
      _isDuplicateTracking: true,
      _mergedIds: group.map(p => p.id),
      _mergedPedidos: group,
    });
  }
  return result;
}

export default function DeliveryEspecialTable({
  pedidos = [],
  tipo,
  onMarcarDespachado,
  onMarcarDespachadosBulk,
  onProcesar,
  onProcesarBulk,
  onActualizar,
  mostrarToast,
}) {
  const [driveState, setDriveState]       = useState({});
  const [previewPedidoId, setPreviewPedidoId] = useState(null);
  const [selectedIds, setSelectedIds]     = useState(new Set());
  const [bulkLoading, setBulkLoading]     = useState(false);

  const tipoLabel = tipo === 'pickup_local' ? 'Pick-UP' : tipo === 'recibilo_hoy' ? 'Recibilo Hoy' : 'Reenvíos';
  const tipoIcon  = tipo === 'pickup_local' ? '🏪' : tipo === 'recibilo_hoy' ? '⚡' : '📦';
  const esReenvio = tipo === 'reenvio';

  const pedidosOrdenados = groupByTracking(
    [...pedidos].sort((a, b) => {
      const na = parseInt(String(a.numero_pedido || '').replace(/\D/g, ''), 10) || 0;
      const nb = parseInt(String(b.numero_pedido || '').replace(/\D/g, ''), 10) || 0;
      return nb - na;
    })
  );

  // IDs reales (expandidos) de todos los pedidos en la vista
  const allRealIds = pedidosOrdenados.flatMap(p => p._mergedIds || [p.id]);

  // ── Selección ───────────────────────────────────────────────────────────────
  const allSelected = allRealIds.length > 0 && allRealIds.every(id => selectedIds.has(id));
  const someSelected = selectedIds.size > 0;

  const toggleSelect = useCallback((row) => {
    const ids = row._mergedIds || [row.id];
    setSelectedIds((prev) => {
      const next = new Set(prev);
      const allSel = ids.every(id => next.has(id));
      ids.forEach(id => allSel ? next.delete(id) : next.add(id));
      return next;
    });
  }, []);

  const toggleAll = useCallback(() => {
    setSelectedIds((prev) =>
      allRealIds.every(id => prev.has(id))
        ? new Set()
        : new Set(allRealIds)
    );
  }, [allRealIds]);

  // ── Etiqueta helpers ────────────────────────────────────────────────────────
  const getEtiquetaUrl = (pedido) => {
    const local = driveState[pedido.id];
    if (local?.previewUrl) return { previewUrl: local.previewUrl, downloadUrl: local.downloadUrl };
    if (pedido.link_etiqueta_drive) {
      const fileId = extractDriveFileId(pedido.link_etiqueta_drive);
      if (fileId) return buildDriveUrls(fileId);
      return { previewUrl: pedido.link_etiqueta_drive, downloadUrl: pedido.link_etiqueta_drive };
    }
    return null;
  };

  const getDriveLink = (pedido) => {
    const local = driveState[pedido.id];
    if (local?.webViewLink) return local.webViewLink;
    if (pedido.link_etiqueta_drive) return pedido.link_etiqueta_drive;
    return null;
  };

  // ── Buscar etiqueta (soporta grupos) ───────────────────────────────────────
  const buscarEtiqueta = async (pedido) => {
    const stateKey = pedido.id;
    const ids = pedido._mergedIds || [pedido.id];
    // Para grupos, buscar por el primer número real del grupo
    const primerNumero = pedido._mergedPedidos
      ? pedido._mergedPedidos[0].numero_pedido
      : pedido.numero_pedido;

    setDriveState((s) => ({ ...s, [stateKey]: { ...s[stateKey], loading: true, error: null, showManualInput: false } }));
    try {
      const result = await buscarEtiquetaDrive(primerNumero);
      if (result.success) {
        for (const id of ids) await guardarLinkDriveEnPedido(id, result.webViewLink);
        setDriveState((s) => ({
          ...s,
          [stateKey]: { loading: false, previewUrl: result.previewUrl, downloadUrl: result.downloadUrl, webViewLink: result.webViewLink },
        }));
        mostrarToast?.(`✅ Etiqueta encontrada: ${result.name}`, 'success');
        onActualizar?.();
      } else {
        setDriveState((s) => ({
          ...s,
          [stateKey]: { loading: false, fallbackUrl: result.fallbackUrl, error: result.error, showManualInput: true, manualLink: '' },
        }));
        mostrarToast?.(
          result.error?.includes('GOOGLE_API_KEY')
            ? '⚠️ API de Drive no configurada — pegá el link manualmente'
            : '⚠️ No se encontró en Drive — pegá el link manualmente',
          'warning'
        );
      }
    } catch (err) {
      setDriveState((s) => ({
        ...s,
        [stateKey]: { loading: false, error: err.message, showManualInput: true, manualLink: '' },
      }));
      mostrarToast?.('Error buscando en Drive — pegá el link manualmente', 'warning');
    }
  };

  // ── Link manual (soporta grupos) ────────────────────────────────────────────
  const handleManualLink = async (pedido, rawLink) => {
    const stateKey = pedido.id;
    const ids = pedido._mergedIds || [pedido.id];
    const fileId = extractDriveFileId(rawLink);
    if (!fileId) {
      mostrarToast?.('El link no parece un link de Google Drive válido', 'error');
      return;
    }
    const urls = buildDriveUrls(fileId);
    try {
      for (const id of ids) await guardarLinkDriveEnPedido(id, urls.webViewLink);
      setDriveState((s) => ({ ...s, [stateKey]: { loading: false, ...urls, showManualInput: false } }));
      mostrarToast?.('✅ Etiqueta vinculada correctamente', 'success');
      onActualizar?.();
    } catch (_) {
      setDriveState((s) => ({ ...s, [stateKey]: { loading: false, ...urls, showManualInput: false } }));
      mostrarToast?.('PDF cargado (no se pudo guardar en DB)', 'warning');
    }
  };

  // ── Descargar PDFs unidos (bulk) ────────────────────────────────────────────
  const handleDescargarPDFsBulk = useCallback(async () => {
    const pedidosSel = pedidosOrdenados.filter((p) => {
      const ids = p._mergedIds || [p.id];
      return ids.some(id => selectedIds.has(id));
    });
    const links = pedidosSel.map((p) => getDriveLink(p)).filter(Boolean);

    if (links.length === 0) {
      mostrarToast?.('Los pedidos seleccionados no tienen etiqueta asignada', 'warning');
      return;
    }
    if (links.length < pedidosSel.length) {
      mostrarToast?.(`⚠️ Solo ${links.length} de ${pedidosSel.length} pedidos tienen etiqueta`, 'warning');
    }

    setBulkLoading(true);
    try {
      const blob = await mergePedidosPDF(links);
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href     = url;
      a.download = `etiquetas-${tipo}-${new Date().toISOString().slice(0, 10)}.pdf`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      mostrarToast?.(`✅ PDF con ${links.length} etiqueta(s) descargado`, 'success');
    } catch (err) {
      mostrarToast?.(`Error generando PDF: ${err.message}`, 'error');
    } finally {
      setBulkLoading(false);
    }
  }, [pedidosOrdenados, selectedIds, tipo, mostrarToast]);

  // ── Marcar despachados (bulk) ───────────────────────────────────────────────
  const handleDespacharBulk = useCallback(async () => {
    const ids = [...selectedIds]; // selectedIds ya contiene IDs reales expandidos
    if (ids.length === 0) return;
    setBulkLoading(true);
    try {
      await onMarcarDespachadosBulk?.(ids);
      setSelectedIds(new Set());
    } finally {
      setBulkLoading(false);
    }
  }, [selectedIds, onMarcarDespachadosBulk]);

  // ── Procesar en bulk (sin Shopify fulfillment) ──────────────────────────────
  const handleProcesarBulk = useCallback(async () => {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    setBulkLoading(true);
    try {
      await onProcesarBulk?.(ids);
      setSelectedIds(new Set());
    } finally {
      setBulkLoading(false);
    }
  }, [selectedIds, onProcesarBulk]);

  // ── Render ──────────────────────────────────────────────────────────────────
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

      {/* Barra de acciones bulk */}
      {someSelected && (
        <div className="de-bulk-bar">
          <span className="de-bulk-count">{selectedIds.size} seleccionado{selectedIds.size !== 1 ? 's' : ''}</span>
          <div className="de-bulk-actions">
            <button
              className="btn btn-primary btn-sm"
              onClick={handleDescargarPDFsBulk}
              disabled={bulkLoading}
              title="Descargar todos los PDFs seleccionados en un único archivo">
              {bulkLoading ? '⏳ Generando…' : '⬇️ Descargar PDFs'}
            </button>
            <button
              className="btn btn-primary btn-sm"
              onClick={handleDespacharBulk}
              disabled={bulkLoading}
              title="Marcar todos los seleccionados como despachados">
              🚀 Despachar todos
            </button>
            <button
              className="btn btn-success btn-sm"
              onClick={handleProcesarBulk}
              disabled={bulkLoading}
              title="Marcar todos los seleccionados como procesados (sin fulfillment Shopify)">
              ✅ Procesar todos
            </button>
            <button
              className="btn btn-outline btn-sm"
              onClick={() => setSelectedIds(new Set())}
              disabled={bulkLoading}>
              ✕ Limpiar
            </button>
          </div>
        </div>
      )}

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
                <th style={{ width: '2.5rem' }}>
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={toggleAll}
                    title={allSelected ? 'Deseleccionar todos' : 'Seleccionar todos'}
                  />
                </th>
                <th>N° Orden</th>
                <th>Cliente</th>
                <th>Teléfono</th>
                {esReenvio && <th>Motivo / Producto</th>}
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
                const realIds  = pedido._mergedIds || [pedido.id];
                const isSelected = realIds.every(id => selectedIds.has(id));
                const rowKey   = pedido._mergedIds ? pedido._mergedIds.join('-') : pedido.id;

                return (
                  <tr key={rowKey} className={[isSelected ? 'de-row-selected' : '', pedido._isDuplicateTracking ? 'pedidos-row-duplicate-tracking' : ''].filter(Boolean).join(' ')}>
                    <td>
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggleSelect(pedido)}
                      />
                    </td>
                    <td>
                      <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                        <strong>#{pedido.numero_pedido}</strong>
                        {pedido._isDuplicateTracking && (
                          <span className="pedido-duplicate-tracking-badge" style={{ fontSize: 11 }}>
                            📦 mismo tracking
                          </span>
                        )}
                        {esReenvio && pedido.pedido_origen_id && (
                          <span style={{ fontSize: 11, color: '#888' }}>
                            origen: #{String(pedido.numero_pedido).replace(/^RCL-/, '').replace(/-\d+$/, '')}
                          </span>
                        )}
                      </span>
                    </td>
                    <td>{pedido.cliente_nombre || '—'}</td>
                    <td>{pedido.cliente_telefono || pedido.cliente_email || '—'}</td>
                    {esReenvio && (
                      <td style={{ fontSize: 12, maxWidth: 180, wordBreak: 'break-word' }}>
                        {pedido.motivo_reenvio || '—'}
                      </td>
                    )}
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
                      ) : ds.showManualInput ? (
                        <div className="de-manual-link-wrap">
                          <p className="de-manual-link-hint">
                            {ds.error?.includes('GOOGLE_API_KEY')
                              ? '⚠️ Drive API no configurada'
                              : '⚠️ No encontrado automáticamente'}
                          </p>
                          <div className="de-manual-link-row">
                            <input
                              className="de-manual-link-input"
                              type="text"
                              placeholder="Pegá el link de Drive aquí…"
                              value={ds.manualLink || ''}
                              onChange={(e) => setDriveState((s) => ({
                                ...s,
                                [pedido.id]: { ...s[pedido.id], manualLink: e.target.value },
                              }))}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter' && ds.manualLink?.trim()) {
                                  handleManualLink(pedido, ds.manualLink.trim());
                                }
                              }}
                            />
                            <button
                              className="btn btn-primary btn-sm"
                              disabled={!ds.manualLink?.trim()}
                              onClick={() => handleManualLink(pedido, ds.manualLink.trim())}
                              title="Vincular este link de Drive al pedido">
                              ✓
                            </button>
                          </div>
                          <div style={{ display: 'flex', gap: '0.4rem', marginTop: '0.3rem' }}>
                            <button className="btn btn-secondary btn-sm"
                              onClick={() => buscarEtiqueta(pedido)}
                              disabled={ds.loading}>
                              🔄 Reintentar
                            </button>
                            <a href={ds.fallbackUrl || DRIVE_FOLDER_URL} target="_blank"
                              rel="noopener noreferrer" className="de-drive-fallback">
                              📁 Abrir carpeta
                            </a>
                          </div>
                        </div>
                      ) : (
                        <button className="btn btn-primary btn-sm"
                          onClick={() => buscarEtiqueta(pedido)}
                          disabled={ds.loading}
                          title="Buscar etiqueta en Google Drive">
                          {ds.loading ? '⏳ Buscando…' : '🔍 Buscar en Drive'}
                        </button>
                      )}
                    </td>

                    {/* Acciones individuales */}
                    <td className="reclamo-actions">
                      <button className={`btn btn-sm ${isDespachado ? 'btn-secondary' : 'btn-primary'}`}
                        disabled={isDespachado}
                        title={isDespachado ? 'Ya despachado' : 'Marcar como despachado'}
                        onClick={() => onMarcarDespachado?.(pedido.id)}>
                        🚀 Despachar
                      </button>
                      <button
                        className={`btn btn-sm ${estado === 'enviado' ? 'btn-secondary' : 'btn-success'}`}
                        disabled={estado === 'enviado' || !urls}
                        title={
                          estado === 'enviado' ? 'Ya procesado'
                          : !urls ? 'Necesita etiqueta Drive para procesar'
                          : 'Marcar como procesado (sin fulfillment Shopify)'
                        }
                        onClick={() => onProcesar?.(pedido.id)}>
                        ✅ Procesar
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

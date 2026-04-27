import React, { useState, useEffect, useCallback } from 'react';
import { obtenerDetallePedido } from '../../services/api';

export default function ArmadoReviewModal({ pedidos, initialIndex = 0, onConfirmarListos, onClose }) {
  const [index, setIndex] = useState(initialIndex);
  const [lineItemsByPedido, setLineItemsByPedido] = useState({});
  const [checkedByPedido, setCheckedByPedido] = useState({});
  const [loadingId, setLoadingId] = useState(null);
  const [errorByPedido, setErrorByPedido] = useState({});
  const [confirmingId, setConfirmingId] = useState(null);
  const [confirmedIds, setConfirmedIds] = useState(new Set());
  const [justConfirmedId, setJustConfirmedId] = useState(null);

  const pedido = pedidos[index];

  const cargarDetalle = useCallback(async (p) => {
    if (lineItemsByPedido[p.id]) return;
    setLoadingId(p.id);
    try {
      if (p._mergedPedidos) {
        const allItems = [];
        for (const mp of p._mergedPedidos) {
          const res = await obtenerDetallePedido(mp.numero_pedido);
          if (res.success) {
            allItems.push(...(res.lineItems || []).map(item => ({ ...item, _fromPedido: mp.numero_pedido })));
          }
        }
        setLineItemsByPedido((prev) => ({ ...prev, [p.id]: allItems }));
      } else {
        const res = await obtenerDetallePedido(p.numero_pedido);
        if (!res.success) throw new Error(res.error || 'Error al obtener detalle');
        setLineItemsByPedido((prev) => ({ ...prev, [p.id]: res.lineItems || [] }));
      }
    } catch (e) {
      setErrorByPedido((prev) => ({ ...prev, [p.id]: e.message }));
    } finally {
      setLoadingId(null);
    }
  }, [lineItemsByPedido]);

  useEffect(() => {
    if (pedido) cargarDetalle(pedido);
  }, [pedido, cargarDetalle]);

  const lineItems = pedido ? (lineItemsByPedido[pedido.id] || []) : [];
  const checked = pedido ? (checkedByPedido[pedido.id] || new Set()) : new Set();
  const error = pedido ? errorByPedido[pedido.id] : null;
  const isLoading = loadingId === pedido?.id;
  const allChecked = lineItems.length > 0 && lineItems.every((item) => checked.has(item.id));
  const allIdsForPedido = (p) => p?._mergedIds || (p ? [p.id] : []);
  const isConfirmed = pedido ? allIdsForPedido(pedido).every(id => confirmedIds.has(id)) : false;

  const toggleItem = (itemId) => {
    const pid = pedido.id;
    setCheckedByPedido((prev) => {
      const cur = new Set(prev[pid] || []);
      if (cur.has(itemId)) cur.delete(itemId);
      else cur.add(itemId);
      return { ...prev, [pid]: cur };
    });
  };

  const toggleAll = () => {
    const pid = pedido.id;
    if (allChecked) {
      setCheckedByPedido((prev) => ({ ...prev, [pid]: new Set() }));
    } else {
      setCheckedByPedido((prev) => ({ ...prev, [pid]: new Set(lineItems.map((i) => i.id)) }));
    }
  };

  const getReadyIds = () => {
    const primaryIds = [];
    const secondaryIds = [];
    for (const p of pedidos) {
      if (errorByPedido[p.id]) continue;
      if (allIdsForPedido(p).every(id => confirmedIds.has(id))) continue;
      const items = lineItemsByPedido[p.id] || [];
      if (items.length === 0) continue;
      const checkedSet = checkedByPedido[p.id] || new Set();
      if (checkedSet.size === items.length) {
        const ids = allIdsForPedido(p);
        primaryIds.push(ids[0]);
        secondaryIds.push(...ids.slice(1));
      }
    }
    return { primaryIds, secondaryIds };
  };

  const handleConfirmar = async () => {
    const { primaryIds, secondaryIds } = getReadyIds();
    if (primaryIds.length === 0) return;

    setConfirmingId('__batch__');
    try {
      await onConfirmarListos(primaryIds, secondaryIds);

      const nextConfirmed = new Set(confirmedIds);
      [...primaryIds, ...secondaryIds].forEach((id) => nextConfirmed.add(id));
      setConfirmedIds(nextConfirmed);
      setJustConfirmedId(pedido.id);

      // Pequeña pausa para que el operario vea feedback positivo antes de avanzar/cerrar.
      await new Promise((resolve) => setTimeout(resolve, 700));

      const next = pedidos.findIndex((p, i) => i > index && !allIdsForPedido(p).every(id => nextConfirmed.has(id)));
      if (next >= 0) {
        setJustConfirmedId(null);
        setIndex(next);
      } else {
        const anyLeft = pedidos.some((p) => !allIdsForPedido(p).every(id => nextConfirmed.has(id)));
        if (!anyLeft) onClose();
      }
    } finally {
      setConfirmingId(null);
    }
  };

  const totalPedidos = pedidos.length;
  const totalConfirmados = pedidos.filter(p => allIdsForPedido(p).every(id => confirmedIds.has(id))).length;

  const getSidebarStatus = (p) => {
    if (allIdsForPedido(p).every(id => confirmedIds.has(id))) return { label: 'Armado', tone: 'ok' };
    if (errorByPedido[p.id]) return { label: 'Error', tone: 'error' };
    if (loadingId === p.id) return { label: 'Cargando...', tone: 'loading' };
    const items = lineItemsByPedido[p.id];
    if (!items) return { label: 'Pendiente', tone: 'pending' };
    const ch = checkedByPedido[p.id] || new Set();
    if (ch.size === 0) return { label: 'Sin revisar', tone: 'pending' };
    if (ch.size === items.length) return { label: 'Listo', tone: 'ok' };
    return { label: `${ch.size}/${items.length}`, tone: 'warn' };
  };

  if (!pedido) return null;

  const { primaryIds: readyPrimaryIds } = getReadyIds();
  const readyCount = readyPrimaryIds.length;
  const canConfirmar = readyCount > 0 && !confirmingId;
  const isLast = pedidos.findIndex((p, i) => i > index && !allIdsForPedido(p).every(id => confirmedIds.has(id))) < 0;

  return (
    <div className="modal modal-open">
      <div className="modal-content modal-large armado-modal-fixed">

        {/* Header */}
        <div className="modal-header">
          <h3>Revision de Armado - Orden #{pedido.numero_pedido}</h3>
          <button className="btn-close" onClick={onClose}>&times;</button>
        </div>

        {/* Topbar navegacion */}
        <div className="preview-topbar">
          <span className="preview-counter">Pedido {index + 1} de {totalPedidos}</span>
          <div className="preview-nav-actions">
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => setIndex((i) => Math.max(0, i - 1))}
              disabled={index === 0}
            >
              Anterior
            </button>
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => setIndex((i) => Math.min(totalPedidos - 1, i + 1))}
              disabled={index === totalPedidos - 1}
            >
              Siguiente
            </button>
          </div>
        </div>

        {/* Body con layout sidebar + contenido */}
        <div className="modal-body armado-modal-body">
          <div className="preview-layout">
            <aside className="preview-sidebar">
              <h4>{totalPedidos > 1 ? 'Pedidos' : 'Resumen'}</h4>
              <div className="preview-sidebar-summary">
                <span className="preview-sidebar-summary-pill ok">Armados: {totalConfirmados}</span>
                <span className="preview-sidebar-summary-pill pending">Pendientes: {totalPedidos - totalConfirmados}</span>
              </div>

              {totalPedidos > 1 ? (
                <div className="preview-sidebar-list">
                  {pedidos.map((p, i) => {
                    const status = getSidebarStatus(p);
                    return (
                      <button
                        key={p.id}
                        className={`preview-sidebar-item${i === index ? ' active' : ''}`}
                        onClick={() => setIndex(i)}
                      >
                        <span className="preview-sidebar-item-main">#{p.numero_pedido}</span>
                        <span className={`preview-sidebar-item-status ${status.tone}`}>{status.label}</span>
                      </button>
                    );
                  })}
                </div>
              ) : (
                <div className="preview-sidebar-single">
                  <div className="preview-sidebar-single-row">
                    <span>Orden</span>
                    <strong>#{pedido.numero_pedido}</strong>
                  </div>
                  <div className="preview-sidebar-single-row">
                    <span>Cliente</span>
                    <strong>{pedido.cliente_nombre || '-'}</strong>
                  </div>
                  <div className="preview-sidebar-single-row">
                    <span>Estado</span>
                    <span className={`preview-sidebar-item-status ${getSidebarStatus(pedido).tone}`}>
                      {getSidebarStatus(pedido).label}
                    </span>
                  </div>
                  <div className="preview-sidebar-single-note">
                    Revisa y tilda cada producto antes de confirmar el armado.
                  </div>
                </div>
              )}
            </aside>

            <div className="preview-content">
              {/* Banner de estado */}
              <div
                className={`preview-validation-banner ${isConfirmed ? 'ok' : allChecked ? 'ok' : checked.size > 0 ? 'warn' : 'warn'}`}
              >
                {(justConfirmedId === pedido.id || isConfirmed)
                  ? 'Armado OK. Este pedido fue movido a Despachados.'
                  : allChecked
                  ? 'Todos los productos listos - podes confirmar'
                  : checked.size > 0
                  ? `${checked.size} de ${lineItems.length} productos chequeados`
                  : 'Tilda cada producto a medida que lo coloques en el paquete'}
              </div>

              <div className="preview-validation-list">
                <span className="tag-warn">Listos para confirmar: {readyCount}</span>
              </div>

              {/* Contenido: items */}
              <div className="preview-section" style={{ borderLeftColor: '#7b2f4d' }}>
                <h4>Contenido del pedido{pedido._isDuplicateTracking ? ` (${pedido._mergedPedidos.length} pedidos con mismo tracking)` : ''}</h4>

                {isLoading && (
                  <div style={{ padding: '1rem', color: '#64748b' }}>Cargando contenido desde Shopify...</div>
                )}
                {error && (
                  <div className="tag-error" style={{ display: 'block', padding: '0.6rem', borderRadius: '8px' }}>{error}</div>
                )}

                {!isLoading && !error && lineItems.length > 0 && (
                  <>
                    <li style={{ borderBottom: '1px solid #e2e8f0', paddingBottom: '0.5rem', marginBottom: '0.25rem', listStyle: 'none' }}>
                      <label style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', cursor: 'pointer', fontWeight: 600, color: '#475569', fontSize: '0.85rem' }}>
                        <input type="checkbox" checked={allChecked} onChange={toggleAll} disabled={isConfirmed} />
                        Marcar todos
                      </label>
                    </li>
                    <div className="armado-list-scroll">
                      <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                        {lineItems.map((item) => {
                          const done = checked.has(item.id);
                          return (
                            <li key={item.id} style={{
                              border: `1px solid ${done ? '#86efac' : '#e2e8f0'}`,
                              borderRadius: '8px',
                              background: done ? '#dcfce7' : '#ffffff',
                              transition: 'background 0.15s ease, border-color 0.15s ease',
                            }}>
                              <label style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', padding: '0.7rem 0.9rem', cursor: isConfirmed ? 'default' : 'pointer', width: '100%' }}>
                                <input
                                  type="checkbox"
                                  checked={done}
                                  onChange={() => toggleItem(item.id)}
                                  disabled={isConfirmed}
                                />
                                <span style={{ flex: 1, minWidth: 0 }}>
                                  <span style={{ display: 'block', fontWeight: 600, fontSize: '0.92rem', color: '#0f172a' }}>{item.title}</span>
                                  {item.variant_title && (
                                    <span style={{ display: 'block', fontSize: '0.8rem', color: '#64748b' }}>{item.variant_title}</span>
                                  )}
                                  {item.sku && (
                                    <span style={{ display: 'block', fontSize: '0.74rem', color: '#94a3b8' }}>SKU: {item.sku}</span>
                                  )}
                                  {item._fromPedido && (
                                    <span style={{ display: 'block', fontSize: '0.72rem', color: '#b45309', fontWeight: 600 }}>Pedido #{item._fromPedido}</span>
                                  )}
                                </span>
                                <span style={{ fontWeight: 700, color: '#7b2f4d', whiteSpace: 'nowrap' }}>x{item.quantity}</span>
                              </label>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose}>Cancelar</button>
          <button
            className="btn btn-primary"
            disabled={!canConfirmar || !!confirmingId}
            onClick={handleConfirmar}
          >
            {confirmingId
              ? 'Marcando...'
              : `Confirmar armados listos (${readyCount})`}
          </button>
        </div>
      </div>
    </div>
  );
}

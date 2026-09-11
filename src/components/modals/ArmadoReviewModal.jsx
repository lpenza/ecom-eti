import React, { useState, useEffect, useCallback } from 'react';
import { obtenerDetallePedido } from '../../services/api';

// ID sintético para cada pieza de contenido físico fijo de un kit (no tiene line item).
const fijoId = (kitLineId, idx) => `fijo:${kitLineId}:${idx}`;

// Lista plana de todos los IDs que hay que tildar para dar por armado un pedido:
// line items reales + una entrada por cada pieza física fija de cada kit.
function buildCheckableIds(lineItems, desglose) {
  if (desglose) {
    const ids = [];
    for (const k of desglose.kits) {
      if (k.colorBase) ids.push(k.colorBase.id);
      for (const c of k.colores || []) ids.push(c.id);
      for (const a of k.adicionales || []) ids.push(a.id);
      (k.fijos || []).forEach((_, i) => ids.push(fijoId(k.kitLineId, i)));
    }
    for (const s of desglose.sueltos || []) ids.push(s.id);
    return ids;
  }
  return (lineItems || []).map((i) => i.id);
}

export default function ArmadoReviewModal({ pedidos, initialIndex = 0, onConfirmarListos, onImprimirEtiqueta, onClose }) {
  const [index, setIndex] = useState(initialIndex);
  const [lineItemsByPedido, setLineItemsByPedido] = useState({});
  const [desgloseByPedido, setDesgloseByPedido] = useState({});
  const [checkedByPedido, setCheckedByPedido] = useState({});
  const [loadingId, setLoadingId] = useState(null);
  const [errorByPedido, setErrorByPedido] = useState({});
  const [confirmingId, setConfirmingId] = useState(null);
  const [confirmedIds, setConfirmedIds] = useState(new Set());
  const [justConfirmedId, setJustConfirmedId] = useState(null);
  const [motivoAceptadoByPedido, setMotivoAceptadoByPedido] = useState({});

  const pedido = pedidos[index];

  const cargarDetalle = useCallback(async (p) => {
    if (lineItemsByPedido[p.id]) return;
    setLoadingId(p.id);
    try {
      if (p._mergedPedidos) {
        const allItems = [];
        const combinedKits = [];
        const combinedSueltos = [];
        let anyDesglose = false;
        for (const mp of p._mergedPedidos) {
          const res = await obtenerDetallePedido(mp.numero_pedido);
          if (res.success) {
            const tag = (it) => ({ ...it, _fromPedido: mp.numero_pedido });
            const items = (res.lineItems || []).map(tag);
            allItems.push(...items);
            if (res.desglose) {
              anyDesglose = true;
              combinedKits.push(...res.desglose.kits.map((k) => ({
                ...k,
                colorBase: k.colorBase ? tag(k.colorBase) : k.colorBase,
                colores: (k.colores || []).map(tag),
                adicionales: (k.adicionales || []).map(tag),
              })));
              combinedSueltos.push(...(res.desglose.sueltos || []).map(tag));
            } else {
              // Pedido sin kit dentro del grupo: sus items van como sueltos.
              combinedSueltos.push(...items);
            }
          }
        }
        setLineItemsByPedido((prev) => ({ ...prev, [p.id]: allItems }));
        setDesgloseByPedido((prev) => ({
          ...prev,
          [p.id]: anyDesglose ? { kits: combinedKits, sueltos: combinedSueltos } : null,
        }));
      } else {
        const res = await obtenerDetallePedido(p.numero_pedido);
        if (!res.success) throw new Error(res.error || 'Error al obtener detalle');
        setLineItemsByPedido((prev) => ({ ...prev, [p.id]: res.lineItems || [] }));
        setDesgloseByPedido((prev) => ({ ...prev, [p.id]: res.desglose || null }));
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
  const desglose = pedido ? (desgloseByPedido[pedido.id] || null) : null;
  const checkableIds = pedido ? buildCheckableIds(lineItems, desglose) : [];
  const checked = pedido ? (checkedByPedido[pedido.id] || new Set()) : new Set();
  const error = pedido ? errorByPedido[pedido.id] : null;
  const isLoading = loadingId === pedido?.id;
  const allChecked = checkableIds.length > 0 && checkableIds.every((id) => checked.has(id));
  const checkedCount = checkableIds.filter((id) => checked.has(id)).length;
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
      setCheckedByPedido((prev) => ({ ...prev, [pid]: new Set(checkableIds) }));
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
      const cids = buildCheckableIds(items, desgloseByPedido[p.id]);
      const checkedSet = checkedByPedido[p.id] || new Set();
      const motivoOk = !p.motivo_reenvio || !!motivoAceptadoByPedido[p.id];
      if (cids.length > 0 && cids.every((id) => checkedSet.has(id)) && motivoOk) {
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
    const cids = buildCheckableIds(items, desgloseByPedido[p.id]);
    const total = cids.length;
    const ch = checkedByPedido[p.id] || new Set();
    const hechos = cids.filter((id) => ch.has(id)).length;
    if (hechos === 0) return { label: 'Sin revisar', tone: 'pending' };
    if (hechos === total) return { label: 'Listo', tone: 'ok' };
    return { label: `${hechos}/${total}`, tone: 'warn' };
  };

  if (!pedido) return null;

  const { primaryIds: readyPrimaryIds } = getReadyIds();
  const readyCount = readyPrimaryIds.length;
  const canConfirmar = readyCount > 0 && !confirmingId;
  const isLast = pedidos.findIndex((p, i) => i > index && !allIdsForPedido(p).every(id => confirmedIds.has(id))) < 0;

  // Colores de las etiquetas por rol dentro del kit.
  const TAG_COLORS = {
    Color: { bg: '#ecfccb', fg: '#3f6212' },
    Adicional: { bg: '#e0e7ff', fg: '#3730a3' },
    Fijo: { bg: '#fef9c3', fg: '#854d0e' },
  };

  // Fila tildeable reutilizable (line item real o pieza física fija del kit).
  const renderRow = ({ checkId, title, subtitle, sku, fromPedido, quantity, tag }) => {
    const done = checked.has(checkId);
    const tagColor = tag ? TAG_COLORS[tag] : null;
    return (
      <li key={checkId} style={{
        border: `1px solid ${done ? '#86efac' : 'var(--border-soft)'}`,
        borderRadius: '8px',
        background: done ? 'var(--success-bg)' : 'var(--surface-card)',
        transition: 'background 0.15s ease, border-color 0.15s ease',
      }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', padding: '0.7rem 0.9rem', cursor: isConfirmed ? 'default' : 'pointer', width: '100%' }}>
          <input type="checkbox" checked={done} onChange={() => toggleItem(checkId)} disabled={isConfirmed} />
          <span style={{ flex: 1, minWidth: 0 }}>
            {tag && (
              <span style={{
                display: 'inline-block', marginBottom: '0.2rem', padding: '0.05rem 0.4rem', borderRadius: '999px',
                fontSize: '0.66rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.03em',
                background: tagColor.bg, color: tagColor.fg,
              }}>{tag}</span>
            )}
            <span style={{ display: 'block', fontWeight: 600, fontSize: '0.92rem', color: done ? '#0f172a' : 'var(--text-strong)' }}>{title}</span>
            {subtitle && (
              <span style={{ display: 'block', fontSize: '0.8rem', color: done ? '#334155' : 'var(--text-muted)' }}>{subtitle}</span>
            )}
            {sku && (
              <span style={{ display: 'block', fontSize: '0.74rem', color: done ? '#475569' : 'var(--text-muted)' }}>SKU: {sku}</span>
            )}
            {fromPedido && (
              <span style={{ display: 'block', fontSize: '0.72rem', color: '#b45309', fontWeight: 600 }}>Pedido #{fromPedido}</span>
            )}
          </span>
          {quantity != null && (
            <span style={{ fontWeight: 700, color: done ? '#7b2f4d' : 'var(--brand-primary)', whiteSpace: 'nowrap' }}>x{quantity}</span>
          )}
        </label>
      </li>
    );
  };

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
                  {pedido.origen === 'mercadolibre' && (
                    <div className="preview-sidebar-single-row">
                      <span>Origen</span>
                      <span className="pedido-ml-badge">🛒 MERCADOLIBRE</span>
                    </div>
                  )}
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
                className={`preview-validation-banner ${isConfirmed ? 'ok' : allChecked ? 'ok' : 'warn'}`}
              >
                {(justConfirmedId === pedido.id || isConfirmed)
                  ? 'Armado OK. Este pedido fue movido a Despachados.'
                  : allChecked
                  ? 'Todos los productos listos - podes confirmar'
                  : checkedCount > 0
                  ? `${checkedCount} de ${checkableIds.length} ítems chequeados`
                  : 'Tilda cada ítem a medida que lo coloques en el paquete'}
              </div>

              <div className="preview-validation-list">
                <span className="tag-warn">Listos para confirmar: {readyCount}</span>
              </div>

              {/* Alerta motivo reenvío — debe chequearse antes de confirmar */}
              {pedido.motivo_reenvio && (
                <div style={{
                  background: motivoAceptadoByPedido[pedido.id] ? '#dcfce7' : '#fee2e2',
                  border: `2px solid ${motivoAceptadoByPedido[pedido.id] ? '#86efac' : '#f87171'}`,
                  borderRadius: '8px',
                  padding: '0.75rem 1rem',
                  marginBottom: '0.75rem',
                  transition: 'background 0.2s, border-color 0.2s',
                }}>
                  <div style={{ fontWeight: 700, color: motivoAceptadoByPedido[pedido.id] ? '#166534' : '#991b1b', fontSize: '0.82rem', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '0.3rem' }}>
                    ⚠ {pedido.es_reclamo ? 'Reclamo — ' : ''}Atención
                  </div>
                  <p style={{ margin: '0 0 0.6rem', color: motivoAceptadoByPedido[pedido.id] ? '#166534' : '#7f1d1d', fontSize: '0.92rem', whiteSpace: 'pre-wrap', fontWeight: 600 }}>
                    {pedido.motivo_reenvio}
                  </p>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: isConfirmed ? 'default' : 'pointer', fontSize: '0.85rem', color: motivoAceptadoByPedido[pedido.id] ? '#166534' : '#991b1b', fontWeight: 600 }}>
                    <input
                      type="checkbox"
                      checked={!!motivoAceptadoByPedido[pedido.id]}
                      disabled={isConfirmed}
                      onChange={(e) => setMotivoAceptadoByPedido((prev) => ({ ...prev, [pedido.id]: e.target.checked }))}
                    />
                    Leí la especificación y voy a incluirla en el paquete
                  </label>
                </div>
              )}

              {/* Contenido: items */}
              <div className="preview-section" style={{ borderLeftColor: '#7b2f4d' }}>
                <h4>Contenido del pedido{pedido._isDuplicateTracking ? ` (${pedido._mergedPedidos.length} pedidos con mismo tracking)` : ''}</h4>

                {isLoading && (
                  <div style={{ padding: '1rem', color: '#64748b' }}>Cargando contenido desde Shopify...</div>
                )}
                {error && (
                  <div className="tag-error" style={{ display: 'block', padding: '0.6rem', borderRadius: '8px' }}>{error}</div>
                )}

                {!isLoading && !error && checkableIds.length > 0 && (
                  <>
                    <li style={{ borderBottom: '1px solid var(--border-soft)', paddingBottom: '0.5rem', marginBottom: '0.25rem', listStyle: 'none' }}>
                      <label style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', cursor: 'pointer', fontWeight: 600, color: 'var(--text-muted)', fontSize: '0.85rem' }}>
                        <input type="checkbox" checked={allChecked} onChange={toggleAll} disabled={isConfirmed} />
                        Marcar todos
                      </label>
                    </li>
                    <div className="armado-list-scroll">
                      {desglose ? (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.9rem' }}>
                          {desglose.kits.map((k) => (
                            <div key={k.kitLineId} style={{ border: '1px solid var(--border-soft)', borderRadius: '10px', overflow: 'hidden' }}>
                              <div style={{ background: '#faf1f5', borderBottom: '1px solid var(--border-soft)', padding: '0.5rem 0.75rem' }}>
                                <div style={{ fontWeight: 700, color: '#7b2f4d', fontSize: '0.9rem' }}>🎁 {k.kitNombre}</div>
                                {k.aviso && (
                                  <div style={{ marginTop: '0.25rem', fontSize: '0.76rem', fontWeight: 600, color: '#b45309' }}>⚠ {k.aviso}</div>
                                )}
                                {k.ambiguo && (
                                  <div style={{ marginTop: '0.25rem', fontSize: '0.76rem', fontWeight: 600, color: '#b45309' }}>
                                    ⚠ Hay varios kits en el pedido: revisá manualmente qué colores van en cada uno.
                                  </div>
                                )}
                              </div>
                              <ul style={{ listStyle: 'none', padding: '0.6rem', margin: 0, display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                                {k.colorBase && renderRow({
                                  checkId: k.colorBase.id,
                                  title: k.colorBase.title,
                                  subtitle: k.colorBase.variant_title ? `Color base: ${k.colorBase.variant_title}` : null,
                                  sku: k.colorBase.sku,
                                  fromPedido: k.colorBase._fromPedido,
                                  quantity: k.colorBase.quantity,
                                })}
                                {(k.colores || []).map((c) => renderRow({
                                  checkId: c.id,
                                  title: c.variant_title || c.title,
                                  subtitle: c.variant_title ? c.title : null,
                                  sku: c.sku,
                                  fromPedido: c._fromPedido,
                                  quantity: c.quantity,
                                  tag: 'Color',
                                }))}
                                {(k.adicionales || []).map((a) => renderRow({
                                  checkId: a.id,
                                  title: a.title,
                                  subtitle: a.variant_title,
                                  sku: a.sku,
                                  fromPedido: a._fromPedido,
                                  quantity: a.quantity,
                                  tag: 'Adicional',
                                }))}
                                {(k.fijos || []).map((f, i) => renderRow({
                                  checkId: fijoId(k.kitLineId, i),
                                  title: f.descripcion,
                                  subtitle: 'Incluido en el kit (no figura en la orden)',
                                  quantity: f.cantidad,
                                  tag: 'Fijo',
                                }))}
                              </ul>
                            </div>
                          ))}

                          {desglose.sueltos.length > 0 && (
                            <div style={{ border: '1px solid var(--border-soft)', borderRadius: '10px', overflow: 'hidden' }}>
                              <div style={{ background: 'var(--surface-muted, #f8fafc)', borderBottom: '1px solid var(--border-soft)', padding: '0.5rem 0.75rem', fontWeight: 700, color: 'var(--text-muted)', fontSize: '0.85rem' }}>
                                Otros productos
                              </div>
                              <ul style={{ listStyle: 'none', padding: '0.6rem', margin: 0, display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                                {desglose.sueltos.map((s) => renderRow({
                                  checkId: s.id,
                                  title: s.title,
                                  subtitle: s.variant_title,
                                  sku: s.sku,
                                  fromPedido: s._fromPedido,
                                  quantity: s.quantity,
                                }))}
                              </ul>
                            </div>
                          )}
                        </div>
                      ) : (
                        <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                          {lineItems.map((item) => renderRow({
                            checkId: item.id,
                            title: item.title,
                            subtitle: item.variant_title,
                            sku: item.sku,
                            fromPedido: item._fromPedido,
                            quantity: item.quantity,
                          }))}
                        </ul>
                      )}
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
          {onImprimirEtiqueta && (
            <button
              className="btn btn-secondary"
              onClick={() => onImprimirEtiqueta(pedido)}
              disabled={!String(pedido.link_etiqueta_drive || '').trim()}
              title={String(pedido.link_etiqueta_drive || '').trim()
                ? 'Imprimir/descargar la etiqueta de este pedido'
                : 'Este pedido no tiene etiqueta PDF disponible'}
            >
              🖨️ Imprimir etiqueta
            </button>
          )}
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

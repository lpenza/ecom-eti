import React, { useEffect, useMemo, useState } from 'react';
import { obtenerDetallePedido } from '../services/api';

// Etiqueta de tipo de entrega. La regla es simple: si el número de seguimiento
// empieza por "UES" es un envío UES; cualquier otro caso es MarcoPostal.
function getTipoEnvioLabel(pedido) {
  const tipoEnvio = pedido?.tipo_envio;
  if (tipoEnvio === 'pickup_local') return 'Pick-Up';
  if (tipoEnvio === 'recibilo_hoy') return 'Recibilo Hoy';
  const tracking = String(pedido?.numero_seguimiento_ues || '').trim().toUpperCase();
  if (tracking.startsWith('UES')) return 'Envio UES';
  return 'MarcoPostal';
}

// Detecta si un item es un kit y de qué tipo, mirando el nombre y la variante.
// Devuelve 'inicial' | 'studio' | null.
function getKitTipo(item) {
  const txt = `${item?.title || ''} ${item?.variant_title || ''}`.toLowerCase();
  if (!txt.includes('kit')) return null;
  if (txt.includes('inicial')) return 'inicial';
  if (txt.includes('studio')) return 'studio';
  return null;
}

/**
 * Pantalla mobile-first para el retiro de paquetes por la cadetería.
 * Lista los pedidos ya despachados (previo al fulfillment). El armador/admin
 * SELECCIONA los paquetes que se lleva la cadetería y confirma todos juntos con
 * un botón; al confirmar se guardan en la BD con fecha/hora de Uruguay y
 * DESAPARECEN de la lista (la confirmación es definitiva, no se puede deshacer).
 *
 * Además, desde la barra de búsqueda se pueden ubicar pedidos que todavía están
 * en "Etiqueta Generada" (no despachados). Si la cadetería se lleva uno de esos,
 * el armador debe indicar un motivo y confirmar; queda registrado para que el
 * administrador pueda hacer seguimiento (entrega sin despacho).
 */
export default function CadeteriaPanel({
  pedidos = [],
  onConfirmarRetiros,
  onActualizar,
  onBuscarEtiquetas,
  onEntregaSinDespacho,
}) {
  const [busqueda, setBusqueda] = useState('');
  const [selected, setSelected] = useState(() => new Set());
  const [confirmando, setConfirmando] = useState(false);

  // Búsqueda de pedidos en "Etiqueta Generada" (no despachados).
  const [etiquetaResultados, setEtiquetaResultados] = useState([]);
  const [buscandoEtiquetas, setBuscandoEtiquetas] = useState(false);

  // Modal de "entrega sin despacho": { pedido }.
  const [entregaModal, setEntregaModal] = useState(null);
  const [motivo, setMotivo] = useState('');
  const [registrando, setRegistrando] = useState(false);

  // Modal de detalle del pedido: { pedido, loading, items, error }.
  const [detalleModal, setDetalleModal] = useState(null);

  // Solo se muestran los pedidos aún NO retirados: al confirmar desaparecen.
  const pendientes = useMemo(() => pedidos.filter((p) => !p.retirado_cadeteria_at), [pedidos]);

  const filtrados = useMemo(() => {
    const q = busqueda.trim().toLowerCase();
    if (!q) return pendientes;
    return pendientes.filter((p) =>
      String(p.numero_pedido || '').toLowerCase().includes(q) ||
      String(p.cliente_nombre || '').toLowerCase().includes(q) ||
      String(p.numero_seguimiento_ues || '').toLowerCase().includes(q)
    );
  }, [pendientes, busqueda]);

  // Busca pedidos con etiqueta generada (no despachados) al escribir (con debounce).
  useEffect(() => {
    const q = busqueda.trim();
    if (!onBuscarEtiquetas || q.length < 2) {
      setEtiquetaResultados([]);
      setBuscandoEtiquetas(false);
      return;
    }
    let cancelado = false;
    setBuscandoEtiquetas(true);
    const t = setTimeout(async () => {
      try {
        const res = await onBuscarEtiquetas(q);
        if (!cancelado) setEtiquetaResultados(Array.isArray(res) ? res : []);
      } catch {
        if (!cancelado) setEtiquetaResultados([]);
      } finally {
        if (!cancelado) setBuscandoEtiquetas(false);
      }
    }, 350);
    return () => { cancelado = true; clearTimeout(t); };
  }, [busqueda, onBuscarEtiquetas]);

  const toggleSelect = (pedido) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(pedido.id)) next.delete(pedido.id);
      else next.add(pedido.id);
      return next;
    });
  };

  const handleConfirmar = async () => {
    const seleccionados = pendientes.filter((p) => selected.has(p.id));
    if (seleccionados.length === 0) return;
    if (!window.confirm(`¿Confirmar la entrega de ${seleccionados.length} paquete(s) a cadetería? Esta acción no se puede deshacer.`)) return;
    setConfirmando(true);
    try {
      await onConfirmarRetiros(seleccionados);
      setSelected(new Set());
    } finally {
      setConfirmando(false);
    }
  };

  const abrirEntregaSinDespacho = (pedido) => {
    setMotivo('');
    setEntregaModal({ pedido });
  };

  const handleConfirmarEntregaSinDespacho = async () => {
    const pedido = entregaModal?.pedido;
    const motivoLimpio = motivo.trim();
    if (!pedido || !motivoLimpio) return;
    if (!window.confirm(
      `¿Seguro que querés entregar el pedido #${pedido.numero_pedido} a cadetería SIN despacharlo?\n\n` +
      `Se registrará el motivo para control del administrador.`
    )) return;
    setRegistrando(true);
    try {
      const ok = await onEntregaSinDespacho(pedido, motivoLimpio);
      if (ok !== false) {
        setEntregaModal(null);
        setMotivo('');
        // Sacamos el pedido de los resultados de búsqueda ya procesado.
        setEtiquetaResultados((prev) => prev.filter((p) => p.id !== pedido.id));
      }
    } finally {
      setRegistrando(false);
    }
  };

  const verDetalle = async (pedido) => {
    setDetalleModal({ pedido, loading: true, items: [], error: null });
    try {
      const res = await obtenerDetallePedido(pedido.numero_pedido);
      setDetalleModal((prev) => {
        // Ignorar si ya se cerró o se abrió otro pedido.
        if (!prev || prev.pedido.id !== pedido.id) return prev;
        return res?.success
          ? { pedido, loading: false, items: res.lineItems || [], error: null }
          : { pedido, loading: false, items: [], error: res?.error || 'No se pudo cargar el contenido' };
      });
    } catch (err) {
      setDetalleModal((prev) => {
        if (!prev || prev.pedido.id !== pedido.id) return prev;
        return { pedido, loading: false, items: [], error: err.message };
      });
    }
  };

  const seleccionadosCount = pendientes.filter((p) => selected.has(p.id)).length;

  return (
    <div className="cadeteria-panel">
      <div className="cadeteria-header">
        <div>
          <h2 className="cadeteria-title">Retiro de Cadetería</h2>
          <span className="cadeteria-count">
            {pendientes.length} por retirar
          </span>
        </div>
        <button type="button" className="btn btn-secondary btn-sm" onClick={onActualizar}>
          Actualizar
        </button>
      </div>

      <div className="cadeteria-search-wrap">
        <span className="cadeteria-search-icon">🔍</span>
        <input
          type="text"
          className="cadeteria-search-input"
          placeholder="Buscar por N° pedido, cliente o tracking…"
          value={busqueda}
          onChange={(e) => setBusqueda(e.target.value)}
        />
        {busqueda && (
          <button type="button" className="cadeteria-search-clear" onClick={() => setBusqueda('')}>✕</button>
        )}
      </div>

      {filtrados.length === 0 ? (
        <div className="cadeteria-empty">
          <p>{pendientes.length === 0 ? 'No hay pedidos despachados para retirar.' : 'Ningún pedido despachado coincide con la búsqueda.'}</p>
        </div>
      ) : (
        <div className="cadeteria-list">
          {filtrados.map((p) => {
            const isSelected = selected.has(p.id);
            return (
              <div
                key={p.id}
                className={`cadeteria-card${isSelected ? ' cadeteria-card-selected' : ''}`}
                onClick={() => toggleSelect(p)}
                role="button"
                tabIndex={0}
                aria-pressed={isSelected}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleSelect(p); }
                }}
              >
                <div className={`cadeteria-check${isSelected ? ' selected' : ''}`}>
                  {isSelected ? '✓' : ''}
                </div>
                <div className="cadeteria-card-info">
                  <div className="cadeteria-card-top">
                    <span className="cadeteria-card-orden">#{p.numero_pedido || p.id?.substring(0, 8)}</span>
                    <span className="cadeteria-card-tipo">{getTipoEnvioLabel(p)}</span>
                  </div>
                  <div className="cadeteria-card-cliente">{p.cliente_nombre || 'Sin nombre'}</div>
                  <div className="cadeteria-card-tracking">
                    {p.numero_seguimiento_ues ? `Tracking: ${p.numero_seguimiento_ues}` : 'Sin tracking'}
                  </div>
                </div>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm cadeteria-card-detalle"
                  onClick={(e) => { e.stopPropagation(); verDetalle(p); }}
                >
                  👁 Ver detalle
                </button>
              </div>
            );
          })}
        </div>
      )}

      {/* Pedidos con etiqueta generada (no despachados) que matchean la búsqueda.
          Entregarlos a cadetería es una excepción que requiere motivo. */}
      {busqueda.trim().length >= 2 && (buscandoEtiquetas || etiquetaResultados.length > 0) && (
        <div className="cadeteria-etiquetas-block">
          <div className="cadeteria-etiquetas-title">
            Con etiqueta generada · sin despachar
            <span className="cadeteria-etiquetas-hint">Entregar requiere motivo</span>
          </div>
          {buscandoEtiquetas && etiquetaResultados.length === 0 ? (
            <div className="cadeteria-empty"><p>Buscando…</p></div>
          ) : (
            <div className="cadeteria-list">
              {etiquetaResultados.map((p) => (
                <div key={p.id} className="cadeteria-card cadeteria-card-etiqueta">
                  <div className="cadeteria-card-info">
                    <div className="cadeteria-card-top">
                      <span className="cadeteria-card-orden">#{p.numero_pedido || p.id?.substring(0, 8)}</span>
                      <span className="cadeteria-card-tipo">{getTipoEnvioLabel(p)}</span>
                    </div>
                    <div className="cadeteria-card-cliente">{p.cliente_nombre || 'Sin nombre'}</div>
                    <div className="cadeteria-card-tracking">
                      {p.numero_seguimiento_ues ? `Tracking: ${p.numero_seguimiento_ues}` : 'Sin tracking'}
                    </div>
                  </div>
                  <div className="cadeteria-card-etiqueta-actions">
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      onClick={() => verDetalle(p)}
                    >
                      👁 Ver detalle
                    </button>
                    <button
                      type="button"
                      className="btn btn-outline-danger btn-sm"
                      onClick={() => abrirEntregaSinDespacho(p)}
                    >
                      Entregar sin despacho
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {seleccionadosCount > 0 && (
        <div className="cadeteria-confirm-bar">
          <span className="cadeteria-confirm-count">{seleccionadosCount} seleccionado(s)</span>
          <div className="cadeteria-confirm-actions">
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => setSelected(new Set())}
              disabled={confirmando}
            >
              Limpiar
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={handleConfirmar}
              disabled={confirmando}
            >
              {confirmando ? 'Confirmando…' : `✓ Confirmar entrega a cadetería (${seleccionadosCount})`}
            </button>
          </div>
        </div>
      )}

      {/* Modal: detalle del contenido del pedido */}
      {detalleModal && (
        <div className="cadeteria-modal-overlay" onClick={() => setDetalleModal(null)}>
          <div className="cadeteria-modal" onClick={(e) => e.stopPropagation()}>
            <h3 className="cadeteria-modal-title">Detalle del pedido</h3>
            <p className="cadeteria-modal-desc">
              Pedido <strong>#{detalleModal.pedido.numero_pedido}</strong> — {detalleModal.pedido.cliente_nombre || 'Sin nombre'}
            </p>
            {detalleModal.loading ? (
              <div className="cadeteria-empty"><p>Cargando contenido…</p></div>
            ) : detalleModal.error ? (
              <div className="cadeteria-modal-warning">⚠️ {detalleModal.error}</div>
            ) : detalleModal.items.length === 0 ? (
              <div className="cadeteria-empty"><p>Sin productos visibles en este pedido.</p></div>
            ) : (
              <ul className="cadeteria-detalle-list">
                {detalleModal.items.map((item) => {
                  const kitTipo = getKitTipo(item);
                  return (
                    <li key={item.id} className="cadeteria-detalle-item">
                      <span className="cadeteria-detalle-cant">{item.quantity}×</span>
                      <div className="cadeteria-detalle-body">
                        <div className="cadeteria-detalle-titulo">
                          {item.title}
                          {kitTipo && (
                            <span className={`cadeteria-kit-badge cadeteria-kit-${kitTipo}`}>
                              Kit {kitTipo === 'inicial' ? 'Inicial' : 'Studio'}
                            </span>
                          )}
                        </div>
                        <div className="cadeteria-detalle-meta">
                          {item.variant_title && (
                            <span className="cadeteria-detalle-color">{item.variant_title}</span>
                          )}
                          {item.sku && (
                            <span className="cadeteria-detalle-sku">{item.sku}</span>
                          )}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
            <div className="cadeteria-modal-actions">
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={() => setDetalleModal(null)}
              >
                Cerrar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal: motivo de entrega sin despacho */}
      {entregaModal && (
        <div className="cadeteria-modal-overlay" onClick={() => !registrando && setEntregaModal(null)}>
          <div className="cadeteria-modal" onClick={(e) => e.stopPropagation()}>
            <h3 className="cadeteria-modal-title">Entregar sin despacho</h3>
            <p className="cadeteria-modal-desc">
              Pedido <strong>#{entregaModal.pedido.numero_pedido}</strong> — {entregaModal.pedido.cliente_nombre || 'Sin nombre'}
            </p>
            <div className="cadeteria-modal-warning">
              ⚠️ Este pedido todavía no fue despachado. Indicá por qué se entrega igual; quedará registrado para el administrador.
            </div>
            <label className="cadeteria-modal-label" htmlFor="motivo-entrega">Motivo</label>
            <textarea
              id="motivo-entrega"
              className="cadeteria-modal-textarea"
              rows={3}
              placeholder="Ej: cliente esperando en el local, urgencia, etc."
              value={motivo}
              onChange={(e) => setMotivo(e.target.value)}
              autoFocus
            />
            <div className="cadeteria-modal-actions">
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => setEntregaModal(null)}
                disabled={registrando}
              >
                Cancelar
              </button>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={handleConfirmarEntregaSinDespacho}
                disabled={registrando || !motivo.trim()}
              >
                {registrando ? 'Registrando…' : 'Confirmar entrega'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

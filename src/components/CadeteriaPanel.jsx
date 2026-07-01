import React, { useMemo, useState } from 'react';

function getTipoEnvioLabel(tipoEnvio) {
  if (tipoEnvio === 'pickup_local') return 'Pick-Up';
  if (tipoEnvio === 'recibilo_hoy') return 'Recibilo Hoy';
  return 'Envio UES';
}

// Formatea un timestamp ISO en horario de Uruguay (America/Montevideo).
function formatearFechaUY(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString('es-UY', {
      timeZone: 'America/Montevideo',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return '';
  }
}

/**
 * Pantalla mobile-first para el retiro de paquetes por la cadetería.
 * Lista los pedidos ya despachados (previo al fulfillment). El armador/admin
 * SELECCIONA los paquetes que se lleva la cadetería y confirma todos juntos con
 * un botón; al confirmar se guardan en la BD con fecha/hora de Uruguay.
 * Los ya retirados se pueden deshacer individualmente.
 */
export default function CadeteriaPanel({ pedidos = [], onConfirmarRetiros, onDesmarcarRetiro, onActualizar }) {
  const [busqueda, setBusqueda] = useState('');
  const [selected, setSelected] = useState(() => new Set());
  const [confirmando, setConfirmando] = useState(false);
  const [deshaciendoId, setDeshaciendoId] = useState(null);

  const filtrados = useMemo(() => {
    const q = busqueda.trim().toLowerCase();
    const base = [...pedidos].sort((a, b) => {
      // No retirados primero.
      const aRet = a.retirado_cadeteria_at ? 1 : 0;
      const bRet = b.retirado_cadeteria_at ? 1 : 0;
      return aRet - bRet;
    });
    if (!q) return base;
    return base.filter((p) =>
      String(p.numero_pedido || '').toLowerCase().includes(q) ||
      String(p.cliente_nombre || '').toLowerCase().includes(q) ||
      String(p.numero_seguimiento_ues || '').toLowerCase().includes(q)
    );
  }, [pedidos, busqueda]);

  const retirados = pedidos.filter((p) => Boolean(p.retirado_cadeteria_at)).length;

  const toggleSelect = (pedido) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(pedido.id)) next.delete(pedido.id);
      else next.add(pedido.id);
      return next;
    });
  };

  const handleConfirmar = async () => {
    const seleccionados = pedidos.filter((p) => selected.has(p.id) && !p.retirado_cadeteria_at);
    if (seleccionados.length === 0) return;
    setConfirmando(true);
    try {
      await onConfirmarRetiros(seleccionados);
      setSelected(new Set());
    } finally {
      setConfirmando(false);
    }
  };

  const handleDeshacer = async (pedido, e) => {
    e.stopPropagation();
    if (deshaciendoId) return;
    setDeshaciendoId(pedido.id);
    try {
      await onDesmarcarRetiro(pedido);
    } finally {
      setDeshaciendoId(null);
    }
  };

  const seleccionadosCount = pedidos.filter((p) => selected.has(p.id) && !p.retirado_cadeteria_at).length;

  return (
    <div className="cadeteria-panel">
      <div className="cadeteria-header">
        <div>
          <h2 className="cadeteria-title">Retiro de Cadetería</h2>
          <span className="cadeteria-count">
            Retirados {retirados} / {pedidos.length}
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
          <p>{pedidos.length === 0 ? 'No hay pedidos despachados para retirar.' : 'Ningún pedido coincide con la búsqueda.'}</p>
        </div>
      ) : (
        <div className="cadeteria-list">
          {filtrados.map((p) => {
            const retirado = Boolean(p.retirado_cadeteria_at);
            const isSelected = selected.has(p.id);
            const cargando = deshaciendoId === p.id;
            return (
              <button
                key={p.id}
                type="button"
                className={`cadeteria-card${retirado ? ' cadeteria-card-retirado' : ''}${isSelected ? ' cadeteria-card-selected' : ''}`}
                onClick={() => (retirado ? undefined : toggleSelect(p))}
                disabled={retirado}
                aria-pressed={retirado || isSelected}
              >
                <div className={`cadeteria-check${retirado ? ' checked' : ''}${isSelected ? ' selected' : ''}`}>
                  {retirado ? '✓' : isSelected ? '✓' : ''}
                </div>
                <div className="cadeteria-card-info">
                  <div className="cadeteria-card-top">
                    <span className="cadeteria-card-orden">#{p.numero_pedido || p.id?.substring(0, 8)}</span>
                    <span className="cadeteria-card-tipo">{getTipoEnvioLabel(p.tipo_envio)}</span>
                  </div>
                  <div className="cadeteria-card-cliente">{p.cliente_nombre || 'Sin nombre'}</div>
                  <div className="cadeteria-card-tracking">
                    {p.numero_seguimiento_ues ? `Tracking: ${p.numero_seguimiento_ues}` : 'Sin tracking'}
                  </div>
                  {retirado && (
                    <div className="cadeteria-card-retiro-info">
                      Retirado {formatearFechaUY(p.retirado_cadeteria_at)}
                      {p.retirado_cadeteria_por ? ` · ${p.retirado_cadeteria_por}` : ''}
                    </div>
                  )}
                </div>
                {retirado && (
                  <span
                    className="cadeteria-deshacer"
                    role="button"
                    tabIndex={0}
                    onClick={(e) => handleDeshacer(p, e)}
                  >
                    {cargando ? '…' : 'Deshacer'}
                  </span>
                )}
              </button>
            );
          })}
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
    </div>
  );
}

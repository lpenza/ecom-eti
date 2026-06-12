import React, { useState } from 'react';
import ArmadoReviewModal from './modals/ArmadoReviewModal';

function getTipoEnvioLabel(tipoEnvio) {
  if (tipoEnvio === 'pickup_local') return 'Pick-Up';
  if (tipoEnvio === 'recibilo_hoy') return 'Recibilo Hoy';
  return 'Envio UES';
}

function groupByTracking(pedidos) {
  const groups = new Map();
  for (const p of pedidos) {
    const tracking = String(p.numero_seguimiento_ues || '').trim();
    if (!tracking) continue;
    if (!groups.has(tracking)) groups.set(tracking, []);
    groups.get(tracking).push(p);
  }
  const seen = new Set();
  const result = [];
  for (const p of pedidos) {
    const tracking = String(p.numero_seguimiento_ues || '').trim();
    if (!tracking) { result.push({ ...p, _mergedIds: null }); continue; }
    if (seen.has(tracking)) continue;
    seen.add(tracking);
    const group = groups.get(tracking);
    if (group.length === 1) {
      result.push(p);
    } else {
      result.push({
        ...group[0],
        numero_pedido: group.map(g => g.numero_pedido).join(' / '),
        _mergedIds: group.map(g => g.id),
        _mergedPedidos: group,
        _isDuplicateTracking: true,
      });
    }
  }
  return result;
}

export default function ArmadorPanel({ pedidos = [], onActualizar, onMarcarArmadoBulk }) {
  // Modal de revisión
  const [reviewQueue, setReviewQueue] = useState(null); // null | { pedidos, startIndex }

  // Callback del modal: confirma todos los pedidos que quedaron en "Listo".
  const handleConfirmarListosDelModal = async (primaryIds, secondaryIds = []) => {
    if (!Array.isArray(primaryIds) || primaryIds.length === 0) return;
    await onMarcarArmadoBulk(primaryIds, secondaryIds);
  };

  return (
    <>
    <div className="armador-panel">
      <div className="armador-panel-header">
        <div>
          <h2 className="armador-panel-title">Pedidos a Armar</h2>
          <span className="armador-panel-count">
            {pedidos.length} pendiente{pedidos.length !== 1 ? 's' : ''}
          </span>
        </div>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={onActualizar}
        >
          Actualizar
        </button>
      </div>

      <div className="atencion-info-card">
        <div className="atencion-info-item">
          <div className="atencion-info-item-header">
            <span className="atencion-info-badge atencion-info-badge-mvd">Montevideo</span>
            <span className="atencion-info-time">24-48 hs hábiles</span>
          </div>
          <div className="atencion-info-carrier">
            Envíos por <strong>Marco Postal</strong>
            {' · '}
            <a
              href="https://marcopostal.epresis.com/seguimiento"
              target="_blank"
              rel="noopener noreferrer"
            >
              Seguimiento
            </a>
          </div>
        </div>
        <div className="atencion-info-item">
          <div className="atencion-info-item-header">
            <span className="atencion-info-badge atencion-info-badge-interior">Interior</span>
            <span className="atencion-info-time">24-72 hs hábiles</span>
          </div>
          <div className="atencion-info-carrier">
            Envíos por <strong>UES</strong>
            {' · '}
            <a
              href="https://ues.com.uy/rastreo_paquete.html"
              target="_blank"
              rel="noopener noreferrer"
            >
              Seguimiento
            </a>
          </div>
        </div>
      </div>

      {pedidos.length > 0 && (
        <div className="section-action-bar">
          <span>El detalle de productos se valida dentro del modal de revision.</span>
          <button
            className="btn btn-primary btn-sm"
            onClick={() => setReviewQueue({ pedidos: groupByTracking(pedidos), startIndex: 0 })}
          >
            Revisar y armar todos ({pedidos.length})
          </button>
        </div>
      )}

      <div className="armador-body">
        {pedidos.length === 0 ? (
          <div className="armador-empty">
            <p>No hay pedidos pendientes por armar</p>
          </div>
        ) : (
          <table className="armador-table">
            <thead>
              <tr>
                <th>N&deg; Orden</th>
                <th>Tipo de entrega</th>
                <th>Tracking</th>
                <th>Nota</th>
              </tr>
            </thead>
            <tbody>
              {groupByTracking(pedidos).map((p) => (
                <tr
                  key={p._mergedIds ? p._mergedIds.join('-') : p.id}
                  className={p._isDuplicateTracking ? 'armador-row-duplicate-tracking' : ''}
                >
                  <td className="armador-orden">
                    #{p.numero_pedido || p.id?.substring(0, 8)}
                    {p.es_reclamo && (
                      <span className="pedido-duplicate-tracking-badge" style={{ background: '#fef9c3', color: '#92400e', borderColor: '#fde047' }}>
                        ⚠ reclamo
                      </span>
                    )}
                    {p._isDuplicateTracking && (
                      <span className="pedido-duplicate-tracking-badge" title="Estos pedidos comparten el mismo número de seguimiento">
                        📦 mismo tracking
                      </span>
                    )}
                  </td>
                  <td>{getTipoEnvioLabel(p.tipo_envio)}</td>
                  <td>{p.numero_seguimiento_ues || '-'}</td>
                  <td style={{ maxWidth: '220px' }}>
                    {p.motivo_reenvio ? (
                      <span style={{ display: 'inline-block', background: '#fee2e2', border: '1px solid #f87171', color: '#991b1b', borderRadius: '6px', padding: '0.2rem 0.5rem', fontSize: '0.8rem', fontWeight: 600 }}>
                        ⚠ {p.motivo_reenvio}
                      </span>
                    ) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>

    {reviewQueue && (
      <ArmadoReviewModal
        pedidos={reviewQueue.pedidos}
        initialIndex={reviewQueue.startIndex}
        onConfirmarListos={handleConfirmarListosDelModal}
        onClose={() => setReviewQueue(null)}
      />
    )}
    </>
  );
}

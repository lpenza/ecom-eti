import React, { useState } from 'react';
import ArmadoReviewModal from './modals/ArmadoReviewModal';

function getTipoEnvioLabel(tipoEnvio) {
  if (tipoEnvio === 'pickup_local') return 'Pick-Up';
  if (tipoEnvio === 'recibilo_hoy') return 'Recibilo Hoy';
  return 'Envio UES';
}

export default function ArmadorPanel({ pedidos = [], onActualizar, onMarcarArmadoBulk }) {
  // Modal de revisión
  const [reviewQueue, setReviewQueue] = useState(null); // null | { pedidos, startIndex }

  // Callback del modal: confirma todos los pedidos que quedaron en "Listo".
  const handleConfirmarListosDelModal = async (pedidoIds) => {
    if (!Array.isArray(pedidoIds) || pedidoIds.length === 0) return;
    await onMarcarArmadoBulk(pedidoIds);
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

      {pedidos.length > 0 && (
        <div className="section-action-bar">
          <span>El detalle de productos se valida dentro del modal de revision.</span>
          <button
            className="btn btn-primary btn-sm"
            onClick={() => setReviewQueue({ pedidos, startIndex: 0 })}
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
              </tr>
            </thead>
            <tbody>
              {pedidos.map((p) => (
                <tr key={p.id}>
                  <td className="armador-orden">#{p.numero_pedido || p.id?.substring(0, 8)}</td>
                  <td>{getTipoEnvioLabel(p.tipo_envio)}</td>
                  <td>{p.numero_seguimiento_ues || '-'}</td>
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

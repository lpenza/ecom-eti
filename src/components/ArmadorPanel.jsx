import React, { useMemo, useState } from 'react';
import ArmadoReviewModal from './modals/ArmadoReviewModal';

// Etiqueta de tipo de entrega. Montevideo se despacha por MarcoPostal (no UES);
// se detecta por el link de etiqueta MarcoPostal o por departamento = Montevideo.
function getTipoEnvioLabel(pedido) {
  const tipoEnvio = pedido?.tipo_envio;
  if (tipoEnvio === 'pickup_local') return 'Pick-Up';
  if (tipoEnvio === 'recibilo_hoy') return 'Recibilo Hoy';
  // Venta de ML con Mercado Envíos: la etiqueta y el transporte son de ML. Sin
  // esto caía en "Envio UES" por descarte y el armador lo despachaba mal.
  // Una venta de ML SIN envío asignado sí sigue el flujo normal (UES/MarcoPostal).
  if (pedido?.origen === 'mercadolibre' && pedido?.ml_shipment_id) return 'MERCADOLIBRE';
  const link = String(pedido?.link_etiqueta_drive || '').toLowerCase();
  const esMarcoPostal = /marcopostal|etiquetas-marcopostal/.test(link)
    || String(pedido?.departamento || '').trim().toLowerCase() === 'montevideo';
  if (esMarcoPostal) return 'MarcoPostal';
  return 'Envio UES';
}

// Couriers que emiten etiqueta. El armador imprime por courier porque cada lote
// sale distinto: MarcoPostal se renderiza on-demand y tarda, ML viaja con etiqueta
// de Mercado Envíos y UES es el PDF que queda en Drive.
const COURIERS = [
  { key: 'marcopostal', label: 'MarcoPostal', icon: '📮' },
  { key: 'ues', label: 'UES', icon: '🚚' },
  { key: 'mercadolibre', label: 'Mercado Libre', icon: '🛒' },
];

// Courier real de la etiqueta. Se decide por el link del PDF, que es la fuente más
// confiable: Pick-UP y Recibilo Hoy también se etiquetan por MarcoPostal, así que
// el tipo de entrega solo no alcanza. Si el pedido todavía no tiene etiqueta caemos
// a la heurística de origen/tipo/destino para poder agruparlo igual.
function getCourier(pedido) {
  const link = String(pedido?.link_etiqueta_drive || '').toLowerCase();
  if (link) {
    if (/mercadolibre/.test(link)) return 'mercadolibre';
    if (/marcopostal/.test(link)) return 'marcopostal';
    return 'ues';
  }
  if (pedido?.origen === 'mercadolibre' && pedido?.ml_shipment_id) return 'mercadolibre';
  const tipoEnvio = pedido?.tipo_envio;
  if (tipoEnvio === 'pickup_local' || tipoEnvio === 'recibilo_hoy') return 'marcopostal';
  if (String(pedido?.departamento || '').trim().toLowerCase() === 'montevideo') return 'marcopostal';
  return 'ues';
}

function getCourierInfo(key) {
  return COURIERS.find((c) => c.key === key) || { key, label: key, icon: '📦' };
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

export default function ArmadorPanel({ pedidos = [], onActualizar, onMarcarArmadoBulk, onImprimirEtiqueta, onImprimirEtiquetas, onAbrirStockPlanner }) {
  // Modal de revisión
  const [reviewQueue, setReviewQueue] = useState(null); // null | { pedidos, startIndex }
  // Courier elegido para ver/imprimir ('todos' = la cola completa).
  const [courierFilter, setCourierFilter] = useState('todos');

  // Callback del modal: confirma todos los pedidos que quedaron en "Listo".
  const handleConfirmarListosDelModal = async (primaryIds, secondaryIds = []) => {
    if (!Array.isArray(primaryIds) || primaryIds.length === 0) return;
    await onMarcarArmadoBulk(primaryIds, secondaryIds);
  };

  // Filas agrupadas por tracking (dedupe para impresión combinada).
  const filas = useMemo(() => groupByTracking(pedidos), [pedidos]);

  // Conteos por courier: total de filas y cuántas tienen etiqueta imprimible.
  const conteos = useMemo(() => {
    const base = {};
    for (const c of COURIERS) base[c.key] = { total: 0, conEtiqueta: 0 };
    for (const p of filas) {
      const key = getCourier(p);
      if (!base[key]) base[key] = { total: 0, conEtiqueta: 0 };
      base[key].total += 1;
      if (String(p.link_etiqueta_drive || '').trim()) base[key].conEtiqueta += 1;
    }
    return base;
  }, [filas]);

  const filasVisibles = courierFilter === 'todos'
    ? filas
    : filas.filter((p) => getCourier(p) === courierFilter);
  const filasConEtiqueta = filasVisibles.filter((p) => String(p.link_etiqueta_drive || '').trim());

  const courierActivo = courierFilter === 'todos' ? null : getCourierInfo(courierFilter);

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
        <div className="armador-panel-header-actions">
          {onAbrirStockPlanner && (
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={onAbrirStockPlanner}
              title="Abrir StockPlanner (Pedidos en camino) con sesión iniciada"
            >
              📊 StockPlanner
            </button>
          )}
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={onActualizar}
          >
            Actualizar
          </button>
        </div>
      </div>

      {pedidos.length > 0 && (
        <div className="armador-courier-bar">
          <span className="armador-courier-bar-label">Courier:</span>
          <button
            type="button"
            className={'armador-courier-chip' + (courierFilter === 'todos' ? ' is-active' : '')}
            onClick={() => setCourierFilter('todos')}
            title="Ver e imprimir la cola completa"
          >
            Todos <span>{filas.length}</span>
          </button>
          {COURIERS.map((c) => {
            const conteo = conteos[c.key] || { total: 0, conEtiqueta: 0 };
            return (
              <button
                key={c.key}
                type="button"
                className={
                  'armador-courier-chip armador-courier-chip--' + c.key
                  + (courierFilter === c.key ? ' is-active' : '')
                }
                onClick={() => setCourierFilter(c.key)}
                disabled={conteo.total === 0}
                title={conteo.total === 0
                  ? 'No hay pedidos de ' + c.label + ' en la cola'
                  : conteo.total + ' pedido(s) de ' + c.label + ' — ' + conteo.conEtiqueta + ' con etiqueta lista'}
              >
                {c.icon} {c.label} <span>{conteo.total}</span>
              </button>
            );
          })}
        </div>
      )}

      {pedidos.length > 0 && (
        <div className="section-action-bar">
          <span>El detalle de productos se valida dentro del modal de revision.</span>
          {onImprimirEtiquetas && (
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => onImprimirEtiquetas(filasConEtiqueta)}
              disabled={filasConEtiqueta.length === 0}
              title={filasConEtiqueta.length === 0
                ? 'Ninguno de estos pedidos tiene etiqueta PDF disponible'
                : courierActivo
                  ? 'Descargar/imprimir juntas las etiquetas de ' + courierActivo.label
                  : 'Descargar/imprimir juntas las etiquetas de la cola'}
            >
              {courierActivo
                ? '🖨️ Imprimir etiquetas ' + courierActivo.label + ' (' + filasConEtiqueta.length + ')'
                : '🖨️ Imprimir etiquetas (' + filasConEtiqueta.length + ')'}
            </button>
          )}
          <button
            className="btn btn-primary btn-sm"
            onClick={() => setReviewQueue({ pedidos: filasVisibles, startIndex: 0 })}
            disabled={filasVisibles.length === 0}
          >
            {courierActivo
              ? 'Revisar y armar ' + courierActivo.label + ' (' + filasVisibles.length + ')'
              : 'Revisar y armar todos (' + filasVisibles.length + ')'}
          </button>
        </div>
      )}

      <div className="armador-body">
        {pedidos.length === 0 ? (
          <div className="armador-empty">
            <p>No hay pedidos pendientes por armar</p>
          </div>
        ) : filasVisibles.length === 0 ? (
          <div className="armador-empty">
            <p>No hay pedidos de {courierActivo ? courierActivo.label : 'este courier'} en la cola</p>
          </div>
        ) : (
          <table className="armador-table">
            <thead>
              <tr>
                <th>N&deg; Orden</th>
                <th>Courier</th>
                <th>Tipo de entrega</th>
                <th>Tracking</th>
                <th>Nota</th>
                <th>Etiqueta</th>
              </tr>
            </thead>
            <tbody>
              {filasVisibles.map((p) => {
                const courier = getCourierInfo(getCourier(p));
                const tieneEtiqueta = Boolean(String(p.link_etiqueta_drive || '').trim());
                return (
                  <tr
                    key={p._mergedIds ? p._mergedIds.join('-') : p.id}
                    className={p._isDuplicateTracking ? 'armador-row-duplicate-tracking' : ''}
                  >
                    <td className="armador-orden">
                      #{p.numero_pedido || p.id?.substring(0, 8)}
                      {p.origen === 'mercadolibre' && (
                        <span
                          className="pedido-ml-badge"
                          title={p.ml_shipment_id
                            ? 'Venta de MercadoLibre — viaja con etiqueta de Mercado Envíos'
                            : 'Venta de MercadoLibre — se despacha por nuestra cuenta'}
                        >
                          🛒 MERCADOLIBRE
                        </span>
                      )}
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
                    <td>
                      <span className={'armador-courier-badge armador-courier-badge--' + courier.key}>
                        {courier.icon} {courier.label}
                      </span>
                    </td>
                    <td>{getTipoEnvioLabel(p)}</td>
                    <td>{p.numero_seguimiento_ues || '-'}</td>
                    <td style={{ maxWidth: '220px' }}>
                      {p.motivo_reenvio ? (
                        <span style={{ display: 'inline-block', background: '#fee2e2', border: '1px solid #f87171', color: '#991b1b', borderRadius: '6px', padding: '0.2rem 0.5rem', fontSize: '0.8rem', fontWeight: 600 }}>
                          ⚠ {p.motivo_reenvio}
                        </span>
                      ) : '—'}
                    </td>
                    <td>
                      {onImprimirEtiqueta && (
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          onClick={() => onImprimirEtiqueta(p)}
                          disabled={!tieneEtiqueta}
                          title={tieneEtiqueta
                            ? 'Imprimir/descargar la etiqueta ' + courier.label + ' de este pedido'
                            : 'Este pedido no tiene etiqueta PDF disponible'}
                        >
                          🖨️
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
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
        onImprimirEtiqueta={onImprimirEtiqueta}
        onClose={() => setReviewQueue(null)}
      />
    )}
    </>
  );
}

import React, { useCallback, useEffect, useState } from 'react';
import { obtenerPedidosAtencion, obtenerDetallePedido } from '../services/api';

// Estado visible para atención al cliente, derivado con la misma lógica que usa
// el tablero de admin (precedencia: procesado > despachado > etiqueta > contacto > validar).
function derivarEstado(p) {
  const estado = String(p.estado || '').toLowerCase();
  if (estado === 'enviado') {
    return { key: 'procesado', label: 'Procesado', icon: '✅', cls: 'de-estado-enviado' };
  }
  if (estado === 'despachado') {
    return { key: 'despachado', label: 'Despachado', icon: '🚀', cls: 'de-estado-despachado' };
  }
  if (estado === 'cancelado') {
    return { key: 'cancelado', label: 'Cancelado', icon: '🚫', cls: '' };
  }
  if (p.etiqueta_generada) {
    return { key: 'etiqueta', label: 'Etiqueta generada', icon: '📄', cls: 'de-estado-etiqueta' };
  }
  if (p.revision_contacto_pendiente) {
    return { key: 'contacto', label: 'Pendiente de contacto', icon: '📞', cls: 'de-estado-pendiente' };
  }
  return { key: 'porValidar', label: 'Por validar', icon: '🕐', cls: 'de-estado-pendiente' };
}

const TIPO_ENVIO_LABELS = {
  pickup_local: '🏪 Pick-UP',
  recibilo_hoy: '⚡ Recibilo Hoy',
};

function fmtFecha(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('es-UY', { day: '2-digit', month: '2-digit', year: '2-digit' });
}

export default function AtencionPanel({ mostrarToast }) {
  const [pedidos, setPedidos] = useState([]);
  const [loading, setLoading] = useState(false);
  const [busqueda, setBusqueda] = useState('');
  // Detalle por pedido: { [pedidoId]: { loading, items, error, open } }
  const [detalles, setDetalles] = useState({});

  const cargar = useCallback(async (q = '') => {
    setLoading(true);
    try {
      const res = await obtenerPedidosAtencion(q);
      if (res?.success) {
        setPedidos(Array.isArray(res.data) ? res.data : []);
      } else {
        mostrarToast?.(res?.error || 'Error cargando pedidos', 'error');
      }
    } catch (err) {
      mostrarToast?.(`Error: ${err.message}`, 'error');
    } finally {
      setLoading(false);
    }
  }, [mostrarToast]);

  // Carga inicial y búsqueda con debounce — busca en el servidor (toda la historia)
  useEffect(() => {
    const timer = setTimeout(() => { cargar(busqueda.trim()); }, busqueda ? 400 : 0);
    return () => clearTimeout(timer);
  }, [busqueda, cargar]);

  const toggleDetalle = async (pedido) => {
    const actual = detalles[pedido.id];
    if (actual?.open) {
      setDetalles((d) => ({ ...d, [pedido.id]: { ...actual, open: false } }));
      return;
    }
    if (actual?.items) {
      setDetalles((d) => ({ ...d, [pedido.id]: { ...actual, open: true } }));
      return;
    }
    setDetalles((d) => ({ ...d, [pedido.id]: { loading: true, open: true } }));
    try {
      const res = await obtenerDetallePedido(pedido.numero_pedido);
      setDetalles((d) => ({
        ...d,
        [pedido.id]: res?.success
          ? { loading: false, open: true, items: res.lineItems || [] }
          : { loading: false, open: true, error: res?.error || 'No se pudo cargar el contenido' },
      }));
    } catch (err) {
      setDetalles((d) => ({ ...d, [pedido.id]: { loading: false, open: true, error: err.message } }));
    }
  };

  return (
    <div className="main-content">
      <div className="de-wrapper">
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap', marginBottom: '1rem' }}>
          <h2 style={{ margin: 0 }}>🎧 Atención al Cliente</h2>
          <input
            type="text"
            placeholder="Buscar por número, nombre, email o teléfono…"
            value={busqueda}
            onChange={(e) => setBusqueda(e.target.value)}
            style={{ flex: '1 1 280px', maxWidth: 420, padding: '0.5rem 0.75rem' }}
          />
          <button className="btn btn-secondary btn-sm" onClick={() => cargar(busqueda.trim())} disabled={loading}>
            {loading ? '⏳ Cargando…' : '🔄 Actualizar'}
          </button>
        </div>

        {pedidos.length === 0 && !loading ? (
          <div className="de-empty">
            <span style={{ fontSize: '2rem' }}>🔍</span>
            <p>{busqueda ? 'No se encontraron pedidos para esa búsqueda.' : 'No hay pedidos para mostrar.'}</p>
          </div>
        ) : (
          <div className="reclamos-table-wrapper">
            <table className="reclamos-table">
              <thead>
                <tr>
                  <th>N° Orden</th>
                  <th>Cliente</th>
                  <th>Contacto</th>
                  <th>Fecha</th>
                  <th>Envío</th>
                  <th>Estado</th>
                  <th>N° de guía</th>
                  <th>Contenido</th>
                </tr>
              </thead>
              <tbody>
                {pedidos.map((pedido) => {
                  const est = derivarEstado(pedido);
                  const det = detalles[pedido.id] || {};
                  const tipoLabel = TIPO_ENVIO_LABELS[pedido.tipo_envio] || '📦 Estándar';
                  return (
                    <React.Fragment key={pedido.id}>
                      <tr>
                        <td><strong>#{pedido.numero_pedido}</strong></td>
                        <td>{pedido.cliente_nombre || '—'}</td>
                        <td style={{ fontSize: 12 }}>
                          {pedido.cliente_telefono || '—'}
                          {pedido.cliente_email ? <><br />{pedido.cliente_email}</> : null}
                        </td>
                        <td>{fmtFecha(pedido.created_at)}</td>
                        <td style={{ fontSize: 12 }}>{tipoLabel}</td>
                        <td>
                          <span className={`reclamo-estado-badge ${est.cls}`}>
                            {est.icon} {est.label}
                          </span>
                          {est.key === 'contacto' && pedido.revision_contacto_motivo && (
                            <div style={{ fontSize: 12, color: '#a15c00', marginTop: 4, maxWidth: 220 }}>
                              Motivo: {pedido.revision_contacto_motivo}
                            </div>
                          )}
                        </td>
                        <td>
                          {est.key === 'procesado' && pedido.numero_seguimiento_ues
                            ? <strong>{pedido.numero_seguimiento_ues}</strong>
                            : <span style={{ color: '#bbb' }}>—</span>}
                        </td>
                        <td>
                          <button
                            className="btn btn-secondary btn-sm"
                            onClick={() => toggleDetalle(pedido)}
                            disabled={det.loading}
                            title="Ver los productos del pedido">
                            {det.loading ? '⏳' : det.open ? '▲ Ocultar' : '👁 Ver'}
                          </button>
                        </td>
                      </tr>
                      {det.open && !det.loading && (
                        <tr>
                          <td colSpan={8} style={{ background: '#fafafa', padding: '0.6rem 1rem' }}>
                            {det.error ? (
                              <span style={{ color: '#c0392b' }}>⚠️ {det.error}</span>
                            ) : (det.items || []).length === 0 ? (
                              <span style={{ color: '#888' }}>Sin productos visibles en este pedido.</span>
                            ) : (
                              <ul style={{ margin: 0, paddingLeft: '1.2rem' }}>
                                {det.items.map((item) => (
                                  <li key={item.id} style={{ fontSize: 13 }}>
                                    {item.quantity} × {item.title}
                                    {item.variant_title ? ` — ${item.variant_title}` : ''}
                                    {item.sku ? <span style={{ color: '#999' }}> ({item.sku})</span> : null}
                                  </li>
                                ))}
                              </ul>
                            )}
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

import React, { useState, useEffect, useCallback } from 'react';
import { obtenerMisPedidosArmados } from '../services/api';

const hoy = new Date().toISOString().slice(0, 10);
const inicioMes = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10);

function formatFecha(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('es-UY', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export default function MisPedidosPanel({ user }) {
  const [desde, setDesde] = useState(inicioMes);
  const [hasta, setHasta] = useState(hoy);
  const [pedidos, setPedidos] = useState([]);
  const [montoPorPedido, setMontoPorPedido] = useState(0);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);

  const cargar = useCallback(async () => {
    setLoading(true);
    try {
      const res = await obtenerMisPedidosArmados(desde, hasta);
      if (res.success) {
        setPedidos(res.pedidos || []);
        setMontoPorPedido(res.monto_por_pedido || 0);
        setTotal(res.total || 0);
      }
    } finally {
      setLoading(false);
    }
  }, [desde, hasta]);

  useEffect(() => { cargar(); }, [cargar]);

  return (
    <div className="mis-pedidos-panel">
      <div className="mis-pedidos-header">
        <div>
          <h2 className="mis-pedidos-title">Mis pedidos armados</h2>
          <p className="mis-pedidos-sub">Pedidos que procesaste en el período seleccionado</p>
        </div>
      </div>

      <div className="mis-pedidos-filtros">
        <label>
          Desde
          <input type="date" value={desde} onChange={(e) => setDesde(e.target.value)} />
        </label>
        <label>
          Hasta
          <input type="date" value={hasta} onChange={(e) => setHasta(e.target.value)} />
        </label>
        <button className="btn btn-secondary" onClick={cargar} disabled={loading}>
          {loading ? 'Cargando...' : '🔄 Actualizar'}
        </button>
      </div>

      <div className="mis-pedidos-resumen">
        <div className="mis-resumen-card">
          <div className="mis-resumen-valor">{pedidos.length}</div>
          <div className="mis-resumen-label">Pedidos armados</div>
        </div>
        <div className="mis-resumen-card">
          <div className="mis-resumen-valor">${Number(montoPorPedido).toFixed(2)}</div>
          <div className="mis-resumen-label">Monto por pedido</div>
        </div>
        <div className="mis-resumen-card mis-resumen-total">
          <div className="mis-resumen-valor">${Number(total).toFixed(2)}</div>
          <div className="mis-resumen-label">Total a cobrar</div>
        </div>
      </div>

      <table className="mis-pedidos-tabla">
        <thead>
          <tr>
            <th>N° Pedido</th>
            <th>Cliente</th>
            <th>Fecha procesado</th>
            <th>Monto</th>
          </tr>
        </thead>
        <tbody>
          {pedidos.map((p) => (
            <tr key={p.id}>
              <td className="mis-col-numero">#{p.numero_pedido || '—'}</td>
              <td>{p.cliente_nombre || '—'}</td>
              <td className="mis-col-fecha">{formatFecha(p.armado_at)}</td>
              <td className="mis-col-monto">${Number(montoPorPedido).toFixed(2)}</td>
            </tr>
          ))}
          {pedidos.length === 0 && !loading && (
            <tr>
              <td colSpan={4} className="mis-empty">No hay pedidos armados en este período</td>
            </tr>
          )}
          {loading && (
            <tr>
              <td colSpan={4} className="mis-empty">Cargando...</td>
            </tr>
          )}
        </tbody>
        {pedidos.length > 0 && (
          <tfoot>
            <tr>
              <td colSpan={3} className="mis-total-label">Total del período</td>
              <td className="mis-col-monto mis-total-bold">${Number(total).toFixed(2)}</td>
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}

import React, { useEffect, useMemo, useState } from 'react';
import { previewLoteComprobantes, emitirLoteComprobantes } from '../../services/api';
import { cierreFuera } from '../../utils/cierreModal';

// Emisión masiva de e-Tickets en Zensei. Primero revisa todos los pedidos (sin
// emitir), muestra cuáles están listos, cuáles no y por qué, y recién al
// confirmar emite de a uno, marcando cada fila a medida que Zensei responde.
// Los pedidos que ya tienen comprobante nunca se vuelven a mandar.
// Los pedidos del mismo cliente salen en UN solo e-Ticket: el server los junta
// en el primero que revisa y el resto de la tanda queda como "va en el de #X".

const pesos = (n) =>
  `$ ${Number(n || 0).toLocaleString('es-UY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fechaCorta = (iso) => (iso ? iso.split('-').reverse().join('/') : '—');

const celdaNum = { textAlign: 'right', whiteSpace: 'nowrap' };

// Un resultado de emisión vale para todos los pedidos de su e-Ticket.
const porPedido = (resultados) => {
  const mapa = {};
  for (const r of resultados) {
    for (const id of r.pedidoIds || [r.pedidoId]) mapa[id] = r;
  }
  return mapa;
};

export default function ComprobanteLoteModal({ pedidos, onClose, onTerminado, mostrarToast }) {
  const ids = useMemo(() => pedidos.map((p) => p.id), [pedidos]);
  const [fase, setFase] = useState('revisando'); // revisando | listo | emitiendo | fin
  const [items, setItems] = useState({}); // pedidoId → item del preview
  const [resultados, setResultados] = useState({}); // pedidoId → resultado de la emisión
  const [progreso, setProgreso] = useState({ hechos: 0, total: ids.length, mensaje: '' });
  const [modoFecha, setModoFecha] = useState('auto'); // auto | hoy
  const [config, setConfig] = useState({ configurado: true, faltaConfigurar: [] });
  const [error, setError] = useState(null);
  const [resumen, setResumen] = useState(null);

  useEffect(() => {
    let cancelado = false;
    (async () => {
      try {
        const res = await previewLoteComprobantes(ids, (ev) => {
          if (cancelado) return;
          setProgreso({ hechos: ev.hechos, total: ev.total, mensaje: ev.mensaje });
          if (ev.item) setItems((prev) => ({ ...prev, [ev.item.pedidoId]: ev.item }));
        });
        if (cancelado) return;
        const todos = {};
        for (const it of res.items || []) todos[it.pedidoId] = it;
        setItems(todos);
        setConfig({ configurado: res.configurado, faltaConfigurar: res.faltaConfigurar || [] });
        setFase('listo');
      } catch (err) {
        if (!cancelado) { setError(err.message || 'No se pudo revisar los pedidos'); setFase('listo'); }
      }
    })();
    return () => { cancelado = true; };
  }, [ids]);

  const filas = pedidos.map((p) => ({ pedido: p, item: items[p.id], resultado: resultados[p.id] }));
  const listos = filas.filter((f) => f.item?.listo);
  const totalListos = listos.reduce((s, f) => s + Number(f.item.total || 0), 0);
  const fechaDe = (item) =>
    !item?.fechas ? null : (modoFecha === 'auto' && item.fechas.pedidoPermitida ? item.fechas.pedido : item.fechas.hoy);

  async function emitir() {
    if (!listos.length) return;
    const pedidosCubiertos = listos.reduce((s, f) => s + (f.item.pedidoIds?.length || 1), 0);
    const ok = window.confirm(
      `Se van a emitir ${listos.length} e-Ticket(s) REALES a DGI por un total de ${pesos(totalListos)}` +
      `${pedidosCubiertos > listos.length ? ` (cubren ${pedidosCubiertos} pedidos: los del mismo cliente van juntos)` : ''}.\n\n` +
      `Fecha: ${modoFecha === 'auto' ? 'la del pedido cuando tenga hasta 2 días, si no la de hoy' : 'hoy para todos'}.\n\n¿Confirmás?`
    );
    if (!ok) return;
    setFase('emitiendo');
    setError(null);
    setProgreso({ hechos: 0, total: listos.length, mensaje: 'Emitiendo…' });
    try {
      const grupos = Object.fromEntries(listos.map((f) => [f.pedido.id, f.item.pedidoIds || [f.pedido.id]]));
      const res = await emitirLoteComprobantes(listos.map((f) => f.pedido.id), modoFecha, (ev) => {
        setProgreso({ hechos: ev.hechos, total: ev.total, mensaje: ev.mensaje });
        if (ev.item) setResultados((prev) => ({ ...prev, ...porPedido([ev.item]) }));
      }, grupos);
      setResultados((prev) => ({ ...prev, ...porPedido(res.resultados || []) }));
      setResumen(res);
      mostrarToast?.(
        `🧾 ${res.emitidos} de ${res.total} e-Ticket(s) emitidos${res.corte ? ' — se cortó la tanda' : ''}`,
        res.emitidos === res.total ? 'success' : 'warning'
      );
      onTerminado?.(res.resultados || []);
    } catch (err) {
      setError(`${err.message || 'Se cortó la emisión'}. Lo que ya se emitió quedó guardado; volvé a abrir la emisión masiva para ver qué falta (no se duplica).`);
      onTerminado?.(Object.values(resultados));
    } finally {
      setFase('fin');
    }
  }

  function estadoFila({ item, resultado }) {
    if (resultado) {
      if (resultado.ok) return <span style={{ color: '#16a34a', fontWeight: 600 }}>✅ {resultado.comprobante?.serie}-{resultado.comprobante?.numero}</span>;
      if (resultado.yaEmitido) return <span style={{ color: '#6b7280' }}>✔ Ya tenía {resultado.comprobante?.serie}-{resultado.comprobante?.numero}</span>;
      return <span style={{ color: '#dc2626' }} title={resultado.error}>❌ {resultado.error}</span>;
    }
    if (!item) return <span style={{ color: '#9ca3af' }}>Revisando…</span>;
    if (item.incluidoEn) return <span style={{ color: '#6b7280' }}>↳ Va en el e-Ticket de #{item.numeroPrincipal} (mismo cliente)</span>;
    if (item.comprobante) return <span style={{ color: '#6b7280' }}>✔ Ya tiene {item.comprobante.serie}-{item.comprobante.numero}</span>;
    if (!item.listo) return <span style={{ color: '#dc2626' }} title={(item.bloqueos || []).join('\n')}>⛔ {item.bloqueos?.[0]}</span>;
    const notas = [...(item.avisos || []), item.redondeo ? 'Lleva línea de redondeo de $0,01' : null, item.errorAnterior ? `Intento anterior: ${item.errorAnterior}` : null].filter(Boolean);
    return (
      <span style={{ color: '#2563eb' }} title={notas.join('\n')}>
        {fase === 'emitiendo' ? '⏳ En cola' : 'Listo'}{notas.length ? ' ⚠️' : ''}
      </span>
    );
  }

  const ocupado = fase === 'revisando' || fase === 'emitiendo';

  return (
    <div
      className="modal modal-open"
      {...cierreFuera(onClose, { bloqueado: fase === 'emitiendo', confirmar: false })}
    >
      <div className="modal-content modal-large" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>🧾 Emisión masiva de e-Tickets · {pedidos.length} pedido(s)</h3>
          <button className="btn-close" onClick={onClose} disabled={fase === 'emitiendo'}>&times;</button>
        </div>

        <div className="modal-body">
          {ocupado && (
            <div style={{ margin: '0 0 10px' }}>
              <div style={{ fontSize: '0.9rem', marginBottom: 4 }}>
                {progreso.mensaje || 'Revisando…'} {fase === 'emitiendo' && '— no cierres esta ventana'}
              </div>
              <div style={{ height: 6, background: '#e5e7eb', borderRadius: 3 }}>
                <div style={{ height: 6, borderRadius: 3, background: '#2563eb', width: `${progreso.total ? (100 * progreso.hechos) / progreso.total : 0}%`, transition: 'width .3s' }} />
              </div>
            </div>
          )}

          {error && <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 6, padding: '8px 12px', margin: '8px 0' }}>❌ {error}</div>}
          {!config.configurado && (
            <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 6, padding: '8px 12px', margin: '8px 0' }}>
              ⚙️ Falta configurar en el servidor: {config.faltaConfigurar.join(', ')}
            </div>
          )}
          {resumen && (
            <div style={{ background: resumen.emitidos === resumen.total ? '#f0fdf4' : '#fffbeb', border: '1px solid #e5e7eb', borderRadius: 6, padding: '8px 12px', margin: '8px 0' }}>
              {resumen.emitidos} de {resumen.total} emitido(s).
              {resumen.corte && <> La tanda se cortó: <strong>{resumen.corte}</strong>. Quedaron {resumen.pendientes} sin intentar.</>}
            </div>
          )}

          {fase !== 'revisando' && !resumen && (
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center', margin: '4px 0 10px', fontSize: '0.9rem' }}>
              <strong>Fecha de emisión:</strong>
              <label style={{ cursor: 'pointer' }}>
                <input type="radio" name="fecha-lote" checked={modoFecha === 'auto'} disabled={fase === 'emitiendo'} onChange={() => setModoFecha('auto')} />{' '}
                La del pedido si tiene hasta 2 días (si no, hoy)
              </label>
              <label style={{ cursor: 'pointer' }}>
                <input type="radio" name="fecha-lote" checked={modoFecha === 'hoy'} disabled={fase === 'emitiendo'} onChange={() => setModoFecha('hoy')} />{' '}
                Hoy para todos
              </label>
            </div>
          )}

          <div style={{ maxHeight: '50vh', overflowY: 'auto' }}>
            <table className="pedidos-table" style={{ fontSize: '0.85rem' }}>
              <thead>
                <tr>
                  <th>Pedido</th>
                  <th>Cliente</th>
                  <th style={celdaNum}>Total</th>
                  <th>Fecha</th>
                  <th>Estado</th>
                </tr>
              </thead>
              <tbody>
                {filas.map((f) => (
                  <tr key={f.pedido.id}>
                    <td>
                      {f.item?.numeros?.length > 1
                        ? <span title="Mismo cliente: un solo e-Ticket">{f.item.numeros.map((n) => `#${n}`).join(' + ')}</span>
                        : `#${f.pedido.numero_pedido}`}
                    </td>
                    <td>{f.item?.cliente || f.pedido.cliente_nombre || '—'}</td>
                    <td style={celdaNum}>{f.item?.total != null ? pesos(f.item.total) : '—'}</td>
                    <td>{f.item?.listo ? fechaCorta(fechaDe(f.item)) : '—'}</td>
                    <td>{estadoFila(f)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="modal-footer">
          <span style={{ marginRight: 'auto', fontSize: '0.9rem', color: '#6b7280' }}>
            {fase !== 'revisando' && `${listos.length} listo(s) para emitir · ${pesos(totalListos)}`}
          </span>
          <button className="btn btn-secondary" onClick={onClose} disabled={fase === 'emitiendo'}>
            {fase === 'fin' ? 'Cerrar' : 'Cancelar'}
          </button>
          {fase !== 'fin' && (
            <button
              className="btn btn-primary"
              onClick={emitir}
              disabled={fase !== 'listo' || !listos.length || !config.configurado}
            >
              {fase === 'emitiendo' ? `Emitiendo ${progreso.hechos}/${progreso.total}…` : `🧾 Emitir ${listos.length} e-Ticket(s)`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

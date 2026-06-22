import React, { useCallback, useEffect, useState } from 'react';
import {
  obtenerCarritosAbandonados,
  sincronizarCarritosAbandonados,
  probarMensajeCarrito,
} from '../services/api';

// ─── helpers ────────────────────────────────────────────────────────────────

function tiempoRelativo(isoDate) {
  if (!isoDate) return '—';
  const diff = Date.now() - new Date(isoDate).getTime();
  const min  = Math.floor(diff / 60000);
  const hrs  = Math.floor(min / 60);
  const dias = Math.floor(hrs / 24);
  if (dias > 0)  return `hace ${dias}d ${hrs % 24}h`;
  if (hrs > 0)   return `hace ${hrs}h ${min % 60}m`;
  return `hace ${min}m`;
}

function formatHora(isoDate) {
  if (!isoDate) return null;
  const d = new Date(isoDate);
  return d.toLocaleDateString('es-UY', { day: '2-digit', month: '2-digit' })
    + ' ' + d.toLocaleTimeString('es-UY', { hour: '2-digit', minute: '2-digit' });
}

function estadoCarrito(c) {
  if (c.recovered)      return { label: 'Recuperado',   color: '#16a34a', bg: '#dcfce7' };
  if (c.msg2_sent_at)   return { label: 'Msg 2 enviado', color: '#6d28d9', bg: '#ede9fe' };
  if (c.msg1_sent_at)   return { label: 'Msg 1 enviado', color: '#b45309', bg: '#fef3c7' };
  return                       { label: 'Sin contactar', color: '#dc2626', bg: '#fee2e2' };
}

function StatPill({ label, value, color }) {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      background: '#fff', border: '1.5px solid #e5e7eb', borderRadius: 10,
      padding: '10px 22px', minWidth: 110,
    }}>
      <span style={{ fontSize: 22, fontWeight: 700, color: color || 'var(--brand-primary)' }}>{value}</span>
      <span style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }}>{label}</span>
    </div>
  );
}

// ─── componente principal ────────────────────────────────────────────────────

export default function CarritosAbandonadosPanel({ mostrarToast }) {
  const [carritos, setCarritos]         = useState([]);
  const [stats, setStats]               = useState({ total: 0, sin_contactar: 0, esperando_msg2: 0, recuperados: 0 });
  const [loading, setLoading]           = useState(false);
  const [sincronizando, setSincronizando] = useState(false);
  const [enviando, setEnviando]         = useState(null); // id del carrito enviando
  const [filtro, setFiltro]             = useState('todos'); // todos | pendientes | enviados | recuperados

  const cargar = useCallback(async () => {
    setLoading(true);
    try {
      const res = await obtenerCarritosAbandonados();
      if (res.success) {
        setCarritos(res.carritos || []);
        setStats(res.stats || {});
      }
    } catch (err) {
      mostrarToast(`Error cargando carritos: ${err.message}`, 'error');
    } finally {
      setLoading(false);
    }
  }, [mostrarToast]);

  useEffect(() => { cargar(); }, [cargar]);

  async function handleSincronizar() {
    setSincronizando(true);
    try {
      const res = await sincronizarCarritosAbandonados();
      mostrarToast(`Sincronizado: ${res.nuevos} nuevos, ${res.actualizados} actualizados`, 'ok');
      await cargar();
    } catch (err) {
      mostrarToast(`Error sincronizando: ${err.message}`, 'error');
    } finally {
      setSincronizando(false);
    }
  }

  async function handleProbar(carrito, msgNum) {
    if (!carrito.cliente_telefono) {
      mostrarToast('Este carrito no tiene teléfono registrado', 'error');
      return;
    }
    setEnviando(`${carrito.id}-${msgNum}`);
    try {
      const res = await probarMensajeCarrito(carrito.id, msgNum);
      mostrarToast(`Msg ${msgNum} enviado a ${res.carrito} (${res.telefono})`, 'ok');
      await cargar();
    } catch (err) {
      mostrarToast(`Error: ${err.message}`, 'error');
    } finally {
      setEnviando(null);
    }
  }

  const carritosFiltrados = carritos.filter(c => {
    if (filtro === 'pendientes')  return !c.msg1_sent_at && !c.recovered;
    if (filtro === 'en_flujo')    return c.msg1_sent_at  && !c.recovered;
    if (filtro === 'recuperados') return c.recovered;
    return true;
  });

  return (
    <div className="module-panel" style={{ padding: '24px 28px' }}>

      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: 'var(--brand-primary)' }}>
            🛒 Carritos Abandonados
          </h2>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: '#6b7280' }}>
            Últimas 72 horas · Flujo automático de recuperación vía WhatsApp
          </p>
        </div>
        <button
          className="btn btn-primary"
          onClick={handleSincronizar}
          disabled={sincronizando}
          style={{ whiteSpace: 'nowrap' }}
        >
          {sincronizando ? '⏳ Sincronizando...' : '🔄 Sincronizar Shopify'}
        </button>
      </div>

      {/* Stats */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 22, flexWrap: 'wrap' }}>
        <StatPill label="Total"          value={stats.total}          color="#374151" />
        <StatPill label="Sin contactar"  value={stats.sin_contactar}  color="#dc2626" />
        <StatPill label="Esperando Msg 2" value={stats.esperando_msg2} color="#b45309" />
        <StatPill label="Recuperados"    value={stats.recuperados}    color="#16a34a" />
      </div>

      {/* Filtros */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        {[
          { key: 'todos',       label: 'Todos' },
          { key: 'pendientes',  label: 'Sin contactar' },
          { key: 'en_flujo',    label: 'En flujo' },
          { key: 'recuperados', label: 'Recuperados' },
        ].map(f => (
          <button
            key={f.key}
            type="button"
            onClick={() => setFiltro(f.key)}
            style={{
              padding: '5px 14px', borderRadius: 20, border: '1.5px solid',
              fontSize: 12, cursor: 'pointer', fontWeight: filtro === f.key ? 600 : 400,
              borderColor: filtro === f.key ? 'var(--brand-primary)' : '#d1d5db',
              background:  filtro === f.key ? 'var(--brand-primary)' : '#fff',
              color:       filtro === f.key ? '#fff' : '#374151',
            }}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* Tabla */}
      {loading ? (
        <div style={{ textAlign: 'center', padding: 40, color: '#6b7280' }}>Cargando carritos...</div>
      ) : carritosFiltrados.length === 0 ? (
        <div style={{ textAlign: 'center', padding: 40, color: '#6b7280' }}>
          {filtro === 'todos' ? 'No hay carritos abandonados en las últimas 72h' : 'No hay carritos con este filtro'}
        </div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: '#f9fafb', borderBottom: '2px solid #e5e7eb' }}>
                {['Cliente', 'Teléfono', 'Total', 'Abandonado', 'Estado', 'Msg 1', 'Msg 2', 'Acciones'].map(h => (
                  <th key={h} style={{ padding: '10px 12px', textAlign: 'left', fontWeight: 600, color: '#374151', whiteSpace: 'nowrap' }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {carritosFiltrados.map(c => {
                const estado = estadoCarrito(c);
                const enviandoMsg1 = enviando === `${c.id}-1`;
                const enviandoMsg2 = enviando === `${c.id}-2`;
                const puedeMsg1 = !c.msg1_sent_at && !c.recovered;
                const puedeMsg2 = c.msg1_sent_at && !c.msg2_sent_at && !c.recovered;

                return (
                  <tr key={c.id} style={{ borderBottom: '1px solid #f3f4f6' }}
                    onMouseEnter={e => e.currentTarget.style.background = '#f9fafb'}
                    onMouseLeave={e => e.currentTarget.style.background = ''}
                  >
                    {/* Cliente */}
                    <td style={{ padding: '10px 12px' }}>
                      <div style={{ fontWeight: 500 }}>{c.cliente_nombre || '—'}</div>
                      {c.cliente_email && (
                        <div style={{ fontSize: 11, color: '#9ca3af' }}>{c.cliente_email}</div>
                      )}
                    </td>

                    {/* Teléfono */}
                    <td style={{ padding: '10px 12px', color: c.cliente_telefono ? '#374151' : '#d1d5db' }}>
                      {c.cliente_telefono || <span style={{ fontSize: 11 }}>sin teléfono</span>}
                    </td>

                    {/* Total */}
                    <td style={{ padding: '10px 12px', fontWeight: 500 }}>
                      {c.total_price ? `$${Number(c.total_price).toLocaleString('es-UY')} ${c.currency || ''}` : '—'}
                    </td>

                    {/* Abandonado hace */}
                    <td style={{ padding: '10px 12px', color: '#6b7280', whiteSpace: 'nowrap' }}>
                      {tiempoRelativo(c.abandoned_at)}
                    </td>

                    {/* Estado badge */}
                    <td style={{ padding: '10px 12px' }}>
                      <span style={{
                        display: 'inline-block', padding: '3px 10px', borderRadius: 12,
                        fontSize: 11, fontWeight: 600,
                        color: estado.color, background: estado.bg,
                      }}>
                        {estado.label}
                      </span>
                    </td>

                    {/* Msg 1 */}
                    <td style={{ padding: '10px 12px', whiteSpace: 'nowrap' }}>
                      {c.msg1_sent_at
                        ? <span style={{ color: '#16a34a', fontSize: 12 }}>✓ {formatHora(c.msg1_sent_at)}</span>
                        : <span style={{ color: '#d1d5db', fontSize: 11 }}>pendiente</span>
                      }
                    </td>

                    {/* Msg 2 */}
                    <td style={{ padding: '10px 12px', whiteSpace: 'nowrap' }}>
                      {c.msg2_sent_at
                        ? <span style={{ color: '#16a34a', fontSize: 12 }}>✓ {formatHora(c.msg2_sent_at)}</span>
                        : c.msg1_sent_at
                          ? <span style={{ color: '#b45309', fontSize: 11 }}>en 12h</span>
                          : <span style={{ color: '#d1d5db', fontSize: 11 }}>—</span>
                      }
                    </td>

                    {/* Acciones */}
                    <td style={{ padding: '10px 12px', whiteSpace: 'nowrap' }}>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button
                          type="button"
                          disabled={!puedeMsg1 || !!enviando}
                          onClick={() => handleProbar(c, 1)}
                          style={{
                            padding: '4px 10px', borderRadius: 6, fontSize: 11, fontWeight: 500,
                            border: '1px solid', cursor: puedeMsg1 ? 'pointer' : 'not-allowed',
                            opacity: puedeMsg1 ? 1 : 0.4,
                            borderColor: '#3b82f6', background: '#eff6ff', color: '#1d4ed8',
                          }}
                        >
                          {enviandoMsg1 ? '...' : '▶ Msg 1'}
                        </button>
                        <button
                          type="button"
                          disabled={!puedeMsg2 || !!enviando}
                          onClick={() => handleProbar(c, 2)}
                          style={{
                            padding: '4px 10px', borderRadius: 6, fontSize: 11, fontWeight: 500,
                            border: '1px solid', cursor: puedeMsg2 ? 'pointer' : 'not-allowed',
                            opacity: puedeMsg2 ? 1 : 0.4,
                            borderColor: '#8b5cf6', background: '#f5f3ff', color: '#6d28d9',
                          }}
                        >
                          {enviandoMsg2 ? '...' : '▶ Msg 2'}
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div style={{ marginTop: 16, fontSize: 11, color: '#9ca3af' }}>
        {carritosFiltrados.length} carritos mostrados · El flujo automático corre cada 50 min · Sin envíos entre 23:00–09:00 UY
      </div>
    </div>
  );
}

import React, { useCallback, useEffect, useState } from 'react';
import {
  obtenerCarritosAbandonados,
  sincronizarCarritosAbandonados,
  probarMensajeCarrito,
  crearCarritoManual,
} from '../services/api';

// Mostrar el botón "Carrito de prueba" (oculto en producción; poner en true para testear)
const MOSTRAR_CARRITO_PRUEBA = false;

// Genera un link de recuperación aleatorio con el formato de Shopify (para pruebas)
function linkAleatorio() {
  const r = (n) => Math.random().toString(36).slice(2, 2 + n);
  return `https://velinneuy.com/checkouts/cn/${r(12)}/recover?key=${r(16)}&locale=es-UY`;
}

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

// Cantidad de pasos del flujo ya enviados para un carrito
function pasosEnviados(c) {
  return Object.keys(c.pasos_enviados || {}).length;
}

// Próximo paso pendiente (1-indexado) según el total de pasos del flujo, o null si ya está completo
function proximoPaso(c, totalPasos) {
  const enviados = c.pasos_enviados || {};
  for (let n = 1; n <= totalPasos; n++) {
    if (!enviados[n]) return n;
  }
  return null;
}

// Describe una demora en horas de forma legible (ej. 0.05 -> "3 min", 12 -> "12 h")
function describirDemora(horas) {
  if (!Number.isFinite(horas)) return '—';
  if (horas < 1) return `${Math.round(horas * 60)} min`;
  return Number.isInteger(horas) ? `${horas} h` : `${horas.toFixed(1)} h`;
}

function estadoCarrito(c, totalPasos) {
  if (c.recovered)                  return { label: 'Recuperado',     color: '#16a34a', bg: '#dcfce7' };
  const n = pasosEnviados(c);
  if (totalPasos > 0 && n >= totalPasos) return { label: 'Flujo completo', color: '#6d28d9', bg: '#ede9fe' };
  if (n > 0)                        return { label: `Paso ${n} enviado`, color: '#b45309', bg: '#fef3c7' };
  if (!c.cliente_telefono)          return { label: 'Sin teléfono',   color: '#6b7280', bg: '#f3f4f6' };
  return                                   { label: 'Sin contactar',  color: '#dc2626', bg: '#fee2e2' };
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
  const [stats, setStats]               = useState({ total: 0, sin_contactar: 0, en_flujo: 0, recuperados: 0, sin_telefono: 0 });
  const [flujo, setFlujo]               = useState([]); // pasos del flujo: [{ template, demoraHoras }]
  const [loading, setLoading]           = useState(false);
  const [sincronizando, setSincronizando] = useState(false);
  const [enviando, setEnviando]         = useState(null); // id del carrito enviando
  const [filtro, setFiltro]             = useState('todos'); // todos | pendientes | enviados | recuperados

  // Formulario "carrito de prueba"
  const [mostrarFormManual, setMostrarFormManual] = useState(false);
  const [manualTel, setManualTel]       = useState('');
  const [manualNombre, setManualNombre] = useState('');
  const [manualLink, setManualLink]     = useState('');
  const [creandoManual, setCreandoManual] = useState(false);

  const cargar = useCallback(async () => {
    setLoading(true);
    try {
      const res = await obtenerCarritosAbandonados();
      if (res.success) {
        setCarritos(res.carritos || []);
        setStats(res.stats || {});
        setFlujo(res.flujo || []);
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
      mostrarToast(`Sincronizado: ${res.nuevos} nuevos, ${res.actualizados} act. · ${res.conTelefono} con tel, ${res.sinTelefono} sin tel`, 'ok');
      await cargar();
    } catch (err) {
      mostrarToast(`Error sincronizando: ${err.message}`, 'error');
    } finally {
      setSincronizando(false);
    }
  }

  async function handleProbar(carrito, pasoNum) {
    if (!carrito.cliente_telefono) {
      mostrarToast('Este carrito no tiene teléfono registrado', 'error');
      return;
    }
    setEnviando(`${carrito.id}-${pasoNum}`);
    try {
      const res = await probarMensajeCarrito(carrito.id, pasoNum);
      mostrarToast(`Paso ${pasoNum} enviado a ${res.carrito} (${res.telefono})`, 'ok');
      await cargar();
    } catch (err) {
      mostrarToast(`Error: ${err.message}`, 'error');
    } finally {
      setEnviando(null);
    }
  }

  function abrirFormManual() {
    setManualLink(linkAleatorio());
    setMostrarFormManual(true);
  }

  async function handleCrearManual() {
    if (!manualTel.trim()) {
      mostrarToast('Ingresá un teléfono', 'error');
      return;
    }
    setCreandoManual(true);
    try {
      await crearCarritoManual({
        telefono: manualTel.trim(),
        nombre:   manualNombre.trim() || 'Prueba',
        cartUrl:  manualLink.trim() || undefined,
      });
      mostrarToast('Carrito de prueba creado — tocá "▶ Enviar próximo" para mandar el WhatsApp', 'ok');
      setMostrarFormManual(false);
      setManualTel(''); setManualNombre(''); setManualLink('');
      await cargar();
    } catch (err) {
      mostrarToast(`Error creando carrito: ${err.message}`, 'error');
    } finally {
      setCreandoManual(false);
    }
  }

  const carritosFiltrados = carritos.filter(c => {
    if (filtro === 'pendientes')   return pasosEnviados(c) === 0 && !c.recovered && c.cliente_telefono;
    if (filtro === 'en_flujo')     return pasosEnviados(c) > 0  && !c.recovered;
    if (filtro === 'recuperados')  return c.recovered;
    if (filtro === 'sin_telefono') return !c.cliente_telefono && !c.recovered;
    // "Todos" = vista inicial: solo carritos con teléfono (los accionables/mensajeables)
    return Boolean(c.cliente_telefono);
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
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {MOSTRAR_CARRITO_PRUEBA && (
            <button
              type="button"
              className="btn"
              onClick={() => (mostrarFormManual ? setMostrarFormManual(false) : abrirFormManual())}
              style={{
                whiteSpace: 'nowrap', border: '1.5px solid #8b5cf6',
                background: '#f5f3ff', color: '#6d28d9', fontWeight: 600,
              }}
            >
              {mostrarFormManual ? '✕ Cancelar' : '🧪 Carrito de prueba'}
            </button>
          )}
          <button
            className="btn btn-primary"
            onClick={handleSincronizar}
            disabled={sincronizando}
            style={{ whiteSpace: 'nowrap' }}
          >
            {sincronizando ? '⏳ Sincronizando...' : '🔄 Sincronizar Shopify'}
          </button>
        </div>
      </div>

      {/* Formulario carrito de prueba */}
      {MOSTRAR_CARRITO_PRUEBA && mostrarFormManual && (
        <div style={{
          background: '#faf5ff', border: '1.5px solid #e9d5ff', borderRadius: 12,
          padding: '16px 18px', marginBottom: 20,
        }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: '#6d28d9', marginBottom: 10 }}>
            🧪 Generar carrito de prueba
          </div>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11, color: '#6b7280' }}>
              Teléfono *
              <input
                type="tel"
                value={manualTel}
                onChange={e => setManualTel(e.target.value)}
                placeholder="099123456"
                style={{ padding: '7px 10px', borderRadius: 6, border: '1.5px solid #d1d5db', fontSize: 13, minWidth: 150 }}
              />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11, color: '#6b7280' }}>
              Nombre
              <input
                type="text"
                value={manualNombre}
                onChange={e => setManualNombre(e.target.value)}
                placeholder="Prueba"
                style={{ padding: '7px 10px', borderRadius: 6, border: '1.5px solid #d1d5db', fontSize: 13, minWidth: 150 }}
              />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11, color: '#6b7280', flex: 1, minWidth: 240 }}>
              Link del carrito (aleatorio, editable)
              <div style={{ display: 'flex', gap: 6 }}>
                <input
                  type="text"
                  value={manualLink}
                  onChange={e => setManualLink(e.target.value)}
                  style={{ padding: '7px 10px', borderRadius: 6, border: '1.5px solid #d1d5db', fontSize: 13, flex: 1 }}
                />
                <button
                  type="button"
                  onClick={() => setManualLink(linkAleatorio())}
                  title="Generar otro link aleatorio"
                  style={{ padding: '7px 10px', borderRadius: 6, border: '1.5px solid #d1d5db', background: '#fff', cursor: 'pointer', fontSize: 13 }}
                >
                  🎲
                </button>
              </div>
            </label>
            <button
              type="button"
              onClick={handleCrearManual}
              disabled={creandoManual}
              className="btn btn-primary"
              style={{ whiteSpace: 'nowrap' }}
            >
              {creandoManual ? '⏳ Creando...' : '➕ Crear carrito'}
            </button>
          </div>
          <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 10 }}>
            Se crea en la lista con teléfono. Después tocá <strong>▶ Msg 1</strong> en su fila para enviar el WhatsApp de prueba (ignora el horario y el interruptor automático).
          </div>
        </div>
      )}

      {/* Resumen del flujo configurado (solo lectura) */}
      {flujo.length > 0 && (
        <div style={{
          background: '#f8fafc', border: '1.5px solid #e5e7eb', borderRadius: 12,
          padding: '14px 18px', marginBottom: 22,
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: 8, marginBottom: 10 }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--brand-primary)' }}>
              ⚙️ Flujo de recuperación · {flujo.length} mensaje{flujo.length === 1 ? '' : 's'}
            </span>
            <span style={{ fontSize: 11, color: '#9ca3af' }}>
              Configurable en <strong>Administración → Carritos abandonados</strong>
            </span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {flujo.map((paso, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12, flexWrap: 'wrap' }}>
                <span style={{
                  flexShrink: 0, display: 'inline-block', minWidth: 56, textAlign: 'center',
                  padding: '2px 8px', borderRadius: 12, fontSize: 11, fontWeight: 600,
                  color: '#b45309', background: '#fef3c7',
                }}>
                  Paso {i + 1}
                </span>
                <code style={{ background: '#fff', border: '1px solid #e5e7eb', padding: '2px 7px', borderRadius: 5, color: '#374151' }}>
                  {paso.template}
                </code>
                <span style={{ color: '#6b7280' }}>
                  {i === 0
                    ? `a los ${describirDemora(paso.demoraHoras)} del abandono`
                    : `${describirDemora(paso.demoraHoras)} después del Paso ${i}`}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Stats */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 22, flexWrap: 'wrap' }}>
        <StatPill label="Total"          value={stats.total}          color="#374151" />
        <StatPill label="Sin contactar"  value={stats.sin_contactar}  color="#dc2626" />
        <StatPill label="En flujo"       value={stats.en_flujo}       color="#b45309" />
        <StatPill label="Recuperados"    value={stats.recuperados}    color="#16a34a" />
        <StatPill label="Sin teléfono"   value={stats.sin_telefono}   color="#6b7280" />
      </div>

      {/* Filtros */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        {[
          { key: 'todos',        label: 'Todos' },
          { key: 'pendientes',   label: 'Sin contactar' },
          { key: 'en_flujo',     label: 'En flujo' },
          { key: 'recuperados',  label: 'Recuperados' },
          { key: 'sin_telefono', label: 'Sin teléfono' },
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
                {['Cliente', 'Teléfono', 'Total', 'Abandonado', 'Estado', 'Mensajes', 'Acciones'].map(h => (
                  <th key={h} style={{ padding: '10px 12px', textAlign: 'left', fontWeight: 600, color: '#374151', whiteSpace: 'nowrap' }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {carritosFiltrados.map(c => {
                const estado = estadoCarrito(c, flujo.length);
                const tieneTelefono = Boolean(c.cliente_telefono);
                const siguiente = proximoPaso(c, flujo.length); // próximo paso a enviar (o null si completo)
                const puedeEnviar = tieneTelefono && !c.recovered && siguiente !== null;
                const enviandoEste = siguiente !== null && enviando === `${c.id}-${siguiente}`;

                return (
                  <tr key={c.id} style={{ borderBottom: '1px solid #f3f4f6', opacity: tieneTelefono ? 1 : 0.55 }}
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

                    {/* Mensajes (un paso por línea, según el flujo configurado) */}
                    <td style={{ padding: '10px 12px' }}>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                        {flujo.length === 0 ? (
                          <span style={{ color: '#d1d5db', fontSize: 11 }}>—</span>
                        ) : (
                          flujo.map((paso, i) => {
                            const n = i + 1;
                            const sentAt = c.pasos_enviados?.[n];
                            const esProximo = n === siguiente;
                            return (
                              <span
                                key={n}
                                title={`Paso ${n} · ${paso.template} · demora ${paso.demoraHoras}h`}
                                style={{ fontSize: 11, color: sentAt ? '#16a34a' : esProximo ? '#b45309' : '#9ca3af', whiteSpace: 'nowrap' }}
                              >
                                {sentAt
                                  ? `✓ P${n} · ${formatHora(sentAt)}`
                                  : esProximo
                                    ? `P${n} · próximo`
                                    : `P${n} · pendiente`}
                              </span>
                            );
                          })
                        )}
                      </div>
                    </td>

                    {/* Acciones */}
                    <td style={{ padding: '10px 12px', whiteSpace: 'nowrap' }}>
                      <button
                        type="button"
                        disabled={!puedeEnviar || !!enviando}
                        onClick={() => handleProbar(c, siguiente)}
                        title={puedeEnviar ? `Enviar paso ${siguiente} (${flujo[siguiente - 1]?.template || ''})` : undefined}
                        style={{
                          padding: '4px 10px', borderRadius: 6, fontSize: 11, fontWeight: 500,
                          border: '1px solid', cursor: puedeEnviar ? 'pointer' : 'not-allowed',
                          opacity: puedeEnviar ? 1 : 0.4,
                          borderColor: '#3b82f6', background: '#eff6ff', color: '#1d4ed8',
                        }}
                      >
                        {enviandoEste
                          ? '...'
                          : siguiente !== null
                            ? `▶ Enviar P${siguiente}`
                            : '✓ Completo'}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div style={{ marginTop: 16, fontSize: 11, color: '#9ca3af' }}>
        {carritosFiltrados.length} carritos mostrados · Flujo de {flujo.length || '—'} mensaje{flujo.length === 1 ? '' : 's'} · Corre cada 30 min · Sin envíos entre 23:00–09:00 UY
      </div>
    </div>
  );
}

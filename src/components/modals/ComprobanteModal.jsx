import React, { useEffect, useState } from 'react';
import {
  obtenerPreviewComprobante,
  emitirComprobante,
  actualizarEstadoComprobante,
  obtenerPdfComprobante,
} from '../../services/api';
import { cierreFuera } from '../../utils/cierreModal';
import { formatFechaHoraCompletaUy } from '../../utils/fechas';

// e-Ticket de un pedido de Shopify en Zensei. Muestra exactamente lo que se va a
// mandar (líneas a neto, IVA 22% sobre el total y el cuadre contra lo cobrado
// por Shopify) y recién emite cuando el admin confirma. Si el pedido ya tiene
// comprobante, muestra su número, estado y el PDF.
// Si el cliente tiene otros pedidos sin facturar (dos compras que viajan juntas),
// van todos en UN solo e-Ticket; se puede pedir emitir este por separado.

const pesos = (n) =>
  `$ ${Number(n || 0).toLocaleString('es-UY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// 'YYYY-MM-DD' → 'DD/MM/AAAA' (sin pasar por Date: no hay corrimiento de zona).
const fechaCorta = (iso) => (iso ? iso.split('-').reverse().join('/') : '—');

const ESTADOS = {
  SENT: { texto: 'Enviado a DGI', color: '#16a34a' },
  READY_TO_SEND: { texto: 'Emitido · envío a DGI pendiente', color: '#ea580c' },
  ERROR: { texto: 'Rechazado por DGI (revisar en Zensei)', color: '#dc2626' },
};

const caja = (bg, borde) => ({
  background: bg,
  border: `1px solid ${borde}`,
  borderRadius: 6,
  padding: '8px 12px',
  margin: '8px 0',
  fontSize: '0.9rem',
});

export default function ComprobanteModal({ pedido, onClose, onEmitido, mostrarToast }) {
  const [preview, setPreview] = useState(null);
  const [comprobante, setComprobante] = useState(null);
  const [cargando, setCargando] = useState(true);
  const [emitiendo, setEmitiendo] = useState(false);
  const [consultando, setConsultando] = useState(false);
  const [error, setError] = useState(null);
  const [infoDgi, setInfoDgi] = useState(null);
  // 'pedido' = fecha en que entró el pedido (si tiene hasta 2 días), 'hoy' si no.
  const [eleccionFecha, setEleccionFecha] = useState('hoy');
  // true = emitir sólo este pedido aunque el cliente tenga otros sin facturar.
  const [separado, setSeparado] = useState(false);
  // Se incrementa para volver a pedir el preview (p.ej. si cambió el grupo).
  const [recarga, setRecarga] = useState(0);

  useEffect(() => {
    let cancelado = false;
    (async () => {
      setCargando(true);
      setError(null);
      try {
        const res = await obtenerPreviewComprobante(pedido.id, { separado });
        if (cancelado) return;
        setPreview(res);
        setComprobante(res.comprobante?.cfeId ? res.comprobante : null);
        setEleccionFecha(res.fechas?.pedidoPermitida ? 'pedido' : 'hoy');
      } catch (err) {
        if (!cancelado) setError(err.message || 'No se pudo armar el e-Ticket');
      } finally {
        if (!cancelado) setCargando(false);
      }
    })();
    return () => { cancelado = true; };
  }, [pedido.id, separado, recarga]);

  const bloqueos = preview?.bloqueos || [];
  const avisos = preview?.avisos || [];
  const totales = preview?.totales;
  const fechas = preview?.fechas;
  const fechaElegida = eleccionFecha === 'pedido' && fechas?.pedidoPermitida ? fechas.pedido : fechas?.hoy;
  const puedeEmitir = Boolean(preview && preview.configurado && bloqueos.length === 0 && !comprobante);
  const grupo = preview?.grupo || [];
  const companeros = preview?.companeros || [];
  const juntaVarios = grupo.length > 1;
  const numerosGrupo = grupo.map((p) => `#${p.numero}`).join(', ');

  async function emitir() {
    if (!puedeEmitir) return;
    const ok = window.confirm(
      `Se va a emitir UN e-Ticket REAL a DGI por ${pesos(totales.total)} para ${juntaVarios ? `los pedidos ${numerosGrupo}` : `el pedido #${pedido.numero_pedido}`}, con fecha ${fechaCorta(fechaElegida)}.\n\n¿Confirmás?`
    );
    if (!ok) return;
    setEmitiendo(true);
    setError(null);
    try {
      const res = await emitirComprobante(pedido.id, eleccionFecha, { separado, pedidoIds: grupo.map((p) => p.id) });
      setComprobante(res.comprobante);
      const c = res.comprobante;
      mostrarToast?.(`🧾 e-Ticket ${c.serie}-${c.numero} emitido para ${juntaVarios ? numerosGrupo : `#${pedido.numero_pedido}`}`, 'success');
      onEmitido?.(c, res.pedidoIds);
    } catch (err) {
      // 409 por "ya emitido": mostrar el comprobante existente en vez del error.
      if (err.response?.comprobante?.cfeId) {
        setComprobante(err.response.comprobante);
        onEmitido?.(err.response.comprobante);
      }
      // Entró otro pedido del cliente o a uno lo facturaron aparte: se vuelve a
      // armar el preview para revisar lo que de verdad se va a emitir.
      if (err.response?.grupoCambio) setRecarga((n) => n + 1);
      setError(err.message || 'No se pudo emitir el e-Ticket');
    } finally {
      setEmitiendo(false);
    }
  }

  async function verPdf() {
    // Se abre la pestaña antes del await: si no, el navegador la bloquea como popup.
    const ventana = window.open('', '_blank');
    try {
      const blob = await obtenerPdfComprobante(pedido.id);
      const url = URL.createObjectURL(blob);
      if (ventana) ventana.location.href = url;
      else window.location.assign(url);
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (err) {
      ventana?.close();
      mostrarToast?.(err.message || 'No se pudo abrir el PDF', 'error');
    }
  }

  async function consultarEstado() {
    setConsultando(true);
    try {
      const res = await actualizarEstadoComprobante(pedido.id);
      setComprobante(res.comprobante);
      setInfoDgi(res.dgi || null);
      onEmitido?.(res.comprobante);
    } catch (err) {
      mostrarToast?.(err.message || 'No se pudo consultar el estado', 'error');
    } finally {
      setConsultando(false);
    }
  }

  const estado = comprobante ? (ESTADOS[comprobante.status] || { texto: comprobante.status || 'Sin estado', color: '#6b7280' }) : null;

  return (
    <div
      className="modal modal-open"
      {...cierreFuera(onClose, { bloqueado: emitiendo, confirmar: false })}
    >
      <div className="modal-content modal-medium" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>🧾 e-Ticket · Pedido #{pedido.numero_pedido}</h3>
          <button className="btn-close" onClick={onClose} disabled={emitiendo}>&times;</button>
        </div>

        <div className="modal-body">
          {cargando && <p>Trayendo el pedido de Shopify…</p>}

          {error && <div style={caja('#fef2f2', '#fecaca')}>❌ {error}</div>}

          {comprobante && (
            <div style={caja('#f0fdf4', '#bbf7d0')}>
              <div style={{ fontSize: '1.1rem', fontWeight: 700 }}>
                e-Ticket {comprobante.serie}-{comprobante.numero}
              </div>
              <div style={{ color: estado.color, fontWeight: 600 }}>{estado.texto}</div>
              {comprobante.pedidos?.length > 1 && (
                <div>Un solo e-Ticket para los pedidos {comprobante.pedidos.map((n) => `#${n}`).join(', ')}</div>
              )}
              {infoDgi && <div>DGI: {infoDgi}</div>}
              <div>Total: {pesos(comprobante.total)}</div>
              {comprobante.fecha && <div>Fecha de emisión: {fechaCorta(comprobante.fecha)}</div>}
              {comprobante.emitidoAt && (
                <div style={{ color: '#6b7280', fontSize: '0.85rem' }}>
                  Emitido {formatFechaHoraCompletaUy(comprobante.emitidoAt)}
                  {comprobante.emitidoPor ? ` por ${comprobante.emitidoPor}` : ''}
                </div>
              )}
            </div>
          )}

          {!cargando && preview && !comprobante && (
            <>
              {!preview.configurado && (
                <div style={caja('#fef2f2', '#fecaca')}>
                  ⚙️ Falta configurar en el servidor: {preview.faltaConfigurar?.join(', ')}
                </div>
              )}
              {preview.comprobante?.error && (
                <div style={caja('#fff7ed', '#fed7aa')}>
                  Último intento sin comprobante: {preview.comprobante.error}
                  <br /><small>Reintentar es seguro: Zensei no emite dos veces el mismo pedido.</small>
                </div>
              )}
              {(juntaVarios || (separado && companeros.length > 0)) && (
                <div style={caja('#eff6ff', '#bfdbfe')}>
                  {juntaVarios ? (
                    <>
                      🧾 El cliente tiene {grupo.length} pedidos sin facturar ({numerosGrupo}):
                      {' '}se emite <strong>un solo e-Ticket</strong> por todos.
                    </>
                  ) : (
                    <>El cliente tiene otro(s) pedido(s) sin facturar ({companeros.map((p) => `#${p.numero}`).join(', ')}) que NO van en este e-Ticket.</>
                  )}
                  <div style={{ marginTop: 4 }}>
                    <label style={{ cursor: 'pointer', fontSize: '0.85rem' }}>
                      <input
                        type="checkbox"
                        checked={separado}
                        disabled={emitiendo || cargando}
                        onChange={(e) => setSeparado(e.target.checked)}
                      />{' '}
                      Emitir sólo el pedido #{pedido.numero_pedido} (no es el mismo cliente)
                    </label>
                  </div>
                </div>
              )}
              {bloqueos.map((b) => (
                <div key={b} style={caja('#fef2f2', '#fecaca')}>⛔ {b}</div>
              ))}
              {avisos.map((a) => (
                <div key={a} style={caja('#fffbeb', '#fde68a')}>⚠️ {a}</div>
              ))}

              <div style={{ color: '#6b7280', fontSize: '0.85rem', margin: '4px 0 8px' }}>
                e-Ticket a consumidor final · {preview.pedidoShopify || `#${pedido.numero_pedido}`}
                {preview.pedido?.cliente ? ` · ${preview.pedido.cliente}` : ''}
              </div>

              {fechas && (
                <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center', margin: '4px 0 10px', fontSize: '0.9rem' }}>
                  <strong>Fecha de emisión:</strong>
                  <label
                    style={{ opacity: fechas.pedidoPermitida ? 1 : 0.5, cursor: fechas.pedidoPermitida ? 'pointer' : 'not-allowed' }}
                    title={fechas.pedidoPermitida
                      ? 'Fecha en que entró el pedido en Shopify'
                      : `El pedido tiene ${fechas.diasAtras ?? '?'} días: con fecha del pedido sólo hasta ${fechas.maxDiasAtras} días atrás`}
                  >
                    <input
                      type="radio"
                      name="fecha-emision"
                      checked={eleccionFecha === 'pedido'}
                      disabled={!fechas.pedidoPermitida || emitiendo}
                      onChange={() => setEleccionFecha('pedido')}
                    />{' '}
                    Del pedido ({fechaCorta(fechas.pedido)})
                  </label>
                  <label style={{ cursor: 'pointer' }}>
                    <input
                      type="radio"
                      name="fecha-emision"
                      checked={eleccionFecha === 'hoy'}
                      disabled={emitiendo}
                      onChange={() => setEleccionFecha('hoy')}
                    />{' '}
                    Hoy ({fechaCorta(fechas.hoy)})
                  </label>
                  {!fechas.pedidoPermitida && fechas.pedido && (
                    <small style={{ color: '#6b7280' }}>
                      El pedido es de hace {fechas.diasAtras} días: sólo se puede emitir con fecha de hoy.
                    </small>
                  )}
                </div>
              )}

              <table className="pedidos-table" style={{ fontSize: '0.85rem' }}>
                <thead>
                  <tr>
                    <th>Concepto</th>
                    <th style={{ textAlign: 'right' }}>Cant.</th>
                    <th style={{ textAlign: 'right' }}>Cobrado</th>
                    <th style={{ textAlign: 'right' }}>Neto</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.lineas.map((l, i) => (
                    <tr key={i}>
                      <td>
                        {l.descripcion}
                        {juntaVarios && l.pedido && <span style={{ color: '#6b7280', fontSize: '0.75rem' }}> · {l.pedido}</span>}
                        {l.sku && <div style={{ color: '#9ca3af', fontSize: '0.75rem' }}>{l.sku}</div>}
                        {l.descuento > 0 && (
                          <div style={{ color: '#9ca3af', fontSize: '0.75rem' }}>
                            Lista {pesos(l.precioLista * l.cantidad)} − desc. {pesos(l.descuento)}
                          </div>
                        )}
                      </td>
                      <td style={{ textAlign: 'right' }}>{l.cantidad}</td>
                      <td style={{ textAlign: 'right' }}>{pesos(l.brutoLinea)}</td>
                      <td style={{ textAlign: 'right' }}>{pesos(l.neto)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {totales && (
                <table style={{ width: '100%', marginTop: 10, fontSize: '0.9rem' }}>
                  <tbody>
                    <tr><td>Neto gravado (IVA 22%)</td><td style={{ textAlign: 'right' }}>{pesos(totales.neto)}</td></tr>
                    <tr><td>IVA 22%</td><td style={{ textAlign: 'right' }}>{pesos(totales.iva)}</td></tr>
                    {totales.noFacturable > 0 && (
                      <tr title="Centésimo que no se puede expresar como neto + IVA redondeados">
                        <td>Redondeo (no facturable)</td><td style={{ textAlign: 'right' }}>{pesos(totales.noFacturable)}</td>
                      </tr>
                    )}
                    <tr style={{ fontWeight: 700 }}>
                      <td>Total e-Ticket</td><td style={{ textAlign: 'right' }}>{pesos(totales.total)}</td>
                    </tr>
                    <tr style={{ color: totales.diferencia === 0 ? '#16a34a' : '#dc2626' }}>
                      <td>Cobrado en Shopify</td>
                      <td style={{ textAlign: 'right' }}>
                        {pesos(totales.totalShopify)} {totales.diferencia === 0 ? '✓' : `(dif. ${pesos(totales.diferencia)})`}
                      </td>
                    </tr>
                  </tbody>
                </table>
              )}
            </>
          )}
        </div>

        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose} disabled={emitiendo}>Cerrar</button>
          {comprobante ? (
            <>
              {comprobante.status !== 'SENT' && (
                <button className="btn btn-outline" onClick={consultarEstado} disabled={consultando}>
                  {consultando ? 'Consultando…' : '🔄 Actualizar estado'}
                </button>
              )}
              <button className="btn btn-primary" onClick={verPdf}>📄 Ver PDF</button>
            </>
          ) : (
            <button className="btn btn-primary" onClick={emitir} disabled={!puedeEmitir || emitiendo || cargando}>
              {emitiendo ? 'Emitiendo… (puede tardar hasta 1 min)' : '🧾 Emitir e-Ticket'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

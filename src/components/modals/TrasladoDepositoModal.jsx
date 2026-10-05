import React, { useState, useEffect, useMemo } from 'react';
import { obtenerPedidosEnDeposito, obtenerPreviewTraslado, trasladarDepositoATienda } from '../../services/api';
import { cierreFuera } from '../../utils/cierreModal';
import {
  planTransfer, coverageDays, computeStatus, FULL_TRANSFER_MAX, TRANSFER_STEP,
} from '../../utils/planTraslado';

// Traslado depósito → tienda de un pedido de StockPlanner. Misma mecánica que el
// diálogo "Trasladar a tienda" de StockPlanner (que es quien aplica el traslado y
// ajusta Shopify): elegís el pedido, el % y, si querés, corregís unidades por color.

const PRESETS = [25, 50, 75, 100];
const ESTADOS_SALUD = [
  { id: 'critico', label: 'Crítico' },
  { id: 'riesgo', label: 'En riesgo' },
  { id: 'bien', label: 'Bien' },
  { id: 'sobre', label: 'Sobre stock' },
];

function formatDias(d) {
  return Number.isFinite(d) ? `${Math.floor(d)}d` : '∞';
}

function formatFechaCorta(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString('es-UY', { day: 'numeric', month: 'short', year: 'numeric' });
}

export default function TrasladoDepositoModal({ onClose, onTrasladado, mostrarToast, nombresPorSku = {} }) {
  const [pedidos, setPedidos] = useState(null); // null = cargando
  const [errorPedidos, setErrorPedidos] = useState('');
  const [pedidoId, setPedidoId] = useState(null);
  const [preview, setPreview] = useState(null);
  const [errorPreview, setErrorPreview] = useState('');
  const [pct, setPct] = useState(50);
  const [overrides, setOverrides] = useState({}); // lineId -> unidades
  const [guardando, setGuardando] = useState(false);
  const [resultado, setResultado] = useState(null);

  useEffect(() => {
    let vivo = true;
    obtenerPedidosEnDeposito()
      .then((data) => {
        if (!vivo) return;
        setPedidos(data);
        if (data.length === 1) setPedidoId(data[0].id); // único pedido: directo a la vista previa
      })
      .catch((err) => vivo && setErrorPedidos(err.message || 'No se pudieron leer los pedidos'));
    return () => { vivo = false; };
  }, []);

  useEffect(() => {
    if (!pedidoId) return undefined;
    let vivo = true;
    setPreview(null);
    setErrorPreview('');
    setOverrides({});
    obtenerPreviewTraslado(pedidoId)
      .then((data) => vivo && setPreview(data))
      .catch((err) => vivo && setErrorPreview(err.message || 'No se pudo cargar el pedido'));
    return () => { vivo = false; };
  }, [pedidoId]);

  // Aviso del navegador si intenta cerrar/recargar mientras se ajusta Shopify.
  useEffect(() => {
    if (!guardando) return undefined;
    const handler = (e) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [guardando]);

  const activas = useMemo(() => (preview?.lines || []).filter((l) => l.remaining > 0), [preview]);
  const lead = preview?.leadTimeDays ?? 42;
  const safety = preview?.safetyBufferDays ?? 14;

  const plan = useMemo(() => planTransfer(
    activas.map((l) => ({ lineId: l.id, remaining: l.remaining, shopStock: l.shopStock, velocity: l.velocity })),
    pct,
    lead + safety
  ), [activas, pct, lead, safety]);

  const filas = useMemo(() => activas
    .map((l) => {
      const units = Math.min(l.remaining, Math.max(0, overrides[l.id] ?? plan.units.get(l.id) ?? 0));
      const diasHoy = coverageDays(l.shopStock, l.velocity);
      const diasDespues = coverageDays(l.shopStock + units, l.velocity);
      return {
        ...l,
        units,
        diasHoy,
        diasDespues,
        saludHoy: computeStatus(Math.floor(diasHoy), lead, safety),
        saludDespues: computeStatus(Math.floor(diasDespues), lead, safety),
        forzado: plan.forced.has(l.id),
        editado: overrides[l.id] !== undefined,
      };
    })
    // Los que menos días les quedan en la tienda, arriba.
    .sort((a, b) => a.diasHoy - b.diasHoy || b.velocity - a.velocity), [activas, overrides, plan, lead, safety]);

  const totalDeposito = activas.reduce((s, l) => s + l.remaining, 0);
  const totalTraslado = filas.reduce((s, r) => s + r.units, 0);
  const hayOverrides = Object.keys(overrides).length > 0;

  function contarSalud(clave) {
    const c = { critico: 0, riesgo: 0, bien: 0, sobre: 0 };
    for (const r of filas) if (r.velocity > 0) c[r[clave]]++;
    return c;
  }
  const saludHoy = contarSalud('saludHoy');
  const saludDespues = contarSalud('saludDespues');

  function cambiarPct(v) {
    setPct(Math.min(100, Math.max(0, Math.round(v))));
    setOverrides({});
  }

  async function confirmar() {
    if (totalTraslado <= 0) return;
    if (!window.confirm(`¿Trasladar ${totalTraslado} u. del depósito a la tienda? Se suman en Shopify y no se deshace automáticamente.`)) return;
    setGuardando(true);
    try {
      const res = await trasladarDepositoATienda(
        pedidoId,
        pct,
        filas.filter((r) => r.units > 0).map((r) => ({ id: r.id, units: r.units }))
      );
      if (!res.success) throw new Error(res.error || 'Error al trasladar');
      const d = res.data || {};
      const sh = d.shopify || {};
      const problemas = (sh.failed || 0) + (sh.notFound || 0);
      setResultado({ ...d, sincronizado: res.sincronizado, problemas });
      if (sh.skipped && sh.reason !== 'no_lines') {
        mostrarToast?.(`Trasladadas ${d.totalUnits} u. · Shopify NO se actualizó (${sh.reason || 'sin detalle'})`, 'warning');
      } else if (problemas > 0) {
        mostrarToast?.(`Trasladadas ${d.totalUnits} u. · ${problemas} SKU sin sincronizar en Shopify`, 'warning');
      } else {
        mostrarToast?.(`Trasladadas ${d.totalUnits} u. a la tienda`, 'success');
      }
      onTrasladado?.();
    } catch (err) {
      mostrarToast?.(err.message || 'Error al trasladar', 'error');
    } finally {
      setGuardando(false);
    }
  }

  const pedidoSel = pedidos?.find((p) => p.id === pedidoId);
  const nombreColor = (r) => nombresPorSku[String(r.skuCode || '').trim().toUpperCase()] || r.skuName;

  return (
    <div
      className="modal modal-open"
      {...cierreFuera(onClose, {
        bloqueado: guardando,
        confirmar: !resultado && hayOverrides,
        mensaje: '¿Cerrar sin trasladar? Los cambios de unidades se pierden.',
      })}
    >
      <div className="modal-content modal-large traslado-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>Trasladar del depósito a la tienda</h3>
          <button className="btn-close" onClick={onClose} disabled={guardando}>&times;</button>
        </div>

        <div className="modal-body traslado-body">
          {resultado ? (
            <div className="traslado-resultado">
              <p className="traslado-resultado-titulo">
                ✅ Se trasladaron <strong>{resultado.totalUnits} u.</strong> a la tienda.
              </p>
              <p>
                {resultado.remainingUnits > 0
                  ? `Quedan ${resultado.remainingUnits} u. de este pedido en el depósito.`
                  : 'El pedido quedó recibido completo.'}
              </p>
              {resultado.shopify?.skipped && resultado.shopify?.reason !== 'no_lines' && (
                <p className="traslado-aviso">
                  ⚠ Shopify no se actualizó ({resultado.shopify.reason}). El traslado quedó registrado:
                  reintentá el ajuste desde "Pedidos en camino" en StockPlanner.
                </p>
              )}
              {resultado.problemas > 0 && (
                <p className="traslado-aviso">
                  ⚠ {resultado.problemas} SKU no se pudieron ajustar en Shopify
                  ({(resultado.shopify?.results || []).filter((r) => r.status !== 'ok').map((r) => r.skuCode).join(', ')}).
                  Reintentá desde "Pedidos en camino" en StockPlanner.
                </p>
              )}
              {!resultado.sincronizado && (
                <p className="traslado-aviso">La columna "Tienda" puede tardar: tocá "Sincronizar desde Shopify".</p>
              )}
            </div>
          ) : (
            <>
              {/* Paso 1: pedido */}
              {errorPedidos && <div className="stockdep-error">⚠ {errorPedidos}</div>}
              {!pedidos && !errorPedidos && <p className="traslado-cargando">Buscando pedidos en depósito…</p>}
              {pedidos && pedidos.length === 0 && (
                <p className="traslado-cargando">No hay pedidos en depósito en StockPlanner.</p>
              )}
              {pedidos && pedidos.length > 0 && (
                <div className="traslado-pedidos">
                  {pedidos.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      className={`traslado-pedido${p.id === pedidoId ? ' traslado-pedido-activo' : ''}`}
                      onClick={() => setPedidoId(p.id)}
                      disabled={guardando}
                    >
                      <span className="traslado-pedido-titulo">
                        Pedido del {formatFechaCorta(p.creado)}
                      </span>
                      <span className="traslado-pedido-sub">
                        En depósito desde {formatFechaCorta(p.en_deposito_desde)} · {p.queda_en_deposito} u. · {p.colores_en_deposito} colores
                      </span>
                      {p.archivo && <span className="traslado-pedido-sub">{p.archivo}</span>}
                    </button>
                  ))}
                </div>
              )}

              {/* Paso 2: reparto */}
              {pedidoId && !preview && !errorPreview && (
                <p className="traslado-cargando">Leyendo stock actual de Shopify…</p>
              )}
              {errorPreview && <div className="stockdep-error">⚠ {errorPreview}</div>}

              {preview && (
                <>
                  <p className="traslado-explica">
                    Elegí qué porcentaje de lo que queda pasa a Shopify. Se reparte según la venta diaria:
                    cada color recibe en proporción a lo que le falta para cubrir {lead + safety} días
                    (lead time + colchón) con el stock que ya tiene, de a {TRANSFER_STEP} unidades; los
                    que tienen {FULL_TRANSFER_MAX} u. o menos pasan completos.
                  </p>
                  {preview.stockRefreshError && (
                    <div className="traslado-aviso">
                      No se pudo leer Shopify en este momento: se usa el stock del último sync.
                    </div>
                  )}

                  <div className="traslado-pct">
                    <span>Trasladar</span>
                    {PRESETS.map((p) => (
                      <button
                        key={p}
                        type="button"
                        className={`stockdep-filtro${pct === p ? ' stockdep-filtro-activo' : ''}`}
                        onClick={() => cambiarPct(p)}
                        disabled={guardando}
                      >
                        {p}%
                      </button>
                    ))}
                    <input
                      type="number"
                      min="1"
                      max="100"
                      className="stocknc-input traslado-pct-input"
                      value={pct}
                      onChange={(e) => cambiarPct(Number(e.target.value) || 0)}
                      disabled={guardando}
                    />
                    <span>%</span>
                    <span className="traslado-pct-total">de {totalDeposito} u. en depósito</span>
                  </div>

                  <div className="traslado-salud">
                    <strong>Salud en tienda</strong>
                    {ESTADOS_SALUD.map((s) => (
                      <span key={s.id}>
                        <span className={`traslado-punto traslado-salud-${s.id}`} />
                        {s.label}: {saludHoy[s.id]} → <strong>{saludDespues[s.id]}</strong>
                      </span>
                    ))}
                  </div>

                  <div className="stocknc-body traslado-tabla-wrap">
                    <table className="stocknc-table traslado-tabla">
                      <thead>
                        <tr>
                          <th>Color</th>
                          <th>Tienda</th>
                          <th>Venta/día</th>
                          <th>Días hoy</th>
                          <th>Depósito</th>
                          <th>Trasladar</th>
                          <th>Días después</th>
                          <th>Queda</th>
                        </tr>
                      </thead>
                      <tbody>
                        {filas.map((r) => (
                          <tr key={r.id}>
                            <td>
                              <span className="stocknc-sku">{r.skuCode}</span>
                              <span className="traslado-nombre"> / {nombreColor(r)}</span>
                              {r.forzado && !r.editado && (
                                <div className="traslado-forzado">≤{FULL_TRANSFER_MAX} u. · pasa completo</div>
                              )}
                            </td>
                            <td>{r.shopStock}</td>
                            <td>{r.velocity > 0 ? r.velocity.toFixed(1) : '—'}</td>
                            <td className={r.velocity > 0 ? `traslado-salud-txt-${r.saludHoy}` : ''}>{formatDias(r.diasHoy)}</td>
                            <td>{r.remaining}</td>
                            <td>
                              <input
                                type="number"
                                min="0"
                                step={TRANSFER_STEP}
                                max={r.remaining}
                                className={`stocknc-input${r.editado ? ' traslado-input-editado' : ''}`}
                                value={r.units}
                                disabled={guardando}
                                onChange={(e) => setOverrides((o) => ({
                                  ...o,
                                  [r.id]: Math.min(r.remaining, Math.max(0, Math.floor(Number(e.target.value) || 0))),
                                }))}
                              />
                            </td>
                            <td className={r.velocity > 0 ? `traslado-salud-txt-${r.saludDespues}` : ''}>{formatDias(r.diasDespues)}</td>
                            <td className="stocknc-fecha">{r.remaining - r.units}</td>
                          </tr>
                        ))}
                        {filas.length === 0 && (
                          <tr><td colSpan={8} className="stocknc-empty">Este pedido no tiene unidades en depósito</td></tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </>
          )}
        </div>

        <div className="modal-footer traslado-footer">
          {resultado ? (
            <button className="btn btn-primary" onClick={onClose}>Cerrar</button>
          ) : (
            <>
              {preview && (
                <span className="traslado-resumen">
                  A tienda: <strong className="traslado-num-tienda">{totalTraslado} u.</strong>
                  {totalTraslado !== plan.target && !hayOverrides && (
                    <span> (objetivo {plan.target}, redondeado de a {TRANSFER_STEP} y con los colores ≤{FULL_TRANSFER_MAX} completos)</span>
                  )}
                  {' · '}Queda en depósito: <strong className="traslado-num-deposito">{totalDeposito - totalTraslado} u.</strong>
                  {pedidoSel && <span> · pedido del {formatFechaCorta(pedidoSel.creado)}</span>}
                </span>
              )}
              {hayOverrides && (
                <button className="btn btn-secondary" onClick={() => setOverrides({})} disabled={guardando}>
                  Volver a la sugerencia
                </button>
              )}
              <button className="btn btn-secondary" onClick={onClose} disabled={guardando}>Cancelar</button>
              <button
                className="btn btn-primary"
                onClick={confirmar}
                disabled={!preview || guardando || totalTraslado === 0}
              >
                {guardando ? 'Sumando stock en Shopify…' : `Trasladar ${totalTraslado} u. a la tienda`}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

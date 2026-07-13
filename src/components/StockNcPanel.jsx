import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { obtenerStockNC, sincronizarStockNC, actualizarStockNC } from '../services/api';

function formatFecha(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('es-UY', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export default function StockNcPanel({ mostrarToast }) {
  const [productos, setProductos] = useState([]);
  const [loading, setLoading] = useState(false);
  const [sincronizando, setSincronizando] = useState(false);
  const [busqueda, setBusqueda] = useState('');
  // Borradores de edición por SKU y estado de guardado por SKU.
  const [drafts, setDrafts] = useState({}); // sku -> string
  const [guardando, setGuardando] = useState({}); // sku -> bool
  // Producto pendiente de confirmar en el modal de conteo: { prod, valor, diff } | null
  const [confirmData, setConfirmData] = useState(null);
  // Lista de cambios pendiente de confirmar para guardado en lote: [{ prod, valor, diff }] | null
  const [bulkConfirm, setBulkConfirm] = useState(null);
  const [guardandoTodo, setGuardandoTodo] = useState(false);

  const cargar = useCallback(async () => {
    setLoading(true);
    try {
      const data = await obtenerStockNC();
      setProductos(data);
      // Reiniciar borradores al valor actual.
      const nextDrafts = {};
      for (const p of data) nextDrafts[p.sku] = String(p.stock ?? 0);
      setDrafts(nextDrafts);
    } catch (err) {
      mostrarToast?.(err.message || 'Error cargando stock NC', 'error');
    } finally {
      setLoading(false);
    }
  }, [mostrarToast]);

  useEffect(() => { cargar(); }, [cargar]);

  async function handleSincronizar() {
    setSincronizando(true);
    try {
      const res = await sincronizarStockNC();
      if (!res.success) {
        mostrarToast?.(res.error || 'Error al sincronizar', 'error');
        return;
      }
      const r = res.resumen || {};
      let msg = `${r.actualizados} actualizado(s) desde Shopify`;
      if (r.sinCambios) msg += ` · ${r.sinCambios} sin cambios`;
      mostrarToast?.(msg, 'success');
      if (Array.isArray(r.soloEnShopify) && r.soloEnShopify.length > 0) {
        mostrarToast?.(`${r.soloEnShopify.length} SKU(s) en Shopify sin producto en la base`, 'warning');
      }
      await cargar();
    } catch (err) {
      mostrarToast?.(err.message || 'Error al sincronizar', 'error');
    } finally {
      setSincronizando(false);
    }
  }

  // Paso 1: validar el conteo físico y abrir el modal de confirmación mostrando la diferencia.
  // No escribe nada todavía: solo prepara la advertencia.
  function solicitarGuardar(prod) {
    const raw = drafts[prod.sku];
    if (raw === '' || raw == null) {
      mostrarToast?.('Ingresá el conteo físico antes de guardar', 'error');
      return;
    }
    const valor = Number(raw);
    if (!Number.isInteger(valor)) {
      mostrarToast?.('El conteo debe ser un número entero', 'error');
      return;
    }
    if (valor < 0) {
      mostrarToast?.('El conteo no puede ser negativo', 'error');
      return;
    }
    if (valor === Number(prod.stock)) return; // coincide con el sistema: nada que confirmar
    setConfirmData({ prod, valor, diff: valor - Number(prod.stock) });
  }

  // Paso 2: el usuario confirmó a pesar de la advertencia → recién acá se aplica el cambio.
  async function confirmarGuardado() {
    if (!confirmData) return;
    const { prod, valor } = confirmData;
    const sku = prod.sku;
    setConfirmData(null);
    setGuardando((g) => ({ ...g, [sku]: true }));
    try {
      const res = await actualizarStockNC(prod.id, sku, valor);
      if (!res.success) {
        mostrarToast?.(res.error || 'Error al guardar', 'error');
        return;
      }
      const nVar = res.shopify?.variantes;
      const detalleVar = nVar ? ` · ${nVar} variante(s) igualadas en Shopify` : ' (Shopify actualizado)';
      mostrarToast?.(`${sku}: stock fijado en ${valor}${detalleVar}`, 'success');
      setProductos((prev) => prev.map((p) => (p.sku === sku ? { ...p, stock: valor, updated_at: res.producto?.updated_at || p.updated_at } : p)));
    } catch (err) {
      mostrarToast?.(err.message || 'Error al guardar', 'error');
    } finally {
      setGuardando((g) => ({ ...g, [sku]: false }));
    }
  }

  // Todas las filas con un conteo válido distinto al del sistema, listas para guardar juntas.
  // Se calcula sobre todos los productos (no sobre el filtro de búsqueda) para no perder
  // conteos hechos antes de filtrar.
  const cambiosPendientes = useMemo(() => {
    const out = [];
    for (const p of productos) {
      const raw = drafts[p.sku];
      if (raw === '' || raw == null) continue;
      const valor = Number(raw);
      if (!Number.isInteger(valor) || valor < 0) continue;
      if (valor === Number(p.stock)) continue;
      out.push({ prod: p, valor, diff: valor - Number(p.stock) });
    }
    return out;
  }, [productos, drafts]);

  // Paso 1 (lote): abrir el modal de confirmación listando todos los cambios pendientes.
  function solicitarGuardarTodo() {
    if (cambiosPendientes.length === 0) {
      mostrarToast?.('No hay conteos distintos al sistema para guardar', 'warning');
      return;
    }
    setBulkConfirm(cambiosPendientes);
  }

  // Paso 2 (lote): aplicar todos los cambios secuencialmente (cada uno también sincroniza Shopify).
  async function confirmarGuardadoBulk() {
    if (!bulkConfirm || bulkConfirm.length === 0) return;
    const items = bulkConfirm;
    setBulkConfirm(null);
    setGuardandoTodo(true);
    let ok = 0;
    const errores = [];
    for (const { prod, valor } of items) {
      const sku = prod.sku;
      setGuardando((g) => ({ ...g, [sku]: true }));
      try {
        const res = await actualizarStockNC(prod.id, sku, valor);
        if (!res.success) {
          errores.push(sku);
        } else {
          ok++;
          setProductos((prev) => prev.map((p) => (p.sku === sku ? { ...p, stock: valor, updated_at: res.producto?.updated_at || p.updated_at } : p)));
        }
      } catch {
        errores.push(sku);
      } finally {
        setGuardando((g) => ({ ...g, [sku]: false }));
      }
    }
    setGuardandoTodo(false);
    if (ok > 0) mostrarToast?.(`${ok} producto(s) actualizados en el sistema y Shopify`, 'success');
    if (errores.length > 0) {
      mostrarToast?.(`${errores.length} con error: ${errores.slice(0, 4).join(', ')}${errores.length > 4 ? '…' : ''}`, 'error');
    }
  }

  const filtrados = useMemo(() => {
    const q = busqueda.trim().toLowerCase();
    if (!q) return productos;
    return productos.filter((p) =>
      String(p.sku || '').toLowerCase().includes(q) ||
      String(p.nombre || '').toLowerCase().includes(q)
    );
  }, [productos, busqueda]);

  return (
    <div className="stocknc-panel">
      <div className="stocknc-header">
        <div>
          <h2 className="stocknc-title">Stock de colores (NC)</h2>
          <p className="stocknc-sub">
            Sincronizá el stock desde Shopify, contá el físico y guardalo: se refleja en Shopify
            (todas las variantes con el mismo SKU quedan iguales).
          </p>
        </div>
        <div className="stocknc-header-actions">
          <button className="btn btn-secondary btn-sm" onClick={cargar} disabled={loading || sincronizando || guardandoTodo}>
            🔄 Actualizar
          </button>
          <button className="btn btn-primary btn-sm" onClick={handleSincronizar} disabled={sincronizando || loading || guardandoTodo}>
            {sincronizando ? 'Sincronizando…' : '⬇️ Sincronizar desde Shopify'}
          </button>
        </div>
      </div>

      <div className="stocknc-toolbar">
        <input
          type="search"
          className="stocknc-search"
          placeholder="Buscar por SKU o nombre…"
          value={busqueda}
          onChange={(e) => setBusqueda(e.target.value)}
        />
        <span className="stocknc-count">{filtrados.length} producto(s)</span>
        <button
          className="btn btn-primary btn-sm stocknc-guardar-todo"
          onClick={solicitarGuardarTodo}
          disabled={cambiosPendientes.length === 0 || guardandoTodo || loading}
          title={cambiosPendientes.length > 0
            ? `Guardar los ${cambiosPendientes.length} conteo(s) modificados de una vez`
            : 'Contá al menos un producto con un valor distinto al del sistema'}
        >
          {guardandoTodo
            ? 'Guardando…'
            : `💾 Guardar todo${cambiosPendientes.length > 0 ? ` (${cambiosPendientes.length})` : ''}`}
        </button>
      </div>

      <div className="stocknc-body">
        <table className="stocknc-table">
          <thead>
            <tr>
              <th>SKU</th>
              <th>Color</th>
              <th>Stock del sistema</th>
              <th>Conteo físico</th>
              <th>Diferencia</th>
              <th>Actualizado</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {filtrados.map((p) => {
              const draft = drafts[p.sku] ?? '';
              const draftValido = draft !== '' && draft != null && Number.isInteger(Number(draft));
              const diff = draftValido ? Number(draft) - Number(p.stock) : null;
              const cambiado = diff !== null && diff !== 0;
              const bajo = Number(p.stock) <= Number(p.stock_minimo ?? 0);
              return (
                <tr key={p.id} className={bajo ? 'stocknc-row-bajo' : ''}>
                  <td className="stocknc-sku">{p.sku}</td>
                  <td>{p.nombre}</td>
                  <td className={`stocknc-stock ${Number(p.stock) < 0 ? 'stocknc-neg' : ''}`}>
                    {p.stock}
                    {bajo && <span className="stocknc-badge-bajo" title={`Mínimo: ${p.stock_minimo}`}>⚠ bajo</span>}
                  </td>
                  <td>
                    <input
                      type="number"
                      className="stocknc-input"
                      value={draft}
                      disabled={guardandoTodo}
                      onChange={(e) => setDrafts((d) => ({ ...d, [p.sku]: e.target.value }))}
                      onKeyDown={(e) => { if (e.key === 'Enter') solicitarGuardar(p); }}
                    />
                  </td>
                  <td className="stocknc-diff-cell">
                    {diff === null ? (
                      <span className="stocknc-diff-muted">—</span>
                    ) : diff === 0 ? (
                      <span className="stocknc-diff stocknc-diff-eq">✓ coincide</span>
                    ) : (
                      <span
                        className={`stocknc-diff ${diff > 0 ? 'stocknc-diff-pos' : 'stocknc-diff-neg'}`}
                        title={diff > 0 ? `Sobran ${diff} respecto al sistema` : `Faltan ${Math.abs(diff)} respecto al sistema`}
                      >
                        {diff > 0 ? `+${diff}` : diff}
                      </span>
                    )}
                  </td>
                  <td className="stocknc-fecha">{formatFecha(p.updated_at)}</td>
                  <td>
                    <button
                      className="btn btn-primary btn-sm"
                      onClick={() => solicitarGuardar(p)}
                      disabled={!cambiado || guardando[p.sku] || guardandoTodo}
                      title={cambiado ? 'Revisar diferencia y actualizar' : 'Ingresá un conteo distinto al del sistema'}
                    >
                      {guardando[p.sku] ? '…' : 'Guardar'}
                    </button>
                  </td>
                </tr>
              );
            })}
            {filtrados.length === 0 && !loading && (
              <tr><td colSpan={7} className="stocknc-empty">No hay productos NC para mostrar</td></tr>
            )}
            {loading && (
              <tr><td colSpan={7} className="stocknc-empty">Cargando…</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {confirmData && (
        <div className="modal modal-open" onClick={() => setConfirmData(null)}>
          <div
            className="modal-content modal-medium"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-header">
              <h3>Confirmar conteo de stock</h3>
              <button className="btn-close" onClick={() => setConfirmData(null)}>&times;</button>
            </div>

            <div className="modal-body">
              <p className="stocknc-confirm-prod">
                <strong>{confirmData.prod.nombre}</strong>
                <span className="stocknc-confirm-sku">{confirmData.prod.sku}</span>
              </p>

              <div className="stocknc-confirm-nums">
                <div className="stocknc-confirm-num">
                  <span className="stocknc-confirm-label">Sistema</span>
                  <span className="stocknc-confirm-value">{confirmData.prod.stock}</span>
                </div>
                <div className="stocknc-confirm-arrow">→</div>
                <div className="stocknc-confirm-num">
                  <span className="stocknc-confirm-label">Tu conteo</span>
                  <span className="stocknc-confirm-value">{confirmData.valor}</span>
                </div>
                <div className={`stocknc-confirm-num stocknc-confirm-diff ${confirmData.diff > 0 ? 'pos' : 'neg'}`}>
                  <span className="stocknc-confirm-label">Diferencia</span>
                  <span className="stocknc-confirm-value">
                    {confirmData.diff > 0 ? `+${confirmData.diff}` : confirmData.diff}
                  </span>
                </div>
              </div>

              <div className="stocknc-confirm-warn">
                ⚠ El conteo <strong>no coincide</strong> con el stock del sistema
                ({confirmData.diff > 0
                  ? `sobran ${confirmData.diff}`
                  : `faltan ${Math.abs(confirmData.diff)}`} unidad(es)).
                Al confirmar vas a <strong>sobrescribir</strong> el stock actual y reflejarlo en
                Shopify (todas las variantes con este SKU quedan iguales). Esta acción no se
                deshace automáticamente: si no estás seguro, volvé a contar antes de continuar.
              </div>
            </div>

            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setConfirmData(null)}>
                Cancelar y volver a contar
              </button>
              <button className="btn btn-danger" onClick={confirmarGuardado}>
                Sí, actualizar a {confirmData.valor}
              </button>
            </div>
          </div>
        </div>
      )}

      {bulkConfirm && (
        <div className="modal modal-open" onClick={() => setBulkConfirm(null)}>
          <div
            className="modal-content modal-medium"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-header">
              <h3>Confirmar {bulkConfirm.length} conteo(s) de stock</h3>
              <button className="btn-close" onClick={() => setBulkConfirm(null)}>&times;</button>
            </div>

            <div className="modal-body">
              <div className="stocknc-confirm-warn">
                ⚠ Vas a <strong>sobrescribir</strong> el stock de {bulkConfirm.length} producto(s)
                y reflejarlo en Shopify (todas las variantes con cada SKU quedan iguales).
                Revisá las diferencias antes de continuar: esta acción no se deshace automáticamente.
              </div>

              <div className="stocknc-bulk-list">
                <table className="stocknc-bulk-table">
                  <thead>
                    <tr>
                      <th>SKU</th>
                      <th>Color</th>
                      <th>Sistema</th>
                      <th>Tu conteo</th>
                      <th>Diferencia</th>
                    </tr>
                  </thead>
                  <tbody>
                    {bulkConfirm.map(({ prod, valor, diff }) => (
                      <tr key={prod.id}>
                        <td className="stocknc-sku">{prod.sku}</td>
                        <td>{prod.nombre}</td>
                        <td>{prod.stock}</td>
                        <td><strong>{valor}</strong></td>
                        <td>
                          <span className={`stocknc-diff ${diff > 0 ? 'stocknc-diff-pos' : 'stocknc-diff-neg'}`}>
                            {diff > 0 ? `+${diff}` : diff}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setBulkConfirm(null)}>
                Cancelar
              </button>
              <button className="btn btn-danger" onClick={confirmarGuardadoBulk}>
                Sí, actualizar {bulkConfirm.length} producto(s)
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

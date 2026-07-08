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

  async function handleGuardar(prod) {
    const sku = prod.sku;
    const raw = drafts[sku];
    const valor = Number(raw);
    if (!Number.isInteger(valor)) {
      mostrarToast?.('El stock debe ser un número entero', 'error');
      return;
    }
    if (valor === Number(prod.stock)) return; // sin cambios

    const ok = window.confirm(
      `¿Confirmás actualizar el stock de ${prod.nombre} (${sku})?\n\n` +
      `${prod.stock}  →  ${valor}\n\n` +
      `Este cambio se guarda en la base y se refleja en Shopify (todas las variantes con este SKU).`
    );
    if (!ok) return;

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
          <button className="btn btn-secondary btn-sm" onClick={cargar} disabled={loading || sincronizando}>
            🔄 Actualizar
          </button>
          <button className="btn btn-primary btn-sm" onClick={handleSincronizar} disabled={sincronizando || loading}>
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
      </div>

      <div className="stocknc-body">
        <table className="stocknc-table">
          <thead>
            <tr>
              <th>SKU</th>
              <th>Color</th>
              <th>Stock actual</th>
              <th>Conteo físico</th>
              <th>Actualizado</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {filtrados.map((p) => {
              const draft = drafts[p.sku] ?? '';
              const cambiado = Number(draft) !== Number(p.stock);
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
                      onChange={(e) => setDrafts((d) => ({ ...d, [p.sku]: e.target.value }))}
                      onKeyDown={(e) => { if (e.key === 'Enter') handleGuardar(p); }}
                    />
                  </td>
                  <td className="stocknc-fecha">{formatFecha(p.updated_at)}</td>
                  <td>
                    <button
                      className="btn btn-primary btn-sm"
                      onClick={() => handleGuardar(p)}
                      disabled={!cambiado || guardando[p.sku]}
                      title={cambiado ? 'Guardar y reflejar en Shopify' : 'Sin cambios'}
                    >
                      {guardando[p.sku] ? '…' : 'Guardar'}
                    </button>
                  </td>
                </tr>
              );
            })}
            {filtrados.length === 0 && !loading && (
              <tr><td colSpan={6} className="stocknc-empty">No hay productos NC para mostrar</td></tr>
            )}
            {loading && (
              <tr><td colSpan={6} className="stocknc-empty">Cargando…</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

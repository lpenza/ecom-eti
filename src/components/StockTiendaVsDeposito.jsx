import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { obtenerStockTiendaVsDeposito, sincronizarStockNC } from '../services/api';
import { formatFechaHoraUy, parseTimestampUtc } from '../utils/fechas';

// Mismo criterio de "stock bajo" que la tab de colores: 5 unidades o menos, o el
// `stock_minimo` propio del producto si es mayor.
const STOCK_BAJO_UMBRAL = 5;
function umbralBajo(p) {
  return Math.max(STOCK_BAJO_UMBRAL, Number(p?.stock_minimo) || 0);
}

// Estado de cada color según tienda (Shopify) y depósito (StockPlanner).
// `prioridad` define el orden por defecto: lo más urgente de reponer arriba.
const ESTADOS = {
  reponer_sin:  { prioridad: 0, label: 'Sin stock en tienda · hay en depósito', clase: 'rojo',     reponer: true  },
  reponer_bajo: { prioridad: 1, label: 'Stock bajo · hay en depósito',          clase: 'ambar',    reponer: true  },
  no_publicado: { prioridad: 2, label: 'En depósito, no está en la tienda',     clase: 'violeta',  reponer: true  },
  agotado:      { prioridad: 3, label: 'Sin stock en ningún lado',              clase: 'gris',     reponer: false },
  bajo_sin_dep: { prioridad: 4, label: 'Stock bajo · sin depósito',             clase: 'gris',     reponer: false },
  sin_sp:       { prioridad: 5, label: 'No está en StockPlanner',               clase: 'muted',    reponer: false },
  ok:           { prioridad: 6, label: 'OK',                                    clase: 'verde',    reponer: false },
};

function estadoDe(p) {
  if (!p.en_tienda) return 'no_publicado';
  const tienda = Number(p.stock_tienda) || 0;
  const bajo = tienda <= umbralBajo(p);
  if (!p.en_stockplanner) return bajo ? 'sin_sp' : 'ok';
  const dep = Number(p.stock_deposito) || 0;
  if (tienda <= 0) return dep > 0 ? 'reponer_sin' : 'agotado';
  if (bajo) return dep > 0 ? 'reponer_bajo' : 'bajo_sin_dep';
  return 'ok';
}

const FILTROS = [
  { id: 'reponer', label: 'Para reponer',        cumple: (e) => ESTADOS[e].reponer },
  { id: 'bajos',   label: 'Bajos / sin stock',   cumple: (e) => e !== 'ok' },
  { id: 'todos',   label: 'Todos',               cumple: () => true },
];

const COLUMNAS = [
  { campo: 'estado',         label: 'Estado',      dirInicial: 'asc'  },
  { campo: 'sku',            label: 'SKU',         dirInicial: 'asc'  },
  { campo: 'nombre',         label: 'Color',       dirInicial: 'asc'  },
  { campo: 'stock_tienda',   label: 'Tienda',      dirInicial: 'asc'  },
  { campo: 'stock_deposito', label: 'Depósito',    dirInicial: 'desc' },
  { campo: 'stock_transito', label: 'En tránsito', dirInicial: 'desc' },
  { campo: 'updated_at',     label: 'Sync tienda', dirInicial: 'desc' },
];

export default function StockTiendaVsDeposito({ mostrarToast }) {
  const [filas, setFilas] = useState([]);
  const [loading, setLoading] = useState(false);
  const [sincronizando, setSincronizando] = useState(false);
  const [error, setError] = useState('');
  const [busqueda, setBusqueda] = useState('');
  const [filtro, setFiltro] = useState('reponer');
  const [orden, setOrden] = useState({ campo: 'estado', dir: 'asc' });

  const cargar = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await obtenerStockTiendaVsDeposito();
      setFilas(data.map((p) => ({ ...p, estado: estadoDe(p) })));
    } catch (err) {
      setError(err.message || 'Error leyendo el depósito');
      mostrarToast?.(err.message || 'Error leyendo el depósito', 'error');
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
      mostrarToast?.(`${res.resumen?.actualizados ?? 0} actualizado(s) desde Shopify`, 'success');
      await cargar();
    } catch (err) {
      mostrarToast?.(err.message || 'Error al sincronizar', 'error');
    } finally {
      setSincronizando(false);
    }
  }

  // Los inactivos no cuentan para las alertas (sólo aparecen en "Todos").
  const activas = useMemo(() => filas.filter((p) => p.activo !== false), [filas]);
  const conteos = useMemo(() => {
    const c = {};
    for (const p of activas) c[p.estado] = (c[p.estado] || 0) + 1;
    return c;
  }, [activas]);
  const unidadesAReponer = useMemo(() => activas
    .filter((p) => ESTADOS[p.estado].reponer)
    .reduce((s, p) => s + (Number(p.stock_deposito) || 0), 0), [activas]);

  const filtradas = useMemo(() => {
    const f = FILTROS.find((x) => x.id === filtro) || FILTROS[0];
    const base = filtro === 'todos' ? filas : activas;
    const q = busqueda.trim().toLowerCase();
    return base.filter((p) => f.cumple(p.estado) && (!q
      || String(p.sku || '').toLowerCase().includes(q)
      || String(p.nombre || '').toLowerCase().includes(q)));
  }, [filas, activas, filtro, busqueda]);

  function ordenarPor(campo) {
    const col = COLUMNAS.find((c) => c.campo === campo);
    setOrden((o) => (o.campo === campo
      ? { campo, dir: o.dir === 'asc' ? 'desc' : 'asc' }
      : { campo, dir: col?.dirInicial || 'asc' }));
  }

  const ordenadas = useMemo(() => {
    const { campo, dir } = orden;
    const signo = dir === 'asc' ? 1 : -1;
    const valor = (p) => {
      if (campo === 'estado') return ESTADOS[p.estado].prioridad;
      if (campo === 'sku' || campo === 'nombre') return String(p[campo] || '').trim().toLowerCase();
      if (campo === 'updated_at') {
        const t = parseTimestampUtc(p.updated_at);
        return Number.isFinite(t) ? t : null;
      }
      return p[campo] == null ? null : Number(p[campo]) || 0;
    };
    return [...filtradas].sort((a, b) => {
      const va = valor(a);
      const vb = valor(b);
      if (va === null && vb === null) return 0;
      if (va === null) return 1;
      if (vb === null) return -1;
      const r = typeof va === 'string' ? va.localeCompare(vb, 'es') : va - vb;
      // Desempate: dentro del mismo estado, más depósito primero (más para reponer).
      if (r === 0 && campo === 'estado') return (Number(b.stock_deposito) || 0) - (Number(a.stock_deposito) || 0);
      return r * signo;
    });
  }, [filtradas, orden]);

  const ocupado = loading || sincronizando;

  return (
    <>
      <div className="stocknc-header">
        <div>
          <h2 className="stocknc-title">Tienda vs depósito</h2>
          <p className="stocknc-sub">
            Compara el stock de cada color en Shopify con lo que queda en el depósito según
            StockPlanner (pedidos recibidos en depósito que todavía no se pasaron a la tienda).
            Así ves qué colores están bajos o agotados en la tienda y se pueden reponer.
          </p>
        </div>
        <div className="stocknc-header-actions">
          <button className="btn btn-secondary btn-sm" onClick={cargar} disabled={ocupado}>
            🔄 Actualizar
          </button>
          <button className="btn btn-primary btn-sm" onClick={handleSincronizar} disabled={ocupado}>
            {sincronizando ? 'Sincronizando…' : '⬇️ Sincronizar desde Shopify'}
          </button>
        </div>
      </div>

      {error && !loading && (
        <div className="stockdep-error" role="alert">⚠ {error}</div>
      )}

      <div className="stockdep-resumen">
        <button type="button" className="stockdep-card stockdep-card-rojo" onClick={() => setFiltro('reponer')}>
          <span className="stockdep-card-num">{conteos.reponer_sin || 0}</span>
          <span className="stockdep-card-label">Sin stock en tienda, con depósito</span>
        </button>
        <button type="button" className="stockdep-card stockdep-card-ambar" onClick={() => setFiltro('reponer')}>
          <span className="stockdep-card-num">{conteos.reponer_bajo || 0}</span>
          <span className="stockdep-card-label">Stock bajo, con depósito</span>
        </button>
        <button type="button" className="stockdep-card stockdep-card-violeta" onClick={() => setFiltro('reponer')}>
          <span className="stockdep-card-num">{conteos.no_publicado || 0}</span>
          <span className="stockdep-card-label">En depósito, no en la tienda</span>
        </button>
        <button type="button" className="stockdep-card stockdep-card-gris" onClick={() => setFiltro('bajos')}>
          <span className="stockdep-card-num">{conteos.agotado || 0}</span>
          <span className="stockdep-card-label">Sin stock en ningún lado</span>
        </button>
        <div className="stockdep-card stockdep-card-neutro">
          <span className="stockdep-card-num">{unidadesAReponer}</span>
          <span className="stockdep-card-label">Unidades en depósito de colores a reponer</span>
        </div>
      </div>

      <div className="stocknc-toolbar">
        <div className="stockdep-filtros">
          {FILTROS.map((f) => (
            <button
              key={f.id}
              type="button"
              className={`stockdep-filtro${filtro === f.id ? ' stockdep-filtro-activo' : ''}`}
              onClick={() => setFiltro(f.id)}
            >
              {f.label}
            </button>
          ))}
        </div>
        <input
          type="search"
          className="stocknc-search"
          placeholder="Buscar por SKU o nombre…"
          value={busqueda}
          onChange={(e) => setBusqueda(e.target.value)}
        />
        <span className="stocknc-count">{filtradas.length} color(es)</span>
      </div>

      <div className="stocknc-body">
        <table className="stocknc-table">
          <thead>
            <tr>
              {COLUMNAS.map((c) => {
                const activa = orden.campo === c.campo;
                return (
                  <th
                    key={c.campo}
                    className={`stocknc-th-sort${activa ? ' stocknc-th-sort-activa' : ''}`}
                    onClick={() => ordenarPor(c.campo)}
                    title={`Ordenar por ${c.label.toLowerCase()}`}
                  >
                    {c.label}
                    <span className="stocknc-sort-icon">
                      {activa ? (orden.dir === 'asc' ? '▲' : '▼') : '↕'}
                    </span>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {!loading && ordenadas.map((p) => {
              const est = ESTADOS[p.estado];
              return (
                <tr key={p.id} className={`stockdep-row-${est.clase}`}>
                  <td><span className={`stockdep-badge stockdep-badge-${est.clase}`}>{est.label}</span></td>
                  <td className="stocknc-sku">{p.sku}</td>
                  <td>{p.nombre}{p.activo === false && <span className="stockdep-inactivo"> (inactivo)</span>}</td>
                  <td className={`stocknc-stock ${Number(p.stock_tienda) < 0 ? 'stocknc-neg' : ''}`}>
                    {p.stock_tienda ?? '—'}
                  </td>
                  <td className="stocknc-stock">{p.stock_deposito ?? '—'}</td>
                  <td className="stockdep-transito">
                    {p.stock_transito ? (
                      <>
                        {p.stock_transito}
                        {p.llegada_transito && <span className="stockdep-llegada"> · llega {p.llegada_transito}</span>}
                      </>
                    ) : (p.stock_transito === null ? '—' : 0)}
                  </td>
                  <td className="stocknc-fecha">{p.updated_at ? formatFechaHoraUy(p.updated_at) : '—'}</td>
                </tr>
              );
            })}
            {ordenadas.length === 0 && !loading && (
              <tr>
                <td colSpan={COLUMNAS.length} className="stocknc-empty">
                  {filtro === 'reponer' ? 'No hay colores para reponer desde el depósito 🎉' : 'No hay colores para mostrar'}
                </td>
              </tr>
            )}
            {loading && (
              <tr><td colSpan={COLUMNAS.length} className="stocknc-empty">Cargando…</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}

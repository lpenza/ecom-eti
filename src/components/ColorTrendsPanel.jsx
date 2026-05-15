import React, { useEffect, useMemo, useState } from 'react';
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  LineChart, Line,
} from 'recharts';
import { obtenerColorTrends, refrescarColorTrends } from '../services/api';

const PALETTE = ['#e85a8a', '#7a6ad8', '#3aa3d6', '#4cc38a', '#f5a623', '#d05656', '#9aa0a6', '#8d6e63', '#4a90e2', '#c85cd9'];

function toISODate(d) {
  return d.toISOString().slice(0, 10);
}

function defaultRange() {
  const hasta = new Date();
  const desde = new Date(hasta.getTime() - 30 * 24 * 60 * 60 * 1000);
  return { desde: toISODate(desde), hasta: toISODate(hasta) };
}

function formatNumber(n) {
  return Number(n || 0).toLocaleString('es-UY');
}

function formatPct(n) {
  if (n === null || n === undefined) return '—';
  const sign = n > 0 ? '+' : '';
  return `${sign}${Number(n).toFixed(1)}%`;
}

function formatFecha(s, granularidad) {
  if (!s) return '';
  if (granularidad === 'mes') {
    const [y, m] = s.split('-');
    return `${m}/${y.slice(2)}`;
  }
  const d = new Date(`${s}T00:00:00`);
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleDateString('es-UY', { day: '2-digit', month: 'short' });
}

export default function ColorTrendsPanel() {
  const { desde: defDesde, hasta: defHasta } = defaultRange();
  const [desde, setDesde] = useState(defDesde);
  const [hasta, setHasta] = useState(defHasta);
  const [contexto, setContexto] = useState('todos');
  const [granularidad, setGranularidad] = useState('dia');
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [data, setData] = useState(null);
  const [selectedColor, setSelectedColor] = useState(null); // color_key
  const [helperOpen, setHelperOpen] = useState(false);
  const [selectedSeriesKeys, setSelectedSeriesKeys] = useState(null); // null = usar top 5 default

  async function cargar() {
    setLoading(true);
    setError('');
    try {
      const res = await obtenerColorTrends({ desde, hasta, contexto, granularidad, comparativa: true });
      setData(res);
      // resetear seleccion al top 5 de los nuevos datos
      const top5 = (res?.topColors || []).map(c => c.color_key);
      setSelectedSeriesKeys(top5);
    } catch (err) {
      setError(err.message || 'Error cargando tendencias');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { cargar(); /* eslint-disable-next-line */ }, []);

  async function handleRefrescar(full = false) {
    if (refreshing) return;
    setRefreshing(true);
    setError('');
    try {
      const body = full ? {} : { desde, hasta };
      await refrescarColorTrends(body);
      await cargar();
    } catch (err) {
      setError(err.message || 'Error refrescando cache');
    } finally {
      setRefreshing(false);
    }
  }

  // Colores activos en la serie (lo que el usuario eligio o top 5 por default)
  const activeKeys = selectedSeriesKeys || (data?.topColors || []).map(c => c.color_key);
  const activeColors = useMemo(() => {
    const ranking = data?.ranking || [];
    const map = new Map(ranking.map(r => [r.color_key, r]));
    return activeKeys
      .map(k => map.get(k))
      .filter(Boolean);
  }, [data, activeKeys]);

  const colorByKey = useMemo(() => {
    const map = {};
    activeColors.forEach((c, i) => { map[c.color_key] = { label: c.color_label, color: PALETTE[i % PALETTE.length] }; });
    return map;
  }, [activeColors]);

  // Reconstruimos la serie en cliente usando ranking[i].serie_dia + granularidad
  const bucketOf = (fechaISO) => {
    if (granularidad === 'mes') return fechaISO.slice(0, 7);
    if (granularidad === 'semana') {
      const dt = new Date(fechaISO + 'T00:00:00');
      const dayOfWeek = (dt.getDay() + 6) % 7;
      dt.setDate(dt.getDate() - dayOfWeek);
      return dt.toISOString().slice(0, 10);
    }
    return fechaISO;
  };
  const serieFmt = useMemo(() => {
    if (!data) return [];
    const bucketMap = new Map();
    activeColors.forEach(c => {
      (c.serie_dia || []).forEach(d => {
        const b = bucketOf(d.fecha);
        if (!bucketMap.has(b)) bucketMap.set(b, { fecha: b, fechaLabel: formatFecha(b, granularidad) });
        const row = bucketMap.get(b);
        row[c.color_key] = (row[c.color_key] || 0) + (d.unidades || 0);
      });
    });
    return Array.from(bucketMap.values()).sort((a, b) => a.fecha.localeCompare(b.fecha));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, activeColors, granularidad]);

  function toggleSerieColor(key) {
    setSelectedSeriesKeys(prev => {
      const cur = prev || (data?.topColors || []).map(c => c.color_key);
      if (cur.includes(key)) return cur.filter(k => k !== key);
      if (cur.length >= 10) return cur; // limite practico
      return [...cur, key];
    });
  }
  function resetSerieColors() {
    setSelectedSeriesKeys((data?.topColors || []).map(c => c.color_key));
  }
  function clearSerieColors() {
    setSelectedSeriesKeys([]);
  }

  const rankingTop = (data?.ranking || []).slice(0, 10);
  const comparativa = data?.comparativa?.comparativa?.slice(0, 15) || [];

  // Ranking por velocidad (sortable, todos los colores)
  const [sortBy, setSortBy] = useState('velocidad'); // velocidad | intensidad | unidades | tendencia_pct
  const [sortDir, setSortDir] = useState('desc');
  const [topN, setTopN] = useState(15);
  const rankingPorVelocidad = useMemo(() => {
    const arr = [...(data?.ranking || [])];
    const dir = sortDir === 'asc' ? 1 : -1;
    arr.sort((a, b) => {
      const av = a[sortBy];
      const bv = b[sortBy];
      // nulls al final siempre
      if (av === null || av === undefined) return 1;
      if (bv === null || bv === undefined) return -1;
      return (av - bv) * dir;
    });
    return arr.slice(0, topN);
  }, [data, sortBy, sortDir, topN]);

  function toggleSort(col) {
    if (sortBy === col) {
      setSortDir(d => d === 'desc' ? 'asc' : 'desc');
    } else {
      setSortBy(col);
      setSortDir('desc');
    }
  }
  const sortArrow = (col) => sortBy === col ? (sortDir === 'desc' ? ' ▼' : ' ▲') : '';
  const selectedRow = useMemo(
    () => (data?.ranking || []).find(r => r.color_key === selectedColor) || null,
    [data, selectedColor]
  );

  return (
    <div className="ct-panel">
      <header className="ct-header">
        <div>
          <h2 className="ct-title">Tendencias de colores</h2>
          <p className="ct-subtitle">
            Unidades vendidas por color (esmaltes sueltos + componentes de kits/sets).
            {data?.refreshed_at && (
              <span className="ct-refreshed"> · Cache: {new Date(data.refreshed_at).toLocaleString('es-UY')}</span>
            )}
          </p>
        </div>
        <div className="ct-actions">
          <button className="ct-btn" onClick={() => handleRefrescar(false)} disabled={refreshing || loading}>
            {refreshing ? 'Refrescando…' : 'Refrescar rango'}
          </button>
          <button className="ct-btn ct-btn-secondary" onClick={() => handleRefrescar(true)} disabled={refreshing || loading} title="Reconstruir cache desde cero (todo el historial)">
            Rebuild full
          </button>
        </div>
      </header>

      <section className={`ct-helper ${helperOpen ? 'ct-helper-open' : ''}`}>
        <button
          type="button"
          className="ct-helper-toggle"
          onClick={() => setHelperOpen(o => !o)}
          aria-expanded={helperOpen}
        >
          <span className="ct-helper-icon">ⓘ</span>
          <span>¿Cómo leer este panel?</span>
          <span className="ct-helper-chevron">{helperOpen ? '▲' : '▼'}</span>
        </button>
        {helperOpen && (
          <div className="ct-helper-body">
            <p>
              Este panel muestra qué colores se vendieron en el rango elegido y a qué ritmo, combinando
              esmaltes sueltos y los que salieron como componentes de kits/sets (fuente: <code>movimientos_stock</code>).
            </p>
            <dl className="ct-helper-defs">
              <div>
                <dt>Velocidad <span className="ct-helper-unit">(ud / día)</span></dt>
                <dd>Unidades totales dividido los <strong>días del rango completo</strong>. Mide el ritmo continuo de venta.</dd>
              </div>
              <div>
                <dt>Intensidad <span className="ct-helper-unit">(ud / día activo)</span></dt>
                <dd>Unidades totales dividido los <strong>días en que efectivamente vendió</strong>. Mide cuánto vende cuando vende.</dd>
              </div>
              <div>
                <dt>Días activos <span className="ct-helper-unit">(N / rango)</span></dt>
                <dd>Cantidad de días distintos en que ese color tuvo al menos una venta sobre el total del rango. Mide consistencia.</dd>
              </div>
              <div>
                <dt>Tendencia interna <span className="ct-helper-unit">(1ª → 2ª mitad)</span></dt>
                <dd>Variación porcentual entre lo vendido en la primera mitad del rango y la segunda. ▲ acelera, ▼ desacelera.</dd>
              </div>
            </dl>
            <div className="ct-helper-example">
              <strong>Ejemplo:</strong> dos colores con 30 unidades en 30 días.
              <table>
                <thead>
                  <tr><th>Color</th><th>Días activos</th><th>Velocidad</th><th>Intensidad</th><th>Lectura</th></tr>
                </thead>
                <tbody>
                  <tr><td>Constante</td><td>30/30</td><td>1.0/día</td><td>1.0/día</td><td>Vende 1 todos los días. Seller estable.</td></tr>
                  <tr><td>Explosivo</td><td>3/30</td><td>1.0/día</td><td>10.0/día</td><td>10 ud en 3 días, nada el resto. Hit puntual.</td></tr>
                </tbody>
              </table>
              <p className="ct-helper-tip">
                Misma velocidad, intensidad muy distinta. Velocidad alta + intensidad similar = flujo parejo.
                Intensidad mucho mayor que velocidad = picos esporádicos (riesgo de quiebre de stock).
              </p>
            </div>
            <p className="ct-helper-hint">
              💡 Tip: click en una barra del ranking o en una fila de las tablas para abrir el detalle día a día de ese color.
            </p>
          </div>
        )}
      </section>

      <section className="ct-filters">
        <label>Desde
          <input type="date" value={desde} onChange={e => setDesde(e.target.value)} />
        </label>
        <label>Hasta
          <input type="date" value={hasta} onChange={e => setHasta(e.target.value)} />
        </label>
        <label>Contexto
          <select value={contexto} onChange={e => setContexto(e.target.value)}>
            <option value="todos">Todos</option>
            <option value="kit">Kits</option>
            <option value="set">Sets</option>
            <option value="individual">Individuales</option>
          </select>
        </label>
        <label>Granularidad
          <select value={granularidad} onChange={e => setGranularidad(e.target.value)}>
            <option value="dia">Día</option>
            <option value="semana">Semana</option>
            <option value="mes">Mes</option>
          </select>
        </label>
        <button className="ct-btn ct-btn-primary" onClick={cargar} disabled={loading}>
          {loading ? 'Cargando…' : 'Aplicar'}
        </button>
      </section>

      {error && <div className="ct-error">{error}</div>}

      {data && (
        <>
          <section className="ct-kpis">
            <div className="ct-kpi">
              <span className="ct-kpi-label">Total unidades</span>
              <strong className="ct-kpi-value">{formatNumber(data.kpis?.totalUnidades)}</strong>
            </div>
            <div className="ct-kpi">
              <span className="ct-kpi-label">Color top</span>
              <strong className="ct-kpi-value">{data.kpis?.colorTop?.color_label || '—'}</strong>
              <span className="ct-kpi-detail">{formatNumber(data.kpis?.colorTop?.unidades)} ud · {data.kpis?.colorTop?.pct || 0}%</span>
            </div>
            <div className="ct-kpi">
              <span className="ct-kpi-label">Colores únicos</span>
              <strong className="ct-kpi-value">{data.kpis?.coloresUnicos || 0}</strong>
            </div>
          </section>

          <section className="ct-charts">
            <div className="ct-card">
              <h3 className="ct-card-title">Ranking · Top 10 <span className="ct-card-sub">(click en un color para ver detalle)</span></h3>
              <ResponsiveContainer width="100%" height={360}>
                <BarChart
                  data={rankingTop}
                  layout="vertical"
                  margin={{ left: 20, right: 30, top: 10, bottom: 10 }}
                  onClick={(e) => {
                    if (e && e.activePayload && e.activePayload[0]) {
                      setSelectedColor(e.activePayload[0].payload.color_key);
                    }
                  }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="#eee" />
                  <XAxis type="number" />
                  <YAxis type="category" dataKey="color_label" width={120} tick={{ fontSize: 12, cursor: 'pointer' }} />
                  <Tooltip formatter={(v) => formatNumber(v)} />
                  <Bar dataKey="unidades" fill="#7a6ad8" radius={[0, 4, 4, 0]} cursor="pointer" />
                </BarChart>
              </ResponsiveContainer>
            </div>

            <div className="ct-card">
              <div className="ct-card-titlebar">
                <h3 className="ct-card-title" style={{ margin: 0 }}>
                  Tendencia · colores seleccionados
                  <span className="ct-card-sub"> ({activeColors.length} de {(data?.ranking || []).length})</span>
                </h3>
                <div className="ct-card-controls">
                  <button type="button" className="ct-chip-link" onClick={resetSerieColors}>Top 5</button>
                  <button type="button" className="ct-chip-link" onClick={clearSerieColors}>Limpiar</button>
                </div>
              </div>
              <div className="ct-tendencia-row">
                <div className="ct-tendencia-chart">
                  <ResponsiveContainer width="100%" height={420}>
                    <LineChart data={serieFmt} margin={{ left: 10, right: 20, top: 10, bottom: 10 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#eee" />
                      <XAxis dataKey="fechaLabel" />
                      <YAxis />
                      <Tooltip />
                      <Legend />
                      {activeColors.map((c) => (
                        <Line
                          key={c.color_key}
                          type="monotone"
                          dataKey={c.color_key}
                          name={c.color_label}
                          stroke={colorByKey[c.color_key]?.color || '#888'}
                          strokeWidth={2}
                          dot={false}
                          connectNulls
                        />
                      ))}
                    </LineChart>
                  </ResponsiveContainer>
                </div>
                <div className="ct-chips ct-chips-side">
                  {(data?.ranking || []).slice(0, 30).map((c, i) => {
                    const active = activeKeys.includes(c.color_key);
                    const swatch = active ? (colorByKey[c.color_key]?.color || PALETTE[i % PALETTE.length]) : '#d1d5db';
                    return (
                      <button
                        key={c.color_key}
                        type="button"
                        className={`ct-chip ${active ? 'ct-chip-on' : ''}`}
                        onClick={() => toggleSerieColor(c.color_key)}
                        title={`${c.color_label} · ${formatNumber(c.unidades)} ud`}
                      >
                        <span className="ct-chip-dot" style={{ background: swatch }} />
                        {c.color_label}
                        <span className="ct-chip-num">{formatNumber(c.unidades)}</span>
                      </button>
                    );
                  })}
                  {(data?.ranking || []).length > 30 && (
                    <span className="ct-chips-more">+ {(data?.ranking || []).length - 30} colores (mostrando top 30)</span>
                  )}
                </div>
              </div>
            </div>
          </section>

          <section className="ct-card">
            <div className="ct-card-titlebar">
              <h3 className="ct-card-title" style={{ margin: 0 }}>
                Velocidad de venta por color
                <span className="ct-card-sub"> (click en una fila para ver detalle)</span>
              </h3>
              <div className="ct-card-controls">
                <label>
                  Mostrar
                  <select value={topN} onChange={e => setTopN(Number(e.target.value))}>
                    <option value={10}>Top 10</option>
                    <option value={15}>Top 15</option>
                    <option value={30}>Top 30</option>
                    <option value={1000}>Todos</option>
                  </select>
                </label>
              </div>
            </div>
            <table className="ct-table ct-table-sortable">
              <thead>
                <tr>
                  <th onClick={() => toggleSort('color_label')}>Color</th>
                  <th className="ct-num" onClick={() => toggleSort('unidades')}>Unidades{sortArrow('unidades')}</th>
                  <th className="ct-num" onClick={() => toggleSort('velocidad')} title="Unidades / dias totales del rango">
                    Velocidad{sortArrow('velocidad')}
                    <div className="ct-th-sub">ud / día</div>
                  </th>
                  <th className="ct-num" onClick={() => toggleSort('intensidad')} title="Unidades / dias en que efectivamente vendio">
                    Intensidad{sortArrow('intensidad')}
                    <div className="ct-th-sub">ud / día activo</div>
                  </th>
                  <th className="ct-num" onClick={() => toggleSort('dias_activos')}>
                    Días activos{sortArrow('dias_activos')}
                    <div className="ct-th-sub">/ rango</div>
                  </th>
                  <th className="ct-num" onClick={() => toggleSort('tendencia_pct')} title="Variacion 1a mitad vs 2a mitad del rango">
                    Tendencia{sortArrow('tendencia_pct')}
                    <div className="ct-th-sub">1ª → 2ª mitad</div>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rankingPorVelocidad.length === 0 && (
                  <tr><td colSpan="6" className="ct-empty">Sin datos en el rango.</td></tr>
                )}
                {rankingPorVelocidad.map(r => {
                  const tend = r.tendencia_pct;
                  const tendTxt = tend === null
                    ? '—'
                    : (tend > 0 ? '▲ ' : tend < 0 ? '▼ ' : '= ') + Math.abs(tend).toFixed(1) + '%';
                  const tendClass = tend === null ? '' : (tend > 0 ? 'ct-up' : tend < 0 ? 'ct-down' : '');
                  return (
                    <tr key={r.color_key} className="ct-row-clickable" onClick={() => setSelectedColor(r.color_key)}>
                      <td>{r.color_label}</td>
                      <td className="ct-num">{formatNumber(r.unidades)}</td>
                      <td className="ct-num ct-strong">{r.velocidad.toFixed(2)}</td>
                      <td className="ct-num">{r.intensidad.toFixed(2)}</td>
                      <td className="ct-num">{r.dias_activos} / {r.dias_rango}</td>
                      <td className={`ct-num ${tendClass}`}>{tendTxt}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>

          <section className="ct-card">
            <h3 className="ct-card-title">
              Comparativa con período anterior
              {data.comparativa && (
                <span className="ct-card-sub">
                  {' '}({data.comparativa.periodoAnterior.desde} → {data.comparativa.periodoAnterior.hasta})
                </span>
              )}
            </h3>
            <table className="ct-table">
              <thead>
                <tr>
                  <th>Color</th>
                  <th className="ct-num">Actual</th>
                  <th className="ct-num">Anterior</th>
                  <th className="ct-num">Δ abs</th>
                  <th className="ct-num">Δ %</th>
                </tr>
              </thead>
              <tbody>
                {comparativa.length === 0 && (
                  <tr><td colSpan="5" className="ct-empty">Sin datos para comparar.</td></tr>
                )}
                {comparativa.map(r => (
                  <tr key={r.color_key} className="ct-row-clickable" onClick={() => setSelectedColor(r.color_key)}>
                    <td>{r.color_label}</td>
                    <td className="ct-num">{formatNumber(r.actual)}</td>
                    <td className="ct-num">{formatNumber(r.anterior)}</td>
                    <td className={`ct-num ${r.variacion_abs > 0 ? 'ct-up' : r.variacion_abs < 0 ? 'ct-down' : ''}`}>
                      {r.variacion_abs > 0 ? '+' : ''}{formatNumber(r.variacion_abs)}
                    </td>
                    <td className={`ct-num ${r.variacion_pct > 0 ? 'ct-up' : r.variacion_pct < 0 ? 'ct-down' : ''}`}>
                      {formatPct(r.variacion_pct)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </>
      )}

      {selectedRow && (
        <ColorDetailModal
          row={selectedRow}
          desde={desde}
          hasta={hasta}
          onClose={() => setSelectedColor(null)}
        />
      )}
    </div>
  );
}

function ColorDetailModal({ row, desde, hasta, onClose }) {
  const serie = (row.serie_dia || []).map(d => ({
    ...d,
    fechaLabel: formatFecha(d.fecha, 'dia'),
  }));
  const tendencia = row.tendencia_pct;
  const tendenciaTxt = tendencia === null
    ? '—'
    : (tendencia > 0 ? '▲ ' : tendencia < 0 ? '▼ ' : '= ') + Math.abs(tendencia).toFixed(1) + '%';
  const tendenciaClass = tendencia === null ? '' : (tendencia > 0 ? 'ct-up' : tendencia < 0 ? 'ct-down' : '');

  // Mejor dia
  let mejorDia = null;
  for (const d of (row.serie_dia || [])) {
    if (!mejorDia || d.unidades > mejorDia.unidades) mejorDia = d;
  }

  return (
    <div className="ct-modal-overlay" onClick={onClose}>
      <div className="ct-modal" onClick={e => e.stopPropagation()}>
        <header className="ct-modal-header">
          <div>
            <h3 className="ct-modal-title">{row.color_label}</h3>
            <p className="ct-modal-sub">
              Detalle de ventas · {desde} → {hasta} ({row.dias_rango} días)
            </p>
          </div>
          <button className="ct-modal-close" onClick={onClose} aria-label="Cerrar">×</button>
        </header>

        <section className="ct-modal-kpis">
          <div className="ct-kpi">
            <span className="ct-kpi-label">Unidades</span>
            <strong className="ct-kpi-value">{formatNumber(row.unidades)}</strong>
            <span className="ct-kpi-detail">{row.pct}% del total</span>
          </div>
          <div className="ct-kpi">
            <span className="ct-kpi-label">Velocidad</span>
            <strong className="ct-kpi-value">{row.velocidad.toFixed(2)}</strong>
            <span className="ct-kpi-detail">ud / día (promedio del rango)</span>
          </div>
          <div className="ct-kpi">
            <span className="ct-kpi-label">Intensidad</span>
            <strong className="ct-kpi-value">{row.intensidad.toFixed(2)}</strong>
            <span className="ct-kpi-detail">ud / día activo · {row.dias_activos} días vendió</span>
          </div>
          <div className="ct-kpi">
            <span className="ct-kpi-label">Tendencia interna</span>
            <strong className={`ct-kpi-value ${tendenciaClass}`}>{tendenciaTxt}</strong>
            <span className="ct-kpi-detail">
              1ª mitad: {formatNumber(row.unidades_1a_mitad)} · 2ª: {formatNumber(row.unidades_2a_mitad)}
            </span>
          </div>
        </section>

        <section className="ct-modal-chart">
          <h4 className="ct-modal-section-title">Ventas día a día</h4>
          {serie.length === 0 ? (
            <p className="ct-empty">Sin movimientos en el rango.</p>
          ) : (
            <ResponsiveContainer width="100%" height={280}>
              <BarChart data={serie} margin={{ left: 10, right: 20, top: 10, bottom: 10 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#eee" />
                <XAxis dataKey="fechaLabel" />
                <YAxis allowDecimals={false} />
                <Tooltip formatter={(v) => formatNumber(v) + ' ud'} />
                <Bar dataKey="unidades" fill="#7a6ad8" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
          {mejorDia && (
            <p className="ct-modal-footnote">
              Mejor día: <strong>{formatFecha(mejorDia.fecha, 'dia')}</strong> con {formatNumber(mejorDia.unidades)} ud.
            </p>
          )}
        </section>
      </div>
    </div>
  );
}

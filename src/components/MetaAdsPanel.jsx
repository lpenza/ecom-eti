import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  obtenerCuentasMetaAds,
  obtenerCampaniasMetaAds,
  obtenerConjuntosMetaAds,
  obtenerAnunciosMetaAds,
  cambiarEstadoMetaAds,
  cambiarPresupuestoMetaAds,
  duplicarMetaAds,
  obtenerParametrosMetaAds,
} from '../services/api';
import { ACCIONES, evaluar } from '../utils/metaAdsReglas';
import { ESTADOS_ENTIDAD } from './metaAds/util';

// Pestaña "Campañas" de la sección Meta Ads (diseño Cauce, ver metaAds/cauce.css):
// campañas → conjuntos → anuncios con métricas, prender/apagar, presupuesto y
// duplicar. Estas acciones son manuales (las hace el admin en el momento) y
// quedan en la actividad del piloto.

const PERIODOS = [
  { value: 'today', label: 'Hoy' },
  { value: 'yesterday', label: 'Ayer' },
  { value: 'last_3d', label: 'Últimos 3 días' },
  { value: 'last_7d', label: 'Últimos 7 días' },
  { value: 'last_14d', label: 'Últimos 14 días' },
  { value: 'last_30d', label: 'Últimos 30 días' },
  { value: 'this_month', label: 'Este mes' },
  { value: 'last_month', label: 'Mes pasado' },
  { value: 'maximum', label: 'Todo el tiempo' },
];

// Rulebook §3: subir siempre por debajo del 20% (más reinicia el aprendizaje).
const ESCALADOS_RAPIDOS = [-20, 10, 15, 18];

const APRENDIZAJE = {
  LEARNING: { label: 'Aprendiendo', clase: 'accent' },
  FAIL: { label: 'Aprendizaje limitado', clase: 'warn' },
};

const NIVEL = {
  campania: { singular: 'la campaña', indent: 0 },
  conjunto: { singular: 'el conjunto', indent: 22 },
  anuncio: { singular: 'el anuncio', indent: 44 },
};

const fmtNum = (n, dec = 0) => (n == null || !Number.isFinite(n) ? '—' : n.toLocaleString('es-UY', { maximumFractionDigits: dec, minimumFractionDigits: dec }));
const fmtPlata = (n) => (n == null || !Number.isFinite(n) ? '—' : fmtNum(n, n >= 100 ? 0 : 2));

function colorRoas(roas, p) {
  if (roas == null) return 'var(--c-muted)';
  if (roas > (p?.roasEscalado ?? 3)) return 'var(--c-good)';
  if (roas >= (p?.roasPausa ?? 2)) return 'var(--c-text)';
  return 'var(--c-bad)';
}

function sumarMetricas(items) {
  const t = { gasto: 0, compras: 0, valorCompras: 0 };
  for (const it of items) {
    const m = it.metricas;
    if (!m) continue;
    t.gasto += m.gasto;
    t.compras += m.compras;
    t.valorCompras += m.valorCompras;
  }
  return { ...t, cpa: t.compras > 0 ? t.gasto / t.compras : null, roas: t.gasto > 0 && t.valorCompras > 0 ? t.valorCompras / t.gasto : null };
}

const porGasto = (a, b) => (b.metricas?.gasto || 0) - (a.metricas?.gasto || 0);

function Chip({ e }) {
  if (!e) return null;
  return <span className={`chip ${e.clase || ''}`}>{e.label}</span>;
}

function Interruptor({ encendido, deshabilitado, onClick, titulo }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={deshabilitado}
      title={titulo}
      aria-label={titulo}
      aria-pressed={encendido}
      style={{
        width: 32, height: 18, borderRadius: 999, border: 'none', padding: 2, flexShrink: 0, marginTop: 1,
        background: encendido ? 'var(--c-accent)' : 'rgba(255,255,255,.16)',
        display: 'flex', justifyContent: encendido ? 'flex-end' : 'flex-start', transition: 'background .15s',
      }}
    >
      <span style={{ width: 14, height: 14, borderRadius: '50%', background: encendido ? '#0B0C0F' : 'var(--c-text)' }} />
    </button>
  );
}

function EditorPresupuesto({ item, onAplicar, onCerrar, ocupado }) {
  const actual = item.presupuestoDiario ?? item.presupuestoTotal;
  const [monto, setMonto] = useState(actual != null ? String(actual) : '');
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: 8, marginTop: 6, background: 'var(--c-bg)', border: '1px solid var(--c-border-strong)', borderRadius: 8 }}>
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
        {ESCALADOS_RAPIDOS.map(p => (
          <button key={p} type="button" className="btn btn-sm" disabled={ocupado} onClick={() => onAplicar({ porcentaje: p })} style={{ color: p > 0 ? 'var(--c-good)' : 'var(--c-bad)' }}>
            {p > 0 ? `+${p}%` : `${p}%`}
          </button>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
        <input
          type="number" min="1" step="any" value={monto} className="num" aria-label="Monto nuevo"
          onChange={e => setMonto(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && monto) onAplicar({ monto: Number(monto) }); }}
          style={{ width: 90, height: 26, textAlign: 'right' }}
        />
        <button type="button" className="pri btn-sm" disabled={ocupado || !monto} onClick={() => onAplicar({ monto: Number(monto) })} style={{ height: 26 }}>Aplicar</button>
        <button type="button" className="btn btn-sm" onClick={onCerrar} aria-label="Cerrar">✕</button>
      </div>
    </div>
  );
}

function Indicador({ veredicto, onAplicar, ocupado }) {
  if (!veredicto) return <span style={{ color: 'var(--c-faint)' }}>—</span>;
  const a = ACCIONES[veredicto.accion];
  const aplicable = veredicto.accion === 'pausar' || (veredicto.accion === 'escalar' && veredicto.cambio);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 4, whiteSpace: 'normal', minWidth: 170, maxWidth: 250 }}>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <span className={`chip ${a.clase}`}>{a.label}{veredicto.cambio ? ` +${veredicto.cambio.porcentaje}%` : ''}</span>
        {aplicable && <button type="button" className="btn btn-sm" disabled={ocupado} onClick={onAplicar} title="Aplicar a mano (pide confirmación)">Aplicar</button>}
      </div>
      <span style={{ fontSize: 11.5, color: 'var(--c-soft)', textAlign: 'left', lineHeight: 1.3 }}>{veredicto.motivo}</span>
      {veredicto.alertas.map(t => <span key={t} style={{ fontSize: 11, color: 'var(--c-warn)', textAlign: 'left' }}>⚠ {t}</span>)}
    </div>
  );
}

export default function MetaAdsPanel({ mostrarToast }) {
  const [cuentas, setCuentas] = useState([]);
  const [cuenta, setCuenta] = useState('');
  const [periodo, setPeriodo] = useState('last_7d');
  const [filtro, setFiltro] = useState('activas');
  const [moneda, setMoneda] = useState('UYU');

  const [campanias, setCampanias] = useState([]);
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState(null);

  const [conjuntos, setConjuntos] = useState({});
  const [anuncios, setAnuncios] = useState({});
  const [abiertos, setAbiertos] = useState(() => new Set());
  const [ocupados, setOcupados] = useState(() => new Set());
  const [editandoPresupuesto, setEditandoPresupuesto] = useState(null);

  const [parametros, setParametros] = useState(null);
  const [soloConAccion, setSoloConAccion] = useState(false);

  const marcarOcupado = (id, si) => setOcupados(prev => {
    const n = new Set(prev);
    if (si) n.add(id); else n.delete(id);
    return n;
  });

  useEffect(() => {
    obtenerCuentasMetaAds()
      .then(r => {
        setCuentas(r.cuentas || []);
        setCuenta(r.porDefecto || '');
        if (!r.cuentas?.length) setError({ mensaje: 'El token no tiene acceso a ninguna cuenta publicitaria' });
      })
      .catch(err => setError({ mensaje: err.message, detalle: err.response?.detalle, status: err.status }));
    obtenerParametrosMetaAds().then(r => setParametros(r.parametros)).catch(() => {});
  }, []);

  const params = useMemo(() => ({ datePreset: periodo, filtro }), [periodo, filtro]);

  const cargarCampanias = useCallback(async () => {
    if (!cuenta) return;
    setCargando(true);
    setError(null);
    setConjuntos({});
    setAnuncios({});
    try {
      const r = await obtenerCampaniasMetaAds({ cuenta, ...params });
      setMoneda(r.moneda || 'UYU');
      setCampanias((r.campanias || []).sort(porGasto));
    } catch (err) {
      setError({ mensaje: err.message, detalle: err.response?.detalle, status: err.status });
      setCampanias([]);
    } finally {
      setCargando(false);
    }
  }, [cuenta, params]);

  useEffect(() => { cargarCampanias(); }, [cargarCampanias]);

  const cargarConjuntos = useCallback(async (campaniaId) => {
    setConjuntos(prev => ({ ...prev, [campaniaId]: { ...prev[campaniaId], cargando: true, error: null } }));
    try {
      const r = await obtenerConjuntosMetaAds(campaniaId, params);
      setConjuntos(prev => ({ ...prev, [campaniaId]: { cargando: false, items: (r.conjuntos || []).sort(porGasto) } }));
    } catch (err) {
      setConjuntos(prev => ({ ...prev, [campaniaId]: { cargando: false, error: err.message, items: [] } }));
    }
  }, [params]);

  const cargarAnuncios = useCallback(async (conjuntoId) => {
    setAnuncios(prev => ({ ...prev, [conjuntoId]: { ...prev[conjuntoId], cargando: true, error: null } }));
    try {
      const r = await obtenerAnunciosMetaAds(conjuntoId, params);
      setAnuncios(prev => ({ ...prev, [conjuntoId]: { cargando: false, items: (r.anuncios || []).sort(porGasto) } }));
    } catch (err) {
      setAnuncios(prev => ({ ...prev, [conjuntoId]: { cargando: false, error: err.message, items: [] } }));
    }
  }, [params]);

  // Al recargar campañas se limpian los hijos: volvemos a pedir los que estaban abiertos.
  useEffect(() => {
    if (cargando) return;
    for (const c of campanias) {
      if (abiertos.has(c.id) && !conjuntos[c.id]) cargarConjuntos(c.id);
    }
    for (const lista of Object.values(conjuntos)) {
      for (const s of lista.items || []) {
        if (abiertos.has(s.id) && !anuncios[s.id]) cargarAnuncios(s.id);
      }
    }
  }, [campanias, conjuntos, anuncios, abiertos, cargando, cargarConjuntos, cargarAnuncios]);

  function alternarAbierto(id) {
    setAbiertos(prev => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  }

  function actualizarItem(nivel, id, cambios, padreId) {
    const aplicar = items => items.map(it => (it.id === id ? { ...it, ...cambios } : it));
    if (nivel === 'campania') setCampanias(prev => aplicar(prev));
    if (nivel === 'conjunto') setConjuntos(prev => ({ ...prev, [padreId]: { ...prev[padreId], items: aplicar(prev[padreId]?.items || []) } }));
    if (nivel === 'anuncio') setAnuncios(prev => ({ ...prev, [padreId]: { ...prev[padreId], items: aplicar(prev[padreId]?.items || []) } }));
  }

  async function handleEstado(nivel, item, padreId) {
    const encender = item.estado !== 'ACTIVE';
    if (!window.confirm(`¿${encender ? 'Prender' : 'Apagar'} ${NIVEL[nivel].singular} "${item.nombre}"?`)) return;
    marcarOcupado(item.id, true);
    try {
      const r = await cambiarEstadoMetaAds(item.id, encender ? 'ACTIVE' : 'PAUSED', item.nombre);
      actualizarItem(nivel, item.id, { estado: r.estado, estadoEfectivo: r.estadoEfectivo }, padreId);
      if (nivel === 'campania' && conjuntos[item.id]) cargarConjuntos(item.id);
      if (nivel === 'conjunto' && anuncios[item.id]) cargarAnuncios(item.id);
      mostrarToast?.(`${encender ? 'Prendido' : 'Apagado'}: ${item.nombre}`, 'success');
    } catch (err) {
      mostrarToast?.(`No se pudo cambiar el estado: ${err.message}`, 'error');
    } finally {
      marcarOcupado(item.id, false);
    }
  }

  async function handlePresupuesto(nivel, item, padreId, cambio) {
    const actual = item.presupuestoDiario ?? item.presupuestoTotal;
    const nuevoEstimado = cambio.monto != null ? cambio.monto : actual * (1 + cambio.porcentaje / 100);
    const tipo = item.presupuestoDiario != null ? 'diario' : 'total';
    const variacion = actual ? ((nuevoEstimado - actual) / actual) * 100 : 0;
    const aviso = variacion >= 20 ? '\n\n⚠ Subir 20% o más de una vez reinicia la fase de aprendizaje (Rulebook §3: +15-18%).' : '';
    if (!window.confirm(`Presupuesto ${tipo} de "${item.nombre}":\n${fmtPlata(actual)} → ${fmtPlata(nuevoEstimado)} ${moneda} (${variacion >= 0 ? '+' : ''}${variacion.toFixed(0)}%)${aviso}`)) return;
    marcarOcupado(item.id, true);
    try {
      const r = await cambiarPresupuestoMetaAds(item.id, cambio);
      actualizarItem(nivel, item.id, r.tipo === 'diario' ? { presupuestoDiario: r.nuevo } : { presupuestoTotal: r.nuevo }, padreId);
      setEditandoPresupuesto(null);
      mostrarToast?.(`Presupuesto: ${fmtPlata(r.anterior)} → ${fmtPlata(r.nuevo)} ${r.moneda}`, 'success');
    } catch (err) {
      mostrarToast?.(`No se pudo cambiar el presupuesto: ${err.message}`, 'error');
    } finally {
      marcarOcupado(item.id, false);
    }
  }

  async function handleDuplicar(nivel, item, padreId) {
    if (!window.confirm(`¿Duplicar ${NIVEL[nivel].singular} "${item.nombre}"?\nLa copia se crea APAGADA para que la revises antes de prenderla.`)) return;
    marcarOcupado(item.id, true);
    try {
      await duplicarMetaAds(item.id, nivel);
      mostrarToast?.(`Duplicado: ${item.nombre} (queda apagado)`, 'success');
      if (nivel === 'campania') await cargarCampanias();
      if (nivel === 'conjunto') await cargarConjuntos(padreId);
      if (nivel === 'anuncio') await cargarAnuncios(padreId);
    } catch (err) {
      mostrarToast?.(`No se pudo duplicar: ${err.message}`, 'error');
    } finally {
      marcarOcupado(item.id, false);
    }
  }

  const totales = sumarMetricas(campanias);
  const activas = campanias.filter(c => c.estadoEfectivo === 'ACTIVE').length;
  const ACCIONABLES = new Set(['pausar', 'revisar', 'escalar', 'graduar', 'ganador', 'creativo']);

  function aplicarSugerencia(nivel, item, padreId, v) {
    if (v.accion === 'pausar') return handleEstado(nivel, item, padreId);
    if (v.cambio) return handlePresupuesto(nivel, item, padreId, v.cambio);
    return undefined;
  }

  function filaItem(nivel, item, padreId, nombresPadres = []) {
    const veredicto = evaluar(item, nivel, parametros, { nombresPadres });
    const ocupado = ocupados.has(item.id);
    const m = item.metricas;
    const abierto = abiertos.has(item.id);
    const presupuesto = item.presupuestoDiario ?? item.presupuestoTotal;
    const fondo = nivel === 'campania' ? 'transparent' : nivel === 'conjunto' ? 'rgba(255,255,255,.015)' : 'rgba(255,255,255,.03)';

    return (
      <tr key={item.id} style={{ background: fondo }}>
        <td style={{ textAlign: 'left', whiteSpace: 'normal', minWidth: 300 }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, paddingLeft: NIVEL[nivel].indent }}>
            {nivel !== 'anuncio' ? (
              <button
                type="button"
                onClick={() => alternarAbierto(item.id)}
                aria-expanded={abierto}
                aria-label={abierto ? 'Contraer' : nivel === 'campania' ? 'Ver conjuntos' : 'Ver anuncios'}
                style={{ border: 'none', background: 'none', fontSize: 10, color: 'var(--c-muted)', width: 14, padding: 0, marginTop: 3 }}
              >
                {abierto ? '▼' : '▶'}
              </button>
            ) : <span style={{ width: 14, flexShrink: 0 }} />}
            <Interruptor encendido={item.estado === 'ACTIVE'} deshabilitado={ocupado} onClick={() => handleEstado(nivel, item, padreId)} titulo={item.estado === 'ACTIVE' ? `Apagar ${item.nombre}` : `Prender ${item.nombre}`} />
            {nivel === 'anuncio' && item.miniatura && <img src={item.miniatura} alt="" style={{ width: 34, height: 34, objectFit: 'cover', borderRadius: 6, flexShrink: 0 }} />}
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: nivel === 'campania' ? 600 : 500, wordBreak: 'break-word' }}>{item.nombre}</div>
              <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 4, alignItems: 'center' }}>
                <Chip e={ESTADOS_ENTIDAD[item.estadoEfectivo] || { label: item.estadoEfectivo, clase: '' }} />
                <Chip e={APRENDIZAJE[item.aprendizaje]} />
                {nivel === 'campania' && <span style={{ fontSize: 11, color: 'var(--c-faint)' }}>{item.presupuestoEnCampania ? 'CBO' : 'ABO'}</span>}
                {item.linkVistaPrevia && <a href={item.linkVistaPrevia} target="_blank" rel="noreferrer" style={{ fontSize: 11, color: 'var(--c-accent)' }}>vista previa ↗</a>}
              </div>
            </div>
          </div>
        </td>
        <td>
          {presupuesto != null ? (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
              <button
                type="button"
                onClick={() => setEditandoPresupuesto(editandoPresupuesto === item.id ? null : item.id)}
                title="Cambiar presupuesto"
                className="num"
                style={{ border: 'none', background: 'none', fontSize: 12.5, fontWeight: 500, padding: 0, borderBottom: '1px dashed var(--c-border-strong)' }}
              >
                {fmtPlata(presupuesto)}<span style={{ color: 'var(--c-faint)' }}>{item.presupuestoDiario != null ? '/día' : ' total'}</span>
              </button>
              {editandoPresupuesto === item.id && (
                <EditorPresupuesto item={item} ocupado={ocupado} onAplicar={cambio => handlePresupuesto(nivel, item, padreId, cambio)} onCerrar={() => setEditandoPresupuesto(null)} />
              )}
            </div>
          ) : <span style={{ color: 'var(--c-faint)', fontSize: 11.5 }}>{nivel === 'anuncio' ? '' : nivel === 'campania' ? 'en conjuntos' : 'en campaña'}</span>}
        </td>
        <td className="num" style={{ fontWeight: 500 }}>{fmtPlata(m?.gasto)}</td>
        <td className="num">{fmtNum(m?.impresiones)}</td>
        <td className="num">{fmtNum(m?.clics)}</td>
        <td className="num">{m ? `${fmtNum(m.ctr, 2)}%` : '—'}</td>
        <td className="num">{fmtNum(m?.frecuencia, 2)}</td>
        <td className="num">{m ? fmtNum(m.compras) : '—'}</td>
        <td className="num">{fmtPlata(m?.cpa)}</td>
        <td className="num" style={{ fontWeight: 600, color: colorRoas(m?.roas, parametros) }}>{m?.roas != null ? fmtNum(m.roas, 2) : '—'}</td>
        <td style={{ textAlign: 'left' }}>
          <Indicador veredicto={veredicto} ocupado={ocupado} onAplicar={() => aplicarSugerencia(nivel, item, padreId, veredicto)} />
        </td>
        <td>
          <button type="button" className="btn btn-sm" onClick={() => handleDuplicar(nivel, item, padreId)} disabled={ocupado} title="Duplicar. La copia queda apagada.">Duplicar</button>
        </td>
      </tr>
    );
  }

  function filaEstado(key, nivel, texto, color = 'var(--c-muted)') {
    return <tr key={key}><td colSpan={12} style={{ textAlign: 'left', color, fontSize: 12, paddingLeft: NIVEL[nivel].indent + 36 }}>{texto}</td></tr>;
  }

  const mostrar = (item, nivel, padres) => {
    if (!soloConAccion) return true;
    if (nivel === 'campania' && !item.presupuestoEnCampania) return true; // ABO: decide en sus conjuntos
    const v = evaluar(item, nivel, parametros, { nombresPadres: padres });
    return Boolean(v && ACCIONABLES.has(v.accion));
  };

  const conteo = {};
  const contar = (item, nivel, padres) => {
    const v = evaluar(item, nivel, parametros, { nombresPadres: padres });
    if (v && ACCIONABLES.has(v.accion)) conteo[v.accion] = (conteo[v.accion] || 0) + 1;
  };
  for (const c of campanias) {
    contar(c, 'campania', []);
    for (const s of conjuntos[c.id]?.items || []) {
      contar(s, 'conjunto', [c.nombre]);
      for (const a of anuncios[s.id]?.items || []) contar(a, 'anuncio', [c.nombre, s.nombre]);
    }
  }

  const filas = [];
  for (const c of campanias) {
    if (!mostrar(c, 'campania', [])) continue;
    filas.push(filaItem('campania', c));
    if (!abiertos.has(c.id)) continue;
    const sets = conjuntos[c.id];
    if (!sets || sets.cargando) { filas.push(filaEstado(`${c.id}-c`, 'conjunto', 'Cargando conjuntos…')); continue; }
    if (sets.error) { filas.push(filaEstado(`${c.id}-e`, 'conjunto', `Error: ${sets.error}`, 'var(--c-bad)')); continue; }
    if (!sets.items.length) filas.push(filaEstado(`${c.id}-v`, 'conjunto', 'Sin conjuntos para este filtro'));
    for (const s of sets.items) {
      if (!mostrar(s, 'conjunto', [c.nombre])) continue;
      filas.push(filaItem('conjunto', s, c.id, [c.nombre]));
      if (!abiertos.has(s.id)) continue;
      const ads = anuncios[s.id];
      if (!ads || ads.cargando) { filas.push(filaEstado(`${s.id}-c`, 'anuncio', 'Cargando anuncios…')); continue; }
      if (ads.error) { filas.push(filaEstado(`${s.id}-e`, 'anuncio', `Error: ${ads.error}`, 'var(--c-bad)')); continue; }
      if (!ads.items.length) filas.push(filaEstado(`${s.id}-v`, 'anuncio', 'Sin anuncios para este filtro'));
      for (const a of ads.items) {
        if (mostrar(a, 'anuncio', [c.nombre, s.nombre])) filas.push(filaItem('anuncio', a, s.id, [c.nombre, s.nombre]));
      }
    }
  }

  const sinPermisos = error?.status === 403 || error?.status === 503;
  const resumen = [
    ['Campañas activas', fmtNum(activas)],
    ['Gasto', fmtPlata(totales.gasto)],
    ['Compras', fmtNum(totales.compras)],
    ['Valor compras', fmtPlata(totales.valorCompras)],
    ['CPA', fmtPlata(totales.cpa)],
    ['ROAS', totales.roas != null ? fmtNum(totales.roas, 2) : '—'],
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20, padding: '24px 28px 40px' }}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        {cuentas.length > 1 && (
          <select value={cuenta} onChange={e => setCuenta(e.target.value)} aria-label="Cuenta publicitaria">
            {cuentas.map(c => <option key={c.id} value={c.id}>{c.nombre}{c.activa ? '' : ` (${c.estado})`}</option>)}
          </select>
        )}
        <select value={periodo} onChange={e => setPeriodo(e.target.value)} aria-label="Período">
          {PERIODOS.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
        </select>
        <select value={filtro} onChange={e => setFiltro(e.target.value)} aria-label="Estado">
          <option value="activas">Activas</option>
          <option value="todas">Todas (sin archivadas)</option>
        </select>
        <button type="button" className="btn" onClick={cargarCampanias} disabled={cargando || !cuenta}>{cargando ? 'Cargando…' : 'Actualizar'}</button>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: 'var(--c-soft)', marginLeft: 'auto', cursor: 'pointer' }}>
          <input type="checkbox" checked={soloConAccion} onChange={e => setSoloConAccion(e.target.checked)} style={{ height: 'auto' }} />
          Sólo lo que requiere acción
        </label>
      </div>

      {error && (
        <div className="aviso bad" style={{ flexDirection: 'column', gap: 4 }}>
          <b>{error.mensaje}</b>
          {error.detalle && error.detalle !== error.mensaje && <span>{error.detalle}</span>}
          {sinPermisos && <span>Hace falta un token de usuario del sistema con <b>ads_read</b> y <b>ads_management</b> en <code>META_ADS_ACCESS_TOKEN</code>, y la cuenta en <code>META_AD_ACCOUNT_ID</code>.</span>}
        </div>
      )}

      {!error && campanias.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 10 }}>
          {resumen.map(([k, v]) => (
            <div key={k} style={{ padding: '10px 12px', borderRadius: 8, border: '1px solid var(--c-border)' }}>
              <div style={{ fontSize: 11.5, color: 'var(--c-muted)' }}>{k}</div>
              <div className="num" style={{ fontSize: 18, fontWeight: 500, color: k === 'ROAS' ? colorRoas(totales.roas, parametros) : 'var(--c-text)' }}>{v}</div>
            </div>
          ))}
        </div>
      )}

      {!error && campanias.length > 0 && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', fontSize: 12.5 }}>
          <span style={{ color: 'var(--c-soft)' }}>Lectura rápida del período:</span>
          {Object.keys(conteo).length === 0 && <span style={{ color: 'var(--c-muted)' }}>nada fuera de rango</span>}
          {Object.entries(conteo).sort(([a], [b]) => ACCIONES[a].orden - ACCIONES[b].orden).map(([accion, n]) => (
            <span key={accion} className={`chip ${ACCIONES[accion].clase}`}>{n} {ACCIONES[accion].label.toLowerCase()}</span>
          ))}
          <span style={{ color: 'var(--c-faint)', fontSize: 12 }}>· sin 2 lecturas ni cadencias: las propuestas formales están en Para revisar</span>
          {(periodo === 'today' || periodo === 'yesterday') && <span style={{ flexBasis: '100%', color: 'var(--c-warn)', fontSize: 12 }}>⚠ Con un solo día de datos la lectura es poco confiable: para decidir usá 7 días o más.</span>}
        </div>
      )}

      {!error && (
        <div className="lista" style={{ overflowX: 'auto' }}>
          <table className="tabla">
            <thead>
              <tr>
                <th style={{ textAlign: 'left' }}>Nombre</th>
                <th>Presupuesto</th>
                <th>Gasto</th>
                <th>Impr.</th>
                <th>Clics</th>
                <th>CTR</th>
                <th>Frec.</th>
                <th>Compras</th>
                <th>CPA</th>
                <th>ROAS</th>
                <th style={{ textAlign: 'left' }}>Lectura</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {filas}
              {!cargando && campanias.length === 0 && <tr><td colSpan={12} style={{ textAlign: 'center', color: 'var(--c-muted)', padding: 28 }}>{cuenta ? 'No hay campañas para este filtro' : 'Cargando cuentas…'}</td></tr>}
              {cargando && campanias.length === 0 && <tr><td colSpan={12} style={{ textAlign: 'center', color: 'var(--c-muted)', padding: 28 }}>Cargando campañas…</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

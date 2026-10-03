import React, { useState } from 'react';
import { TIPOS, ESTADOS_PROPUESTA, fmtNum, fmtPlata, fmtHora, fmtFecha, hace, diasEsperando } from './util';

const Flecha = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--c-muted)" strokeWidth="2.2" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
);

// Línea principal de una propuesta, como en el mockup ("1.200 → 1.500 UYU/día").
export function LineaPropuesta({ p, moneda = 'UYU' }) {
  const pl = p.payload || {};
  const m = p.snapshot?.metricas;
  if (p.tipo === 'escalado') {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span className="num" style={{ color: 'var(--c-muted)', textDecoration: 'line-through', textDecorationColor: 'rgba(255,255,255,.25)' }}>{fmtPlata(pl.anterior)}</span>
        <Flecha />
        <span className="num" style={{ fontWeight: 500 }}>{fmtPlata(pl.nuevo)} {moneda}/día</span>
        <span style={{ fontSize: 12.5, color: 'var(--c-soft)' }}>· {p.entidad_nombre}{m?.cpa != null ? ` · CPA ${fmtNum(m.cpa)}, bajo objetivo` : ''}</span>
      </div>
    );
  }
  if (p.tipo === 'ajuste_parametro') {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 500 }}>{p.entidad_nombre}</span>
        <span className="num" style={{ color: 'var(--c-muted)', textDecoration: 'line-through' }}>{pl.anterior}</span>
        <Flecha />
        <span className="num" style={{ fontWeight: 500 }}>{pl.nuevo}</span>
      </div>
    );
  }
  if (p.tipo === 'crear_sich') {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', minWidth: 0 }}>
        <span style={{ fontWeight: 500 }}>{p.entidad_nombre}</span>
        <span style={{ fontSize: 12.5, color: 'var(--c-soft)' }}>· {(pl.angulos || []).map(a => a.angulo).join(', ')}</span>
      </div>
    );
  }
  if (p.tipo === 'ingesta_tanda') {
    const items = pl.items || [];
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', minWidth: 0 }}>
        <span style={{ fontWeight: 500 }}>{items.length} ad set{items.length === 1 ? '' : 's'} nuevo{items.length === 1 ? '' : 's'}</span>
        <Flecha />
        <span style={{ fontWeight: 500 }}>{pl.campaniaNombre}</span>
        <span style={{ fontSize: 12.5, color: 'var(--c-soft)' }}>· {pl.activar ? `${fmtPlata(pl.presupuesto)} ${moneda}/día` : 'se crean pausados'} · {fmtFecha(pl.inicio, { weekday: 'short', hour: '2-digit', minute: '2-digit' })}</span>
      </div>
    );
  }
  if (p.tipo === 'graduacion' || p.tipo === 'duplicado_rtg' || p.tipo === 'crear_cbo') {
    const destino = p.tipo === 'crear_cbo' ? pl.nombreCampania : (pl.conjuntoNombre || pl.campaniaDestino);
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', minWidth: 0 }}>
        <span style={{ fontWeight: 500 }}>{p.entidad_nombre}</span>
        <Flecha />
        <span style={{ fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis' }}>{destino}</span>
        {p.tipo === 'crear_cbo' && <span style={{ fontSize: 12.5, color: 'var(--c-soft)' }}>· se crea pausada</span>}
      </div>
    );
  }
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', minWidth: 0 }}>
      <span style={{ fontWeight: 500 }}>{p.entidad_nombre}</span>
      <span style={{ fontSize: 12.5, color: 'var(--c-soft)' }}>· {p.motivo}</span>
    </div>
  );
}

export function MetaPropuesta({ p }) {
  const tipo = TIPOS[p.tipo]?.label || p.tipo;
  const espera = diasEsperando(p.creado_at);
  const venceProx = p.vence_at && new Date(p.vence_at) - Date.now() < 6 * 3600000;
  return (
    <div className="meta-linea">
      <span>{tipo}{p.oferta ? ` · ${p.oferta}` : ''}</span>
      {p.avisos?.length > 0 && <span style={{ color: 'var(--c-warn)' }}>· {p.avisos.length === 1 ? '1 aviso' : `${p.avisos.length} avisos`}</span>}
      {espera >= 1 && <span style={{ color: espera > 14 ? 'var(--c-bad)' : 'var(--c-soft)' }}>· espera {espera} {espera === 1 ? 'día' : 'días'}</span>}
      {p.vence_at && <span style={{ color: venceProx ? 'var(--c-warn)' : 'var(--c-soft)', fontWeight: venceProx ? 500 : 400 }}>vence {fmtHora(p.vence_at)}</span>}
    </div>
  );
}

// Detalle completo (bandeja y modal de confirmación).
export function DetallePropuesta({ p, moneda = 'UYU' }) {
  const m = p.snapshot?.metricas;
  const pl = p.payload || {};
  const filas = [];
  if (p.campania_nombre) filas.push(['Campaña', p.campania_nombre]);
  if (p.snapshot?.conjunto) filas.push(['Ad set', p.snapshot.conjunto]);
  if (p.regla) filas.push(['Regla', p.regla]);
  if (p.tipo === 'escalado') filas.push(['Presupuesto', `${fmtPlata(pl.anterior)} → ${fmtPlata(pl.nuevo)} ${moneda}/día (+${pl.porcentaje}%)`]);
  if (pl.nombre) filas.push(['Anuncio nuevo', pl.nombre]);
  if (pl.nombreAnuncio) filas.push(['Anuncio nuevo', pl.nombreAnuncio]);
  if (p.tipo === 'crear_sich') {
    for (const a of pl.angulos || []) {
      filas.push([`A. ${a.angulo.toUpperCase()}`, `${a.estado === 'confirmada' ? '✅' : '🧪'} ${a.hipotesis}`]);
    }
  }
  if (p.tipo === 'ajuste_parametro') filas.push(['Cambio', `${pl.anterior} → ${pl.nuevo}`]);
  if (p.resultado?.link) filas.push(['Carpeta', p.resultado.link]);
  if (p.tipo === 'ingesta_tanda') {
    filas.push(['Presupuesto', pl.activar ? `${fmtPlata(pl.presupuesto)} ${moneda}/día por ad set` : 'Se crean pausados (banda roja)']);
    filas.push(['Arranque', fmtFecha(pl.inicio, { weekday: 'long', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })]);
    filas.push(['Creativos', (pl.items || []).map(i => `${i.veln} (${i.angulo}, ${i.tipo})`).join(' · ')]);
  }
  const resultados = p.resultado?.resultados;
  if (resultados?.length) {
    filas.push(['Resultado', resultados.map(r => `${r.veln}: ${r.estado === 'creado' ? `creado${r.subido ? ' (subido desde Drive)' : ''}` : r.estado === 'ya_existia' ? 'ya existía' : `error — ${r.error}`}`).join(' · ')]);
  }
  if (p.tipo === 'crear_cbo') {
    filas.push(['Campaña nueva', `${pl.nombreCampania} · ${fmtPlata(pl.presupuesto)} ${moneda}/día · pausada`]);
    filas.push(['Arranque', fmtFecha(pl.inicio, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })]);
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <p style={{ color: 'var(--c-soft)' }}>{p.motivo}</p>
      {p.avisos?.map(a => <div key={a} className="aviso"><span aria-hidden="true">⚠</span><span>{a}</span></div>)}
      {m && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(92px, 1fr))', gap: 8 }}>
          {[
            ['Gasto', fmtPlata(m.gasto)],
            ['Compras', fmtNum(m.compras)],
            ['CPA', fmtPlata(m.cpa)],
            ['ROAS', m.roas != null ? fmtNum(m.roas, 2) : '—'],
            m.ctr != null && ['CTR', `${fmtNum(m.ctr, 2)}%`],
            m.frecuencia != null && ['Frecuencia', fmtNum(m.frecuencia, 2)],
          ].filter(Boolean).map(([k, v]) => (
            <div key={k} style={{ padding: '8px 10px', borderRadius: 8, background: 'var(--c-bg)', border: '1px solid var(--c-border-soft)' }}>
              <div style={{ fontSize: 11, color: 'var(--c-muted)' }}>{k}</div>
              <div className="num" style={{ fontSize: 14, fontWeight: 500 }}>{v}</div>
            </div>
          ))}
        </div>
      )}
      <dl style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '6px 14px', margin: 0, fontSize: 12.5 }}>
        {filas.map(([k, v]) => (
          <React.Fragment key={k + v}>
            <dt style={{ color: 'var(--c-muted)' }}>{k}</dt>
            <dd style={{ margin: 0, wordBreak: 'break-word' }}>{v}</dd>
          </React.Fragment>
        ))}
      </dl>
      <div style={{ fontSize: 11.5, color: 'var(--c-faint)' }}>
        Propuesta {hace(p.creado_at)}{p.actualizado_at && p.actualizado_at !== p.creado_at ? ` · recalculada ${hace(p.actualizado_at)}` : ''}
      </div>
    </div>
  );
}

export function ChipEstadoPropuesta({ estado }) {
  const e = ESTADOS_PROPUESTA[estado] || { label: estado, clase: '' };
  return <span className={`chip ${e.clase}`}>{e.label}</span>;
}

// Modal de confirmación: muestra exactamente qué se va a ejecutar en Meta.
export function ConfirmarAprobacion({ p, moneda, onConfirmar, onCerrar, ocupado }) {
  return (
    <div className="cauce-modal-fondo" role="presentation" onMouseDown={e => { if (e.target === e.currentTarget && !ocupado) onCerrar(); }}>
      <div className="cauce-modal" role="dialog" aria-modal="true" aria-labelledby="confirmar-titulo">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <MetaPropuesta p={p} />
          <h2 id="confirmar-titulo" style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>{p.titulo}</h2>
        </div>
        <DetallePropuesta p={p} moneda={moneda} />
        <div className="aviso info">
          <span aria-hidden="true">ℹ</span>
          <span>Antes de ejecutar se vuelve a leer el estado real en Meta. Si algo cambió desde que se propuso, no se aplica y queda como desactualizada.</span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button type="button" className="btn" onClick={onCerrar} disabled={ocupado}>Cancelar</button>
          <button type="button" className="pri" onClick={onConfirmar} disabled={ocupado} autoFocus>
            {ocupado ? 'Ejecutando…' : 'Aprobar y ejecutar'}
          </button>
        </div>
      </div>
    </div>
  );
}

export function RechazarPropuesta({ p, onConfirmar, onCerrar, ocupado }) {
  const [motivo, setMotivo] = useState('');
  return (
    <div className="cauce-modal-fondo" role="presentation" onMouseDown={e => { if (e.target === e.currentTarget && !ocupado) onCerrar(); }}>
      <div className="cauce-modal" role="dialog" aria-modal="true" aria-labelledby="rechazar-titulo">
        <h2 id="rechazar-titulo" style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>Rechazar: {p.titulo}</h2>
        <p style={{ color: 'var(--c-soft)', fontSize: 12.5 }}>No se vuelve a proponer durante los próximos días de cadencia. El motivo queda en la actividad.</p>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12.5, color: 'var(--c-soft)' }}>
          Motivo (opcional)
          <textarea rows={3} value={motivo} onChange={e => setMotivo(e.target.value)} placeholder="Ej. la dejo correr hasta el lunes" />
        </label>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button type="button" className="btn" onClick={onCerrar} disabled={ocupado}>Cancelar</button>
          <button type="button" className="btn btn-danger" onClick={() => onConfirmar(motivo)} disabled={ocupado}>{ocupado ? 'Rechazando…' : 'Rechazar'}</button>
        </div>
      </div>
    </div>
  );
}

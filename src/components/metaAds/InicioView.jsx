import React, { useEffect, useState } from 'react';
import { obtenerInicioMetaAds, obtenerActividadMetaAds } from '../../services/api';
import { LineaPropuesta, MetaPropuesta } from './Propuestas';
import { fmtNum, fmtPlata, fmtHora, hoyLargo, diaClave } from './util';

const BANDA_TEXTO = {
  verde: 'La cuenta está dentro de rango.',
  amarilla: 'La cuenta está sobre el objetivo.',
  roja: 'La cuenta está sobre el CPA máximo.',
};

const COLOR_CPA = { bien: 'var(--c-accent)', medio: 'var(--c-text)', mal: 'var(--c-warn)', sin: 'var(--c-muted)' };
const FONDOS_SIN_IMAGEN = [
  'linear-gradient(160deg,#F1D2C6,#C98A7A)', 'linear-gradient(160deg,#8C2F3A,#4E1520)', 'linear-gradient(160deg,#E9DCCF,#BFA48E)',
  'linear-gradient(160deg,#D7A1B4,#9C5672)', 'linear-gradient(160deg,#B9C4D9,#7B88A6)',
];

// Medidor de CPA: zona buena hasta el objetivo, neutra hasta el máximo y de
// alerta por encima (mockup "CPA de cuenta · 7 días").
function MedidorCpa({ cpa, objetivo, maximo, moneda }) {
  const escala = Math.max(maximo * 1.3, (cpa || 0) * 1.08);
  const pos = (v) => `${Math.min(Math.max((v / escala) * 100, 1), 99)}%`;
  const pObj = (objetivo / escala) * 100;
  const pMax = (maximo / escala) * 100;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <span style={{ fontSize: 12.5, color: 'var(--c-soft)' }}>CPA de cuenta · 7 días</span>
        <span className="num" style={{ fontSize: 22, fontWeight: 500 }}>{fmtNum(cpa)} <span style={{ fontSize: 12, color: 'var(--c-faint)' }}>{moneda}</span></span>
      </div>
      <div style={{ position: 'relative', height: 28 }} role="img" aria-label={`CPA ${fmtNum(cpa)}, objetivo ${fmtNum(objetivo)}, máximo ${fmtNum(maximo)}`}>
        <div style={{ position: 'absolute', left: 0, right: 0, top: 12, height: 4, borderRadius: 2, background: `linear-gradient(90deg,rgba(142,162,255,.45) 0 ${pObj}%,rgba(255,255,255,.10) ${pObj}% ${pMax}%,rgba(242,181,68,.40) ${pMax}% 100%)` }} />
        <span style={{ position: 'absolute', left: `${pObj}%`, top: 6, width: 1, height: 16, background: 'var(--c-muted)' }} />
        <span style={{ position: 'absolute', left: `${pMax}%`, top: 6, width: 1, height: 16, background: 'var(--c-muted)' }} />
        {cpa != null && <span style={{ position: 'absolute', left: pos(cpa), top: 5, width: 18, height: 18, marginLeft: -9, borderRadius: 9, background: 'var(--c-text)', boxShadow: `0 0 0 3px #121318,0 0 0 4.5px ${cpa > maximo ? 'var(--c-warn)' : 'var(--c-accent)'}` }} />}
      </div>
      <div className="num" style={{ position: 'relative', height: 14, fontSize: 11, color: 'var(--c-muted)' }}>
        <span style={{ position: 'absolute', left: `${pObj}%`, transform: 'translateX(-50%)' }}>{fmtNum(objetivo)} obj.</span>
        <span style={{ position: 'absolute', left: `${pMax}%`, transform: 'translateX(-50%)' }}>{fmtNum(maximo)} máx.</span>
      </div>
    </div>
  );
}

export default function InicioView({ pendientes, cargandoPendientes, sinTablas, version, irA, onAprobar, mostrarToast }) {
  const [datos, setDatos] = useState(null);
  const [error, setError] = useState(null);
  const [hoy, setHoy] = useState([]);

  useEffect(() => {
    let vivo = true;
    setError(null);
    obtenerInicioMetaAds()
      .then(r => { if (vivo) setDatos(r); })
      .catch(err => { if (vivo) setError(err.message); });
    if (!sinTablas) {
      obtenerActividadMetaAds(1)
        .then(r => { if (vivo) setHoy((r.actividad || []).filter(a => diaClave(a.at) === diaClave(new Date().toISOString()))); })
        .catch(() => {});
    }
    return () => { vivo = false; };
  }, [version, sinTablas]);

  const c = datos?.cuenta;
  const moneda = datos?.moneda || 'UYU';
  const n = pendientes.length;
  const top = pendientes.slice(0, 4);

  return (
    <div className="cauce-body">
      {error && <div className="aviso bad"><span aria-hidden="true">⚠</span><span>No se pudo leer Meta: {error}</span></div>}

      <section aria-label="Estado de la cuenta" className="estado-cuenta">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12.5, color: 'var(--c-soft)' }}><span className="dot" />{hoyLargo()}</span>
          <h1 style={{ margin: 0, fontSize: 26, fontWeight: 600, letterSpacing: '-0.03em', lineHeight: 1.2 }}>
            {c?.banda ? BANDA_TEXTO[c.banda] : 'Leyendo la cuenta…'}<br />
            <span style={{ color: 'var(--c-muted)' }}>
              {sinTablas ? 'La bandeja todavía no está activa.' : cargandoPendientes ? ' ' : n === 0 ? 'No hay nada para revisar.' : n === 1 ? 'Hay 1 cosa para revisar.' : `Hay ${n} cosas para revisar.`}
            </span>
          </h1>
        </div>
        {c ? <MedidorCpa cpa={c.cpa} objetivo={c.objetivo} maximo={c.maximo} moneda={moneda} /> : <div style={{ height: 80 }} />}
      </section>

      <div className="two">
        <section aria-labelledby="rev" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div className="seccion-titulo"><h2 id="rev">Para revisar</h2><a onClick={() => irA('revisar')}>Abrir bandeja</a></div>
          <div className="lista">
            {top.length === 0 && (
              <div className="vacio">{cargandoPendientes ? 'Cargando…' : sinTablas ? 'Activá las tablas del piloto para ver propuestas.' : 'Nada pendiente. El próximo chequeo puede proponer algo nuevo.'}</div>
            )}
            {top.map(p => (
              <div key={p.id} className="fila">
                <div style={{ display: 'flex', flexDirection: 'column', gap: 5, minWidth: 0 }}>
                  <MetaPropuesta p={p} />
                  <LineaPropuesta p={p} moneda={moneda} />
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <a className="btn" onClick={() => irA('revisar')}>Revisar</a>
                  <button type="button" className="pri" onClick={() => onAprobar(p)}>Aprobar</button>
                </div>
              </div>
            ))}
            {n > top.length && (
              <a className="fila" onClick={() => irA('revisar')} style={{ color: 'var(--c-soft)', fontSize: 12.5 }}>
                <span>Y {n - top.length} más en la bandeja</span><span aria-hidden="true">→</span>
              </a>
            )}
          </div>
        </section>

        <section aria-labelledby="trail" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div className="seccion-titulo"><h2 id="trail">Lo que pasó hoy</h2><a onClick={() => irA('actividad')}>Actividad</a></div>
          <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column' }}>
            {hoy.length === 0 && <li style={{ padding: '10px 0', color: 'var(--c-muted)', fontSize: 12.5 }}>{sinTablas ? 'Sin registro de actividad todavía.' : 'Todavía no pasó nada hoy.'}</li>}
            {hoy.slice(0, 6).map((a, i) => (
              <li key={a.id} style={{ display: 'grid', gridTemplateColumns: '44px 1fr', gap: 10, padding: '10px 0', borderBottom: i < Math.min(hoy.length, 6) - 1 ? '1px solid var(--c-border-soft)' : 0 }}>
                <span className="num" style={{ fontSize: 12, color: 'var(--c-muted)', paddingTop: 1 }}>{fmtHora(a.at)}</span>
                <span style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
                  <span style={{ fontWeight: 500 }}>{a.titulo}{a.usuario && a.origen !== 'cron' ? <span style={{ fontWeight: 400, color: 'var(--c-soft)' }}> · {a.usuario.split('@')[0]}</span> : null}</span>
                  {a.detalle && <span style={{ fontSize: 12.5, color: 'var(--c-soft)', overflowWrap: 'anywhere' }}>{a.detalle}</span>}
                </span>
              </li>
            ))}
          </ol>
        </section>
      </div>

      <section aria-labelledby="crea" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div className="seccion-titulo"><h2 id="crea">Creativos que más invierten · 7 días</h2><a onClick={() => irA('campanias')}>Ver campañas</a></div>
        <div className="crea">
          {(datos?.creativos || []).map((cr, i) => (
            <div key={cr.id} style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }} title={cr.campania || ''}>
              <div className="crea-img" style={{ backgroundImage: cr.miniatura ? `url("${cr.miniatura}")` : FONDOS_SIN_IMAGEN[i % 5] }}>
                <span className="crea-tag">{cr.etiqueta}</span>
                {cr.roas != null && <span className="num crea-fmt">ROAS {fmtNum(cr.roas, 2)}</span>}
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 6 }}>
                <span className="num" style={{ fontSize: 12.5, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{cr.nombre}</span>
                {cr.angulo && <span style={{ fontSize: 12, color: 'var(--c-soft)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{cr.angulo}</span>}
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', fontSize: 12.5 }}>
                <span className="num" style={{ color: COLOR_CPA[cr.cpaNivel] }}>CPA {fmtNum(cr.cpa)}</span>
                <span className="num" style={{ color: 'var(--c-muted)' }}>{fmtPlata(cr.gasto)}</span>
              </div>
            </div>
          ))}
          {!datos && !error && Array.from({ length: 5 }).map((_, i) => <div key={i} className="crea-img" style={{ opacity: 0.35 }} />)}
        </div>
      </section>
    </div>
  );
}

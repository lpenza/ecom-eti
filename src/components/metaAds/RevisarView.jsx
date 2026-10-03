import React, { useEffect, useMemo, useState } from 'react';
import { obtenerPropuestasMetaAds, obtenerJobsMetaAds } from '../../services/api';
import { LineaPropuesta, MetaPropuesta, DetallePropuesta, ChipEstadoPropuesta } from './Propuestas';
import { TIPOS, hace, fmtFecha } from './util';

const FILTROS = [
  { id: 'todas', label: 'Todas' },
  { id: 'pausa', label: 'Pausas' },
  { id: 'escalado', label: 'Escalados' },
  { id: 'graduacion', label: 'Graduación', tipos: ['graduacion', 'duplicado_rtg', 'crear_cbo'] },
];

export default function RevisarView({ pendientes, cargandoPendientes, sinTablas, version, onAprobar, onRechazar, onEjecutarChequeo, chequeando }) {
  const [tab, setTab] = useState('pendientes');
  const [filtro, setFiltro] = useState('todas');
  const [abierta, setAbierta] = useState(null);
  const [historial, setHistorial] = useState([]);
  const [cargandoHist, setCargandoHist] = useState(false);
  const [observaciones, setObservaciones] = useState([]);

  useEffect(() => {
    obtenerJobsMetaAds()
      .then(r => setObservaciones((r.jobs || []).flatMap(j => (j.ultima?.detalleObservaciones || []).map(o => ({ ...o, job: j.nombre, at: j.ultima.at })))))
      .catch(() => {});
  }, [version]);

  useEffect(() => {
    if (tab !== 'historial' || sinTablas) return;
    setCargandoHist(true);
    obtenerPropuestasMetaAds('historial')
      .then(r => setHistorial(r.propuestas || []))
      .catch(() => setHistorial([]))
      .finally(() => setCargandoHist(false));
  }, [tab, version, sinTablas]);

  const lista = tab === 'pendientes' ? pendientes : historial;
  const filtradas = useMemo(() => {
    const f = FILTROS.find(x => x.id === filtro);
    if (!f || f.id === 'todas') return lista;
    const tipos = f.tipos || [f.id];
    return lista.filter(p => tipos.includes(p.tipo));
  }, [lista, filtro]);

  const cargando = tab === 'pendientes' ? cargandoPendientes : cargandoHist;

  return (
    <div className="cauce-body">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <div className="tabs" role="tablist" aria-label="Bandeja">
          <button type="button" role="tab" aria-selected={tab === 'pendientes'} onClick={() => setTab('pendientes')}>Pendientes{pendientes.length ? ` · ${pendientes.length}` : ''}</button>
          <button type="button" role="tab" aria-selected={tab === 'historial'} onClick={() => setTab('historial')}>Resueltas · 30 días</button>
        </div>
        <div className="tabs" role="tablist" aria-label="Tipo">
          {FILTROS.map(f => (
            <button key={f.id} type="button" role="tab" aria-selected={filtro === f.id} onClick={() => setFiltro(f.id)}>{f.label}</button>
          ))}
        </div>
      </div>

      <section style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div className="lista">
          {filtradas.length === 0 && (
            <div className="vacio">
              {cargando ? 'Cargando…' : sinTablas ? 'Activá las tablas del piloto para usar la bandeja.' : tab === 'pendientes'
                ? <>Nada pendiente. <button type="button" className="btn btn-sm" style={{ marginLeft: 8 }} onClick={onEjecutarChequeo} disabled={chequeando}>{chequeando ? 'Chequeando…' : 'Ejecutar chequeo'}</button></>
                : 'Sin propuestas resueltas en los últimos 30 días.'}
            </div>
          )}
          {filtradas.map(p => {
            const expandida = abierta === p.id;
            return (
              <div key={p.id}>
                <div className="fila" style={{ cursor: 'pointer' }} onClick={() => setAbierta(expandida ? null : p.id)}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 5, minWidth: 0 }}>
                    {tab === 'pendientes'
                      ? <MetaPropuesta p={p} />
                      : (
                        <div className="meta-linea">
                          <ChipEstadoPropuesta estado={p.estado} />
                          <span>{TIPOS[p.tipo]?.label || p.tipo}</span>
                          <span>· {p.resuelto_por || 'sistema'} · {fmtFecha(p.resuelto_at || p.actualizado_at, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
                        </div>
                      )}
                    <LineaPropuesta p={p} />
                    {tab === 'historial' && p.error && <span style={{ fontSize: 12, color: p.estado === 'ejecutada' ? 'var(--c-warn)' : 'var(--c-soft)' }}>{p.error}</span>}
                  </div>
                  {tab === 'pendientes' ? (
                    <div style={{ display: 'flex', gap: 6 }} onClick={e => e.stopPropagation()}>
                      <button type="button" className="btn" onClick={() => onRechazar(p)}>Rechazar</button>
                      <button type="button" className="pri" onClick={() => onAprobar(p)}>Aprobar</button>
                    </div>
                  ) : <span aria-hidden="true" style={{ color: 'var(--c-faint)' }}>{expandida ? '▾' : '▸'}</span>}
                </div>
                {expandida && (
                  <div style={{ padding: '0 16px 16px' }}>
                    <DetallePropuesta p={p} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </section>

      {tab === 'pendientes' && observaciones.length > 0 && (
        <section aria-labelledby="obs" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div className="seccion-titulo">
            <h2 id="obs">En observación</h2>
            <span style={{ fontSize: 12, color: 'var(--c-muted)' }}>Detectado en el último chequeo ({hace(observaciones[0].at)}), todavía sin propuesta</span>
          </div>
          <div className="lista">
            {observaciones.map((o, i) => (
              <div key={`${o.entidad}-${i}`} className="fila" style={{ gridTemplateColumns: 'minmax(0, 1fr)' }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                  <span className="meta-linea">{o.job}</span>
                  <span style={{ fontWeight: 500 }}>{o.entidad}</span>
                  <span style={{ fontSize: 12.5, color: 'var(--c-soft)' }}>{o.motivo}</span>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

import React, { useEffect, useMemo, useState } from 'react';
import { obtenerActividadMetaAds } from '../../services/api';
import { fmtHora, fmtFecha, diaClave } from './util';

const TIPOS_ACTIVIDAD = {
  corrida: { label: 'Chequeo', clase: '' },
  pausa: { label: 'Pausa', clase: 'warn' },
  activacion: { label: 'Activación', clase: 'good' },
  escalado: { label: 'Escalado', clase: 'accent' },
  presupuesto: { label: 'Presupuesto', clase: 'accent' },
  anuncio_creado: { label: 'Anuncio creado', clase: 'good' },
  campania_creada: { label: 'Campaña creada', clase: 'good' },
  duplicado: { label: 'Duplicado', clase: 'accent' },
  audiencia_creada: { label: 'Audiencia creada', clase: 'good' },
  decision: { label: 'Decisión', clase: 'accent' },
  rechazo: { label: 'Rechazo', clase: '' },
  error: { label: 'Error', clase: 'bad' },
};

const ORIGEN = { manual: 'a mano', aprobacion: 'aprobado', cron: 'automático', historial: 'tarea vieja', pausa_escalado: 'pausa y escalado', graduacion: 'graduación', ingesta: 'ingesta', ganadores: 'ganadores caídos', auditoria: 'auditoría', reporte: 'reporte semanal', brief: 'brief creativo', mensual: 'resumen mensual', politicas: 'políticas' };

export default function ActividadView({ sinTablas, version }) {
  const [dias, setDias] = useState(7);
  const [filtro, setFiltro] = useState('cambios');
  const [items, setItems] = useState([]);
  const [cargando, setCargando] = useState(false);
  const [abierto, setAbierto] = useState(null);

  useEffect(() => {
    if (sinTablas) return;
    setCargando(true);
    obtenerActividadMetaAds(dias)
      .then(r => setItems(r.actividad || []))
      .catch(() => setItems([]))
      .finally(() => setCargando(false));
  }, [dias, version, sinTablas]);

  const grupos = useMemo(() => {
    const visibles = items.filter(a => filtro === 'todo' || (filtro === 'cambios' ? !['corrida'].includes(a.tipo) : a.tipo === 'corrida'));
    const porDia = new Map();
    for (const a of visibles) {
      const k = diaClave(a.at);
      if (!porDia.has(k)) porDia.set(k, []);
      porDia.get(k).push(a);
    }
    return [...porDia.entries()];
  }, [items, filtro]);

  return (
    <div className="cauce-body">
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div className="tabs" role="tablist" aria-label="Qué mostrar">
          {[['cambios', 'Cambios'], ['corridas', 'Chequeos'], ['todo', 'Todo']].map(([id, label]) => (
            <button key={id} type="button" role="tab" aria-selected={filtro === id} onClick={() => setFiltro(id)}>{label}</button>
          ))}
        </div>
        <div className="tabs" role="tablist" aria-label="Período">
          {[1, 7, 30].map(d => (
            <button key={d} type="button" role="tab" aria-selected={dias === d} onClick={() => setDias(d)}>{d === 1 ? 'Hoy' : `${d} días`}</button>
          ))}
        </div>
      </div>

      {grupos.length === 0 && (
        <div className="lista"><div className="vacio">{sinTablas ? 'Activá las tablas del piloto para registrar la actividad.' : cargando ? 'Cargando…' : 'Sin actividad en el período.'}</div></div>
      )}

      {grupos.map(([dia, lista]) => (
        <section key={dia} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <h2 style={{ margin: 0, fontSize: 13.5, fontWeight: 600 }}>{fmtFecha(`${dia}T15:00:00Z`, { weekday: 'long', day: 'numeric', month: 'long' })}</h2>
          <ol style={{ listStyle: 'none', margin: 0, padding: 0 }} className="lista">
            {lista.map(a => {
              const t = TIPOS_ACTIVIDAD[a.tipo] || { label: a.tipo, clase: '' };
              const tieneDetalle = a.antes || a.despues?.observaciones?.length;
              return (
                <li key={a.id}>
                  <div className="fila" style={{ gridTemplateColumns: '48px minmax(0,1fr) auto', cursor: tieneDetalle ? 'pointer' : 'default' }} onClick={() => tieneDetalle && setAbierto(abierto === a.id ? null : a.id)}>
                    <span className="num" style={{ fontSize: 12, color: 'var(--c-muted)', alignSelf: 'start', paddingTop: 2 }}>{fmtHora(a.at)}</span>
                    <span style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
                      <span style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                        <span className={`chip ${t.clase}`}>{t.label}</span>
                        <span style={{ fontWeight: 500 }}>{a.titulo}</span>
                      </span>
                      {a.detalle && <span style={{ fontSize: 12.5, color: 'var(--c-soft)', overflowWrap: 'anywhere' }}>{a.detalle}</span>}
                    </span>
                    <span style={{ fontSize: 12, color: 'var(--c-muted)', textAlign: 'right' }}>{ORIGEN[a.origen] || a.origen}{a.usuario ? <><br />{a.usuario.split('@')[0]}</> : null}</span>
                  </div>
                  {abierto === a.id && (
                    <div style={{ padding: '0 16px 14px 64px', display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12.5, color: 'var(--c-soft)' }}>
                      {a.despues?.observaciones?.map((o, i) => <span key={i}>· <b style={{ color: 'var(--c-text)', fontWeight: 500 }}>{o.entidad}</b> — {o.motivo}</span>)}
                      {a.antes && <span className="num" style={{ fontSize: 11.5 }}>Antes: {JSON.stringify(a.antes)}</span>}
                      {a.despues && !a.despues.observaciones && <span className="num" style={{ fontSize: 11.5 }}>Después: {JSON.stringify(a.despues)}</span>}
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
        </section>
      ))}
    </div>
  );
}

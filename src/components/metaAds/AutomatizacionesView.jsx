import React, { useEffect, useState } from 'react';
import { obtenerJobsMetaAds, ejecutarJobMetaAds, obtenerParametrosMetaAds, guardarParametrosMetaAds } from '../../services/api';
import { JOBS_INFO, hace } from './util';

function describirCron(cron) {
  if (!cron) return null;
  const m = /^(\d+)\s+(\d+)\s+\*\s+\*\s+\*$/.exec(cron.trim());
  return m ? `Todos los días a las ${m[2].padStart(2, '0')}:${m[1].padStart(2, '0')}` : cron;
}

export default function AutomatizacionesView({ mostrarToast, sinTablas, version, refrescarTodo }) {
  const [jobs, setJobs] = useState([]);
  const [cron, setCron] = useState(null);
  const [corriendo, setCorriendo] = useState(null);
  const [params, setParams] = useState(null);
  const [borrador, setBorrador] = useState(null);
  const [guardando, setGuardando] = useState(false);

  const cargarJobs = () => obtenerJobsMetaAds().then(r => { setJobs(r.jobs || []); setCron(r.cron); }).catch(() => {});
  useEffect(() => { cargarJobs(); }, [version]);
  useEffect(() => {
    obtenerParametrosMetaAds()
      .then(r => { setParams(r); setBorrador({ ...r.parametros }); })
      .catch(err => mostrarToast?.(`No se pudieron leer los parámetros: ${err.message}`, 'error'));
  }, [version, mostrarToast]);

  async function correr(job) {
    setCorriendo(job);
    try {
      const r = await ejecutarJobMetaAds(job);
      mostrarToast?.(`${r.resumen.nombre}: ${r.resumen.propuestas} propuestas, ${r.resumen.observaciones} en observación`, 'success');
      refrescarTodo();
    } catch (err) {
      mostrarToast?.(err.message, 'error');
      cargarJobs();
    } finally {
      setCorriendo(null);
    }
  }

  async function guardar() {
    setGuardando(true);
    try {
      const r = await guardarParametrosMetaAds(borrador);
      setParams(p => ({ ...p, parametros: r.parametros, actualizadoPor: r.actualizadoPor, actualizadoEn: r.actualizadoEn }));
      setBorrador({ ...r.parametros });
      mostrarToast?.('Parámetros guardados. Se aplican desde el próximo chequeo.', 'success');
    } catch (err) {
      mostrarToast?.(err.message, 'error');
    } finally {
      setGuardando(false);
    }
  }

  const defs = params?.definiciones || [];
  const grupos = [...new Set(defs.map(d => d.grupo))];
  const cambiado = params && borrador && defs.some(d => borrador[d.clave] !== params.parametros[d.clave]);
  const valido = borrador && defs.every(d => d.tipo === 'texto' ? String(borrador[d.clave] || '').trim() : Number.isFinite(borrador[d.clave]) && borrador[d.clave] >= 0);

  return (
    <div className="cauce-body">
      <section aria-labelledby="jobs" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div className="seccion-titulo">
          <h2 id="jobs">Chequeos</h2>
          <span style={{ fontSize: 12, color: 'var(--c-muted)' }}>{cron ? describirCron(cron) : 'Sin horario automático (META_ADS_PILOTO_CRON): se corren a mano'}</span>
        </div>
        <div className="lista">
          {jobs.map(j => {
            const info = JOBS_INFO[j.id] || {};
            const u = j.ultima;
            return (
              <div key={j.id} className="fila" style={{ alignItems: 'start' }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <span style={{ fontWeight: 600 }}>{j.nombre}</span>
                    <span className="chip">{info.reglas}</span>
                    <span className="chip accent">Sugiere · requiere aprobación</span>
                    {j.ia && <span className={`chip ${j.disponible ? 'good' : 'warn'}`}>{j.disponible ? 'Usa Claude' : 'Falta ANTHROPIC_API_KEY'}</span>}
                  </div>
                  <p style={{ fontSize: 12.5, color: 'var(--c-soft)', maxWidth: 680 }}>{info.descripcion}</p>
                  <span style={{ fontSize: 12, color: 'var(--c-muted)' }}>Reemplaza a <span className="num">{info.reemplaza}</span></span>
                  {u && (
                    <span style={{ fontSize: 12, color: u.error ? 'var(--c-bad)' : 'var(--c-soft)' }}>
                      Última corrida {hace(u.at)}: {u.error ? u.error : `${u.evaluados} evaluados · ${u.propuestas} propuestas · ${u.observaciones} en observación · ${u.protegidos} protegidos`}
                    </span>
                  )}
                </div>
                <button type="button" className="btn" onClick={() => correr(j.id)} disabled={Boolean(corriendo) || j.enCurso || sinTablas || !j.disponible}>
                  {corriendo === j.id || j.enCurso ? 'Corriendo…' : 'Ejecutar ahora'}
                </button>
              </div>
            );
          })}
        </div>
        <div className="aviso info">
          <span aria-hidden="true">ℹ</span>
          <span>Apagadas por ahora: la ingesta de creativos desde Drive y las tareas con Claude (brief creativo, resumen mensual y chequeo de políticas).</span>
        </div>
      </section>

      <section aria-labelledby="params" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div className="seccion-titulo">
          <h2 id="params">Límites y reglas</h2>
          <span style={{ fontSize: 12, color: 'var(--c-muted)' }}>
            {params?.sinTabla ? 'Valores del Rulebook (sin tabla para guardar cambios)' : params?.actualizadoPor ? `Último cambio: ${params.actualizadoPor} · ${hace(params.actualizadoEn)}` : 'Valores del Rulebook'}
          </span>
        </div>
        {!borrador && <div className="lista"><div className="vacio">Cargando…</div></div>}
        {borrador && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))', gap: 24 }}>
            {grupos.map(g => (
              <div key={g} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--c-accent)', textTransform: 'uppercase', letterSpacing: '.05em' }}>{g}</span>
                {defs.filter(d => d.grupo === g).map(d => (
                  <label key={d.clave} style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12.5 }}>
                    <span>{d.label}{d.unidad ? <span style={{ color: 'var(--c-faint)' }}> · {d.unidad}</span> : null}</span>
                    <input
                      type={d.tipo === 'texto' ? 'text' : 'number'}
                      min="0"
                      step={d.paso || 'any'}
                      value={borrador[d.clave] ?? ''}
                      onChange={e => setBorrador(b => ({ ...b, [d.clave]: d.tipo === 'texto' ? e.target.value : (e.target.value === '' ? '' : Number(e.target.value)) }))}
                      className={d.tipo === 'texto' ? '' : 'num'}
                    />
                    <span style={{ fontSize: 11.5, color: 'var(--c-faint)', lineHeight: 1.35 }}>{d.ayuda}</span>
                  </label>
                ))}
              </div>
            ))}
          </div>
        )}
        {borrador && (
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap' }}>
            <button type="button" className="btn" onClick={() => setBorrador(b => ({ ...b, ...Object.fromEntries(defs.map(d => [d.clave, d.defecto])) }))}>Volver a los del Rulebook</button>
            <button type="button" className="btn" onClick={() => setBorrador({ ...params.parametros })} disabled={!cambiado}>Descartar cambios</button>
            <button type="button" className="pri" onClick={guardar} disabled={!cambiado || !valido || guardando || params?.sinTabla}>{guardando ? 'Guardando…' : 'Guardar'}</button>
          </div>
        )}
      </section>
    </div>
  );
}

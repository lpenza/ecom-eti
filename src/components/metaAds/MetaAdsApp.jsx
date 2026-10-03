import React, { useCallback, useEffect, useRef, useState } from 'react';
import './cauce.css';
import {
  obtenerPropuestasMetaAds,
  aprobarPropuestaMetaAds,
  rechazarPropuestaMetaAds,
  ejecutarJobMetaAds,
} from '../../services/api';
import { ConfirmarAprobacion, RechazarPropuesta } from './Propuestas';
import { fmtHora } from './util';
import InicioView from './InicioView';
import RevisarView from './RevisarView';
import ActividadView from './ActividadView';
import AutomatizacionesView from './AutomatizacionesView';
import OfertasView from './OfertasView';
import ReportesView from './ReportesView';
import MetaAdsPanel from '../MetaAdsPanel';

const ICONOS = {
  inicio: <path d="M4 10.5L12 4l8 6.5V20H4z" strokeLinejoin="round" />,
  revisar: <><path d="M4 13h4l1.5 2.5h5L16 13h4" /><path d="M6 5h12l2 8v6H4v-6z" strokeLinejoin="round" /></>,
  campanias: <path d="M3 5h18M3 12h18M3 19h12" />,
  creativos: <><rect x="3" y="3" width="8" height="8" rx="2" /><rect x="13" y="3" width="8" height="8" rx="2" /><rect x="3" y="13" width="8" height="8" rx="2" /><rect x="13" y="13" width="8" height="8" rx="2" /></>,
  ofertas: <><path d="M20 13l-7 7-9-9V4h7z" strokeLinejoin="round" /><circle cx="8" cy="8" r="1.2" /></>,
  automatizaciones: <><circle cx="6" cy="6" r="2.5" /><circle cx="18" cy="18" r="2.5" /><path d="M6 8.5V13a3 3 0 0 0 3 3h6.5" /></>,
  reportes: <><path d="M4 20V10M10 20V4M16 20v-7M22 20H2" /></>,
  actividad: <><path d="M12 7v5l3 2" /><circle cx="12" cy="12" r="8.5" /></>,
};

const VISTAS = [
  { id: 'inicio', label: 'Inicio' },
  { id: 'revisar', label: 'Para revisar' },
  { id: 'campanias', label: 'Campañas' },
  { id: 'ofertas', label: 'Ofertas' },
  { id: 'automatizaciones', label: 'Automatizaciones' },
  { id: 'reportes', label: 'Reportes' },
  { id: 'actividad', label: 'Actividad' },
];

function iniciales(nombre) {
  return String(nombre || '?').split(/[\s@.]+/).filter(Boolean).slice(0, 2).map(x => x[0].toUpperCase()).join('');
}

export default function MetaAdsApp({ mostrarToast: mostrarToastApp, user }) {
  // App crea una función mostrarToast nueva en cada render (y cada toast la
  // re-renderiza). Usarla como dependencia de efectos dispara recargas en bucle
  // cuando una carga falla: se pasa a las vistas una versión estable.
  const toastRef = useRef(mostrarToastApp);
  toastRef.current = mostrarToastApp;
  const mostrarToast = useCallback((...args) => toastRef.current?.(...args), []);
  const [vista, setVista] = useState('inicio');
  const [pendientes, setPendientes] = useState([]);
  const [cargandoPendientes, setCargandoPendientes] = useState(true);
  const [sinTablas, setSinTablas] = useState(false);
  const [ultimaSync, setUltimaSync] = useState(null);
  const [aprobando, setAprobando] = useState(null);   // propuesta en el modal de aprobar
  const [rechazando, setRechazando] = useState(null); // propuesta en el modal de rechazar
  const [ocupado, setOcupado] = useState(false);
  const [chequeando, setChequeando] = useState(false);
  const [version, setVersion] = useState(0); // fuerza recargas de las vistas tras una acción

  const cargarPendientes = useCallback(async () => {
    setCargandoPendientes(true);
    try {
      const r = await obtenerPropuestasMetaAds('pendientes');
      setPendientes(r.propuestas || []);
      setSinTablas(false);
    } catch (err) {
      if (err.response?.sinTabla) setSinTablas(true);
      else mostrarToast?.(`No se pudieron leer las propuestas: ${err.message}`, 'error');
      setPendientes([]);
    } finally {
      setCargandoPendientes(false);
      setUltimaSync(new Date().toISOString());
    }
  }, [mostrarToast]);

  useEffect(() => { cargarPendientes(); }, [cargarPendientes]);

  const refrescarTodo = useCallback(() => {
    cargarPendientes();
    setVersion(v => v + 1);
  }, [cargarPendientes]);

  async function confirmarAprobacion() {
    const p = aprobando;
    setOcupado(true);
    try {
      const r = await aprobarPropuestaMetaAds(p.id);
      const final = r.propuesta;
      if (final?.estado === 'ejecutada') {
        mostrarToast?.(final.error ? `Ejecutada con aviso: ${final.error}` : `Hecho: ${p.titulo}`, final.error ? 'warning' : 'success');
      } else if (final?.estado === 'desactualizada') {
        mostrarToast?.(`No se aplicó: ${final.error}`, 'warning');
      } else {
        mostrarToast?.(`Falló: ${final?.error || 'error desconocido'}`, 'error');
      }
      setAprobando(null);
      refrescarTodo();
    } catch (err) {
      mostrarToast?.(err.message, 'error');
      setAprobando(null);
      refrescarTodo();
    } finally {
      setOcupado(false);
    }
  }

  async function confirmarRechazo(motivo) {
    const p = rechazando;
    setOcupado(true);
    try {
      await rechazarPropuestaMetaAds(p.id, motivo);
      mostrarToast?.(`Rechazada: ${p.titulo}`, 'info');
      setRechazando(null);
      refrescarTodo();
    } catch (err) {
      mostrarToast?.(err.message, 'error');
    } finally {
      setOcupado(false);
    }
  }

  // Corre los jobs de campañas (lo que antes hacían el chequeo diario y la graduación).
  async function ejecutarChequeo() {
    setChequeando(true);
    try {
      let propuestas = 0;
      for (const job of ['pausa_escalado', 'graduacion']) {
        const r = await ejecutarJobMetaAds(job);
        propuestas += r.resumen?.propuestas || 0;
      }
      mostrarToast?.(propuestas ? `Chequeo listo: ${propuestas} propuesta${propuestas === 1 ? '' : 's'} vigente${propuestas === 1 ? '' : 's'}` : 'Chequeo listo: nada para proponer', 'success');
      refrescarTodo();
    } catch (err) {
      mostrarToast?.(`El chequeo falló: ${err.message}`, 'error');
    } finally {
      setChequeando(false);
    }
  }

  // Al cambiar de vista, el contenido arranca arriba. La bandeja se relee al
  // volver a Inicio o Para revisar (un chequeo del cron puede haber agregado algo).
  function irA(v) {
    setVista(v);
    if (v === 'inicio' || v === 'revisar') cargarPendientes();
    document.querySelector('.app-main')?.scrollTo?.({ top: 0 });
  }

  const comunes = {
    mostrarToast, pendientes, cargandoPendientes, sinTablas, version, irA,
    onAprobar: setAprobando, onRechazar: setRechazando, onEjecutarChequeo: ejecutarChequeo, chequeando, refrescarTodo,
  };
  const titulo = VISTAS.find(v => v.id === vista)?.label;

  return (
    <div className="cauce">
      <div className="cauce-grid">
        <aside className="cauce-side" aria-label="Meta Ads">
          <div className="cauce-brand">
            <span className="cauce-brand-logo" aria-hidden="true">V</span>
            <span style={{ flexGrow: 1, fontWeight: 600, fontSize: 13.5 }}>Velinne</span>
            <span style={{ fontSize: 11.5, color: 'var(--c-faint)' }}>Meta Ads</span>
          </div>
          <nav className="cauce-nav" aria-label="Secciones de Meta Ads">
            {VISTAS.map(v => (
              <a
                key={v.id}
                href={`#${v.id}`}
                onClick={e => { e.preventDefault(); if (!v.proximamente) irA(v.id); }}
                aria-current={vista === v.id ? 'page' : undefined}
                aria-disabled={v.proximamente ? 'true' : undefined}
                title={v.proximamente ? 'Fase 2: ingesta de tandas SICH desde Drive' : undefined}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">{ICONOS[v.id]}</svg>
                <span style={{ flexGrow: 1 }}>{v.label}</span>
                {v.id === 'revisar' && pendientes.length > 0 && <span className="num cauce-count">{pendientes.length}</span>}
                {v.proximamente && <span style={{ fontSize: 10.5, color: 'var(--c-faint)' }}>pronto</span>}
              </a>
            ))}
          </nav>
          <div className="cauce-relleno" style={{ flexGrow: 1 }} />
          <div className="cauce-autonomia">
            <span style={{ fontSize: 12, color: 'var(--c-soft)' }}>Autonomía</span>
            <span style={{ fontSize: 13, fontWeight: 500 }}>Sugerir: todo cambio de inversión pide aprobación</span>
            <a onClick={() => irA('automatizaciones')} style={{ fontSize: 12, color: 'var(--c-accent)', fontWeight: 500 }}>Configurar límites</a>
          </div>
          <div className="cauce-usuario">
            <span style={{ width: 22, height: 22, borderRadius: 11, background: '#2A2D36', fontSize: 10, fontWeight: 600, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{iniciales(user?.nombre || user?.email)}</span>
            <span style={{ fontSize: 13, flexGrow: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{user?.nombre || user?.email}</span>
            {ultimaSync && (
              <span style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11.5, color: 'var(--c-soft)' }} title="Última lectura de la bandeja">
                <span style={{ width: 6, height: 6, borderRadius: 3, background: 'var(--c-accent)' }} />Meta {fmtHora(ultimaSync)}
              </span>
            )}
          </div>
        </aside>

        <div className="cauce-main-wrap">
          <main className="cauce-main">
            <header className="cauce-header">
              <span style={{ fontSize: 13, fontWeight: 500 }}>{titulo}</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                {vista !== 'campanias' && <span className="btn" style={{ cursor: 'default' }}>Últimos 7 días</span>}
                <button type="button" className="pri" onClick={ejecutarChequeo} disabled={chequeando || sinTablas} title="Corre pausa/escalado y graduación ahora. Sólo genera propuestas.">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5" /></svg>
                  {chequeando ? 'Chequeando…' : 'Ejecutar chequeo'}
                </button>
              </div>
            </header>

            {sinTablas && vista !== 'campanias' && (
              <div style={{ padding: '16px 20px 0' }}>
                <div className="aviso">
                  <span aria-hidden="true">⚠</span>
                  <span>Faltan las tablas del piloto en Supabase. Corré <b>sql/create_meta_ads_piloto.sql</b> en el editor SQL para activar la bandeja, la actividad y los parámetros. Mientras tanto, Inicio y Campañas funcionan en modo lectura.</span>
                </div>
              </div>
            )}

            {vista === 'inicio' && <InicioView {...comunes} />}
            {vista === 'revisar' && <RevisarView {...comunes} />}
            {vista === 'campanias' && <div className="cauce-body wide" style={{ padding: 0 }}><MetaAdsPanel mostrarToast={mostrarToast} embebido /></div>}
            {vista === 'ofertas' && <OfertasView {...comunes} />}
            {vista === 'automatizaciones' && <AutomatizacionesView {...comunes} />}
            {vista === 'reportes' && <ReportesView {...comunes} />}
          {vista === 'actividad' && <ActividadView {...comunes} />}
          </main>
        </div>
      </div>

      {aprobando && <ConfirmarAprobacion p={aprobando} moneda="UYU" ocupado={ocupado} onConfirmar={confirmarAprobacion} onCerrar={() => setAprobando(null)} />}
      {rechazando && <RechazarPropuesta p={rechazando} ocupado={ocupado} onConfirmar={confirmarRechazo} onCerrar={() => setRechazando(null)} />}
    </div>
  );
}

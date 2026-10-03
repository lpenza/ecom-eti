import React, { useCallback, useEffect, useState } from 'react';
import { obtenerTandasMetaAds, asignarCreativoMetaAds, obtenerMiniaturaCreativo, ejecutarJobMetaAds } from '../../services/api';
import { fmtNum, fmtFecha, ESTADOS_ENTIDAD } from './util';

// Pantalla "Creativos": tandas SICH de Drive cruzadas con Meta (reemplaza a la
// tarea velinne-ads-creative-ingest y a la sección "Ingesta" del dashboard viejo).

const ESTADO_ITEM = {
  creado: { label: 'Ad set creado', clase: 'good' },
  listo: { label: 'Listo para crear', clase: 'accent' },
  sin_campania: { label: 'Falta campaña de testeo', clase: 'warn' },
  sin_veln: { label: 'Sin VELn', clase: 'bad' },
  sin_angulo: { label: 'Sin ángulo', clase: 'warn' },
};

const BANDA = {
  verde: { titulo: 'Banda verde', clase: 'good', texto: (g) => `Los ad sets nuevos arrancan activos a $${fmtNum(g.presupuesto)}/día.` },
  amarilla: { titulo: 'Banda amarilla', clase: 'warn', texto: (g) => `Los ad sets nuevos arrancan con presupuesto reducido: $${fmtNum(g.presupuesto)}/día.` },
  roja: { titulo: 'Banda roja', clase: 'bad', texto: () => 'Los ad sets nuevos se crean pausados: los activás vos cuando la cuenta mejore.' },
};

// Miniatura de Drive (se pide con el token y se muestra como blob).
function Miniatura({ fileId, tipo }) {
  const [url, setUrl] = useState(null);
  useEffect(() => {
    let vivo = true;
    let objeto = null;
    obtenerMiniaturaCreativo(fileId)
      .then(b => { if (b && vivo) { objeto = URL.createObjectURL(b); setUrl(objeto); } })
      .catch(() => {});
    return () => { vivo = false; if (objeto) URL.revokeObjectURL(objeto); };
  }, [fileId]);
  return (
    <div className="crea-img" style={{ backgroundImage: url ? `url("${url}")` : undefined }}>
      {!url && <span style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--c-faint)', fontSize: 11 }}>{tipo === 'video' ? 'video' : 'imagen'}</span>}
      {tipo === 'video' && <span className="crea-fmt">video</span>}
    </div>
  );
}

// Para archivos sueltos sin ángulo o sin VELn: lo completa una persona (Rulebook §6.1).
function Asignar({ item, onGuardado, mostrarToast }) {
  const [angulo, setAngulo] = useState(item.angulo || '');
  const [veln, setVeln] = useState(item.veln || '');
  const [guardando, setGuardando] = useState(false);
  async function guardar() {
    setGuardando(true);
    try {
      await asignarCreativoMetaAds(item.fileId, { angulo: angulo.trim(), veln: veln.trim() });
      onGuardado();
    } catch (err) {
      mostrarToast?.(err.message, 'error');
    } finally {
      setGuardando(false);
    }
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {item.estado === 'sin_veln' && <input value={veln} onChange={e => setVeln(e.target.value.toUpperCase())} placeholder="VEL412" aria-label={`VELn de ${item.archivo}`} className="num" />}
      {(item.estado === 'sin_angulo' || !item.angulo) && <input value={angulo} onChange={e => setAngulo(e.target.value)} placeholder="Ángulo (ej. Promo directa)" aria-label={`Ángulo de ${item.archivo}`} />}
      <button type="button" className="btn btn-sm" onClick={guardar} disabled={guardando || (item.estado === 'sin_veln' ? !veln : !angulo.trim())}>{guardando ? 'Guardando…' : 'Guardar'}</button>
    </div>
  );
}

function TarjetaCreativo({ item, onGuardado, mostrarToast }) {
  const e = ESTADO_ITEM[item.estado];
  const ent = item.anuncio && (ESTADOS_ENTIDAD[item.anuncio.estadoEfectivo] || { label: item.anuncio.estadoEfectivo, clase: '' });
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>
      <Miniatura fileId={item.fileId} tipo={item.tipo} />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 6 }}>
        <span className="num" style={{ fontSize: 12.5, fontWeight: 500 }}>{item.veln || item.archivo}</span>
        {item.angulo && <span style={{ fontSize: 12, color: 'var(--c-soft)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={item.angulo}>{item.angulo}</span>}
      </div>
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
        <span className={`chip ${e.clase}`}>{e.label}</span>
        {ent && <span className={`chip ${ent.clase}`}>{ent.label}</span>}
      </div>
      {item.anuncio && !item.anuncio.enTesteo && <span style={{ fontSize: 11.5, color: 'var(--c-muted)' }}>En "{item.anuncio.campaniaNombre}"</span>}
      {(item.velnAsignado || item.anguloAsignado) && <span style={{ fontSize: 11.5, color: 'var(--c-muted)' }}>Dato asignado a mano</span>}
      {(item.estado === 'sin_veln' || item.estado === 'sin_angulo') && <Asignar item={item} onGuardado={onGuardado} mostrarToast={mostrarToast} />}
    </div>
  );
}

export default function CreativosView({ mostrarToast, version, irA, pendientes, refrescarTodo }) {
  const [datos, setDatos] = useState(null);
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState(null);
  const [buscando, setBuscando] = useState(false);

  const cargar = useCallback(async (fresco = false) => {
    setCargando(true);
    setError(null);
    try {
      setDatos(await obtenerTandasMetaAds(fresco));
    } catch (err) {
      setError(err.message);
    } finally {
      setCargando(false);
    }
  }, []);

  useEffect(() => { cargar(); }, [cargar, version]);

  async function buscarNuevos() {
    setBuscando(true);
    try {
      const r = await ejecutarJobMetaAds('ingesta');
      const n = r.resumen?.propuestas || 0;
      mostrarToast?.(n ? `${n} tanda${n === 1 ? '' : 's'} lista${n === 1 ? '' : 's'} para aprobar en Para revisar` : 'No hay creativos nuevos para crear', n ? 'success' : 'info');
      refrescarTodo();
      await cargar(true);
    } catch (err) {
      mostrarToast?.(err.message, 'error');
    } finally {
      setBuscando(false);
    }
  }

  const g = datos?.gate;
  const banda = g && BANDA[g.banda];
  const enBandeja = pendientes.filter(p => p.tipo === 'ingesta_tanda');
  const ejecutando = (datos?.propuestas || []).filter(p => p.estado === 'aprobada');
  const vacias = (datos?.tandas || []).filter(t => !t.items.length);
  const conArchivos = (datos?.tandas || []).filter(t => t.items.length);

  return (
    <div className="cauce-body">
      <section className="estado-cuenta" aria-label="Gate de testeo">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12.5, color: 'var(--c-soft)' }}>
            <span className="dot" />Próximo arranque de testeo: {datos ? fmtFecha(datos.inicioProximo, { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }) : '…'}
          </span>
          <h1 style={{ margin: 0, fontSize: 24, fontWeight: 600, letterSpacing: '-0.03em', lineHeight: 1.25 }}>
            {banda ? <>Gate de testeo en {banda.titulo.toLowerCase()}.<br /><span style={{ color: 'var(--c-muted)' }}>{banda.texto(g)}</span></> : 'Leyendo Drive y Meta…'}
          </h1>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'flex-end' }}>
          {g && (
            <div className="num" style={{ fontSize: 12.5, color: 'var(--c-soft)', textAlign: 'right' }}>
              CPA de cuenta 7 días <span style={{ color: 'var(--c-text)', fontSize: 18, fontWeight: 500 }}>{fmtNum(g.cpa)}</span>
              <br />objetivo {fmtNum(g.objetivo)} · máximo {fmtNum(g.maximo)} <span className={`chip ${banda.clase}`} style={{ marginLeft: 6 }}>{banda.titulo}</span>
            </div>
          )}
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" className="btn" onClick={() => cargar(true)} disabled={cargando}>{cargando ? 'Leyendo…' : 'Actualizar'}</button>
            <button type="button" className="pri" onClick={buscarNuevos} disabled={buscando}>{buscando ? 'Buscando…' : 'Buscar creativos nuevos'}</button>
          </div>
        </div>
      </section>

      {error && <div className="aviso bad"><span aria-hidden="true">⚠</span><span>{error}</span></div>}
      {enBandeja.length > 0 && (
        <div className="aviso info" style={{ alignItems: 'center' }}>
          <span aria-hidden="true">ℹ</span>
          <span style={{ flexGrow: 1 }}>{enBandeja.map(p => p.titulo).join(' · ')}: esperando aprobación.</span>
          <button type="button" className="btn btn-sm" onClick={() => irA('revisar')}>Revisar</button>
        </div>
      )}
      {ejecutando.length > 0 && (
        <div className="aviso info"><span aria-hidden="true">⏳</span><span>Creando en Meta: {ejecutando.map(p => p.titulo).join(' · ')}. Los videos tardan unos minutos en procesarse.</span></div>
      )}

      {vacias.length > 0 && (
        <div className="lista">
          <div className="vacio" style={{ textAlign: 'left' }}>
            {vacias.length === 1 ? `Tanda ${vacias[0].sich}` : `Tandas ${vacias.map(t => t.sich).join(', ')}`}: sólo hipótesis, todavía sin imágenes ni videos en Drive.
          </div>
        </div>
      )}

      {conArchivos.map(t => {
        const total = t.items.length;
        const creados = t.conteo.creado || 0;
        const necesitanDato = (t.conteo.sin_veln || 0) + (t.conteo.sin_angulo || 0);
        return (
          <section key={t.sich} aria-labelledby={`tanda-${t.sich}`} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div className="seccion-titulo" style={{ flexWrap: 'wrap' }}>
              <h2 id={`tanda-${t.sich}`}>Tanda {t.sich}</h2>
              <div className="meta-linea" style={{ justifyContent: 'flex-end' }}>
                {total > 0 && <span className="num">{creados} de {total} creados</span>}
                {necesitanDato > 0 && <span style={{ color: 'var(--c-warn)' }}>· {necesitanDato} {necesitanDato === 1 ? 'archivo necesita' : 'archivos necesitan'} un dato</span>}
                {t.campania
                  ? <span className={`chip ${ESTADOS_ENTIDAD[t.campania.estadoEfectivo]?.clase || ''}`} title={t.campania.nombre}>{t.campania.nombre}</span>
                  : total > creados && <span className="chip warn">Falta crear "TESTEO - SICH {t.sich}"</span>}
              </div>
            </div>
            <div className="crea">{t.items.map(i => <TarjetaCreativo key={i.fileId} item={i} mostrarToast={mostrarToast} onGuardado={() => cargar(true)} />)}</div>
          </section>
        );
      })}

      {!datos && !error && <div className="lista"><div className="vacio">Leyendo las carpetas SICH de Drive…</div></div>}
    </div>
  );
}

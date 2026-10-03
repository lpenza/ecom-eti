import React, { useCallback, useEffect, useState } from 'react';
import { obtenerReportesMetaAds, ejecutarJobMetaAds, obtenerJobsMetaAds } from '../../services/api';
import Markdown from './Markdown';
import { fmtNum, fmtPlata, fmtFecha, hace, TIPOS } from './util';

// Reportes del piloto (Fase 3). Reemplazan la parte numérica de
// velinne-ads-weekly-digest, velinne-ads-decision-audit y velinne-winner-decline-audit.

const PESTANIAS = [
  { id: 'reporte', label: 'Semanal' },
  { id: 'auditoria', label: 'Auditoría de decisiones' },
  { id: 'ganadores', label: 'Ganadores caídos' },
  // Brief creativo, Mensual y Políticas (con Claude) están apagados por ahora.
];

// Costo aproximado de una corrida con Claude (Opus 5.5: US$4 / US$20 por millón
// de tokens; búsqueda web US$10 cada mil búsquedas).
function costoUsd(uso) {
  if (!uso) return null;
  return (uso.entrada * 4 + uso.salida * 20) / 1e6 + (uso.busquedas || 0) * 0.01;
}

function PieIA({ r }) {
  const costo = costoUsd(r.uso);
  return (
    <>
      {r.fuentes?.length > 0 && (
        <Seccion titulo="Fuentes consultadas">
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12.5 }}>
            {r.fuentes.slice(0, 20).map(f => <li key={f.url}><a href={f.url} target="_blank" rel="noreferrer" style={{ color: 'var(--c-accent)' }}>{f.titulo}</a></li>)}
          </ul>
        </Seccion>
      )}
      <p style={{ fontSize: 11.5, color: 'var(--c-faint)' }}>
        Redactado por {r.modelo || 'Claude'}{r.uso ? ` · ${fmtNum(r.uso.entrada)} tokens de entrada, ${fmtNum(r.uso.salida)} de salida, ${r.uso.busquedas || 0} búsquedas web` : ''}{costo != null ? ` · ≈ US$${costo.toFixed(2)}` : ''}. Es un borrador asistido: revisá las cifras antes de actuar.
      </p>
    </>
  );
}

function Brief({ r, mostrarToast }) {
  async function copiar() {
    try {
      await navigator.clipboard.writeText(r.brief_editor);
      mostrarToast?.('Brief copiado: listo para mandarle al editor', 'success');
    } catch {
      mostrarToast?.('No se pudo copiar automáticamente: seleccioná el texto a mano', 'warning');
    }
  }
  return (
    <>
      <Seccion titulo="Brief para el editor" extra={<button type="button" className="btn btn-sm" onClick={copiar}>Copiar</button>}>
        <div style={{ padding: '14px 16px', borderRadius: 10, border: '1px solid var(--c-border)', background: 'var(--c-bg)' }}><Markdown texto={r.brief_editor} /></div>
        <p style={{ fontSize: 12, color: 'var(--c-muted)', marginTop: -4 }}>Sin CPA, ROAS ni presupuestos: se puede reenviar tal cual.</p>
      </Seccion>
      <Seccion titulo="Análisis por ángulo"><Markdown texto={r.resumen} /></Seccion>
      {(r.angulos_confirmados?.length > 0 || r.ideas_especulativas?.length > 0) && (
        <Seccion titulo={`Para la SICH ${r.proximaSich}`}>
          <div className="lista">
            {r.angulos_confirmados.map(a => (
              <div key={a.angulo} className="fila" style={{ alignItems: 'start' }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
                  <span style={{ fontWeight: 500 }}>A. {a.angulo.toUpperCase()}</span>
                  <span style={{ fontSize: 12.5 }}>{a.hipotesis}</span>
                  <span style={{ fontSize: 12, color: 'var(--c-soft)' }}>{a.razon}</span>
                </div>
                <span className="chip good">✅ Confirmada por datos</span>
              </div>
            ))}
            {r.ideas_especulativas.map(a => (
              <div key={a.angulo} className="fila" style={{ alignItems: 'start' }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
                  <span style={{ fontWeight: 500 }}>A. {a.angulo.toUpperCase()}</span>
                  <span style={{ fontSize: 12.5 }}>{a.hipotesis}</span>
                  <span style={{ fontSize: 12, color: 'var(--c-soft)' }}>Fuente: {a.fuente}</span>
                </div>
                <span className="chip warn">🧪 Especulativa</span>
              </div>
            ))}
          </div>
        </Seccion>
      )}
      <PieIA r={r} />
    </>
  );
}

function Mensual({ r }) {
  return (
    <>
      <Seccion titulo={`Resumen de ${r.mes}`}><Markdown texto={r.resumen} /></Seccion>
      <PieIA r={r} />
    </>
  );
}

function Politicas({ r }) {
  return (
    <>
      <Seccion titulo={`Novedades de Meta desde el ${fmtFecha(`${r.desde}T15:00:00Z`)}`}><Markdown texto={r.resumen} /></Seccion>
      {r.novedades?.length > 0 && (
        <div className="lista">
          {r.novedades.map(n => (
            <div key={n.titulo} className="fila" style={{ alignItems: 'start' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
                <span className="meta-linea">{n.fecha}{n.fuente ? <> · <a href={n.fuente} target="_blank" rel="noreferrer" style={{ color: 'var(--c-accent)' }}>fuente</a></> : null}</span>
                <span style={{ fontWeight: 500 }}>{n.titulo}</span>
                <span style={{ fontSize: 12.5, color: 'var(--c-soft)' }}>{n.impacto}</span>
                {n.afecta_regla && <span style={{ fontSize: 12.5 }}>→ {n.regla}: {n.enmienda}</span>}
              </div>
              <span className={`chip ${n.afecta_regla ? 'warn' : ''}`}>{n.afecta_regla ? 'Afecta una regla' : 'Informativa'}</span>
            </div>
          ))}
        </div>
      )}
      <PieIA r={r} />
    </>
  );
}

const CLASIF = {
  acertada: { label: '✅ Acertada', clase: 'good' },
  cuestionable: { label: '⚠️ Cuestionable', clase: 'warn' },
  contraproducente: { label: '❌ Contraproducente', clase: 'bad' },
};
const ESTADO_CASO = {
  resuelta: { label: 'Causa resuelta', clase: 'good' },
  esperando: { label: 'Esperando resolución', clase: 'warn' },
  ambigua: { label: 'Causa ambigua', clase: '' },
};

function Variacion({ v, invertir = false, dec = 0 }) {
  if (v == null || !Number.isFinite(v)) return <span style={{ color: 'var(--c-faint)' }}>—</span>;
  const bueno = invertir ? v < 0 : v > 0;
  const color = Math.abs(v) < 3 ? 'var(--c-muted)' : bueno ? 'var(--c-good)' : 'var(--c-bad)';
  return <span className="num" style={{ color }}>{v > 0 ? '+' : ''}{fmtNum(v, dec)}%</span>;
}

function Seccion({ titulo, extra, children }) {
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div className="seccion-titulo"><h2>{titulo}</h2>{extra}</div>
      {children}
    </section>
  );
}

function Tile({ label, valor, variacion, invertir }) {
  return (
    <div style={{ padding: '10px 12px', borderRadius: 8, border: '1px solid var(--c-border)', display: 'flex', flexDirection: 'column', gap: 2 }}>
      <span style={{ fontSize: 11.5, color: 'var(--c-muted)' }}>{label}</span>
      <span className="num" style={{ fontSize: 18, fontWeight: 500 }}>{valor}</span>
      {variacion !== undefined && <span style={{ fontSize: 11.5 }}><Variacion v={variacion} invertir={invertir} /> <span style={{ color: 'var(--c-faint)' }}>vs semana anterior</span></span>}
    </div>
  );
}

const grilla = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 10 };

function ReporteSemanal({ r, irA }) {
  const pf = r.performance;
  const v = pf?.variaciones || {};
  return (
    <>
      <Seccion titulo="Pendiente de tu decisión" extra={<a onClick={() => irA('revisar')}>Abrir bandeja</a>}>
        <div className="lista">
          {r.pendientes?.total ? (
            <div className="fila" style={{ gridTemplateColumns: '1fr' }}>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {Object.entries(r.pendientes.porTipo).map(([t, n]) => <span key={t} className="chip accent">{n} · {TIPOS[t]?.label || t}</span>)}
              </div>
              {r.pendientes.masViejas?.map(x => <span key={x.titulo} style={{ fontSize: 12.5, color: 'var(--c-bad)' }}>🔴 {x.titulo} · espera {x.dias} días</span>)}
            </div>
          ) : <div className="vacio">Nada pendiente al generar el reporte.</div>}
        </div>
      </Seccion>

      <Seccion titulo="Pixel / CAPI">
        {r.pixel ? (
          <>
            {r.pixel.alertas.length > 0
              ? r.pixel.alertas.map(e => <div key={e.evento} className="aviso bad"><span>⚠</span><span>{e.evento} cayó {fmtNum(-e.variacion)}% semana contra semana ({fmtNum(e.previa)} → {fmtNum(e.actual)})</span></div>)
              : <div className="aviso info"><span>✓</span><span>Sin alertas: ningún evento cayó más de 20%.</span></div>}
            <div style={grilla}>{r.pixel.eventos.map(e => <Tile key={e.evento} label={e.evento} valor={fmtNum(e.actual)} variacion={e.variacion} />)}</div>
          </>
        ) : <div className="aviso">No se pudo leer el pixel: {r.errores?.pixel}</div>}
      </Seccion>

      <Seccion titulo="Performance de la semana" extra={<span style={{ fontSize: 12, color: 'var(--c-muted)' }}>{fmtFecha(`${r.ventana.actual.since}T15:00:00Z`)} – {fmtFecha(`${r.ventana.actual.until}T15:00:00Z`)}</span>}>
        <div style={grilla}>
          <Tile label="Gasto" valor={fmtPlata(pf.actual?.gasto)} variacion={v.gasto} />
          <Tile label="Compras" valor={fmtNum(pf.actual?.compras)} variacion={v.compras} />
          <Tile label="CPA" valor={fmtPlata(pf.actual?.cpa)} variacion={v.cpa} invertir />
          <Tile label="ROAS" valor={fmtNum(pf.actual?.roas, 2)} variacion={v.roas} />
          <Tile label="CPM" valor={fmtPlata(pf.actual?.cpm)} variacion={v.cpm} invertir />
          <Tile label="CTR" valor={`${fmtNum(pf.actual?.ctr, 2)}%`} variacion={v.ctr} />
        </div>
        {pf.fueraDeRango?.length > 0 && (
          <div className="lista">
            {pf.fueraDeRango.map(c => (
              <div key={c.campania} className="fila">
                <div style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
                  <span style={{ fontWeight: 500 }}>{c.campania}</span>
                  <span style={{ fontSize: 12.5, color: 'var(--c-warn)' }}>{c.motivos.join(' · ')}</span>
                </div>
                <span className="num" style={{ color: 'var(--c-muted)' }}>{fmtPlata(c.gasto)}</span>
              </div>
            ))}
          </div>
        )}
      </Seccion>

      <Seccion titulo="Funnel de Shopify">
        {r.funnel ? (
          <>
            <div style={grilla}>
              {r.funnel.etapas.map(e => (
                <div key={e.clave} style={{ padding: '10px 12px', borderRadius: 8, border: `1px solid ${r.funnel.peor?.clave === e.clave ? 'var(--c-warn)' : 'var(--c-border)'}` }}>
                  <div style={{ fontSize: 11.5, color: 'var(--c-muted)' }}>{e.label}{r.funnel.peor?.clave === e.clave ? ' · peor etapa' : ''}</div>
                  <div className="num" style={{ fontSize: 18, fontWeight: 500 }}>{fmtNum(e.actual, 2)}%</div>
                  <div style={{ fontSize: 11.5 }}><Variacion v={e.variacion} /></div>
                </div>
              ))}
            </div>
            {r.funnel.bajoPiso && <div className="aviso bad"><span>⚠</span><span>La conversión del sitio está bajo el piso configurado.</span></div>}
            {r.funnel.dispositivos?.length > 0 && (
              <p style={{ fontSize: 12.5, color: 'var(--c-soft)' }}>
                {r.funnel.dispositivos.filter(d => d.sesiones > 20).map(d => `${d.tipo}: ${fmtNum(d.sesiones)} sesiones, ${fmtNum(d.conversion, 2)}% conversión`).join(' · ')}
              </p>
            )}
          </>
        ) : <div className="aviso">No se pudo leer Shopify: {r.errores?.funnel}</div>}
      </Seccion>

      <Seccion titulo="Variantes core e inventario">
        {r.inventario ? (
          <div className="lista" style={{ overflowX: 'auto' }}>
            <table className="tabla">
              <thead><tr><th style={{ textAlign: 'left' }}>Variante</th><th>Ventas 90 días</th><th>Órdenes</th><th>Stock</th><th style={{ textAlign: 'left' }}>Estado</th></tr></thead>
              <tbody>
                {r.inventario.core.map(c => (
                  <tr key={c.variante}>
                    <td style={{ textAlign: 'left' }}>{c.variante}</td>
                    <td className="num">{fmtPlata(c.ventas)}</td>
                    <td className="num">{fmtNum(c.ordenes)}</td>
                    <td className="num">{c.stock ?? '—'}</td>
                    <td style={{ textAlign: 'left' }}><span className={`chip ${c.estado === 'agotada' ? 'bad' : c.estado === 'bajo' ? 'warn' : c.estado === 'ok' ? 'good' : ''}`}>{c.estado === 'agotada' ? 'Agotada' : c.estado === 'bajo' ? 'Stock bajo' : c.estado === 'ok' ? 'OK' : 'Sin dato'}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <div className="aviso">No se pudo leer el inventario: {r.errores?.inventario}</div>}
      </Seccion>

      <Seccion titulo="Audiencias">
        {r.audiencias ? (
          <>
            {r.audiencias.propuestas.length > 0
              ? <div className="aviso info"><span>ℹ</span><span>Lookalike propuesto sobre: {r.audiencias.propuestas.map(s => `"${s.nombre}" (~${fmtNum(s.tamanio)})`).join(', ')}. Está en la bandeja para aprobar.</span></div>
              : <p style={{ fontSize: 12.5, color: 'var(--c-soft)' }}>Sin lookalikes nuevos para proponer.</p>}
            {r.audiencias.congeladas.length > 0 && (
              <div className="aviso"><span>⚠</span><span>Audiencias de pixel que no crecen (~{fmtNum(r.audiencias.congeladas[0].tamanio)} personas): {r.audiencias.congeladas.map(c => c.nombre).join(', ')}. Conviene recrearlas antes de usarlas como base.</span></div>
            )}
          </>
        ) : <div className="aviso">No se pudieron leer las audiencias: {r.errores?.audiencias}</div>}
      </Seccion>

      <Seccion titulo="Testeo de creativos" extra={r.testeo?.costoCarritoBroad ? <span style={{ fontSize: 12, color: 'var(--c-muted)' }}>Costo por carrito BROAD: {fmtPlata(r.testeo.costoCarritoBroad)}</span> : null}>
        {r.testeo?.senales?.length ? (
          <div className="lista">
            {r.testeo.senales.map(s => (
              <div key={s.conjunto} className="fila">
                <div style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
                  <span style={{ fontWeight: 500 }}>{s.conjunto}</span>
                  <span style={{ fontSize: 12.5, color: 'var(--c-soft)' }}>{s.campania} · CTR {fmtNum(s.ctr, 2)}% · {s.compras} compras{s.cpa ? ` · CPA ${fmtNum(s.cpa)}` : ''}{s.costoCarrito ? ` · carrito a ${fmtPlata(s.costoCarrito)}` : ''}</span>
                </div>
                <span className={`chip ${s.confirmado ? 'good' : 'accent'}`}>{s.confirmado ? '🏆 Candidato confirmado' : '🟢 Señal temprana'}</span>
              </div>
            ))}
          </div>
        ) : <p style={{ fontSize: 12.5, color: 'var(--c-soft)' }}>Sin candidatos ni señales tempranas esta semana.</p>}
      </Seccion>

      {r.auditoria && (
        <Seccion titulo="Auditoría de decisiones" extra={<span style={{ fontSize: 12, color: 'var(--c-muted)' }}>{fmtFecha(r.auditoria.fecha)}</span>}>
          {r.auditoria.patrones.map(pat => <div key={pat.tipo} className="aviso"><span>⚠</span><span>Patrón: {pat.tipo} salió mal {pat.veces} veces — candidato a ajuste de regla.</span></div>)}
          {r.auditoria.cuestionables.length === 0 && r.auditoria.patrones.length === 0 && <p style={{ fontSize: 12.5, color: 'var(--c-soft)' }}>Todas las decisiones auditadas salieron acertadas.</p>}
          {r.auditoria.cuestionables.map(x => <p key={x.actividadId} style={{ fontSize: 12.5, color: 'var(--c-soft)' }}>{x.etiqueta} · {x.entidad}: {x.razon}</p>)}
        </Seccion>
      )}

      <Seccion titulo="Acciones de la semana">
        {r.acciones?.length ? (
          <div className="lista">
            {r.acciones.map((a, i) => (
              <div key={i} className="fila" style={{ gridTemplateColumns: '90px minmax(0,1fr)' }}>
                <span className="num" style={{ fontSize: 12, color: 'var(--c-muted)' }}>{fmtFecha(a.at, { day: 'numeric', month: 'short' })}</span>
                <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                  <span style={{ fontWeight: 500 }}>{a.titulo}</span>
                  {a.detalle && <span style={{ fontSize: 12, color: 'var(--c-soft)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.detalle}</span>}
                </span>
              </div>
            ))}
          </div>
        ) : <p style={{ fontSize: 12.5, color: 'var(--c-soft)' }}>No hubo pausas ni escalados esta semana.</p>}
      </Seccion>

      <Seccion titulo="Elasticidad de escalado" extra={r.elasticidad?.promedioVariacionCpa != null ? <span style={{ fontSize: 12, color: 'var(--c-muted)' }}>CPA promedio tras escalar: <Variacion v={r.elasticidad.promedioVariacionCpa} invertir /></span> : null}>
        {r.elasticidad?.casos?.length ? (
          <div className="lista" style={{ overflowX: 'auto' }}>
            <table className="tabla">
              <thead><tr><th style={{ textAlign: 'left' }}>Entidad</th><th>Fecha</th><th>Presupuesto</th><th>CPA antes</th><th>CPA después</th><th>Variación</th></tr></thead>
              <tbody>
                {r.elasticidad.casos.map((c, i) => (
                  <tr key={i}>
                    <td style={{ textAlign: 'left' }}>{c.entidad}</td>
                    <td className="num">{fmtFecha(`${c.fecha}T15:00:00Z`)}</td>
                    <td className="num">{c.subaPresupuesto != null ? `+${fmtNum(c.subaPresupuesto)}%` : '—'}</td>
                    <td className="num">{fmtNum(c.cpaAntes)}</td>
                    <td className="num">{fmtNum(c.cpaDespues)}</td>
                    <td><Variacion v={c.variacionCpa} invertir /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <p style={{ fontSize: 12.5, color: 'var(--c-soft)' }}>Sin escalados con datos suficientes.</p>}
        {r.elasticidad?.fueraDeLimite > 0 && <p style={{ fontSize: 12.5, color: 'var(--c-warn)' }}>{r.elasticidad.fueraDeLimite} de {r.elasticidad.casos.length} escalados subieron el CPA más que la elasticidad aceptable: revisá el parámetro en Automatizaciones.</p>}
      </Seccion>
    </>
  );
}

function Auditoria({ r }) {
  return (
    <>
      {r.patrones?.map(pat => <div key={pat.tipo} className="aviso"><span>⚠</span><span>Patrón detectado: {pat.tipo} salió cuestionable o contraproducente {pat.veces} veces (sumando auditorías anteriores). Candidato a ajustar la regla.</span></div>)}
      <div className="lista" style={{ overflowX: 'auto' }}>
        {r.resultados?.length ? (
          <table className="tabla">
            <thead><tr><th style={{ textAlign: 'left' }}>Fecha</th><th style={{ textAlign: 'left' }}>Decisión</th><th style={{ textAlign: 'left' }}>Clasificación</th><th style={{ textAlign: 'left' }}>Por qué</th></tr></thead>
            <tbody>
              {r.resultados.map(x => (
                <tr key={x.actividadId}>
                  <td className="num" style={{ textAlign: 'left' }}>{fmtFecha(`${x.fecha}T15:00:00Z`)}</td>
                  <td style={{ textAlign: 'left', whiteSpace: 'normal' }}>
                    <div style={{ fontWeight: 500 }}>{x.accion === 'pausa' ? 'Pausa' : 'Escalado'} · {x.entidad}</div>
                    <div style={{ fontSize: 11.5, color: 'var(--c-muted)' }}>{x.campania} · {x.segmento}{x.origen === 'historial' ? ' · tarea vieja' : ''}</div>
                  </td>
                  <td style={{ textAlign: 'left' }}><span className={`chip ${CLASIF[x.clasificacion]?.clase || ''}`}>{CLASIF[x.clasificacion]?.label || x.clasificacion}</span></td>
                  <td style={{ textAlign: 'left', whiteSpace: 'normal', color: 'var(--c-soft)', minWidth: 260 }}>{x.razon}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <div className="vacio">No había decisiones de 7 a 21 días atrás sin auditar.</div>}
      </div>
      <p style={{ fontSize: 12, color: 'var(--c-faint)' }}>Es correlación, no causalidad: compara cada decisión con su conjunto y con la cuenta en la semana anterior y la posterior.</p>
    </>
  );
}

function Ganadores({ r }) {
  if (!r.casos?.length) return <div className="lista"><div className="vacio">De {fmtNum(r.ganadores)} ganadores de los últimos 90 días, ninguno cayó.</div></div>;
  return (
    <div className="lista">
      {r.casos.map(c => (
        <div key={c.id} className="fila" style={{ alignItems: 'start' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5, minWidth: 0 }}>
            <div className="meta-linea">
              <span>{c.nivel === 'anuncio' ? 'Anuncio' : 'Ad set'} · {c.campania}</span>
              <span>· {c.caida.tipo === 'pausado' ? `pausado el ${fmtFecha(`${c.caida.fecha}T15:00:00Z`)}` : 'activo, fuera de rango'}</span>
            </div>
            <span style={{ fontWeight: 500 }}>{c.nombre}</span>
            <span style={{ fontSize: 12.5, color: 'var(--c-soft)' }}>
              Ganó la semana del {fmtFecha(`${c.ganadora?.desde}T15:00:00Z`)}: CPA {fmtNum(c.ganadora?.cpa)} / ROAS {fmtNum(c.ganadora?.roas, 2)}
              {c.actual?.cpa != null ? ` · ahora CPA ${fmtNum(c.actual.cpa)} / ROAS ${fmtNum(c.actual.roas, 2)}` : ''}
            </span>
            <span style={{ fontSize: 12.5 }}>{c.causa}</span>
            <span style={{ fontSize: 12.5, color: 'var(--c-accent)' }}>→ {c.recomendacion}</span>
          </div>
          <span className={`chip ${ESTADO_CASO[c.estado]?.clase || ''}`}>{ESTADO_CASO[c.estado]?.label || c.estado}</span>
        </div>
      ))}
    </div>
  );
}

export default function ReportesView({ mostrarToast, sinTablas, version, irA, refrescarTodo }) {
  const [tab, setTab] = useState('reporte');
  const [corridas, setCorridas] = useState([]);
  const [elegida, setElegida] = useState(0);
  const [cargando, setCargando] = useState(false);
  const [generando, setGenerando] = useState(false);
  const [iaDisponible, setIaDisponible] = useState(true);

  useEffect(() => {
    obtenerJobsMetaAds().then(r => setIaDisponible((r.jobs || []).every(j => !j.ia || j.disponible))).catch(() => {});
  }, []);

  const cargar = useCallback(async () => {
    if (sinTablas) return;
    setCargando(true);
    try {
      const r = await obtenerReportesMetaAds(tab);
      setCorridas(r.corridas || []);
      setElegida(0);
    } catch (err) {
      mostrarToast?.(err.message, 'error');
    } finally {
      setCargando(false);
    }
  }, [tab, sinTablas, mostrarToast]);

  useEffect(() => { cargar(); }, [cargar, version]);

  async function generar() {
    setGenerando(true);
    try {
      const r = await ejecutarJobMetaAds(tab);
      mostrarToast?.(`${r.resumen.nombre} listo${r.resumen.propuestas ? ` · ${r.resumen.propuestas} propuesta(s) en la bandeja` : ''}`, 'success');
      refrescarTodo();
      await cargar();
    } catch (err) {
      mostrarToast?.(err.message, 'error');
    } finally {
      setGenerando(false);
    }
  }

  const c = corridas[elegida];
  const cadencia = {
    reporte: 'Se genera solo los lunes', auditoria: 'Se genera sola los días 1 y 15', ganadores: 'Se genera solo los miércoles',
    brief: 'Se genera solo los lunes, después del reporte', mensual: 'Se genera solo el día 1', politicas: 'Se genera solo los días 1 y 15',
  }[tab];
  const esIA = PESTANIAS.find(t => t.id === tab)?.ia;
  const bloqueado = esIA && !iaDisponible;

  return (
    <div className="cauce-body">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <div className="tabs" role="tablist" aria-label="Reporte">
          {PESTANIAS.map(t => <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}>{t.label}</button>)}
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {corridas.length > 1 && (
            <select value={elegida} onChange={e => setElegida(Number(e.target.value))} aria-label="Corrida">
              {corridas.map((x, i) => <option key={x.id} value={i}>{fmtFecha(x.at, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</option>)}
            </select>
          )}
          <button type="button" className="pri" onClick={generar} disabled={generando || sinTablas || bloqueado} title={esIA ? 'Usa la API de Claude: tarda 1-3 minutos y tiene costo' : undefined}>{generando ? (esIA ? 'Redactando… (1-3 min)' : 'Generando…') : 'Generar ahora'}</button>
        </div>
      </div>
      <p style={{ fontSize: 12, color: 'var(--c-muted)', marginTop: -16 }}>
        {cadencia} (con META_ADS_PILOTO_CRON configurado){c ? ` · este es del ${fmtFecha(c.at, { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })}${c.usuario ? ` por ${c.usuario.split('@')[0]}` : ''} (${hace(c.at)})` : ''}
      </p>

      {bloqueado && (
        <div className="aviso"><span aria-hidden="true">⚠</span><span>Falta <b>ANTHROPIC_API_KEY</b> en el servidor: esta tarea redacta e investiga con la API de Claude. Cargala en Railway (y en tu .env para probar en local).</span></div>
      )}
      {!c && <div className="lista"><div className="vacio">{cargando ? 'Cargando…' : sinTablas ? 'Activá las tablas del piloto.' : 'Todavía no se generó ninguno. Tocá "Generar ahora".'}</div></div>}
      {c && tab === 'reporte' && <ReporteSemanal r={c.resultado} irA={irA} />}
      {c && tab === 'auditoria' && <Auditoria r={c.resultado} />}
      {c && tab === 'ganadores' && <Ganadores r={c.resultado} />}
      {c && tab === 'brief' && <Brief r={c.resultado} mostrarToast={mostrarToast} />}
      {c && tab === 'mensual' && <Mensual r={c.resultado} />}
      {c && tab === 'politicas' && <Politicas r={c.resultado} />}
    </div>
  );
}

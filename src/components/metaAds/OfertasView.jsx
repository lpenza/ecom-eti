import React, { useEffect, useState } from 'react';
import { obtenerParametrosMetaAds, guardarParametrosMetaAds } from '../../services/api';
import { hace } from './util';

export default function OfertasView({ mostrarToast, version }) {
  const [params, setParams] = useState(null);
  const [ofertas, setOfertas] = useState([]);
  const [guardando, setGuardando] = useState(false);

  useEffect(() => {
    obtenerParametrosMetaAds()
      .then(r => { setParams(r); setOfertas(r.parametros.ofertas.map(o => ({ ...o }))); })
      .catch(err => mostrarToast?.(`No se pudieron leer las ofertas: ${err.message}`, 'error'));
  }, [version, mostrarToast]);

  const cambiar = (i, campo, valor) => setOfertas(lista => lista.map((o, j) => {
    if (campo === 'defecto') return { ...o, defecto: j === i };
    return j === i ? { ...o, [campo]: valor } : o;
  }));

  const valido = ofertas.length > 0 && ofertas.every(o => /^[A-Z0-9+_-]{1,20}$/.test(o.tag) && o.cpaObjetivo > 0 && o.cpaMaximo > 0 && o.cpaObjetivo < o.cpaMaximo)
    && new Set(ofertas.map(o => o.tag)).size === ofertas.length;
  const cambiado = params && JSON.stringify(ofertas) !== JSON.stringify(params.parametros.ofertas);

  async function guardar() {
    setGuardando(true);
    try {
      const r = await guardarParametrosMetaAds({ ...params.parametros, ofertas });
      setParams(p => ({ ...p, parametros: r.parametros, actualizadoPor: r.actualizadoPor, actualizadoEn: r.actualizadoEn }));
      setOfertas(r.parametros.ofertas.map(o => ({ ...o })));
      mostrarToast?.('Ofertas guardadas', 'success');
    } catch (err) {
      mostrarToast?.(err.message, 'error');
    } finally {
      setGuardando(false);
    }
  }

  return (
    <div className="cauce-body">
      <section style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div className="seccion-titulo">
          <h2>CPA por oferta</h2>
          <span style={{ fontSize: 12, color: 'var(--c-muted)' }}>{params?.actualizadoPor ? `Último cambio: ${params.actualizadoPor} · ${hace(params.actualizadoEn)}` : 'Valores del Rulebook'}</span>
        </div>
        <p style={{ fontSize: 12.5, color: 'var(--c-soft)', maxWidth: 760 }}>
          Cada campaña o ad set se evalúa contra la oferta cuyo <b>tag</b> aparece en su nombre, en mayúsculas (ej. <span className="num">CBO - PRE - SICH11 - STUDIO</span>).
          Sin tag se usa la oferta marcada por defecto. El objetivo de cuenta del Inicio y del gate de testeo se pondera por el gasto de cada oferta.
        </p>
        <div className="lista" style={{ overflowX: 'auto' }}>
          <table className="tabla">
            <thead>
              <tr>
                <th style={{ textAlign: 'left' }}>Por defecto</th>
                <th style={{ textAlign: 'left' }}>Tag</th>
                <th style={{ textAlign: 'left' }}>Oferta</th>
                <th>CPA objetivo</th>
                <th>CPA máximo</th>
                <th style={{ textAlign: 'left' }}>Link de destino</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {ofertas.map((o, i) => (
                <tr key={i}>
                  <td style={{ textAlign: 'left' }}><input type="radio" name="oferta-defecto" checked={Boolean(o.defecto)} onChange={() => cambiar(i, 'defecto', true)} aria-label={`${o.tag} por defecto`} style={{ height: 'auto' }} /></td>
                  <td style={{ textAlign: 'left' }}><input value={o.tag} onChange={e => cambiar(i, 'tag', e.target.value.toUpperCase())} className="num" style={{ width: 110 }} aria-label="Tag" /></td>
                  <td style={{ textAlign: 'left' }}><input value={o.nombre} onChange={e => cambiar(i, 'nombre', e.target.value)} style={{ width: 190 }} aria-label="Nombre" /></td>
                  <td><input type="number" min="1" value={o.cpaObjetivo} onChange={e => cambiar(i, 'cpaObjetivo', Number(e.target.value))} className="num" style={{ width: 90, textAlign: 'right' }} aria-label="CPA objetivo" /></td>
                  <td><input type="number" min="1" value={o.cpaMaximo} onChange={e => cambiar(i, 'cpaMaximo', Number(e.target.value))} className="num" style={{ width: 90, textAlign: 'right' }} aria-label="CPA máximo" /></td>
                  <td style={{ textAlign: 'left', width: '100%' }}><input value={o.link} onChange={e => cambiar(i, 'link', e.target.value)} style={{ width: '100%', minWidth: 200 }} aria-label="Link" title={o.link} /></td>
                  <td><button type="button" className="btn btn-sm btn-danger" onClick={() => setOfertas(l => l.filter((_, j) => j !== i))} disabled={ofertas.length <= 1}>Quitar</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!valido && ofertas.length > 0 && <div className="aviso"><span aria-hidden="true">⚠</span><span>Revisá: cada tag tiene que ser único (letras, números, + o -) y el CPA objetivo menor que el máximo.</span></div>}
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
          <button type="button" className="btn" onClick={() => setOfertas(l => [...l, { tag: '', nombre: '', cpaObjetivo: 550, cpaMaximo: 850, link: '', defecto: false }])}>Agregar oferta</button>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" className="btn" onClick={() => setOfertas(params.defectos.ofertas.map(o => ({ ...o })))} disabled={!params}>Volver a las del Rulebook</button>
            <button type="button" className="pri" onClick={guardar} disabled={!cambiado || !valido || guardando || params?.sinTabla}>{guardando ? 'Guardando…' : 'Guardar'}</button>
          </div>
        </div>
      </section>
    </div>
  );
}

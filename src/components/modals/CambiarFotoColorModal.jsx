import React, { useState, useEffect } from 'react';
import { planFotoColorNC, cambiarFotoColorNC } from '../../services/api';
import { cierreFuera } from '../../utils/cierreModal';
import ProgresoPublicacion from '../ProgresoPublicacion';

// Cambio de la foto de un color NC en Shopify (todos los productos que lo tienen)
// y en MercadoLibre (foto 1 de cada publicación). Al abrir se consulta dónde está
// el color; recién al confirmar se sube la foto nueva.
const MAX_FOTO_MB = 8;

function leerComoBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('No se pudo leer la foto'));
    reader.readAsDataURL(file);
  });
}

export default function CambiarFotoColorModal({ producto, onClose, mostrarToast }) {
  const sku = String(producto.sku || '').trim();
  const [plan, setPlan] = useState(null);
  const [cargando, setCargando] = useState(true);
  const [aplicando, setAplicando] = useState(false);
  const [foto, setFoto] = useState(null); // { file, preview }
  const [elegidosShopify, setElegidosShopify] = useState(new Set());
  const [elegidasML, setElegidasML] = useState(new Set());
  const [resultado, setResultado] = useState(null);
  const [progreso, setProgreso] = useState(null); // no null = publicando

  async function cargarPlan() {
    setCargando(true);
    try {
      const res = await planFotoColorNC(sku);
      setPlan(res);
      setElegidosShopify(new Set(res.shopify.map((p) => p.id)));
      setElegidasML(new Set(res.ml.map((p) => p.itemId)));
    } catch (err) {
      mostrarToast?.(err.message || 'Error consultando dónde está el color', 'error');
      onClose();
    } finally {
      setCargando(false);
    }
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { cargarPlan(); }, [sku]);
  useEffect(() => () => { if (foto?.preview) URL.revokeObjectURL(foto.preview); }, [foto]);

  function elegirFoto(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!['image/jpeg', 'image/png'].includes(file.type)) {
      mostrarToast?.('La foto tiene que ser JPG o PNG', 'error');
      return;
    }
    if (file.size > MAX_FOTO_MB * 1024 * 1024) {
      mostrarToast?.(`La foto pesa más de ${MAX_FOTO_MB} MB`, 'error');
      return;
    }
    setFoto({ file, preview: URL.createObjectURL(file) });
  }

  function alternar(set, setter, clave) {
    const next = new Set(set);
    if (next.has(clave)) next.delete(clave); else next.add(clave);
    setter(next);
  }

  const total = elegidosShopify.size + elegidasML.size;
  const fotoActual = plan?.shopify?.[0]?.fotoActual || plan?.ml?.[0]?.fotoActual || null;

  // Avance en vivo que manda el servidor; cada ítem terminado se acumula en la lista.
  const alProgreso = (ev) => setProgreso((prev) => ({
    mensaje: ev.mensaje,
    hechos: ev.hechos,
    total: ev.total,
    items: ev.item ? [...(prev?.items || []), ev.item] : (prev?.items || []),
  }));

  async function aplicar() {
    setAplicando(true);
    setProgreso({ mensaje: 'Preparando la foto…', hechos: 0, total: 0, items: [] });
    try {
      const base64 = await leerComoBase64(foto.file);
      const res = await cambiarFotoColorNC({
        sku,
        imagen: { base64, mimeType: foto.file.type, filename: foto.file.name },
        productosShopify: [...elegidosShopify],
        publicacionesML: [...elegidasML],
      }, alProgreso);
      setResultado(res);
      if (res.fallos > 0) mostrarToast?.(`${plan.nombre}: ${res.fallos} cambio(s) fallaron, revisá el detalle`, 'warning');
      else mostrarToast?.(`Foto de ${plan.nombre} actualizada`, 'success');
    } catch (err) {
      mostrarToast?.(err.message || 'Error cambiando la foto', 'error');
    } finally {
      setAplicando(false);
      setProgreso(null);
    }
  }

  // Vuelve a la lista con tildado sólo lo que falló: lo que salió bien ya tiene la foto nueva.
  function reintentar() {
    setElegidosShopify(new Set(resultado.shopify.filter((r) => !r.ok).map((r) => r.id)));
    setElegidasML(new Set(resultado.ml.filter((r) => !r.ok).map((r) => r.itemId)));
    setResultado(null);
  }

  return (
    <div
      className="modal modal-open"
      {...cierreFuera(onClose, {
        bloqueado: aplicando,
        confirmar: !resultado,
        mensaje: '¿Cerrar el cambio de foto? Se pierde la foto elegida.',
      })}
    >
      <div className="modal-content modal-medium" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>Cambiar foto · {plan?.nombre || producto.nombre}</h3>
          <button className="btn-close" onClick={onClose} disabled={aplicando}>&times;</button>
        </div>

        {cargando && (
          <div className="modal-body"><p>Buscando el color en Shopify y MercadoLibre…</p></div>
        )}

        {!cargando && plan && !resultado && (
          <>
            <div className="modal-body">
              <div className="cambiarfoto-comparacion">
                <figure>
                  {fotoActual
                    ? <img src={fotoActual} alt="Foto actual" />
                    : <div className="cambiarfoto-vacia">Sin foto</div>}
                  <figcaption>
                    Actual
                    {fotoActual && <> · <a href={fotoActual} target="_blank" rel="noreferrer" download>descargar</a></>}
                  </figcaption>
                </figure>
                <div className="stocknc-confirm-arrow">→</div>
                <figure>
                  {foto
                    ? <img src={foto.preview} alt="Foto nueva" />
                    : <div className="cambiarfoto-vacia">Elegí la foto nueva</div>}
                  <figcaption>
                    <input type="file" accept="image/jpeg,image/png" onChange={elegirFoto} />
                  </figcaption>
                </figure>
              </div>

              <h4 className="nuevocolor-seccion">Shopify ({elegidosShopify.size} producto{elegidosShopify.size === 1 ? '' : 's'})</h4>
              <ul className="nuevocolor-lista">
                {plan.shopify.map((p) => (
                  <li key={p.id}>
                    <label>
                      <input
                        type="checkbox"
                        checked={elegidosShopify.has(p.id)}
                        onChange={() => alternar(elegidosShopify, setElegidosShopify, p.id)}
                      />
                      {p.titulo}
                      <span className="nuevocolor-meta">{p.estado === 'ACTIVE' ? 'activo' : p.estado.toLowerCase()}</span>
                    </label>
                  </li>
                ))}
                {plan.shopify.length === 0 && <li>Ningún producto de Shopify tiene este SKU</li>}
              </ul>

              <h4 className="nuevocolor-seccion">MercadoLibre ({elegidasML.size} publicaci{elegidasML.size === 1 ? 'ón' : 'ones'}, solo la foto 1)</h4>
              {plan.mlError && <div className="stocknc-confirm-warn">No se pudo consultar ML: {plan.mlError}</div>}
              <ul className="nuevocolor-lista">
                {plan.ml.map((p) => (
                  <li key={p.itemId}>
                    <label>
                      <input
                        type="checkbox"
                        checked={elegidasML.has(p.itemId)}
                        onChange={() => alternar(elegidasML, setElegidasML, p.itemId)}
                      />
                      {p.titulo}
                      <span className="nuevocolor-meta">{p.itemId}{p.estado !== 'active' ? ` · ${p.estado}` : ''}</span>
                    </label>
                  </li>
                ))}
                {!plan.mlError && plan.ml.length === 0 && <li>No hay publicaciones con este SKU</li>}
              </ul>

              <div className="stocknc-confirm-warn">
                En Shopify la foto vieja se saca de cada producto pero queda guardada en
                Contenido → Archivos. En ML se reemplaza solo la foto 1: las demás no se tocan.
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={onClose} disabled={aplicando}>Cancelar</button>
              <button className="btn btn-danger" onClick={aplicar} disabled={!foto || total === 0 || aplicando}>
                {aplicando ? 'Cambiando…' : `Cambiar foto en ${total} lugar${total === 1 ? '' : 'es'}`}
              </button>
            </div>
          </>
        )}

        {resultado && (
          <>
            <div className="modal-body">
              <h4 className="nuevocolor-seccion">Shopify</h4>
              <ul className="nuevocolor-lista">
                {resultado.shopify.map((r) => (
                  <li key={r.titulo}>
                    {r.ok ? '✅' : '❌'} {r.titulo}
                    {r.ok && r.conservadas > 0 && <span className="nuevocolor-meta">la foto vieja la usa otra variante: quedó en la galería</span>}
                    {!r.ok && <span className="nuevocolor-motivo">{r.error}</span>}
                    {r.avisos?.map((a) => <span key={a} className="nuevocolor-motivo">{a}</span>)}
                  </li>
                ))}
                {resultado.shopify.length === 0 && <li>Nada que cambiar</li>}
              </ul>
              <h4 className="nuevocolor-seccion">MercadoLibre</h4>
              <ul className="nuevocolor-lista">
                {resultado.ml.map((r) => (
                  <li key={r.itemId}>
                    {r.ok ? '✅' : '❌'}{' '}
                    {r.ok && r.permalink ? <a href={r.permalink} target="_blank" rel="noreferrer">{r.titulo}</a> : r.titulo}
                    {!r.ok && <span className="nuevocolor-motivo">{r.error}</span>}
                  </li>
                ))}
                {resultado.ml.length === 0 && <li>Nada que cambiar</li>}
              </ul>
            </div>
            <div className="modal-footer">
              {resultado.fallos > 0 && (
                <button className="btn btn-secondary" onClick={reintentar}>Volver a intentar</button>
              )}
              <button className="btn btn-primary" onClick={onClose}>Cerrar</button>
            </div>
          </>
        )}
      </div>
      {progreso && <ProgresoPublicacion titulo={`Cambiando la foto de ${plan?.nombre || producto.nombre}`} progreso={progreso} />}
    </div>
  );
}

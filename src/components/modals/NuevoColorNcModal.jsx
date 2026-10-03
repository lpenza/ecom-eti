import React, { useState, useEffect } from 'react';
import { planNuevoColorNC, crearNuevoColorNC } from '../../services/api';
import { cierreFuera } from '../../utils/cierreModal';
import ProgresoPublicacion from '../ProgresoPublicacion';

// Alta de un color NC nuevo en todos los productos de Shopify que llevan colores
// y en las familias de publicaciones de ML. Tres pasos: datos → plan (qué se va a
// crear, sin escribir nada) → resultado.
const MAX_FOTO_MB = 8;

function leerComoBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('No se pudo leer la foto'));
    reader.readAsDataURL(file);
  });
}

export default function NuevoColorNcModal({ onClose, onCreado, mostrarToast }) {
  const [paso, setPaso] = useState('datos'); // datos | plan | resultado
  const [nombre, setNombre] = useState('');
  const [sku, setSku] = useState('');
  const [stock, setStock] = useState('');
  const [foto, setFoto] = useState(null); // { file, preview }
  const [plan, setPlan] = useState(null);
  const [elegidosShopify, setElegidosShopify] = useState(new Set());
  const [elegidasML, setElegidasML] = useState(new Set());
  const [cargando, setCargando] = useState(false);
  const [resultado, setResultado] = useState(null);
  const [progreso, setProgreso] = useState(null); // no null = publicando
  // Alta del color en Shopify (metaobjeto de colores) cuando todavía no existe.
  const [colorBase, setColorBase] = useState('');
  const [patron, setPatron] = useState('');
  // null = sin elegir: no se manda, en vez de guardar el gris del selector como tono.
  const [hex, setHex] = useState(null);

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

  const stockNum = Number(stock);
  const stockValido = stock !== '' && Number.isInteger(stockNum) && stockNum >= 0;
  const datosCompletos = nombre.trim() && /^NC\d{4,}$/i.test(sku.trim()) && stockValido && foto;

  async function verPlan() {
    setCargando(true);
    try {
      const res = await planNuevoColorNC(nombre.trim(), sku.trim());
      setPlan(res);
      setElegidosShopify(new Set(res.shopify.filter((p) => !p.omitir).map((p) => p.id)));
      setElegidasML(new Set(res.ml.filter((f) => !f.omitir).map((f) => f.familia)));
      setPatron(res.colorShopify?.patrones?.[0]?.id || '');
      setPaso('plan');
    } catch (err) {
      mostrarToast?.(err.message || 'Error armando el plan', 'error');
    } finally {
      setCargando(false);
    }
  }

  function alternar(set, setter, clave) {
    const next = new Set(set);
    if (next.has(clave)) next.delete(clave); else next.add(clave);
    setter(next);
  }

  const mlSinStock = elegidasML.size > 0 && stockNum < 1;
  const nadaElegido = elegidosShopify.size === 0 && elegidasML.size === 0;
  // Hay que crear el color en Shopify si se van a crear variantes y no existe todavía.
  const faltaColorShopify = elegidosShopify.size > 0
    && plan?.colorShopify?.requerido
    && !plan?.colorShopify?.existente;

  // Avance en vivo que manda el servidor; cada ítem terminado se acumula en la lista.
  const alProgreso = (ev) => setProgreso((prev) => ({
    mensaje: ev.mensaje,
    hechos: ev.hechos,
    total: ev.total,
    items: ev.item ? [...(prev?.items || []), ev.item] : (prev?.items || []),
  }));

  async function crear() {
    setCargando(true);
    setProgreso({ mensaje: 'Preparando la foto…', hechos: 0, total: 0, items: [] });
    try {
      const base64 = await leerComoBase64(foto.file);
      const res = await crearNuevoColorNC({
        nombre: plan.nombre,
        sku: plan.sku,
        stock: stockNum,
        imagen: { base64, mimeType: foto.file.type, filename: foto.file.name },
        productosShopify: [...elegidosShopify],
        familiasML: [...elegidasML],
        colorShopify: faltaColorShopify ? { colorBase, patron, hex } : null,
      }, alProgreso);
      setResultado(res);
      setPaso('resultado');
      onCreado?.();
      if (res.fallos > 0) mostrarToast?.(`${plan.nombre}: ${res.fallos} alta(s) fallaron, revisá el detalle`, 'warning');
      else mostrarToast?.(`${plan.nombre} (${plan.sku}) dado de alta`, 'success');
    } catch (err) {
      mostrarToast?.(err.message || 'Error creando el color', 'error');
    } finally {
      setCargando(false);
      setProgreso(null);
    }
  }

  return (
    <div
      className="modal modal-open"
      {...cierreFuera(onClose, {
        bloqueado: cargando,
        confirmar: paso !== 'resultado',
        mensaje: '¿Cerrar el alta del color? Se pierde lo que cargaste.',
      })}
    >
      <div className="modal-content modal-medium" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>Agregar color nuevo</h3>
          <button className="btn-close" onClick={onClose} disabled={cargando}>&times;</button>
        </div>

        {paso === 'datos' && (
          <>
            <div className="modal-body nuevocolor-form">
              <p className="stocknc-sub">
                Se crea la variante en todos los productos de Shopify que llevan colores NC
                y una publicación por familia en MercadoLibre. Antes de crear nada vas a ver
                la lista completa.
              </p>
              <label>
                Nombre del color
                <input type="text" value={nombre} onChange={(e) => setNombre(e.target.value)} placeholder="Ej. Rose Velvet" />
              </label>
              <label>
                SKU
                <input type="text" value={sku} onChange={(e) => setSku(e.target.value.toUpperCase())} placeholder="Ej. NC260015" />
              </label>
              <label>
                Stock inicial
                <input type="number" min="0" value={stock} onChange={(e) => setStock(e.target.value)} placeholder="Unidades en Bvar España" />
              </label>
              <label>
                Foto del color (JPG o PNG, cuadrada)
                <input type="file" accept="image/jpeg,image/png" onChange={elegirFoto} />
              </label>
              {foto && <img className="nuevocolor-preview" src={foto.preview} alt="Foto del color" />}
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={onClose}>Cancelar</button>
              <button className="btn btn-primary" onClick={verPlan} disabled={!datosCompletos || cargando}>
                {cargando ? 'Revisando Shopify y ML…' : 'Ver qué se va a crear'}
              </button>
            </div>
          </>
        )}

        {paso === 'plan' && plan && (
          <>
            <div className="modal-body">
              <p className="stocknc-confirm-prod">
                <strong>{plan.nombre}</strong>
                <span className="stocknc-confirm-sku">{plan.sku}</span>
                <span> · stock inicial {stockNum}</span>
              </p>

              <h4 className="nuevocolor-seccion">Shopify ({elegidosShopify.size} producto{elegidosShopify.size === 1 ? '' : 's'})</h4>
              <ul className="nuevocolor-lista">
                {plan.shopify.map((p) => (
                  <li key={p.id} className={p.omitir ? 'nuevocolor-omitido' : ''}>
                    <label>
                      <input
                        type="checkbox"
                        checked={elegidosShopify.has(p.id)}
                        disabled={Boolean(p.omitir)}
                        onChange={() => alternar(elegidosShopify, setElegidosShopify, p.id)}
                      />
                      {p.titulo}
                      <span className="nuevocolor-meta">
                        {p.estado === 'ACTIVE' ? 'activo' : p.estado.toLowerCase()} · ${Number(p.precio)}
                      </span>
                      {p.omitir && <span className="nuevocolor-motivo">{p.omitir}</span>}
                    </label>
                  </li>
                ))}
              </ul>

              {elegidosShopify.size > 0 && plan.colorShopify?.requerido && (
                plan.colorShopify.existente ? (
                  <p className="nuevocolor-color-existente">
                    {plan.colorShopify.existente.hex && (
                      <span className="nuevocolor-muestra" style={{ background: plan.colorShopify.existente.hex }} />
                    )}
                    Se usa el color <strong>{plan.colorShopify.existente.nombre}</strong> que ya existe en Shopify
                    {plan.colorShopify.existente.colorBase?.length > 0 && ` (${plan.colorShopify.existente.colorBase.join(', ')})`}.
                  </p>
                ) : (
                  <div className="nuevocolor-color-nuevo">
                    <p>
                      <strong>{plan.nombre}</strong> no existe todavía en los colores de Shopify: se crea con estos datos
                      (Shopify los usa para los filtros y la muestra de color).
                    </p>
                    <div className="nuevocolor-color-campos">
                      <label>
                        Color base
                        <select value={colorBase} onChange={(e) => setColorBase(e.target.value)}>
                          <option value="">Elegí…</option>
                          {plan.colorShopify.coloresBase.map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}
                        </select>
                      </label>
                      <label>
                        Tono {hex ? <span className="nuevocolor-meta">{hex}</span> : <span className="nuevocolor-motivo">sin elegir</span>}
                        <input type="color" value={hex || '#cccccc'} onChange={(e) => setHex(e.target.value)} />
                      </label>
                      <label>
                        Patrón
                        <select value={patron} onChange={(e) => setPatron(e.target.value)}>
                          {plan.colorShopify.patrones.map((p) => <option key={p.id} value={p.id}>{p.nombre}</option>)}
                        </select>
                      </label>
                    </div>
                  </div>
                )
              )}

              <h4 className="nuevocolor-seccion">MercadoLibre ({elegidasML.size} publicaci{elegidasML.size === 1 ? 'ón' : 'ones'})</h4>
              {plan.mlError && <div className="stocknc-confirm-warn">No se pudo consultar ML: {plan.mlError}</div>}
              <ul className="nuevocolor-lista">
                {plan.ml.map((f) => (
                  <li key={f.familia} className={f.omitir ? 'nuevocolor-omitido' : ''}>
                    <label>
                      <input
                        type="checkbox"
                        checked={elegidasML.has(f.familia)}
                        disabled={Boolean(f.omitir)}
                        onChange={() => alternar(elegidasML, setElegidasML, f.familia)}
                      />
                      {f.tituloNuevo}
                      <span className="nuevocolor-meta">copia de {f.plantillaId}</span>
                      {f.omitir && <span className="nuevocolor-motivo">{f.omitir}</span>}
                    </label>
                  </li>
                ))}
              </ul>

              {mlSinStock && (
                <div className="stocknc-confirm-warn">
                  ML no deja publicar con stock 0. Cargá al menos 1 unidad o destildá las publicaciones de ML.
                </div>
              )}
              <div className="stocknc-confirm-warn">
                Cada variante copia el precio y el precio tachado de su producto; cada publicación de ML
                copia precio, envío y fotos 2 en adelante de su plantilla. La foto que subiste va como
                foto del color. {plan.existeEnBd ? 'El SKU ya existe en el panel: no se modifica su stock.' : 'El color se agrega al panel de stock.'}
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setPaso('datos')} disabled={cargando}>Volver</button>
              <button className="btn btn-danger" onClick={crear} disabled={cargando || nadaElegido || mlSinStock || (faltaColorShopify && !colorBase)}>
                {cargando ? 'Creando…' : `Crear en ${elegidosShopify.size} producto(s) y ${elegidasML.size} publicación(es)`}
              </button>
            </div>
          </>
        )}

        {paso === 'resultado' && resultado && (
          <>
            <div className="modal-body">
              <h4 className="nuevocolor-seccion">Shopify</h4>
              {resultado.colorShopify?.creado && (
                <p>✅ Color <strong>{resultado.colorShopify.nombre}</strong> creado en los colores de Shopify</p>
              )}
              <ul className="nuevocolor-lista">
                {resultado.shopify.map((r) => (
                  <li key={r.titulo}>
                    {r.ok ? '✅' : '❌'} {r.titulo}
                    {!r.ok && <span className="nuevocolor-motivo">{r.error}</span>}
                  </li>
                ))}
                {resultado.shopify.length === 0 && <li>Nada que crear</li>}
              </ul>
              <h4 className="nuevocolor-seccion">MercadoLibre</h4>
              <ul className="nuevocolor-lista">
                {resultado.ml.map((r) => (
                  <li key={r.familia}>
                    {r.ok ? '✅' : '❌'}{' '}
                    {r.ok && r.permalink
                      ? <a href={r.permalink} target="_blank" rel="noreferrer">{r.titulo || r.familia}</a>
                      : (r.titulo || r.familia)}
                    {r.ok && r.itemId && <span className="nuevocolor-meta">{r.itemId}</span>}
                    {!r.ok && <span className="nuevocolor-motivo">{r.error}</span>}
                  </li>
                ))}
                {resultado.ml.length === 0 && <li>Nada que crear</li>}
              </ul>
              <h4 className="nuevocolor-seccion">Panel de stock</h4>
              <p>
                {resultado.bd?.ok
                  ? (resultado.bd.creado ? '✅ Color agregado al panel' : 'Ya estaba en el panel')
                  : `❌ ${resultado.bd?.error || 'No se pudo agregar'}`}
              </p>
              {resultado.fallos > 0 && (
                <div className="stocknc-confirm-warn">
                  Algunas altas fallaron. Podés volver a correrlo: lo que ya quedó creado se saltea.
                </div>
              )}
            </div>
            <div className="modal-footer">
              {resultado.fallos > 0 && (
                <button className="btn btn-secondary" onClick={verPlan} disabled={cargando}>Reintentar lo que falló</button>
              )}
              <button className="btn btn-primary" onClick={onClose}>Cerrar</button>
            </div>
          </>
        )}
      </div>
      {progreso && <ProgresoPublicacion titulo={`Dando de alta ${plan?.nombre || 'el color'}`} progreso={progreso} />}
    </div>
  );
}

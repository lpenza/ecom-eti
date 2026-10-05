import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { atencionFaqCategorias } from '../data/atencionFaq';
import { normalizarTexto, expandirToken } from '../data/atencionFaqSinonimos';
import {
  obtenerAtencionFaqCasos,
  crearAtencionFaqCaso,
  actualizarAtencionFaqCaso,
  eliminarAtencionFaqCaso,
} from '../services/api';

// Búsqueda "inteligente": no busca la frase literal, busca por palabra — y cada
// palabra se expande a sus sinónimos (ver atencionFaqSinonimos.js). Así "color
// mal" encuentra situaciones etiquetadas como "color incorrecto" o "no coincide
// con la web" aunque la palabra "mal" no aparezca ahí tal cual.
//
// Las `tags` de cada situación (en atencionFaq.js, o cargadas en "Agregar caso")
// son justamente las formas alternativas en las que un agente podría escribir la
// consulta — agregar un caso nuevo es tan simple como completar el formulario, o
// sumar un sinónimo al grupo que corresponda en atencionFaqSinonimos.js.

function tokenizar(query) {
  return normalizarTexto(query).split(/\s+/).map((t) => t.trim()).filter(Boolean);
}

// Palabras sueltas del texto (para matchear términos cortos por palabra exacta,
// no por substring — evita falsos positivos como "mal" adentro de "normal").
function palabrasDe(texto) {
  return new Set(texto.split(/[^a-z0-9]+/i).filter(Boolean));
}

function campoDeTexto(texto) {
  return { texto, palabras: palabrasDe(texto) };
}

function camposDeSituacion(situacion) {
  return {
    tags: campoDeTexto(normalizarTexto((situacion.tags || []).join(' | '))),
    pregunta: campoDeTexto(normalizarTexto(situacion.pregunta)),
    cuerpo: campoDeTexto(
      normalizarTexto(
        [
          situacion.regla,
          situacion.respuesta,
          situacion.escalar,
          situacion.noPrometer,
          situacion.datoAConfirmar,
          situacion.categoriaNombre,
          ...(situacion.variantes || []).flatMap((v) => [v.condicion, v.respuesta]),
        ]
          .filter(Boolean)
          .join(' | ')
      )
    ),
  };
}

// Un término de 4 letras o menos ("mal", "hay", "dura"...) sólo cuenta si aparece
// como palabra completa; uno más largo también vale como substring, para
// tolerar plurales o variantes ("lampara" matchea dentro de "lamparas").
function terminoEnCampo(termino, campo) {
  if (termino.includes(' ')) return campo.texto.includes(termino);
  if (termino.length <= 4) return campo.palabras.has(termino);
  return campo.texto.includes(termino);
}

// Puntúa una situación contra los tokens de búsqueda: cuántos tokens cubre
// (contando sinónimos) y con qué peso (tags > pregunta > resto del cuerpo).
function puntuarSituacion(campos, tokens) {
  let puntaje = 0;
  let tokensCubiertos = 0;
  for (const token of tokens) {
    const equivalentes = expandirToken(token);
    let cubreEste = false;
    for (const eq of equivalentes) {
      if (terminoEnCampo(eq, campos.tags)) { puntaje += 3; cubreEste = true; }
      if (terminoEnCampo(eq, campos.pregunta)) { puntaje += 2; cubreEste = true; }
      if (terminoEnCampo(eq, campos.cuerpo)) { puntaje += 1; cubreEste = true; }
    }
    if (cubreEste) tokensCubiertos += 1;
  }
  return { puntaje, tokensCubiertos };
}

function buscarSituaciones(query, situacionesFlat) {
  const tokens = tokenizar(query);
  if (tokens.length === 0) return [];

  const resultados = situacionesFlat
    .map((situacion) => {
      const { puntaje, tokensCubiertos } = puntuarSituacion(camposDeSituacion(situacion), tokens);
      return { situacion, puntaje, tokensCubiertos };
    })
    .filter((r) => r.tokensCubiertos > 0);

  // Preferir resultados que cubren TODAS las palabras buscadas; si ninguno las
  // cubre todas, mostrar los parciales (mejor algo que una búsqueda vacía).
  const completos = resultados.filter((r) => r.tokensCubiertos === tokens.length);
  const base = completos.length > 0 ? completos : resultados;

  return base.sort((a, b) => b.puntaje - a.puntaje).map((r) => r.situacion);
}

// ── Casos agregados desde el panel (Supabase) ───────────────────────────────
// Se combinan con los casos curados en código para armar las mismas categorías
// y la misma lista de búsqueda, sin distinción para quien consulta la guía.

function casoDbASituacion(row) {
  return {
    id: row.id,
    pregunta: row.pregunta,
    regla: row.regla || '',
    respuesta: row.respuesta || '',
    variantes: Array.isArray(row.variantes) ? row.variantes : [],
    escalar: row.escalar || '',
    noPrometer: row.no_prometer || '',
    datoAConfirmar: row.dato_a_confirmar || '',
    tags: Array.isArray(row.tags) ? row.tags : [],
    fuente: row.fuente || '',
    dbId: row.id,
    categoriaId: row.categoria_id,
    categoriaNombre: row.categoria_nombre,
    categoriaIcon: row.categoria_icon || '❓',
  };
}

// La guía vive en la base (tabla atencion_faq_casos) una vez migrada — ver
// scripts/migrate-atencion-faq-a-db.js. Mientras esa tabla esté vacía (o no
// exista todavía), se usa el contenido curado en código como respaldo de
// sólo lectura, para que el panel nunca se vea vacío.
function construirCategorias(casosDb) {
  if (casosDb.length === 0) {
    return atencionFaqCategorias.map((cat) => ({ ...cat, situaciones: [...cat.situaciones] }));
  }

  const mapa = new Map();
  casosDb.forEach((row) => {
    const situacion = casoDbASituacion(row);
    if (!mapa.has(situacion.categoriaId)) {
      mapa.set(situacion.categoriaId, {
        id: situacion.categoriaId,
        nombre: situacion.categoriaNombre,
        icon: situacion.categoriaIcon,
        descripcion: row.categoria_descripcion || '',
        situaciones: [],
      });
    }
    mapa.get(situacion.categoriaId).situaciones.push(situacion);
  });

  return Array.from(mapa.values());
}

function construirFlat(categorias) {
  return categorias.flatMap((cat) =>
    cat.situaciones.map((s) => ({ ...s, categoriaId: cat.id, categoriaNombre: cat.nombre, categoriaIcon: cat.icon }))
  );
}

function CopiarBoton({ texto, mostrarToast, etiqueta = 'Copiar respuesta' }) {
  const [copiado, setCopiado] = useState(false);

  const copiar = async () => {
    try {
      await navigator.clipboard.writeText(texto);
      setCopiado(true);
      mostrarToast?.('✅ Respuesta copiada', 'success');
      setTimeout(() => setCopiado(false), 1500);
    } catch (err) {
      mostrarToast?.('No se pudo copiar', 'error');
    }
  };

  return (
    <button type="button" className="btn btn-secondary btn-sm faq-copy-btn" onClick={copiar}>
      {copiado ? '✅ Copiado' : `📋 ${etiqueta}`}
    </button>
  );
}

function SituacionDetalle({ situacion, mostrarToast, esAdmin, onEditar, onEliminar }) {
  if (!situacion) {
    return (
      <div className="faq-empty-detail">
        <span style={{ fontSize: '2rem' }}>🔍</span>
        <p>Elegí un tema a la izquierda para ver la regla y las respuestas sugeridas.</p>
      </div>
    );
  }

  return (
    <div className="faq-detalle">
      <div className="faq-detalle-header">
        <span className="faq-detalle-categoria">
          {situacion.categoriaIcon} {situacion.categoriaNombre}
        </span>
        <h3>{situacion.pregunta}</h3>
        {/* Atención al cliente la ve en solo lectura: editar/eliminar es sólo para admin */}
        {esAdmin && situacion.dbId && (
          <div className="faq-detalle-acciones">
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => onEditar(situacion)}>✏️ Editar</button>
            <button type="button" className="btn btn-danger btn-sm" onClick={() => onEliminar(situacion)}>🗑️ Eliminar</button>
          </div>
        )}
      </div>

      {situacion.regla && (
        <div className="faq-bloque">
          <div className="faq-bloque-titulo">📌 Regla del negocio</div>
          <p className="faq-bloque-texto">{situacion.regla}</p>
        </div>
      )}

      {Array.isArray(situacion.variantes) && situacion.variantes.length > 0 && (
        <div className="faq-bloque">
          <div className="faq-bloque-titulo">🔀 Variables y su respuesta</div>
          <div className="faq-variantes">
            {situacion.variantes.map((v, idx) => (
              <div className="faq-variante-card" key={idx}>
                <div className="faq-variante-condicion">{v.condicion}</div>
                <div className="faq-variante-respuesta">{v.respuesta}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {situacion.respuesta && (
        <div className="faq-bloque faq-bloque-respuesta">
          <div className="faq-bloque-titulo">💬 Respuesta sugerida a la clienta</div>
          <p className="faq-bloque-texto faq-respuesta-texto">{situacion.respuesta}</p>
          <CopiarBoton texto={situacion.respuesta} mostrarToast={mostrarToast} />
        </div>
      )}

      {situacion.escalar && (
        <div className="faq-bloque faq-bloque-escalar">
          <div className="faq-bloque-titulo">⬆️ Cuándo escalar a Bryan</div>
          <p className="faq-bloque-texto">{situacion.escalar}</p>
        </div>
      )}

      {situacion.noPrometer && (
        <div className="faq-bloque faq-bloque-noprometer">
          <div className="faq-bloque-titulo">🚫 No prometer</div>
          <p className="faq-bloque-texto">{situacion.noPrometer}</p>
        </div>
      )}

      {situacion.datoAConfirmar && (
        <div className="faq-bloque faq-bloque-dato">
          <div className="faq-bloque-titulo">⚠️ Dato a confirmar</div>
          <p className="faq-bloque-texto">{situacion.datoAConfirmar}</p>
        </div>
      )}

      {situacion.fuente && (
        <div className="faq-fuente">Fuente: {situacion.fuente}</div>
      )}
    </div>
  );
}

const CATEGORIA_NUEVA_VALOR = '__nueva__';

function CasoFormModal({ categorias, casoInicial, onCancelar, onGuardar }) {
  const [categoriaId, setCategoriaId] = useState(casoInicial?.categoria_id || categorias[0]?.id || CATEGORIA_NUEVA_VALOR);
  const [nuevaCategoriaNombre, setNuevaCategoriaNombre] = useState('');
  const [nuevaCategoriaIcon, setNuevaCategoriaIcon] = useState('❓');
  const [pregunta, setPregunta] = useState(casoInicial?.pregunta || '');
  const [regla, setRegla] = useState(casoInicial?.regla || '');
  const [respuesta, setRespuesta] = useState(casoInicial?.respuesta || '');
  const [escalar, setEscalar] = useState(casoInicial?.escalar || '');
  const [noPrometer, setNoPrometer] = useState(casoInicial?.no_prometer || '');
  const [datoAConfirmar, setDatoAConfirmar] = useState(casoInicial?.dato_a_confirmar || '');
  const [tagsTexto, setTagsTexto] = useState((casoInicial?.tags || []).join(', '));
  const [fuente, setFuente] = useState(casoInicial?.fuente || '');
  const [variantes, setVariantes] = useState(
    Array.isArray(casoInicial?.variantes) ? casoInicial.variantes : []
  );
  const [guardando, setGuardando] = useState(false);

  const esCategoriaNueva = categoriaId === CATEGORIA_NUEVA_VALOR;

  const agregarVariante = () => setVariantes((v) => [...v, { condicion: '', respuesta: '' }]);
  const quitarVariante = (idx) => setVariantes((v) => v.filter((_, i) => i !== idx));
  const cambiarVariante = (idx, campo, valor) =>
    setVariantes((v) => v.map((item, i) => (i === idx ? { ...item, [campo]: valor } : item)));

  const handleSubmit = async (e) => {
    e.preventDefault();
    const preguntaLimpia = pregunta.trim();
    if (!preguntaLimpia) return;

    let catId;
    let catNombre;
    let catIcon;
    if (esCategoriaNueva) {
      catNombre = nuevaCategoriaNombre.trim();
      if (!catNombre) return;
      catId = normalizarTexto(catNombre).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'nueva-categoria';
      catIcon = nuevaCategoriaIcon.trim() || '❓';
    } else {
      const cat = categorias.find((c) => c.id === categoriaId);
      catId = cat?.id || categoriaId;
      catNombre = cat?.nombre || categoriaId;
      catIcon = cat?.icon || '❓';
    }

    const payload = {
      categoria_id: catId,
      categoria_nombre: catNombre,
      categoria_icon: catIcon,
      pregunta: preguntaLimpia,
      regla: regla.trim() || null,
      respuesta: respuesta.trim() || null,
      variantes: variantes.filter((v) => (v.condicion || '').trim() || (v.respuesta || '').trim()),
      escalar: escalar.trim() || null,
      no_prometer: noPrometer.trim() || null,
      dato_a_confirmar: datoAConfirmar.trim() || null,
      tags: tagsTexto.split(',').map((t) => t.trim()).filter(Boolean),
      fuente: fuente.trim() || null,
    };

    setGuardando(true);
    try {
      await onGuardar(payload);
    } finally {
      setGuardando(false);
    }
  };

  return (
    <div className="modal show" onClick={(e) => { if (e.target === e.currentTarget) onCancelar(); }}>
      <div className="modal-content modal-medium">
        <div className="modal-header">
          <h3>{casoInicial ? 'Editar caso' : 'Agregar caso a la guía'}</h3>
          <button type="button" className="btn-close" onClick={onCancelar}>×</button>
        </div>
        <form onSubmit={handleSubmit}>
          <div className="modal-body faq-form-body">
            <label className="faq-form-label">
              Categoría
              <select
                className="faq-form-input"
                value={categoriaId}
                onChange={(e) => setCategoriaId(e.target.value)}
              >
                {categorias.map((c) => (
                  <option key={c.id} value={c.id}>{c.icon} {c.nombre}</option>
                ))}
                <option value={CATEGORIA_NUEVA_VALOR}>➕ Nueva categoría…</option>
              </select>
            </label>

            {esCategoriaNueva && (
              <div className="faq-form-row">
                <label className="faq-form-label" style={{ flex: 1 }}>
                  Nombre de la categoría nueva
                  <input
                    className="faq-form-input"
                    value={nuevaCategoriaNombre}
                    onChange={(e) => setNuevaCategoriaNombre(e.target.value)}
                    placeholder="Ej: Garantías"
                  />
                </label>
                <label className="faq-form-label" style={{ width: 90, flex: '0 0 90px' }}>
                  Ícono
                  <input
                    className="faq-form-input"
                    value={nuevaCategoriaIcon}
                    onChange={(e) => setNuevaCategoriaIcon(e.target.value)}
                    placeholder="🔧"
                    maxLength={4}
                  />
                </label>
              </div>
            )}

            <label className="faq-form-label">
              Pregunta / tema de consulta *
              <input
                className="faq-form-input"
                value={pregunta}
                onChange={(e) => setPregunta(e.target.value)}
                placeholder='Ej: "Llegó un pedido con la caja mojada"'
                required
              />
            </label>

            <label className="faq-form-label">
              Regla del negocio
              <textarea className="faq-form-textarea" rows={3} value={regla} onChange={(e) => setRegla(e.target.value)} />
            </label>

            <label className="faq-form-label">
              Respuesta sugerida a la clienta
              <textarea className="faq-form-textarea" rows={3} value={respuesta} onChange={(e) => setRespuesta(e.target.value)} />
            </label>

            <div className="faq-form-variantes">
              <div className="faq-form-variantes-header">
                <span>Variables (opcional): cuando la respuesta cambia según el caso</span>
                <button type="button" className="btn btn-secondary btn-sm" onClick={agregarVariante}>+ Agregar variable</button>
              </div>
              {variantes.map((v, idx) => (
                <div className="faq-form-variante-row" key={idx}>
                  <input
                    className="faq-form-input"
                    placeholder="Condición (ej: Montevideo)"
                    value={v.condicion}
                    onChange={(e) => cambiarVariante(idx, 'condicion', e.target.value)}
                  />
                  <input
                    className="faq-form-input"
                    placeholder="Respuesta para ese caso"
                    value={v.respuesta}
                    onChange={(e) => cambiarVariante(idx, 'respuesta', e.target.value)}
                  />
                  <button type="button" className="btn btn-secondary btn-sm" onClick={() => quitarVariante(idx)}>✕</button>
                </div>
              ))}
            </div>

            <label className="faq-form-label">
              Cuándo escalar
              <input className="faq-form-input" value={escalar} onChange={(e) => setEscalar(e.target.value)} />
            </label>

            <label className="faq-form-label">
              No prometer
              <input className="faq-form-input" value={noPrometer} onChange={(e) => setNoPrometer(e.target.value)} />
            </label>

            <label className="faq-form-label">
              Dato a confirmar
              <input className="faq-form-input" value={datoAConfirmar} onChange={(e) => setDatoAConfirmar(e.target.value)} />
            </label>

            <label className="faq-form-label">
              Palabras clave para la búsqueda (separadas por coma)
              <input
                className="faq-form-input"
                value={tagsTexto}
                onChange={(e) => setTagsTexto(e.target.value)}
                placeholder="caja mojada, pedido mojado, humedad"
              />
            </label>

            <label className="faq-form-label">
              Fuente / referencia (opcional)
              <input
                className="faq-form-input"
                value={fuente}
                onChange={(e) => setFuente(e.target.value)}
                placeholder="Ej: agregado por Ayelen · 24/09"
              />
            </label>
          </div>
          <div className="modal-footer">
            <button type="button" className="btn btn-secondary" onClick={onCancelar}>Cancelar</button>
            <button type="submit" className="btn btn-primary" disabled={guardando}>
              {guardando ? 'Guardando…' : casoInicial ? 'Guardar cambios' : 'Agregar caso'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default function FaqAtencionPanel({ mostrarToast, esAdmin }) {
  const [busqueda, setBusqueda] = useState('');
  const [categoriaActiva, setCategoriaActiva] = useState(atencionFaqCategorias[0]?.id || '');
  const [situacionActivaId, setSituacionActivaId] = useState(null);
  const [casosDb, setCasosDb] = useState([]);
  const [cargandoCasos, setCargandoCasos] = useState(true);
  const [avisoCasos, setAvisoCasos] = useState('');
  const [formAbierto, setFormAbierto] = useState(false);
  const [casoEditando, setCasoEditando] = useState(null);

  const cargarCasos = useCallback(async () => {
    setCargandoCasos(true);
    try {
      const res = await obtenerAtencionFaqCasos();
      setCasosDb(Array.isArray(res?.data) ? res.data : []);
      setAvisoCasos(res?.aviso || '');
    } catch (err) {
      mostrarToast?.(`No se pudieron cargar los casos agregados: ${err.message}`, 'error');
    } finally {
      setCargandoCasos(false);
    }
  }, [mostrarToast]);

  useEffect(() => { cargarCasos(); }, [cargarCasos]);

  const categorias = useMemo(() => construirCategorias(casosDb), [casosDb]);
  const situacionesFlat = useMemo(() => construirFlat(categorias), [categorias]);

  const buscando = busqueda.trim().length > 0;

  const situacionesFiltradas = useMemo(() => {
    if (!buscando) return null;
    return buscarSituaciones(busqueda, situacionesFlat);
  }, [busqueda, buscando, situacionesFlat]);

  const categoria = categorias.find((c) => c.id === categoriaActiva) || categorias[0];

  const situacionesVisibles = buscando
    ? situacionesFiltradas
    : (categoria?.situaciones || []).map((s) => ({
        ...s,
        categoriaId: categoria.id,
        categoriaNombre: categoria.nombre,
        categoriaIcon: categoria.icon,
      }));

  const situacionActiva = situacionesVisibles.find((s) => s.id === situacionActivaId)
    || (buscando ? situacionesVisibles[0] : null);

  const seleccionarCategoria = (id) => {
    setCategoriaActiva(id);
    setSituacionActivaId(null);
    setBusqueda('');
  };

  const totalSituaciones = situacionesFlat.length;

  const abrirFormNuevo = () => {
    setCasoEditando(null);
    setFormAbierto(true);
  };

  const abrirFormEditar = (situacion) => {
    const row = casosDb.find((c) => c.id === situacion.dbId);
    setCasoEditando(row || null);
    setFormAbierto(true);
  };

  const cerrarForm = () => {
    setFormAbierto(false);
    setCasoEditando(null);
  };

  const handleGuardarCaso = async (payload) => {
    try {
      if (casoEditando) {
        await actualizarAtencionFaqCaso(casoEditando.id, payload);
        mostrarToast?.('✅ Caso actualizado', 'success');
      } else {
        await crearAtencionFaqCaso(payload);
        mostrarToast?.('✅ Caso agregado a la guía', 'success');
      }
      cerrarForm();
      await cargarCasos();
    } catch (err) {
      mostrarToast?.(err.message || 'Error al guardar el caso', 'error');
    }
  };

  const handleEliminarCaso = async (situacion) => {
    if (!window.confirm(`¿Eliminar el caso "${situacion.pregunta}"? Esta acción no se puede deshacer.`)) return;
    try {
      await eliminarAtencionFaqCaso(situacion.dbId);
      mostrarToast?.('🗑️ Caso eliminado', 'success');
      if (situacionActivaId === situacion.id) setSituacionActivaId(null);
      await cargarCasos();
    } catch (err) {
      mostrarToast?.(err.message || 'Error al eliminar el caso', 'error');
    }
  };

  return (
    <div className="main-content">
      <div className="faq-wrapper">
        <div className="faq-header">
          <h2 style={{ margin: 0 }}>📖 Guía de Atención al Cliente</h2>
          <span className="faq-header-count">
            {totalSituaciones} situaciones · {categorias.length} temas
            {cargandoCasos ? ' · cargando…' : ''}
          </span>
          {esAdmin && (
            <button type="button" className="btn btn-primary btn-sm faq-agregar-btn" onClick={abrirFormNuevo}>
              ➕ Agregar caso
            </button>
          )}
        </div>

        {avisoCasos && (
          <div className="faq-aviso">⚠️ {avisoCasos}</div>
        )}

        <input
          type="text"
          placeholder="Buscar por palabra clave (ej: envío, lámpara, cambio, devolución)…"
          value={busqueda}
          onChange={(e) => {
            setBusqueda(e.target.value);
            setSituacionActivaId(null);
          }}
          className="faq-search-input"
        />

        <div className="faq-body">
          {!buscando && (
            <div className="faq-categorias">
              {categorias.map((cat) => (
                <button
                  key={cat.id}
                  type="button"
                  className={`faq-categoria-item ${cat.id === categoriaActiva ? 'faq-categoria-item-active' : ''}`}
                  onClick={() => seleccionarCategoria(cat.id)}
                  title={cat.descripcion}
                >
                  <span className="faq-categoria-icon">{cat.icon}</span>
                  <span className="faq-categoria-nombre">{cat.nombre}</span>
                  <span className="faq-categoria-count">{cat.situaciones.length}</span>
                </button>
              ))}
            </div>
          )}

          <div className="faq-situaciones">
            {!buscando && categoria?.descripcion && (
              <p className="faq-categoria-descripcion">{categoria.descripcion}</p>
            )}
            {buscando && (
              <p className="faq-categoria-descripcion">
                {situacionesVisibles.length === 0
                  ? 'Sin resultados para esa búsqueda.'
                  : `${situacionesVisibles.length} resultado(s) para "${busqueda}"`}
              </p>
            )}
            <div className="faq-situaciones-lista">
              {situacionesVisibles.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  className={`faq-situacion-item ${situacionActiva?.id === s.id ? 'faq-situacion-item-active' : ''}`}
                  onClick={() => setSituacionActivaId(s.id)}
                >
                  {buscando && <span className="faq-situacion-tema">{s.categoriaIcon} {s.categoriaNombre}</span>}
                  <span className="faq-situacion-pregunta">{s.pregunta}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="faq-detalle-wrapper">
            <SituacionDetalle
              situacion={situacionActiva}
              mostrarToast={mostrarToast}
              esAdmin={esAdmin}
              onEditar={abrirFormEditar}
              onEliminar={handleEliminarCaso}
            />
          </div>
        </div>
      </div>

      {formAbierto && (
        <CasoFormModal
          categorias={categorias}
          casoInicial={casoEditando}
          onCancelar={cerrarForm}
          onGuardar={handleGuardarCaso}
        />
      )}
    </div>
  );
}

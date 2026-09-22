import React, { useMemo, useState } from 'react';
import { atencionFaqCategorias, atencionFaqSituacionesFlat } from '../data/atencionFaq';

function normalizar(texto) {
  return String(texto || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

function coincide(situacion, query) {
  if (!query) return true;
  const q = normalizar(query);
  const campos = [
    situacion.pregunta,
    situacion.regla,
    situacion.respuesta,
    situacion.escalar,
    situacion.noPrometer,
    situacion.datoAConfirmar,
    ...(situacion.variantes || []).flatMap((v) => [v.condicion, v.respuesta]),
  ];
  return campos.some((c) => normalizar(c).includes(q));
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

function SituacionDetalle({ situacion, mostrarToast }) {
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

export default function FaqAtencionPanel({ mostrarToast }) {
  const [busqueda, setBusqueda] = useState('');
  const [categoriaActiva, setCategoriaActiva] = useState(atencionFaqCategorias[0]?.id || '');
  const [situacionActivaId, setSituacionActivaId] = useState(null);

  const buscando = busqueda.trim().length > 0;

  const situacionesFiltradas = useMemo(() => {
    if (!buscando) return null;
    return atencionFaqSituacionesFlat.filter((s) => coincide(s, busqueda));
  }, [busqueda, buscando]);

  const categoria = atencionFaqCategorias.find((c) => c.id === categoriaActiva) || atencionFaqCategorias[0];

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

  const totalSituaciones = atencionFaqSituacionesFlat.length;

  return (
    <div className="main-content">
      <div className="faq-wrapper">
        <div className="faq-header">
          <h2 style={{ margin: 0 }}>📖 Guía de Atención al Cliente</h2>
          <span className="faq-header-count">{totalSituaciones} situaciones · 12 temas</span>
        </div>

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
              {atencionFaqCategorias.map((cat) => (
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
            <SituacionDetalle situacion={situacionActiva} mostrarToast={mostrarToast} />
          </div>
        </div>
      </div>
    </div>
  );
}

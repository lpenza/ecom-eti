import React, { useEffect, useRef } from 'react';

// Pantalla bloqueante mientras se publica en Shopify / MercadoLibre. Muestra el
// paso en curso, la barra de avance y lo que ya quedó hecho (con ✅ / ❌).
// `progreso` = { mensaje, hechos, total, items: [{ plataforma, titulo, ok, error }] }
export default function ProgresoPublicacion({ titulo, progreso }) {
  const listaRef = useRef(null);
  const { mensaje, hechos = 0, total = 0, items = [] } = progreso || {};
  const pct = total > 0 ? Math.min(100, Math.round((hechos / total) * 100)) : 0;

  // Evita cerrar la pestaña a mitad de camino: quedaría una parte publicada y otra no.
  useEffect(() => {
    const avisar = (e) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', avisar);
    return () => window.removeEventListener('beforeunload', avisar);
  }, []);

  useEffect(() => {
    if (listaRef.current) listaRef.current.scrollTop = listaRef.current.scrollHeight;
  }, [items.length]);

  return (
    <div className="progreso-pub-overlay" role="alertdialog" aria-modal="true" aria-busy="true" aria-label={titulo}>
      <div className="progreso-pub-card">
        <div className="spinner progreso-pub-spinner" />
        <h3>{titulo}</h3>
        <p className="progreso-pub-mensaje" aria-live="polite">{mensaje || 'Conectando…'}</p>

        <div className="progreso-pub-barra" aria-hidden="true">
          <div
            className={`progreso-pub-relleno${total === 0 ? ' progreso-pub-indeterminado' : ''}`}
            style={total > 0 ? { width: `${pct}%` } : undefined}
          />
        </div>
        {total > 0 && <div className="progreso-pub-contador">{hechos} de {total} · {pct}%</div>}

        {items.length > 0 && (
          <ul className="progreso-pub-lista" ref={listaRef}>
            {items.map((it, i) => (
              <li key={i} className={it.ok ? '' : 'progreso-pub-fallo'}>
                <span>{it.ok ? '✅' : '❌'}</span>
                <span className="progreso-pub-plataforma">{it.plataforma}</span>
                <span className="progreso-pub-item">{it.titulo}</span>
                {!it.ok && it.error && <span className="progreso-pub-error">{it.error}</span>}
              </li>
            ))}
          </ul>
        )}

        <p className="progreso-pub-aviso">No cierres ni recargues la página hasta que termine.</p>
      </div>
    </div>
  );
}

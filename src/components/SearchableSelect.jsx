import React, { useEffect, useMemo, useRef, useState } from 'react';

const normalizar = (s) => String(s || '')
  .normalize('NFD')
  .replace(/[̀-ͯ]/g, '')
  .toLowerCase()
  .trim();

// Selector con búsqueda: muestra sólo el nombre, el value (id) queda interno.
// options: [{ value, label }]
export default function SearchableSelect({ value, options, onChange, placeholder = 'Buscar...', disabled = false }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);
  const rootRef = useRef(null);
  const listRef = useRef(null);

  const selected = options.find((o) => String(o.value) === String(value ?? ''));

  const filtradas = useMemo(() => {
    const q = normalizar(query);
    if (!q) return options;
    const palabras = q.split(/\s+/);
    const matches = options.filter((o) => {
      const label = normalizar(o.label);
      return palabras.every((p) => label.includes(p));
    });
    // Primero las que empiezan con lo buscado
    return matches.sort((a, b) => {
      const aStart = normalizar(a.label).startsWith(q) ? 0 : 1;
      const bStart = normalizar(b.label).startsWith(q) ? 0 : 1;
      return aStart - bStart;
    });
  }, [options, query]);

  useEffect(() => {
    if (!open) return;
    const onClick = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) cerrar();
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  useEffect(() => {
    const el = listRef.current?.children[highlight];
    if (el) el.scrollIntoView({ block: 'nearest' });
  }, [highlight, open]);

  const abrir = () => {
    if (disabled) return;
    setOpen(true);
    setQuery('');
    const idx = options.findIndex((o) => String(o.value) === String(value ?? ''));
    setHighlight(idx >= 0 ? idx : 0);
  };

  const cerrar = () => {
    setOpen(false);
    setQuery('');
  };

  const elegir = (opt) => {
    onChange(String(opt.value));
    cerrar();
  };

  const onKeyDown = (e) => {
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'Enter') { e.preventDefault(); abrir(); }
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlight((h) => Math.min(h + 1, filtradas.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (filtradas[highlight]) elegir(filtradas[highlight]);
    } else if (e.key === 'Escape' || e.key === 'Tab') {
      cerrar();
    }
  };

  return (
    <div className="searchable-select" ref={rootRef}>
      <input
        value={open ? query : (selected?.label || '')}
        placeholder={open ? (selected?.label || placeholder) : placeholder}
        onFocus={abrir}
        onClick={() => { if (!open) abrir(); }}
        onChange={(e) => { setQuery(e.target.value); setHighlight(0); if (!open) setOpen(true); }}
        onKeyDown={onKeyDown}
        disabled={disabled}
        autoComplete="off"
      />
      {open && (
        <ul className="searchable-select-list" ref={listRef}>
          {filtradas.length === 0 && <li className="searchable-select-empty">Sin resultados</li>}
          {filtradas.map((o, i) => (
            <li
              key={o.value}
              className={[
                i === highlight ? 'is-highlighted' : '',
                String(o.value) === String(value ?? '') ? 'is-selected' : '',
              ].join(' ')}
              onMouseDown={(e) => { e.preventDefault(); elegir(o); }}
              onMouseEnter={() => setHighlight(i)}
            >
              {o.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

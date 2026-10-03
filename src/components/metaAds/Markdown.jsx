import React from 'react';

// Markdown mínimo para los informes que redacta Claude (títulos, listas,
// negrita, cursiva, links, tablas, citas). Arma elementos de React: nunca
// inyecta HTML, así un texto con <script> se muestra como texto.

function enLinea(texto, clave = 'l') {
  const partes = [];
  const re = /(\*\*[^*]+\*\*|\*[^*\s][^*]*\*|`[^`]+`|\[[^\]]+\]\((https?:\/\/[^)\s]+)\))/g;
  let ultimo = 0;
  let m;
  let i = 0;
  while ((m = re.exec(texto))) {
    if (m.index > ultimo) partes.push(texto.slice(ultimo, m.index));
    const t = m[0];
    const k = `${clave}-${i++}`;
    if (t.startsWith('**')) partes.push(<strong key={k}>{t.slice(2, -2)}</strong>);
    else if (t.startsWith('`')) partes.push(<code key={k} className="num" style={{ fontSize: '0.92em', background: 'var(--c-bg)', padding: '1px 4px', borderRadius: 4 }}>{t.slice(1, -1)}</code>);
    else if (t.startsWith('[')) {
      const etiqueta = t.slice(1, t.indexOf(']('));
      partes.push(<a key={k} href={m[2]} target="_blank" rel="noreferrer" style={{ color: 'var(--c-accent)' }}>{etiqueta}</a>);
    } else partes.push(<em key={k}>{t.slice(1, -1)}</em>);
    ultimo = m.index + t.length;
  }
  if (ultimo < texto.length) partes.push(texto.slice(ultimo));
  return partes;
}

const celdas = (linea) => linea.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());

export default function Markdown({ texto }) {
  if (!texto) return null;
  const lineas = String(texto).replace(/\r\n/g, '\n').split('\n');
  const bloques = [];
  let i = 0;
  while (i < lineas.length) {
    const l = lineas[i];
    if (!l.trim()) { i++; continue; }
    const h = /^(#{1,4})\s+(.*)$/.exec(l);
    if (h) {
      const tam = { 1: 17, 2: 15, 3: 14, 4: 13.5 }[h[1].length];
      bloques.push(<div key={i} role="heading" aria-level={h[1].length + 2} style={{ fontSize: tam, fontWeight: 600, margin: '14px 0 6px' }}>{enLinea(h[2], `h${i}`)}</div>);
      i++;
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(l) && /^\s*\|?\s*:?-{2,}/.test(lineas[i + 1] || '')) {
      const cabecera = celdas(l);
      const filas = [];
      i += 2;
      while (i < lineas.length && /^\s*\|.*\|\s*$/.test(lineas[i])) { filas.push(celdas(lineas[i])); i++; }
      bloques.push(
        <div key={`t${i}`} className="lista" style={{ overflowX: 'auto', margin: '6px 0' }}>
          <table className="tabla">
            <thead><tr>{cabecera.map((c, j) => <th key={j} style={{ textAlign: 'left' }}>{enLinea(c, `th${j}`)}</th>)}</tr></thead>
            <tbody>{filas.map((f, r) => <tr key={r}>{f.map((c, j) => <td key={j} style={{ textAlign: 'left', whiteSpace: 'normal' }}>{enLinea(c, `td${r}${j}`)}</td>)}</tr>)}</tbody>
          </table>
        </div>,
      );
      continue;
    }
    if (/^\s*([-*•]|\d+[.)])\s+/.test(l)) {
      const ordenada = /^\s*\d+[.)]/.test(l);
      const items = [];
      while (i < lineas.length && /^\s*([-*•]|\d+[.)])\s+/.test(lineas[i])) {
        const sangria = /^\s*/.exec(lineas[i])[0].length;
        items.push(<li key={i} style={{ marginLeft: sangria ? 16 : 0, marginBottom: 3 }}>{enLinea(lineas[i].replace(/^\s*([-*•]|\d+[.)])\s+/, ''), `li${i}`)}</li>);
        i++;
      }
      const Lista = ordenada ? 'ol' : 'ul';
      bloques.push(<Lista key={`l${i}`} style={{ margin: '4px 0 8px', paddingLeft: 20 }}>{items}</Lista>);
      continue;
    }
    if (/^>\s?/.test(l)) {
      const citas = [];
      while (i < lineas.length && /^>\s?/.test(lineas[i])) { citas.push(lineas[i].replace(/^>\s?/, '')); i++; }
      bloques.push(<blockquote key={`q${i}`} style={{ margin: '6px 0', padding: '6px 12px', borderLeft: '2px solid var(--c-border-strong)', color: 'var(--c-soft)' }}>{enLinea(citas.join(' '), `q${i}`)}</blockquote>);
      continue;
    }
    if (/^-{3,}\s*$/.test(l)) { bloques.push(<hr key={i} style={{ border: 0, borderTop: '1px solid var(--c-border)', margin: '12px 0' }} />); i++; continue; }
    const parrafo = [];
    while (i < lineas.length && lineas[i].trim() && !/^(#{1,4}\s|\s*([-*•]|\d+[.)])\s+|>|\s*\|)/.test(lineas[i])) { parrafo.push(lineas[i]); i++; }
    if (!parrafo.length) { parrafo.push(lineas[i]); i++; }
    bloques.push(<p key={`p${i}`} style={{ margin: '0 0 8px', lineHeight: 1.55 }}>{enLinea(parrafo.join(' '), `p${i}`)}</p>);
  }
  return <div style={{ fontSize: 13.5, color: 'var(--c-text)' }}>{bloques}</div>;
}

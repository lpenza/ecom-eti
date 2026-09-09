import React, { useState, useEffect, useCallback, useRef } from 'react';
import { obtenerEmailAliases, obtenerEmails, obtenerEmail, enviarEmail, obtenerFirmasEmail, guardarFirmaEmail, descargarAdjunto } from '../services/api';

const MAX_ADJUNTOS_BYTES = 12 * 1024 * 1024; // ~12 MB (queda bajo el límite de 15mb del server)

function formatBytes(n) {
  const b = Number(n) || 0;
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

// Lee un File del navegador a base64 (sin el prefijo data:).
function leerArchivoBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const dataUrl = String(r.result || '');
      resolve({
        filename: file.name,
        content: dataUrl.split(',')[1] || '',
        contentType: file.type || 'application/octet-stream',
        size: file.size,
      });
    };
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

function formatFecha(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const hoy = new Date();
  const mismoDia = d.toDateString() === hoy.toDateString();
  return mismoDia
    ? d.toLocaleTimeString('es-UY', { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString('es-UY', { day: '2-digit', month: '2-digit', year: '2-digit' });
}

function nombreRemitente(addr) {
  if (!addr) return '(desconocido)';
  return addr.name || addr.address || '(desconocido)';
}

function aliasLabel(alias) {
  if (alias === 'all') return 'Todos los correos';
  return alias;
}

// Parte local del alias (ventas@velinne.com → "ventas") para el flag de la bandeja.
function aliasChip(alias) {
  if (!alias) return '';
  return String(alias).split('@')[0];
}

// Color estable por alias (deriva del texto) para distinguirlos de un vistazo.
function aliasColor(alias) {
  if (!alias) return null;
  let h = 0;
  for (let i = 0; i < alias.length; i += 1) h = (h * 31 + alias.charCodeAt(i)) % 360;
  return `hsl(${h}, 55%, 42%)`;
}

const POLL_MS = 45000; // auto-actualización de la bandeja

// Firma por defecto si el alias todavía no tiene una cargada en la base.
// Usa el wordmark VELINNE (imagen alojada) + datos, con tablas y estilos inline
// (lo más compatible con Gmail/Outlook). alt="VELINNE" cubre el caso en que el
// cliente bloquee imágenes.
function firmaPorDefecto(/* alias */) {
  return `<table cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;font-family:Arial,Helvetica,sans-serif;margin-top:18px;background:#fff8fb;">
  <tr>
    <td style="border-left:4px solid #6d1f3a;padding:16px 20px;vertical-align:middle;">
      <img src="https://i.imgur.com/WbP8QZX.png" alt="VELINNE" width="165" style="display:block;border:0;outline:none;text-decoration:none;">
    </td>
    <td style="padding:14px 20px;vertical-align:top;border-left:1px solid #ead9df;">
      <div style="font-size:15px;font-weight:700;color:#3a2530;">Flor &#128156;</div>
      <div style="font-size:12px;color:#7b2f4d;margin-bottom:8px;">Equipo Velinne | Atenci&oacute;n personalizada</div>
      <div style="font-size:12px;color:#76636d;margin-bottom:8px;">U&ntilde;as de Gel UV &middot; Ediciones limitadas</div>
      <div style="font-size:12px;color:#3a2530;line-height:1.8;">
        &#127760; <a href="https://www.velinneuy.com" style="color:#7b2f4d;text-decoration:none;">www.velinneuy.com</a><br>
        &#128231; <a href="mailto:velinneuy@gmail.com" style="color:#7b2f4d;text-decoration:none;">velinneuy@gmail.com</a><br>
        &#128241; <a href="tel:+59895406741" style="color:#7b2f4d;text-decoration:none;">+598 95 406 741</a>
      </div>
      <div style="font-size:11px;font-style:italic;color:#a0356a;margin-top:8px;">Preventas activas &middot; Unidades limitadas</div>
    </td>
  </tr>
</table>`;
}

// Convierte el texto plano del compositor en HTML simple (respeta saltos de línea).
function textoAHtml(texto) {
  const escapado = String(texto || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#222;white-space:pre-wrap;">${escapado}</div>`;
}

// Versión en texto plano de un fragmento HTML (para la parte text/plain del correo).
function htmlAtexto(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export default function EmailsPanel({ mostrarToast }) {
  const [aliasInfo, setAliasInfo] = useState({ canSeeAll: false, aliases: [], defaultAlias: null });
  const [alias, setAlias] = useState('all');
  const [folder, setFolder] = useState('inbox'); // 'inbox' (recibidos) | 'sent' (enviados)
  const [mensajes, setMensajes] = useState([]);
  const [loadingList, setLoadingList] = useState(false);
  const [seleccionado, setSeleccionado] = useState(null); // mensaje completo
  const [loadingMsg, setLoadingMsg] = useState(false);
  const [compose, setCompose] = useState(null); // { from, to, cc, subject, body, inReplyTo, references }
  const [enviando, setEnviando] = useState(false);
  const [cargadaUnaVez, setCargadaUnaVez] = useState(false);
  const [firmas, setFirmas] = useState({});          // { alias: htmlFirma }
  const [incluirFirma, setIncluirFirma] = useState(true);
  const [firmasDraft, setFirmasDraft] = useState(null); // editor de firmas (admin)
  const [guardandoFirma, setGuardandoFirma] = useState(false);

  // mostrarToast se recrea en cada render del App; lo guardamos en un ref para que
  // los efectos/callbacks no cambien de identidad y no se disparen en bucle.
  const toastRef = useRef(mostrarToast);
  useEffect(() => { toastRef.current = mostrarToast; }, [mostrarToast]);

  const aliasRef = useRef(alias);         // alias vigente para el polling
  useEffect(() => { aliasRef.current = alias; }, [alias]);
  const folderRef = useRef(folder);       // carpeta vigente para el polling
  useEffect(() => { folderRef.current = folder; }, [folder]);
  const cacheRef = useRef(new Map());     // `${folder}:${uid}` → mensaje completo (reabrir instantáneo)

  // Cargar alias permitidos al montar (una sola vez).
  useEffect(() => {
    let cancelled = false;
    obtenerEmailAliases()
      .then((data) => {
        if (cancelled) return;
        setAliasInfo(data);
        setAlias(data.defaultAlias || 'all');
      })
      .catch((err) => {
        if (cancelled) return;
        toastRef.current?.(err.message || 'No se pudieron cargar los buzones', 'error');
      });
    return () => { cancelled = true; };
  }, []);

  // silent=true → recarga en segundo plano (polling): no muestra el indicador ni
  // pisa la lista si falla; solo actualiza si hay cambios reales.
  // Cargar firmas por alias (una vez).
  useEffect(() => {
    obtenerFirmasEmail()
      .then((data) => setFirmas(data?.firmas || {}))
      .catch(() => { /* si falla, se usan las firmas por defecto */ });
  }, []);

  // Firma efectiva de un alias (la cargada, o la de por defecto).
  const firmaDe = useCallback((a) => (firmas[a] != null ? firmas[a] : firmaPorDefecto(a)), [firmas]);

  const cargarBandeja = useCallback(async (aliasActual, { silent = false, folderActual = folderRef.current } = {}) => {
    if (!silent) setLoadingList(true);
    try {
      const data = await obtenerEmails({ alias: aliasActual, limit: 50, folder: folderActual });
      const nuevos = Array.isArray(data.mensajes) ? data.mensajes : [];
      setMensajes((prev) => {
        // Evita re-render si nada cambió (mismos uids en el mismo orden).
        const igual = prev.length === nuevos.length && prev.every((m, i) => m.uid === nuevos[i].uid && m.seen === nuevos[i].seen);
        return igual ? prev : nuevos;
      });
    } catch (err) {
      if (!silent) {
        toastRef.current?.(err.message || 'Error al leer la bandeja', 'error');
        setMensajes([]);
      }
    } finally {
      if (!silent) setLoadingList(false);
      setCargadaUnaVez(true);
    }
  }, []);

  // Carga la bandeja cuando cambia el alias o la carpeta (no en cada render).
  useEffect(() => {
    if (alias) cargarBandeja(alias, { folderActual: folder });
  }, [alias, folder, cargarBandeja]);

  // Auto-actualización: cada POLL_MS y al volver el foco a la pestaña. En segundo
  // plano, sin tocar el correo abierto ni la selección.
  useEffect(() => {
    const tick = () => {
      if (typeof document !== 'undefined' && document.hidden) return;
      if (aliasRef.current) cargarBandeja(aliasRef.current, { silent: true, folderActual: folderRef.current });
    };
    const id = setInterval(tick, POLL_MS);
    window.addEventListener('focus', tick);
    return () => { clearInterval(id); window.removeEventListener('focus', tick); };
  }, [cargarBandeja]);

  const abrirMensaje = async (uid) => {
    const cacheKey = `${folder}:${uid}`;
    // Reabrir desde cache es instantáneo; igual revalidamos en segundo plano.
    const cacheado = cacheRef.current.get(cacheKey);
    if (cacheado) {
      setSeleccionado(cacheado);
      setLoadingMsg(false);
    } else {
      setLoadingMsg(true);
      setSeleccionado(null);
    }
    setMensajes((prev) => prev.map((m) => (m.uid === uid ? { ...m, seen: true } : m)));
    try {
      const data = await obtenerEmail(uid, folder);
      cacheRef.current.set(cacheKey, data.mensaje);
      // Solo actualizar la vista si el usuario sigue en este correo.
      setSeleccionado((actual) => (!actual || actual.uid === uid ? data.mensaje : actual));
    } catch (err) {
      if (!cacheado) toastRef.current?.(err.message || 'No se pudo abrir el correo', 'error');
    } finally {
      setLoadingMsg(false);
    }
  };

  const cambiarCarpeta = (nueva) => {
    if (nueva === folder) return;
    setSeleccionado(null);
    setFolder(nueva);
  };

  // Descargar un adjunto de un correo abierto.
  const descargarAdjuntoDe = async (att) => {
    if (!seleccionado) return;
    try {
      const blob = await descargarAdjunto(seleccionado.uid, att.id, folder);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = att.filename || 'adjunto';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    } catch (err) {
      toastRef.current?.(err.message || 'No se pudo descargar el adjunto', 'error');
    }
  };

  // Adjuntar archivos en el compositor.
  const agregarAdjuntos = async (fileList) => {
    const files = Array.from(fileList || []);
    if (files.length === 0) return;
    try {
      const nuevos = await Promise.all(files.map(leerArchivoBase64));
      setCompose((c) => (c ? { ...c, attachments: [...(c.attachments || []), ...nuevos] } : c));
    } catch {
      toastRef.current?.('No se pudieron leer algunos archivos', 'error');
    }
  };

  const quitarAdjunto = (idx) => {
    setCompose((c) => (c ? { ...c, attachments: (c.attachments || []).filter((_, i) => i !== idx) } : c));
  };

  // Remitente por defecto para el compositor
  const remitentePorDefecto = aliasInfo.canSeeAll
    ? (aliasInfo.aliases[0] || '')
    : (aliasInfo.aliases[0] || '');

  const abrirNuevo = () => {
    setIncluirFirma(true);
    setCompose({ from: remitentePorDefecto, to: '', cc: '', subject: '', body: '', inReplyTo: null, references: null, attachments: [] });
  };

  // ===== Editor de firmas (admin) =====
  const abrirEditorFirmas = () => {
    const draft = {};
    aliasInfo.aliases.forEach((a) => { draft[a] = firmas[a] != null ? firmas[a] : firmaPorDefecto(a); });
    setFirmasDraft(draft);
  };

  const guardarFirmas = async () => {
    if (!firmasDraft) return;
    setGuardandoFirma(true);
    try {
      const entradas = Object.entries(firmasDraft);
      await Promise.all(entradas.map(([a, html]) => guardarFirmaEmail(a, html)));
      setFirmas((prev) => ({ ...prev, ...firmasDraft }));
      setFirmasDraft(null);
      toastRef.current?.('✅ Firmas guardadas', 'success');
    } catch (err) {
      toastRef.current?.(err.message || 'Error al guardar las firmas', 'error');
    } finally {
      setGuardandoFirma(false);
    }
  };

  const abrirRespuesta = (msg) => {
    if (!msg) return;
    const asunto = String(msg.subject || '');
    const reSubject = /^re:/i.test(asunto) ? asunto : `Re: ${asunto}`;
    const citado = `\n\n\n--------\nEl ${formatFecha(msg.date)}, ${nombreRemitente(msg.from)} escribió:\n> ${String(msg.text || '').replace(/\n/g, '\n> ')}`;
    // En Enviados el destinatario de la respuesta es el destinatario original (To),
    // no nosotros; el remitente vuelve a ser el alias con el que se envió.
    const esEnviado = folder === 'sent';
    const destino = esEnviado ? (msg.to?.[0]?.address || '') : (msg.from?.address || '');
    const desde = (esEnviado && msg.alias) ? msg.alias : remitentePorDefecto;
    setIncluirFirma(true);
    setCompose({
      from: desde,
      to: destino,
      cc: '',
      subject: reSubject,
      body: citado,
      inReplyTo: msg.messageId || null,
      references: msg.references || msg.messageId || null,
      attachments: [],
    });
  };

  const handleEnviar = async () => {
    if (!compose) return;
    if (!compose.to.trim()) { mostrarToast?.('Falta el destinatario', 'warning'); return; }
    const adjuntos = compose.attachments || [];
    const totalBytes = adjuntos.reduce((acc, a) => acc + (a.size || 0), 0);
    if (totalBytes > MAX_ADJUNTOS_BYTES) {
      mostrarToast?.(`Los adjuntos superan el máximo (${formatBytes(MAX_ADJUNTOS_BYTES)})`, 'warning');
      return;
    }
    setEnviando(true);
    try {
      const firmaHtml = incluirFirma ? firmaDe(compose.from) : '';
      const firmaTxt = incluirFirma ? htmlAtexto(firmaHtml) : '';
      const payload = {
        from: compose.from || undefined,
        to: compose.to.trim(),
        cc: compose.cc.trim() || undefined,
        subject: compose.subject.trim() || '(sin asunto)',
        html: textoAHtml(compose.body) + firmaHtml,
        text: compose.body + (firmaTxt ? `\n\n${firmaTxt}` : ''),
        attachments: adjuntos.map((a) => ({ filename: a.filename, content: a.content, contentType: a.contentType })),
        inReplyTo: compose.inReplyTo || undefined,
        references: compose.references || undefined,
      };
      await enviarEmail(payload);
      mostrarToast?.('✅ Correo enviado', 'success');
      setCompose(null);
    } catch (err) {
      mostrarToast?.(err.message || 'Error al enviar el correo', 'error');
    } finally {
      setEnviando(false);
    }
  };

  return (
    <div className="emails-panel">
      <div className="emails-header">
        <h2 className="emails-title">📧 EMAILS</h2>
        <div className="emails-header-actions">
          <div className="emails-folder-tabs" role="tablist">
            <button
              type="button"
              className={`emails-folder-tab ${folder === 'inbox' ? 'emails-folder-tab-active' : ''}`}
              onClick={() => cambiarCarpeta('inbox')}
            >
              📥 Recibidos
            </button>
            <button
              type="button"
              className={`emails-folder-tab ${folder === 'sent' ? 'emails-folder-tab-active' : ''}`}
              onClick={() => cambiarCarpeta('sent')}
            >
              📤 Enviados
            </button>
          </div>
          {aliasInfo.canSeeAll ? (
            <select
              className="emails-alias-select"
              value={alias}
              onChange={(e) => { setAlias(e.target.value); setSeleccionado(null); }}
            >
              <option value="all">Todos los correos</option>
              {aliasInfo.aliases.map((a) => (
                <option key={a} value={a}>{a}</option>
              ))}
            </select>
          ) : (
            <span className="emails-alias-badge">{aliasInfo.aliases[0] || '—'}</span>
          )}
          <button type="button" className="emails-btn" onClick={() => cargarBandeja(alias)} disabled={loadingList}>
            {loadingList ? 'Actualizando…' : '🔄 Actualizar'}
          </button>
          {aliasInfo.canSeeAll && (
            <button type="button" className="emails-btn" onClick={abrirEditorFirmas} title="Editar las firmas por alias">
              ✍️ Firmas
            </button>
          )}
          <button type="button" className="emails-btn emails-btn-primary" onClick={abrirNuevo}>
            ✏️ Nuevo
          </button>
        </div>
      </div>

      <div className="emails-body">
        <div className="emails-list">
          {loadingList && mensajes.length > 0 && (
            <div className="emails-list-refreshing">Actualizando…</div>
          )}
          {!cargadaUnaVez && mensajes.length === 0 && (
            <div className="emails-empty">Cargando bandeja…</div>
          )}
          {cargadaUnaVez && !loadingList && mensajes.length === 0 && (
            <div className="emails-empty">
              No hay correos {folder === 'sent' ? 'enviados' : `en ${aliasLabel(alias)}`}.
            </div>
          )}
          {mensajes.map((m) => (
            <button
              key={m.uid}
              type="button"
              className={`emails-list-item ${seleccionado?.uid === m.uid ? 'emails-list-item-active' : ''} ${m.seen ? '' : 'emails-list-item-unread'}`}
              onClick={() => abrirMensaje(m.uid)}
            >
              <div className="emails-list-row">
                <span className="emails-list-from">
                  {folder === 'sent'
                    ? `Para: ${m.to?.[0] ? nombreRemitente(m.to[0]) : '—'}`
                    : nombreRemitente(m.from)}
                </span>
                <span className="emails-list-date">{formatFecha(m.date)}</span>
              </div>
              <div className="emails-list-subject-row">
                <span className="emails-list-subject">{m.subject}</span>
                {m.alias && (
                  <span className="emails-alias-flag" style={{ backgroundColor: aliasColor(m.alias) }} title={`Recibido en ${m.alias}`}>
                    {aliasChip(m.alias)}
                  </span>
                )}
              </div>
            </button>
          ))}
        </div>

        <div className="emails-reader">
          {loadingMsg && <div className="emails-empty">Abriendo correo…</div>}
          {!loadingMsg && !seleccionado && (
            <div className="emails-empty">Seleccioná un correo para leerlo.</div>
          )}
          {!loadingMsg && seleccionado && (
            <>
              <div className="emails-reader-head">
                <div className="emails-reader-subject-row">
                  <h3 className="emails-reader-subject">{seleccionado.subject}</h3>
                  {seleccionado.alias && (
                    <span className="emails-alias-flag" style={{ backgroundColor: aliasColor(seleccionado.alias) }} title={`Recibido en ${seleccionado.alias}`}>
                      {seleccionado.alias}
                    </span>
                  )}
                </div>
                <div className="emails-reader-meta">
                  <div><strong>De:</strong> {nombreRemitente(seleccionado.from)} &lt;{seleccionado.from?.address}&gt;</div>
                  <div><strong>Para:</strong> {(seleccionado.to || []).map((t) => t.address).join(', ')}</div>
                  {(seleccionado.cc || []).length > 0 && (
                    <div><strong>Cc:</strong> {seleccionado.cc.map((t) => t.address).join(', ')}</div>
                  )}
                  <div><strong>Fecha:</strong> {new Date(seleccionado.date).toLocaleString('es-UY')}</div>
                </div>
                <button type="button" className="emails-btn emails-btn-primary" onClick={() => abrirRespuesta(seleccionado)}>
                  ↩️ Responder
                </button>
              </div>
              {(seleccionado.attachments || []).length > 0 && (
                <div className="emails-adjuntos">
                  <span className="emails-adjuntos-label">📎 {seleccionado.attachments.length} adjunto(s):</span>
                  {seleccionado.attachments.map((att) => (
                    <button
                      key={att.id}
                      type="button"
                      className="emails-adjunto-chip"
                      onClick={() => descargarAdjuntoDe(att)}
                      title={`Descargar ${att.filename}`}
                    >
                      ⬇ {att.filename} <span className="emails-adjunto-size">({formatBytes(att.size)})</span>
                    </button>
                  ))}
                </div>
              )}
              <iframe
                title="Contenido del correo"
                className="emails-reader-body"
                sandbox=""
                srcDoc={seleccionado.html || textoAHtml(seleccionado.text)}
              />
            </>
          )}
        </div>
      </div>

      {compose && (
        <div className="emails-compose-overlay" onClick={(e) => { if (e.target === e.currentTarget) setCompose(null); }}>
          <div className="emails-compose">
            <div className="emails-compose-head">
              <h3>{compose.inReplyTo ? 'Responder' : 'Nuevo correo'}</h3>
              <button type="button" className="emails-compose-close" onClick={() => setCompose(null)}>✕</button>
            </div>
            <div className="emails-compose-body">
              <label className="emails-field">
                <span>De</span>
                {aliasInfo.canSeeAll ? (
                  <select
                    value={compose.from}
                    onChange={(e) => setCompose({ ...compose, from: e.target.value })}
                  >
                    {aliasInfo.aliases.map((a) => (
                      <option key={a} value={a}>{a}</option>
                    ))}
                  </select>
                ) : (
                  <input type="text" value={aliasInfo.aliases[0] || ''} disabled />
                )}
              </label>
              <label className="emails-field">
                <span>Para</span>
                <input
                  type="email"
                  value={compose.to}
                  placeholder="destinatario@ejemplo.com"
                  onChange={(e) => setCompose({ ...compose, to: e.target.value })}
                />
              </label>
              <label className="emails-field">
                <span>Cc</span>
                <input
                  type="text"
                  value={compose.cc}
                  placeholder="opcional"
                  onChange={(e) => setCompose({ ...compose, cc: e.target.value })}
                />
              </label>
              <label className="emails-field">
                <span>Asunto</span>
                <input
                  type="text"
                  value={compose.subject}
                  onChange={(e) => setCompose({ ...compose, subject: e.target.value })}
                />
              </label>
              <textarea
                className="emails-compose-textarea"
                value={compose.body}
                placeholder="Escribí tu mensaje…"
                onChange={(e) => setCompose({ ...compose, body: e.target.value })}
              />
              <div className="emails-firma-zona">
                <label className="emails-firma-toggle">
                  <input type="checkbox" checked={incluirFirma} onChange={(e) => setIncluirFirma(e.target.checked)} />
                  Incluir firma de {compose.from}
                </label>
                {incluirFirma && (
                  <div className="emails-firma-preview" dangerouslySetInnerHTML={{ __html: firmaDe(compose.from) }} />
                )}
              </div>

              <div className="emails-adjuntar">
                <label className="emails-btn emails-adjuntar-btn">
                  📎 Adjuntar archivos
                  <input
                    type="file"
                    multiple
                    hidden
                    onChange={(e) => { agregarAdjuntos(e.target.files); e.target.value = ''; }}
                  />
                </label>
                {(compose.attachments || []).length > 0 && (
                  <div className="emails-adjuntos-lista">
                    {compose.attachments.map((a, idx) => (
                      <span key={idx} className="emails-adjunto-chip emails-adjunto-chip-editable">
                        📄 {a.filename} <span className="emails-adjunto-size">({formatBytes(a.size)})</span>
                        <button type="button" className="emails-adjunto-quitar" onClick={() => quitarAdjunto(idx)} title="Quitar">✕</button>
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>
            <div className="emails-compose-foot">
              <button type="button" className="emails-btn" onClick={() => setCompose(null)}>Cancelar</button>
              <button type="button" className="emails-btn emails-btn-primary" onClick={handleEnviar} disabled={enviando}>
                {enviando ? 'Enviando…' : '📤 Enviar'}
              </button>
            </div>
          </div>
        </div>
      )}

      {firmasDraft && (
        <div className="emails-compose-overlay" onClick={(e) => { if (e.target === e.currentTarget) setFirmasDraft(null); }}>
          <div className="emails-compose emails-firmas-editor">
            <div className="emails-compose-head">
              <h3>✍️ Firmas por alias</h3>
              <button type="button" className="emails-compose-close" onClick={() => setFirmasDraft(null)}>✕</button>
            </div>
            <div className="emails-compose-body">
              <p className="emails-firma-ayuda">
                Se agregan al final de cada correo que envíes desde ese alias. Podés usar HTML (negrita, enlaces, etc.).
              </p>
              {Object.keys(firmasDraft).map((a) => (
                <div key={a} className="emails-firma-editor-item">
                  <div className="emails-firma-editor-label">
                    <span className="emails-alias-flag" style={{ backgroundColor: aliasColor(a) }}>{aliasChip(a)}</span>
                    {a}
                  </div>
                  <textarea
                    className="emails-firma-editor-textarea"
                    value={firmasDraft[a]}
                    onChange={(e) => setFirmasDraft({ ...firmasDraft, [a]: e.target.value })}
                  />
                  <div className="emails-firma-editor-preview">
                    <span className="emails-firma-editor-preview-label">Vista previa:</span>
                    <div dangerouslySetInnerHTML={{ __html: firmasDraft[a] }} />
                  </div>
                </div>
              ))}
            </div>
            <div className="emails-compose-foot">
              <button type="button" className="emails-btn" onClick={() => setFirmasDraft(null)}>Cancelar</button>
              <button type="button" className="emails-btn emails-btn-primary" onClick={guardarFirmas} disabled={guardandoFirma}>
                {guardandoFirma ? 'Guardando…' : '💾 Guardar firmas'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

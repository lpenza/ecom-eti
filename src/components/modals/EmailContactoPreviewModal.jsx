import React, { useState, useEffect } from 'react';
import { previewEmailContacto } from '../../services/api';
import { cierreFuera } from '../../utils/cierreModal';

// Preview del email de contacto de un pedido en "Pendientes de Contacto".
// El servidor arma el correo tal cual se va a enviar (desde info@, con su firma
// y la plantilla elegida); recién al confirmar se envía.
const ASUNTO_DEFAULT = 'Seguimiento de tu pedido #{{numero_pedido}}';

export default function EmailContactoPreviewModal({ pedido, plantilla, onEnviar, onClose, mostrarToast }) {
  const [asunto, setAsunto] = useState(ASUNTO_DEFAULT);
  const [preview, setPreview] = useState(null); // { from, to, subject, html }
  const [cargando, setCargando] = useState(true);
  const [enviando, setEnviando] = useState(false);

  // Se vuelve a armar al cambiar el asunto (con un respiro para no pedir por tecla).
  useEffect(() => {
    let cancelado = false;
    setCargando(true);
    const t = setTimeout(async () => {
      try {
        const res = await previewEmailContacto(pedido.id, {
          subjectTemplate: asunto.trim() || ASUNTO_DEFAULT,
          htmlTemplate: plantilla?.content || '',
        });
        if (!cancelado) setPreview(res);
      } catch (err) {
        if (!cancelado) {
          mostrarToast?.(err.message || 'No se pudo armar el preview', 'error');
          onClose();
        }
      } finally {
        if (!cancelado) setCargando(false);
      }
    }, 350);
    return () => { cancelado = true; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asunto, pedido.id, plantilla?.id]);

  async function enviar() {
    setEnviando(true);
    try {
      const ok = await onEnviar(asunto.trim() || ASUNTO_DEFAULT);
      if (ok) onClose();
    } finally {
      setEnviando(false);
    }
  }

  return (
    <div
      className="modal modal-open"
      {...cierreFuera(onClose, { bloqueado: enviando, mensaje: '¿Cerrar sin enviar el email?' })}
    >
      <div className="modal-content modal-medium" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>✉️ Email de contacto · Pedido #{pedido.numero_pedido}</h3>
          <button className="btn-close" onClick={onClose} disabled={enviando}>&times;</button>
        </div>

        <div className="modal-body email-contacto-preview">
          <div className="email-contacto-meta">
            <div><strong>De:</strong> {preview?.from || 'info@'}</div>
            <div><strong>Para:</strong> {preview?.to || pedido.cliente_email}</div>
            <div><strong>Plantilla:</strong> {plantilla?.name || 'Mensaje por defecto'}</div>
          </div>

          <label className="email-contacto-asunto">
            <strong>Asunto</strong>
            <input
              value={asunto}
              onChange={(e) => setAsunto(e.target.value)}
              disabled={enviando}
              placeholder={ASUNTO_DEFAULT}
            />
            <small>Podés usar {'{{numero_pedido}}'} y {'{{cliente_nombre}}'}. Queda: <em>{preview?.subject || '…'}</em></small>
          </label>

          <div className="email-contacto-cuerpo">
            {cargando && !preview ? (
              <p>Armando el correo…</p>
            ) : (
              <iframe title="Preview del email" sandbox="" srcDoc={preview?.html || ''} />
            )}
          </div>
        </div>

        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose} disabled={enviando}>Cancelar</button>
          <button className="btn btn-primary" onClick={enviar} disabled={!preview || cargando || enviando}>
            {enviando ? 'Enviando…' : '✉️ Enviar email'}
          </button>
        </div>
      </div>
    </div>
  );
}

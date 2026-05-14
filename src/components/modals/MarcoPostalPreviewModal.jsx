import React, { useEffect, useState } from 'react';
import { previewGuiaMarcoPostal, generarGuiaMarcoPostalWeb } from '../../services/api';

function MarcoPostalPreviewModal({ pedidoId, numeroPedido, onClose, onGenerada }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [data, setData] = useState(null);
  const [overrides, setOverrides] = useState({});
  const [submitting, setSubmitting] = useState(false);
  const [generated, setGenerated] = useState(null); // { guiaId, labelUrl }

  const ref = numeroPedido || pedidoId;

  useEffect(() => {
    let cancel = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const resp = await previewGuiaMarcoPostal(ref);
        if (cancel) return;
        if (!resp?.success) throw new Error(resp?.error || 'Error obteniendo preview');
        setData(resp.data);
        setOverrides({});
      } catch (e) {
        if (!cancel) setError(e.message);
      } finally {
        if (!cancel) setLoading(false);
      }
    })();
    return () => {
      cancel = true;
    };
  }, [ref]);

  const setField = (key, value) => setOverrides((prev) => ({ ...prev, [key]: value }));
  const getField = (key) => (key in overrides ? overrides[key] : data?.payload?.[key] ?? '');

  const handleGenerar = async () => {
    if (!data) return;
    if (!confirm('¿Confirmás generar la guía en MarcoPostal con estos datos?')) return;
    setSubmitting(true);
    setError(null);
    try {
      const resp = await generarGuiaMarcoPostalWeb(ref, overrides);
      if (!resp?.success) throw new Error(resp?.error || 'Error generando guía');
      setGenerated({ guiaId: resp.data?.guiaId, labelUrl: resp.data?.labelUrl, externalUrl: resp.data?.externalUrl });
      onGenerada?.(resp.data);
    } catch (e) {
      setError(e.message);
    } finally {
      setSubmitting(false);
    }
  };

  const isPickup = data?.isPickup || data?.resolved?.modo === 'pickup';
  const destinoSource = data?.resolved?.destino?.source;
  const geoSource = data?.resolved?.destino?.geoSource;
  const sourceLabel = {
    table: 'Mapeado en BD',
    runtime: 'Buscado en vivo',
    unresolved: 'Sin resolver',
    none: 'Sin datos',
  }[destinoSource] || destinoSource;

  return (
    <div className="modal modal-open">
      <div className="modal-content modal-large">
        <div className="modal-header">
          <h3>Generar etiqueta MarcoPostal — Pedido #{numeroPedido || ref}</h3>
          <button className="btn-close" onClick={onClose}>✕</button>
        </div>

        <div className="modal-body">
          {loading && <p>Cargando preview…</p>}
          {error && (
            <div style={{ background: '#ffe5e5', padding: 12, borderRadius: 6, marginBottom: 12 }}>
              <strong>Error:</strong> {error}
            </div>
          )}

          {generated?.labelUrl && (
            <div style={{ marginBottom: 12 }}>
              <div style={{ background: '#e6f6e9', padding: 10, borderRadius: 6, marginBottom: 8 }}>
                ✅ Guía generada — Nº <strong>{generated.guiaId}</strong>
                {generated.externalUrl && (
                  <a href={generated.externalUrl} target="_blank" rel="noreferrer" style={{ marginLeft: 12 }}>
                    Abrir en MarcoPostal ↗
                  </a>
                )}
              </div>
              <iframe
                src={generated.labelUrl}
                title="Etiqueta MarcoPostal"
                style={{ width: '100%', height: 520, border: '1px solid #ccc', borderRadius: 4 }}
              />
            </div>
          )}

          {data && !generated && (
            <>
              {isPickup ? (
                <div style={{ marginBottom: 12, padding: 10, background: '#fffbe6', border: '1px solid #f0c060', borderRadius: 6, fontSize: 13 }}>
                  <strong>📦 Pickup — retiro en oficina MarcoPostal</strong>
                  <div style={{ marginTop: 4, color: '#7a3e00' }}>
                    Punto fijo: <code>{getField('localidad')}</code> · CP <code>{getField('cp')}</code> · servicio_id <code>{getField('servicio_id')}</code>
                  </div>
                </div>
              ) : (
                <div style={{ marginBottom: 12, padding: 10, background: '#f4f4f4', borderRadius: 6, fontSize: 13 }}>
                  <strong>Resolución del destino:</strong>{' '}
                  <span style={{ color: destinoSource === 'table' ? '#2a7' : destinoSource === 'unresolved' ? '#c33' : '#a60' }}>
                    {sourceLabel}
                  </span>
                  {geoSource && <span> · vía {geoSource}</span>}
                  {data.resolved?.destino?.localidadOriginal && (
                    <span> · original: <code>{data.resolved.destino.localidadOriginal}</code></span>
                  )}
                </div>
              )}

              <h4 style={{ marginTop: 8, marginBottom: 8 }}>Destinatario</h4>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <Field label="Nombre" value={getField('apellido_nombre')} onChange={(v) => setField('apellido_nombre', v)} />
                <Field label="Email" value={getField('email')} onChange={(v) => setField('email', v)} />
                <Field label="Celular" value={getField('celular')} onChange={(v) => setField('celular', v)} />
                {!isPickup && <Field label="Calle" value={getField('calle')} onChange={(v) => setField('calle', v)} />}
                {!isPickup && <Field label="Altura" value={getField('altura')} onChange={(v) => setField('altura', v)} />}
                {!isPickup && <Field label="Piso/Apto" value={getField('piso')} onChange={(v) => setField('piso', v)} />}
                <Field label="Localidad (MP)" value={getField('localidad')} onChange={(v) => setField('localidad', v)} highlight readOnly={isPickup} />
                <Field label="CP" value={getField('cp')} onChange={(v) => setField('cp', v)} highlight readOnly={isPickup} />
                <Field label="Provincia" value={getField('provincia')} onChange={(v) => setField('provincia', v)} readOnly={isPickup} />
                <Field label="Observaciones" value={getField('other_info')} onChange={(v) => setField('other_info', v)} />
              </div>

              <h4 style={{ marginTop: 16, marginBottom: 8 }}>Envío</h4>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
                <Field label="Referencia (obs1)" value={getField('obs1')} onChange={(v) => setField('obs1', v)} />
                <Field label="Servicio ID" value={getField('servicio_id')} onChange={(v) => setField('servicio_id', v)} />
                <Field label="Fecha" value={getField('fecha_hora')} onChange={(v) => setField('fecha_hora', v)} />
              </div>

              <h4 style={{ marginTop: 16, marginBottom: 8 }}>Remitente (sucursal)</h4>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, opacity: 0.85 }}>
                <Field label="Empresa" value={getField('sender_empresa')} readOnly />
                <Field label="Contacto" value={getField('sender_remitente')} readOnly />
                <Field label="Dirección" value={`${getField('sender_calle')} ${getField('sender_altura')} ${getField('sender_piso')}`} readOnly />
                <Field label="Localidad / CP" value={`${getField('sender_localidad')} (${getField('sender_cp')})`} readOnly />
              </div>
            </>
          )}
        </div>

        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose} disabled={submitting}>
            {generated ? 'Cerrar' : 'Cancelar'}
          </button>
          {!generated && (
            <button
              className="btn btn-primary"
              onClick={handleGenerar}
              disabled={loading || submitting || !data}
            >
              {submitting ? 'Generando…' : '✅ Confirmar y generar'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function Field({ label, value, onChange, readOnly, highlight }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', fontSize: 13 }}>
      <span style={{ color: '#666', marginBottom: 2 }}>{label}</span>
      <input
        type="text"
        value={value ?? ''}
        readOnly={readOnly}
        onChange={(e) => onChange?.(e.target.value)}
        style={{
          padding: '6px 8px',
          border: '1px solid #ccc',
          borderRadius: 4,
          background: readOnly ? '#f4f4f4' : highlight ? '#fffbe6' : 'white',
        }}
      />
    </label>
  );
}

export default MarcoPostalPreviewModal;

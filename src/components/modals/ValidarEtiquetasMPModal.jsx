import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { previewGuiaMarcoPostal } from '../../services/api';

// Validación en lote previa a generar las etiquetas MarcoPostal de un panel
// (Pick-UP o Recibilo Hoy). Muestra los datos con los que se va a armar cada guía,
// permite corregirlos y confirma todo junto. El request final lo elige el backend
// según tipo_envio: pickup_local → guía PickUp (servicio 9), recibilo_hoy → delivery.

const CONCURRENCIA_PREVIEW = 3;

// Campos editables por tipo. Son claves reales del form de MarcoPostal, así que
// viajan tal cual como payloadOverrides.
const CAMPOS_PICKUP = ['apellido_nombre', 'celular', 'email', 'obs1', 'other_info'];
const CAMPOS_RECIBILO = [
  'apellido_nombre', 'celular', 'email', 'obs1',
  'calle', 'altura', 'piso', 'localidad', 'cp', 'other_info',
  'fecha_servicio', 'hora_desde', 'hora_hasta',
];

const CAMPOS_LOTE = ['fecha_servicio', 'hora_desde', 'hora_hasta'];

// MarcoPostal (Carbon/PHP) espera DD/MM/YYYY; el input date devuelve YYYY-MM-DD.
function toMpDate(valor) {
  const s = String(valor || '').trim();
  if (!s) return '';
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : s;
}

function formInicial(pedido) {
  return {
    apellido_nombre: pedido.cliente_nombre || '',
    celular: pedido.cliente_telefono || '',
    email: pedido.cliente_email || '',
    obs1: String(pedido.numero_pedido || ''),
    other_info: '',
    calle: '',
    altura: '',
    piso: '',
    localidad: '',
    cp: '',
    fecha_servicio: '',
    hora_desde: '',
    hora_hasta: '',
  };
}

// Sólo mandamos lo que aporta algo: un valor cargado, o un campo que el operador
// dejó distinto del payload que armó el backend (incluido vaciarlo a propósito).
function construirOverrides(form, payloadPreview, campos) {
  const out = {};
  for (const campo of campos) {
    const valor = String(form?.[campo] ?? '').trim();
    const base = payloadPreview ? String(payloadPreview[campo] ?? '').trim() : null;
    const difiereDelBase = base !== null && valor !== base;
    if (!valor && !difiereDelBase) continue;
    out[campo] = campo === 'fecha_servicio' ? toMpDate(valor) : valor;
  }
  // MarcoPostal rechaza celulares basura ("-", "N/A"): mismo criterio que el backend.
  if (out.celular && out.celular.replace(/\D/g, '').length < 6) out.celular = '';
  return out;
}

export default function ValidarEtiquetasMPModal({ pedidos = [], tipo, onClose, onConfirm }) {
  const esPickup = tipo === 'pickup_local';
  const campos = esPickup ? CAMPOS_PICKUP : CAMPOS_RECIBILO;
  const tipoLabel = esPickup ? 'Pick-UP' : 'Recibilo Hoy';

  const ordenados = useMemo(() => (
    [...pedidos].sort((a, b) => {
      const na = parseInt(String(a.numero_pedido || '').replace(/\D/g, ''), 10) || 0;
      const nb = parseInt(String(b.numero_pedido || '').replace(/\D/g, ''), 10) || 0;
      return nb - na;
    })
  ), [pedidos]);

  const [forms, setForms]       = useState(() => Object.fromEntries(ordenados.map((p) => [p.id, formInicial(p)])));
  const [checked, setChecked]   = useState(() => Object.fromEntries(ordenados.map((p) => [p.id, !p.link_etiqueta_drive])));
  const [previews, setPreviews] = useState({}); // { pedidoId: { loading, payload, destino, error } }
  const [loteForm, setLoteForm] = useState({ fecha_servicio: '', hora_desde: '', hora_hasta: '' });

  // Campos que el operador editó a mano: el preview no los pisa. No afecta al
  // render, así que vive en un ref y no en estado.
  const tocadosRef = useRef({});

  const marcarTocado = (pedidoId, campo) => {
    const set = tocadosRef.current[pedidoId] || new Set();
    set.add(campo);
    tocadosRef.current[pedidoId] = set;
  };

  // Preview real de MarcoPostal para los delivery: es donde se ve si la localidad
  // de destino resolvió. En pickup el destino es el punto fijo de MP, no hace falta.
  useEffect(() => {
    if (esPickup || ordenados.length === 0) return undefined;
    let cancelado = false;
    const cola = [...ordenados];

    setPreviews(Object.fromEntries(ordenados.map((p) => [p.id, { loading: true }])));

    const worker = async () => {
      while (!cancelado) {
        const pedido = cola.shift();
        if (!pedido) return;
        try {
          const resp = await previewGuiaMarcoPostal(pedido.id);
          if (cancelado) return;
          if (!resp?.success) throw new Error(resp?.error || 'No se pudo obtener el preview');
          const payload = resp.data?.payload || {};
          setPreviews((prev) => ({
            ...prev,
            [pedido.id]: { loading: false, payload, destino: resp.data?.resolved?.destino || null },
          }));
          setForms((prev) => {
            const form = prev[pedido.id];
            if (!form) return prev;
            const tocados = tocadosRef.current[pedido.id] || new Set();
            const merged = { ...form };
            for (const campo of campos) {
              if (tocados.has(campo)) continue;
              if (campo in payload) merged[campo] = String(payload[campo] ?? '');
            }
            return { ...prev, [pedido.id]: merged };
          });
        } catch (err) {
          if (cancelado) return;
          setPreviews((prev) => ({ ...prev, [pedido.id]: { loading: false, error: err.message } }));
        }
      }
    };

    const workers = Array.from({ length: Math.min(CONCURRENCIA_PREVIEW, cola.length) }, () => worker());
    Promise.all(workers).catch(() => {});
    return () => { cancelado = true; };
  }, [ordenados, esPickup, campos]);

  const setCampo = useCallback((pedidoId, campo, valor) => {
    marcarTocado(pedidoId, campo);
    setForms((prev) => ({ ...prev, [pedidoId]: { ...prev[pedidoId], [campo]: valor } }));
  }, []);

  const aplicarLote = useCallback(() => {
    const cargados = CAMPOS_LOTE.filter((c) => String(loteForm[c] || '').trim());
    if (cargados.length === 0) return;
    const destinos = ordenados.filter((p) => checked[p.id]);
    destinos.forEach((p) => cargados.forEach((c) => marcarTocado(p.id, c)));
    setForms((prev) => {
      const next = { ...prev };
      for (const p of destinos) {
        next[p.id] = { ...next[p.id] };
        cargados.forEach((c) => { next[p.id][c] = loteForm[c]; });
      }
      return next;
    });
  }, [loteForm, ordenados, checked]);

  const seleccionados = ordenados.filter((p) => checked[p.id]);
  const algunoCargando = seleccionados.some((p) => previews[p.id]?.loading);
  const todosMarcados = ordenados.length > 0 && ordenados.every((p) => checked[p.id]);

  const handleConfirmar = () => {
    const items = seleccionados.map((p) => ({
      pedidoId: p.id,
      numeroPedido: p.numero_pedido,
      overrides: construirOverrides(forms[p.id], previews[p.id]?.payload || null, campos),
    }));
    if (items.length === 0) return;
    onConfirm?.(items);
  };

  const toggleTodos = () => {
    setChecked(Object.fromEntries(ordenados.map((p) => [p.id, !todosMarcados])));
  };

  return (
    <div className="modal modal-open">
      <div className="modal-content modal-large">
        <div className="modal-header">
          <h3>Validar y generar etiquetas — {tipoLabel} ({seleccionados.length}/{ordenados.length})</h3>
          <button className="btn-close" onClick={onClose}>✕</button>
        </div>

        <div className="modal-body">
          <div className="mpb-toolbar">
            <label className="mpb-check-all">
              <input type="checkbox" checked={todosMarcados} onChange={toggleTodos} />
              Seleccionar todos
            </label>
            <span className="mpb-hint">
              {esPickup
                ? 'Retiro en oficina MarcoPostal — el destino es el punto fijo, sólo se envían los datos de contacto.'
                : 'Delivery MarcoPostal — revisá localidad y CP: si no resuelven, MarcoPostal rechaza la guía.'}
            </span>
          </div>

          {!esPickup && (
            <div className="mpb-lote">
              <strong>Horario para todos los seleccionados</strong>
              <div className="mpb-lote-fields">
                <Campo
                  label="Fecha servicio" type="date" value={loteForm.fecha_servicio}
                  onChange={(v) => setLoteForm((s) => ({ ...s, fecha_servicio: v }))}
                />
                <Campo
                  label="Hora desde" type="time" value={loteForm.hora_desde}
                  onChange={(v) => setLoteForm((s) => ({ ...s, hora_desde: v }))}
                />
                <Campo
                  label="Hora hasta" type="time" value={loteForm.hora_hasta}
                  onChange={(v) => setLoteForm((s) => ({ ...s, hora_hasta: v }))}
                />
                <button type="button" className="btn btn-secondary btn-sm" onClick={aplicarLote}>
                  ↧ Aplicar a todos
                </button>
              </div>
            </div>
          )}

          {ordenados.length === 0 && (
            <p className="mpb-empty">No hay pedidos {tipoLabel} en el panel.</p>
          )}

          {ordenados.map((pedido) => {
            const form = forms[pedido.id] || formInicial(pedido);
            const pv   = previews[pedido.id] || {};
            const sel  = Boolean(checked[pedido.id]);

            return (
              <div key={pedido.id} className={`mpb-card ${sel ? 'mpb-card-sel' : ''}`}>
                <div className="mpb-card-head">
                  <label className="mpb-card-title">
                    <input
                      type="checkbox"
                      checked={sel}
                      onChange={() => setChecked((prev) => ({ ...prev, [pedido.id]: !prev[pedido.id] }))}
                    />
                    <strong>#{pedido.numero_pedido}</strong>
                    <span className="mpb-card-cliente">{pedido.cliente_nombre || 'Sin nombre'}</span>
                  </label>
                  <div className="mpb-card-badges">
                    {pedido.link_etiqueta_drive && (
                      <span
                        className="mpb-badge mpb-badge-warn"
                        title={`Guía actual: ${pedido.numero_seguimiento_ues || '—'}`}>
                        ♻️ Ya tiene etiqueta — se genera una nueva
                      </span>
                    )}
                    {!esPickup && pv.loading && <span className="mpb-badge">⏳ Resolviendo destino…</span>}
                    {!esPickup && pv.error && <span className="mpb-badge mpb-badge-err">⚠️ {pv.error}</span>}
                    {!esPickup && pv.destino && (
                      <span className={`mpb-badge ${pv.destino.source === 'unresolved' ? 'mpb-badge-err' : 'mpb-badge-ok'}`}>
                        {pv.destino.source === 'table' ? '✔ Destino mapeado'
                          : pv.destino.source === 'runtime' ? '✔ Destino resuelto en vivo'
                          : '⚠️ Destino sin resolver'}
                        {pv.destino.localidadOriginal ? ` · ${pv.destino.localidadOriginal}` : ''}
                      </span>
                    )}
                  </div>
                </div>

                {!esPickup && pedido.direccion_envio && (
                  <p className="mpb-direccion-original">Dirección del pedido: {pedido.direccion_envio}</p>
                )}

                <div className="mpb-grid">
                  <Campo label="Nombre" value={form.apellido_nombre} onChange={(v) => setCampo(pedido.id, 'apellido_nombre', v)} />
                  <Campo label="Celular" value={form.celular} onChange={(v) => setCampo(pedido.id, 'celular', v)} />
                  <Campo label="Email" value={form.email} onChange={(v) => setCampo(pedido.id, 'email', v)} />
                  <Campo label="Referencia (obs1)" value={form.obs1} onChange={(v) => setCampo(pedido.id, 'obs1', v)} />

                  {!esPickup && (
                    <>
                      <Campo label="Calle" value={form.calle} onChange={(v) => setCampo(pedido.id, 'calle', v)} />
                      <Campo label="Altura" value={form.altura} onChange={(v) => setCampo(pedido.id, 'altura', v)} />
                      <Campo label="Piso / Apto" value={form.piso} onChange={(v) => setCampo(pedido.id, 'piso', v)} />
                      <Campo label="Localidad (MP)" value={form.localidad} onChange={(v) => setCampo(pedido.id, 'localidad', v)} highlight />
                      <Campo label="CP" value={form.cp} onChange={(v) => setCampo(pedido.id, 'cp', v)} highlight />
                    </>
                  )}

                  <Campo label="Observaciones" value={form.other_info} onChange={(v) => setCampo(pedido.id, 'other_info', v)} />

                  {!esPickup && (
                    <>
                      <Campo label="Fecha servicio" type="date" value={form.fecha_servicio} onChange={(v) => setCampo(pedido.id, 'fecha_servicio', v)} />
                      <Campo label="Hora desde" type="time" value={form.hora_desde} onChange={(v) => setCampo(pedido.id, 'hora_desde', v)} />
                      <Campo label="Hora hasta" type="time" value={form.hora_hasta} onChange={(v) => setCampo(pedido.id, 'hora_hasta', v)} />
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose}>Cancelar</button>
          <button
            className="btn btn-primary"
            onClick={handleConfirmar}
            disabled={seleccionados.length === 0 || algunoCargando}
            title={algunoCargando ? 'Esperando el preview de MarcoPostal' : 'Generar todas las etiquetas seleccionadas'}
          >
            {algunoCargando ? '⏳ Cargando datos…' : `📮 Generar ${seleccionados.length} etiqueta(s)`}
          </button>
        </div>
      </div>
    </div>
  );
}

function Campo({ label, value, onChange, type = 'text', highlight }) {
  return (
    <label className="mpb-field">
      <span>{label}</span>
      <input
        type={type}
        value={value ?? ''}
        onChange={(e) => onChange?.(e.target.value)}
        className={highlight ? 'mpb-input mpb-input-highlight' : 'mpb-input'}
      />
    </label>
  );
}

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  agregarNotaCliente,
  actualizarEstadoCliente,
  marcarFollowupEnviado,
  obtenerNotasCliente,
  obtenerPedidosFollowUp,
} from '../services/api';

const TASK_STATUS_STORAGE_KEY = 'velinne_followup_task_status_v1';
const CUSTOMER_STATES = [
  { value: 'happy', label: 'Happy' },
  { value: 'neutral', label: 'Neutral' },
  { value: 'issue', label: 'Issue' },
  { value: 'repeat', label: 'Repeat' },
  { value: 'no_lo_uso', label: 'No lo uso aún' },
];

const CUSTOMER_STATE_META = {
  happy: { label: 'Feliz', className: 'state-happy' },
  neutral: { label: 'Neutral', className: 'state-neutral' },
  issue: { label: 'Problema', className: 'state-issue' },
  repeat: { label: 'Recurrente', className: 'state-repeat' },
  no_lo_uso: { label: 'No lo uso aún', className: 'state-no-uso' },
};

function getTodayIso() {
  return new Date().toISOString().slice(0, 10);
}

function getTodayLabel() {
  return new Date().toLocaleDateString('es-UY', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

function normalizePhoneForWa(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith('598')) return digits;
  if (digits.length >= 8) return `598${digits}`;
  return '';
}

function getInitials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return 'CL';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
}

function formatDate(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '-';
  return d.toLocaleDateString('es-UY');
}

function formatDateTime(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '-';
  return d.toLocaleString('es-UY', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatPrimerNombre(nombreCompleto) {
  if (!nombreCompleto) return 'cliente';
  // Extraer solo el primer nombre (antes del primer espacio)
  return String(nombreCompleto).trim().split(/\s+/)[0];
}

function renderTemplate(templateBody, pedido) {
  const vars = {
    cliente_nombre: formatPrimerNombre(pedido.cliente_nombre),
    numero_pedido: pedido.numero_pedido || pedido.id,
    tracking: pedido.numero_seguimiento_ues || '-',
    dias_transcurridos: String(pedido.followup_days_elapsed ?? ''),
    fecha_objetivo: formatDate(pedido.followup_target_date),
  };

  return String(templateBody || '').replace(/{{\s*([a-zA-Z0-9_]+)\s*}}/g, (_, key) => {
    return vars[key] ?? '';
  });
}

function buildTaskScopeKey({ days, fromDate, toDate, estadoFiltro, pedidoPrioritario }) {
  const estado = estadoFiltro || 'default_finalizados';
  const pedido = String(pedidoPrioritario || '').trim();
  return pedido
    ? `pedido:${pedido}`
    : `${days}|${fromDate}|${toDate}|${estado}`;
}

function getCustomerStateMeta(state) {
  const key = String(state || 'neutral').toLowerCase();
  return CUSTOMER_STATE_META[key] || CUSTOMER_STATE_META.neutral;
}

function FollowUpPanel({
  mostrarToast,
  templates = [],
  activeTemplateId,
  setActiveTemplateId,
  onUpdateTemplate,
  onOpenTemplateManager,
}) {
  const [days, setDays] = useState(15);
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState(getTodayIso());
  const [estadoFiltro, setEstadoFiltro] = useState('');
  const [pedidoPrioritario, setPedidoPrioritario] = useState('');
  const [loading, setLoading] = useState(false);
  const [pedidos, setPedidos] = useState([]);
  const [taskStatus, setTaskStatus] = useState({});
  const [showOnlyPending, setShowOnlyPending] = useState(false);
  const [showOnlyWithWhatsApp, setShowOnlyWithWhatsApp] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [estadoListaFiltro, setEstadoListaFiltro] = useState('');
  const [customerStateFilter, setCustomerStateFilter] = useState('');
  const [notesPanel, setNotesPanel] = useState({
    open: false,
    customerId: '',
    customerName: '',
    customerEmail: '',
    orderNumber: '',
    orderAge: '',
    notes: [],
    loading: false,
    draft: '',
  });

  useEffect(() => {
    try {
      const raw = localStorage.getItem(TASK_STATUS_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        setTaskStatus(parsed);
      }
    } catch (error) {
      console.error('No se pudo cargar estado de tareas follow-up:', error);
    }
  }, []);

  useEffect(() => {
    localStorage.setItem(TASK_STATUS_STORAGE_KEY, JSON.stringify(taskStatus));
  }, [taskStatus]);

  const activeTemplate = useMemo(
    () => templates.find((t) => t.id === activeTemplateId) || templates[0] || { id: '', name: 'Sin plantilla', body: '' },
    [templates, activeTemplateId]
  );

  const taskScopeKey = useMemo(() => buildTaskScopeKey({
    days,
    fromDate,
    toDate,
    estadoFiltro,
    pedidoPrioritario,
  }), [days, fromDate, toDate, estadoFiltro, pedidoPrioritario]);

  // La DB es la fuente de verdad; localStorage actúa como caché visual offline
  const isPedidoSent = useCallback((pedidoId) => {
    const pedido = pedidos.find((p) => p.id === pedidoId);
    if (pedido?.followup_enviado_at) return true;
    return Boolean(taskStatus[`${taskScopeKey}:${pedidoId}`]);
  }, [pedidos, taskStatus, taskScopeKey]);

  const marcarEstadoPedido = useCallback(async (pedidoId, sent) => {
    // 1. Actualizar localStorage inmediatamente (UX optimista)
    const key = `${taskScopeKey}:${pedidoId}`;
    setTaskStatus((prev) => {
      if (!sent) {
        const next = { ...prev };
        delete next[key];
        return next;
      }
      return { ...prev, [key]: new Date().toISOString() };
    });

    // 2. Persistir en Supabase si se está marcando como enviado
    if (sent) {
      try {
        await marcarFollowupEnviado(pedidoId);
        // Actualizar el pedido en el estado local para que isPedidoSent lo lea de DB
        setPedidos((prev) => prev.map((p) =>
          p.id === pedidoId
            ? { ...p, followup_enviado_at: new Date().toISOString() }
            : p
        ));
      } catch (err) {
        console.error('Error guardando follow-up en DB:', err);
        // El localStorage ya lo marcó — no bloquear al usuario
      }
    }
  }, [taskScopeKey]);

  const tareasDelDia = useMemo(() => {
    return [...pedidos]
      .map((p) => ({
        ...p,
        sent: isPedidoSent(p.id),
      }))
      .sort((a, b) => {
        if (a.sent === b.sent) return 0;
        return a.sent ? 1 : -1;
      });
  }, [pedidos, taskStatus, taskScopeKey]);

  const tareasVisibles = useMemo(() => {
    if (!showOnlyPending) return tareasDelDia;
    return tareasDelDia.filter((t) => !t.sent);
  }, [tareasDelDia, showOnlyPending]);

  const pedidosVisibles = useMemo(() => {
    if (!showOnlyPending) return pedidos;
    return pedidos.filter((p) => !isPedidoSent(p.id));
  }, [pedidos, showOnlyPending, taskStatus, taskScopeKey]);

  const pedidosFiltrados = useMemo(() => {
    if (!showOnlyWithWhatsApp) return pedidosVisibles;
    return pedidosVisibles.filter((p) => Boolean(normalizePhoneForWa(p.cliente_telefono)));
  }, [pedidosVisibles, showOnlyWithWhatsApp]);

  const estadosDisponibles = useMemo(() => {
    const values = new Set(
      pedidos
        .map((p) => String(p.estado || '').trim())
        .filter(Boolean)
    );
    return Array.from(values).sort((a, b) => a.localeCompare(b, 'es'));
  }, [pedidos]);

  const pedidosFiltradosLista = useMemo(() => {
    const query = String(searchTerm || '').trim().toLowerCase();

    return pedidosFiltrados.filter((p) => {
      const matchEstado = !estadoListaFiltro || String(p.estado || '') === estadoListaFiltro;
      if (!matchEstado) return false;

      const matchCustomerState =
        !customerStateFilter ||
        String(p.customer_state || 'neutral').toLowerCase() === customerStateFilter;
      if (!matchCustomerState) return false;

      if (!query) return true;

      const text = [
        p.cliente_nombre,
        p.cliente_email,
        p.cliente_telefono,
        p.numero_pedido,
        p.id,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();

      return text.includes(query);
    });
  }, [pedidosFiltrados, searchTerm, estadoListaFiltro, customerStateFilter]);

  const resumen = useMemo(() => {
    const conTelefono = pedidosFiltradosLista.filter((p) => normalizePhoneForWa(p.cliente_telefono)).length;
    const sinTelefono = pedidosFiltradosLista.length - conTelefono;
    return { total: pedidosFiltradosLista.length, conTelefono, sinTelefono };
  }, [pedidosFiltradosLista]);

  const sentCount = pedidosFiltradosLista.filter((p) => isPedidoSent(p.id)).length;
  const pendingCount = pedidosFiltradosLista.length - sentCount;
  const waPercent = resumen.total > 0 ? Math.round((resumen.conTelefono / resumen.total) * 100) : 0;
  const noWaPercent = resumen.total > 0 ? Math.round((resumen.sinTelefono / resumen.total) * 100) : 0;

  const previewPedido = pedidos[0] || null;
  const previewTexto = previewPedido ? renderTemplate(activeTemplate?.content, previewPedido) : '';

  const cargarGrupo = async () => {
    try {
      setLoading(true);
      const result = await obtenerPedidosFollowUp({
        days,
        from: fromDate,
        to: toDate,
        estado: estadoFiltro,
        pedido: pedidoPrioritario,
      });
      if (!result.success) {
        mostrarToast?.(result.error || 'No se pudo cargar follow-up', 'error');
        return;
      }
      setPedidos(result.data || []);
      mostrarToast?.(`✅ Grupo cargado: ${result.count || 0} pedido(s)`, 'success');
    } catch (error) {
      mostrarToast?.(error.message || 'Error cargando follow-up', 'error');
    } finally {
      setLoading(false);
    }
  };

  const actualizarEstadoClienteEnLista = (customerId, state) => {
    setPedidos((prev) => prev.map((p) => (
      p.customer_id === customerId
        ? { ...p, customer_state: state }
        : p
    )));
  };

  const handleCambiarEstadoCliente = async (pedido, state) => {
    const customerId = pedido.customer_id;
    if (!customerId) return;

    const prevState = String(pedido.customer_state || 'neutral');
    if (prevState === state) return;

    actualizarEstadoClienteEnLista(customerId, state);
    try {
      const result = await actualizarEstadoCliente(customerId, state);
      if (!result.success) {
        throw new Error(result.error || 'No se pudo actualizar estado');
      }
      mostrarToast?.(`Estado actualizado: ${state}`, 'success');
    } catch (error) {
      actualizarEstadoClienteEnLista(customerId, prevState);
      mostrarToast?.(error.message || 'Error actualizando estado del cliente', 'error');
    }
  };

  const openNotes = async (pedido) => {
    const customerId = pedido.customer_id;
    if (!customerId) {
      mostrarToast?.('No se pudo identificar al cliente para notas', 'warning');
      return;
    }

    setNotesPanel({
      open: true,
      customerId,
      customerName: pedido.cliente_nombre || 'Cliente',
      customerEmail: pedido.cliente_email || '',
      orderNumber: pedido.numero_pedido || pedido.id,
      orderAge: pedido.followup_days_elapsed ?? '',
      notes: [],
      loading: true,
      draft: '',
    });

    try {
      const result = await obtenerNotasCliente(customerId);
      if (!result.success) {
        throw new Error(result.error || 'No se pudieron cargar notas');
      }
      setNotesPanel((prev) => ({ ...prev, notes: result.data || [], loading: false }));
    } catch (error) {
      setNotesPanel((prev) => ({ ...prev, loading: false }));
      mostrarToast?.(error.message || 'Error cargando notas', 'error');
    }
  };

  const closeNotes = () => {
    setNotesPanel({
      open: false,
      customerId: '',
      customerName: '',
      customerEmail: '',
      orderNumber: '',
      orderAge: '',
      notes: [],
      loading: false,
      draft: '',
    });
  };

  const handleAgregarNota = async () => {
    const customerId = notesPanel.customerId;
    const content = String(notesPanel.draft || '').trim();
    if (!customerId || !content) return;

    setNotesPanel((prev) => ({ ...prev, loading: true }));
    try {
      const result = await agregarNotaCliente(customerId, content);
      if (!result.success) {
        throw new Error(result.error || 'No se pudo guardar la nota');
      }
      setNotesPanel((prev) => ({
        ...prev,
        draft: '',
        loading: false,
        notes: [result.data, ...prev.notes],
      }));
      mostrarToast?.('Nota guardada', 'success');
    } catch (error) {
      setNotesPanel((prev) => ({ ...prev, loading: false }));
      mostrarToast?.(error.message || 'Error guardando nota', 'error');
    }
  };

  useEffect(() => {
    cargarGrupo();
  }, []);

  const abrirWhatsApp = async (pedido) => {
    const waNumber = normalizePhoneForWa(pedido.cliente_telefono);
    if (!waNumber) {
      mostrarToast?.('Pedido sin telefono valido para WhatsApp', 'warning');
      return;
    }

    const message = renderTemplate(activeTemplate?.content, pedido);

    // Mismo formato que notificationService.js (que ya funciona con emojis)
    const url = `https://api.whatsapp.com/send?phone=${waNumber}&text=${encodeURIComponent(message)}`;
    window.open(url, '_blank', 'noopener,noreferrer');
    await marcarEstadoPedido(pedido.id, true);
  };

  const marcarVisiblesComoEnviados = async () => {
    const pendientes = pedidosFiltradosLista.filter((p) => !isPedidoSent(p.id));
    if (pendientes.length === 0) {
      mostrarToast?.('No hay pendientes visibles para marcar', 'warning');
      return;
    }

    const now = new Date().toISOString();

    // Actualizar localStorage de forma optimista
    setTaskStatus((prev) => {
      const next = { ...prev };
      pendientes.forEach((p) => { next[`${taskScopeKey}:${p.id}`] = now; });
      return next;
    });

    // Persistir en DB en paralelo (best-effort, no bloquea UX)
    const resultados = await Promise.allSettled(
      pendientes.map((p) => marcarFollowupEnviado(p.id))
    );
    const ok = resultados.filter((r) => r.status === 'fulfilled').length;
    const fail = resultados.length - ok;

    // Actualizar estado local de los que se guardaron bien en DB
    setPedidos((prev) => prev.map((p) =>
      pendientes.some((x) => x.id === p.id)
        ? { ...p, followup_enviado_at: now }
        : p
    ));

    mostrarToast?.(
      fail > 0
        ? `✅ ${ok} marcados. ${fail} no pudieron guardarse en DB (pero quedan en caché local)`
        : `✅ ${ok} pedido(s) marcados como enviados y guardados`,
      fail > 0 ? 'warning' : 'success'
    );
  };

  const limpiarSeguimientoActual = () => {
    setTaskStatus((prev) => {
      const next = { ...prev };
      pedidos.forEach((pedido) => delete next[`${taskScopeKey}:${pedido.id}`]);
      return next;
    });
    mostrarToast?.('🧹 Seguimiento del grupo limpiado', 'info');
  };

  return (
    <div className="main-content followup-v2-shell">
      <div className="followup-v2-header">
        <div>
          <h2>Follow-Up Diario</h2>
          <p>Gestiona seguimiento post-compra de forma personalizada</p>
        </div>
      </div>

      <div className="followup-v2-statsbar">
        <div className="followup-stat-card">
          <span className="followup-stat-label">📅 Hoy</span>
          <strong>{getTodayLabel()}</strong>
        </div>
        <div className="followup-stat-card">
          <span className="followup-stat-label">👥 Total</span>
          <strong>{resumen.total}</strong>
          <small>Cargados hoy</small>
        </div>
        <div className="followup-stat-card">
          <span className="followup-stat-label">🟢 Con WhatsApp</span>
          <strong>{resumen.conTelefono}</strong>
          <small>{waPercent}% del total</small>
        </div>
        <div className="followup-stat-card">
          <span className="followup-stat-label">⚪ Sin Telefono</span>
          <strong>{resumen.sinTelefono}</strong>
          <small>{noWaPercent}% del total</small>
        </div>
        <div className="followup-stat-card is-pending">
          <span className="followup-stat-label">📌 Pendientes</span>
          <strong>{pendingCount}</strong>
          <small>Por contactar</small>
        </div>
        <div className="followup-stat-card is-sent">
          <span className="followup-stat-label">✅ Hechos</span>
          <strong>{sentCount}</strong>
          <small>Completados</small>
        </div>
      </div>

      <div className="followup-v2-grid">
        <section className="followup-v2-left">
          <div className="module-panel followup-step-panel">
            <div className="followup-step-header">
              <div>
                <h3><span className="followup-section-icon">◉</span>1. Configuracion</h3>
                <p>Defini el segmento diario de clientes a contactar</p>
              </div>
            </div>

            <div className="followup-card-box">
              <h4>Segmento del dia</h4>
              <p className="followup-section-hint">Paso 1: Defini los filtros del grupo que queres contactar.</p>
              <div>
                <label className="module-label" htmlFor="followup-pedido-prioritario">Pedido puntual (prioritario)</label>
                <input
                  id="followup-pedido-prioritario"
                  className="module-input"
                  type="text"
                  placeholder="Ej: 1550"
                  value={pedidoPrioritario}
                  onChange={(e) => setPedidoPrioritario(e.target.value)}
                />
                <small className="module-help">Si completas este campo, se ignoran dias, fechas y estado para traer ese pedido rapido.</small>
              </div>
              <div className="module-grid followup-segment-grid">
                <div>
                  <label className="module-label" htmlFor="followup-days">Dias desde la compra</label>
                  <input
                    id="followup-days"
                    className="module-input"
                    type="number"
                    min="1"
                    value={days}
                    onChange={(e) => setDays(Math.max(parseInt(e.target.value || '15', 10) || 15, 1))}
                  />
                  <small className="module-help">Ej: 3, 7, 15, 30</small>
                </div>
                <div>
                  <label className="module-label" htmlFor="followup-from">Fecha desde</label>
                  <input
                    id="followup-from"
                    className="module-input"
                    type="date"
                    value={fromDate}
                    onChange={(e) => setFromDate(e.target.value)}
                  />
                </div>
                <div>
                  <label className="module-label" htmlFor="followup-to">Fecha hasta</label>
                  <input
                    id="followup-to"
                    className="module-input"
                    type="date"
                    value={toDate}
                    onChange={(e) => setToDate(e.target.value)}
                  />
                </div>
                <div>
                  <label className="module-label" htmlFor="followup-estado">Estado del pedido</label>
                  <select
                    id="followup-estado"
                    className="module-input"
                    value={estadoFiltro}
                    onChange={(e) => setEstadoFiltro(e.target.value)}
                  >
                    <option value="">Finalizados / Notificados</option>
                    <option value="pendiente">Pendiente</option>
                    <option value="etiqueta_generada">Etiqueta generada</option>
                    <option value="enviado">Enviado</option>
                    <option value="entregado">Entregado</option>
                    <option value="cancelado">Cancelado</option>
                    <option value="en_proceso">En proceso</option>
                  </select>
                </div>
              </div>

              <div className="followup-actions-row">
                <div className="followup-action-block">
                  <span className="followup-step-caption">Paso 2: Cargar el grupo</span>
                  <button type="button" className="btn btn-primary" onClick={cargarGrupo} disabled={loading}>
                    {loading ? 'Cargando...' : 'Cargar clientes'}
                  </button>
                </div>
                <div className="followup-result-block">
                  <span className="followup-result-label">Resultado del filtro</span>
                  <span className="followup-kpi followup-kpi-ok">{resumen.total} clientes encontrados</span>
                </div>
              </div>
            </div>
          </div>

          <div className="module-panel followup-step-panel">
            <div className="followup-template-header">
              <h3><span className="followup-section-icon">✎</span>2. Plantilla del mensaje</h3>
              <button type="button" className="btn btn-secondary btn-sm" onClick={onOpenTemplateManager}>
                Gestionar plantillas
              </button>
            </div>

            <label className="module-label" htmlFor="tpl-active">Plantilla activa</label>
            <select
              id="tpl-active"
              className="module-input"
              value={activeTemplate?.id || ''}
              onChange={(e) => setActiveTemplateId(e.target.value)}
            >
              {templates.map((tpl) => (
                <option key={tpl.id} value={tpl.id}>{tpl.name}</option>
              ))}
            </select>

            <div className="followup-vars-wrap">
              <span className="followup-vars-label">Variables disponibles:</span>
              <div className="followup-vars">
              <span>{'{{cliente_nombre}}'}</span>
              <span>{'{{numero_pedido}}'}</span>
              <span>{'{{tracking}}'}</span>
              <span>{'{{dias_transcurridos}}'}</span>
              <span>{'{{fecha_objetivo}}'}</span>
              </div>
            </div>

            <textarea
              className="module-input"
              rows={5}
              value={activeTemplate?.content || ''}
              onChange={(e) => {
                const nextContent = e.target.value;
                if (!activeTemplate?.id) return;
                onUpdateTemplate?.(activeTemplate.id, { content: nextContent });
              }}
            />
            <div className="followup-char-counter">{(activeTemplate?.content || '').length} caracteres</div>
            <p className="followup-inline-tip">💡 Tip: Usa plantillas personalizadas y habla en tono cercano y humano.</p>

            {previewPedido && (
              <div className="followup-preview-box">
                <strong>Vista previa</strong>
                <pre>{previewTexto}</pre>
              </div>
            )}
          </div>
        </section>

        <section className="followup-v2-right">
          <div className="table-container followup-v2-exec">
            <div className="followup-v2-exec-header">
              <div>
                <h3><span className="followup-section-icon">☍</span>3. Ejecucion</h3>
                <p>Revisa la lista y envia los mensajes por WhatsApp</p>
              </div>
              <button type="button" className="btn btn-secondary btn-sm">
                Modo ejecucion
              </button>
            </div>

            <div className="followup-v2-subheader">
              <div className="followup-v2-subheader-top">
                <div className="followup-exec-title">
                  <strong>Clientes para contactar hoy</strong>
                  <span className="followup-count-pill">{pedidosFiltradosLista.length} clientes</span>
                </div>
                <button type="button" className="btn btn-secondary btn-sm">Filtrar</button>
              </div>

              <div className="followup-v2-filters-row">
                <input
                  type="search"
                  className="module-input followup-inline-input"
                  placeholder="Buscar cliente, pedido, email o telefono"
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                />
                <select
                  className="module-input followup-inline-select"
                  value={estadoListaFiltro}
                  onChange={(e) => setEstadoListaFiltro(e.target.value)}
                >
                  <option value="">Todos los estados</option>
                  {estadosDisponibles.map((estado) => (
                    <option key={estado} value={estado}>{estado}</option>
                  ))}
                </select>
                <select
                  className="module-input followup-inline-select"
                  value={customerStateFilter}
                  onChange={(e) => setCustomerStateFilter(e.target.value)}
                >
                  <option value="">Todos los estados CX</option>
                  {CUSTOMER_STATES.map((st) => (
                    <option key={st.value} value={st.value}>{st.label}</option>
                  ))}
                </select>
                <label className="followup-switch">
                  <input
                    type="checkbox"
                    checked={showOnlyWithWhatsApp}
                    onChange={(e) => setShowOnlyWithWhatsApp(e.target.checked)}
                  />
                  <span className="followup-switch-track" aria-hidden="true">
                    <span className="followup-switch-thumb" />
                  </span>
                  <span className="followup-switch-label">Solo con WhatsApp</span>
                </label>
              </div>

              <div className="followup-v2-actions-row">
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => setShowOnlyPending((prev) => !prev)}
                >
                  {showOnlyPending ? 'Ver todos' : 'Solo pendientes'}
                </button>
                <button
                  type="button"
                  className="btn btn-success btn-sm"
                  onClick={marcarVisiblesComoEnviados}
                  disabled={pedidosFiltradosLista.length === 0}
                >
                  Marcar visibles como enviados
                </button>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={limpiarSeguimientoActual}
                  disabled={pedidos.length === 0}
                >
                  Limpiar seguimiento
                </button>
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  onClick={() => mostrarToast?.('✅ Configuracion guardada', 'success')}
                >
                  Guardar configuracion
                </button>
              </div>
            </div>

            <div className="table-scroll">
              <table className="pedidos-table">
                <thead>
                  <tr>
                    <th></th>
                    <th>Cliente</th>
                    <th>Pedido</th>
                    <th>Dias</th>
                    <th>Telefono</th>
                    <th>Estado</th>
                    <th>Seguimiento</th>
                    <th>Acciones</th>
                  </tr>
                </thead>
                <tbody>
                  {pedidosFiltradosLista.length === 0 ? (
                    <tr>
                      <td colSpan="8" style={{ textAlign: 'center', padding: '1.5rem' }}>
                        {showOnlyPending ? 'No hay pendientes para el filtro seleccionado' : 'No hay alertas para el filtro seleccionado'}
                      </td>
                    </tr>
                  ) : (
                    pedidosFiltradosLista.map((pedido) => {
                      const tieneTelefono = Boolean(normalizePhoneForWa(pedido.cliente_telefono));
                      const sent = isPedidoSent(pedido.id);
                      const customerStateMeta = getCustomerStateMeta(pedido.customer_state);
                      return (
                        <tr key={pedido.id}>
                          <td>
                            <input type="checkbox" aria-label={`Seleccionar ${pedido.cliente_nombre || pedido.id}`} />
                          </td>
                          <td>
                            <div className="followup-client-cell with-avatar">
                              <span className="followup-avatar">{getInitials(pedido.cliente_nombre)}</span>
                              <strong>{pedido.cliente_nombre || 'Sin nombre'}</strong>
                              <span>{pedido.cliente_email || '-'}</span>
                            </div>
                          </td>
                          <td>
                            <div className="followup-order-cell">
                              <strong>#{pedido.numero_pedido || pedido.id}</strong>
                              <span>{formatDate(pedido.followup_base_date)}</span>
                            </div>
                          </td>
                          <td>{pedido.followup_days_elapsed ?? '-'}</td>
                          <td>
                            <span className={`followup-phone-cell ${tieneTelefono ? 'is-valid' : 'is-empty'}`}>
                              {pedido.cliente_telefono || 'Sin WhatsApp'}
                            </span>
                          </td>
                          <td>
                            <div className="followup-order-state-cell">
                              <span>{pedido.estado || '-'}</span>
                              <span className={`customer-state-badge ${customerStateMeta.className}`}>
                                {customerStateMeta.label}
                              </span>
                            </div>
                          </td>
                          <td>
                            <span className={`followup-task-chip ${sent ? 'is-sent' : 'is-pending'}`}>
                              {sent ? 'Enviado' : 'Pendiente'}
                            </span>
                          </td>
                          <td>
                            <div className="followup-table-actions">
                              <button
                                type="button"
                                className="btn btn-success btn-sm"
                                onClick={() => abrirWhatsApp(pedido)}
                                disabled={!tieneTelefono}
                                title={!tieneTelefono ? 'Pedido sin telefono valido para WhatsApp' : 'Abrir WhatsApp con mensaje parametrizado'}
                              >
                                Abrir WhatsApp
                              </button>
                              <details className="followup-actions-menu">
                                <summary className="btn btn-secondary btn-sm">Acciones</summary>
                                <div className="followup-actions-popover">
                                  <button type="button" className="btn btn-secondary btn-sm" onClick={() => handleCambiarEstadoCliente(pedido, 'happy')}>Marcar como Feliz</button>
                                  <button type="button" className="btn btn-secondary btn-sm" onClick={() => handleCambiarEstadoCliente(pedido, 'neutral')}>Marcar como Neutral</button>
                                  <button type="button" className="btn btn-secondary btn-sm" onClick={() => handleCambiarEstadoCliente(pedido, 'issue')}>Marcar como Problema</button>
                                  <button type="button" className="btn btn-secondary btn-sm" onClick={() => handleCambiarEstadoCliente(pedido, 'repeat')}>Marcar como Recurrente</button>
                                  <button type="button" className="btn btn-secondary btn-sm" onClick={() => handleCambiarEstadoCliente(pedido, 'no_lo_uso')}>No lo uso aún</button>
                                  <button type="button" className="btn btn-secondary btn-sm" onClick={() => openNotes(pedido)}>Agregar Nota</button>
                                </div>
                              </details>
                              <button
                                type="button"
                                className={`followup-done-toggle ${sent ? 'is-sent' : ''}`}
                                onClick={() => marcarEstadoPedido(pedido.id, !sent)}
                                title={sent ? 'Marcar como pendiente' : 'Marcar como hecho'}
                              >
                                {sent ? '✓' : '○'}
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      </div>

      {notesPanel.open && (
        <div className="customer-notes-overlay" onClick={closeNotes}>
          <div className="customer-notes-panel" onClick={(e) => e.stopPropagation()}>
            <div className="customer-notes-header">
              <div>
                <h4>Notas de {notesPanel.customerName}</h4>
                <p>{notesPanel.customerEmail || 'Sin email'}{notesPanel.orderNumber ? ` · #${notesPanel.orderNumber}` : ''}{String(notesPanel.orderAge) ? ` · Hace ${notesPanel.orderAge} dias` : ''}</p>
              </div>
              <button type="button" className="btn btn-secondary btn-sm" onClick={closeNotes}>Cerrar</button>
            </div>

            <div className="customer-notes-list">
              {notesPanel.loading ? (
                <div className="customer-notes-empty">Cargando notas...</div>
              ) : notesPanel.notes.length === 0 ? (
                <div className="customer-notes-empty">Sin notas todavia</div>
              ) : (
                notesPanel.notes.map((note) => (
                  <div key={note.id} className="customer-note-item">
                    <div className="customer-note-date">{formatDateTime(note.created_at)}</div>
                    <div className="customer-note-content">{note.content}</div>
                  </div>
                ))
              )}
            </div>

            <div className="customer-notes-inputs">
              <textarea
                className="module-input"
                rows={3}
                placeholder="Agregar nota interna..."
                value={notesPanel.draft}
                onChange={(e) => setNotesPanel((prev) => ({ ...prev, draft: e.target.value }))}
              />
              <button
                type="button"
                className="btn btn-primary"
                onClick={handleAgregarNota}
                disabled={notesPanel.loading || !String(notesPanel.draft || '').trim()}
              >
                Guardar nota
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default FollowUpPanel;

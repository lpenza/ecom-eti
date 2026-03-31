import React, { useEffect, useMemo, useState } from 'react';
import { obtenerPedidosFollowUp } from '../services/api';

const TASK_STATUS_STORAGE_KEY = 'velinne_followup_task_status_v1';

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

function renderTemplate(templateBody, pedido) {
  const vars = {
    cliente_nombre: pedido.cliente_nombre || 'cliente',
    numero_pedido: pedido.numero_pedido || pedido.id,
    tracking: pedido.numero_seguimiento_ues || '-',
    dias_transcurridos: String(pedido.followup_days_elapsed ?? ''),
    fecha_objetivo: formatDate(pedido.followup_target_date),
  };

  return String(templateBody || '').replace(/{{\s*([a-zA-Z0-9_]+)\s*}}/g, (_, key) => {
    return vars[key] ?? '';
  });
}

function buildTaskScopeKey({ days, fromDate, toDate, estadoFiltro }) {
  const estado = estadoFiltro || 'default_finalizados';
  return `${days}|${fromDate}|${toDate}|${estado}`;
}

function FollowUpPanel({
  mostrarToast,
  templates = [],
  activeTemplateId,
  setActiveTemplateId,
  setTemplates,
  onOpenTemplateManager,
}) {
  const [days, setDays] = useState(15);
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState(getTodayIso());
  const [estadoFiltro, setEstadoFiltro] = useState('');
  const [loading, setLoading] = useState(false);
  const [pedidos, setPedidos] = useState([]);
  const [taskStatus, setTaskStatus] = useState({});
  const [showOnlyPending, setShowOnlyPending] = useState(false);
  const [showOnlyWithWhatsApp, setShowOnlyWithWhatsApp] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [estadoListaFiltro, setEstadoListaFiltro] = useState('');

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
  }), [days, fromDate, toDate, estadoFiltro]);

  const isPedidoSent = (pedidoId) => Boolean(taskStatus[`${taskScopeKey}:${pedidoId}`]);

  const marcarEstadoPedido = (pedidoId, sent) => {
    const key = `${taskScopeKey}:${pedidoId}`;
    setTaskStatus((prev) => {
      if (!sent) {
        const next = { ...prev };
        delete next[key];
        return next;
      }
      return {
        ...prev,
        [key]: new Date().toISOString(),
      };
    });
  };

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
  }, [pedidosFiltrados, searchTerm, estadoListaFiltro]);

  const resumen = useMemo(() => {
    const conTelefono = pedidosFiltradosLista.filter((p) => normalizePhoneForWa(p.cliente_telefono)).length;
    const sinTelefono = pedidosFiltradosLista.length - conTelefono;
    return { total: pedidosFiltradosLista.length, conTelefono, sinTelefono };
  }, [pedidosFiltradosLista]);

  const sentCount = pedidosFiltradosLista.filter((p) => isPedidoSent(p.id)).length;
  const pendingCount = pedidosFiltradosLista.length - sentCount;

  const previewPedido = pedidos[0] || null;
  const previewTexto = previewPedido ? renderTemplate(activeTemplate?.body, previewPedido) : '';

  const cargarGrupo = async () => {
    try {
      setLoading(true);
      const result = await obtenerPedidosFollowUp({
        days,
        from: fromDate,
        to: toDate,
        estado: estadoFiltro,
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

  useEffect(() => {
    cargarGrupo();
  }, []);

  const abrirWhatsApp = (pedido) => {
    const waNumber = normalizePhoneForWa(pedido.cliente_telefono);
    if (!waNumber) {
      mostrarToast?.('Pedido sin telefono valido para WhatsApp', 'warning');
      return;
    }

    const message = renderTemplate(activeTemplate?.body, pedido);
    const url = `https://wa.me/${waNumber}?text=${encodeURIComponent(message)}`;
    window.open(url, '_blank', 'noopener,noreferrer');
    marcarEstadoPedido(pedido.id, true);
  };

  const marcarVisiblesComoEnviados = () => {
    if (pedidosFiltradosLista.length === 0) {
      mostrarToast?.('No hay tareas visibles para marcar', 'warning');
      return;
    }

    const now = new Date().toISOString();
    setTaskStatus((prev) => {
      const next = { ...prev };
      pedidosFiltradosLista.forEach((pedido) => {
        next[`${taskScopeKey}:${pedido.id}`] = now;
      });
      return next;
    });
    mostrarToast?.(`✅ Marcados ${pedidosFiltradosLista.length} pedido(s) como enviados`, 'success');
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
        <span className="followup-v2-pill">📅 Hoy: {getTodayLabel()}</span>
        <span className="followup-v2-divider">|</span>
        <span className="followup-v2-pill">👥 Total clientes: {resumen.total}</span>
        <span className="followup-v2-pill is-pending">📌 Pendientes: {pendingCount}</span>
        <span className="followup-v2-pill is-sent">✅ Hechos: {sentCount}</span>
      </div>

      <div className="followup-v2-grid">
        <section className="followup-v2-left">
          <div className="module-panel followup-step-panel">
            <div className="followup-step-header">
              <div>
                <h3>1. Configuracion</h3>
                <p>Defini el segmento diario de clientes a contactar</p>
              </div>
            </div>

            <div className="followup-card-box">
              <h4>Segmento del dia</h4>
              <p className="followup-section-hint">Paso 1: Defini los filtros del grupo que queres contactar.</p>
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
              <h3>2. Plantilla del mensaje</h3>
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
              value={activeTemplate?.body || ''}
              onChange={(e) => {
                const nextBody = e.target.value;
                if (!activeTemplate?.id) return;
                setTemplates((prev) => prev.map((tpl) =>
                  tpl.id === activeTemplate.id ? { ...tpl, body: nextBody } : tpl
                ));
              }}
            />
            <div className="followup-char-counter">{(activeTemplate?.body || '').length} caracteres</div>
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
                <h3>3. Ejecucion</h3>
                <p>Revisa la lista y envia los mensajes por WhatsApp</p>
              </div>
              <button type="button" className="btn btn-secondary btn-sm">
                Modo ejecucion
              </button>
            </div>

            <div className="followup-v2-subheader">
              <div className="followup-v2-subheader-top">
                <strong>Clientes para hoy ({pedidosFiltradosLista.length})</strong>
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
                          <td>{pedido.cliente_telefono ? `🟢 ${pedido.cliente_telefono}` : '-'}</td>
                          <td>{pedido.estado || '-'}</td>
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
                              {sent && (
                                <button
                                  type="button"
                                  className="btn btn-secondary btn-sm"
                                  onClick={() => marcarEstadoPedido(pedido.id, false)}
                                  title="Volver a pendiente"
                                >
                                  Pendiente
                                </button>
                              )}
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
    </div>
  );
}

export default FollowUpPanel;

import React, { useEffect, useMemo, useState } from 'react';
import {
  actualizarBotContactControl,
  obtenerBotContactHistory,
  obtenerBotContacts,
} from '../services/api';

// ── Metadata maps ─────────────────────────────────────────────────────────────

const STAGE_META = {
  risk:         { label: 'Riesgo',        icon: '🔴', cls: 'bot-stage-risk',         priority: 0 },
  active:       { label: 'Activo',        icon: '🟢', cls: 'bot-stage-active',        priority: 2 },
  interested:   { label: 'Interesado',    icon: '🟣', cls: 'bot-stage-interested',    priority: 3 },
  inactive:     { label: 'Inactivo',      icon: '⚪', cls: 'bot-stage-inactive',      priority: 4 },
  new:          { label: 'Nuevo',         icon: '🔵', cls: 'bot-stage-new',           priority: 1 },
  ready_to_buy: { label: 'Ready to buy',  icon: '🛒', cls: 'bot-stage-ready-to-buy',  priority: 2 },
};

const INTENT_META = {
  complaint:        { label: 'Reclamo',     icon: '😡', cls: 'bot-intent-complaint', urgent: true },
  delivery_delay:   { label: 'Demora',      icon: '⏳', cls: 'bot-intent-delay',     urgent: true },
  returns:          { label: 'Devolución',  icon: '↩️', cls: 'bot-intent-return',    urgent: false },
  purchase_intent:  { label: 'Compra',      icon: '🛒', cls: 'bot-intent-purchase',  urgent: false },
  tracking_request: { label: 'Seguimiento', icon: '📦', cls: 'bot-intent-tracking',  urgent: false },
  product_inquiry:  { label: 'Consulta',    icon: '💬', cls: 'bot-intent-inquiry',   urgent: false },
  greeting:         { label: 'Saludo',      icon: '👋', cls: 'bot-intent-greeting',  urgent: false },
};

const STATE_META = {
  upset:   { label: 'Molesta',    icon: '😠', cls: 'bot-cstate-upset',   urgent: true  },
  anxious: { label: 'Ansiosa',    icon: '😰', cls: 'bot-cstate-anxious', urgent: true  },
  neutral: { label: 'Neutral',    icon: '😐', cls: 'bot-cstate-neutral', urgent: false },
  curious: { label: 'Curiosa',    icon: '🤔', cls: 'bot-cstate-curious', urgent: false },
  happy:   { label: 'Satisfecha', icon: '😊', cls: 'bot-cstate-happy',   urgent: false },
};

const SUBINTENT_LABELS = {
  delivery_delay:   'Demora en entrega',
  wrong_product:    'Producto incorrecto',
  missing_item:     'Falta un ítem',
  damaged_product:  'Producto dañado',
  refund_request:   'Reembolso',
  exchange_request: 'Cambio de producto',
};

function getStageMeta(s)  { return STAGE_META[String(s||'').toLowerCase()]  || { label: s||'—', icon: '⚪', cls: 'bot-stage-inactive', priority: 5 }; }
function getIntentMeta(s) { return INTENT_META[String(s||'').toLowerCase()] || { label: s||'—', icon: '💬', cls: 'bot-intent-inquiry', urgent: false }; }
function getStateMeta(s)  { return STATE_META[String(s||'').toLowerCase()]  || { label: s||'—', icon: '😐', cls: 'bot-cstate-neutral', urgent: false }; }

// ── Contact priority score (lower = more urgent) ──────────────────────────────
function contactPriority(c) {
  let score = 100;
  if (c.requires_human_last_time) score -= 40;
  const stage = String(c.stage || '').toLowerCase();
  score += (STAGE_META[stage]?.priority ?? 5) * 5;
  if (getIntentMeta(c.last_intent).urgent) score -= 10;
  if (getStateMeta(c.customer_state).urgent) score -= 10;
  return score;
}

function getRecommendedAction(contact) {
  if (!contact) return { title: 'Sin selección', detail: 'Elegí un contacto para ver acciones sugeridas.', level: 'neutral' };

  const mode = resolveMode(contact);
  if (mode === 'blacklist') {
    return {
      title: 'No responder automáticamente',
      detail: 'Este contacto está en lista negra. Solo quitar blacklist si corresponde reabrir atención.',
      level: 'critical',
    };
  }

  if (contact.requires_human_last_time || String(contact.stage || '').toLowerCase() === 'risk') {
    return {
      title: 'Intervención humana prioritaria',
      detail: 'Revisar historial y tomar el caso manualmente. Mantener bot pausado hasta cerrar contexto.',
      level: 'warning',
    };
  }

  if (mode === 'paused') {
    return {
      title: 'Caso en pausa',
      detail: 'Validar motivo operativo. Si está resuelto, reactivar Bot activo para retomar automatización.',
      level: 'info',
    };
  }

  return {
    title: 'Seguimiento normal por bot',
    detail: 'El bot puede responder. Monitorear intent y estado cliente para detectar escalamiento.',
    level: 'ok',
  };
}

function getCaseFlowStep(contact) {
  if (!contact) return 0;
  const mode = resolveMode(contact);
  const pending = String(contact.pending_action || '').toLowerCase();

  if (pending.includes('resolved') || pending.includes('cerrad')) return 4;
  if (pending.includes('propuesta') || pending.includes('solution')) return 3;
  if (mode === 'paused' || mode === 'blacklist' || contact.requires_human_last_time) return 2;
  if (contact.last_intent) return 1;
  return 0;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function formatDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('es-UY', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function formatPhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (!digits) return '—';
  if (digits.startsWith('598') && digits.length >= 11) {
    const local = digits.slice(3);
    return `+598 ${local.slice(0,2)} ${local.slice(2,5)} ${local.slice(5,8)}`.trim();
  }
  return digits.length >= 8 ? `${digits.slice(0,4)} ${digits.slice(4,8)}`.trim() : digits;
}

function resolveMode(contact) {
  const e = contact?.control?.mode;
  if (e === 'human_taken') return 'paused';
  if (e === 'bot_active' || e === 'paused' || e === 'blacklist') return e;
  if (contact?.control?.blacklisted) return 'blacklist';
  if (contact?.control?.bot_enabled === false) return 'paused';
  return 'bot_active';
}

function normalizeContact(raw) {
  const id    = String(raw?.id || raw?.contact_id || raw?.phone || '').trim();
  const phone = String(raw?.phone || raw?.contact_id || raw?.id || '').trim();
  const requiresHuman = Boolean(raw?.requires_human_last_time);
  const ctrl  = raw?.control && typeof raw.control === 'object' ? raw.control : {};
  const name  = String(raw?.displayName || raw?.name || raw?.customer_name || raw?.cliente_nombre || '').trim();
  return {
    ...raw, id, phone,
    displayName: name || 'Sin nombre',
    requires_human_last_time: requiresHuman,
    control: {
      mode: ctrl.mode || null,
      bot_enabled: typeof ctrl.bot_enabled === 'boolean' ? ctrl.bot_enabled : !requiresHuman,
      blacklisted: Boolean(ctrl.blacklisted),
      reason: String(ctrl.reason || ''),
      updated_at: ctrl.updated_at || null,
    },
    history: Array.isArray(raw?.history) ? raw.history : [],
  };
}

// ── Mini badge ────────────────────────────────────────────────────────────────
function Badge({ cls, children }) {
  return <span className={`bot-badge ${cls}`}>{children}</span>;
}

// ── Situation card ────────────────────────────────────────────────────────────
function SitCard({ icon, label, value, sub, cls }) {
  return (
    <div className={`bot-sit-card ${cls}`}>
      <div className="bot-sit-card-icon">{icon}</div>
      <div className="bot-sit-card-body">
        <div className="bot-sit-card-label">{label}</div>
        <div className="bot-sit-card-value">{value}</div>
        {sub && <div className="bot-sit-card-sub">{sub}</div>}
      </div>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
export default function BotControlPanel({ mostrarToast }) {
  const [contacts,          setContacts]          = useState([]);
  const [selectedId,        setSelectedId]        = useState('');
  const [search,            setSearch]            = useState('');
  const [filterStatus,      setFilterStatus]      = useState('all');
  const [filterStage,       setFilterStage]       = useState('all');
  const [filterIntent,      setFilterIntent]      = useState('all');
  const [reasonDraft,       setReasonDraft]       = useState('');
  const [loadingContacts,   setLoadingContacts]   = useState(true);
  const [serviceDown,       setServiceDown]       = useState(false);
  const [savingControl,     setSavingControl]     = useState(false);
  const [historyById,       setHistoryById]       = useState({});
  const [loadingHistory,    setLoadingHistory]    = useState(false);
  const [historyMsgFilter,  setHistoryMsgFilter]  = useState('all'); // all | user | assistant
  const [draftMessage,      setDraftMessage]      = useState('');
  const [showAdvancedFilters, setShowAdvancedFilters] = useState(false);

  // ── Load ──────────────────────────────────────────────────────────────────
  const loadContacts = async () => {
    setLoadingContacts(true);
    try {
      const data = await obtenerBotContacts();
      const normalized = (Array.isArray(data) ? data : [])
        .map(normalizeContact)
        .filter((c) => !!c.id)
        .sort((a, b) => contactPriority(a) - contactPriority(b));
      setContacts(normalized);
      setServiceDown(false);
      setSelectedId((prev) =>
        prev && normalized.some((c) => c.id === prev) ? prev : (normalized[0]?.id || ''));
    } catch {
      setContacts([]); setSelectedId(''); setServiceDown(true);
    } finally {
      setLoadingContacts(false);
    }
  };

  useEffect(() => { loadContacts(); }, []);

  // ── Filtered list (sorted already) ────────────────────────────────────────
  const filteredContacts = useMemo(() => {
    const q = search.trim().toLowerCase();
    return contacts.filter((c) => {
      const mode = resolveMode(c);
      if (filterStatus === 'requires_human' && !c.requires_human_last_time)                        return false;
      if (filterStatus === 'bot_paused'     && mode !== 'paused')                                   return false;
      if (filterStatus === 'blacklist'      && mode !== 'blacklist')                                 return false;
      if (filterStatus === 'bot_active'     && (c.requires_human_last_time || mode !== 'bot_active')) return false;
      if (filterStage  !== 'all' && String(c.stage       || '').toLowerCase() !== filterStage)  return false;
      if (filterIntent !== 'all' && String(c.last_intent || '').toLowerCase() !== filterIntent) return false;
      if (!q) return true;
      return (
        String(c.displayName    || '').toLowerCase().includes(q) ||
        String(c.phone          || '').toLowerCase().includes(q) ||
        String(c.profile_summary|| '').toLowerCase().includes(q)
      );
    });
  }, [contacts, filterStatus, filterStage, filterIntent, search]);

  const selected = useMemo(
    () => contacts.find((c) => c.id === selectedId) || filteredContacts[0] || null,
    [contacts, selectedId, filteredContacts],
  );

  // ── History ───────────────────────────────────────────────────────────────
  const loadHistory = async (id) => {
    if (!id || historyById[id]) return;
    setLoadingHistory(true);
    try {
      const data = await obtenerBotContactHistory(id);
      setHistoryById((p) => ({ ...p, [id]: Array.isArray(data) ? data : [] }));
    } catch { setHistoryById((p) => ({ ...p, [id]: [] })); }
    finally  { setLoadingHistory(false); }
  };

  useEffect(() => {
    setReasonDraft(selected?.control?.reason || '');
    setDraftMessage('');
    setHistoryMsgFilter('all');
    if (selected?.id) loadHistory(selected.id);
  }, [selected?.id]);

  // ── Control helpers ───────────────────────────────────────────────────────
  const patchLocal = (id, patch) =>
    setContacts((prev) => prev.map((c) => c.id !== id ? c : {
      ...c, control: { ...c.control, ...patch, updated_at: new Date().toISOString() },
    }));

  const saveControl = async (id, payload, rollback) => {
    setSavingControl(true);
    try   { await actualizarBotContactControl(id, payload); return true; }
    catch (err) {
      if (rollback) setContacts((p) => p.map((c) => c.id !== id ? c : rollback));
      mostrarToast?.(err?.message || 'Error al guardar', 'error');
      return false;
    }
    finally { setSavingControl(false); }
  };

  // ── Derived counts for filter pills ───────────────────────────────────────
  const counts = useMemo(() => {
    const stage = {}, intent = {};
    contacts.forEach((c) => {
      const s = String(c.stage       || '—').toLowerCase();
      const i = String(c.last_intent || '—').toLowerCase();
      stage[s]  = (stage[s]  || 0) + 1;
      intent[i] = (intent[i] || 0) + 1;
    });
    return { stage, intent };
  }, [contacts]);

  const mode     = selected ? resolveMode(selected) : 'bot_active';
  const selMode  = mode === 'blacklist' ? 'paused' : mode;
  // history stored newest-last → reverse so newest appears first in UI
  const history  = useMemo(() => {
    const raw = selected?.id ? (historyById[selected.id] || selected?.history || []) : [];
    return [...raw].reverse();
  }, [selected?.id, historyById, selected?.history]);

  const lastUserIdx = useMemo(() => {
    // index in original (non-reversed) array — find first from end
    const raw = selected?.id ? (historyById[selected.id] || selected?.history || []) : [];
    for (let i = raw.length - 1; i >= 0; i--) if (raw[i]?.role === 'user') return i;
    return -1;
  }, [selected?.id, historyById, selected?.history]);

  // reversed index mapping: reversedIdx = (raw.length - 1 - rawIdx)
  const filteredHistory = useMemo(() => {
    if (historyMsgFilter === 'all') return history;
    return history.filter((m) => m.role === historyMsgFilter);
  }, [history, historyMsgFilter]);

  const urgentCount = contacts.filter((c) => c.requires_human_last_time || String(c.stage||'').toLowerCase() === 'risk').length;
  const blacklistedCount = contacts.filter((c) => c.control.blacklisted).length;
  const pausedCount = contacts.filter((c) => resolveMode(c) === 'paused').length;
  const botActiveCount = contacts.filter((c) => resolveMode(c) === 'bot_active' && !c.requires_human_last_time).length;
  const recommendation = getRecommendedAction(selected);
  const quickActions = [
    { key: 'devolucion', label: 'Confirmar devolución', reason: 'Se confirma devolución y seguimiento manual.' },
    { key: 'escalar', label: 'Escalar a supervisor', reason: 'Caso escalado a supervisor por criticidad.' },
    { key: 'datos', label: 'Solicitar datos envío', reason: 'Solicitar datos de envío para continuar resolución.' },
    { key: 'personalizada', label: 'Respuesta personalizada', reason: 'Se requiere respuesta personalizada del operador.' },
  ];

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="bot-panel-shell">
      <section className="bot-workflow-head">
        <div className="bot-workflow-step active">1. Priorizar cola</div>
        <div className="bot-workflow-step">2. Entender contexto</div>
        <div className="bot-workflow-step">3. Ejecutar acción</div>
      </section>

      <section className="bot-filterbar bot-filterbar-compact">
        <div className="bot-search-wrap">
          <span className="bot-search-icon">🔍</span>
          <input
            className="bot-search-input"
            placeholder="Buscar nombre, teléfono o resumen..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        <div className="bot-primary-tabs">
          {[
            { k: 'all', label: `Inbox (${contacts.length})` },
            { k: 'requires_human', label: `En riesgo (${urgentCount})`, urgent: true },
            { k: 'bot_paused', label: `Pausados (${pausedCount})` },
            { k: 'blacklist', label: `Lista negra (${blacklistedCount})` },
            { k: 'bot_active', label: `Bot activo (${botActiveCount})`, ok: true },
          ].map(({ k, label, urgent, ok }) => (
            <button
              key={k}
              type="button"
              className={`bot-filter-pill ${filterStatus === k ? 'active' : ''} ${urgent ? 'urgent' : ''} ${ok ? 'ok' : ''}`}
              onClick={() => setFilterStatus(k)}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="bot-filter-actions">
          <button
            type="button"
            className="bot-link-btn"
            onClick={() => setShowAdvancedFilters((v) => !v)}
          >
            {showAdvancedFilters ? 'Ocultar filtros avanzados' : 'Mostrar filtros avanzados'}
          </button>
          <button type="button" className="bot-refresh-btn" onClick={loadContacts} disabled={loadingContacts} title="Actualizar">
            {loadingContacts ? '⏳' : '↻'}
          </button>
        </div>
      </section>

      {showAdvancedFilters && (
        <section className="bot-advanced-filters">
          <label>
            Stage
            <select value={filterStage} onChange={(e) => setFilterStage(e.target.value)}>
              <option value="all">Todos</option>
              {Object.keys(counts.stage).filter((s) => s !== '—').map((s) => (
                <option key={s} value={s}>{getStageMeta(s).label} ({counts.stage[s]})</option>
              ))}
            </select>
          </label>
          <label>
            Motivo
            <select value={filterIntent} onChange={(e) => setFilterIntent(e.target.value)}>
              <option value="all">Todos</option>
              {Object.keys(counts.intent).filter((i) => i !== '—').map((i) => (
                <option key={i} value={i}>{getIntentMeta(i).label} ({counts.intent[i]})</option>
              ))}
            </select>
          </label>
        </section>
      )}

      {/* ── Grid principal ──────────────────────────────────────────────── */}
      <section className="bot-main-grid">

        {/* ── Lista de contactos ── */}
        <aside className="bot-contact-list">
          {urgentCount > 0 && (
            <div className="bot-list-urgency-banner">
              ⚠ {urgentCount} contacto{urgentCount > 1 ? 's' : ''} requiere{urgentCount === 1 ? '' : 'n'} atención inmediata
            </div>
          )}

          {loadingContacts  && <p className="bot-list-empty">Cargando…</p>}
          {!loadingContacts && serviceDown && <p className="bot-list-empty">Servicio no disponible. Reintentá en unos segundos.</p>}
          {!loadingContacts && !serviceDown && filteredContacts.length === 0 && <p className="bot-list-empty">Sin resultados para este filtro.</p>}

          {filteredContacts.map((c) => {
            const isActive  = selected?.id === c.id;
            const cMode     = resolveMode(c);
            const stageMeta = getStageMeta(c.stage);
            const intentMeta= getIntentMeta(c.last_intent);
            const stateMeta = getStateMeta(c.customer_state);
            const isRisk    = c.requires_human_last_time || String(c.stage||'').toLowerCase() === 'risk';

            return (
              <button key={c.id} type="button"
                className={`bot-contact-card ${isActive ? 'selected' : ''} ${isRisk ? 'urgent' : ''}`}
                onClick={() => { setSelectedId(c.id); setReasonDraft(c.control.reason || ''); }}>

                {/* Cabecera de la card */}
                <div className="bot-cc-head">
                  <div className="bot-cc-name">
                    {c.requires_human_last_time && <span className="bot-cc-alert-dot" title="Requiere humano"/>}
                    {c.displayName}
                  </div>
                  <Badge cls={stageMeta.cls}>{stageMeta.icon} {stageMeta.label}</Badge>
                </div>

                {/* Resumen del caso */}
                {c.profile_summary && (
                  <div className="bot-cc-summary">{c.profile_summary}</div>
                )}

                {/* Fila de intent + estado */}
                <div className="bot-cc-tags">
                  {c.last_intent && <Badge cls={intentMeta.cls}>{intentMeta.icon} {intentMeta.label}</Badge>}
                  {c.customer_state && <Badge cls={stateMeta.cls}>{stateMeta.icon} {stateMeta.label}</Badge>}
                  {cMode === 'paused'    && <Badge cls="bot-badge-paused">⏸ Pausado</Badge>}
                  {cMode === 'blacklist' && <Badge cls="bot-badge-black">🚫 Negra</Badge>}
                </div>

                {/* Teléfono */}
                <div className="bot-cc-phone">{formatPhone(c.phone)}</div>
              </button>
            );
          })}
        </aside>

        {/* ── Panel de detalle ── */}
        <article className="bot-detail-panel">
          {!selected && (
            <div className="bot-empty-state">
              <div style={{ fontSize: '2.5rem' }}>💬</div>
              <p>Seleccioná un contacto para ver el detalle y gestionar la atención.</p>
            </div>
          )}

          {selected && (() => {
            const stageMeta  = getStageMeta(selected.stage);
            const intentMeta = getIntentMeta(selected.last_intent);
            const stateMeta  = getStateMeta(selected.customer_state);
            const isUrgent   = selected.requires_human_last_time || String(selected.stage||'').toLowerCase() === 'risk';

            return (
              <div className="bot-detail-inner">

                {/* ① Identidad + alerta */}
                <div className={`bot-detail-hero ${isUrgent ? 'urgent' : ''}`}>
                  <div className="bot-hero-left">
                    <div className="bot-hero-name">{selected.displayName}</div>
                    <div className="bot-hero-phone">{formatPhone(selected.phone)}</div>
                  </div>
                  <div className="bot-hero-badges">
                    <Badge cls={stageMeta.cls}>{stageMeta.icon} {stageMeta.label}</Badge>
                    {selected.requires_human_last_time && (
                      <Badge cls="bot-badge-human">⚠ Requiere humano</Badge>
                    )}
                  </div>
                </div>

                <div className={`bot-recommendation bot-recommendation-${recommendation.level}`}>
                  <div className="bot-recommendation-title">Acción recomendada: {recommendation.title}</div>
                  <p>{recommendation.detail}</p>
                </div>

                <div className="bot-section bot-case-flow">
                  <div className="bot-section-title">Línea de vida del ticket</div>
                  <div className="bot-flow-track">
                    {[
                      { title: 'Caso iniciado', hint: 'Entrada del cliente' },
                      { title: 'Identificado', hint: 'Clasificación bot' },
                      { title: 'Intervención humana', hint: 'Operador toma control' },
                      { title: 'Propuesta solución', hint: 'Definición de salida' },
                      { title: 'Resolución', hint: 'Cierre del caso' },
                    ].map((step, idx) => {
                      const activeIdx = getCaseFlowStep(selected);
                      const isDone = idx < activeIdx;
                      const isCurrent = idx === activeIdx;
                      return (
                        <div
                          key={step.title}
                          className={`bot-flow-step ${isDone ? 'done' : ''} ${isCurrent ? 'current' : ''}`}
                        >
                          <span className="bot-flow-dot" />
                          <div className="bot-flow-content">
                            <strong>{step.title}</strong>
                            <small>{step.hint}</small>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* ② Situación del caso */}
                <div className="bot-section">
                  <div className="bot-section-title">2. Diagnóstico rápido</div>
                  <div className="bot-situation-cards">
                    <SitCard icon={intentMeta.icon} label="Motivo" value={intentMeta.label}
                      sub={selected.last_subintent ? SUBINTENT_LABELS[selected.last_subintent] || selected.last_subintent : null}
                      cls={intentMeta.cls} />
                    <SitCard icon={stateMeta.icon}  label="Estado cliente" value={stateMeta.label} cls={stateMeta.cls} />
                    {selected.pending_action && (
                      <SitCard icon="⏳" label="Acción pendiente" value={selected.pending_action} cls="bot-sit-card-pending" />
                    )}
                    {selected.interest_product && (
                      <SitCard icon="🛍" label="Producto" value={selected.interest_product} cls="bot-sit-card-product" />
                    )}
                  </div>

                  {selected.profile_summary && (
                    <div className="bot-case-summary">
                      <span className="bot-case-summary-icon">📋</span>
                      <p>{selected.profile_summary}</p>
                    </div>
                  )}
                </div>

                {/* ③ Control del bot */}
                <div className="bot-section">
                  <div className="bot-section-title">3. Decisión operativa</div>
                  <div className="bot-control-row">
                    {/* Bot on/off */}
                    <div className="bot-toggle-group">
                      {[
                        { k: 'bot_active', icon: '🤖', label: 'Bot activo' },
                        { k: 'paused',     icon: '⏸',  label: 'Pausado'   },
                      ].map(({ k, icon, label }) => (
                        <button key={k} type="button" disabled={savingControl}
                          className={`bot-toggle-btn ${selMode === k ? 'active' : ''}`}
                          onClick={() => {
                            const prev = selected;
                            patchLocal(selected.id, { mode: k, bot_enabled: k === 'bot_active', blacklisted: false });
                            saveControl(selected.id, { mode: k }, prev);
                          }}>
                          <span className="bot-toggle-icon">{icon}</span>
                          <span>{label}</span>
                        </button>
                      ))}
                    </div>

                    {/* Blacklist */}
                    <button type="button" disabled={savingControl}
                      className={`bot-blacklist-btn ${selected.control.blacklisted ? 'active' : ''}`}
                      onClick={() => {
                        const next = !selected.control.blacklisted;
                        const prev = selected;
                        patchLocal(selected.id, { blacklisted: next, ...(next ? { bot_enabled: false } : {}) });
                        saveControl(selected.id, { blacklisted: next }, prev);
                      }}>
                      {selected.control.blacklisted ? '🚫 Quitar de lista negra' : '🚫 Lista negra'}
                    </button>
                  </div>

                  {/* Motivo */}
                  <div className="bot-reason-row">
                    <textarea className="bot-reason-input" rows={2}
                      value={reasonDraft}
                      onChange={(e) => setReasonDraft(e.target.value)}
                      placeholder="Motivo operativo (ej: esperando resolución del caso…)" />
                    <button type="button" disabled={savingControl}
                      className="btn btn-secondary btn-sm bot-reason-save"
                      onClick={() => {
                        const prev = selected;
                        patchLocal(selected.id, { reason: reasonDraft });
                        saveControl(selected.id, { reason: reasonDraft }, prev);
                      }}>
                      {savingControl ? '…' : 'Guardar'}
                    </button>
                  </div>
                  {selected.control.updated_at && (
                    <div className="bot-control-meta">
                      Última actualización: {formatDate(selected.control.updated_at)}
                    </div>
                  )}
                </div>

                {/* ④ Historial */}
                <div className="bot-section bot-section-history">
                  <div className="bot-history-header">
                    <span className="bot-section-title" style={{ marginBottom: 0 }}>
                      4. Validar conversación
                    </span>
                    <div className="bot-history-filters">
                      {[
                        { k: 'all',       label: `Todos (${history.length})` },
                        { k: 'user',      label: `👤 Cliente (${history.filter(m=>m.role==='user').length})` },
                        { k: 'assistant', label: `🤖 Bot (${history.filter(m=>m.role==='assistant').length})` },
                      ].map(({ k, label }) => (
                        <button key={k} type="button"
                          className={`bot-filter-pill ${historyMsgFilter === k ? 'active' : ''}`}
                          onClick={() => setHistoryMsgFilter(k)}>
                          {label}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="bot-history-body">
                    {loadingHistory && <p className="bot-list-empty">Cargando…</p>}
                    {!loadingHistory && history.length === 0 && (
                      <p className="bot-list-empty">Sin historial disponible.</p>
                    )}
                    {!loadingHistory && filteredHistory.map((msg, idx) => {
                      // original index (pre-reverse) = raw.length - 1 - idx_in_reversed
                      const rawLen = history.length;
                      const rawIdx = rawLen - 1 - history.indexOf(msg);
                      const isLastUser = msg.role === 'user' && rawIdx === lastUserIdx;
                      const isTrigger  = Boolean(selected.requires_human_last_time && isLastUser);
                      return (
                        <div key={`${msg.at}-${idx}`}
                          className={`bot-msg bot-msg-${msg.role} ${isTrigger ? 'bot-msg-trigger' : ''} ${isLastUser ? 'bot-msg-last-user' : ''}`}>
                          <div className="bot-msg-head">
                            <strong>{msg.role === 'assistant' ? '🤖 Bot' : '👤 Cliente'}</strong>
                            <span>{formatDate(msg.at)}</span>
                          </div>
                          {isTrigger && (
                            <div className="bot-msg-alert-tag">⚠ Este mensaje activó "requiere humano"</div>
                          )}
                          <p>{msg.content}</p>
                        </div>
                      );
                    })}
                  </div>

                  <div className="bot-quick-actions-wrap">
                    <div className="bot-section-title" style={{ marginBottom: '0.5rem' }}>Atajos operativos</div>
                    <div className="bot-quick-actions">
                      {quickActions.map((action) => (
                        <button
                          key={action.key}
                          type="button"
                          className="bot-quick-action-btn"
                          onClick={() => {
                            setReasonDraft(action.reason);
                            mostrarToast?.('Plantilla aplicada al motivo operativo', 'success');
                          }}
                        >
                          {action.label}
                        </button>
                      ))}
                    </div>

                    <div className="bot-composer-dock">
                      <div className="bot-composer-head">
                        <span>Mensaje operativo</span>
                        <div className="bot-composer-head-actions">
                          <strong>{selMode === 'bot_active' ? 'Bot' : 'Humano'}</strong>
                          <button
                            type="button"
                            className="bot-composer-pause"
                            disabled={savingControl}
                            onClick={() => {
                              const prev = selected;
                              patchLocal(selected.id, { mode: 'paused', bot_enabled: false });
                              saveControl(selected.id, { mode: 'paused' }, prev);
                            }}
                          >
                            Pausar Bot
                          </button>
                        </div>
                      </div>
                      <textarea
                        className="bot-composer-input"
                        rows={2}
                        value={draftMessage}
                        onChange={(e) => setDraftMessage(e.target.value)}
                        placeholder="Nueva respuesta operativa..."
                      />
                      <div className="bot-composer-footer">
                        <button
                          type="button"
                          className="bot-composer-save"
                          onClick={() => {
                            if (!draftMessage.trim()) return;
                            setReasonDraft(draftMessage.trim());
                            setDraftMessage('');
                            mostrarToast?.('Mensaje preparado y copiado a motivo operativo', 'success');
                          }}
                        >
                          Guardar
                        </button>
                      </div>
                    </div>
                  </div>
                </div>

              </div>
            );
          })()}
        </article>

      </section>
    </div>
  );
}

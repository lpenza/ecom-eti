import React, { useEffect, useMemo, useState } from 'react';
import {
  actualizarBotContactControl,
  obtenerBotContactHistory,
  obtenerBotContacts,
} from '../services/api';

const MODE_CONFIG = {
  bot_active: { label: 'Bot activo', icon: '🤖', badgeClass: 'bot-badge-ok' },
  paused: { label: 'Pausado', icon: '⏸', badgeClass: 'bot-badge-paused' },
  blacklist: { label: 'Lista negra', icon: '🚫', badgeClass: 'bot-badge-black' },
};

const MODE_SELECTOR_OPTIONS = ['bot_active', 'paused'];

function formatDate(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '-';
  return d.toLocaleString('es-UY', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatPhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (!digits) return '-';

  if (digits.startsWith('598') && digits.length >= 11) {
    const local = digits.slice(3);
    return `+598 ${local.slice(0, 2)} ${local.slice(2, 5)} ${local.slice(5, 8)}`.trim();
  }

  if (digits.length >= 8) {
    return `${digits.slice(0, 4)} ${digits.slice(4, 8)}`.trim();
  }

  return digits;
}

function resolveMode(contact) {
  const explicit = contact?.control?.mode;
  if (explicit === 'human_taken') return 'paused';
  if (explicit && MODE_CONFIG[explicit]) return explicit;
  if (contact?.control?.blacklisted) return 'blacklist';
  if (contact?.control?.bot_enabled === false) return 'paused';
  return 'bot_active';
}

function getBlockingLabel(contact) {
  const mode = resolveMode(contact);
  if (mode === 'blacklist') return 'Lista negra';
  if (mode === 'paused') return 'Pausado';
  if (contact?.requires_human_last_time) return 'Requiere humano (bot)';
  return 'Sin bloqueo';
}

function normalizeContact(raw) {
  const id = String(raw?.id || raw?.contact_id || raw?.phone || '').trim();
  const phone = String(raw?.phone || raw?.contact_id || raw?.id || '').trim();
  const requiresHumanLastTime = Boolean(raw?.requires_human_last_time);
  const controlRaw = raw?.control && typeof raw.control === 'object' ? raw.control : {};
  const displayName = String(
    raw?.displayName
    || raw?.name
    || raw?.customer_name
    || raw?.cliente_nombre
    || ''
  ).trim();

  return {
    ...raw,
    id,
    phone,
    displayName: displayName || 'Sin nombre',
    requires_human_last_time: requiresHumanLastTime,
    control: {
      mode: controlRaw.mode || null,
      bot_enabled: typeof controlRaw.bot_enabled === 'boolean' ? controlRaw.bot_enabled : !requiresHumanLastTime,
      blacklisted: Boolean(controlRaw.blacklisted),
      reason: String(controlRaw.reason || ''),
      updated_at: controlRaw.updated_at || null,
      updated_by: controlRaw.updated_by || null,
    },
    history: Array.isArray(raw?.history) ? raw.history : [],
  };
}

export default function BotControlPanel({ mostrarToast }) {
  const [contacts, setContacts] = useState([]);
  const [selectedId, setSelectedId] = useState('');
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const [reasonDraft, setReasonDraft] = useState('');
  const [loadingContacts, setLoadingContacts] = useState(true);
  const [serviceUnavailable, setServiceUnavailable] = useState(false);
  const [savingControl, setSavingControl] = useState(false);
  const [historyById, setHistoryById] = useState({});
  const [loadingHistory, setLoadingHistory] = useState(false);

  const loadContacts = async () => {
    setLoadingContacts(true);
    try {
      const data = await obtenerBotContacts();
      const normalized = (Array.isArray(data) ? data : []).map(normalizeContact).filter((c) => !!c.id);
      setContacts(normalized);
      setServiceUnavailable(false);
      if (normalized.length > 0) {
        setSelectedId((prev) => (prev && normalized.some((c) => c.id === prev) ? prev : normalized[0].id));
      } else {
        setSelectedId('');
      }
    } catch (error) {
      setContacts([]);
      setSelectedId('');
      setServiceUnavailable(true);
      console.error('Error cargando contactos bot:', error);
    } finally {
      setLoadingContacts(false);
    }
  };

  useEffect(() => {
    loadContacts();
  }, []);

  const filteredContacts = useMemo(() => {
    const q = String(search || '').trim().toLowerCase();

    return contacts.filter((contact) => {
      const mode = resolveMode(contact);
      if (filter === 'requires_human' && !contact.requires_human_last_time) return false;
      if (filter === 'bot_paused' && mode !== 'paused') return false;
      if (filter === 'blacklist' && mode !== 'blacklist') return false;

      if (!q) return true;
      return (
        String(contact.displayName || '').toLowerCase().includes(q)
        || String(contact.phone || '').toLowerCase().includes(q)
        || String(contact.interest_product || '').toLowerCase().includes(q)
      );
    });
  }, [contacts, filter, search]);

  const selected = useMemo(
    () => contacts.find((c) => c.id === selectedId) || filteredContacts[0] || null,
    [contacts, selectedId, filteredContacts]
  );

  const updateContact = (id, updater) => {
    setContacts((prev) => prev.map((c) => (c.id === id ? updater(c) : c)));
  };

  const loadContactHistory = async (contactId) => {
    if (!contactId || historyById[contactId]) return;

    setLoadingHistory(true);
    try {
      const data = await obtenerBotContactHistory(contactId);
      setHistoryById((prev) => ({
        ...prev,
        [contactId]: Array.isArray(data) ? data : [],
      }));
    } catch (error) {
      setHistoryById((prev) => ({ ...prev, [contactId]: [] }));
      console.error('Error cargando historial contacto bot:', error);
    } finally {
      setLoadingHistory(false);
    }
  };

  useEffect(() => {
    setReasonDraft(selected?.control?.reason || '');
    if (selected?.id) {
      loadContactHistory(selected.id);
    }
  }, [selected?.id]);

  const applyControlChange = (id, nextControl) => {
    updateContact(id, (current) => ({
      ...current,
      control: {
        ...current.control,
        ...nextControl,
        updated_at: new Date().toISOString(),
        updated_by: 'panel',
      },
    }));
  };

  const saveControl = async (contactId, payload, rollbackContact = null) => {
    setSavingControl(true);
    try {
      await actualizarBotContactControl(contactId, payload);
      return true;
    } catch (error) {
      if (rollbackContact) {
        updateContact(contactId, () => rollbackContact);
      }
      if (typeof mostrarToast === 'function') {
        mostrarToast(error?.message || 'No se pudo guardar control del contacto', 'error');
      }
      return false;
    } finally {
      setSavingControl(false);
    }
  };

  const resolvedMode = selected ? resolveMode(selected) : 'bot_active';
  const selectedMode = resolvedMode === 'blacklist' ? 'paused' : resolvedMode;

  const selectedHistory = selected?.id
    ? (historyById[selected.id] || selected?.history || [])
    : [];

  const lastUserIndex = useMemo(() => {
    for (let i = selectedHistory.length - 1; i >= 0; i -= 1) {
      if (selectedHistory[i]?.role === 'user') return i;
    }
    return -1;
  }, [selectedHistory]);

  return (
    <div className="bot-panel-shell">
      <section className="bot-panel-header module-panel module-panel-tight-top">
        <h3>Panel Bot WhatsApp</h3>
        <p>Control operativo por contacto. Se mantiene requires_human_last_time como alerta del bot.</p>
      </section>

      <section className="bot-panel-toolbar module-panel module-panel-tight">
        <div className="bot-panel-filter-group">
          <button type="button" className={`btn btn-secondary btn-sm ${filter === 'all' ? 'bot-chip-active' : ''}`} onClick={() => setFilter('all')}>
            Todos ({contacts.length})
          </button>
          <button type="button" className={`btn btn-secondary btn-sm ${filter === 'requires_human' ? 'bot-chip-active' : ''}`} onClick={() => setFilter('requires_human')}>
            Requiere humano ({contacts.filter((c) => c.requires_human_last_time).length})
          </button>
          <button type="button" className={`btn btn-secondary btn-sm ${filter === 'bot_paused' ? 'bot-chip-active' : ''}`} onClick={() => setFilter('bot_paused')}>
            Bot pausado ({contacts.filter((c) => resolveMode(c) === 'paused').length})
          </button>
          <button type="button" className={`btn btn-secondary btn-sm ${filter === 'blacklist' ? 'bot-chip-active' : ''}`} onClick={() => setFilter('blacklist')}>
            Lista negra ({contacts.filter((c) => resolveMode(c) === 'blacklist').length})
          </button>
          <button type="button" className="btn btn-secondary btn-sm" onClick={loadContacts} disabled={loadingContacts}>
            {loadingContacts ? 'Actualizando...' : '↻ Actualizar'}
          </button>
        </div>
        <input
          className="module-input bot-search"
          placeholder="Buscar por nombre, telefono o producto"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </section>

      <section className="bot-panel-content module-panel module-panel-tight">
        <div className="bot-grid">
          <aside className="bot-contact-list">
            {loadingContacts && <p className="module-help-text">Cargando contactos...</p>}
            {!loadingContacts && serviceUnavailable && (
              <p className="module-help-text">No se pudo conectar con el servicio del bot. Reintenta en unos segundos.</p>
            )}
            {!loadingContacts && !serviceUnavailable && contacts.length === 0 && (
              <p className="module-help-text">No hay contactos disponibles por ahora.</p>
            )}
            {!loadingContacts && !serviceUnavailable && filteredContacts.length === 0 && (
              <p className="module-help-text">Sin contactos para este filtro.</p>
            )}
            {filteredContacts.map((contact) => {
              const isActive = selected?.id === contact.id;
              const mode = resolveMode(contact);
              const modeMeta = MODE_CONFIG[mode] || MODE_CONFIG.bot_active;

              return (
                <button
                  key={contact.id}
                  type="button"
                  className={`bot-contact-item ${isActive ? 'bot-contact-item-active' : ''}`}
                  onClick={() => {
                    setSelectedId(contact.id);
                    setReasonDraft(contact.control.reason || '');
                  }}
                >
                  <div className="bot-contact-title">
                    <strong>{contact.displayName}</strong>
                  </div>
                  <div className="bot-contact-subline">
                    <span className="bot-contact-phone">📞 {formatPhone(contact.phone)}</span>
                    {contact.id && contact.id !== contact.phone && <span>ID: {contact.id}</span>}
                  </div>
                  <div className="bot-badges">
                    <span className={`bot-badge ${modeMeta.badgeClass}`}>{modeMeta.icon} {modeMeta.label}</span>
                    {contact.requires_human_last_time && <span className="bot-badge bot-badge-human">⚠ Requiere humano</span>}
                  </div>
                </button>
              );
            })}
          </aside>

          <article className="bot-detail">
            {!selected && <p className="module-help-text">Selecciona un contacto para ver detalle.</p>}
            {selected && (
              <>
                <div className="bot-detail-head">
                  <div>
                    <h4>{selected.displayName}</h4>
                    <p>{selected.phone}</p>
                  </div>
                  <div className="bot-detail-state">
                    <span className="bot-state-line">Bloqueo efectivo: <strong>{getBlockingLabel(selected)}</strong></span>
                    <span className="bot-state-line">Actualizado: {formatDate(selected.control.updated_at)}</span>
                  </div>
                </div>

                <div className="bot-control-grid">
                  <span className="module-label" style={{ marginBottom: 0 }}>Modo</span>
                  <div className="bot-mode-selector" role="radiogroup" aria-label="Modo de atencion">
                    {MODE_SELECTOR_OPTIONS.map((modeKey) => {
                      const modeMeta = MODE_CONFIG[modeKey];
                      const checked = selectedMode === modeKey;
                      return (
                        <button
                          key={modeKey}
                          type="button"
                          className={`bot-mode-option ${checked ? 'bot-mode-option-active' : ''}`}
                          role="radio"
                          aria-checked={checked}
                          onClick={() => {
                            const nextControl = {
                              mode: modeKey,
                              bot_enabled: modeKey === 'bot_active',
                              blacklisted: false,
                            };
                            const previousContact = selected;
                            applyControlChange(selected.id, nextControl);
                            saveControl(selected.id, { mode: modeKey }, previousContact);
                          }}
                          disabled={savingControl}
                        >
                          <span>{modeMeta.icon}</span>
                          <span>{modeMeta.label}</span>
                        </button>
                      );
                    })}
                  </div>
                  <button
                    type="button"
                    className={`btn btn-secondary btn-sm ${selected.control.blacklisted ? 'bot-chip-active' : ''}`}
                    onClick={() => {
                      const nextBlacklisted = !selected.control.blacklisted;
                      const previousContact = selected;
                      applyControlChange(selected.id, {
                        blacklisted: nextBlacklisted,
                        ...(nextBlacklisted ? { bot_enabled: false } : {}),
                      });
                      saveControl(selected.id, { blacklisted: nextBlacklisted }, previousContact);
                    }}
                    disabled={savingControl}
                  >
                    {selected.control.blacklisted ? 'Quitar de lista negra' : 'Agregar a lista negra'}
                  </button>
                </div>

                {selected.requires_human_last_time && (
                  <div className="bot-human-alert">
                    ⚠ El bot sugiere intervencion humana para este contacto.
                  </div>
                )}

                <div className="bot-reason-box">
                  <label className="module-label" htmlFor="bot-reason">Motivo operativo</label>
                  <textarea
                    id="bot-reason"
                    className="module-input"
                    rows={2}
                    value={reasonDraft}
                    onChange={(e) => setReasonDraft(e.target.value)}
                    placeholder="Ej: pausa manual hasta revisar caso"
                  />
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => {
                      const previousContact = selected;
                      applyControlChange(selected.id, { reason: reasonDraft });
                      saveControl(selected.id, { reason: reasonDraft }, previousContact);
                    }}
                    disabled={savingControl}
                  >
                    {savingControl ? 'Guardando...' : 'Guardar motivo'}
                  </button>
                </div>

                <div className="bot-meta-grid">
                  <div><strong>Stage:</strong> {selected.stage || '-'}</div>
                  <div><strong>Intent:</strong> {selected.last_intent || '-'}</div>
                  <div><strong>Subintent:</strong> {selected.last_subintent || '-'}</div>
                  <div><strong>Estado cliente:</strong> {selected.customer_state || '-'}</div>
                  <div><strong>Producto interes:</strong> {selected.interest_product || '-'}</div>
                  <div><strong>Pending action:</strong> {selected.pending_action || '-'}</div>
                </div>

                <div className="bot-summary-box">
                  <strong>Profile summary</strong>
                  <p>{selected.profile_summary || '-'}</p>
                </div>

                <div className="bot-history">
                  <h5>Historial</h5>
                  {loadingHistory && <p className="module-help-text">Cargando historial...</p>}
                  {!loadingHistory && selectedHistory.length === 0 && (
                    <p className="module-help-text">Sin historial disponible para este contacto.</p>
                  )}
                  {selectedHistory.map((msg, idx) => {
                    const isLastUserMessage = msg.role === 'user' && idx === lastUserIndex;
                    const isTriggerMessage = Boolean(
                      selected.requires_human_last_time
                      && msg.role === 'user'
                      && idx === lastUserIndex
                    );

                    return (
                      <div
                        key={`${msg.at}-${idx}`}
                        className={`bot-msg bot-msg-${msg.role} ${isLastUserMessage ? 'bot-msg-last-user' : ''} ${isTriggerMessage ? 'bot-msg-trigger' : ''}`}
                      >
                        <div className="bot-msg-head">
                          <strong>{msg.role === 'assistant' ? 'Bot' : 'Cliente'}</strong>
                          <span>{formatDate(msg.at)}</span>
                        </div>
                        <div className="bot-msg-tags">
                          {isLastUserMessage && <span className="bot-msg-tag">Ultimo mensaje cliente</span>}
                          {isTriggerMessage && <span className="bot-msg-tag bot-msg-tag-danger">Activa requires human</span>}
                        </div>
                        <p>{msg.content}</p>
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </article>
        </div>
      </section>
    </div>
  );
}

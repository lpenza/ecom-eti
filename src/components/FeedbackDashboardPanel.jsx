import React, { useEffect, useMemo, useState } from 'react';
import { obtenerFeedbackDashboard, analizarRazonesCompra } from '../services/api';

function percent(part, total) {
  if (!total) return 0;
  return Math.round((part / total) * 100);
}

function formatPct(part, total) {
  return `${percent(part, total)}%`;
}

function formatDateLabel(isoDate) {
  const d = new Date(`${isoDate}T00:00:00`);
  if (Number.isNaN(d.getTime())) return isoDate;
  return d.toLocaleDateString('es-UY', { day: '2-digit', month: 'short' });
}

function normalizeLabel(label) {
  return String(label || '').replace(/_/g, ' ').trim();
}

function dictionaryEntry(rawLabel, dictionary = {}) {
  const key = String(rawLabel || '').trim().toLowerCase();
  const direct = dictionary[key];
  if (direct) return direct;

  const normalized = key
    .replace(/[™]/g, '')
    .replace(/\s+/g, '_');
  if (dictionary[normalized]) return dictionary[normalized];

  return {
    label: normalizeLabel(rawLabel),
    action: '',
  };
}

function toSparkPoints(values, width = 84, height = 26) {
  const max = Math.max(...values, 1);
  const step = values.length > 1 ? width / (values.length - 1) : width;

  return values
    .map((v, i) => {
      const x = Math.round(i * step);
      const y = Math.round(height - (v / max) * height);
      return `${x},${y}`;
    })
    .join(' ');
}

// Compara el último valor de la serie contra el promedio de los anteriores
function computeTrend(series) {
  if (series.length === 0) return { text: '= 0', up: false };
  const last = series[series.length - 1];
  if (series.length < 2) return { text: `= ${last}`, up: false };
  const prev = series.slice(0, -1);
  const avg = prev.reduce((s, v) => s + v, 0) / prev.length;
  const up = last > avg;
  const diff = Math.abs(Math.round(last - avg));
  return { text: `${up ? '▲' : '▼'} ${diff}`, up };
}

function KpiCard({ title, value, detail, secondValue, secondLabel, delta, deltaUp, series = [], tooltip = '' }) {
  const points = toSparkPoints(series.length > 0 ? series : [0, 0, 0]);

  return (
    <article className="fdx-kpi-card">
      <div className="fdx-kpi-head">
        <span>{title}</span>
        {tooltip && (
          <span className="fdx-tip" title={tooltip} aria-label={tooltip}>ⓘ</span>
        )}
      </div>
      <div className="fdx-kpi-main">
        <strong>{value}</strong>
        <span>{detail}</span>
      </div>
      {secondValue && (
        <div className="fdx-kpi-second">
          <span>{secondLabel}</span>
          <strong>{secondValue}</strong>
        </div>
      )}
      <div className="fdx-kpi-foot">
        <svg viewBox="0 0 84 26" aria-hidden="true" focusable="false">
          <polyline points={points} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
        <span className={`fdx-delta ${deltaUp ? 'is-up' : 'is-down'}`}>{delta}</span>
      </div>
    </article>
  );
}

function SimpleList({ title, items = [], emptyText, showAction = true, dictionary = {} }) {
  return (
    <article className="fdx-list-card">
      <h4>{title}</h4>
      {items.length === 0 ? (
        <p>{emptyText}</p>
      ) : (
        <ol>
          {items.map((item, idx) => {
            const entry = dictionaryEntry(item.label, dictionary);
            return (
              <li key={`${item.label}-${idx}`}>
                <span>
                  {entry.label}
                  {showAction && entry.action && (
                    <small>{entry.action}</small>
                  )}
                </span>
                <strong>{item.count}</strong>
              </li>
            );
          })}
        </ol>
      )}
    </article>
  );
}

function BotStatusBlock({ overview }) {
  const contacts = overview.contacts || 0;
  const requiresHuman = overview.requiresHuman || 0;
  const paused = overview.paused || 0;
  const blacklisted = overview.blacklisted || 0;
  const botActive = overview.botActive || 0;
  const activeLast24h = overview.activeLast24h || 0;

  const humanRatio = contacts > 0 ? requiresHuman / contacts : 0;
  const blacklistRatio = contacts > 0 ? blacklisted / contacts : 0;

  let health = 'green';
  if (humanRatio >= 0.30 || blacklistRatio >= 0.10) health = 'red';
  else if (humanRatio >= 0.15 || blacklistRatio >= 0.05) health = 'yellow';

  const healthMeta = {
    green:  { label: 'Saludable', color: '#67b36a' },
    yellow: { label: 'Atención',  color: '#d4a017' },
    red:    { label: 'Alerta',    color: '#de5a67' },
  };

  const modes = [
    { label: 'Bot activo', count: botActive,   color: '#67b36a' },
    { label: 'Pausado',    count: paused,       color: '#d4a017' },
    { label: 'Blacklist',  count: blacklisted,  color: '#de5a67' },
  ];

  return (
    <article className="fdx-card fdx-bot-block">
      <div className="fdx-bot-header">
        <h3>Estado del Bot (Redis)</h3>
        <span
          className="fdx-bot-health"
          style={{ color: healthMeta[health].color }}
          title={`Human ratio: ${percent(requiresHuman, contacts)}% — Blacklist: ${percent(blacklisted, contacts)}%`}
        >
          ● {healthMeta[health].label}
        </span>
      </div>

      <div className="fdx-bot-grid">
        <div className="fdx-bot-highlight">
          <span>Activos últimas 24h</span>
          <strong>{activeLast24h}</strong>
          <em>{contacts > 0 ? `${percent(activeLast24h, contacts)}% del total` : '—'}</em>
        </div>

        <div className="fdx-bot-stat">
          <span>Total contactos</span>
          <strong>{contacts}</strong>
        </div>

        <div className={`fdx-bot-stat${requiresHuman > 0 ? ' is-alert' : ''}`}>
          <span>Requiere humano</span>
          <strong>{requiresHuman}</strong>
          {requiresHuman > 0 && (
            <em className="fdx-bot-badge">{percent(requiresHuman, contacts)}%</em>
          )}
        </div>

        <div className="fdx-bot-modes">
          <span className="fdx-bot-modes-title">Distribución de modos</span>
          {modes.map((m) => (
            <div key={m.label} className="fdx-bot-mode-row">
              <span>{m.label}</span>
              <div className="fdx-bot-mode-bar-wrap">
                <div
                  className="fdx-bot-mode-bar"
                  style={{
                    width: contacts > 0 ? `${Math.max(2, percent(m.count, contacts))}%` : '0%',
                    background: m.color,
                  }}
                />
              </div>
              <span className="fdx-bot-mode-count">{m.count} ({contacts > 0 ? percent(m.count, contacts) : 0}%)</span>
            </div>
          ))}
        </div>
      </div>
    </article>
  );
}

const STATE_META = {
  happy:     { label: 'Feliz',      emoji: '😊', tone: 'positive' },
  satisfied: { label: 'Satisfecha', emoji: '😊', tone: 'positive' },
  feliz:     { label: 'Feliz',      emoji: '😊', tone: 'positive' },
  ok:        { label: 'Conforme',   emoji: '👍', tone: 'positive' },
  neutral:   { label: 'Neutral',    emoji: '😐', tone: 'neutral'  },
  issue:     { label: 'Problema',   emoji: '😟', tone: 'negative' },
  repeat:    { label: 'Reiteró',    emoji: '🔁', tone: 'negative' },
  upset:     { label: 'Molesta',    emoji: '😤', tone: 'negative' },
  frustrated:{ label: 'Frustrada', emoji: '😤', tone: 'negative' },
  anxious:   { label: 'Ansiosa',   emoji: '😰', tone: 'negative' },
  molesta:   { label: 'Molesta',    emoji: '😤', tone: 'negative' },
  no_lo_uso: { label: 'No lo uso aún', emoji: '⏳', tone: 'neutral' },
};

function StateBadge({ state }) {
  const meta = STATE_META[String(state || '').toLowerCase()] || { label: state || 'Sin estado', emoji: '❓', tone: 'neutral' };
  return (
    <span className={`fdx-state-badge tone-${meta.tone}`}>
      {meta.emoji} {meta.label}
    </span>
  );
}

function formatRelativeDate(isoDate) {
  if (!isoDate) return '—';
  const d = new Date(isoDate);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('es-UY', { day: '2-digit', month: 'short', year: '2-digit' });
}

function maskPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length < 6) return phone || '—';
  return `${digits.slice(0, -4).replace(/.(?=.{2})/g, '·')}${digits.slice(-4)}`;
}

// Lookup normalizado — evita roturas si el estado viene con mayúsculas o espacios del DB
function stateTone(rawState) {
  return STATE_META[String(rawState || '').trim().toLowerCase()]?.tone || 'neutral';
}

const PER_PAGE = 15;

function CampaignContactsList({ contacts = [], campaignSent = 0 }) {
  const [filter, setFilter] = useState('todos');
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState(null);
  const [page, setPage] = useState(1);

  const isNoLoUso = (c) => String(c.state || '').toLowerCase() === 'no_lo_uso';

  const filtered = contacts.filter((c) => {
    if (filter === 'respondio'     && !c.responded) return false;
    if (filter === 'sin_respuesta' && c.responded)  return false;
    if (filter === 'positivo'      && stateTone(c.state) !== 'positive') return false;
    if (filter === 'negativo'      && stateTone(c.state) !== 'negative') return false;
    if (filter === 'no_lo_uso'     && !isNoLoUso(c)) return false;
    if (search) {
      const q = search.toLowerCase();
      if (!String(c.name || '').toLowerCase().includes(q) && !String(c.phone || '').includes(q)) return false;
    }
    return true;
  });

  const totalPages = Math.max(1, Math.ceil(filtered.length / PER_PAGE));
  const safePage   = Math.min(page, totalPages);
  const pageItems  = filtered.slice((safePage - 1) * PER_PAGE, safePage * PER_PAGE);

  const changePage = (next) => {
    setPage(next);
    setExpanded(null);
  };

  const changeFilter = (key) => {
    setFilter(key);
    setPage(1);
    setExpanded(null);
  };

  const changeSearch = (val) => {
    setSearch(val);
    setPage(1);
    setExpanded(null);
  };

  const counts = {
    todos:         contacts.length,
    respondio:     contacts.filter((c) => c.responded).length,
    sin_respuesta: contacts.filter((c) => !c.responded).length,
    positivo:      contacts.filter((c) => stateTone(c.state) === 'positive').length,
    negativo:      contacts.filter((c) => stateTone(c.state) === 'negative').length,
    no_lo_uso:     contacts.filter(isNoLoUso).length,
  };

  return (
    <article className="fdx-card fdx-contacts-card">
      <div className="fdx-contacts-toolbar">
        <h3>Clientes de la campaña de feedback <span className="fdx-contacts-total">{contacts.length} clientes · {campaignSent} mensajes enviados</span></h3>
        <input
          type="text"
          className="module-input fdx-contacts-search"
          placeholder="Buscar por nombre o teléfono..."
          value={search}
          onChange={(e) => changeSearch(e.target.value)}
        />
      </div>

      <div className="fdx-contacts-filters" role="group">
        {[
          { key: 'todos',         label: 'Todos' },
          { key: 'respondio',     label: 'Respondieron' },
          { key: 'sin_respuesta', label: 'Sin respuesta' },
          { key: 'positivo',      label: '😊 Positivo' },
          { key: 'negativo',      label: '😤 Negativo' },
          { key: 'no_lo_uso',     label: '⏳ Aún no lo usan' },
        ].map(({ key, label }) => (
          <button
            key={key}
            type="button"
            className={`fdx-filter-chip${filter === key ? ' is-active' : ''}${key === 'no_lo_uso' ? ' fdx-filter-chip--nlu' : ''}`}
            onClick={() => changeFilter(key)}
          >
            {label} <span>{counts[key]}</span>
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <p className="fdx-contacts-empty">No hay resultados para este filtro.</p>
      ) : (
        <>
          <ul className="fdx-contacts-list">
            {pageItems.map((c) => {
              const isOpen = expanded === c.customerId;
              return (
                <li key={c.customerId} className={`fdx-contact-row${isOpen ? ' is-open' : ''}`}>
                  <button
                    type="button"
                    className="fdx-contact-main"
                    onClick={() => setExpanded(isOpen ? null : c.customerId)}
                    aria-expanded={isOpen}
                  >
                    <span className="fdx-contact-name">{c.name}</span>
                    <span className="fdx-contact-phone">{maskPhone(c.phone)}</span>
                    <span className="fdx-contact-state-col">
                      <StateBadge state={c.state} />
                      {c.requiresHuman && <span className="fdx-contact-human">👤</span>}
                    </span>
                    <span className={`fdx-contact-responded ${c.responded ? 'yes' : 'no'}`}>
                      {c.responded ? '✓ Respondió' : '✗ Sin resp.'}
                    </span>
                    <span className="fdx-contact-date">{formatRelativeDate(c.followupSentAt)}</span>
                  </button>

                  {isOpen && (
                    <div className="fdx-contact-detail">
                      <div className="fdx-contact-dates">
                        <div className="fdx-contact-date-item">
                          <span className="fdx-date-label">Feedback enviado</span>
                          <span className="fdx-date-value">{formatRelativeDate(c.followupSentAt)}</span>
                        </div>
                        <div className="fdx-contact-date-item">
                          <span className="fdx-date-label">Estado actualizado</span>
                          <span className="fdx-date-value">{c.stateUpdatedAt ? formatRelativeDate(c.stateUpdatedAt) : '—'}</span>
                          {c.stateSource && (
                            <span className="fdx-source-tag">{c.stateSource === 'db' ? 'Manual' : 'Bot'}</span>
                          )}
                        </div>
                        {c.lastMessageAt && (
                          <div className="fdx-contact-date-item">
                            <span className="fdx-date-label">Último WhatsApp</span>
                            <span className="fdx-date-value">{formatRelativeDate(c.lastMessageAt)}</span>
                          </div>
                        )}
                        {c.orderCount > 1 && (
                          <div className="fdx-contact-date-item">
                            <span className="fdx-date-label">Pedidos en período</span>
                            <span className="fdx-date-value">{c.orderCount}</span>
                          </div>
                        )}
                      </div>

                      {c.notes && c.notes.length > 0 && (
                        <div className="fdx-contact-notes">
                          <span className="fdx-notes-title">Notas ({c.notes.length})</span>
                          <ul>
                            {c.notes.map((n) => (
                              <li key={n.id}>
                                <span className="fdx-note-content">{n.content}</span>
                                <time className="fdx-note-date">{formatRelativeDate(n.created_at)}</time>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}

                      {!c.notes?.length && !c.stateUpdatedAt && (
                        <p className="fdx-contact-nodata">Sin notas ni estado registrado en base de datos.</p>
                      )}

                      {c.profileSummary && (
                        <details className="fdx-contact-summary">
                          <summary>Ver perfil del bot</summary>
                          <p>{c.profileSummary}</p>
                        </details>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>

          {totalPages > 1 && (
            <div className="fdx-pagination">
              <button
                type="button"
                className="fdx-page-btn"
                onClick={() => changePage(safePage - 1)}
                disabled={safePage === 1}
              >
                ‹ Anterior
              </button>
              <div className="fdx-page-numbers">
                {Array.from({ length: totalPages }, (_, i) => i + 1)
                  .filter((p) => p === 1 || p === totalPages || Math.abs(p - safePage) <= 1)
                  .reduce((acc, p, idx, arr) => {
                    if (idx > 0 && p - arr[idx - 1] > 1) acc.push('…');
                    acc.push(p);
                    return acc;
                  }, [])
                  .map((p, i) =>
                    p === '…' ? (
                      <span key={`ellipsis-${i}`} className="fdx-page-ellipsis">…</span>
                    ) : (
                      <button
                        key={p}
                        type="button"
                        className={`fdx-page-btn fdx-page-num${p === safePage ? ' is-active' : ''}`}
                        onClick={() => changePage(p)}
                      >
                        {p}
                      </button>
                    )
                  )}
              </div>
              <button
                type="button"
                className="fdx-page-btn"
                onClick={() => changePage(safePage + 1)}
                disabled={safePage === totalPages}
              >
                Siguiente ›
              </button>
              <span className="fdx-page-info">{(safePage - 1) * PER_PAGE + 1}–{Math.min(safePage * PER_PAGE, filtered.length)} de {filtered.length}</span>
            </div>
          )}
        </>
      )}
    </article>
  );
}

function SectionLabel({ children }) {
  return <div className="fdx-section-label">{children}</div>;
}

const CATEGORIA_ICONS = {
  'se come o muerde las uñas': '🪤',
  'uñas dañadas o débiles': '💔',
  'cuidado y estética': '✨',
  'ocasión especial': '🎉',
  'prolijas para el trabajo': '💼',
  'curiosidad o exploración': '🔍',
  'regalo o sorpresa': '🎁',
  'uñas cortas o que no crecen': '📏',
  'cambiar hábitos': '🔄',
  'otro': '💬',
};

function RazonesDeCompra({ razones, loading, onAnalizar }) {
  const [subTab, setSubTab] = useState('resumen');
  const [search, setSearch] = useState('');

  const sortedCategories = useMemo(() => {
    if (!razones?.categories) return [];
    return Object.entries(razones.categories)
      .sort(([, a], [, b]) => b.count - a.count);
  }, [razones]);

  const maxCatCount = sortedCategories[0]?.[1]?.count || 1;

  const filteredMotivations = useMemo(() => {
    const list = razones?.motivations || [];
    const q = search.toLowerCase().trim();
    if (!q) return list;
    return list.filter(
      (m) =>
        (m.motivation || '').toLowerCase().includes(q) ||
        (m.name || '').toLowerCase().includes(q) ||
        (m.categoria || '').toLowerCase().includes(q)
    );
  }, [razones, search]);

  return (
    <section className="fdx-razones-section">
      <div className="fdx-razones-header">
        <div>
          <h3>Motivos de contacto</h3>
          <p>Por qué los clientes se acercan — clasificado automáticamente por perfil</p>
        </div>
        <div className="fdx-razones-actions">
          {razones && (
            <span className="fdx-razones-meta">
              {razones.totalAnalyzed} analizados
              {razones.newlyAnalyzed > 0 && ` · ${razones.newlyAnalyzed} nuevos`}
            </span>
          )}
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => onAnalizar(true)} disabled={loading}>
            {loading ? 'Analizando...' : razones ? 'Actualizar' : 'Analizar con IA'}
          </button>
        </div>
      </div>

      {loading && (
        <div className="fdx-razones-loading">
          <div className="fdx-razones-spinner" />
          <span>OpenAI analizando perfiles… puede demorar un momento</span>
        </div>
      )}

      {!loading && !razones && (
        <div className="fdx-razones-empty">
          <p>Hacé clic en <strong>"Analizar con IA"</strong> para que OpenAI identifique el motivo de contacto de cada cliente.<br />Los resultados se guardan y no se reprocesa lo ya analizado.</p>
        </div>
      )}

      {!loading && razones && (
        <>
          <div className="fdx-razones-subtabs">
            <button
              type="button"
              className={`fdx-razones-subtab ${subTab === 'resumen' ? 'is-active' : ''}`}
              onClick={() => setSubTab('resumen')}
            >
              Resumen por motivo
            </button>
            <button
              type="button"
              className={`fdx-razones-subtab ${subTab === 'detalle' ? 'is-active' : ''}`}
              onClick={() => setSubTab('detalle')}
            >
              Todos los clientes ({razones.totalAnalyzed})
            </button>
          </div>

          {subTab === 'resumen' && (
            <div className="fdx-razones-top">
              {sortedCategories.length === 0 ? (
                <p className="fdx-razones-empty">Sin datos de categorías.</p>
              ) : (
                <div className="fdx-razones-block">
                  {sortedCategories.map(([cat, info]) => (
                    <div key={cat} className="fdx-bigram-row fdx-cat-row">
                      <span className="fdx-bigram-label">
                        {CATEGORIA_ICONS[cat] || '💬'} {cat}
                      </span>
                      <div className="fdx-razon-bar-wrap">
                        <div
                          className="fdx-razon-bar fdx-razon-bar--teal"
                          style={{ width: `${Math.round((info.count / maxCatCount) * 100)}%` }}
                        />
                      </div>
                      <span className="fdx-bigram-count">{info.count}</span>
                      {info.examples?.length > 0 && (
                        <div className="fdx-cat-examples">
                          {info.examples.slice(0, 3).map((ex, i) => (
                            <span key={i} className="fdx-cat-example">"{ex}"</span>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {subTab === 'detalle' && (
            <div className="fdx-razones-detalle">
              <input
                className="module-input fdx-razones-search"
                type="text"
                placeholder="Buscar por nombre, motivo o categoría..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <div className="fdx-summaries-list">
                {filteredMotivations.length === 0 && (
                  <p className="fdx-razones-empty">Sin resultados.</p>
                )}
                {filteredMotivations.map((m, i) => (
                  <div key={i} className="fdx-summary-row">
                    <div className="fdx-summary-meta">
                      <span className="fdx-summary-name">{m.name || 'Sin nombre'}</span>
                      {m.stage && <span className="fdx-summary-stage">{m.stage}</span>}
                      {m.categoria && (
                        <span className="fdx-summary-product">
                          {CATEGORIA_ICONS[m.categoria] || '💬'} {m.categoria}
                        </span>
                      )}
                    </div>
                    <p className="fdx-summary-text">{m.motivation}</p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function FeedbackDashboardPanel({ mostrarToast }) {
  const [days, setDays] = useState(30);
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState(null);
  const [activeTab, setActiveTab] = useState('resumen');
  const [razones, setRazones] = useState(null);
  const [loadingRazones, setLoadingRazones] = useState(false);

  const loadDashboard = async () => {
    try {
      setLoading(true);
      const result = await obtenerFeedbackDashboard({ days });
      if (!result?.success) {
        mostrarToast?.(result?.error || 'No se pudo cargar dashboard feedback', 'error');
        return;
      }
      setData(result);
    } catch (error) {
      mostrarToast?.(error.message || 'Error cargando dashboard feedback', 'error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadDashboard();
  }, [days]);

  const handleAnalizarRazones = async (force = false) => {
    try {
      setLoadingRazones(true);
      const result = await analizarRazonesCompra(force);
      if (!result?.success) {
        mostrarToast?.(result?.error || 'Error analizando razones', 'error');
        return;
      }
      setRazones(result.data);
    } catch (err) {
      mostrarToast?.(err.message || 'Error analizando razones', 'error');
    } finally {
      setLoadingRazones(false);
    }
  };

  const campaign = data?.campaignFeedback?.kpis || { sent: 0, responded: 0, ok: 0, notOk: 0, noResponse: 0 };
  const campaignSentiment = data?.campaignFeedback?.sentiment || { positive: 0, neutral: 0, negative: 0 };
  const campaignContacts = data?.campaignFeedback?.contacts || [];
  const noLoUsoCount = campaignContacts.filter((c) => String(c.state || '').toLowerCase() === 'no_lo_uso').length;
  const timeline = data?.campaignFeedback?.timeline || [];
  const hotOverview = data?.hotRedis?.overview || { contacts: 0, activeLast24h: 0, requiresHuman: 0, paused: 0, blacklisted: 0, botActive: 0 };
  const hotSentiment = data?.hotRedis?.sentiment || { positive: 0, neutral: 0, negative: 0 };
  const hotTops = data?.hotRedis?.tops || {};
  const dictionary = data?.dictionary || {};

  // Últimos 7 días para evolución (antes eran 3)
  const recentTimeline = useMemo(() => timeline.slice(-7), [timeline]);
  const responseSeries   = recentTimeline.map((d) => d.responded || 0);
  const conversionSeries = recentTimeline.map((d) => d.ok || 0);
  const frictionSeries   = recentTimeline.map((d) => d.notOk || 0);

  // Tasas de campaña
  const responseRate = percent(campaign.responded, campaign.sent);
  // Conversión: tasa sobre enviados (alcance) y sobre respondidos (efectividad)
  const conversionRateAlcance     = percent(campaign.ok, campaign.sent);
  const conversionRateEfectividad = percent(campaign.ok, campaign.responded);
  const frictionRate = percent(campaign.notOk, campaign.sent);

  // Tendencias comparando último día vs promedio de anteriores
  const responseTrend   = computeTrend(responseSeries);
  const conversionTrend = computeTrend(conversionSeries);
  const frictionTrend   = computeTrend(frictionSeries);

  const insightCards = (data?.hotRedis?.insights || []).map((insight) => ({
    title: insight.label,
    subtitle: insight.action,
    tone: insight.severity === 'Alta' ? 'alert' : insight.severity === 'Media' ? 'warning' : 'neutral',
    level: insight.severity,
  }));

  // En resumen solo mostramos dolores de Redis; en conversaciones agregamos "Sin respuesta" de campaña
  const lossItemsResumen = (hotTops.dolores || []).filter((x) => x.count > 0).slice(0, 5);
  const lossItemsCampana = [
    { label: 'Sin respuesta', count: campaign.noResponse },
    ...(hotTops.dolores || []),
  ].filter((x) => x.count > 0).slice(0, 5);

  // lossItemsCampana se usa en la tab conversaciones si se necesita; lossItemsResumen en resumen

  const preCompra  = (hotTops.dudas   || []).slice(0, 5);
  const postCompra = (hotTops.quejas  || []).slice(0, 5);

  const sentimentTotal = hotSentiment.positive + hotSentiment.neutral + hotSentiment.negative;
  const donutStyle = sentimentTotal > 0 ? {
    background: `conic-gradient(
      #67b36a 0 ${percent(hotSentiment.positive, sentimentTotal)}%,
      #edc858 ${percent(hotSentiment.positive, sentimentTotal)}% ${percent(hotSentiment.positive + hotSentiment.neutral, sentimentTotal)}%,
      #de5a67 ${percent(hotSentiment.positive + hotSentiment.neutral, sentimentTotal)}% 100%
    )`,
  } : { background: '#ede8e8' };

  const evolutionMax = Math.max(...recentTimeline.map((r) => Math.max(r.responded || 0, r.notOk || 0, r.ok || 0)), 1);

  const linePoints = (field) => {
    const values = recentTimeline.map((x) => x[field] || 0);
    const width  = 420;
    const height = 90;
    const step   = values.length > 1 ? width / (values.length - 1) : width;
    return values.map((v, i) => {
      const x = Math.round(i * step);
      const y = Math.round(height - (v / evolutionMax) * height);
      return `${x},${y}`;
    }).join(' ');
  };

  return (
    <div className="main-content fdx-shell">
      <header className="fdx-header">
        <div>
          <h2>Resumen general</h2>
          <p>Vista estratégica de campañas WhatsApp y data en tiempo real del bot Redis</p>
        </div>
        <div className="fdx-header-controls">
          <select
            className="module-input"
            value={days}
            onChange={(e) => setDays(parseInt(e.target.value, 10))}
          >
            <option value={7}>Últimos 7 días</option>
            <option value={15}>Últimos 15 días</option>
            <option value={30}>Últimos 30 días</option>
            <option value={60}>Últimos 60 días</option>
          </select>
          <button type="button" className="btn btn-secondary btn-sm" onClick={loadDashboard} disabled={loading}>
            {loading ? 'Actualizando...' : 'Actualizar ahora'}
          </button>
        </div>
      </header>

      <div className="fdx-tabs" role="tablist" aria-label="Vistas del dashboard">
        <button type="button" role="tab" aria-selected={activeTab === 'resumen'} className={`fdx-tab ${activeTab === 'resumen' ? 'is-active' : ''}`} onClick={() => setActiveTab('resumen')}>
          Resumen
        </button>
        <button type="button" role="tab" aria-selected={activeTab === 'campanas'} className={`fdx-tab ${activeTab === 'campanas' ? 'is-active' : ''}`} onClick={() => setActiveTab('campanas')}>
          Campañas
        </button>
        <button type="button" role="tab" aria-selected={activeTab === 'conversaciones'} className={`fdx-tab ${activeTab === 'conversaciones' ? 'is-active' : ''}`} onClick={() => setActiveTab('conversaciones')}>
          Conversaciones
        </button>
        <button type="button" role="tab" aria-selected={activeTab === 'razones'} className={`fdx-tab ${activeTab === 'razones' ? 'is-active' : ''}`} onClick={() => { setActiveTab('razones'); if (!razones) handleAnalizarRazones(); }}>
          Razones de compra
        </button>
      </div>

      {/* ── Insights ── */}
      {activeTab === 'resumen' && (
        <section className="fdx-insight-strip">
          <div className="fdx-insight-intro">
            <span>Hoy está pasando esto:</span>
          </div>
          {insightCards.map((item) => (
            <article key={item.title} className={`fdx-insight-card tone-${item.tone}`}>
              <em className={`fdx-level ${item.tone}`}>{item.level}</em>
              <strong>{item.title}</strong>
              <small>{item.subtitle}</small>
            </article>
          ))}
        </section>
      )}

      {/* ── Campaña WhatsApp (solo tab campanas) ── */}
      {activeTab === 'campanas' && (
        <SectionLabel>Campaña de feedback WhatsApp</SectionLabel>
      )}

      {activeTab === 'campanas' && (
        <div className="fdx-campaign-kpi-row">
        <section className="fdx-kpi-grid">
          <KpiCard
            title="Tasa de respuesta"
            value={`${responseRate}%`}
            detail={`${campaign.responded} / ${campaign.sent} enviadas`}
            delta={responseTrend.text}
            deltaUp={responseTrend.up}
            series={responseSeries}
            tooltip={data?.campaignFeedback?.criteria?.responded || ''}
          />
          <KpiCard
            title="Conversación → compra"
            value={`${conversionRateEfectividad}%`}
            detail={`Efectividad: ${campaign.ok} / ${campaign.responded} respondieron`}
            secondValue={`${conversionRateAlcance}%`}
            secondLabel={`Alcance: ${campaign.ok} / ${campaign.sent} enviadas`}
            delta={conversionTrend.text}
            deltaUp={conversionTrend.up}
            series={conversionSeries}
            tooltip="Efectividad = ok / respondidos. Alcance = ok / enviados."
          />
          <KpiCard
            title="Clientes poco satisfechos"
            value={`${frictionRate}%`}
            detail={`${campaign.notOk} / ${campaign.sent} enviadas`}
            delta={frictionTrend.text}
            deltaUp={frictionTrend.up}
            series={frictionSeries}
            tooltip={data?.campaignFeedback?.criteria?.notOk || ''}
          />
        </section>

        {/* Donut sentimiento de campaña */}
        {(() => {
          const trueNeutral = campaignSentiment.neutral - noLoUsoCount;
          const total = campaignSentiment.positive + campaignSentiment.neutral + campaignSentiment.negative;
          // 4 segmentos: positivo, neutral puro, no_lo_uso, negativo
          const pPos   = percent(campaignSentiment.positive, total);
          const pNeu   = percent(trueNeutral, total);
          const pNlu   = percent(noLoUsoCount, total);
          const style = total > 0 ? {
            background: `conic-gradient(
              #67b36a 0 ${pPos}%,
              #edc858 ${pPos}% ${pPos + pNeu}%,
              #4ab5c4 ${pPos + pNeu}% ${pPos + pNeu + pNlu}%,
              #de5a67 ${pPos + pNeu + pNlu}% 100%
            )`,
          } : { background: '#ede8e8' };
          return (
            <article className="fdx-card fdx-campaign-sentiment">
              <h3>Sentimiento de campaña</h3>
              <p className="fdx-sentiment-note">Basado en estado registrado de clientes que respondieron</p>
              <div className="fdx-experience">
                <div className={`fdx-donut${total === 0 ? ' fdx-donut-empty' : ''}`} style={style}>
                  <div className="fdx-donut-hole">
                    {total === 0 && <span className="fdx-donut-empty-label">Sin datos</span>}
                  </div>
                </div>
                <ul className="fdx-sentiment-list">
                  <li><span className="dot positive" />Positivo<strong>{campaignSentiment.positive} ({formatPct(campaignSentiment.positive, total)})</strong></li>
                  <li><span className="dot neutral" />Neutral<strong>{trueNeutral} ({formatPct(trueNeutral, total)})</strong></li>
                  {noLoUsoCount > 0 && (
                    <li><span className="dot nlu" />Aún no lo usan<strong>{noLoUsoCount} ({formatPct(noLoUsoCount, total)})</strong></li>
                  )}
                  <li><span className="dot negative" />Poco satisfechos<strong>{campaignSentiment.negative} ({formatPct(campaignSentiment.negative, total)})</strong></li>
                </ul>
              </div>
            </article>
          );
        })()}
        </div>
      )}

      {/* Lista de contactos de campaña */}
      {activeTab === 'campanas' && (
        <CampaignContactsList contacts={campaignContacts} campaignSent={campaign.sent} />
      )}

      {/* ════════════════════════════════
           RESUMEN — Redis overview + análisis compacto
          ════════════════════════════════ */}
      {activeTab === 'resumen' && (
        <>
          <SectionLabel>Bot Redis — en tiempo real</SectionLabel>
          <BotStatusBlock overview={hotOverview} />

          <SectionLabel>Análisis de conversaciones</SectionLabel>
          <section className="fdx-main-grid">
            <article className="fdx-card">
              <h3>Dónde estamos perdiendo ventas</h3>
              <ol className="fdx-loss-list">
                {lossItemsResumen.map((item) => (
                  <li key={item.label}>
                    <span>{dictionaryEntry(item.label, dictionary).label}</span>
                    <div className="fdx-loss-bar-wrap">
                      <div className="fdx-loss-bar" style={{ width: `${Math.max(10, Math.round((item.count / Math.max(...lossItemsResumen.map((x) => x.count), 1)) * 100))}%` }} />
                    </div>
                    <strong>{item.count}</strong>
                  </li>
                ))}
              </ol>
            </article>

            <article className="fdx-card">
              <h3>Embudo conversacional</h3>
              <div className="fdx-funnel-grid">
                <div>
                  <h4>Pre compra</h4>
                  <ul>
                    {preCompra.map((item) => (
                      <li key={item.label}><span>{dictionaryEntry(item.label, dictionary).label}</span><strong>{item.count}</strong></li>
                    ))}
                  </ul>
                </div>
                <div>
                  <h4>Post compra</h4>
                  <ul>
                    {postCompra.map((item) => (
                      <li key={item.label}><span>{dictionaryEntry(item.label, dictionary).label}</span><strong>{item.count}</strong></li>
                    ))}
                  </ul>
                </div>
              </div>
            </article>

            <article className="fdx-card">
              <h3>Experiencia del cliente</h3>
              <div className="fdx-experience">
                <div className={`fdx-donut${sentimentTotal === 0 ? ' fdx-donut-empty' : ''}`} style={donutStyle}>
                  <div className="fdx-donut-hole">
                    {sentimentTotal === 0 && <span className="fdx-donut-empty-label">Sin datos</span>}
                  </div>
                </div>
                <ul className="fdx-sentiment-list">
                  <li><span className="dot positive" />Positivo<strong>{hotSentiment.positive} ({formatPct(hotSentiment.positive, sentimentTotal)})</strong></li>
                  <li><span className="dot neutral" />Neutro<strong>{hotSentiment.neutral} ({formatPct(hotSentiment.neutral, sentimentTotal)})</strong></li>
                  <li><span className="dot negative" />Negativo<strong>{hotSentiment.negative} ({formatPct(hotSentiment.negative, sentimentTotal)})</strong></li>
                </ul>
              </div>
            </article>
          </section>

          <section className="fdx-top-lists">
            <SimpleList title="Intenciones frecuentes" items={(hotTops.intents || []).slice(0, 8)} emptyText="Sin datos" dictionary={dictionary} />
            <SimpleList title="Subintents frecuentes" items={(hotTops.subintents || []).slice(0, 8)} emptyText="Sin datos" dictionary={dictionary} />
            <SimpleList title="Razones de compra" items={(hotTops.razonesCompra || []).slice(0, 8)} emptyText="Sin datos" showAction={false} dictionary={dictionary} />
          </section>
        </>
      )}

      {/* ════════════════════════════════
           CONVERSACIONES — Comportamiento completo del bot Redis
          ════════════════════════════════ */}
      {activeTab === 'conversaciones' && (
        <>
          {/* Estado del bot */}
          <SectionLabel>Estado del bot</SectionLabel>
          <BotStatusBlock overview={hotOverview} />

          {/* Comportamiento — intenciones, subintents, etapas */}
          <SectionLabel>Comportamiento del bot</SectionLabel>
          <section className="fdx-top-lists">
            <SimpleList
              title="Intenciones frecuentes"
              items={(hotTops.intents || []).slice(0, 10)}
              emptyText="Sin datos de intención"
              dictionary={dictionary}
            />
            <SimpleList
              title="Subintenciones frecuentes"
              items={(hotTops.subintents || []).slice(0, 10)}
              emptyText="Sin datos de subintención"
              dictionary={dictionary}
            />
            <SimpleList
              title="Etapas del funnel"
              items={(hotTops.stages || []).slice(0, 10)}
              emptyText="Sin datos de etapa"
              showAction={false}
              dictionary={dictionary}
            />
          </section>

          {/* Acciones pendientes y motivaciones */}
          <SectionLabel>Acciones y motivaciones</SectionLabel>
          <section className="fdx-top-lists fdx-top-lists-2col">
            <SimpleList
              title="Acciones pendientes sin resolver"
              items={(hotTops.pendientes || []).slice(0, 8)}
              emptyText="Sin acciones pendientes"
              showAction={false}
              dictionary={dictionary}
            />
            <SimpleList
              title="Razones de compra detectadas"
              items={(hotTops.razonesCompra || []).slice(0, 8)}
              emptyText="Sin datos de razones"
              showAction={false}
              dictionary={dictionary}
            />
          </section>

          {/* Embudo conversacional */}
          <SectionLabel>Embudo conversacional</SectionLabel>
          <section className="fdx-top-lists fdx-top-lists-2col">
            <SimpleList
              title="Pre compra — dudas frecuentes"
              items={(hotTops.dudas || []).slice(0, 8)}
              emptyText="Sin dudas registradas"
              dictionary={dictionary}
            />
            <SimpleList
              title="Post compra — quejas y reclamos"
              items={(hotTops.quejas || []).slice(0, 8)}
              emptyText="Sin quejas registradas"
              dictionary={dictionary}
            />
          </section>

          {/* Sentimiento y fricción */}
          <SectionLabel>Sentimiento y fricción</SectionLabel>
          <section className="fdx-conv-bottom-grid">
            <article className="fdx-card">
              <h3>Experiencia del cliente (Redis global)</h3>
              <div className="fdx-experience">
                <div className={`fdx-donut${sentimentTotal === 0 ? ' fdx-donut-empty' : ''}`} style={donutStyle}>
                  <div className="fdx-donut-hole">
                    {sentimentTotal === 0 && <span className="fdx-donut-empty-label">Sin datos</span>}
                  </div>
                </div>
                <ul className="fdx-sentiment-list">
                  <li><span className="dot positive" />Positivo<strong>{hotSentiment.positive} ({formatPct(hotSentiment.positive, sentimentTotal)})</strong></li>
                  <li><span className="dot neutral" />Neutro<strong>{hotSentiment.neutral} ({formatPct(hotSentiment.neutral, sentimentTotal)})</strong></li>
                  <li><span className="dot negative" />Negativo<strong>{hotSentiment.negative} ({formatPct(hotSentiment.negative, sentimentTotal)})</strong></li>
                </ul>
              </div>
              <div className="fdx-alert-box">
                <strong>Principales problemas detectados</strong>
                <ul>
                  {(hotTops.quejas || []).slice(0, 3).map((q) => (
                    <li key={q.label}>{dictionaryEntry(q.label, dictionary).label}</li>
                  ))}
                </ul>
              </div>
            </article>

            <article className="fdx-card">
              <h3>Puntos de dolor — clientes poco satisfechos</h3>
              <ol className="fdx-loss-list">
                {(hotTops.dolores || []).slice(0, 6).map((item) => (
                  <li key={item.label}>
                    <span>{dictionaryEntry(item.label, dictionary).label}</span>
                    <div className="fdx-loss-bar-wrap">
                      <div className="fdx-loss-bar" style={{ width: `${Math.max(10, Math.round((item.count / Math.max(...(hotTops.dolores || []).map((x) => x.count), 1)) * 100))}%` }} />
                    </div>
                    <strong>{item.count}</strong>
                  </li>
                ))}
              </ol>
            </article>
          </section>
        </>
      )}

      {/* Evolución — solo campañas (es data de pedidos, no del bot) */}
      {activeTab === 'campanas' && (
        <article className="fdx-card fdx-evolution-card">
          <h3>Evolución últimos {recentTimeline.length} días</h3>
          <div className="fdx-lines-legend">
            <span className="respuestas">Respuestas</span>
            <span className="fricciones">Poco satisfechos</span>
            <span className="conversiones">Conversiones</span>
          </div>
          <svg className="fdx-lines" viewBox="0 0 420 95" aria-hidden="true" focusable="false">
            <polyline points={linePoints('responded')} className="line respuestas" />
            <polyline points={linePoints('notOk')}     className="line fricciones" />
            <polyline points={linePoints('ok')}        className="line conversiones" />
          </svg>
          <div className="fdx-lines-dates">
            {recentTimeline.map((d) => <span key={d.date}>{formatDateLabel(d.date)}</span>)}
          </div>
        </article>
      )}

      {data?.warnings?.redis && (
        <div className="fdx-warning">Redis no disponible: {data.warnings.redis}</div>
      )}

      {/* ── Razones de compra ── */}
      {activeTab === 'razones' && (
        <RazonesDeCompra
          razones={razones}
          loading={loadingRazones}
          onAnalizar={handleAnalizarRazones}
        />
      )}
    </div>
  );
}

export default FeedbackDashboardPanel;

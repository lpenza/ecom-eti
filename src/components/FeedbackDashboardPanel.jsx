import React, { useEffect, useMemo, useState } from 'react';
import { obtenerFeedbackDashboard } from '../services/api';

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

function KpiCard({ title, value, detail, delta, deltaUp, series = [], tooltip = '' }) {
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

function FeedbackDashboardPanel({ mostrarToast }) {
  const [days, setDays] = useState(30);
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState(null);
  const [activeTab, setActiveTab] = useState('resumen');

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

  const campaign = data?.campaignFeedback?.kpis || { sent: 0, responded: 0, ok: 0, notOk: 0, noResponse: 0 };
  const timeline = data?.campaignFeedback?.timeline || [];
  const hotOverview = data?.hotRedis?.overview || { contacts: 0, activeLast24h: 0, requiresHuman: 0, paused: 0, blacklisted: 0, botActive: 0 };
  const hotSentiment = data?.hotRedis?.sentiment || { positive: 0, neutral: 0, negative: 0 };
  const hotTops = data?.hotRedis?.tops || {};
  const dictionary = data?.dictionary || {};

  const recentTimeline = useMemo(() => timeline.slice(-3), [timeline]);
  const responseSeries = recentTimeline.map((d) => d.responded || 0);
  const conversionSeries = recentTimeline.map((d) => d.ok || 0);
  const frictionSeries = recentTimeline.map((d) => d.notOk || 0);

  const responseRate = percent(campaign.responded, campaign.sent);
  const conversionRate = percent(campaign.ok, campaign.sent);
  const frictionRate = percent(campaign.notOk, campaign.sent);

  const insightCards = (data?.hotRedis?.insights || []).map((insight) => ({
    title: insight.label,
    subtitle: insight.action,
    tone: insight.severity === 'Alta' ? 'alert' : insight.severity === 'Media' ? 'warning' : 'neutral',
    level: insight.severity,
  }));

  const lossItems = [
    { label: 'Sin respuesta', count: campaign.noResponse },
    ...(hotTops.dolores || []),
  ]
    .filter((x) => x.count > 0)
    .slice(0, 5);

  const maxLoss = Math.max(...lossItems.map((x) => x.count), 1);

  const preCompra = (hotTops.dudas || []).slice(0, 5);
  const postCompra = (hotTops.quejas || []).slice(0, 5);

  const sentimentTotal = hotSentiment.positive + hotSentiment.neutral + hotSentiment.negative;
  const donutStyle = {
    background: `conic-gradient(
      #67b36a 0 ${percent(hotSentiment.positive, sentimentTotal)}%,
      #edc858 ${percent(hotSentiment.positive, sentimentTotal)}% ${percent(hotSentiment.positive + hotSentiment.neutral, sentimentTotal)}%,
      #de5a67 ${percent(hotSentiment.positive + hotSentiment.neutral, sentimentTotal)}% 100%
    )`,
  };

  const evolutionMax = Math.max(...recentTimeline.map((r) => Math.max(r.responded || 0, r.notOk || 0, r.ok || 0)), 1);

  const linePoints = (field) => {
    const values = recentTimeline.map((x) => x[field] || 0);
    const width = 280;
    const height = 90;
    const step = values.length > 1 ? width / (values.length - 1) : width;
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
          <p>Vista estrategica de campanas WhatsApp y data caliente de Redis</p>
        </div>
        <div className="fdx-header-controls">
          <select
            className="module-input"
            value={days}
            onChange={(e) => setDays(parseInt(e.target.value, 10))}
          >
            <option value={7}>Ultimos 7 dias</option>
            <option value={15}>Ultimos 15 dias</option>
            <option value={30}>Ultimos 30 dias</option>
            <option value={60}>Ultimos 60 dias</option>
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
          Campanas
        </button>
        <button type="button" role="tab" aria-selected={activeTab === 'conversaciones'} className={`fdx-tab ${activeTab === 'conversaciones' ? 'is-active' : ''}`} onClick={() => setActiveTab('conversaciones')}>
          Conversaciones
        </button>
      </div>

      {activeTab === 'resumen' && (
      <section className="fdx-insight-strip">
        <div className="fdx-insight-intro">
          <span>Hoy esta pasando esto:</span>
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

      {(activeTab === 'resumen' || activeTab === 'campanas') && (
      <section className="fdx-kpi-grid">
        <KpiCard
          title="Tasa de respuesta"
          value={`${responseRate}%`}
          detail={`${campaign.responded} / ${campaign.sent} enviadas`}
          delta={`${campaign.responded === 0 ? '=' : '▲'} ${campaign.responded}`}
          deltaUp={campaign.responded > 0}
          series={responseSeries}
          tooltip={data?.campaignFeedback?.criteria?.responded || ''}
        />
        <KpiCard
          title="Conversacion -> compra"
          value={`${conversionRate}%`}
          detail={`${campaign.ok} / ${campaign.sent} enviadas`}
          delta={`${campaign.ok === 0 ? '=' : '▲'} ${campaign.ok}`}
          deltaUp={campaign.ok > 0}
          series={conversionSeries}
          tooltip={data?.campaignFeedback?.criteria?.ok || ''}
        />
        <KpiCard
          title="Tasa de friccion"
          value={`${frictionRate}%`}
          detail={`${campaign.notOk} / ${campaign.sent} enviadas`}
          delta={`${campaign.notOk === 0 ? '=' : '▲'} ${campaign.notOk}`}
          deltaUp={campaign.notOk > 0}
          series={frictionSeries}
          tooltip={data?.campaignFeedback?.criteria?.notOk || ''}
        />
      </section>
      )}

      {(activeTab === 'resumen' || activeTab === 'conversaciones') && (
      <section className="fdx-main-grid">
        <article className="fdx-card">
          <h3>Donde estamos perdiendo ventas</h3>
          <ol className="fdx-loss-list">
            {lossItems.map((item) => (
              <li key={item.label}>
                <span>{dictionaryEntry(item.label, dictionary).label}</span>
                <div className="fdx-loss-bar-wrap">
                  <div className="fdx-loss-bar" style={{ width: `${Math.max(10, Math.round((item.count / maxLoss) * 100))}%` }} />
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
            <div className="fdx-donut" style={donutStyle}>
              <div className="fdx-donut-hole" />
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
              {(hotTops.quejas || []).slice(0, 3).map((q) => <li key={q.label}>{dictionaryEntry(q.label, dictionary).label}</li>)}
            </ul>
          </div>
        </article>
      </section>
      )}

      {(activeTab === 'resumen' || activeTab === 'conversaciones') && (
      <section className="fdx-bottom-grid">
        <article className="fdx-card">
          <h3>Estado del sistema (Redis)</h3>
          <div className="fdx-status-grid">
            <div><span>Contactos activos</span><strong>{hotOverview.contacts}</strong></div>
            <div><span>Requiere humano</span><strong>{hotOverview.requiresHuman}</strong></div>
            <div><span>Bot pausado</span><strong>{hotOverview.paused}</strong></div>
            <div><span>Blacklist</span><strong>{hotOverview.blacklisted}</strong></div>
            <div><span>Bot activo</span><strong>{hotOverview.botActive}</strong></div>
          </div>
        </article>

        <article className="fdx-card">
          <h3>Evolucion ultimos 3 dias</h3>
          <div className="fdx-lines-legend">
            <span className="respuestas">Respuestas</span>
            <span className="fricciones">Fricciones</span>
            <span className="conversiones">Conversiones</span>
          </div>
          <svg className="fdx-lines" viewBox="0 0 280 95" aria-hidden="true" focusable="false">
            <polyline points={linePoints('responded')} className="line respuestas" />
            <polyline points={linePoints('notOk')} className="line fricciones" />
            <polyline points={linePoints('ok')} className="line conversiones" />
          </svg>
          <div className="fdx-lines-dates">
            {recentTimeline.map((d) => <span key={d.date}>{formatDateLabel(d.date)}</span>)}
          </div>
        </article>
      </section>
      )}

      {(activeTab === 'resumen' || activeTab === 'conversaciones') && (
      <section className="fdx-top-lists">
        <SimpleList title="Intenciones frecuentes (Redis)" items={(hotTops.intents || []).slice(0, 8)} emptyText="Sin datos de intent" dictionary={dictionary} />
        <SimpleList title="Subintents frecuentes (Redis)" items={(hotTops.subintents || []).slice(0, 8)} emptyText="Sin datos de subintent" dictionary={dictionary} />
        <SimpleList title="Razones de compra" items={(hotTops.razonesCompra || []).slice(0, 8)} emptyText="Sin datos de razones" showAction={false} dictionary={dictionary} />
      </section>
      )}

      {data?.warnings?.redis && <div className="fdx-warning">Redis no disponible: {data.warnings.redis}</div>}
    </div>
  );
}

export default FeedbackDashboardPanel;

import React from 'react';
import { useNotificaciones } from '../context/NotificacionesContext';
import { formatFechaHoraUy, tiempoRelativoUy } from '../utils/fechas';

const ICONO_POR_TIPO = {
  levante_auto: '📦',
  levante_manual: '📦',
  pickup_programado: '⏱',
  pickup_despachado: '🏬',
};

const ICONO_POR_NIVEL = {
  ok: '✅',
  error: '⚠️',
  warning: '⚠️',
  info: 'ℹ️',
};

/**
 * Columna lateral con las notificaciones de procesos automáticos (levantes UES y
 * pickups diferidos). Se puede ocultar desde el botón del header o desde su ✕,
 * pero mientras haya notificaciones sin leer se muestra igual: recién se pliega
 * cuando están todas marcadas como leídas.
 */
function NotificacionesPanel() {
  const notif = useNotificaciones();
  if (!notif) return null;

  const {
    notificaciones,
    noLeidas,
    leidas,
    hayNoLeidas,
    cargando,
    error,
    marcando,
    mostrarPanel,
    cambiarOculto,
    marcarLeida,
    marcarTodas,
  } = notif;

  const renderItem = (n) => (
    <article
      key={n.id}
      className={`notif-item notif-item-${n.nivel || 'info'}${n.leida ? ' notif-item-leida' : ''}`}
    >
      <div className="notif-item-head">
        <span className="notif-item-icon">
          {ICONO_POR_TIPO[n.tipo] || ICONO_POR_NIVEL[n.nivel] || 'ℹ️'}
        </span>
        <span className="notif-item-title">{n.titulo}</span>
      </div>
      {n.mensaje && <p className="notif-item-msg">{n.mensaje}</p>}
      <div className="notif-item-foot">
        <time title={formatFechaHoraUy(n.created_at)}>{tiempoRelativoUy(n.created_at)}</time>
        {!n.leida ? (
          <button type="button" className="notif-item-marcar" onClick={() => marcarLeida(n.id)}>
            OK, leído
          </button>
        ) : (
          <span className="notif-item-leida-tag">Leído</span>
        )}
      </div>
    </article>
  );

  // Plegado se reabre desde el botón 🔔 del nav lateral.
  if (cargando || !mostrarPanel) return null;

  return (
    <aside className={`notif-panel${hayNoLeidas ? ' notif-panel-alerta' : ''}`}>
      <header className="notif-panel-header">
        <span className="notif-panel-title">
          🔔 Notificaciones
          {hayNoLeidas && <span className="notif-badge">{noLeidas.length}</span>}
        </span>
        <button
          type="button"
          className="notif-panel-close"
          onClick={() => cambiarOculto(true)}
          disabled={hayNoLeidas}
          title={
            hayNoLeidas
              ? 'Marcá las notificaciones como leídas para poder ocultar el panel'
              : 'Ocultar panel'
          }
        >
          ✕
        </button>
      </header>

      {error && <div className="notif-panel-error">{error}</div>}

      <div className="notif-list">
        {notificaciones.length === 0 && (
          <p className="notif-empty">
            Sin notificaciones todavía.
            <br />
            Acá van a aparecer los levantes y los pickups automáticos.
          </p>
        )}

        {hayNoLeidas && <h3 className="notif-group">Sin leer</h3>}
        {noLeidas.map(renderItem)}

        {leidas.length > 0 && <h3 className="notif-group">Historial</h3>}
        {leidas.map(renderItem)}
      </div>

      {hayNoLeidas && (
        <footer className="notif-panel-footer">
          <button
            type="button"
            className="notif-marcar-todas"
            onClick={marcarTodas}
            disabled={marcando}
          >
            {marcando ? 'Marcando…' : `Marcar ${noLeidas.length} como leídas`}
          </button>
        </footer>
      )}
    </aside>
  );
}

export default NotificacionesPanel;

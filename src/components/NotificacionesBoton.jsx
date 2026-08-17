import React from 'react';
import { useNotificaciones } from '../context/NotificacionesContext';

/**
 * Botón de notificaciones del nav lateral. Está en todas las vistas, abre y
 * cierra el panel, y se ilumina mientras haya notificaciones sin leer.
 */
function NotificacionesBoton() {
  const notif = useNotificaciones();
  if (!notif) return null;

  const { noLeidas, hayNoLeidas, mostrarPanel, alternarPanel } = notif;

  return (
    <button
      type="button"
      className={`side-nav-item notif-nav-btn${hayNoLeidas ? ' notif-nav-btn-alerta' : ''}`}
      onClick={alternarPanel}
      aria-pressed={mostrarPanel}
      title={
        hayNoLeidas
          ? `${noLeidas.length} notificación(es) sin leer`
          : mostrarPanel ? 'Ocultar notificaciones' : 'Ver notificaciones'
      }
    >
      <span className="side-nav-icon">🔔</span>
      Notificaciones
      {hayNoLeidas && <span className="notif-nav-count">{noLeidas.length}</span>}
    </button>
  );
}

export default NotificacionesBoton;

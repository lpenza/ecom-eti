import React, { useEffect } from 'react';
import { useNotificaciones } from '../context/NotificacionesContext';

/**
 * Botón de notificaciones del header (al lado de "UES Conectado"). Abre y cierra
 * el panel lateral, y se ilumina mientras haya notificaciones sin leer.
 */
function NotificacionesBoton() {
  const notif = useNotificaciones();
  const registrar = notif?.setBotonEnHeader;

  // Mientras este botón esté montado, el panel no dibuja su propio launcher.
  useEffect(() => {
    if (!registrar) return undefined;
    registrar(true);
    return () => registrar(false);
  }, [registrar]);

  if (!notif) return null;

  const { noLeidas, hayNoLeidas, mostrarPanel, alternarPanel } = notif;

  return (
    <button
      type="button"
      className={`btn header-btn notif-header-btn${hayNoLeidas ? ' notif-header-btn-alerta' : ''}`}
      onClick={alternarPanel}
      aria-pressed={mostrarPanel}
      title={
        hayNoLeidas
          ? `${noLeidas.length} notificación(es) sin leer`
          : mostrarPanel ? 'Ocultar notificaciones' : 'Ver notificaciones'
      }
    >
      <span className="notif-header-btn-icon">🔔</span>
      Notificaciones
      {hayNoLeidas && <span className="notif-header-btn-count">{noLeidas.length}</span>}
    </button>
  );
}

export default NotificacionesBoton;

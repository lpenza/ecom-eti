import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import {
  obtenerNotificaciones,
  marcarNotificacionLeida as apiMarcarLeida,
  marcarTodasNotificacionesLeidas as apiMarcarTodas,
} from '../services/api';

// Cada cuánto se refresca la lista. El levante automático y los pickups diferidos
// son procesos del backend: el front se entera por polling.
const POLL_MS = 60 * 1000;
const STORAGE_OCULTO = 'velinne_notif_oculto';

const NotificacionesContext = createContext(null);

/**
 * Estado compartido de las notificaciones de procesos automáticos. Lo consumen
 * el botón del header (que abre/cierra y avisa cuántas hay sin leer) y el panel
 * lateral, así que vive acá arriba en vez de dentro de uno de los dos.
 *
 * `activo` corta el polling para los roles que no ven las notificaciones.
 */
export function NotificacionesProvider({ children, activo = true }) {
  const [notificaciones, setNotificaciones] = useState([]);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState('');
  const [marcando, setMarcando] = useState(false);
  // La preferencia de ocultarlo sobrevive al refresh; las no leídas la pisan.
  const [oculto, setOculto] = useState(() => localStorage.getItem(STORAGE_OCULTO) === '1');
  // El panel sólo muestra su propio botón flotante en las vistas donde no hay
  // header (el header sólo se renderiza en Pedidos).
  const [botonEnHeader, setBotonEnHeader] = useState(false);

  const noLeidas = notificaciones.filter((n) => !n.leida);
  const leidas = notificaciones.filter((n) => n.leida);
  const hayNoLeidas = noLeidas.length > 0;

  // Las no leídas pisan la preferencia: el panel se muestra aunque esté oculto y
  // vuelve a plegarse solo cuando quedan todas marcadas como leídas.
  const mostrarPanel = !oculto || hayNoLeidas;

  const cambiarOculto = useCallback((valor) => {
    setOculto(valor);
    localStorage.setItem(STORAGE_OCULTO, valor ? '1' : '0');
  }, []);

  const alternarPanel = useCallback(() => {
    cambiarOculto(!oculto);
  }, [cambiarOculto, oculto]);

  const cargar = useCallback(async () => {
    if (!activo) {
      setCargando(false);
      return;
    }
    try {
      const res = await obtenerNotificaciones(100);
      setNotificaciones(res?.notificaciones || []);
      setError('');
    } catch (err) {
      setError(err.message || 'No se pudieron cargar las notificaciones');
    } finally {
      setCargando(false);
    }
  }, [activo]);

  useEffect(() => {
    cargar();
    if (!activo) return undefined;
    const id = setInterval(cargar, POLL_MS);
    return () => clearInterval(id);
  }, [cargar, activo]);

  const marcarLeida = useCallback(async (id) => {
    // Optimista: el item se apaga al toque y el polling confirma.
    setNotificaciones((prev) =>
      prev.map((n) => (n.id === id ? { ...n, leida: true, leida_at: new Date().toISOString() } : n))
    );
    try {
      await apiMarcarLeida(id);
    } catch (err) {
      setError(err.message || 'No se pudo marcar como leída');
      cargar();
    }
  }, [cargar]);

  const marcarTodas = useCallback(async () => {
    setMarcando(true);
    try {
      await apiMarcarTodas();
      await cargar();
    } catch (err) {
      setError(err.message || 'No se pudieron marcar las notificaciones');
    } finally {
      setMarcando(false);
    }
  }, [cargar]);

  const valor = {
    notificaciones,
    noLeidas,
    leidas,
    hayNoLeidas,
    cargando,
    error,
    marcando,
    mostrarPanel,
    botonEnHeader,
    setBotonEnHeader,
    cambiarOculto,
    alternarPanel,
    marcarLeida,
    marcarTodas,
  };

  return (
    <NotificacionesContext.Provider value={valor}>
      {children}
    </NotificacionesContext.Provider>
  );
}

// Devuelve null fuera del provider: los componentes que lo usan simplemente no
// se renderizan en vez de romper la vista.
export function useNotificaciones() {
  return useContext(NotificacionesContext);
}

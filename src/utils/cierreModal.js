// Props para el fondo (overlay) de un modal: un click afuera no lo cierra de golpe,
// primero pregunta. Sólo cuenta como "click afuera" si el botón se apretó Y se soltó
// sobre el fondo: arrastrar desde un input hacia afuera (seleccionando texto) hace
// que el navegador dispare el click en el fondo y antes cerraba el modal.
//
// Uso: <div className="modal modal-open" {...cierreFuera(onClose, { bloqueado: cargando })}>
//  - bloqueado: hay una operación en curso; el click afuera se ignora.
//  - confirmar: false cuando no hay nada que perder (ej. pantalla de resultado).
//  - mensaje: texto del aviso.
export function cierreFuera(onClose, { bloqueado = false, confirmar = true, mensaje } = {}) {
  return {
    onMouseDown: (e) => {
      e.currentTarget.dataset.presionFuera = e.target === e.currentTarget ? '1' : '';
    },
    onClick: (e) => {
      const fuera = e.target === e.currentTarget && e.currentTarget.dataset.presionFuera === '1';
      e.currentTarget.dataset.presionFuera = '';
      if (!fuera || bloqueado) return;
      if (confirmar && !window.confirm(mensaje || '¿Cerrar esta ventana? Lo que no hayas guardado se pierde.')) return;
      onClose();
    },
  };
}

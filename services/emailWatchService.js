/**
 * Servicio de fondo que vigila la bandeja y genera notificaciones del panel
 * lateral cuando llega un correo nuevo (mismo mecanismo que el levante de UES).
 *
 * Detección: los UID de IMAP son crecientes por carpeta, así que guardamos el
 * UID más alto visto y notificamos los que lo superan. Al arrancar fijamos ese
 * baseline SIN notificar, para no avisar de correos viejos tras cada reinicio.
 */
const mailboxService = require('./mailboxService');

let lastMaxUid = null;

/**
 * @param {Function} notificar  helper que crea la notificación ({ tipo, nivel, titulo, mensaje, data }).
 */
async function revisarCorreosNuevos(notificar) {
  const mensajes = await mailboxService.listMessages({ tipo: 'inbox', limit: 25 });
  if (!Array.isArray(mensajes) || mensajes.length === 0) {
    if (lastMaxUid === null) lastMaxUid = 0;
    return { nuevos: 0 };
  }

  const maxUid = Math.max(...mensajes.map((m) => Number(m.uid) || 0));

  // Primera corrida tras el arranque: baseline, sin notificar histórico.
  if (lastMaxUid === null) {
    lastMaxUid = maxUid;
    return { nuevos: 0, baseline: maxUid };
  }

  const nuevos = mensajes
    .filter((m) => Number(m.uid) > lastMaxUid)
    .sort((a, b) => Number(a.uid) - Number(b.uid));

  if (nuevos.length === 0) return { nuevos: 0 };

  if (nuevos.length > 5) {
    // Muchos de golpe: un solo aviso resumen para no floodear el panel.
    await notificar({
      tipo: 'email',
      nivel: 'info',
      titulo: `${nuevos.length} correos nuevos`,
      mensaje: `Entraron ${nuevos.length} correos a la bandeja.`,
      data: { count: nuevos.length, alias: null },
    });
  } else {
    for (const m of nuevos) {
      const fromTxt = m.from ? (m.from.name || m.from.address || 'Desconocido') : 'Desconocido';
      const aliasLocal = m.alias ? String(m.alias).split('@')[0] : '';
      await notificar({
        tipo: 'email',
        nivel: 'info',
        titulo: aliasLocal ? `Nuevo correo en ${aliasLocal}` : 'Nuevo correo',
        mensaje: `${fromTxt}: ${m.subject}`,
        data: { uid: m.uid, alias: m.alias || null, from: m.from?.address || '', subject: m.subject },
      });
    }
  }

  lastMaxUid = maxUid;
  return { nuevos: nuevos.length };
}

module.exports = { revisarCorreosNuevos };

/**
 * Hub de Server-Sent Events (SSE) para empujar avisos al navegador al instante.
 * Lo usan las notificaciones de correo: cuando el backend detecta uno nuevo,
 * hace broadcast y los clientes conectados refrescan sin esperar el polling.
 */
const clients = new Set();

function addClient(res) {
  clients.add(res);
  res.on('close', () => clients.delete(res));
}

function broadcast(event, data = {}) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try { res.write(payload); } catch { /* cliente caído; se limpia en 'close' */ }
  }
}

function count() {
  return clients.size;
}

module.exports = { addClient, broadcast, count };

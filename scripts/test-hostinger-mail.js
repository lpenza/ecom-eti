/**
 * Diagnóstico de la integración de correo (Hostinger Mail REST API).
 *
 * Valida, sin levantar la app, que:
 *   1. El token conecta y /me responde (y dónde vive el mailboxResourceId).
 *   2. Se puede listar la bandeja.
 *   3. La búsqueda por alias (To/Cc) funciona.
 *   4. Se puede leer un mensaje completo (cuerpo).
 *
 * Uso (PowerShell):
 *   $env:HOSTINGER_MAIL_TOKEN="tu_token"; node scripts/test-hostinger-mail.js
 * o cargá las variables desde tu .env y corré: node scripts/test-hostinger-mail.js
 *
 * NO imprime el token.
 */
require('dotenv').config();
const mailboxService = require('../services/mailboxService');
const axios = require('axios');

const BASE = String(process.env.HOSTINGER_MAIL_BASE || 'https://api.mail.hostinger.com').replace(/\/+$/, '');
const VENTAS = String(process.env.MAIL_ALIAS_VENTAS || 'ventas@velinneuy.com');

function line() { console.log('─'.repeat(60)); }

async function main() {
  if (!process.env.HOSTINGER_MAIL_TOKEN) {
    console.error('✗ Falta HOSTINGER_MAIL_TOKEN. Definilo antes de correr el script.');
    process.exit(1);
  }

  const c = axios.create({
    baseURL: BASE,
    timeout: 20000,
    headers: {
      Authorization: `Bearer ${process.env.HOSTINGER_MAIL_TOKEN}`,
      Accept: 'application/json',
    },
  });

  // 1) /me — ver la estructura y confirmar el mailboxResourceId
  line();
  console.log('1) GET /api/v1/me');
  try {
    const { data } = await c.get('/api/v1/me');
    console.log(JSON.stringify(data, null, 2).slice(0, 1500));
    if (process.env.HOSTINGER_MAILBOX_ID) {
      console.log(`\n→ Usando HOSTINGER_MAILBOX_ID del entorno: ${process.env.HOSTINGER_MAILBOX_ID}`);
    } else {
      console.log('\n→ HOSTINGER_MAILBOX_ID no está seteado; se intentará resolver desde /me.');
      console.log('  Si algo falla, copiá el resourceId del buzón info@ de arriba y seteá HOSTINGER_MAILBOX_ID.');
    }
  } catch (e) {
    console.error('✗ /me falló:', e.response?.status, JSON.stringify(e.response?.data || e.message));
    process.exit(1);
  }

  // 2) Listar bandeja (toda) vía el servicio real
  line();
  console.log('2) listMessages({ alias: null }) — bandeja completa (lo que ve el admin)');
  try {
    const msgs = await mailboxService.listMessages({ alias: null, limit: 5 });
    console.log(`   ${msgs.length} mensaje(s). Últimos:`);
    msgs.forEach((m) => console.log(`   • uid=${m.uid} [${m.seen ? 'leído' : 'NO leído'}] ${m.from?.address} → "${m.subject}" (${m.date})`));
    global.__unUid = msgs[0]?.uid;
  } catch (e) {
    console.error('✗ listMessages falló:', e.message);
  }

  // 3) Búsqueda por alias ventas@ (lo que ve atención)
  line();
  console.log(`3) listMessages({ alias: "${VENTAS}" }) — filtrado (lo que ve atención)`);
  try {
    const msgs = await mailboxService.listMessages({ alias: VENTAS, limit: 5 });
    console.log(`   ${msgs.length} mensaje(s) dirigidos a ${VENTAS}.`);
    msgs.forEach((m) => console.log(`   • uid=${m.uid} ${m.from?.address} → "${m.subject}"`));
    if (!global.__unUid) global.__unUid = msgs[0]?.uid;
  } catch (e) {
    console.error('✗ búsqueda por alias falló:', e.message);
  }

  // 4) Leer un mensaje completo
  line();
  const uid = global.__unUid;
  if (uid) {
    console.log(`4) getMessage({ uid: ${uid} }) — cuerpo completo`);
    try {
      const msg = await mailboxService.getMessage({ uid, markSeen: false });
      console.log(`   Asunto: ${msg.subject}`);
      console.log(`   De: ${msg.from?.address}  Para: ${(msg.to || []).map((t) => t.address).join(', ')}`);
      console.log(`   HTML: ${msg.html ? `${msg.html.length} chars` : '(sin html)'}  Texto: ${msg.text ? `${msg.text.length} chars` : '(sin texto)'}`);
    } catch (e) {
      console.error('✗ getMessage falló:', e.message);
    }
  } else {
    console.log('4) (sin mensajes para leer — bandeja vacía)');
  }

  line();
  console.log('✓ Diagnóstico terminado. Si los 4 pasos dieron OK, la app puede leer correos.');
}

main().catch((e) => { console.error('Error inesperado:', e); process.exit(1); });

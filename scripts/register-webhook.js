/**
 * Registra (o lista/borra) el webhook de correo nuevo en Hostinger.
 *
 * El webhook hace que Hostinger avise a nuestro server APENAS entra un correo,
 * en vez de esperar el polling. La URL lleva una key secreta (EMAIL_WEBHOOK_KEY)
 * que el server valida.
 *
 * Requisitos (en el .env o el entorno):
 *   HOSTINGER_MAIL_TOKEN   token de la Mail API.
 *   EMAIL_WEBHOOK_KEY      key secreta compartida (la MISMA que tenga el server/Railway).
 *   HOSTINGER_MAILBOX_ID   opcional (si no, se resuelve por /me).
 *
 * Uso (desde la raíz del proyecto):
 *   node scripts/register-webhook.js https://tu-app.up.railway.app   # crear
 *   node scripts/register-webhook.js list                            # listar
 *   node scripts/register-webhook.js delete <webhookId>              # borrar
 */
require('dotenv').config();
const axios = require('axios');

const BASE = 'https://api.mail.hostinger.com';
const TOKEN = process.env.HOSTINGER_MAIL_TOKEN;

function api() {
  if (!TOKEN) { console.error('✗ Falta HOSTINGER_MAIL_TOKEN'); process.exit(1); }
  return axios.create({ baseURL: BASE, headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/json' } });
}

async function mailboxId(c) {
  if (process.env.HOSTINGER_MAILBOX_ID) return process.env.HOSTINGER_MAILBOX_ID;
  const { data } = await c.get('/api/v1/me');
  const mb = data?.data?.mailboxes?.[0]?.resourceId;
  if (!mb) { console.error('✗ No pude resolver el mailboxResourceId; definí HOSTINGER_MAILBOX_ID'); process.exit(1); }
  return mb;
}

async function main() {
  const [cmd, arg] = process.argv.slice(2);
  const c = api();
  const mb = await mailboxId(c);
  const bases = `/api/v1/mailboxes/${mb}/webhooks`;

  if (cmd === 'list') {
    const { data } = await c.get(bases);
    console.log(JSON.stringify(data?.data || data, null, 2));
    return;
  }

  if (cmd === 'delete') {
    if (!arg) { console.error('Uso: node scripts/register-webhook.js delete <webhookId>'); process.exit(1); }
    await c.delete(`${bases}/${arg}`);
    console.log('✓ Webhook borrado:', arg);
    return;
  }

  // crear
  const publicBase = cmd;
  if (!publicBase || !/^https?:\/\//.test(publicBase)) {
    console.error('Uso: node scripts/register-webhook.js https://tu-app.up.railway.app');
    process.exit(1);
  }
  const key = process.env.EMAIL_WEBHOOK_KEY;
  if (!key) {
    console.error('✗ Falta EMAIL_WEBHOOK_KEY. Generá una y ponela en el entorno del server (y Railway) ANTES de registrar,');
    console.error('  para que la URL del webhook coincida con lo que el server valida. Ej (PowerShell):');
    console.error('  $env:EMAIL_WEBHOOK_KEY = [guid]::NewGuid().ToString("N")');
    process.exit(1);
  }

  const url = `${publicBase.replace(/\/+$/, '')}/api/emails/webhook?key=${encodeURIComponent(key)}`;
  const { data } = await c.post(bases, {
    name: 'Velinne - correo nuevo',
    description: 'Notifica al panel de EMAILS apenas entra un correo',
    events: ['message.received'],
    status: 'active',
    url,
  });
  console.log('✓ Webhook creado:');
  console.log(JSON.stringify(data?.data || data, null, 2));
  console.log('\n(La URL registrada apunta a tu app con la key secreta. Guardá el "secret" si querés verificar firmas más adelante.)');
}

main().catch((e) => {
  console.error('ERR:', e.response?.status, JSON.stringify(e.response?.data || e.message));
  process.exit(1);
});

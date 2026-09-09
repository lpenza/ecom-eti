/**
 * Prueba de entregabilidad / DKIM.
 *
 * Envía un correo de prueba (por SMTP, igual que el panel) desde un alias hacia
 * info@velinneuy.com — que cae en tu propia bandeja — y luego lee el MIME crudo
 * vía la API para mostrarte las cabeceras de autenticación:
 *   - DKIM-Signature      → confirma que Hostinger firmó el correo.
 *   - Authentication-Results / ARC-Authentication-Results → dkim/spf/dmarc = pass.
 *
 * El DKIM lo aplica el servidor SMTP de Hostinger automáticamente; este script
 * solo verifica que sale bien.
 *
 * Uso (PowerShell, desde la raíz del proyecto, con SMTP_* y HOSTINGER_MAIL_TOKEN en .env):
 *   node scripts/test-dkim.js
 *   node scripts/test-dkim.js ventas@velinneuy.com          # elegir alias remitente
 *   $env:TEST_TO="tucorreo@gmail.com"; node scripts/test-dkim.js   # enviar afuera (verificás allá)
 */
require('dotenv').config();
const emailService = require('../services/emailService');
const mailboxService = require('../services/mailboxService');

const FROM = (process.argv[2] || process.env.MAIL_ALIAS_VENTAS || 'ventas@velinneuy.com').toLowerCase().trim();
const MADRE = (process.env.MAIL_MADRE || 'info@velinneuy.com').toLowerCase().trim();
const TO = (process.env.TEST_TO || MADRE).toLowerCase().trim();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function extraerCabeceras(mime, nombres) {
  // Toma las cabeceras pedidas respetando continuaciones (líneas que empiezan con espacio/tab).
  const lineas = String(mime).split(/\r?\n/);
  const out = [];
  let capturando = null;
  for (const linea of lineas) {
    if (linea === '') break; // fin de cabeceras
    if (/^\s/.test(linea) && capturando) { out[out.length - 1] += '\n  ' + linea.trim(); continue; }
    const m = linea.match(/^([\w-]+):/);
    if (m) {
      capturando = nombres.find((n) => n.toLowerCase() === m[1].toLowerCase()) ? m[1] : null;
      if (capturando) out.push(linea.trim());
    }
  }
  return out;
}

async function main() {
  if (!process.env.SMTP_PASS || /PONER_/.test(process.env.SMTP_PASS)) {
    console.error('✗ Falta completar SMTP_PASS (clave del buzón info@) en el .env.');
    process.exit(1);
  }

  const token = `dkim-test-${Date.now()}`;
  const subject = `Prueba de entregabilidad ${token}`;

  console.log(`Enviando desde ${FROM} → ${TO} …`);
  try {
    const res = await emailService.enviarCorreoRaw({
      from: FROM,
      to: TO,
      replyTo: FROM,
      subject,
      text: `Test de DKIM/SPF/DMARC. Token: ${token}`,
      html: `<p>Test de DKIM/SPF/DMARC.</p><p>Token: <b>${token}</b></p>`,
    });
    console.log('✓ Enviado. messageId:', res.messageId, '| aceptados:', res.accepted);
  } catch (e) {
    console.error('✗ Falló el envío por SMTP:', e.message);
    console.error('  (Si es error de remitente/identidad, hay que habilitar', FROM, 'como identidad de envío en Hostinger.)');
    process.exit(1);
  }

  const externo = !TO.endsWith('@' + MADRE.split('@')[1]);
  if (externo) {
    console.log(`\nEl destino ${TO} es externo: revisá allá el correo y abrí "Mostrar original" para ver dkim/spf/dmarc = pass.`);
    return;
  }

  console.log('\nBuscando el correo en la bandeja para leer sus cabeceras (puede tardar unos segundos)…');
  let uid = null;
  for (let intento = 1; intento <= 6 && !uid; intento += 1) {
    await sleep(4000);
    try {
      const msgs = await mailboxService.listMessages({ alias: null, limit: 15 });
      const encontrado = msgs.find((m) => String(m.subject).includes(token));
      if (encontrado) uid = encontrado.uid;
      else process.stdout.write(`  intento ${intento}/6…\n`);
    } catch (e) {
      console.error('  (error listando:', e.message, ')');
    }
  }

  if (!uid) {
    console.log('No apareció aún (puede demorar). Reintentá en un momento o revisá el panel EMAILS.');
    return;
  }

  const source = await mailboxService.getMessageSource({ uid });
  const cabeceras = extraerCabeceras(source, [
    'DKIM-Signature',
    'Authentication-Results',
    'ARC-Authentication-Results',
    'Received-SPF',
    'Return-Path',
    'From',
  ]);

  console.log('\n' + '─'.repeat(60));
  console.log('CABECERAS DE AUTENTICACIÓN (uid=' + uid + '):');
  console.log('─'.repeat(60));
  cabeceras.forEach((c) => console.log(c + '\n'));

  const authLine = cabeceras.find((c) => /^Authentication-Results:/i.test(c)) || '';
  const veredicto = (re, etiqueta) => console.log(`${re.test(authLine) ? '✓' : '✗'} ${etiqueta}`);
  console.log('─'.repeat(60));
  console.log('RESUMEN:');
  console.log(cabeceras.some((c) => /^DKIM-Signature:/i.test(c)) ? '✓ El correo está firmado con DKIM' : '✗ No se encontró DKIM-Signature');
  veredicto(/dkim=pass/i, 'dkim=pass');
  veredicto(/spf=pass/i, 'spf=pass');
  veredicto(/dmarc=pass/i, 'dmarc=pass');
  console.log('\nSi alguno no da pass acá, para el test definitivo enviá a mail-tester.com o a un Gmail.');
}

main().catch((e) => { console.error('Error inesperado:', e); process.exit(1); });

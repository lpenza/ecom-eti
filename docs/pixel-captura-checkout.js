// ════════════════════════════════════════════════════════════════════════════
//  PIXEL PERSONALIZADO DE SHOPIFY — Captura de contacto en el checkout
// ════════════════════════════════════════════════════════════════════════════
//
//  QUÉ HACE:
//  Captura el teléfono / email / nombre que el cliente escribe en el checkout
//  y los envía a tu backend, porque la Admin API de Shopify los censura
//  (Protected Customer Data). Después se cruzan con los carritos abandonados
//  por el `checkout_token`.
//
//  DÓNDE SE PEGA:
//  Shopify admin → Configuración → Eventos de clientes (Customer events)
//  → Agregar pixel personalizado → pegar este código → Guardar → Conectar.
//
//  ⚠️ IMPORTANTE:
//  1. Reemplazá BACKEND_URL por la URL PÚBLICA de tu app (Railway), NO localhost.
//     Este código corre en el navegador de tus clientes, no en tu PC.
//  2. El `secret` ya está puesto, tiene que coincidir con PIXEL_CAPTURE_SECRET del .env.
//
// ════════════════════════════════════════════════════════════════════════════

const BACKEND_URL = "https://TU-APP.up.railway.app";  // <-- CAMBIAR por tu dominio de Railway
const SECRET      = "fc6dbed7f5dcb71d2a41802c48c4a7fd2b2b18455cbf4bb3";

const ENDPOINT = BACKEND_URL + "/api/checkout-capturado?secret=" + SECRET;

function enviarContacto(checkout) {
  if (!checkout || !checkout.token) return;

  const ship = checkout.shippingAddress || {};
  const bill = checkout.billingAddress  || {};

  const payload = {
    checkout_token: checkout.token,
    email:          checkout.email      || null,
    phone:          checkout.phone || ship.phone || bill.phone || null,
    first_name:     ship.firstName || bill.firstName || null,
    last_name:      ship.lastName  || bill.lastName  || null,
  };

  // Solo enviamos si hay al menos teléfono o email
  if (!payload.phone && !payload.email) return;

  fetch(ENDPOINT, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify(payload),
  }).catch(function () { /* silencioso: no romper el checkout */ });
}

// Se dispara en cada paso del checkout donde puede haber datos de contacto.
// Mandamos en varios eventos para captar el dato apenas el cliente lo escribe.
analytics.subscribe("checkout_contact_info_submitted", function (event) {
  enviarContacto(event.data.checkout);
});

analytics.subscribe("checkout_address_info_submitted", function (event) {
  enviarContacto(event.data.checkout);
});

analytics.subscribe("payment_info_submitted", function (event) {
  enviarContacto(event.data.checkout);
});

analytics.subscribe("checkout_started", function (event) {
  enviarContacto(event.data.checkout);
});

# 🚚 VELINNE - Sistema de Gestión de Envíos

Sistema de gestión de etiquetas de envío para Uruguay, integrado con Shopify, Supabase y UES (Uruguay Express Service).

## 🏗️ Arquitectura

**Frontend:** React + Vite  
**Backend:** Node.js + Express  
**Base de Datos:** Supabase (PostgreSQL)  
**APIs:** UES (etiquetas), Shopify (pedidos)

## 🚀 Cómo Ejecutar

### 1. Instalar dependencias
```bash
npm install
```

### 2. Configurar `.env`
```env
SUPABASE_URL=tu_url
SUPABASE_KEY=tu_key
UES_API_URL=https://api.ues.com.uy
UES_API_KEY=tu_key
UES_TEST_MODE=true
SHOPIFY_STORE=tu_tienda
SHOPIFY_ACCESS_TOKEN=tu_token
PORT=3000

# Tracking link para mensajes
UES_TRACKING_URL_TEMPLATE=https://tu-tracking.ues.com.uy/seguimiento/{tracking}

# Email — ENVÍO por SMTP (nodemailer). Panel EMAILS y notificaciones.
# En Hostinger: smtp.hostinger.com:465 (secure). El usuario/clave es el del buzón
# madre info@velinneuy.com; se puede enviar con From = alias (ventas@).
SMTP_HOST=smtp.hostinger.com
SMTP_PORT=465
SMTP_USER=info@velinneuy.com
SMTP_PASS=tu_password
SMTP_FROM=info@velinneuy.com
SMTP_SECURE=true

# Email — LECTURA por Hostinger Mail REST API (panel EMAILS).
# Token Bearer creado en el panel de Hostinger (Emails → API / Agentic Mail).
# HOSTINGER_MAILBOX_ID es opcional: si se omite se resuelve solo desde /me.
HOSTINGER_MAIL_TOKEN=tu_token_de_hostinger
HOSTINGER_MAILBOX_ID=
# HOSTINGER_MAIL_BASE=https://api.mail.hostinger.com
# HOSTINGER_MAIL_FOLDER=INBOX
# HOSTINGER_SENT_FOLDER=INBOX.Sent

# IMAP para guardar copia en "Enviados" al enviar (el SMTP no lo hace solo).
# Si se omiten USER/PASS se reutilizan los de SMTP (mismo buzón info@).
# IMAP_HOST=imap.hostinger.com
# IMAP_PORT=993
# IMAP_SECURE=true
# IMAP_USER=info@velinneuy.com
# IMAP_PASS=tu_password

# Alias del buzón madre. MAIL_ALIASES = lista que ve el admin (separados por coma).
# MAIL_ALIASES_ATENCION = alias que ve/usa el rol "atención al cliente".
MAIL_MADRE=info@velinneuy.com
MAIL_ALIASES=info@velinneuy.com,ventas@velinneuy.com,consultas@velinneuy.com,facturacion@velinneuy.com,mercadopago@velinneuy.com
MAIL_ALIASES_ATENCION=consultas@velinneuy.com

# Los crons (levante, pickups, stock, correos nuevos…) hacen cambios compartidos
# vía la base. Deben correr en UNA sola instancia; si corren en local Y en Railway
# a la vez, se DUPLICAN. Poné CRONS_ENABLED=false donde NO deban dispararse (local).
# CRONS_ENABLED=true

# Servicio de fondo que notifica correos nuevos en el panel lateral.
# EMAIL_WATCH_ENABLED=false para desactivarlo. EMAIL_WATCH_CRON: frecuencia
# (6 campos = con segundos; default cada 15s). Con webhook, el cron es respaldo.
# EMAIL_WATCH_ENABLED=true
# EMAIL_WATCH_CRON=*/15 * * * * *

# Webhook de Hostinger para aviso INSTANTÁNEO de correo nuevo (solo prod, URL pública).
# EMAIL_WEBHOOK_KEY: key secreta compartida; va en la URL del webhook y el server la valida.
# Registrar una vez: node scripts/register-webhook.js https://tu-app.up.railway.app
# EMAIL_WEBHOOK_KEY=una_key_larga_al_azar

# MercadoLibre. Credenciales de la app creada en developers.mercadolibre.com.uy.
# ML_REDIRECT_URI tiene que ser EXACTAMENTE la misma URL cargada en la app
# (https, sin barra final) y apuntar al callback del server.
# Los tokens NO van acá: se guardan en la tabla ml_config (el refresh_token es
# de un solo uso y rota en cada refresco). Correr sql/create_mercadolibre.sql.
ML_CLIENT_ID=
ML_CLIENT_SECRET=
ML_REDIRECT_URI=https://tu-app.up.railway.app/api/mercadolibre/callback
# Cron de sincronización (default cada 10 min). ML_SYNC_ENABLED=false lo apaga.
# ML_SYNC_CRON=*/10 * * * *
# ML_SYNC_HORAS=72

# WhatsApp (elige proveedor: twilio o meta)
WHATSAPP_PROVIDER=twilio

# Twilio WhatsApp
TWILIO_ACCOUNT_SID=ACxxxx
TWILIO_AUTH_TOKEN=xxxx
TWILIO_WHATSAPP_FROM=whatsapp:+14155238886

# Meta WhatsApp Cloud API (si WHATSAPP_PROVIDER=meta)
WHATSAPP_META_TOKEN=xxxx
WHATSAPP_META_PHONE_NUMBER_ID=xxxx

# Meta Ads (panel "Meta Ads": campañas, conjuntos y anuncios)
# Token de usuario de sistema con permisos ads_read + ads_management y la
# cuenta publicitaria asignada. Si falta, se intenta con WHATSAPP_ACCESS_TOKEN.
META_ADS_ACCESS_TOKEN=xxxx
META_AD_ACCOUNT_ID=act_xxxx   # obligatorio con token de usuario de sistema (no lista sus cuentas)
# Piloto con aprobación (sql/create_meta_ads_piloto.sql): horario de los chequeos
# que generan propuestas. Sin esta variable sólo se corren a mano desde el panel.
META_ADS_PILOTO_CRON="10 8 * * *"
```

### 3. Iniciar Backend (Terminal 1)
```bash
npm start
```
Backend en: http://localhost:3000

### 4. Iniciar Frontend React (Terminal 2)
```bash
npm run client
```
Frontend en: http://localhost:5173

### 5. Abrir navegador
```
http://localhost:5173
```

## ✨ Funcionalidades

- ✅ **Vista Previa de Datos** antes de generar etiquetas
- ✅ **Generación Individual y Masiva** de etiquetas
- ✅ **Modo de Prueba** (genera PDFs sin llamar API real)
- ✅ **Sincronización con Shopify** automática
- ✅ **Pedidos de MercadoLibre** en el mismo panel (ver sección abajo)
- ✅ **Fulfillment Shopify** con envío de tracking a clientes (email/WhatsApp)
- ✅ **Vista Previa de PDF** de etiquetas generadas
- ✅ **Dashboard en Tiempo Real** con estadísticas
- ✅ **Interfaz Moderna** con React

## 📁 Estructura del Proyecto

```
velinne-js/
├── src/                    # Frontend React
│   ├── App.jsx             # Componente principal
│   ├── components/         # Componentes UI
│   ├── hooks/              # Custom hooks (usePedidos)
│   └── services/           # API client
├── services/               # Backend services
│   ├── supabaseService.js
│   ├── uesService.js
│   ├── shopifyService.js
│   └── logService.js
├── server.js               # Servidor Express API
├── vite.config.js          # Configuración Vite
├── index.html              # HTML principal (raíz)
└── package.json            # Dependencias
```

## 🔧 Scripts Disponibles

```bash
npm start          # Iniciar servidor backend
npm run dev        # Backend con nodemon
npm run client     # Frontend React (desarrollo)
npm run build      # Build React para producción
```

## 🐛 Debugging

### React DevTools
F12 → Components → Inspecciona estado de hooks

### Console Logs
- 📥 Carga de datos
- ✅ Operaciones exitosas
- ❌ Errores
- 🔍 Vista previa

### Network Inspector
F12 → Network → Filtra "Fetch/XHR"

## 🛒 MercadoLibre

Las ventas de ML se espejan en la **misma tabla `pedidos`** que las de Shopify
(columna `origen`), así aparecen en el panel, en la cola del armador y en
cadetería sin pantallas nuevas. El número visible es `ML-<id>` y un carrito
(varias ventas en un paquete) entra como **un solo pedido**, agrupado por `pack_id`.

**Envíos.** Si la venta va con Mercado Envíos (`logistic_type` = drop_off,
xd_drop_off, cross_docking, self_service o fulfillment), la etiqueta la emite ML:
el sistema la baja a `public/etiquetas-mercadolibre/<shipment_id>.pdf`, la
engancha al pedido en `link_etiqueta_drive` y queda lista para imprimir con los
mismos botones que UES y Marco Postal (individual y combinada por lote). Si es
"envío a acordar" (`custom`), el pedido entra al flujo normal y se le genera
etiqueta UES o Marco Postal como a cualquier otro.

### Puesta en marcha

1. Correr `sql/create_mercadolibre.sql` en Supabase.
2. Crear la app en https://developers.mercadolibre.com.uy → *Mis aplicaciones* →
   *Crear aplicación*.
   - **Redirect URI:** `https://tu-app.up.railway.app/api/mercadolibre/callback`
     (https obligatorio, sin barra final, idéntica a `ML_REDIRECT_URI`).
   - **Scopes:** `read`, `offline_access` (habilita el refresh token; sin él hay
     que reautorizar cada 6 horas) y el dominio de **publicaciones**
     (`urn:ml:mktp:publish-sync`), que es el que permite leer y escribir
     `available_quantity`. Sin ese último, todo `/items/...` responde 403
     PolicyAgent aunque la app tenga `read` y `write` genéricos.
   - Al agregar un scope hay que **volver a autorizar**: un token ya emitido NO
     gana permisos nuevos, y el síntoma es un 403 que parece un cambio que no
     se guardó.
   - **Notificaciones (webhook):** `https://tu-app.up.railway.app/api/mercadolibre/webhook`
     con los topics `orders_v2` y `shipments`.
3. Cargar `ML_CLIENT_ID`, `ML_CLIENT_SECRET` y `ML_REDIRECT_URI` en Railway.
4. En el panel (como admin) apretar **🔌 Conectar MercadoLibre**, autorizar con la
   cuenta vendedora y volver. El botón pasa a **🛒 Sincronizar ML**.

Después de eso el cron trae las ventas solo cada 10 minutos y el webhook las trae
al instante; el botón queda para forzar una pasada.

### Sincronización de stock

**Shopify es el master.** El stock real vive en Shopify, `productos` lo espeja y ML
recibe siempre valores **absolutos** — nunca diferencias, porque ML ya descuenta su
propio stock al vender y mandarle un delta descontaría dos veces.

| Cuándo | Qué pasa |
|---|---|
| Venta en **ML** | Se descuenta en Shopify (y en `productos`) por SKU NC, y se empuja el nuevo valor a las publicaciones de ese SKU |
| Venta en **Shopify** | Shopify descuenta solo; la reconciliación trae el valor a `productos` y lo empuja a ML |

Ritmo:

| Camino | Cuándo | Demora |
|---|---|---|
| Venta ML → Shopify | El webhook descuenta al entrar la venta | segundos |
| Venta ML (respaldo) | Cron `ML_STOCK_CRON`, cada 3 min | ≤ 3 min |
| Venta Shopify → ML | Cron `ML_STOCK_SHOPIFY_CRON`, cada 3 min | ≤ 3 min |
| Barrido completo | Cron `ML_STOCK_RECON_CRON`, a los :20 de cada hora | red de seguridad |

Los caminos rápidos usan un **índice SKU → publicaciones cacheado en memoria** (1 h
de vida, o se refresca cuando aparece un SKU desconocido). Sin él, empujar un solo
SKU obligaba a releer las ~166 publicaciones. Con el índice, un push cuesta una
llamada por publicación, y cero si ML ya tiene el valor correcto — que pasa seguido,
porque ML descuenta sola la publicación donde se vendió.

Un solo ciclo de stock corre a la vez (guard en memoria): el webhook y el cron
pueden dispararse casi juntos, y dos corridas en paralelo leerían el mismo stock
antes de que la otra escriba.

Los descuentos automáticos quedan firmados en `stock_ajustes_nc` con
`usuario_nombre = "venta ML"` y `origen = "venta_ml"`, para distinguirlos de un
conteo físico hecho por una persona en el panel del armador.

**Idempotencia.** `pedidos.ml_stock_descontado_at` marca la venta ya procesada y
`pedidos.ml_stock_descontado` guarda el detalle ítem por ítem. Sin esto, el cron
—que reprocesa una ventana de 72 h cada 10 minutos— descontaría el mismo pedido en
cada corrida. El detalle por ítem permite además reintentar un pedido que falló a
la mitad sin volver a descontar lo que ya salió. Correr `sql/add_ml_stock_sync.sql`.

Un SKU con varias publicaciones recibe el stock **completo en cada una** (no se
reparte), así que el catálogo ofrece más unidades de las que hay. Es una decisión
tomada, no un bug.

### Endpoints

| Método | Ruta | Qué hace |
|---|---|---|
| GET | `/api/mercadolibre/estado` | Si está configurado / conectado, y con qué cuenta |
| GET | `/api/mercadolibre/stock/comparar` | Compara ML vs nuestro stock (solo lectura) |
| POST | `/api/mercadolibre/stock/ajustar` | Empuja el stock a ML (`?simular=1` para no escribir) |
| POST | `/api/mercadolibre/stock/sincronizar` | Corre el ciclo de stock a mano |
| GET | `/api/mercadolibre/auth-url` | Link de autorización OAuth (admin) |
| GET | `/api/mercadolibre/callback` | Callback del OAuth (es el Redirect URI) |
| POST | `/api/mercadolibre/sincronizar` | Trae ventas y etiquetas ahora |
| GET | `/api/mercadolibre/etiqueta/:pedidoId` | Baja/refresca la etiqueta (`?forzar=1`) |
| POST | `/api/mercadolibre/webhook` | Notificaciones de ML (`orders_v2`, `shipments`) |

## 🧾 e-Ticket (Zensei)

Emisión **manual** de e-Tickets para pedidos de **Shopify**: el admin aprieta
**🧾 Emitir** en la columna *Comprobante* de la tabla, revisa el preview y confirma.
Las ventas de MercadoLibre no pasan por acá (las factura la integración de ML que
trae Zensei).

**Reglas**

- Siempre **e-Ticket (101)** a consumidor final, sin receptor.
- Los precios de Shopify incluyen IVA; la API de Zensei pide el unitario **sin**
  IVA y calcula el 22% sobre el total gravado. `services/comprobanteBuilder.js`
  pasa cada línea a neto (4 decimales) y garantiza que el total cierre al
  centésimo con lo cobrado. Cuando un total no se puede expresar como neto + IVA
  redondeados (ej. $2.760 → 2.759,99 ó 2.760,01) agrega una línea **Redondeo** de
  $0,01 no facturable (`NON_BILLABLE`).
- Descuentos (escalera de tonos, códigos, automáticos) salen de los
  `discount_allocations` de cada línea; el envío va como una línea más con IVA.
- No se emite si el pedido no está pagado, está cancelado, reembolsado del todo,
  editado después de la compra o no cierra el total. Los reembolsos parciales se
  facturan por lo cobrado originalmente (los reembolsos van por fuera).
- **Fecha de emisión:** hoy, o la fecha en que entró el pedido (hora de Uruguay)
  si tiene como máximo **2 días** — tope confirmado con el contador / Zensei
  (`MAX_DIAS_ATRAS` en `comprobanteBuilder.js`). El server valida la ventana.
- `Idempotency-Key: shopify-<order_id>`: un reintento (timeout, doble click)
  nunca emite dos comprobantes.
- Al emitir se guarda serie/número/estado en `pedidos.cfe_*` y se agrega el tag
  `ETICKET-<serie><número>` a la orden de Shopify.

**Puesta en marcha**

1. Correr `sql/add_cfe_to_pedidos.sql` en Supabase.
2. Crear la API key en Zensei → Configuración → API Keys (permisos `cfe:issue` y
   `cfe:read`) y cargar `ZENSEI_API_KEY`, `ZENSEI_TENANT_ID`, `ZENSEI_COMPANY_ID`
   y `ZENSEI_BRANCH_ID` en `.env` y en Railway.
3. Probar primero con un pedido real chico: `app.zensei.uy` es producción.

| Método | Ruta | Qué hace |
|---|---|---|
| GET | `/api/pedidos/:id/comprobante/preview` | Arma el e-Ticket desde Shopify sin emitir |
| POST | `/api/pedidos/:id/comprobante` | Emite el e-Ticket en Zensei |
| POST | `/api/pedidos/:id/comprobante/actualizar` | Reconsulta el estado en Zensei |
| GET | `/api/pedidos/:id/comprobante/pdf` | PDF del comprobante |
| POST | `/api/comprobantes/lote/preview` | Revisa una tanda (`{ pedidoIds }`) sin emitir — progreso NDJSON |
| POST | `/api/comprobantes/lote` | Emite la tanda (`{ pedidoIds, fecha: 'auto'\|'hoy' }`) de a uno — progreso NDJSON |

**Emisión masiva.** Barra *🧾 Emitir e-Tickets (N)* arriba de la tabla: toma
**sólo los pedidos seleccionados** con el checkbox (sin selección queda
deshabilitada; máx. 100 por tanda). Los seleccionados que ya tienen comprobante
o son de ML se dejan afuera. Primero revisa todo y muestra qué está listo y qué no; al
confirmar emite de a uno (≥ 1,1 s entre emisiones por el límite de 60/min de
Zensei; ante un 429 espera un minuto y reintenta) y corta la tanda si el error es
de cuenta (key, permisos, suscripción). Con fecha `auto` cada pedido sale con su
fecha si tiene hasta 2 días y con la de hoy si no.

**Un pedido, un comprobante.** Con `cfe_id` cargado la fila muestra el número en
vez de *Emitir*, el modal no ofrece emitir y el server responde 409. Si el
comprobante se emitió pero falló el guardado en la base, reintentar devuelve el
mismo CFE (misma `Idempotency-Key`).

## 📚 Documentación

Lee [README-REACT.md](README-REACT.md) para arquitectura detallada.

---

**Desarrollado con ❤️ para VELINNE**

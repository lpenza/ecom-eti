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
MAIL_ALIASES=info@velinneuy.com,ventas@velinneuy.com,consultas@velinneuy.com,facturacion@velinneuy.com
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

# WhatsApp (elige proveedor: twilio o meta)
WHATSAPP_PROVIDER=twilio

# Twilio WhatsApp
TWILIO_ACCOUNT_SID=ACxxxx
TWILIO_AUTH_TOKEN=xxxx
TWILIO_WHATSAPP_FROM=whatsapp:+14155238886

# Meta WhatsApp Cloud API (si WHATSAPP_PROVIDER=meta)
WHATSAPP_META_TOKEN=xxxx
WHATSAPP_META_PHONE_NUMBER_ID=xxxx
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

## 📚 Documentación

Lee [README-REACT.md](README-REACT.md) para arquitectura detallada.

---

**Desarrollado con ❤️ para VELINNE**

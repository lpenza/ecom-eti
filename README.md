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

# Email (SMTP)
SMTP_HOST=smtp.tu-proveedor.com
SMTP_PORT=587
SMTP_USER=tu_usuario
SMTP_PASS=tu_password
SMTP_FROM=envios@tu-dominio.com
SMTP_SECURE=false

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

# VELINNE - Aplicación React

## 🎉 Migración Completada

La aplicación ha sido migrada exitosamente a **React** con una arquitectura moderna y comprensible.

## 🚀 Cómo Ejecutar

### 1. Backend (API)
```bash
npm start
```
Corre en: `http://localhost:3000`

### 2. Frontend (React)
```bash
npm run client
```
Corre en: `http://127.0.0.1:5173`

**Abre tu navegador en: http://127.0.0.1:5173**

## 📁 Arquitectura React

### Estructura de Carpetas

```
src/
├── main.jsx                 # Punto de entrada React
├── App.jsx                  # Componente principal
├── styles.css              # Estilos globales
├── components/             # Componentes UI
│   ├── Header.jsx          # Header con estadísticas
│   ├── Toolbar.jsx         # Botones de acciones
│   ├── PedidosTable.jsx    # Tabla de pedidos
│   ├── Toast.jsx           # Notificaciones
│   └── modals/             # Modales
│       ├── DatosPreviewModal.jsx   # Preview de datos antes de generar
│       ├── PDFPreviewModal.jsx     # Preview del PDF generado
│       └── LoadingModal.jsx        # Spinner de carga
├── hooks/                  # Custom Hooks
│   └── usePedidos.js       # Hook para manejar lógica de pedidos
└── services/               # Servicios
    └── api.js              # Llamadas HTTP al backend
```

## 🧩 Componentes Principales

### **App.jsx**
- Componente raíz de la aplicación
- Maneja el estado global con el hook `usePedidos`
- Coordina la comunicación entre componentes
- Maneja los modales y notificaciones

### **usePedidos.js** (Custom Hook)
Hook personalizado que encapsula **TODA** la lógica de negocio:
- `cargarPedidos()` - Obtiene pedidos del backend
- `sincronizarShopify()` - Sincroniza con Shopify
- `generarEtiqueta(id)` - Genera etiqueta individual
- `generarEtiquetasMasivo()` - Genera múltiples etiquetas
- `toggleSelectPedido(id)` - Selección individual
- `toggleSelectAll()` - Seleccionar todos

**Estado manejado:**
- `pedidos` - Array de pedidos
- `loading` - Estado de carga
- `selectedPedidos` - IDs seleccionados
- `stats` - Estadísticas calculadas

### **services/api.js**
Servicio centralizado para llamadas HTTP:
- `obtenerPedidos()` - GET /api/pedidos
- `sincronizarShopify()` - POST /api/sync-shopify
- `generarEtiqueta(id)` - POST /api/generar-etiqueta/:id

## 🔄 Flujo de Datos

```
Usuario interactúa
    ↓
PedidosTable onClick
    ↓
App.jsx handler
    ↓
usePedidos hook
    ↓
api.js (fetch)
    ↓
Backend Express API (puerto 3000)
    ↓
Respuesta
    ↓
Hook actualiza estado
    ↓
React re-renderiza componentes
```

## 🎯 Ventajas de esta Arquitectura

### ✅ **Claridad**
Cada componente tiene una responsabilidad única y clara.

### ✅ **Debuggable**
- Logs en cada paso (`console.log`)
- React DevTools para inspeccionar estado
- Componentes pequeños y testeables

### ✅ **Mantenible**
- Lógica separada en hooks
- Componentes reutilizables
- Servicios centralizados

### ✅ **Escalable**
- Fácil agregar nuevos componentes
- State management simple pero efectivo
- Listo para Redux/Context si crece

## 🛠 Debugging

### Ver estado en tiempo real:
1. Abre React DevTools (F12 → Components)
2. Selecciona componente `App`
3. Inspecciona hooks: `pedidos`, `loading`, `selectedPedidos`

### Ver llamadas API:
1. Abre Network tab (F12 → Network)
2. Filtra por "Fetch/XHR"
3. Verás todas las llamadas a `/api/*`

### Ver logs:
```javascript
// En usePedidos.js
console.log('📥 Cargando pedidos...');
console.log('✅ Etiqueta generada:', result);
console.log('❌ Error:', error);
```

## 📝 Diferencias con Vanilla JS

| Aspecto | Vanilla JS | React |
|---------|-----------|-------|
| **Estado** | Variables globales | Hooks (useState) |
| **UI Updates** | DOM manipulation manual | Re-render automático |
| **Componentes** | Función con innerHTML | JSX declarativo |
| **Eventos** | onclick en HTML | onClick en JSX |
| **Debugging** | console.log everywhere | React DevTools |

## 🎨 Estilos

Los estilos CSS son los **mismos** que tenías, solo copiados a `src/styles.css`.

## 🔧 Próximos Pasos (Opcionales)

1. **PropTypes** - Validación de props
2. **Context API** - Para evitar prop drilling
3. **React Query** - Cache y gestión de estado del servidor
4. **Tests** - Jest + React Testing Library
5. **TypeScript** - Type safety

## 📞 ¿Cómo leer este código?

1. Empieza por `main.jsx` - punto de entrada
2. Lee `App.jsx` - ve cómo se conecta todo
3. Explora `usePedidos.js` - lógica de negocio
4. Mira componentes en `components/` - UI pura
5. Revisa `api.js` - comunicación con backend

Cada archivo es **corto y enfocado**, no más de 200 líneas.

---

**¡Ahora puedes ver exactamente qué está pasando en cada paso!** 🎉

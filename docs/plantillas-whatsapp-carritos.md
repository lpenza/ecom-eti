# Plantillas de WhatsApp — Carritos Abandonados

Las plantillas del flujo de recuperación se crean y aprueban en **Meta** (WhatsApp
Manager / Kommo → WhatsApp → Plantillas). El código solo guarda el **nombre técnico**
de cada plantilla en `WA_FLOW` (o en el flujo por defecto) y le pasa los parámetros.

## ⚠️ Estructura obligatoria (no cambiar)

El envío lo arma `buildComponents()` en
[`services/kommoWhatsAppService.js`](../services/kommoWhatsAppService.js). Cada plantilla
del flujo **tiene que** tener exactamente:

- **BODY** con **una sola variable** `{{1}}` = nombre del cliente.
- **BOTÓN** de tipo *URL dinámica*:
  - Tipo: **Visitar sitio web** → **Dinámico**
  - URL base en Meta: `https://velinneuy.com/{{1}}`
  - Texto del botón: `FINALIZAR MI PEDIDO`

> El código manda **1 parámetro de body** (el nombre) y **1 parámetro de botón**
> (el path del carrito). Si la plantilla tiene más variables en el body, Meta rechaza
> el envío por cantidad de parámetros. **Mantené siempre un único `{{1}}` en el body.**

Datos comunes a las 3:

| Campo      | Valor                                  |
|------------|----------------------------------------|
| Categoría  | `MARKETING`                            |
| Idioma     | Español (`es`) — debe coincidir con `WA_TEMPLATE_LANG` |
| Variables  | Body: `{{1}}` = nombre · Botón URL: dinámico |

---

## Plantilla 3 — `carrito_abandonado_3`

Tercer (y último) mensaje del flujo. Tono de última oportunidad / urgencia.

- **Nombre técnico:** `carrito_abandonado_3`
- **Categoría:** MARKETING
- **Idioma:** Español (es)

### Body (elegí UNA opción — todas usan un solo `{{1}}`)

**Opción A — urgencia simple**
```
¡{{1}}, tu carrito está por vencer! 🛒 Los productos que elegiste todavía te
esperan, pero no podemos reservarlos por mucho más. Terminá tu compra ahora antes
de que se agoten. 💕
```

**Opción B — última oportunidad**
```
{{1}}, esta es tu última oportunidad para llevarte lo que dejaste en el carrito. ✨
Tenemos pocas unidades disponibles y no queremos que te quedes sin lo tuyo.
¡Completá tu pedido en un toque! 👇
```

**Opción C — con guiño de envío**
```
¡Hola {{1}}! 👋 Vimos que dejaste productos en tu carrito. Si finalizás hoy tu
compra, la preparamos y despachamos enseguida. No dejes pasar lo que te gustó. 🛍️
```

### Botón (igual que en las plantillas 1 y 2)

- Tipo: **Llamado a la acción → Visitar sitio web → Dinámico**
- URL: `https://velinneuy.com/{{1}}`
- Texto del botón: `FINALIZAR MI PEDIDO`

### Ejemplo para la aprobación de Meta

Cuando Meta pide valores de ejemplo:

- Body `{{1}}` → `María`
- Botón URL `{{1}}` → `checkouts/cn/abc123/recover?key=xyz&locale=es-UY`

---

## Activar la 3ª plantilla en el flujo

Una vez que Meta la **apruebe**, agregala a `WA_FLOW` (ver bloque comentado en `.env`):

```bash
WA_FLOW='[{"template":"carrito_abandonado_1","demoraHoras":1},{"template":"carrito_abandonado_2","demoraHoras":12},{"template":"carrito_abandonado_3","demoraHoras":24}]'
```

- **Local:** en `.env` + reiniciar (`npm run dev` / `npm start`).
- **Producción:** en el panel de Variables del hosting + redeploy.

El recuadro "⚙️ Flujo de recuperación" de la pantalla *Carritos Abandonados* mostrará
los 3 pasos automáticamente.

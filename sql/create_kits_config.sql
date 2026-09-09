-- Configuración de "kits especiales" para el desglose de armado.
--
-- Objetivo: que el armador vea el contenido real de un kit al preparar el pedido.
-- En Shopify un kit llega como varios line items sueltos (el kit con su color base +
-- líneas de colores elegidos + productos adicionales). Estas tablas permiten:
--   1) Registrar cada kit y reconocerlo por el NOMBRE del producto de Shopify.
--   2) Definir qué "productos ayudantes" (carriers) aportan colores/adicionales al kit.
--   3) Listar el contenido FÍSICO fijo del kit que NO viaja como line item
--      (lámpara, base coat, manual, etc.), para que el armador igual lo empaque.
--
-- NO toca stock, precios ni movimientos_stock: es solo para el checklist de armado.

-- ── Kits ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS kits_config (
  id                BIGSERIAL PRIMARY KEY,
  nombre            TEXT NOT NULL,                 -- nombre para mostrar (ej. "Kit Studio")
  patron_shopify    TEXT NOT NULL,                 -- substring a buscar en el título Shopify (ej. "Kit Studio")
  colores_esperados INTEGER NOT NULL DEFAULT 0,    -- cuántos colores elegidos debería traer (0 = sin control)
  activo            BOOLEAN NOT NULL DEFAULT TRUE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_kits_config_activo ON kits_config(activo);

-- ── Carriers de color / adicionales ───────────────────────────────────────────
-- Productos "ayudantes" cuyo line item aporta un color elegido o un adicional al kit
-- del pedido (ej. "Set de colores", "Agregá tus tonos favoritos", "Lápiz Removedor").
CREATE TABLE IF NOT EXISTS carriers_color (
  id             BIGSERIAL PRIMARY KEY,
  patron_shopify TEXT NOT NULL,                    -- substring a buscar en el título Shopify
  tipo           TEXT NOT NULL DEFAULT 'color'
                 CHECK (tipo IN ('color', 'adicional')),
  activo         BOOLEAN NOT NULL DEFAULT TRUE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_carriers_color_activo ON carriers_color(activo);

-- ── Contenido físico fijo del kit ─────────────────────────────────────────────
-- Piezas que el kit incluye siempre y que NO aparecen como line item en la orden.
CREATE TABLE IF NOT EXISTS kit_contenido_fijo (
  id          BIGSERIAL PRIMARY KEY,
  kit_id      BIGINT NOT NULL REFERENCES kits_config(id) ON DELETE CASCADE,
  descripcion TEXT NOT NULL,                       -- ej. "Lámpara UV", "Base coat"
  cantidad    INTEGER NOT NULL DEFAULT 1,
  orden       INTEGER NOT NULL DEFAULT 0,          -- orden de aparición en el checklist
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_kit_contenido_fijo_kit ON kit_contenido_fijo(kit_id);

COMMENT ON TABLE kits_config       IS 'Kits especiales reconocidos por el nombre del producto de Shopify, para el desglose de armado';
COMMENT ON TABLE carriers_color    IS 'Productos ayudantes cuyo line item aporta un color elegido o adicional al kit del pedido';
COMMENT ON TABLE kit_contenido_fijo IS 'Piezas físicas que el kit incluye pero que no viajan como line item en la orden de Shopify';

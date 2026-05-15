-- Cache de tendencias de compra por color.
-- Granularidad: 1 fila por (fecha, producto_color, contexto).
-- Se reconstruye via supabaseService.rebuildColorTrendsCache() (cron diario + refresh manual).
--
-- Fuente de los datos:
--   movimientos_stock (tipo='venta')
--     JOIN productos      ON producto_id  (filtrado por categoria ILIKE 'color')
--     JOIN pedidos        ON referencia_id = pedidos.id
--     LEFT JOIN pedido_items pi sobre el mismo pedido para detectar es_kit
--
-- Contexto:
--   'individual' = el pedido no contiene ningun producto con es_kit=true
--   'kit'        = el pedido contiene >=1 producto es_kit=true y suma 1 color distinto
--   'set'        = el pedido contiene >=1 producto es_kit=true y suma >=2 colores distintos

CREATE TABLE IF NOT EXISTS color_trends_cache (
  id            BIGSERIAL PRIMARY KEY,
  fecha         DATE NOT NULL,
  producto_id   UUID NOT NULL,
  color_key     TEXT NOT NULL,
  color_label   TEXT NOT NULL,
  contexto      TEXT NOT NULL CHECK (contexto IN ('kit', 'set', 'individual')),
  unidades      INTEGER NOT NULL DEFAULT 0,
  pedidos       INTEGER NOT NULL DEFAULT 0,
  refreshed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(fecha, producto_id, contexto)
);

CREATE INDEX IF NOT EXISTS idx_color_trends_fecha    ON color_trends_cache(fecha);
CREATE INDEX IF NOT EXISTS idx_color_trends_producto ON color_trends_cache(producto_id);
CREATE INDEX IF NOT EXISTS idx_color_trends_contexto ON color_trends_cache(contexto);

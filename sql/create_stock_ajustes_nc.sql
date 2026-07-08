-- Auditoría de ajustes manuales de stock de colores "NC" hechos desde el panel de armador
-- (botón Guardar en la pantalla "Stock Colores"). Una fila por cada vez que un usuario
-- fija el stock físico de un SKU. NO registra la sincronización automática Shopify→app.

CREATE TABLE IF NOT EXISTS stock_ajustes_nc (
  id             BIGSERIAL PRIMARY KEY,
  producto_id    UUID,
  sku            TEXT NOT NULL,
  stock_anterior INTEGER,
  stock_nuevo    INTEGER NOT NULL,
  usuario_id     UUID,
  usuario_email  TEXT,
  usuario_nombre TEXT,
  origen         TEXT NOT NULL DEFAULT 'panel_armador',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_stock_ajustes_nc_producto ON stock_ajustes_nc(producto_id);
CREATE INDEX IF NOT EXISTS idx_stock_ajustes_nc_sku      ON stock_ajustes_nc(sku);
CREATE INDEX IF NOT EXISTS idx_stock_ajustes_nc_fecha    ON stock_ajustes_nc(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_stock_ajustes_nc_usuario  ON stock_ajustes_nc(usuario_id);

COMMENT ON TABLE stock_ajustes_nc IS 'Auditoría de conteos físicos de stock NC guardados desde el panel de armador: quién, valor anterior, valor nuevo y fecha';
COMMENT ON COLUMN stock_ajustes_nc.stock_anterior IS 'Valor de productos.stock justo antes del ajuste';
COMMENT ON COLUMN stock_ajustes_nc.stock_nuevo IS 'Nuevo valor fijado (también enviado a Shopify)';

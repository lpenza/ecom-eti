-- Tabla de idempotencia para la automatización de stock de pedidos Pick-UP.
-- Cada fila registra cuánto stock movió la edge function shopify-proxy de
-- Bvar España → Pick-UP para un pedido de Shopify. Shopify reintenta y duplica
-- webhooks (orders/create + orders/updated llegan casi juntos), así que el
-- movimiento NO puede depender solo del webhook: se calcula el delta contra
-- lo ya registrado acá.

CREATE TABLE IF NOT EXISTS pickup_stock_moves (
  id BIGSERIAL PRIMARY KEY,
  shopify_order_id TEXT NOT NULL UNIQUE,
  numero_pedido TEXT,
  -- [{ "inventory_item_id": 123, "cantidad": 2 }, ...] efectivamente movidos a Pick-UP
  items JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- procesando: insert inicial, movimiento en curso (si falla, el próximo webhook reintenta)
  -- movido:     stock transferido y esperando retiro
  -- cerrado:    el pedido ya quedó fulfilled (retirado) — nunca más se ajusta
  estado TEXT NOT NULL DEFAULT 'procesando',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

COMMENT ON TABLE pickup_stock_moves IS 'Registro idempotente de transferencias de stock Bvar España → Pick-UP hechas por la edge function shopify-proxy al entrar pedidos pickup';
COMMENT ON COLUMN pickup_stock_moves.shopify_order_id IS 'ID interno de la orden en Shopify (no el número de pedido). UNIQUE: frena procesamiento concurrente del mismo pedido';
COMMENT ON COLUMN pickup_stock_moves.items IS 'Inventory items y cantidades efectivamente movidos a Pick-UP (lo que habría que descontar/ajustar ante una edición)';
COMMENT ON COLUMN pickup_stock_moves.estado IS 'procesando | movido | cerrado';

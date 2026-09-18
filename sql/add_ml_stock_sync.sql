-- Sincronización automática de stock con MercadoLibre.
-- Correr una sola vez en el SQL editor de Supabase.

-- Marca de que el pedido de ML ya descontó su stock. Es la pieza CRÍTICA: el cron
-- de ML reprocesa una ventana de 72 h cada 10 minutos, así que sin esto el mismo
-- pedido descontaría stock en cada corrida hasta vaciar el inventario.
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS ml_stock_descontado_at timestamptz;

-- Detalle de lo ya descontado: [{ sku, cantidad, at }]. Permite reintentar un
-- pedido que falló a la mitad sin volver a descontar los ítems que sí salieron.
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS ml_stock_descontado jsonb NOT NULL DEFAULT '[]'::jsonb;

-- Los pedidos pendientes de descuento se buscan por esta condición.
CREATE INDEX IF NOT EXISTS pedidos_ml_stock_pendiente_idx
  ON pedidos (origen) WHERE ml_stock_descontado_at IS NULL;

-- Las ventas de ML anteriores a la puesta en marcha NO se descuentan hacia atrás
-- (decisión tomada): se marcan como ya procesadas para que el cron arranque limpio.
UPDATE pedidos
   SET ml_stock_descontado_at = now(),
       ml_stock_descontado    = '[{"nota":"marcado sin descontar: alta de la sincronizacion"}]'::jsonb
 WHERE origen = 'mercadolibre'
   AND ml_stock_descontado_at IS NULL;

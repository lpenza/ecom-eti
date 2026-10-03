-- Devolución de stock de las ventas de ML canceladas.
-- Correr una sola vez en el SQL editor de Supabase.

-- Marca de que el pedido cancelado ya devolvió su stock. Mientras esté en NULL,
-- el ciclo de stock de ML lo toma y repone lo que la venta había descontado.
-- Cada ítem devuelto además queda anotado en `ml_stock_descontado` (campo
-- `devuelto`), así un pedido que falla a la mitad se reintenta sin devolver dos veces.
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS ml_stock_devuelto_at timestamptz;

CREATE INDEX IF NOT EXISTS pedidos_ml_stock_devolucion_pendiente_idx
  ON pedidos (origen) WHERE estado = 'cancelado' AND ml_stock_devuelto_at IS NULL;

-- Los pedidos de ML que ya estaban cancelados antes de esto NO devuelven stock
-- hacia atrás (pudieron haberse corregido a mano): se marcan como procesados.
UPDATE pedidos
   SET ml_stock_devuelto_at = now()
 WHERE origen = 'mercadolibre'
   AND estado = 'cancelado'
   AND ml_stock_devuelto_at IS NULL;

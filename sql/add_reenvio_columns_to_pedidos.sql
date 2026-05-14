-- Columnas necesarias para el feature de reenvíos.
-- Idempotente: usa IF NOT EXISTS para que sea seguro re-ejecutarlo.

ALTER TABLE pedidos
  ADD COLUMN IF NOT EXISTS es_reenvio        boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS pedido_origen_id  uuid REFERENCES pedidos(id),
  ADD COLUMN IF NOT EXISTS motivo_reenvio    text;

CREATE INDEX IF NOT EXISTS idx_pedidos_es_reenvio
  ON pedidos (es_reenvio)
  WHERE es_reenvio = true;

CREATE INDEX IF NOT EXISTS idx_pedidos_pedido_origen_id
  ON pedidos (pedido_origen_id);

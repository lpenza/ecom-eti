-- Persistencia de tipo de entrega y punto de retiro UES en pedidos
ALTER TABLE pedidos
  ADD COLUMN IF NOT EXISTS tipo_entrega_ues TEXT,
  ADD COLUMN IF NOT EXISTS punto_retiro_ues_id TEXT,
  ADD COLUMN IF NOT EXISTS punto_retiro_ues_nombre TEXT;

-- Opcional: índice para filtros rápidos por tipo de entrega
CREATE INDEX IF NOT EXISTS idx_pedidos_tipo_entrega_ues
  ON pedidos (tipo_entrega_ues);

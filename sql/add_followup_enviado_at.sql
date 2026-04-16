-- Agregar columna para registrar cuándo se envió el follow-up al cliente
ALTER TABLE pedidos
  ADD COLUMN IF NOT EXISTS followup_enviado_at TIMESTAMP WITH TIME ZONE DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_pedidos_followup_enviado
  ON pedidos (followup_enviado_at);

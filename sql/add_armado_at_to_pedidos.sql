-- Timestamp real de armado por operario
-- Este campo representa CUANDO se marcó el pedido como armado.
ALTER TABLE pedidos
ADD COLUMN IF NOT EXISTS armado_at timestamptz;

-- Backfill opcional para histórico ya armado/despachado
-- Usa notificacion_enviada_at si existe; si no, cae a created_at.
UPDATE pedidos
SET armado_at = COALESCE(notificacion_enviada_at, created_at)
WHERE armado_at IS NULL
  AND estado IN ('despachado', 'enviado')
  AND despachado_por_nombre IS NOT NULL;

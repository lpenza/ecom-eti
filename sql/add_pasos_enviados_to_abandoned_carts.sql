-- Flujo de mensajes parametrizable para carritos abandonados.
--
-- Reemplaza las columnas fijas msg1_sent_at / msg2_sent_at por un mapa flexible
-- paso -> timestamp (JSONB), para poder agregar N mensajes al flujo sin tener
-- que modificar el esquema cada vez.
--
--   pasos_enviados = { "1": "2026-06-22T14:30:00.000Z", "2": "..." }

ALTER TABLE abandoned_carts
  ADD COLUMN IF NOT EXISTS pasos_enviados JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Backfill desde las columnas viejas (solo filas que aún no tengan pasos_enviados)
UPDATE abandoned_carts
SET pasos_enviados =
      (CASE WHEN msg1_sent_at IS NOT NULL THEN jsonb_build_object('1', to_jsonb(msg1_sent_at)) ELSE '{}'::jsonb END)
   || (CASE WHEN msg2_sent_at IS NOT NULL THEN jsonb_build_object('2', to_jsonb(msg2_sent_at)) ELSE '{}'::jsonb END)
WHERE (msg1_sent_at IS NOT NULL OR msg2_sent_at IS NOT NULL)
  AND (pasos_enviados IS NULL OR pasos_enviados = '{}'::jsonb);

-- Las columnas msg1_sent_at / msg2_sent_at quedan por compatibilidad histórica
-- pero ya no se usan. Una vez verificado el backfill se pueden eliminar:
--   ALTER TABLE abandoned_carts DROP COLUMN msg1_sent_at, DROP COLUMN msg2_sent_at;

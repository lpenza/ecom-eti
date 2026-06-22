-- Configuración del flujo de mensajes de carritos abandonados.
--
-- Cada fila es un PASO del flujo (un WhatsApp): qué plantilla mandar y cuánto
-- esperar antes de enviarlo. Esto reemplaza la configuración por env var WA_FLOW
-- y permite editar tiempos / agregar mensajes desde Administración sin redeploy.
--
-- La demora se mide desde el abandono (paso 1) o desde el envío del paso anterior
-- (pasos siguientes). `orden` define la secuencia (1, 2, 3...).

CREATE TABLE IF NOT EXISTS abandoned_cart_flow (
  id           BIGSERIAL PRIMARY KEY,
  orden        INT NOT NULL,
  template     TEXT NOT NULL,
  demora_horas NUMERIC NOT NULL,
  activo       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at   TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

COMMENT ON TABLE abandoned_cart_flow IS 'Pasos del flujo de recuperación de carritos abandonados (editable desde Administración). Si está vacía, el servidor usa WA_FLOW o el flujo por defecto.';
COMMENT ON COLUMN abandoned_cart_flow.orden IS 'Secuencia del paso: 1, 2, 3...';
COMMENT ON COLUMN abandoned_cart_flow.demora_horas IS 'Horas a esperar: desde el abandono (paso 1) o desde el envío del paso anterior';
COMMENT ON COLUMN abandoned_cart_flow.activo IS 'Si está en false, el paso se ignora sin borrarlo';

-- Seed inicial con el flujo histórico (1h y 12h). Solo si la tabla está vacía.
INSERT INTO abandoned_cart_flow (orden, template, demora_horas)
SELECT * FROM (VALUES
  (1, 'carrito_abandonado_1', 1),
  (2, 'carrito_abandonado_2', 12)
) AS seed(orden, template, demora_horas)
WHERE NOT EXISTS (SELECT 1 FROM abandoned_cart_flow);

-- Registro de "entrega sin despacho".
-- Caso excepcional: la cadetería se lleva un pedido que todavía está en
-- "Etiqueta Generada" (NO fue marcado como despachado). El armador debe
-- justificar por qué lo entrega así. Queda registrado para que el
-- administrador pueda hacer seguimiento de estos casos.

-- Timestamp (UTC) del momento en que se entregó sin despacho.
ALTER TABLE pedidos
ADD COLUMN IF NOT EXISTS entrega_sin_despacho_at timestamptz;

-- Nombre del usuario (armador/admin) que registró la entrega sin despacho.
ALTER TABLE pedidos
ADD COLUMN IF NOT EXISTS entrega_sin_despacho_por text;

-- Motivo (texto libre) por el cual se entregó sin despachar.
ALTER TABLE pedidos
ADD COLUMN IF NOT EXISTS entrega_sin_despacho_motivo text;

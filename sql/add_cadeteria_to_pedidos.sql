-- Registro de retiro por el servicio de cadetería.
-- Cuando la cadetería pasa a buscar los paquetes (pedidos ya despachados,
-- previo al fulfillment), el armador tilda cada paquete retirado.
-- retirado_cadeteria_at guarda el timestamp (UTC) del momento en que se marcó;
-- en la UI se muestra en horario de Uruguay (America/Montevideo).
ALTER TABLE pedidos
ADD COLUMN IF NOT EXISTS retirado_cadeteria_at timestamptz;

-- Nombre del usuario que marcó el retiro (armador o admin).
ALTER TABLE pedidos
ADD COLUMN IF NOT EXISTS retirado_cadeteria_por text;

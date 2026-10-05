-- Comprador de MercadoLibre en cada pedido. Permite detectar que dos ventas con
-- distinto número (p.ej. un producto suelto sin envío + un carrito con envío)
-- son de la misma persona, para que el armador las arme juntas con una sola
-- etiqueta. En ML el email y el teléfono vienen vacíos y el nombre es el del
-- destinatario, así que el id del comprador es la única clave confiable.
-- Correr una sola vez en el SQL editor de Supabase. El sync de ML completa los
-- pedidos de las últimas 72 h solo.
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS ml_buyer_id text;
CREATE INDEX IF NOT EXISTS pedidos_ml_buyer_id_idx ON pedidos (ml_buyer_id) WHERE ml_buyer_id IS NOT NULL;

-- Comprobantes fiscales (e-Ticket) emitidos en Zensei para pedidos de Shopify.
-- Correr una sola vez en el SQL editor de Supabase.
--
-- Hoy la emisión es MANUAL: el admin aprieta "Emitir" en la fila del pedido.
-- Las ventas de MercadoLibre no pasan por acá: las factura la integración de
-- ML que trae Zensei.

-- Identificación fiscal que devuelve Zensei. cfe_id es lo que se usa para
-- consultar el estado y bajar el PDF.
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS cfe_id text;
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS cfe_tipo text;          -- '101' = e-Ticket
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS cfe_serie text;
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS cfe_numero integer;
-- SENT (enviado a DGI con acuse) | READY_TO_SEND (emitido, envío a DGI pendiente)
-- | ERROR (DGI lo rechazó). Con cualquiera de los tres YA tiene número fiscal:
-- no se vuelve a emitir.
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS cfe_status text;
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS cfe_total numeric(12,2);
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS cfe_emitido_at timestamptz;
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS cfe_emitido_por text;

-- La clave de idempotencia es fija por pedido (shopify-<order_id>, o
-- shopify-<id1>+<id2> cuando el e-Ticket junta pedidos del mismo cliente): si un
-- reintento llega a Zensei con la misma clave, devuelve el mismo comprobante
-- en vez de emitir otro. Se guarda para poder auditarlo.
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS cfe_idempotency_key text;

-- Último error de un intento que NO terminó en comprobante (validación, timeout).
-- Se limpia al emitir bien.
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS cfe_error text;

-- Lo que se mandó a Zensei (líneas, netos) para poder explicar el comprobante.
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS cfe_detalle jsonb;

-- Los pedidos del mismo cliente (dos compras que viajan juntas) salen en UN
-- solo e-Ticket, así que varios pedidos pueden compartir cfe_id: el índice es
-- común, no único. La lista de pedidos que cubre queda en cfe_detalle.pedidos.
-- Si ya se había corrido la versión anterior de este archivo, esto quita el
-- índice único que impedía guardar un e-Ticket en más de un pedido.
DROP INDEX IF EXISTS pedidos_cfe_id_uidx;
CREATE INDEX IF NOT EXISTS pedidos_cfe_id_idx
  ON pedidos (cfe_id) WHERE cfe_id IS NOT NULL;

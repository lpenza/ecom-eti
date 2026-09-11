-- MercadoLibre: pedidos espejados en el panel + credenciales OAuth.
-- Correr una sola vez en el SQL editor de Supabase.

-- ── 1) Columnas nuevas en `pedidos` ─────────────────────────────────────────
-- Los pedidos de ML viven en la MISMA tabla que los de Shopify para que todos
-- los paneles (armador, cadetería, delivery especial, atención) los muestren sin
-- cambios. `origen` es lo que distingue de dónde vino cada uno.
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS origen              text NOT NULL DEFAULT 'shopify';
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS ml_order_id         text;
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS ml_pack_id          text;
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS ml_shipment_id      text;
-- Modo de envío que resolvió ML: 'me2' y derivados = etiqueta la genera ML;
-- 'custom'/'not_specified' = envío por nuestra cuenta (UES / Marco Postal).
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS ml_logistic_type    text;
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS ml_shipping_mode    text;
-- Snapshot de los ítems de la venta. Evita pegarle a la API de ML cada vez que
-- el armador abre el detalle (Shopify sí se consulta en vivo, ML tiene rate limit).
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS ml_items            jsonb;
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS ml_etiqueta_at      timestamptz;
-- Piso/apto y referencias de entrega que ML manda aparte de la calle. No se
-- meten en direccion_envio para no ensuciar el parseo de direcciones del courier.
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS ml_referencia       text;

-- Un pedido de ML no puede entrar dos veces (el sync corre por cron y por webhook).
CREATE UNIQUE INDEX IF NOT EXISTS pedidos_ml_order_id_key ON pedidos (ml_order_id) WHERE ml_order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS pedidos_origen_idx ON pedidos (origen);

-- ── 2) Credenciales OAuth de MercadoLibre ───────────────────────────────────
-- Fila única (id = 1). El access_token dura 6 h y el refresh_token es de un solo
-- uso: cada refresh devuelve uno nuevo y hay que persistirlo o se pierde la
-- conexión. Por eso va en la base y no en variables de entorno.
CREATE TABLE IF NOT EXISTS ml_config (
  id            int PRIMARY KEY DEFAULT 1,
  seller_id     text,
  nickname      text,
  access_token  text,
  refresh_token text,
  expires_at    timestamptz,
  updated_at    timestamptz DEFAULT now(),
  CONSTRAINT ml_config_single_row CHECK (id = 1)
);

INSERT INTO ml_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

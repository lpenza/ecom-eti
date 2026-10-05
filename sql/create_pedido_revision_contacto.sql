-- Pedidos marcados como "pendiente de contacto".
-- Correr una sola vez en el SQL editor de Supabase.
--
-- Antes vivía en pedido_revision_contacto.json dentro del contenedor: Railway
-- lo borraba en cada deploy (y cada réplica tenía el suyo), así que los pedidos
-- volvían solos a "por validar" y el email de contacto fallaba porque el
-- servidor ya no los encontraba como pendientes.
CREATE TABLE IF NOT EXISTS pedido_revision_contacto (
  pedido_id             text PRIMARY KEY,
  motivo                text NOT NULL,
  fecha                 timestamptz NOT NULL DEFAULT now(),
  ultimo_contacto_at    timestamptz,
  ultimo_contacto_canal text,
  updated_at            timestamptz DEFAULT now()
);

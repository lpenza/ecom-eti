-- Última dirección con la que se generó una etiqueta para cada cliente.
-- Correr una sola vez en el SQL editor de Supabase.
--
-- Cuando un pedido queda "pendiente de contacto" y el operador corrige la
-- dirección al generar la etiqueta, esa corrección se guarda acá. Si el mismo
-- cliente vuelve a comprar, el modal de datos precarga esta dirección y no hay
-- que volver a contactarlo.
--
-- Una fila por clave de cliente (ml:<buyer>, mail:<email>, tel:<últimos 8>),
-- así se encuentra aunque la compra nueva traiga sólo una de ellas.
CREATE TABLE IF NOT EXISTS cliente_direccion_etiqueta (
  clave                  text PRIMARY KEY,
  pedido_id              text NOT NULL,
  numero_pedido          text,
  -- Lo que el cliente escribió en ese pedido (para saber si la compra nueva
  -- trae la misma dirección o una distinta).
  direccion_original     text,
  localidad_original     text,
  departamento_original  text,
  -- Dirección con la que salió la etiqueta (mismo formato que payloadDireccion
  -- del modal: calle, nro_puerta, numero_apartamento, departamento_id, ...).
  direccion              jsonb NOT NULL,
  updated_at             timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS cliente_direccion_etiqueta_updated_idx
  ON cliente_direccion_etiqueta (updated_at DESC);

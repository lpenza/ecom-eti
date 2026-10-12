-- Conforme de entrega de MercadoLibre adjunto a un pedido.
-- Las ventas "a coordinar con el vendedor" se despachan con guía Pick-UP de MP y
-- llevan el conforme adentro del paquete, para que lo llene quien retira. ML no
-- expone ese documento por API, así que lo sube el admin desde el panel de ML.
-- Correr una sola vez en el SQL editor de Supabase.

-- El archivo va en una tabla APARTE a propósito: `pedidos` se consulta con
-- select('*') sobre cientos de filas, y arrastrar un PDF en base64 en cada una
-- haría pesadísima la carga del panel.
CREATE TABLE IF NOT EXISTS pedido_adjuntos (
  id           BIGSERIAL PRIMARY KEY,
  pedido_id    UUID NOT NULL,
  tipo         TEXT NOT NULL DEFAULT 'conforme_ml',
  nombre       TEXT,
  content_type TEXT NOT NULL DEFAULT 'application/pdf',
  contenido    TEXT NOT NULL,            -- el archivo en base64
  tamano       INTEGER,
  subido_por   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Un adjunto por tipo y pedido: volver a subir reemplaza al anterior.
CREATE UNIQUE INDEX IF NOT EXISTS pedido_adjuntos_pedido_tipo_key
  ON pedido_adjuntos (pedido_id, tipo);

-- Marca liviana en el pedido: le dice al panel y al armador que hay conforme
-- sin tener que traer el archivo.
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS conforme_adjunto_at TIMESTAMPTZ;

COMMENT ON TABLE pedido_adjuntos IS 'Archivos adjuntos a un pedido (hoy: conforme de entrega de MercadoLibre), en base64';

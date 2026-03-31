-- Tabla para gestionar plantillas de mensajes (Follow-Up y Tracking)
-- Esta tabla reemplaza el sistema anterior de localStorage con almacenamiento en base de datos

CREATE TABLE IF NOT EXISTS templates (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  content TEXT NOT NULL,
  is_active BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Índice para búsquedas rápidas por plantilla activa
CREATE INDEX IF NOT EXISTS idx_templates_is_active ON templates(is_active);

-- Comentarios para documentar la tabla
COMMENT ON TABLE templates IS 'Plantillas de mensajes para Follow-Up y notificaciones de tracking';
COMMENT ON COLUMN templates.name IS 'Nombre descriptivo de la plantilla';
COMMENT ON COLUMN templates.content IS 'Contenido del mensaje con variables como {{cliente_nombre}}, {{numero_pedido}}, etc.';
COMMENT ON COLUMN templates.is_active IS 'Indica si es la plantilla activa actualmente';

-- Insertar plantillas por defecto
INSERT INTO templates (name, content, is_active, created_at, updated_at) VALUES
(
  'Seguimiento Nutritivo',
  'Hola {{cliente_nombre}}! 🌱

¿Cómo va tu experiencia con tu pedido #{{numero_pedido}}? Ya pasaron {{dias_transcurridos}} días. 

Nos encantaría saber cómo te sentís y si tenés alguna consulta sobre tu plan nutricional. Estamos acá para acompañarte! 💚

¿Hay algo en lo que podamos ayudarte?',
  TRUE,
  NOW(),
  NOW()
),
(
  'Notificación de Envío',
  '¡Hola {{cliente_nombre}}! 🚚

Tu pedido #{{numero_pedido}} ya está en camino.

📦 Código de seguimiento: {{tracking}}
🔗 Seguí tu envío acá: {{tracking_url}}

¡Gracias por tu compra! 💚',
  FALSE,
  NOW(),
  NOW()
)
ON CONFLICT DO NOTHING;

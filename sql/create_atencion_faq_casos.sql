-- Casos agregados por el equipo a la Guía de Atención al Cliente (FAQ), por fuera
-- de los 90+ casos curados que vienen versionados en código (src/data/atencionFaq.js).
--
-- Esta tabla es el "agregador libre": admin y atención pueden sumar acá un caso
-- nuevo desde el propio panel (Guía de Atención → Agregar caso), sin tocar código
-- ni esperar un redeploy. El panel combina esta lista con los casos curados del
-- código para la búsqueda y la navegación por tema.

CREATE TABLE IF NOT EXISTS atencion_faq_casos (
  id TEXT PRIMARY KEY,
  categoria_id TEXT NOT NULL,
  categoria_nombre TEXT NOT NULL,
  categoria_icon TEXT DEFAULT '❓',
  categoria_descripcion TEXT,
  pregunta TEXT NOT NULL,
  regla TEXT,
  respuesta TEXT,
  -- [{ "condicion": "...", "respuesta": "..." }, ...]
  variantes JSONB NOT NULL DEFAULT '[]'::jsonb,
  escalar TEXT,
  no_prometer TEXT,
  dato_a_confirmar TEXT,
  -- ["color mal", "color incorrecto", ...] — sinónimos/frases para la búsqueda
  tags JSONB NOT NULL DEFAULT '[]'::jsonb,
  fuente TEXT,
  creado_por TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_atencion_faq_casos_categoria ON atencion_faq_casos(categoria_id);

COMMENT ON TABLE atencion_faq_casos IS 'Casos de la Guía de Atención al Cliente agregados desde el panel (no versionados en código)';
COMMENT ON COLUMN atencion_faq_casos.categoria_id IS 'Slug del tema: uno de los 12 temas existentes, o uno nuevo escrito por quien carga el caso';
COMMENT ON COLUMN atencion_faq_casos.categoria_descripcion IS 'Bajada de una línea del tema (se muestra debajo del nombre en el panel)';
COMMENT ON COLUMN atencion_faq_casos.variantes IS 'Ramas de la respuesta según una variable (ej: Montevideo vs interior)';
COMMENT ON COLUMN atencion_faq_casos.tags IS 'Formas alternativas de preguntar lo mismo, para que la búsqueda lo encuentre';
COMMENT ON COLUMN atencion_faq_casos.creado_por IS 'Email de quien cargó el caso, para trazabilidad';

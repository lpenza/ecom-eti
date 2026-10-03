-- Piloto de Meta Ads con aprobación: propuestas, actividad y parámetros.
-- Correr una sola vez en el SQL editor de Supabase (incluye la tabla de
-- parámetros de create_meta_ads_parametros.sql, no hace falta correr ambos).
--
-- Reemplaza a los archivos .md de las tareas programadas viejas:
--   acciones-ejecutadas.md / daily-log.md  → meta_ads_actividad
--   "Pendiente de tu decisión"             → meta_ads_propuestas
--   Rulebook (Parámetros configurables)    → meta_ads_parametros

CREATE TABLE IF NOT EXISTS meta_ads_parametros (
  id                 int PRIMARY KEY DEFAULT 1,
  parametros         jsonb NOT NULL DEFAULT '{}'::jsonb,
  actualizado_por    text,
  updated_at         timestamptz DEFAULT now(),
  CONSTRAINT meta_ads_parametros_single_row CHECK (id = 1)
);
INSERT INTO meta_ads_parametros (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- Cada cambio que un job sugiere. Nada se ejecuta en Meta sin que un admin
-- la apruebe; al aprobar se revalida contra el estado real antes de ejecutar.
CREATE TABLE IF NOT EXISTS meta_ads_propuestas (
  id               bigserial PRIMARY KEY,
  -- Identifica "la misma propuesta" entre corridas (ej. pausa:120250...):
  -- si el job la vuelve a generar se actualiza en vez de duplicarse.
  clave            text NOT NULL,
  job              text NOT NULL,          -- pausa_escalado | graduacion | manual
  tipo             text NOT NULL,          -- pausa | escalado | graduacion | duplicado_rtg | crear_cbo | reencender
  entidad_tipo     text,                   -- campania | conjunto | anuncio
  entidad_id       text,
  entidad_nombre   text,
  campania_nombre  text,
  oferta           text,
  titulo           text NOT NULL,
  motivo           text,
  regla            text,                   -- sección del Rulebook que la justifica
  avisos           jsonb NOT NULL DEFAULT '[]'::jsonb,  -- salvaguardas a tener en cuenta al aprobar
  payload          jsonb NOT NULL DEFAULT '{}'::jsonb,  -- lo que se ejecuta
  snapshot         jsonb NOT NULL DEFAULT '{}'::jsonb,  -- métricas al momento de proponer
  prioridad        int NOT NULL DEFAULT 50,             -- menor = más urgente
  estado           text NOT NULL DEFAULT 'pendiente',
    -- pendiente | aprobada | ejecutada | fallida | rechazada | desactualizada | vencida
  creado_at        timestamptz NOT NULL DEFAULT now(),
  actualizado_at   timestamptz NOT NULL DEFAULT now(),
  vence_at         timestamptz,
  resuelto_por     text,
  resuelto_at      timestamptz,
  resultado        jsonb,
  error            text
);
CREATE INDEX IF NOT EXISTS meta_ads_propuestas_estado_idx ON meta_ads_propuestas (estado, prioridad);
CREATE INDEX IF NOT EXISTS meta_ads_propuestas_clave_idx ON meta_ads_propuestas (clave);
-- Una sola propuesta pendiente por clave.
CREATE UNIQUE INDEX IF NOT EXISTS meta_ads_propuestas_clave_pendiente_uq
  ON meta_ads_propuestas (clave) WHERE estado = 'pendiente';

-- Historial de todo lo que pasó: corridas de jobs, acciones ejecutadas
-- (aprobadas o manuales desde el panel). Es también la fuente de las reglas
-- de cadencia ("no tocar la misma entidad más seguido que...").
CREATE TABLE IF NOT EXISTS meta_ads_actividad (
  id               bigserial PRIMARY KEY,
  at               timestamptz NOT NULL DEFAULT now(),
  tipo             text NOT NULL,   -- corrida | pausa | activacion | escalado | presupuesto | anuncio_creado | campania_creada | duplicado | rechazo | error
  origen           text NOT NULL,   -- nombre del job, 'aprobacion' o 'manual'
  usuario          text,
  entidad_tipo     text,
  entidad_id       text,
  entidad_nombre   text,
  conjunto_id      text,            -- ad set tocado (cadencia de graduación por ad set destino)
  titulo           text NOT NULL,
  detalle          text,
  antes            jsonb,
  despues          jsonb,
  propuesta_id     bigint REFERENCES meta_ads_propuestas(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS meta_ads_actividad_at_idx ON meta_ads_actividad (at DESC);
CREATE INDEX IF NOT EXISTS meta_ads_actividad_entidad_idx ON meta_ads_actividad (entidad_id, at DESC);
CREATE INDEX IF NOT EXISTS meta_ads_actividad_conjunto_idx ON meta_ads_actividad (conjunto_id, at DESC);

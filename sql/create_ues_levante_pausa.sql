-- Pausa del levante automático de UES.
-- Correr una sola vez en el SQL editor de Supabase.
--
-- Fila única (id = 1). Va en la base y no en variables de entorno porque la
-- pausa la decide el equipo desde el panel (licencias, feriados, mudanzas) y
-- tiene que sobrevivir a los redeploys de Railway sin tocar configuración.
CREATE TABLE IF NOT EXISTS ues_levante_pausa (
  id            int PRIMARY KEY DEFAULT 1,
  pausado       boolean NOT NULL DEFAULT false,
  -- Último día INCLUIDO en la pausa (hora de Uruguay). NULL = pausa indefinida.
  -- Al pasar esa fecha el cron se reanuda solo.
  pausado_hasta date,
  motivo        text,
  pausado_por_email  text,
  pausado_por_nombre text,
  pausado_at    timestamptz,
  reanudado_at  timestamptz,
  updated_at    timestamptz DEFAULT now(),
  CONSTRAINT ues_levante_pausa_single_row CHECK (id = 1)
);

INSERT INTO ues_levante_pausa (id, pausado) VALUES (1, false)
ON CONFLICT (id) DO NOTHING;

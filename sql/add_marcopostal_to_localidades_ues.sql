-- Agrega el mapeo a MarcoPostal sobre la tabla existente localidades_ues.
-- Idempotente: se puede correr varias veces sin romper.

ALTER TABLE localidades_ues
  ADD COLUMN IF NOT EXISTS marcopostal_id TEXT,
  ADD COLUMN IF NOT EXISTS marcopostal_nombre TEXT,
  ADD COLUMN IF NOT EXISTS marcopostal_cp TEXT,
  ADD COLUMN IF NOT EXISTS marcopostal_mapped_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_localidades_ues_mp_id
  ON localidades_ues (marcopostal_id);

CREATE INDEX IF NOT EXISTS idx_localidades_ues_mp_nombre
  ON localidades_ues (marcopostal_nombre);

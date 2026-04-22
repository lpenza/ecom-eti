-- ============================================================
-- EJECUTAR EN SUPABASE SQL EDITOR
-- ============================================================

-- 1. Tabla de usuarios
create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  email text unique not null,
  nombre text not null,
  password_hash text not null,
  role text not null check (role in ('admin', 'user')),
  activo boolean not null default true,
  created_at timestamptz not null default now()
);

-- 2. Columna en pedidos para registrar quién despachó
alter table pedidos
  add column if not exists despachado_por_nombre text;

-- Los usuarios iniciales se crean automáticamente al iniciar el servidor
-- si la tabla está vacía (ver initializeDefaultUsers en server.js)
-- Credenciales por defecto (cambiar en .env):
--   admin@velinne.com  /  ADMIN_PASSWORD
--   usuario@velinne.com  /  USER_PASSWORD

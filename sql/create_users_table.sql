-- Tabla de usuarios del sistema
create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  email text unique not null,
  nombre text not null,
  password_hash text not null,
  role text not null check (role in ('admin', 'user')),
  activo boolean not null default true,
  created_at timestamptz not null default now()
);

-- Usuarios iniciales (contraseñas deben cambiarse)
-- admin@velinne.com / admin123
-- usuario@velinne.com / usuario123
-- Los hashes se generan con bcryptjs al iniciar el servidor si no existen

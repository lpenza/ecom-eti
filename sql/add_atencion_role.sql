-- Agregar rol "atencion" (atención al cliente) a la tabla users.
-- Rol de solo lectura: ve todos los pedidos, su contenido y estado,
-- y el número de guía cuando el pedido está procesado.
-- EJECUTAR EN SUPABASE SQL EDITOR

alter table users drop constraint if exists users_role_check;
alter table users add constraint users_role_check check (role in ('admin', 'user', 'atencion'));

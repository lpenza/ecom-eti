-- Agregar columna para registrar quién despachó el pedido
alter table pedidos
  add column if not exists despachado_por_nombre text;

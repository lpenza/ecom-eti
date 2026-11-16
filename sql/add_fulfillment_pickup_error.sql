-- Marca de "el despacho automático de este pickup falló": guarda el error del
-- intento. Mientras tenga valor, el pedido no se vuelve a agendar ni a intentar
-- solo; hay que hacer el fulfillment a mano en Shopify y marcarlo como procesado.
-- Se limpia al procesarlo o al revertirlo a "etiqueta generada".
ALTER TABLE pedidos
  ADD COLUMN IF NOT EXISTS fulfillment_pickup_error text;

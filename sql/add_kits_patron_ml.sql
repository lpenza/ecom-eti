-- Kits de MercadoLibre en el checklist de armado.
--
-- Las publicaciones de ML tienen otro título que el producto de Shopify
-- ("Kit Studio Velinne Uñas Semipermanentes Lámpara Y Manicura …" vs
-- "Kit Signature"), así que cada kit lleva un patrón aparte para ML. El mismo
-- kit comparte el contenido físico fijo entre los dos canales.
--
-- Varias alternativas se separan con "|" (ML renombra publicaciones y conviven
-- ventas con el título viejo y el nuevo).
--
-- Un kit solo de ML deja patron_shopify vacío ('').

ALTER TABLE kits_config ADD COLUMN IF NOT EXISTS patron_ml TEXT;

COMMENT ON COLUMN kits_config.patron_ml IS 'Substring(s) del título de la publicación de MercadoLibre, separados por |; NULL = el kit no se reconoce en ventas de ML';

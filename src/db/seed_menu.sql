-- ============================================================================
-- Semilla del menu real de "La Ruta del Sabor" (Perucho).
-- Idempotente: se puede ejecutar varias veces sin duplicar filas.
-- Ejecutar despues de schema.sql:  psql "$DATABASE_URL" -f src/db/seed_menu.sql
-- ============================================================================

INSERT INTO menu_categories (name, display_order) VALUES
  ('Platos fuertes', 1),
  ('Sopas', 2),
  ('Bebidas', 3),
  ('Postres', 4)
ON CONFLICT (name) DO NOTHING;

WITH cat AS (
  SELECT id, name FROM menu_categories
)
INSERT INTO menu_items (category_id, name, description, price)
SELECT c.id, v.name, v.description, v.price
FROM (VALUES
  -- Platos fuertes
  ('Platos fuertes', 'Cuy entero asado',    'Papas cocinadas, lechuga, tomate, salsa de mani y aguacate.', 18.00),
  ('Platos fuertes', '1/2 Cuy asado',       'Papas cocinadas, lechuga, tomate, salsa de mani y aguacate.', 9.50),
  ('Platos fuertes', '1/4 Cuy asado',       'Papas cocinadas, lechuga, tomate, salsa de mani y aguacate.', 6.00),
  ('Platos fuertes', 'Parrillada',          'Pollo, chuleta, longaniza, boton rojo, boton negro, choclo, papas salteadas y ensalada.', 7.50),
  ('Platos fuertes', 'Borrego',             'Borrego asado, habas, choclo, papas salteadas, queso y ensalada.', 7.50),
  ('Platos fuertes', 'Costillas BBQ',       'Costilla asada, papas fritas, choclo, ensalada y salsa BBQ.', 6.00),
  ('Platos fuertes', 'Tilapia frita',       'Tilapia frita, yucas, porcion de arroz y curtido/ensalada.', 6.00),
  ('Platos fuertes', 'Corvina frita',       'Corvina frita, papas fritas, porcion de arroz y curtido/ensalada.', 6.00),
  ('Platos fuertes', 'Camarones al ajillo', 'Camarones al ajillo, arroz, maduros, tomate y aguacate.', 6.00),
  ('Platos fuertes', 'Churrasco',           'Carne a la plancha, papas fritas, arroz, boton rojo, huevo frito y ensalada.', 5.50),
  ('Platos fuertes', 'Fritada',             'Fritada, choclo, habas, queso, papas salteadas, tostado y curtido.', 6.00),
  ('Platos fuertes', 'Salchipapas',         NULL, 2.00),
  ('Platos fuertes', 'Papipollo',           NULL, 2.50),
  -- Sopas
  ('Sopas', 'Yaguarlocro',                  NULL, 4.50),
  ('Sopas', 'Caldo de gallina',             NULL, 4.50),
  ('Sopas', 'Menudo con morcilla de dulce', NULL, 4.50),
  ('Sopas', 'Caldo de pata',                NULL, 4.50),
  -- Bebidas
  ('Bebidas', 'Gaseosa retornable 2L',      NULL, 3.00),
  ('Bebidas', 'Gaseosa personal',           NULL, 1.00),
  ('Bebidas', 'Jarra (mora, limonada, chicha o guanabana)', NULL, 3.50),
  ('Bebidas', 'Vaso 16 oz (mora, limonada, chicha o guanabana)', NULL, 1.50),
  ('Bebidas', 'Agua',                       NULL, 1.00),
  ('Bebidas', 'Guitig',                     NULL, 1.00),
  -- Postres
  ('Postres', 'Helado de mandarina',        NULL, 1.00),
  ('Postres', 'Porcion de pastel de mandarina', NULL, 1.00),
  ('Postres', 'Pan de mandarina',           NULL, 1.00)
) AS v(category, name, description, price)
JOIN cat c ON c.name = v.category
WHERE NOT EXISTS (
  SELECT 1 FROM menu_items mi
  WHERE mi.name = v.name AND mi.deleted_at IS NULL
);

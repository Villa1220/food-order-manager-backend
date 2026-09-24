-- Estado por plato: el mesero marca cada ítem al salir de cocina.
-- Idempotente para la BD en Docker ya creada.

DO $$ BEGIN
    CREATE TYPE order_item_status AS ENUM ('pendiente', 'listo');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE order_items
    ADD COLUMN IF NOT EXISTS status order_item_status NOT NULL DEFAULT 'pendiente';

ALTER TABLE order_items
    ADD COLUMN IF NOT EXISTS ready_at TIMESTAMPTZ;

ALTER TABLE order_items
    ADD COLUMN IF NOT EXISTS ready_count INT NOT NULL DEFAULT 0;

UPDATE order_items
   SET ready_count = quantity
 WHERE status = 'listo' AND ready_count = 0;

CREATE INDEX IF NOT EXISTS idx_order_items_status ON order_items(status);

-- Líneas de cada cuenta: qué platos y cuántas unidades se cobraron.
CREATE TABLE IF NOT EXISTS payment_lines (
    id             SERIAL PRIMARY KEY,
    payment_id     INT NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
    order_item_id  INT NOT NULL REFERENCES order_items(id),
    item_name      VARCHAR(120) NOT NULL,
    quantity       INT NOT NULL CHECK (quantity > 0),
    unit_price     NUMERIC(8,2) NOT NULL,
    line_total     NUMERIC(10,2) GENERATED ALWAYS AS (unit_price * quantity) STORED
);

CREATE INDEX IF NOT EXISTS idx_payment_lines_payment_id ON payment_lines(payment_id);

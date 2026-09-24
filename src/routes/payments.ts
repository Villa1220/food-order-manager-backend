import { Router } from "express";
import { pool, withUser } from "../db/pool.js";
import {
  asyncHandler,
  requireAuth,
  requireRole,
} from "../auth/middleware.js";

export const paymentsRouter = Router();

const METHODS = new Set(["efectivo", "transferencia"]);

type LineInput = { order_item_id: number; quantity: number };

function cents(value: string | number): number {
  return Math.round(Number(value) * 100);
}

function money(centsValue: number): string {
  return (centsValue / 100).toFixed(2);
}

function parseLines(raw: unknown): LineInput[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw Object.assign(new Error("Elige al menos un plato para esta cuenta."), {
      status: 400,
    });
  }
  const lines = raw.map((row) => {
    const item = row as Record<string, unknown>;
    return {
      order_item_id: Number(item.order_item_id),
      quantity: Number(item.quantity),
    };
  });
  if (
    lines.some(
      (line) =>
        !Number.isInteger(line.order_item_id) ||
        !Number.isInteger(line.quantity) ||
        line.quantity < 1,
    )
  ) {
    throw Object.assign(new Error("Cantidad inválida en la cuenta."), {
      status: 400,
    });
  }
  return lines;
}

/**
 * GET /api/payments/open
 * Pedidos no cancelados con saldo. El precio de cada plato ya incluye IVA.
 */
paymentsRouter.get(
  "/open",
  requireAuth,
  requireRole("admin", "mesero"),
  asyncHandler(async (_req, res) => {
    const result = await pool.query(
      `SELECT o.id,
              o.order_code,
              o.table_number,
              o.status,
              o.subtotal,
              o.received_at,
              COALESCE(paid.paid_total, 0) AS paid_total,
              o.subtotal - COALESCE(paid.paid_total, 0) AS balance_due
       FROM orders o
       LEFT JOIN (
         SELECT order_id, SUM(amount) AS paid_total
         FROM payments
         WHERE status = 'activo'
         GROUP BY order_id
       ) paid ON paid.order_id = o.id
       WHERE o.status <> 'cancelado'
         AND o.subtotal - COALESCE(paid.paid_total, 0) > 0
       ORDER BY o.received_at DESC
       LIMIT 80`,
    );
    res.json({ orders: result.rows });
  }),
);

/**
 * GET /api/payments/orders/:id
 * Platos pendientes de cobro y recibos ya emitidos de ese pedido.
 */
paymentsRouter.get(
  "/orders/:id",
  requireAuth,
  requireRole("admin", "mesero"),
  asyncHandler(async (req, res) => {
    const orderId = Number(req.params.id);
    const order = await pool.query(
      `SELECT id, order_code, table_number, status, subtotal, received_at
       FROM orders
       WHERE id = $1 AND status <> 'cancelado'`,
      [orderId],
    );
    if (!order.rows[0]) {
      res.status(404).json({ error: "Pedido no encontrado." });
      return;
    }

    const items = await pool.query(
      `SELECT oi.id,
              oi.item_name AS name,
              oi.quantity,
              oi.unit_price,
              oi.notes,
              COALESCE(paid.paid_qty, 0)::int AS paid_qty
       FROM order_items oi
       LEFT JOIN (
         SELECT pl.order_item_id, SUM(pl.quantity) AS paid_qty
         FROM payment_lines pl
         JOIN payments p ON p.id = pl.payment_id AND p.status = 'activo'
         WHERE p.order_id = $1
         GROUP BY pl.order_item_id
       ) paid ON paid.order_item_id = oi.id
       WHERE oi.order_id = $1
       ORDER BY oi.id`,
      [orderId],
    );

    const receipts = await pool.query(
      `SELECT p.id,
              p.receipt_number,
              p.amount,
              p.payment_method,
              p.issued_at,
              COALESCE(
                json_agg(
                  json_build_object(
                    'name', pl.item_name,
                    'quantity', pl.quantity,
                    'unit_price', pl.unit_price
                  ) ORDER BY pl.id
                ) FILTER (WHERE pl.id IS NOT NULL),
                '[]'
              ) AS lines
       FROM payments p
       LEFT JOIN payment_lines pl ON pl.payment_id = p.id
       WHERE p.order_id = $1 AND p.status = 'activo'
       GROUP BY p.id
       ORDER BY p.issued_at`,
      [orderId],
    );

    res.json({ order: order.rows[0], items: items.rows, receipts: receipts.rows });
  }),
);

/**
 * POST /api/payments
 * Cobra una cuenta (total o una parte de los platos) en efectivo o transferencia.
 */
paymentsRouter.post(
  "/",
  requireAuth,
  requireRole("admin", "mesero"),
  asyncHandler(async (req, res) => {
    const orderId = Number(req.body?.order_id);
    const method = String(req.body?.payment_method ?? "");
    if (!Number.isInteger(orderId)) {
      res.status(400).json({ error: "Pedido inválido." });
      return;
    }
    if (!METHODS.has(method)) {
      res.status(400).json({ error: "El pago es en efectivo o transferencia." });
      return;
    }
    const requested = parseLines(req.body?.lines);
    const userId = req.user!.id;

    const payment = await withUser(userId, async (client) => {
      const locked = await client.query(
        `SELECT id, order_code, table_number, status
         FROM orders
         WHERE id = $1
         FOR UPDATE`,
        [orderId],
      );
      const order = locked.rows[0];
      if (!order || order.status === "cancelado") {
        throw Object.assign(new Error("Pedido no encontrado."), { status: 404 });
      }

      const stock = await client.query(
        `SELECT oi.id, oi.item_name, oi.quantity, oi.unit_price,
                COALESCE(paid.paid_qty, 0)::int AS paid_qty
         FROM order_items oi
         LEFT JOIN (
           SELECT pl.order_item_id, SUM(pl.quantity) AS paid_qty
           FROM payment_lines pl
           JOIN payments p ON p.id = pl.payment_id AND p.status = 'activo'
           WHERE p.order_id = $1
           GROUP BY pl.order_item_id
         ) paid ON paid.order_item_id = oi.id
         WHERE oi.order_id = $1`,
        [orderId],
      );
      const byId = new Map(stock.rows.map((row) => [Number(row.id), row]));

      let totalCents = 0;
      const ready: {
        order_item_id: number;
        name: string;
        quantity: number;
        unit_price: string;
      }[] = [];

      for (const line of requested) {
        const item = byId.get(line.order_item_id);
        if (!item) {
          throw Object.assign(new Error("Un plato no pertenece a este pedido."), {
            status: 400,
          });
        }
        const remaining = Number(item.quantity) - Number(item.paid_qty);
        if (line.quantity > remaining) {
          throw Object.assign(
            new Error(`"${item.item_name}" ya no tiene tantas unidades por cobrar.`),
            { status: 400 },
          );
        }
        totalCents += cents(item.unit_price) * line.quantity;
        ready.push({
          order_item_id: line.order_item_id,
          name: item.item_name,
          quantity: line.quantity,
          unit_price: Number(item.unit_price).toFixed(2),
        });
      }

      if (totalCents <= 0) {
        throw Object.assign(new Error("La cuenta no tiene monto."), { status: 400 });
      }

      const created = await client.query(
        `INSERT INTO payments (order_id, amount, payment_method, processed_by)
         VALUES ($1, $2, $3, $4)
         RETURNING id, receipt_number, amount, payment_method, issued_at`,
        [orderId, money(totalCents), method, userId],
      );
      const row = created.rows[0];

      for (const line of ready) {
        await client.query(
          `INSERT INTO payment_lines
             (payment_id, order_item_id, item_name, quantity, unit_price)
           VALUES ($1, $2, $3, $4, $5)`,
          [row.id, line.order_item_id, line.name, line.quantity, line.unit_price],
        );
      }

      await client.query(
        `INSERT INTO payment_events (payment_id, event_type, actor_user_id, new_values)
         VALUES ($1, 'created', $2, $3::jsonb)`,
        [
          row.id,
          userId,
          JSON.stringify({
            amount: money(totalCents),
            payment_method: method,
            lines: ready,
          }),
        ],
      );

      return {
        ...row,
        order_code: order.order_code,
        table_number: order.table_number,
        lines: ready,
      };
    });

    res.status(201).json({ payment });
  }),
);

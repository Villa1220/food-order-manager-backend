import { Router } from "express";
import { pool, withUser } from "../db/pool.js";
import {
  asyncHandler,
  requireAuth,
  requireRole,
} from "../auth/middleware.js";
import { emitToKitchen } from "../realtime.js";

export const ordersRouter = Router();

type OrderItemInput = {
  menu_item_id: number;
  quantity: number;
  notes?: string;
};

function parseItems(rawItems: unknown): OrderItemInput[] {
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    throw Object.assign(new Error("El pedido debe tener al menos un ítem."), {
      status: 400,
    });
  }
  const items: OrderItemInput[] = rawItems.map((it) => {
    const row = it as Record<string, unknown>;
    return {
      menu_item_id: Number(row.menu_item_id),
      quantity: Math.max(1, Number(row.quantity ?? 1)),
      notes:
        typeof row.notes === "string" && row.notes.trim()
          ? row.notes.trim()
          : undefined,
    };
  });
  if (items.some((it) => !Number.isInteger(it.menu_item_id))) {
    throw Object.assign(new Error("Ítem inválido en el pedido."), { status: 400 });
  }
  return items;
}

async function loadMenuMap(
  client: { query: typeof pool.query },
  menuIds: number[],
) {
  const menu = await client.query<{
    id: number;
    name: string;
    price: string;
    available: boolean;
  }>(
    `SELECT id, name, price, available
     FROM menu_items
     WHERE id = ANY($1::int[]) AND deleted_at IS NULL`,
    [menuIds],
  );
  const byId = new Map(menu.rows.map((m) => [m.id, m]));
  return byId;
}

function assertDishesAvailable(
  items: OrderItemInput[],
  byId: Map<number, { id: number; name: string; price: string; available: boolean }>,
) {
  for (const it of items) {
    const dish = byId.get(it.menu_item_id);
    if (!dish) {
      throw Object.assign(new Error("Plato inexistente."), { status: 400 });
    }
    if (!dish.available) {
      throw Object.assign(new Error(`"${dish.name}" está agotado.`), {
        status: 409,
      });
    }
  }
}

/** Franja horaria (métrica de la tesis): pico = almuerzo y cena en Ecuador. */
function demandBand(date = new Date()): "pico" | "baja" {
  const hour = Number(
    new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      hour12: false,
      timeZone: "America/Guayaquil",
    }).format(date),
  );
  return (hour >= 12 && hour < 15) || (hour >= 18 && hour < 21)
    ? "pico"
    : "baja";
}

const ORDER_WITH_ITEMS_SQL = `
  SELECT o.id, o.order_code, o.channel, o.status, o.table_number,
         o.customer_note, o.subtotal, o.demand_band,
         o.received_at, o.kitchen_notified_at, o.preparing_at,
         o.ready_at, o.delivered_at, o.cancelled_at,
         COALESCE(
           json_agg(
             json_build_object(
               'id', oi.id,
               'name', oi.item_name,
               'quantity', oi.quantity,
               'unit_price', oi.unit_price,
               'notes', oi.notes,
               'status', oi.status,
               'ready_count', oi.ready_count,
               'ready_at', oi.ready_at,
               'created_at', oi.created_at
             ) ORDER BY oi.id
           ) FILTER (WHERE oi.id IS NOT NULL),
           '[]'
         ) AS items
  FROM orders o
  LEFT JOIN order_items oi ON oi.order_id = o.id`;

async function fetchOrder(orderId: number) {
  const result = await pool.query(
    `${ORDER_WITH_ITEMS_SQL} WHERE o.id = $1 GROUP BY o.id`,
    [orderId],
  );
  return result.rows[0] ?? null;
}

/**
 * GET /api/orders?active=1
 * Personal autenticado. Con active=1 devuelve solo pedidos en curso (KDS).
 */
ordersRouter.get(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const activeOnly = req.query.active === "1";
    const result = await pool.query(
      `${ORDER_WITH_ITEMS_SQL}
       ${activeOnly ? `WHERE o.status IN ('recibido','en_preparacion','listo')` : ""}
       GROUP BY o.id
       ORDER BY o.received_at DESC
       LIMIT 100`,
    );
    res.json({ orders: result.rows });
  }),
);

/**
 * POST /api/orders (admin o mesero)
 * Crea un pedido presencial con sus ítems (precios congelados por snapshot),
 * registra el evento de dominio y notifica a cocina por WebSocket dejando
 * la marca kitchen_notified_at (métrica de latencia de la tesis).
 */
ordersRouter.post(
  "/",
  requireAuth,
  requireRole("admin", "mesero"),
  asyncHandler(async (req, res) => {
    const userId = req.user!.id;
    const tableNumber = String(req.body?.table_number ?? "").trim() || null;
    const customerNote = String(req.body?.customer_note ?? "").trim() || null;
    const rawItems: unknown = req.body?.items;

    if (!Array.isArray(rawItems) || rawItems.length === 0) {
      res.status(400).json({ error: "El pedido debe tener al menos un ítem." });
      return;
    }
    const items = parseItems(rawItems);

    const orderId = await withUser(userId, async (client) => {
      const menuIds = items.map((it) => it.menu_item_id);
      const byId = await loadMenuMap(client, menuIds);
      assertDishesAvailable(items, byId);

      const created = await client.query<{ id: number }>(
        `INSERT INTO orders
           (channel, table_number, mesero_id, customer_note, demand_band, created_by)
         VALUES ('presencial', $1, $2, $3, $4, $2)
         RETURNING id`,
        [tableNumber, userId, customerNote, demandBand()],
      );
      const id = created.rows[0].id;

      for (const it of items) {
        const dish = byId.get(it.menu_item_id)!;
        await client.query(
          `INSERT INTO order_items
             (order_id, menu_item_id, item_name, unit_price, quantity, notes, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [id, dish.id, dish.name, dish.price, it.quantity, it.notes ?? null, userId],
        );
      }

      await client.query(
        `INSERT INTO order_events (order_id, event_type, to_status, actor_user_id, metadata)
         VALUES ($1, 'created', 'recibido', $2, $3)`,
        [id, userId, JSON.stringify({ channel: "presencial", items: items.length })],
      );
      return id;
    });

    // Notificación a cocina: se marca el instante y se emite por WebSocket.
    await pool.query(
      `UPDATE orders SET kitchen_notified_at = now() WHERE id = $1`,
      [orderId],
    );
    await pool.query(
      `INSERT INTO order_events (order_id, event_type, actor_user_id)
       VALUES ($1, 'kitchen_notified', $2)`,
      [orderId, userId],
    );

    const order = await fetchOrder(orderId);
    emitToKitchen("order:new", order);
    res.status(201).json({ order });
  }),
);

/**
 * POST /api/orders/:id/items (admin o mesero)
 * Agrega platos a una comanda ya enviada (segunda ronda de la mesa).
 * Si la comanda ya estaba en "listo", vuelve a "recibido" para que cocina
 * vea el agregado en Nuevos.
 */
ordersRouter.post(
  "/:id/items",
  requireAuth,
  requireRole("admin", "mesero"),
  asyncHandler(async (req, res) => {
    const orderId = Number(req.params.id);
    if (!Number.isInteger(orderId)) {
      res.status(400).json({ error: "Pedido inválido." });
      return;
    }
    const items = parseItems(req.body?.items);
    const userId = req.user!.id;

    await withUser(userId, async (client) => {
      const existing = await client.query<{ id: number; status: string }>(
        `SELECT id, status FROM orders
         WHERE id = $1 AND status IN ('recibido', 'en_preparacion', 'listo')
         FOR UPDATE`,
        [orderId],
      );
      const row = existing.rows[0];
      if (!row) {
        throw Object.assign(
          new Error("El pedido no existe o ya fue entregado/cancelado."),
          { status: 409 },
        );
      }

      const byId = await loadMenuMap(
        client,
        items.map((it) => it.menu_item_id),
      );
      assertDishesAvailable(items, byId);

      for (const it of items) {
        const dish = byId.get(it.menu_item_id)!;
        await client.query(
          `INSERT INTO order_items
             (order_id, menu_item_id, item_name, unit_price, quantity, notes, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [orderId, dish.id, dish.name, dish.price, it.quantity, it.notes ?? null, userId],
        );
      }

      if (row.status === "listo") {
        await client.query(
          `UPDATE orders
           SET status = 'recibido',
               ready_at = NULL,
               delivered_at = NULL,
               corrections_count = corrections_count + 1
           WHERE id = $1`,
          [orderId],
        );
      } else {
        await client.query(
          `UPDATE orders
           SET corrections_count = corrections_count + 1
           WHERE id = $1`,
          [orderId],
        );
      }

      await client.query(
        `INSERT INTO order_events
           (order_id, event_type, from_status, to_status, actor_user_id, metadata)
         VALUES ($1, 'item_edited', $2, $3, $4, $5)`,
        [
          orderId,
          row.status,
          row.status === "listo" ? "recibido" : row.status,
          userId,
          JSON.stringify({ added: items.length }),
        ],
      );
    });

    const order = await fetchOrder(orderId);
    emitToKitchen("order:status", order);
    res.status(201).json({ order });
  }),
);

/**
 * PATCH /api/orders/:id/items/:itemId
 * El mesero marca (o desmarca) un plato al salir de cocina.
 * El cronómetro de ese plato se detiene en ready_at.
 */
ordersRouter.patch(
  "/:id/items/:itemId",
  requireAuth,
  requireRole("admin", "mesero"),
  asyncHandler(async (req, res) => {
    const orderId = Number(req.params.id);
    const itemId = Number(req.params.itemId);
    const rawCount = req.body?.ready_count;
    const userId = req.user!.id;

    await withUser(userId, async (client) => {
      const current = await client.query<{ quantity: number }>(
        `SELECT quantity FROM order_items WHERE id = $1 AND order_id = $2`,
        [itemId, orderId],
      );
      if (!current.rows[0]) {
        throw Object.assign(new Error("Plato no encontrado en este pedido."), {
          status: 404,
        });
      }
      const quantity = current.rows[0].quantity;
      const readyCount = Math.max(
        0,
        Math.min(quantity, Math.floor(Number(rawCount))),
      );
      if (!Number.isFinite(readyCount)) {
        throw Object.assign(new Error("Cantidad marcada inválida."), {
          status: 400,
        });
      }
      const done = readyCount === quantity;
      const updated = await client.query<{ id: number }>(
        `UPDATE order_items
         SET ready_count = $1,
             status = $2::order_item_status,
             ready_at = CASE
               WHEN $2 = 'listo' THEN COALESCE(ready_at, now())
               ELSE NULL
             END
         WHERE id = $3 AND order_id = $4
         RETURNING id`,
        [readyCount, done ? "listo" : "pendiente", itemId, orderId],
      );
      if (!updated.rows[0]) {
        throw Object.assign(new Error("Plato no encontrado en este pedido."), {
          status: 404,
        });
      }

      const counts = await client.query<{ pending: string; done: string }>(
        `SELECT
           COUNT(*) FILTER (WHERE status = 'pendiente')::text AS pending,
           COUNT(*) FILTER (WHERE status = 'listo')::text AS done
         FROM order_items WHERE order_id = $1`,
        [orderId],
      );
      const pending = Number(counts.rows[0].pending);
      const nextOrderStatus = pending === 0 ? "listo" : "recibido";

      await client.query(
        `UPDATE orders
         SET status = $2::order_status,
             ready_at = CASE WHEN $2 = 'listo' THEN COALESCE(ready_at, now()) ELSE NULL END,
             delivered_at = CASE WHEN $2 = 'listo' THEN COALESCE(delivered_at, now()) ELSE NULL END
         WHERE id = $1 AND status <> 'cancelado'`,
        [orderId, nextOrderStatus],
      );

      await client.query(
        `INSERT INTO order_events
           (order_id, event_type, to_status, actor_user_id, metadata)
         VALUES ($1, 'item_edited', $2, $3, $4)`,
        [
          orderId,
          nextOrderStatus,
          userId,
          JSON.stringify({ item_id: itemId, ready_count: readyCount }),
        ],
      );
    });

    const order = await fetchOrder(orderId);
    emitToKitchen("order:status", order);
    res.json({ order });
  }),
);

/** Transiciones de estado válidas y su columna de marca de tiempo. */
const STATUS_META: Record<
  string,
  { from: string[]; column: string }
> = {
  en_preparacion: { from: ["recibido"], column: "preparing_at" },
  listo: { from: ["en_preparacion"], column: "ready_at" },
  entregado: { from: ["listo"], column: "delivered_at" },
  cancelado: {
    from: ["recibido", "en_preparacion", "listo"],
    column: "cancelled_at",
  },
};

/**
 * PATCH /api/orders/:id/status (admin o mesero)
 * Avanza el estado del pedido validando la transición, deja la marca de
 * tiempo de la etapa y registra el evento de dominio.
 */
ordersRouter.patch(
  "/:id/status",
  requireAuth,
  requireRole("admin", "mesero"),
  asyncHandler(async (req, res) => {
    const orderId = Number(req.params.id);
    const target = String(req.body?.status ?? "");
    const meta = STATUS_META[target];
    if (!meta) {
      res.status(400).json({ error: `Estado destino inválido: ${target}` });
      return;
    }
    const userId = req.user!.id;

    const updated = await withUser(userId, async (client) => {
      const result = await client.query<{ id: number; status: string }>(
        `UPDATE orders
         SET status = $1::order_status, ${meta.column} = now()
         WHERE id = $2 AND status = ANY($3::order_status[])
         RETURNING id, status`,
        [target, orderId, meta.from],
      );
      const row = result.rows[0];
      if (!row) return null;
      await client.query(
        `INSERT INTO order_events
           (order_id, event_type, from_status, to_status, actor_user_id)
         VALUES ($1, 'status_changed', $2, $3, $4)`,
        [orderId, meta.from.join("|"), target, userId],
      );
      return row;
    });

    if (!updated) {
      res.status(409).json({
        error: "Transición de estado no permitida o pedido inexistente.",
      });
      return;
    }

    const order = await fetchOrder(orderId);
    emitToKitchen("order:status", order);
    res.json({ order });
  }),
);

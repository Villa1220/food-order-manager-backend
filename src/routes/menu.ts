import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Router } from "express";
import { pool, withUser } from "../db/pool.js";
import {
  asyncHandler,
  requireAuth,
  requireRole,
} from "../auth/middleware.js";

export const menuRouter = Router();

function searchQuery(raw: unknown): string | null {
  const value = typeof raw === "string" ? raw.trim() : "";
  return value.length > 0 ? value : null;
}

/**
 * GET /api/menu
 * Público: lo usa la página de pedidos del mesero y, a futuro, el bot.
 * Query opcional `q`: filtra platos por nombre (ILIKE).
 */
menuRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const q = searchQuery(req.query.q);
    const result = await pool.query(
      `SELECT c.id,
              c.name,
              c.display_order,
              COALESCE(
                json_agg(
                  json_build_object(
                    'id', i.id,
                    'name', i.name,
                    'description', i.description,
                    'price', i.price,
                    'available', i.available,
                    'image_url', i.image_url
                  ) ORDER BY i.name
                ) FILTER (WHERE i.id IS NOT NULL),
                '[]'
              ) AS items
       FROM menu_categories c
       LEFT JOIN menu_items i
         ON i.category_id = c.id
        AND i.deleted_at IS NULL
        AND ($1::text IS NULL OR i.name ILIKE '%' || $1 || '%')
       WHERE c.active = true
       GROUP BY c.id
       ORDER BY c.display_order, c.name`,
      [q],
    );
    res.json({ categories: result.rows });
  }),
);

/**
 * GET /api/menu/items?q=
 * Lista plana de platos para el buscador del mesero.
 * Sin `q` devuelve los platos disponibles; con `q` filtra por nombre.
 */
menuRouter.get(
  "/items",
  asyncHandler(async (req, res) => {
    const q = searchQuery(req.query.q);
    const result = await pool.query(
      `SELECT i.id,
              i.name,
              i.description,
              i.price,
              i.available,
              i.image_url,
              c.name AS category
       FROM menu_items i
       JOIN menu_categories c ON c.id = i.category_id
       WHERE i.deleted_at IS NULL
         AND c.active = true
         AND ($1::text IS NULL OR i.name ILIKE '%' || $1 || '%')
       ORDER BY i.available DESC, c.display_order, i.name
       LIMIT 40`,
      [q],
    );
    res.json({ items: result.rows });
  }),
);

/** POST /api/menu/categories (admin) */
menuRouter.post(
  "/categories",
  requireAuth,
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const name = String(req.body?.name ?? "").trim();
    const displayOrder = Number(req.body?.display_order ?? 0);
    if (!name) {
      res.status(400).json({ error: "El nombre es obligatorio." });
      return;
    }
    const result = await pool.query(
      `INSERT INTO menu_categories (name, display_order)
       VALUES ($1, $2)
       ON CONFLICT (name) DO UPDATE SET active = true
       RETURNING id, name, display_order, active`,
      [name, displayOrder],
    );
    res.status(201).json({ category: result.rows[0] });
  }),
);

/** POST /api/menu/items (admin) */
menuRouter.post(
  "/items",
  requireAuth,
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const { category_id, name, description, price } = req.body ?? {};
    if (!name || typeof price !== "number" || price < 0) {
      res
        .status(400)
        .json({ error: "Nombre y precio (número >= 0) son obligatorios." });
      return;
    }
    const userId = req.user!.id;
    const item = await withUser(userId, async (client) => {
      const created = await client.query(
        `INSERT INTO menu_items (category_id, name, description, price, created_by)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, category_id, name, description, price, available, image_url`,
        [category_id ?? null, String(name).trim(), description ?? null, price, userId],
      );
      return created.rows[0];
    });
    res.status(201).json({ item });
  }),
);

const MENU_UPLOADS = path.join(process.cwd(), "uploads", "menu");

async function storeMenuImage(itemId: number, dataUrl: string): Promise<string> {
  const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=\s]+)$/.exec(
    dataUrl.trim(),
  );
  if (!match) {
    throw Object.assign(new Error("La imagen debe ser JPG, PNG o WebP."), {
      status: 400,
    });
  }
  const buffer = Buffer.from(match[2].replace(/\s/g, ""), "base64");
  if (buffer.length > 5 * 1024 * 1024) {
    throw Object.assign(new Error("La imagen supera 5 MB."), { status: 400 });
  }
  const ext =
    match[1] === "image/png" ? "png" : match[1] === "image/webp" ? "webp" : "jpg";
  await mkdir(MENU_UPLOADS, { recursive: true });
  const filename = `${itemId}-${Date.now()}.${ext}`;
  await writeFile(path.join(MENU_UPLOADS, filename), buffer);
  return `/uploads/menu/${filename}`;
}

/** POST /api/menu/items/:id/image (admin) — reemplaza la foto del plato. */
menuRouter.post(
  "/items/:id/image",
  requireAuth,
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const dataUrl = String(req.body?.data_url ?? "");
    const imageUrl = await storeMenuImage(id, dataUrl);
    const userId = req.user!.id;
    const item = await withUser(userId, async (client) => {
      const updated = await client.query(
        `UPDATE menu_items
         SET image_url = $1, updated_by = $2
         WHERE id = $3 AND deleted_at IS NULL
         RETURNING id, category_id, name, description, price, available, image_url`,
        [imageUrl, userId, id],
      );
      return updated.rows[0] ?? null;
    });
    if (!item) {
      res.status(404).json({ error: "Plato no encontrado." });
      return;
    }
    res.json({ item });
  }),
);

/** PATCH /api/menu/items/:id (admin) — edición parcial, incluye "agotado". */
menuRouter.patch(
  "/items/:id",
  requireAuth,
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const allowed = ["category_id", "name", "description", "price", "available", "image_url"] as const;
    const sets: string[] = [];
    const values: unknown[] = [];
    for (const key of allowed) {
      if (req.body?.[key] !== undefined) {
        values.push(req.body[key]);
        sets.push(`${key} = $${values.length}`);
      }
    }
    if (sets.length === 0) {
      res.status(400).json({ error: "Nada que actualizar." });
      return;
    }
    const userId = req.user!.id;
    values.push(userId);
    sets.push(`updated_by = $${values.length}`);
    values.push(id);

    const item = await withUser(userId, async (client) => {
      const updated = await client.query(
        `UPDATE menu_items SET ${sets.join(", ")}
         WHERE id = $${values.length} AND deleted_at IS NULL
         RETURNING id, category_id, name, description, price, available, image_url`,
        values,
      );
      return updated.rows[0] ?? null;
    });
    if (!item) {
      res.status(404).json({ error: "Plato no encontrado." });
      return;
    }
    res.json({ item });
  }),
);

/** DELETE /api/menu/items/:id (admin) — borrado lógico (soft delete). */
menuRouter.delete(
  "/items/:id",
  requireAuth,
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const userId = req.user!.id;
    const deleted = await withUser(userId, async (client) => {
      const result = await client.query(
        `UPDATE menu_items
         SET deleted_at = now(), updated_by = $1
         WHERE id = $2 AND deleted_at IS NULL
         RETURNING id`,
        [userId, id],
      );
      return result.rows[0] ?? null;
    });
    if (!deleted) {
      res.status(404).json({ error: "Plato no encontrado." });
      return;
    }
    res.json({ ok: true });
  }),
);

import cors from "cors";
import express from "express";
import { googleLogin } from "./auth/google.js";
import { config } from "./config.js";
import { pingDatabase, pool } from "./db/pool.js";

export const app = express();

app.use(
  cors({
    origin: config.frontendOrigin,
  }),
);
app.use(express.json());

app.post("/api/auth/google", (req, res, next) => {
  void googleLogin(req, res).catch(next);
});

app.get("/health", async (_req, res) => {
  try {
    const dbTime = await pingDatabase();
    res.json({
      ok: true,
      service: "food-order-manager-backend",
      database: "up",
      dbTime,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "db_error";
    res.status(503).json({
      ok: false,
      service: "food-order-manager-backend",
      database: "down",
      error: message,
    });
  }
});

app.get("/api/orders", async (_req, res) => {
  const result = await pool.query(
    `SELECT id, order_code, channel, status, table_number, received_at
     FROM orders
     ORDER BY received_at DESC
     LIMIT 50`,
  );
  res.json({ orders: result.rows });
});

app.use(
  (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error(err);
    res.status(500).json({ error: "Error interno del servidor." });
  },
);

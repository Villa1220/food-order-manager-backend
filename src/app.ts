import cors from "cors";
import express from "express";
import path from "node:path";
import { googleLogin } from "./auth/google.js";
import { config } from "./config.js";
import { pingDatabase } from "./db/pool.js";
import { menuRouter } from "./routes/menu.js";
import { ordersRouter } from "./routes/orders.js";
import { paymentsRouter } from "./routes/payments.js";

export const app = express();

app.use(
  cors({
    origin: config.frontendOrigin,
  }),
);
app.use(express.json({ limit: "8mb" }));
app.use("/uploads", express.static(path.join(process.cwd(), "uploads")));

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

app.use("/api/menu", menuRouter);
app.use("/api/orders", ordersRouter);
app.use("/api/payments", paymentsRouter);

app.use(
  (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status =
      typeof (err as { status?: unknown })?.status === "number"
        ? (err as { status: number }).status
        : 500;
    const message =
      status < 500 && err instanceof Error
        ? err.message
        : "Error interno del servidor.";
    if (status >= 500) console.error(err);
    res.status(status).json({ error: message });
  },
);

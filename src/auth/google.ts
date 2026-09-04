import { OAuth2Client } from "google-auth-library";
import type { Request, Response } from "express";
import { config } from "../config.js";
import { pool, withUser } from "../db/pool.js";
import { signSession, type AuthUser } from "./jwt.js";

type StaffRow = {
  id: string;
  email: string;
  full_name: string;
  role: "admin" | "mesero" | "cliente";
  google_sub: string | null;
  active: boolean;
};

function parseIp(req: Request): string | null {
  const raw = (req.ip ?? "").replace("::ffff:", "");
  if (raw === "::1") return "127.0.0.1";
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(raw)) return raw;
  return null;
}

function placeholderPhone(googleSub: string): string {
  const compact = googleSub.replace(/[^0-9A-Za-z]/g, "").slice(0, 19);
  return `g${compact}`.slice(0, 20);
}

async function recordLogin(
  req: Request,
  opts: { userId?: string | null; success: boolean },
) {
  await pool.query(
    `INSERT INTO login_events (user_id, method, success, ip_address, user_agent)
     VALUES ($1, 'google', $2, $3::inet, $4)`,
    [
      opts.userId ?? null,
      opts.success,
      parseIp(req),
      req.get("user-agent") ?? null,
    ],
  );
}

function toAuthUser(row: StaffRow): AuthUser {
  return {
    id: row.id,
    email: row.email,
    fullName: row.full_name,
    role: row.role,
  };
}

export async function googleLogin(req: Request, res: Response) {
  if (!config.googleClientId) {
    res.status(503).json({
      error:
        "Falta GOOGLE_CLIENT_ID en el backend. Crea un ID de cliente OAuth en Google Cloud.",
    });
    return;
  }

  const credential = req.body?.credential;
  if (typeof credential !== "string" || credential.length < 20) {
    res.status(400).json({ error: "Token de Google ausente o inválido." });
    return;
  }

  let email: string;
  let fullName: string;
  let googleSub: string;

  try {
    const googleClient = new OAuth2Client(config.googleClientId);
    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: config.googleClientId,
    });
    const payload = ticket.getPayload();
    if (!payload?.email || !payload.sub) {
      res.status(401).json({ error: "Google no envió correo o identificador." });
      return;
    }
    if (payload.email_verified === false) {
      res.status(401).json({ error: "El correo de Google no está verificado." });
      return;
    }
    email = payload.email.toLowerCase();
    fullName = (payload.name ?? email.split("@")[0]).trim();
    googleSub = payload.sub;
  } catch {
    await recordLogin(req, { success: false });
    res.status(401).json({ error: "No se pudo verificar el inicio de sesión con Google." });
    return;
  }

  const existing = await pool.query<StaffRow>(
    `SELECT id, email, full_name, role, google_sub, active
     FROM users
     WHERE email = $1 AND deleted_at IS NULL
     LIMIT 1`,
    [email],
  );

  let row = existing.rows[0];

  if (row) {
    if (row.role === "cliente") {
      await recordLogin(req, { userId: row.id, success: false });
      res.status(403).json({
        error: "Este correo está registrado como cliente. El personal entra con Google.",
      });
      return;
    }
    if (!row.active) {
      await recordLogin(req, { userId: row.id, success: false });
      res.status(403).json({ error: "La cuenta está desactivada." });
      return;
    }
    if (row.google_sub && row.google_sub !== googleSub) {
      await recordLogin(req, { userId: row.id, success: false });
      res.status(403).json({ error: "Este correo ya está vinculado a otra cuenta de Google." });
      return;
    }
    if (!row.google_sub) {
      row = await withUser(row.id, async (client) => {
        const updated = await client.query<StaffRow>(
          `UPDATE users
           SET google_sub = $1, google_linked_at = now(), full_name = $2
           WHERE id = $3
           RETURNING id, email, full_name, role, google_sub, active`,
          [googleSub, fullName, row.id],
        );
        return updated.rows[0];
      });
    }
  } else {
    const staffCount = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM users
       WHERE role IN ('admin', 'mesero') AND deleted_at IS NULL`,
    );
    if (Number(staffCount.rows[0].n) > 0) {
      await recordLogin(req, { success: false });
      res.status(403).json({
        error:
          "No hay una cuenta de personal invitada con este correo. Pide al administrador que te agregue.",
      });
      return;
    }

    row = await withUser(null, async (client) => {
      const created = await client.query<StaffRow>(
        `INSERT INTO users (role, full_name, email, phone, auth_provider, google_sub, google_linked_at)
         VALUES ('admin', $1, $2, $3, 'google', $4, now())
         RETURNING id, email, full_name, role, google_sub, active`,
        [fullName, email, placeholderPhone(googleSub), googleSub],
      );
      return created.rows[0];
    });
  }

  if (row.role === "cliente") {
    res.status(403).json({ error: "Rol no permitido para Google." });
    return;
  }

  const user = toAuthUser(row);
  await recordLogin(req, { userId: user.id, success: true });
  res.json({
    token: signSession(user),
    user: {
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      role: user.role,
    },
  });
}

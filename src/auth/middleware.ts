import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { config } from "../config.js";
import type { AuthUser } from "./jwt.js";

/** Request con el usuario autenticado ya resuelto por requireAuth. */
export type AuthedRequest = Request & { user?: AuthUser };

/** Extrae y verifica el JWT del header Authorization: Bearer <token>. */
export function requireAuth(
  req: AuthedRequest,
  res: Response,
  next: NextFunction,
) {
  const header = req.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) {
    res.status(401).json({ error: "Sesión requerida." });
    return;
  }
  try {
    const payload = jwt.verify(token, config.jwtSecret) as jwt.JwtPayload;
    if (typeof payload.sub !== "string") throw new Error("sub ausente");
    req.user = {
      id: payload.sub,
      email: String(payload.email ?? ""),
      fullName: String(payload.fullName ?? ""),
      role: payload.role as AuthUser["role"],
    };
    next();
  } catch {
    res.status(401).json({ error: "Sesión inválida o expirada." });
  }
}

/** Restringe la ruta a los roles indicados. Usar después de requireAuth. */
export function requireRole(...roles: AuthUser["role"][]) {
  return (req: AuthedRequest, res: Response, next: NextFunction) => {
    if (!req.user || !roles.includes(req.user.role)) {
      res.status(403).json({ error: "No tienes permisos para esta acción." });
      return;
    }
    next();
  };
}

/** Envuelve un handler async para propagar errores al middleware de Express. */
export function asyncHandler(
  fn: (req: AuthedRequest, res: Response) => Promise<void>,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    void fn(req as AuthedRequest, res).catch(next);
  };
}

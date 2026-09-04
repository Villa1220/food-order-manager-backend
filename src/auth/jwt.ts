import jwt from "jsonwebtoken";
import { config } from "../config.js";

export type AuthUser = {
  id: string;
  email: string;
  fullName: string;
  role: "admin" | "mesero" | "cliente";
};

export function signSession(user: AuthUser): string {
  return jwt.sign(
    {
      sub: user.id,
      email: user.email,
      fullName: user.fullName,
      role: user.role,
    },
    config.jwtSecret,
    { expiresIn: "7d" },
  );
}

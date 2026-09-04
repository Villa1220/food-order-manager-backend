import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Falta la variable de entorno ${name}`);
  }
  return value;
}

export const config = {
  port: Number(process.env.PORT ?? 4000),
  frontendOrigin: process.env.FRONTEND_ORIGIN ?? "http://localhost:3000",
  databaseUrl: required("DATABASE_URL"),
  googleClientId: process.env.GOOGLE_CLIENT_ID ?? "",
  jwtSecret: process.env.JWT_SECRET ?? "dev-only-change-me",
};

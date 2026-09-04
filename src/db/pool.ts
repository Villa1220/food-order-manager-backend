import pg from "pg";
import { config } from "../config.js";

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: 10,
});

export async function pingDatabase(): Promise<string> {
  const result = await pool.query<{ now: Date }>("SELECT now() AS now");
  return result.rows[0].now.toISOString();
}

/** Fija el actor de audit_log para la transaccion actual (schema.sql). */
export async function withUser<T>(
  userId: string | null,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (userId) {
      await client.query("SELECT set_config('app.current_user_id', $1, true)", [
        userId,
      ]);
    }
    const value = await fn(client);
    await client.query("COMMIT");
    return value;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

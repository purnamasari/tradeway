// Drizzle client. If DATABASE_URL is set, connects to Postgres and exposes the
// db instance. If not, db is null and all persistence calls become no-ops.
import { logger } from "../logger.js";

// Re-export the type so callers can import from one place.
export type Db = Awaited<ReturnType<typeof createDb>>;

export async function createDb(databaseUrl?: string) {
  if (!databaseUrl) {
    logger.info("[db] No DATABASE_URL — persistence disabled (log-only mode)");
    return null;
  }
  try {
    const { drizzle } = await import("drizzle-orm/postgres-js");
    const postgres = (await import("postgres")).default;
    const client = postgres(databaseUrl, { max: 5 });
    const db = drizzle(client);
    logger.info("[db] Connected to Postgres");
    return db;
  } catch (err) {
    logger.warn(`[db] Postgres connection failed (${(err as Error).message}) — persistence disabled`);
    return null;
  }
}

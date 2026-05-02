import { drizzle } from "drizzle-orm/mysql2";
import { eq, sql } from "drizzle-orm";
import { users, type User } from "../drizzle/schema";

let _db: ReturnType<typeof drizzle> | null = null;

// Lazily create the drizzle instance so local tooling can run without a DB.
export async function getDb() {
  if (!_db && process.env.DATABASE_URL) {
    try {
      _db = drizzle(process.env.DATABASE_URL);
    } catch (error) {
      console.warn("[Database] Failed to connect:", error);
      _db = null;
    }
  }
  return _db;
}

/**
 * Probes the database with a `SELECT 1` and a hard timeout. Used by the
 * /api/health endpoint and by orchestration layers (Render readiness probes).
 *
 * Returns `{ ok: true, latencyMs }` on success.
 * Returns `{ ok: false, error }` on connection failure or timeout — never
 * throws, so the caller can map the result to an HTTP status without
 * defensive try/catch.
 */
export async function pingDb(
  timeoutMs = 2000,
): Promise<{ ok: true; latencyMs: number } | { ok: false; error: string }> {
  const db = await getDb();
  if (!db) return { ok: false, error: "database not initialized" };

  const started = Date.now();
  const probe = db.execute(sql`SELECT 1`);
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(
      () => reject(new Error(`db ping timeout after ${timeoutMs}ms`)),
      timeoutMs,
    ),
  );

  try {
    await Promise.race([probe, timeout]);
    return { ok: true, latencyMs: Date.now() - started };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function getUserByEmail(email: string): Promise<User | null> {
  const db = await getDb();
  if (!db) return null;
  const [user] = await db.select().from(users).where(eq(users.email, email));
  return user ?? null;
}

export async function getUserById(id: number): Promise<User | null> {
  const db = await getDb();
  if (!db) return null;
  const [user] = await db.select().from(users).where(eq(users.id, id));
  return user ?? null;
}

/** @deprecated kept for any legacy code referencing openId */
export async function getUserByOpenId(openId: string): Promise<User | null> {
  const db = await getDb();
  if (!db) return null;
  const [user] = await db.select().from(users).where(eq(users.openId, openId));
  return user ?? null;
}
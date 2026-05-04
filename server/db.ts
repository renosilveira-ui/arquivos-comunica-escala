import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2";
import { eq, sql } from "drizzle-orm";
import { users, type User } from "../drizzle/schema";
import { resolveSslConfig } from "./_core/db-ssl";

let _db: ReturnType<typeof drizzle> | null = null;

// Lazily create the drizzle instance so local tooling can run without a DB.
//
// When DATABASE_SSL is set we build an explicit mysql2 pool so we can pass
// the ssl object (required by managed providers like DigitalOcean, RDS,
// PlanetScale, Aiven). When SSL is unset (local dev, tests) we keep the
// existing `drizzle(url)` shortcut — preserves the behavior the test suite
// has been validated against.
export async function getDb() {
  if (!_db && process.env.DATABASE_URL) {
    try {
      const ssl = resolveSslConfig(process.env);
      if (ssl) {
        const pool = mysql.createPool({
          uri: process.env.DATABASE_URL,
          ssl,
        });
        _db = drizzle(pool);
      } else {
        _db = drizzle(process.env.DATABASE_URL);
      }
    } catch (error) {
      console.warn("[Database] Failed to connect:", error);
      _db = null;
    }
  }
  return _db;
}

/** Opaque labels safe to expose to unauthenticated callers. */
export type DbProbeStatus =
  | "uninitialized"
  | "unreachable"
  | "auth_failed"
  | "unknown_database"
  | "timeout"
  | "unknown";

export type DbProbeResult =
  | { ok: true; latencyMs: number }
  | {
      ok: false;
      /** Sanitized status label safe for public response bodies. */
      status: DbProbeStatus;
      /** Full driver error message — internal use only (logs, server-side). */
      detail: string;
    };

const TIMEOUT_MARKER = "__db_ping_timeout__";

/**
 * Maps an arbitrary driver error into one of a small fixed set of opaque
 * labels. Callers that respond to unauthenticated traffic (e.g. /api/health)
 * MUST expose only the `status` label and never the raw `detail` — driver
 * messages routinely embed internal hostnames, IPs, usernames and DB names
 * (CWE-209).
 */
function classifyDbError(err: unknown): DbProbeStatus {
  if (err instanceof Error && err.message === TIMEOUT_MARKER) return "timeout";

  const code =
    err && typeof err === "object" && "code" in err
      ? String((err as { code: unknown }).code)
      : "";

  switch (code) {
    case "ECONNREFUSED":
    case "ENOTFOUND":
    case "ETIMEDOUT":
    case "EAI_AGAIN":
    case "ECONNRESET":
    case "EHOSTUNREACH":
    case "ENETUNREACH":
      return "unreachable";
    case "ER_ACCESS_DENIED_ERROR":
    case "ER_DBACCESS_DENIED_ERROR":
      return "auth_failed";
    case "ER_BAD_DB_ERROR":
      return "unknown_database";
    default:
      return "unknown";
  }
}

/**
 * Probes the database with a `SELECT 1` and a hard timeout. Used by the
 * /api/health endpoint and by orchestration layers (Render readiness probes).
 *
 * Returns `{ ok: true, latencyMs }` on success.
 * Returns `{ ok: false, status, detail }` on failure — never throws.
 *
 * `status` is a fixed-vocabulary label safe for public exposure; `detail` is
 * the raw driver message intended for server-side logs only and MUST NOT be
 * propagated to unauthenticated responses.
 */
export async function pingDb(timeoutMs = 2000): Promise<DbProbeResult> {
  const db = await getDb();
  if (!db) {
    return { ok: false, status: "uninitialized", detail: "database not initialized" };
  }

  const started = Date.now();
  const probe = db.execute(sql`SELECT 1`);
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(TIMEOUT_MARKER)), timeoutMs),
  );

  try {
    await Promise.race([probe, timeout]);
    return { ok: true, latencyMs: Date.now() - started };
  } catch (err) {
    const status = classifyDbError(err);
    const rawDetail = err instanceof Error ? err.message : String(err);
    const detail =
      status === "timeout" ? `db ping timeout after ${timeoutMs}ms` : rawDetail;
    return { ok: false, status, detail };
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
import { createHash } from "node:crypto";
import { drizzle } from "drizzle-orm/mysql2";
import { eq, sql } from "drizzle-orm";
import { pushTokens } from "../drizzle/schema";
import type { getDb } from "./db";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;
type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
type PushRegistrationMutationDb = Pick<Db, "delete"> | Pick<Transaction, "delete">;

export const PUSH_ACCOUNT_MUTATION_LOCK_TIMEOUT_SEC = 20;

export class PushOwnershipLockTimeoutError extends Error {}

function lockResultEquals(result: unknown, field: "acquired" | "released"): boolean {
  if (!Array.isArray(result) || !Array.isArray(result[0])) return false;
  const row = result[0][0] as Record<string, unknown> | undefined;
  return Number(row?.[field]) === 1;
}

function accountLockName(userId: number): string {
  return `escala-push-user:${userId}`;
}

function tokenLockName(token: string): string {
  const fingerprint = createHash("sha256").update(token).digest("hex").slice(0, 40);
  return `escala-push-token:${fingerprint}`;
}

async function withPushNamedLocks<T>(
  db: Db,
  lockNames: readonly string[],
  acquisitionTimeoutSeconds: number,
  callback: (connectionDb: Db) => Promise<T>,
): Promise<T> {
  const connection = await db.$client.promise().getConnection();
  const connectionDb = drizzle(connection) as unknown as Db;
  const acquired: string[] = [];
  let releaseSucceeded = true;
  try {
    for (const lockName of lockNames) {
      const result = await connectionDb.execute(sql`
        SELECT GET_LOCK(${lockName}, ${acquisitionTimeoutSeconds}) AS acquired
      `);
      if (!lockResultEquals(result, "acquired")) {
        throw new PushOwnershipLockTimeoutError("Timeout ao serializar ownership push");
      }
      acquired.push(lockName);
    }
    return await callback(connectionDb);
  } finally {
    for (const lockName of acquired.reverse()) {
      try {
        const result = await connectionDb.execute(sql`
          SELECT RELEASE_LOCK(${lockName}) AS released
        `);
        if (!lockResultEquals(result, "released")) {
          throw new Error("MySQL não confirmou a liberação do mutex push");
        }
      } catch {
        releaseSucceeded = false;
        console.error("[Notifications] PUSH_OWNERSHIP_MUTEX_RELEASE_FAILED");
      }
    }
    if (releaseSucceeded) connection.release();
    else connection.destroy();
  }
}

/** Serializa todas as mutações/fetches de push de uma conta. */
export async function withPushAccountMutex<T>(
  db: Db,
  userId: number,
  acquisitionTimeoutSeconds: number,
  callback: (connectionDb: Db) => Promise<T>,
): Promise<T> {
  if (!Number.isSafeInteger(userId) || userId <= 0) {
    throw new TypeError("userId inválido para mutex push");
  }
  return withPushNamedLocks(
    db,
    [accountLockName(userId)],
    acquisitionTimeoutSeconds,
    callback,
  );
}

/** Ordem global entre contas e o token físico, na mesma conexão MySQL. */
export async function withPushAccountAndTokenMutex<T>(
  db: Db,
  userId: number,
  token: string,
  acquisitionTimeoutSeconds: number,
  callback: (connectionDb: Db) => Promise<T>,
): Promise<T> {
  return withPushAccountAndTokenMutexes(
    db,
    userId,
    [token],
    acquisitionTimeoutSeconds,
    callback,
  );
}

/** Ordem global entre a conta e um conjunto de tokens físicos. */
export async function withPushAccountAndTokenMutexes<T>(
  db: Db,
  userId: number,
  tokens: readonly string[],
  acquisitionTimeoutSeconds: number,
  callback: (connectionDb: Db) => Promise<T>,
): Promise<T> {
  if (
    !Number.isSafeInteger(userId) ||
    userId <= 0 ||
    tokens.length === 0 ||
    tokens.some((token) => !token)
  ) {
    throw new TypeError("Ownership push inválido");
  }
  const tokenLocks = [...new Set(tokens.map(tokenLockName))].sort();
  return withPushNamedLocks(
    db,
    [accountLockName(userId), ...tokenLocks],
    acquisitionTimeoutSeconds,
    callback,
  );
}

function affectedRows(result: unknown): number {
  if (Array.isArray(result)) {
    const header = result[0] as { affectedRows?: unknown } | undefined;
    return Number(header?.affectedRows ?? 0);
  }
  return Number((result as { affectedRows?: unknown } | null)?.affectedRows ?? 0);
}

/**
 * Revoga todos os destinos push ligados às sessões anteriores de um usuário.
 * O caller deve manter `users(id)` sob X lock e executar este delete na mesma
 * transação do bump de `sessionVersion` (ordem global: user → push_tokens).
 */
export async function revokeUserPushRegistrations(
  db: PushRegistrationMutationDb,
  userId: number,
): Promise<number> {
  if (!Number.isSafeInteger(userId) || userId <= 0) {
    throw new TypeError("userId inválido para revogação de push");
  }
  const result = await db
    .delete(pushTokens)
    .where(eq(pushTokens.userId, userId));
  return affectedRows(result);
}

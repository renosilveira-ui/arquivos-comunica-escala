import { eq } from "drizzle-orm";
import { pushTokens } from "../drizzle/schema";
import type { getDb } from "./db";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;
type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
type PushRegistrationMutationDb = Pick<Db, "delete"> | Pick<Transaction, "delete">;

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

import { z } from "zod";
import { accountAuditEvents } from "../drizzle/schema";
import type { getDb } from "./db";

const positiveId = z.number().int().positive();
const accountAuditEntry = z
  .object({
    actorUserId: positiveId.nullable(),
    subjectUserId: positiveId,
    action: z.enum([
      "WHATSAPP_CONTACT_SET",
      "WHATSAPP_CONTACT_DEACTIVATED",
      "WHATSAPP_VERIFY_START",
      "WHATSAPP_VERIFY_CHECK",
      "PASSWORD_CHANGED",
      "PASSWORD_RESET_REQUESTED",
      "PASSWORD_RESET",
      "ACCOUNT_DELETED",
    ]),
    outcome: z.enum(["REQUESTED", "SUCCEEDED", "REJECTED", "FAILED"]),
    contactId: positiveId.nullable().default(null),
    sessionVersion: positiveId.nullable(),
    parentEventId: positiveId.nullable().default(null),
    verificationCleared: z.boolean().nullable().default(null),
  })
  .strict();

export type AccountAuditEntry = z.input<typeof accountAuditEntry>;
type AuditDb = Pick<NonNullable<Awaited<ReturnType<typeof getDb>>>, "insert">;

/** Sem tenant/PII/payload livre. O caller deve passar a mesma transação da mutação. */
export async function recordAccountAudit(
  db: AuditDb,
  entry: AccountAuditEntry,
): Promise<number> {
  const value = accountAuditEntry.parse(entry);
  try {
    const [row] = await db
      .insert(accountAuditEvents)
      .values(value)
      .$returningId();
    if (!row?.id) throw new Error("Missing audit receipt");
    return row.id;
  } catch {
    // Não propagar SQL/params do driver (nem converter a falha em sucesso).
    throw new Error("Account audit unavailable");
  }
}

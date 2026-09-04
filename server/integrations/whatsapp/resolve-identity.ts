import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { userContactChannels, users } from "../../../drizzle/schema";
import { getDb } from "../../db";
import { WHATSAPP_CHANNEL } from "../../user-contact-channels";
import type { WhatsAppIdentityResult } from "./types";

export type WhatsAppIdentityRow = { userId: number };

/**
 * Fail-closed: 0 → NOT_FOUND; >1 → CONFLICT; exatamente 1 → user.
 * Nunca escolhe o primeiro de um empate.
 * Só decide sobre linhas já lidas — não mapeia indisponibilidade de DB.
 */
export function decideVerifiedWhatsAppIdentity(
  rows: readonly WhatsAppIdentityRow[],
): WhatsAppIdentityResult {
  if (rows.length === 0) return { ok: false, code: "IDENTITY_NOT_FOUND" };
  if (rows.length > 1) return { ok: false, code: "IDENTITY_CONFLICT" };
  const userId = rows[0]?.userId;
  if (!userId) return { ok: false, code: "IDENTITY_NOT_FOUND" };
  return { ok: true, userId };
}

/**
 * From E.164 → usuário canônico via user_contact_channels.
 * Não infere por e-mail/nome. Não distingue "não existe" de "não verificado".
 * Banco indisponível ou falha transitória da query ≠ IDENTITY_NOT_FOUND.
 */
export async function resolveVerifiedWhatsAppUser(
  fromE164: string,
): Promise<WhatsAppIdentityResult> {
  const db = await getDb();
  if (!db) {
    return { ok: false, retryable: true, code: "DB_UNAVAILABLE" };
  }

  try {
    const rows = await db
      .select({ userId: userContactChannels.userId })
      .from(userContactChannels)
      .innerJoin(users, eq(users.id, userContactChannels.userId))
      .where(
        and(
          eq(userContactChannels.channel, WHATSAPP_CHANNEL),
          eq(userContactChannels.normalizedAddress, fromE164),
          eq(userContactChannels.active, true),
          isNotNull(userContactChannels.verifiedAt),
          isNull(users.deletedAt),
          eq(users.approvalStatus, "APPROVED"),
        ),
      )
      .limit(2);

    return decideVerifiedWhatsAppIdentity(rows);
  } catch {
    return { ok: false, retryable: true, code: "IDENTITY_QUERY_FAILED" };
  }
}

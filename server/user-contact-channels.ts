/**
 * Domínio: canais de contato WhatsApp do usuário.
 *
 * verifiedAt é autoridade server-side — só `markWhatsAppContactVerified`
 * (após Twilio Verify status=approved) pode preenchê-lo.
 * Mutations de perfil NUNCA marcam verificado.
 */
import { TRPCError } from "@trpc/server";
import { and, eq, inArray, isNull, lte, ne } from "drizzle-orm";
import { getDb } from "./db";
import {
  userContactChannels,
  users,
  whatsappVerificationChallenges,
} from "../drizzle/schema";
import { recordAccountAudit } from "./account-audit";
import {
  maskE164,
  normalizeToE164,
  type NormalizePhoneResult,
} from "../lib/phone-e164";

export const WHATSAPP_CHANNEL = "WHATSAPP" as const;

export type WhatsAppContactView = {
  maskedAddress: string;
  verified: boolean;
  active: boolean;
  /** Presente só em caminhos server-side internos — não expor ao cliente. */
  normalizedAddress?: string;
};

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;
export type WhatsAppContactDb = Pick<Db, "select" | "insert" | "update">;
export type WhatsAppOwner = { userId: number; sessionVersion: number };

export async function assertOperableWhatsAppUser(
  userId: number,
  sessionVersion: number,
): Promise<void> {
  if (!Number.isSafeInteger(sessionVersion) || sessionVersion <= 0)
    throw new TRPCError({ code: "UNAUTHORIZED" });
  const db = await getDb();
  if (!db) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "DB unavailable",
    });
  }
  await requireOperableWhatsAppUser(db, userId, sessionVersion);
}

function isDuplicateKeyError(error: unknown): boolean {
  const candidates: unknown[] = [error];
  const err = error as {
    cause?: unknown;
    code?: string;
    errno?: number;
    message?: string;
  };
  if (err?.cause) candidates.push(err.cause);
  return candidates.some((item) => {
    const e = item as { code?: string; errno?: number; message?: string };
    return (
      e?.code === "ER_DUP_ENTRY" ||
      e?.errno === 1062 ||
      /Duplicate entry/i.test(e?.message ?? "")
    );
  });
}

async function requireOperableWhatsAppUser(
  db: WhatsAppContactDb,
  userId: number,
  sessionVersion: number,
  lock = false,
) {
  if (!Number.isSafeInteger(userId) || userId <= 0)
    throw new TRPCError({ code: "UNAUTHORIZED" });
  const query = db
    .select({
      id: users.id,
      deletedAt: users.deletedAt,
      approvalStatus: users.approvalStatus,
      role: users.role,
      name: users.name,
      sessionVersion: users.sessionVersion,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const [user] = await (lock ? query.for("update") : query);
  if (!user || user.deletedAt) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Conta indisponível para cadastrar WhatsApp.",
    });
  }
  if (user.approvalStatus !== "APPROVED") {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Conta ainda não aprovada para cadastrar WhatsApp.",
    });
  }
  if (
    !Number.isSafeInteger(sessionVersion) ||
    sessionVersion <= 0 ||
    user.sessionVersion !== sessionVersion
  )
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Sessão revogada." });
  return user;
}

/** A mesma linha de users serializa contato, desafio, revogação e auditoria. */
export async function withWhatsAppOwnerTransaction<T>(
  owner: WhatsAppOwner,
  run: (
    tx: WhatsAppContactDb,
    user: Awaited<ReturnType<typeof requireOperableWhatsAppUser>>,
  ) => Promise<T>,
): Promise<T> {
  if (!Number.isSafeInteger(owner.sessionVersion) || owner.sessionVersion <= 0)
    throw new TRPCError({ code: "UNAUTHORIZED" });
  const db = await getDb();
  if (!db)
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "DB unavailable",
    });
  try {
    return await db.transaction(async (tx) => {
      const user = await requireOperableWhatsAppUser(
        tx,
        owner.userId,
        owner.sessionVersion,
        true,
      );
      // Retenção oportunista, limitada ao titular já bloqueado. Não concede
      // autorização; expiração/revogação já impedem o consumo antes da limpeza.
      await tx
        .update(whatsappVerificationChallenges)
        .set({ state: "FAILED", providerVerificationSid: null })
        .where(
          and(
            eq(whatsappVerificationChallenges.userId, user.id),
            inArray(whatsappVerificationChallenges.state, [
              "STARTING",
              "READY",
            ]),
            lte(whatsappVerificationChallenges.expiresAt, new Date()),
          ),
        );
      await tx
        .update(whatsappVerificationChallenges)
        .set({ state: "INVALIDATED", providerVerificationSid: null })
        .where(
          and(
            eq(whatsappVerificationChallenges.userId, user.id),
            inArray(whatsappVerificationChallenges.state, [
              "STARTING",
              "READY",
            ]),
            ne(
              whatsappVerificationChallenges.sessionVersion,
              user.sessionVersion,
            ),
          ),
        );
      return run(tx, user);
    });
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    // SQL do desafio pode conter o SID privado. Não encaminhar causa/params
    // ao formatter global, que também registra erros de driver.
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Operação WhatsApp indisponível no momento.",
    });
  }
}

export async function invalidateWhatsAppChallenge(
  tx: WhatsAppContactDb,
  userId: number,
): Promise<void> {
  await tx
    .update(whatsappVerificationChallenges)
    .set({ state: "INVALIDATED", providerVerificationSid: null })
    .where(eq(whatsappVerificationChallenges.userId, userId));
}

export function normalizeWhatsAppInput(raw: string): NormalizePhoneResult {
  return normalizeToE164(raw);
}

export async function getWhatsAppContactForUser(
  userId: number,
  sessionVersion: number,
): Promise<WhatsAppContactView | null> {
  return withWhatsAppOwnerTransaction(
    { userId, sessionVersion },
    async (db) => {
      const [row] = await db
        .select({
          normalizedAddress: userContactChannels.normalizedAddress,
          verifiedAt: userContactChannels.verifiedAt,
          active: userContactChannels.active,
        })
        .from(userContactChannels)
        .where(
          and(
            eq(userContactChannels.userId, userId),
            eq(userContactChannels.channel, WHATSAPP_CHANNEL),
          ),
        )
        .limit(1);
      if (!row || !row.active) return null;
      return {
        maskedAddress: maskE164(row.normalizedAddress),
        verified: row.verifiedAt != null,
        active: true,
      };
    },
  );
}

/**
 * Canal ativo do próprio usuário — E.164 para Verify start/check.
 * Não expor via tRPC ao cliente.
 */
export async function getActiveWhatsAppChannelForUser(
  userId: number,
  sessionVersion: number,
): Promise<{ e164: string; verified: boolean } | null> {
  return withWhatsAppOwnerTransaction(
    { userId, sessionVersion },
    async (db) => {
      const [row] = await db
        .select({
          normalizedAddress: userContactChannels.normalizedAddress,
          verifiedAt: userContactChannels.verifiedAt,
          active: userContactChannels.active,
        })
        .from(userContactChannels)
        .where(
          and(
            eq(userContactChannels.userId, userId),
            eq(userContactChannels.channel, WHATSAPP_CHANNEL),
          ),
        )
        .limit(1);
      if (!row || !row.active) return null;
      return {
        e164: row.normalizedAddress,
        verified: row.verifiedAt != null,
      };
    },
  );
}

/**
 * Canal verificado e ativo de um usuário operable — para inbound futuro.
 * Fail-closed se conta deleted/pending ou canal não verificado.
 */
export async function getVerifiedWhatsAppContactForUser(
  userId: number,
): Promise<{ e164: string; userId: number } | null> {
  const db = await getDb();
  if (!db) return null;
  const [row] = await db
    .select({
      normalizedAddress: userContactChannels.normalizedAddress,
      verifiedAt: userContactChannels.verifiedAt,
      active: userContactChannels.active,
      deletedAt: users.deletedAt,
      approvalStatus: users.approvalStatus,
    })
    .from(userContactChannels)
    .innerJoin(users, eq(users.id, userContactChannels.userId))
    .where(
      and(
        eq(userContactChannels.userId, userId),
        eq(userContactChannels.channel, WHATSAPP_CHANNEL),
        eq(userContactChannels.active, true),
        isNull(users.deletedAt),
        eq(users.approvalStatus, "APPROVED"),
      ),
    )
    .limit(1);
  if (!row?.verifiedAt || !row.active) return null;
  return { e164: row.normalizedAddress, userId };
}

export async function upsertUserWhatsAppContact(input: {
  userId: number;
  rawPhone: string;
  sessionVersion: number;
}): Promise<WhatsAppContactView> {
  const normalized = normalizeWhatsAppInput(input.rawPhone);
  if (!normalized.ok) {
    throw new TRPCError({ code: "BAD_REQUEST", message: normalized.reason });
  }

  return withWhatsAppOwnerTransaction(input, async (db, user) => {
    const [existing] = await db
      .select()
      .from(userContactChannels)
      .where(
        and(
          eq(userContactChannels.userId, input.userId),
          eq(userContactChannels.channel, WHATSAPP_CHANNEL),
        ),
      )
      .limit(1);

    const numberChanged =
      !existing ||
      existing.normalizedAddress !== normalized.e164 ||
      !existing.active;

    try {
      if (existing) {
        await db
          .update(userContactChannels)
          .set({
            address: normalized.displayInput.slice(0, 32),
            normalizedAddress: normalized.e164,
            active: true,
            // Qualquer mudança de número (ou reativação) invalida verificação.
            verifiedAt: numberChanged ? null : existing.verifiedAt,
          })
          .where(eq(userContactChannels.id, existing.id));
      } else {
        await db.insert(userContactChannels).values({
          userId: input.userId,
          channel: WHATSAPP_CHANNEL,
          address: normalized.displayInput.slice(0, 32),
          normalizedAddress: normalized.e164,
          active: true,
          verifiedAt: null,
        });
      }
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        throw new TRPCError({
          code: "CONFLICT",
          message:
            "Este WhatsApp já está vinculado a outra conta. Use outro número ou fale com o suporte.",
        });
      }
      throw error;
    }

    if (numberChanged) await invalidateWhatsAppChallenge(db, input.userId);
    await recordAccountAudit(db, {
      actorUserId: user.id,
      subjectUserId: user.id,
      sessionVersion: user.sessionVersion,
      action: "WHATSAPP_CONTACT_SET",
      outcome: "SUCCEEDED",
      verificationCleared: numberChanged,
    });

    return {
      maskedAddress: maskE164(normalized.e164),
      verified: numberChanged ? false : Boolean(existing?.verifiedAt),
      active: true,
    };
  });
}

export async function deactivateUserWhatsAppContact(input: {
  userId: number;
  sessionVersion: number;
}): Promise<{ active: false }> {
  return withWhatsAppOwnerTransaction(input, async (db, user) => {
    const [existing] = await db
      .select()
      .from(userContactChannels)
      .where(
        and(
          eq(userContactChannels.userId, input.userId),
          eq(userContactChannels.channel, WHATSAPP_CHANNEL),
        ),
      )
      .limit(1);
    if (!existing || !existing.active) {
      return { active: false };
    }

    await db
      .update(userContactChannels)
      .set({
        active: false,
        verifiedAt: null,
      })
      .where(eq(userContactChannels.id, existing.id));

    await invalidateWhatsAppChallenge(db, input.userId);
    await recordAccountAudit(db, {
      actorUserId: user.id,
      subjectUserId: user.id,
      sessionVersion: user.sessionVersion,
      action: "WHATSAPP_CONTACT_DEACTIVATED",
      outcome: "SUCCEEDED",
      contactId: existing.id,
      verificationCleared: true,
    });

    return { active: false };
  });
}

/**
 * Primitive domain — NÃO expor via tRPC ao cliente.
 * Somente o check Twilio Verify com status `approved` deve chamar.
 */
export async function markWhatsAppContactVerified(input: {
  userId: number;
  sessionVersion: number;
  expectedE164: string;
  expectedChallengeId: string;
  expectedProviderSid: string;
  requestAuditId: number;
}): Promise<void> {
  await withWhatsAppOwnerTransaction(input, async (db, user) => {
    const expected = normalizeWhatsAppInput(input.expectedE164);
    if (!expected.ok) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "E.164 esperado inválido para marcar verificação.",
      });
    }
    const [challenge] = await db
      .select()
      .from(whatsappVerificationChallenges)
      .where(eq(whatsappVerificationChallenges.userId, user.id))
      .limit(1);
    if (
      !challenge ||
      challenge.state !== "READY" ||
      challenge.challengeId !== input.expectedChallengeId ||
      challenge.providerVerificationSid !== input.expectedProviderSid ||
      challenge.sessionVersion !== user.sessionVersion ||
      challenge.expiresAt <= new Date()
    ) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "Desafio WhatsApp mudou ou expirou.",
      });
    }

    const updated = await db
      .update(userContactChannels)
      .set({ verifiedAt: new Date() })
      .where(
        and(
          eq(userContactChannels.userId, input.userId),
          eq(userContactChannels.id, challenge.contactId),
          eq(userContactChannels.channel, WHATSAPP_CHANNEL),
          eq(userContactChannels.normalizedAddress, expected.e164),
          eq(userContactChannels.active, true),
        ),
      );
    const affected = Array.isArray(updated)
      ? Number(
          (updated[0] as { affectedRows?: number } | undefined)?.affectedRows ??
            0,
        )
      : Number(
          (updated as { affectedRows?: number } | null)?.affectedRows ?? 0,
        );
    if (affected < 1) {
      throw new TRPCError({
        code: "CONFLICT",
        message:
          "Canal WhatsApp não encontrado ou número não confere com o cadastrado.",
      });
    }
    const consumed = await db
      .update(whatsappVerificationChallenges)
      .set({ state: "CONSUMED", providerVerificationSid: null })
      .where(
        and(
          eq(whatsappVerificationChallenges.userId, user.id),
          eq(
            whatsappVerificationChallenges.challengeId,
            input.expectedChallengeId,
          ),
          eq(whatsappVerificationChallenges.state, "READY"),
        ),
      );
    if (Number(consumed[0]?.affectedRows ?? 0) !== 1) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "Desafio WhatsApp já consumido.",
      });
    }
    await recordAccountAudit(db, {
      actorUserId: user.id,
      subjectUserId: user.id,
      sessionVersion: user.sessionVersion,
      action: "WHATSAPP_VERIFY_CHECK",
      outcome: "SUCCEEDED",
      contactId: challenge.contactId,
      parentEventId: input.requestAuditId,
    });
  });
}

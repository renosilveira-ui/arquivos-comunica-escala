/**
 * Domínio: canais de contato WhatsApp do usuário.
 *
 * verifiedAt é autoridade server-side — só `markWhatsAppContactVerified`
 * (chamado futuramente pelo adapter Twilio Verify) pode preenchê-lo.
 * Mutations de perfil NUNCA marcam verificado.
 */
import { createHash } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "./db";
import { userContactChannels, users } from "../drizzle/schema";
import { recordAudit } from "./audit-trail";
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

function e164AuditHash(e164: string): string {
  return createHash("sha256").update(e164).digest("hex").slice(0, 16);
}

function isDuplicateKeyError(error: unknown): boolean {
  const candidates: unknown[] = [error];
  const err = error as { cause?: unknown; code?: string; errno?: number; message?: string };
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

async function requireOperableUser(db: Db, userId: number) {
  const [user] = await db
    .select({
      id: users.id,
      deletedAt: users.deletedAt,
      approvalStatus: users.approvalStatus,
      role: users.role,
      name: users.name,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
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
  return user;
}

export function normalizeWhatsAppInput(raw: string): NormalizePhoneResult {
  return normalizeToE164(raw);
}

export async function getWhatsAppContactForUser(
  userId: number,
): Promise<WhatsAppContactView | null> {
  const db = await getDb();
  if (!db) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "DB unavailable",
    });
  }
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
  institutionId: number;
}): Promise<WhatsAppContactView> {
  const db = await getDb();
  if (!db) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "DB unavailable",
    });
  }

  const normalized = normalizeWhatsAppInput(input.rawPhone);
  if (!normalized.ok) {
    throw new TRPCError({ code: "BAD_REQUEST", message: normalized.reason });
  }

  const user = await requireOperableUser(db, input.userId);

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

  await recordAudit(
    {
      institutionId: input.institutionId,
      actorUserId: user.id,
      actorRole: user.role,
      actorName: user.name ?? undefined,
      action: "USER_UPDATED",
      entityType: "USER",
      entityId: user.id,
      description: numberChanged
        ? "WhatsApp cadastrado/alterado (verificação pendente)"
        : "WhatsApp reconfirmado sem mudança de número",
      metadata: {
        channel: WHATSAPP_CHANNEL,
        addressHash: e164AuditHash(normalized.e164),
        verificationCleared: numberChanged,
      },
    },
    { strict: true },
  );

  console.info(
    "[whatsapp-contact] upsert",
    JSON.stringify({
      userId: input.userId,
      addressHash: e164AuditHash(normalized.e164),
      verificationCleared: numberChanged,
    }),
  );

  return {
    maskedAddress: maskE164(normalized.e164),
    verified: numberChanged ? false : Boolean(existing?.verifiedAt),
    active: true,
  };
}

export async function deactivateUserWhatsAppContact(input: {
  userId: number;
  institutionId: number;
}): Promise<{ active: false }> {
  const db = await getDb();
  if (!db) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "DB unavailable",
    });
  }
  const user = await requireOperableUser(db, input.userId);
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

  await recordAudit(
    {
      institutionId: input.institutionId,
      actorUserId: user.id,
      actorRole: user.role,
      actorName: user.name ?? undefined,
      action: "USER_UPDATED",
      entityType: "USER",
      entityId: user.id,
      description: "WhatsApp desativado pelo próprio usuário",
      metadata: {
        channel: WHATSAPP_CHANNEL,
        addressHash: e164AuditHash(existing.normalizedAddress),
      },
    },
    { strict: true },
  );

  return { active: false };
}

/**
 * Primitive domain — NÃO expor via tRPC ao cliente.
 * Somente o adapter Twilio Verify (Incremento 2B) deve chamar após approved.
 */
export async function markWhatsAppContactVerified(input: {
  userId: number;
  expectedE164: string;
}): Promise<void> {
  const db = await getDb();
  if (!db) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "DB unavailable",
    });
  }
  await requireOperableUser(db, input.userId);
  const expected = normalizeWhatsAppInput(input.expectedE164);
  if (!expected.ok) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "E.164 esperado inválido para marcar verificação.",
    });
  }

  const updated = await db
    .update(userContactChannels)
    .set({ verifiedAt: new Date(), active: true })
    .where(
      and(
        eq(userContactChannels.userId, input.userId),
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
    : Number((updated as { affectedRows?: number } | null)?.affectedRows ?? 0);
  if (affected < 1) {
    throw new TRPCError({
      code: "CONFLICT",
      message:
        "Canal WhatsApp não encontrado ou número não confere com o cadastrado.",
    });
  }
}

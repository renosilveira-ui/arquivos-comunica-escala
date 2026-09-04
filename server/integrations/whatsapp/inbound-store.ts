import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { whatsappInboundMessages } from "../../../drizzle/schema";
import { getDb } from "../../db";
import { logger } from "../../_core/logger";
import { resolveVerifiedWhatsAppUser } from "./resolve-identity";
import type { WhatsAppInboundEnvelope } from "./types";
import { WhatsAppInboundStatuses } from "./types";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

export type InboundProcessResult =
  | { outcome: "replay"; id: number; status: string }
  | { outcome: "accepted"; id: number; status: string; userId: number | null };

function senderAddressHash(e164: string): string {
  return createHash("sha256").update(e164).digest("hex").slice(0, 16);
}

function messageSidHash(sid: string): string {
  return createHash("sha256").update(sid).digest("hex").slice(0, 16);
}

function isDuplicateKeyError(error: unknown): boolean {
  const candidates: unknown[] = [error];
  const err = error as { cause?: unknown };
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

function terminalFor(
  contentKind: WhatsAppInboundEnvelope["content"]["kind"],
  identity: Awaited<ReturnType<typeof resolveVerifiedWhatsAppUser>>,
): {
  status: (typeof WhatsAppInboundStatuses)[keyof typeof WhatsAppInboundStatuses];
  userId: number | null;
  errorCode: string | null;
} {
  if (!identity.ok) {
    return {
      status:
        identity.code === "IDENTITY_CONFLICT"
          ? WhatsAppInboundStatuses.IDENTITY_CONFLICT
          : WhatsAppInboundStatuses.IDENTITY_NOT_FOUND,
      userId: null,
      errorCode: identity.code,
    };
  }
  if (contentKind === "UNSUPPORTED_MEDIA") {
    return {
      status: WhatsAppInboundStatuses.UNSUPPORTED,
      userId: identity.userId,
      errorCode: "UNSUPPORTED_MEDIA",
    };
  }
  if (contentKind === "AUDIO") {
    return {
      status: WhatsAppInboundStatuses.READY_FOR_TRANSCRIPTION,
      userId: identity.userId,
      errorCode: null,
    };
  }
  return {
    status: WhatsAppInboundStatuses.READY_FOR_NL,
    userId: identity.userId,
    errorCode: null,
  };
}

function logSafe(payload: Record<string, unknown>): void {
  logger.info(JSON.stringify(payload));
}

async function loadByProviderMessage(
  db: Db,
  providerMessageId: string,
) {
  const [row] = await db
    .select({
      id: whatsappInboundMessages.id,
      processingStatus: whatsappInboundMessages.processingStatus,
    })
    .from(whatsappInboundMessages)
    .where(
      and(
        eq(whatsappInboundMessages.provider, "TWILIO"),
        eq(whatsappInboundMessages.providerMessageId, providerMessageId),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function processWhatsAppInbound(
  envelope: WhatsAppInboundEnvelope,
): Promise<InboundProcessResult> {
  const db = await getDb();
  if (!db) {
    throw new Error("DB unavailable");
  }

  const existing = await loadByProviderMessage(db, envelope.providerMessageId);
  if (existing) {
    logSafe({
      event: "whatsapp_inbound_replay",
      messageSidHash: messageSidHash(envelope.providerMessageId),
      status: existing.processingStatus,
    });
    return {
      outcome: "replay",
      id: existing.id,
      status: existing.processingStatus,
    };
  }

  let insertedId: number;
  try {
    const [inserted] = await db
      .insert(whatsappInboundMessages)
      .values({
        provider: "TWILIO",
        providerMessageId: envelope.providerMessageId,
        userId: null,
        contentKind: envelope.content.kind,
        forwarded:
          envelope.content.kind === "TEXT" ? envelope.content.forwarded : false,
        processingStatus: WhatsAppInboundStatuses.RECEIVED,
        errorCode: null,
        senderAddressHash: senderAddressHash(envelope.fromE164),
        receivedAt: envelope.receivedAt,
        processedAt: null,
      })
      .$returningId();
    insertedId = inserted.id;
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      const raced = await loadByProviderMessage(db, envelope.providerMessageId);
      if (raced) {
        logSafe({
          event: "whatsapp_inbound_unique_race",
          messageSidHash: messageSidHash(envelope.providerMessageId),
          status: raced.processingStatus,
        });
        return {
          outcome: "replay",
          id: raced.id,
          status: raced.processingStatus,
        };
      }
    }
    throw error;
  }

  try {
    const identity = await resolveVerifiedWhatsAppUser(envelope.fromE164);
    const terminal = terminalFor(envelope.content.kind, identity);
    await db
      .update(whatsappInboundMessages)
      .set({
        userId: terminal.userId,
        processingStatus: terminal.status,
        errorCode: terminal.errorCode,
        processedAt: new Date(),
      })
      .where(eq(whatsappInboundMessages.id, insertedId));

    logSafe({
      event: "whatsapp_inbound_accepted",
      messageSidHash: messageSidHash(envelope.providerMessageId),
      userId: terminal.userId,
      contentKind: envelope.content.kind,
      status: terminal.status,
      errorCode: terminal.errorCode,
    });

    return {
      outcome: "accepted",
      id: insertedId,
      status: terminal.status,
      userId: terminal.userId,
    };
  } catch {
    await db
      .update(whatsappInboundMessages)
      .set({
        processingStatus: WhatsAppInboundStatuses.FAILED,
        errorCode: "FAILED",
        processedAt: new Date(),
      })
      .where(eq(whatsappInboundMessages.id, insertedId));
    logSafe({
      event: "whatsapp_inbound_failed",
      messageSidHash: messageSidHash(envelope.providerMessageId),
      status: WhatsAppInboundStatuses.FAILED,
    });
    return {
      outcome: "accepted",
      id: insertedId,
      status: WhatsAppInboundStatuses.FAILED,
      userId: null,
    };
  }
}

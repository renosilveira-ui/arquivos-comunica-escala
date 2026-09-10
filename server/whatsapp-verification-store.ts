import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  userContactChannels,
  whatsappVerificationChallenges,
} from "../drizzle/schema";
import { recordAccountAudit } from "./account-audit";
import {
  withWhatsAppOwnerTransaction,
  type WhatsAppOwner,
} from "./user-contact-channels";
import { isTwilioVerificationSid } from "./integrations/whatsapp/twilio-verify-provider";
import type { WhatsAppVerificationStartResult } from "./whatsapp-verification-provider";

// Janela máxima local, independente de eventual TTL maior configurado no provider.
export const WHATSAPP_CHALLENGE_TTL_MS = 10 * 60 * 1000;
export type WhatsAppChallengeAttempt = {
  userId: number;
  sessionVersion: number;
  contactId: number;
  challengeId: string;
  e164: string;
  requestAuditId: number;
};
export type WhatsAppCheckAttempt = WhatsAppChallengeAttempt & {
  verificationSid: string;
};

export async function beginWhatsAppVerification(owner: WhatsAppOwner) {
  return withWhatsAppOwnerTransaction(owner, async (tx, user) => {
    const [contact] = await tx
      .select()
      .from(userContactChannels)
      .where(
        and(
          eq(userContactChannels.userId, user.id),
          eq(userContactChannels.channel, "WHATSAPP"),
        ),
      )
      .limit(1);
    if (!contact?.active) return { state: "MISSING" as const };
    if (contact.verifiedAt)
      return { state: "VERIFIED" as const, e164: contact.normalizedAddress };
    const requestAuditId = await recordAccountAudit(tx, {
      actorUserId: user.id,
      subjectUserId: user.id,
      sessionVersion: user.sessionVersion,
      action: "WHATSAPP_VERIFY_START",
      outcome: "REQUESTED",
      contactId: contact.id,
    });
    const challenge = {
      userId: user.id,
      challengeId: randomUUID(),
      contactId: contact.id,
      sessionVersion: user.sessionVersion,
      state: "STARTING" as const,
      providerVerificationSid: null,
      requestAuditId,
      expiresAt: new Date(Date.now() + WHATSAPP_CHALLENGE_TTL_MS),
      createdAt: new Date(),
    };
    await tx
      .insert(whatsappVerificationChallenges)
      .values(challenge)
      .onDuplicateKeyUpdate({ set: challenge });
    // Persistido ANTES da rede. A→B→A invalida STARTING; não o recriamos na conclusão.
    return {
      state: "STARTING" as const,
      attempt: {
        ...challenge,
        e164: contact.normalizedAddress,
      } satisfies WhatsAppChallengeAttempt,
    };
  });
}

export async function finishWhatsAppVerificationStart(
  attempt: WhatsAppChallengeAttempt,
  result: WhatsAppVerificationStartResult,
): Promise<boolean> {
  return withWhatsAppOwnerTransaction(attempt, async (tx, user) => {
    const [challenge] = await tx
      .select()
      .from(whatsappVerificationChallenges)
      .where(eq(whatsappVerificationChallenges.userId, user.id))
      .limit(1);
    const [contact] = await tx
      .select()
      .from(userContactChannels)
      .where(eq(userContactChannels.id, attempt.contactId))
      .limit(1);
    const current =
      challenge?.challengeId === attempt.challengeId &&
      challenge.state === "STARTING" &&
      challenge.sessionVersion === user.sessionVersion &&
      challenge.contactId === attempt.contactId &&
      challenge.expiresAt > new Date() &&
      contact?.userId === user.id &&
      contact.active &&
      contact.normalizedAddress === attempt.e164;
    const accepted =
      current && result.ok && isTwilioVerificationSid(result.verificationSid);
    if (
      challenge?.challengeId === attempt.challengeId &&
      challenge.state === "STARTING"
    ) {
      await tx
        .update(whatsappVerificationChallenges)
        .set({
          state: accepted ? "READY" : "FAILED",
          providerVerificationSid:
            accepted && result.ok ? result.verificationSid : null,
        })
        .where(
          and(
            eq(whatsappVerificationChallenges.userId, user.id),
            eq(whatsappVerificationChallenges.challengeId, attempt.challengeId),
            eq(whatsappVerificationChallenges.state, "STARTING"),
          ),
        );
    }
    await recordAccountAudit(tx, {
      actorUserId: user.id,
      subjectUserId: user.id,
      sessionVersion: user.sessionVersion,
      action: "WHATSAPP_VERIFY_START",
      outcome: accepted ? "SUCCEEDED" : result.ok ? "REJECTED" : "FAILED",
      contactId: attempt.contactId,
      parentEventId: attempt.requestAuditId,
    });
    return Boolean(accepted);
  });
}

export async function beginWhatsAppVerificationCheck(owner: WhatsAppOwner) {
  return withWhatsAppOwnerTransaction(owner, async (tx, user) => {
    const [contact] = await tx
      .select()
      .from(userContactChannels)
      .where(
        and(
          eq(userContactChannels.userId, user.id),
          eq(userContactChannels.channel, "WHATSAPP"),
        ),
      )
      .limit(1);
    if (!contact?.active) return { state: "MISSING" as const };
    if (contact.verifiedAt)
      return { state: "VERIFIED" as const, e164: contact.normalizedAddress };
    const [challenge] = await tx
      .select()
      .from(whatsappVerificationChallenges)
      .where(eq(whatsappVerificationChallenges.userId, user.id))
      .limit(1);
    if (
      challenge &&
      challenge.expiresAt <= new Date() &&
      (challenge.state === "STARTING" || challenge.state === "READY")
    ) {
      await tx
        .update(whatsappVerificationChallenges)
        .set({ state: "FAILED", providerVerificationSid: null })
        .where(eq(whatsappVerificationChallenges.userId, user.id));
    }
    if (
      !challenge ||
      challenge.state !== "READY" ||
      challenge.expiresAt <= new Date() ||
      challenge.contactId !== contact.id ||
      challenge.sessionVersion !== user.sessionVersion ||
      !isTwilioVerificationSid(challenge.providerVerificationSid)
    )
      return { state: "NO_CHALLENGE" as const };
    const requestAuditId = await recordAccountAudit(tx, {
      actorUserId: user.id,
      subjectUserId: user.id,
      sessionVersion: user.sessionVersion,
      action: "WHATSAPP_VERIFY_CHECK",
      outcome: "REQUESTED",
      contactId: contact.id,
      parentEventId: challenge.requestAuditId,
    });
    return {
      state: "READY" as const,
      attempt: {
        userId: user.id,
        sessionVersion: user.sessionVersion,
        contactId: contact.id,
        challengeId: challenge.challengeId,
        e164: contact.normalizedAddress,
        verificationSid: challenge.providerVerificationSid,
        requestAuditId,
      } satisfies WhatsAppCheckAttempt,
    };
  });
}

export async function recordWhatsAppCheckRejection(
  attempt: WhatsAppCheckAttempt,
  terminal: boolean,
): Promise<void> {
  await withWhatsAppOwnerTransaction(attempt, async (tx, user) => {
    if (terminal)
      await tx
        .update(whatsappVerificationChallenges)
        .set({ state: "FAILED", providerVerificationSid: null })
        .where(
          and(
            eq(whatsappVerificationChallenges.userId, user.id),
            eq(whatsappVerificationChallenges.challengeId, attempt.challengeId),
            eq(whatsappVerificationChallenges.state, "READY"),
          ),
        );
    await recordAccountAudit(tx, {
      actorUserId: user.id,
      subjectUserId: user.id,
      sessionVersion: user.sessionVersion,
      action: "WHATSAPP_VERIFY_CHECK",
      outcome: "REJECTED",
      contactId: attempt.contactId,
      parentEventId: attempt.requestAuditId,
    });
  });
}

import { randomBytes } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { users } from "../../drizzle/schema";
import { getDb } from "../../server/db";
import {
  beginWhatsAppVerification,
  finishWhatsAppVerificationStart,
  beginWhatsAppVerificationCheck,
} from "../../server/whatsapp-verification-store";
import { markWhatsAppContactVerified as commitVerifiedContact } from "../../server/user-contact-channels";

/** Fixture apenas de testes: prepara a correlação sem enviar OTP nem chamar a Twilio. */
export async function markWhatsAppContactVerified(input: {
  userId: number;
  expectedE164: string;
}): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Fixture database unavailable");
  const [user] = await db
    .select({ sessionVersion: users.sessionVersion })
    .from(users)
    .where(eq(users.id, input.userId))
    .limit(1);
  const owner = {
    userId: input.userId,
    sessionVersion: user?.sessionVersion ?? 0,
  };
  const begun = await beginWhatsAppVerification(owner);
  if (begun.state === "VERIFIED" && begun.e164 === input.expectedE164) return;
  if (begun.state !== "STARTING") throw new TRPCError({ code: "CONFLICT" });
  await finishWhatsAppVerificationStart(begun.attempt, {
    ok: true,
    status: "pending",
    verificationSid: `VE${randomBytes(16).toString("hex")}`,
  });
  const checked = await beginWhatsAppVerificationCheck(owner);
  if (checked.state !== "READY") throw new TRPCError({ code: "CONFLICT" });
  await commitVerifiedContact({
    userId: input.userId,
    sessionVersion: checked.attempt.sessionVersion,
    expectedE164: input.expectedE164,
    expectedChallengeId: checked.attempt.challengeId,
    expectedProviderSid: checked.attempt.verificationSid,
    requestAuditId: checked.attempt.requestAuditId,
  });
}

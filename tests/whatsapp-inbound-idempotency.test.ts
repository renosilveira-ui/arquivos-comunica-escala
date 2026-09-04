import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import {
  institutions,
  userContactChannels,
  users,
  whatsappInboundMessages,
} from "../drizzle/schema";
import { getDb } from "../server/db";
import { processWhatsAppInbound } from "../server/integrations/whatsapp/inbound-store";
import type { WhatsAppInboundEnvelope } from "../server/integrations/whatsapp/types";
import {
  markWhatsAppContactVerified,
  upsertUserWhatsAppContact,
} from "../server/user-contact-channels";
import * as identity from "../server/integrations/whatsapp/resolve-identity";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

function envelope(
  sid: string,
  fromE164: string,
  text = "olá",
): WhatsAppInboundEnvelope {
  return {
    provider: "TWILIO",
    providerMessageId: sid,
    fromE164,
    content: { kind: "TEXT", text, forwarded: false },
    receivedAt: new Date(),
  };
}

describe("WhatsApp inbound idempotency", () => {
  let db: Db;
  let institutionId: number;
  let userId: number;
  const stamp = Date.now();
  const e164 = "+5585999100001";
  const sids: string[] = [];

  beforeAll(async () => {
    const maybe = await getDb();
    if (!maybe) throw new Error("DB unavailable");
    db = maybe;
    const [institution] = await db.select().from(institutions).limit(1);
    if (!institution) throw new Error("seed institution missing");
    institutionId = institution.id;
    const name = `wa-idemp-${stamp}`;
    const [user] = await db
      .insert(users)
      .values({
        name,
        email: `${name}@example.test`,
        passwordHash: "not-used",
        role: "doctor",
        approvalStatus: "APPROVED",
        sessionVersion: 1,
      })
      .$returningId();
    userId = user.id;
    await upsertUserWhatsAppContact({ userId, rawPhone: e164, institutionId });
    await markWhatsAppContactVerified({ userId, expectedE164: e164 });
  });

  afterAll(async () => {
    if (sids.length > 0) {
      await db
        .delete(whatsappInboundMessages)
        .where(inArray(whatsappInboundMessages.providerMessageId, sids));
    }
    await db
      .delete(userContactChannels)
      .where(eq(userContactChannels.userId, userId));
    await db.delete(users).where(eq(users.id, userId));
  });

  it("MessageSid novo cria linha READY_FOR_NL", async () => {
    const sid = `SM${stamp}new`;
    sids.push(sid);
    const result = await processWhatsAppInbound(envelope(sid, e164));
    expect(result).toMatchObject({
      outcome: "accepted",
      status: "READY_FOR_NL",
      userId,
    });
    const rows = await db
      .select()
      .from(whatsappInboundMessages)
      .where(eq(whatsappInboundMessages.providerMessageId, sid));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.processingStatus).toBe("READY_FOR_NL");
    expect(rows[0]?.operationalText).toBe("olá");
    expect(rows[0]?.payloadExpiresAt).toBeTruthy();
    expect(rows[0]?.payloadClearedAt).toBeNull();
  });

  it("replay é no-op", async () => {
    const sid = `SM${stamp}replay`;
    sids.push(sid);
    await processWhatsAppInbound(envelope(sid, e164, "primeiro"));
    const again = await processWhatsAppInbound(envelope(sid, e164, "segundo"));
    expect(again.outcome).toBe("replay");
    const rows = await db
      .select()
      .from(whatsappInboundMessages)
      .where(eq(whatsappInboundMessages.providerMessageId, sid));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.processingStatus).toBe("READY_FOR_NL");
  });

  it("mesmo MessageSid com payload diferente não reprocessa", async () => {
    const sid = `SM${stamp}diff`;
    sids.push(sid);
    await processWhatsAppInbound(envelope(sid, e164, "original"));
    const again = await processWhatsAppInbound(
      envelope(sid, "+5585999100999", "outro texto"),
    );
    expect(again.outcome).toBe("replay");
    const [row] = await db
      .select()
      .from(whatsappInboundMessages)
      .where(eq(whatsappInboundMessages.providerMessageId, sid));
    expect(row?.userId).toBe(userId);
    expect(row?.processingStatus).toBe("READY_FOR_NL");
  });

  it("corrida UNIQUE resulta em uma linha", async () => {
    const sid = `SM${stamp}race`;
    sids.push(sid);
    const results = await Promise.all([
      processWhatsAppInbound(envelope(sid, e164, "a")),
      processWhatsAppInbound(envelope(sid, e164, "b")),
    ]);
    expect(
      results.every((r) => r.outcome === "accepted" || r.outcome === "replay"),
    ).toBe(true);
    const rows = await db
      .select()
      .from(whatsappInboundMessages)
      .where(eq(whatsappInboundMessages.providerMessageId, sid));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.processingStatus).toBe("READY_FOR_NL");
  });

  it("falha transitória após INSERT fica RETRYABLE e o retry retoma", async () => {
    const sid = `SM${stamp}fail`;
    sids.push(sid);
    const spy = vi
      .spyOn(identity, "resolveVerifiedWhatsAppUser")
      .mockRejectedValueOnce(new Error("forced"));
    const result = await processWhatsAppInbound(envelope(sid, e164, "retomar"));
    spy.mockRestore();
    expect(result).toMatchObject({
      outcome: "retryable",
      status: "RETRYABLE",
      code: "INTERNAL_TRANSIENT",
    });
    const [stuck] = await db
      .select()
      .from(whatsappInboundMessages)
      .where(eq(whatsappInboundMessages.providerMessageId, sid));
    expect(stuck?.processingStatus).toBe("RETRYABLE");
    expect(stuck?.operationalText).toBe("retomar");

    const resumed = await processWhatsAppInbound(envelope(sid, e164, "retomar"));
    expect(resumed).toMatchObject({
      outcome: "accepted",
      status: "READY_FOR_NL",
      userId,
    });
    const [done] = await db
      .select()
      .from(whatsappInboundMessages)
      .where(eq(whatsappInboundMessages.providerMessageId, sid));
    expect(done?.processingStatus).toBe("READY_FOR_NL");
    expect(done?.operationalText).toBe("retomar");
  });

  it("row terminal continua replay/no-op", async () => {
    const sid = `SM${stamp}term`;
    sids.push(sid);
    await processWhatsAppInbound(envelope(sid, e164, "primeiro"));
    const again = await processWhatsAppInbound(envelope(sid, e164, "segundo"));
    expect(again.outcome).toBe("replay");
    expect(again.status).toBe("READY_FOR_NL");
  });
});

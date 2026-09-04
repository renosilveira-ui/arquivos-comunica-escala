import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express from "express";
import twilio from "twilio";
import { eq, inArray } from "drizzle-orm";
import {
  institutions,
  userContactChannels,
  users,
  whatsappInboundMessages,
} from "../drizzle/schema";
import { getDb } from "../server/db";
import { logger } from "../server/_core/logger";
import { processWhatsAppInbound } from "../server/integrations/whatsapp/inbound-store";
import {
  clearExpiredWhatsAppInboundPayloads,
  clearWhatsAppInboundOperationalPayload,
  isWhatsAppInboundPayloadUsable,
  readWhatsAppInboundOperationalMaterial,
  WHATSAPP_INBOUND_PAYLOAD_TTL_MS,
} from "../server/integrations/whatsapp/operational-payload";
import { twilioWhatsAppRouter } from "../server/routes/twilio-whatsapp";
import { WHATSAPP_INBOUND_PATH } from "../server/integrations/whatsapp/types";
import * as identity from "../server/integrations/whatsapp/resolve-identity";
import {
  markWhatsAppContactVerified,
  upsertUserWhatsAppContact,
} from "../server/user-contact-channels";

const AUTH = "test_twilio_auth_token_not_real";
const PUBLIC = "https://escalas-staging.onrender.com" + WHATSAPP_INBOUND_PATH;

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

function textEnvelope(sid: string, fromE164: string, text: string) {
  return {
    provider: "TWILIO" as const,
    providerMessageId: sid,
    fromE164,
    content: { kind: "TEXT" as const, text, forwarded: false },
    receivedAt: new Date(),
  };
}

function audioEnvelope(sid: string, fromE164: string, mediaUrl: string) {
  return {
    provider: "TWILIO" as const,
    providerMessageId: sid,
    fromE164,
    content: { kind: "AUDIO" as const, mediaUrl, mimeType: "audio/ogg" },
    receivedAt: new Date(),
  };
}

describe("WhatsApp inbound — payload operacional e retomada", () => {
  let db: Db;
  let institutionId: number;
  let userId: number;
  const stamp = Date.now();
  const e164 = "+5585999400001";
  const sids: string[] = [];
  const mediaUrl = "https://api.twilio.com/2010-04-01/Accounts/AC/Media/ME1";

  beforeAll(async () => {
    process.env.TWILIO_AUTH_TOKEN = AUTH;
    process.env.APP_PUBLIC_URL = "https://escalas-staging.onrender.com";
    const maybe = await getDb();
    if (!maybe) throw new Error("DB unavailable");
    db = maybe;
    const [institution] = await db.select().from(institutions).limit(1);
    if (!institution) throw new Error("seed institution missing");
    institutionId = institution.id;
    const name = `wa-payload-${stamp}`;
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

  function app() {
    const server = express();
    server.use(express.urlencoded({ extended: true }));
    server.use(WHATSAPP_INBOUND_PATH, twilioWhatsAppRouter);
    return server;
  }

  it("falha transitória após INSERT não se perde e o retry HTTP retoma", async () => {
    const sid = `SMpay${stamp}retry`;
    sids.push(sid);
    const spy = vi
      .spyOn(identity, "resolveVerifiedWhatsAppUser")
      .mockRejectedValueOnce(new Error("forced"));
    const first = await processWhatsAppInbound(
      textEnvelope(sid, e164, "material para retomar"),
    );
    spy.mockRestore();
    expect(first).toMatchObject({
      outcome: "retryable",
      status: "RETRYABLE",
      code: "INTERNAL_TRANSIENT",
    });

    const params = {
      MessageSid: sid,
      From: `whatsapp:${e164}`,
      Body: "material para retomar",
    };
    const signature = twilio.getExpectedTwilioSignature(AUTH, PUBLIC, params);
    const res = await request(app())
      .post(WHATSAPP_INBOUND_PATH)
      .set("X-Twilio-Signature", signature)
      .type("form")
      .send(params);
    expect(res.status).toBe(200);
    const material = await readWhatsAppInboundOperationalMaterial(first.id!);
    expect(material?.processingStatus).toBe("READY_FOR_NL");
    expect(material?.operationalText).toBe("material para retomar");
  });

  it("HTTP 503 em falha retryable e 200 em row terminal", async () => {
    const sid = `SMpay${stamp}http`;
    sids.push(sid);
    const spy = vi
      .spyOn(identity, "resolveVerifiedWhatsAppUser")
      .mockRejectedValueOnce(new Error("forced"));
    const params = {
      MessageSid: sid,
      From: `whatsapp:${e164}`,
      Body: "texto operacional",
    };
    const signature = twilio.getExpectedTwilioSignature(AUTH, PUBLIC, params);
    const first = await request(app())
      .post(WHATSAPP_INBOUND_PATH)
      .set("X-Twilio-Signature", signature)
      .type("form")
      .send(params);
    spy.mockRestore();
    expect(first.status).toBe(503);

    const [stuck] = await db
      .select()
      .from(whatsappInboundMessages)
      .where(eq(whatsappInboundMessages.providerMessageId, sid));
    expect(stuck?.processingStatus).toBe("RETRYABLE");

    const again = await request(app())
      .post(WHATSAPP_INBOUND_PATH)
      .set("X-Twilio-Signature", signature)
      .type("form")
      .send(params);
    expect(again.status).toBe(200);
    const [done] = await db
      .select()
      .from(whatsappInboundMessages)
      .where(eq(whatsappInboundMessages.providerMessageId, sid));
    expect(done?.processingStatus).toBe("READY_FOR_NL");

    const replay = await request(app())
      .post(WHATSAPP_INBOUND_PATH)
      .set("X-Twilio-Signature", signature)
      .type("form")
      .send(params);
    expect(replay.status).toBe(200);
    const rows = await db
      .select()
      .from(whatsappInboundMessages)
      .where(eq(whatsappInboundMessages.providerMessageId, sid));
    expect(rows).toHaveLength(1);
  });

  it("TEXT READY_FOR_NL possui material suficiente ao próximo estágio", async () => {
    const sid = `SMpay${stamp}text`;
    sids.push(sid);
    const result = await processWhatsAppInbound(
      textEnvelope(sid, e164, "trocar plantão amanhã"),
    );
    expect(result).toMatchObject({ outcome: "accepted", status: "READY_FOR_NL" });
    const material = await readWhatsAppInboundOperationalMaterial(result.id!);
    expect(material).toMatchObject({
      processingStatus: "READY_FOR_NL",
      contentKind: "TEXT",
      operationalText: "trocar plantão amanhã",
      mediaUrl: null,
    });
    expect(material?.payloadExpiresAt).toBeTruthy();
    expect(isWhatsAppInboundPayloadUsable(material!)).toBe(true);
    const remainingMs =
      material!.payloadExpiresAt!.getTime() - Date.now();
    expect(remainingMs).toBeGreaterThan(WHATSAPP_INBOUND_PAYLOAD_TTL_MS - 5_000);
    expect(remainingMs).toBeLessThanOrEqual(
      WHATSAPP_INBOUND_PAYLOAD_TTL_MS + 5_000,
    );
  });

  it("AUDIO READY_FOR_TRANSCRIPTION possui referência de mídia", async () => {
    const sid = `SMpay${stamp}audio`;
    sids.push(sid);
    const result = await processWhatsAppInbound(
      audioEnvelope(sid, e164, mediaUrl),
    );
    expect(result).toMatchObject({
      outcome: "accepted",
      status: "READY_FOR_TRANSCRIPTION",
    });
    const material = await readWhatsAppInboundOperationalMaterial(result.id!);
    expect(material).toMatchObject({
      processingStatus: "READY_FOR_TRANSCRIPTION",
      contentKind: "AUDIO",
      operationalText: null,
      mediaUrl,
      mediaMime: "audio/ogg",
    });
  });

  it("logs não contêm Body nem media URL", async () => {
    const sid = `SMpay${stamp}log`;
    sids.push(sid);
    const lines: string[] = [];
    const spy = vi.spyOn(logger, "info").mockImplementation((...args: unknown[]) => {
      lines.push(args.map((a) => String(a)).join(" "));
      return logger;
    });
    await processWhatsAppInbound(audioEnvelope(sid, e164, mediaUrl));
    spy.mockRestore();
    const joined = lines.join("\n");
    expect(joined).not.toContain(mediaUrl);
    expect(joined).not.toContain(e164);
    expect(joined).not.toContain("Accounts/AC");
  });

  it("cleanup do payload após consumo e após expiração", async () => {
    const consumeSid = `SMpay${stamp}clr`;
    const expireSid = `SMpay${stamp}exp`;
    sids.push(consumeSid, expireSid);
    const consumed = await processWhatsAppInbound(
      textEnvelope(consumeSid, e164, "consumir depois"),
    );
    expect(consumed.outcome).toBe("accepted");
    const cleared = await clearWhatsAppInboundOperationalPayload(consumed.id!);
    expect(cleared).toBe(true);
    const afterConsume = await readWhatsAppInboundOperationalMaterial(
      consumed.id!,
    );
    expect(afterConsume?.operationalText).toBeNull();
    expect(afterConsume?.mediaUrl).toBeNull();
    expect(afterConsume?.payloadClearedAt).toBeTruthy();
    expect(afterConsume?.processingStatus).toBe("READY_FOR_NL");
    expect(isWhatsAppInboundPayloadUsable(afterConsume!)).toBe(false);

    const expired = await processWhatsAppInbound(
      textEnvelope(expireSid, e164, "vai expirar"),
    );
    await db
      .update(whatsappInboundMessages)
      .set({ payloadExpiresAt: new Date(Date.now() - 1000) })
      .where(eq(whatsappInboundMessages.id, expired.id!));
    const swept = await clearExpiredWhatsAppInboundPayloads(new Date());
    expect(swept).toBeGreaterThanOrEqual(1);
    const afterExpiry = await readWhatsAppInboundOperationalMaterial(
      expired.id!,
    );
    expect(afterExpiry?.operationalText).toBeNull();
    expect(afterExpiry?.payloadClearedAt).toBeTruthy();
    expect(afterExpiry?.processingStatus).toBe("READY_FOR_NL");
    expect(isWhatsAppInboundPayloadUsable(afterExpiry!)).toBe(false);
  });

  it("clear operacional não apaga payload de row RETRYABLE", async () => {
    const sid = `SMpay${stamp}rtclr`;
    sids.push(sid);
    const spy = vi
      .spyOn(identity, "resolveVerifiedWhatsAppUser")
      .mockRejectedValueOnce(new Error("forced"));
    const stuck = await processWhatsAppInbound(
      textEnvelope(sid, e164, "não limpar ainda"),
    );
    spy.mockRestore();
    expect(stuck.status).toBe("RETRYABLE");
    const refused = await clearWhatsAppInboundOperationalPayload(stuck.id!);
    expect(refused).toBe(false);
    const material = await readWhatsAppInboundOperationalMaterial(stuck.id!);
    expect(material?.operationalText).toBe("não limpar ainda");
    expect(material?.payloadClearedAt).toBeNull();
  });
});

import express from "express";
import request from "supertest";
import twilio from "twilio";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  institutions,
  userContactChannels,
  users,
  whatsappInboundMessages,
} from "../drizzle/schema";
import { getDb } from "../server/db";
import { twilioWhatsAppRouter } from "../server/routes/twilio-whatsapp";
import { WHATSAPP_INBOUND_PATH } from "../server/integrations/whatsapp/types";
import {
  markWhatsAppContactVerified,
  upsertUserWhatsAppContact,
} from "../server/user-contact-channels";

const AUTH = "test_twilio_auth_token_not_real";
const PUBLIC = "https://escalas-staging.onrender.com" + WHATSAPP_INBOUND_PATH;

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

describe("WhatsApp webhook HTTP — accept/replay", () => {
  let db: Db;
  let institutionId: number;
  let userId: number;
  const stamp = Date.now();
  const e164 = "+5585999300001";
  const sid = `SMhttp${stamp}`;

  beforeAll(async () => {
    process.env.TWILIO_AUTH_TOKEN = AUTH;
    process.env.APP_PUBLIC_URL = "https://escalas-staging.onrender.com";
    const maybe = await getDb();
    if (!maybe) throw new Error("DB unavailable");
    db = maybe;
    const [institution] = await db.select().from(institutions).limit(1);
    if (!institution) throw new Error("seed institution missing");
    institutionId = institution.id;
    const name = `wa-http-${stamp}`;
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
    await db
      .delete(whatsappInboundMessages)
      .where(eq(whatsappInboundMessages.providerMessageId, sid));
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

  it("assinatura válida + TEXT identificado → 200 READY_FOR_NL", async () => {
    const params = {
      MessageSid: sid,
      From: `whatsapp:${e164}`,
      Body: "texto que não deve ser persistido",
    };
    const signature = twilio.getExpectedTwilioSignature(AUTH, PUBLIC, params);
    const res = await request(app())
      .post(WHATSAPP_INBOUND_PATH)
      .set("X-Twilio-Signature", signature)
      .type("form")
      .send(params);
    expect(res.status).toBe(200);
    expect(res.text).toBe("");
    const [row] = await db
      .select()
      .from(whatsappInboundMessages)
      .where(eq(whatsappInboundMessages.providerMessageId, sid));
    expect(row?.processingStatus).toBe("READY_FOR_NL");
    expect(row?.userId).toBe(userId);
    expect(JSON.stringify(row)).not.toContain(params.Body);
  });

  it("replay do mesmo MessageSid → 200 sem segunda linha", async () => {
    const params = {
      MessageSid: sid,
      From: `whatsapp:${e164}`,
      Body: "replay diferente",
    };
    const signature = twilio.getExpectedTwilioSignature(AUTH, PUBLIC, params);
    const res = await request(app())
      .post(WHATSAPP_INBOUND_PATH)
      .set("X-Twilio-Signature", signature)
      .type("form")
      .send(params);
    expect(res.status).toBe(200);
    const rows = await db
      .select()
      .from(whatsappInboundMessages)
      .where(eq(whatsappInboundMessages.providerMessageId, sid));
    expect(rows).toHaveLength(1);
  });
});

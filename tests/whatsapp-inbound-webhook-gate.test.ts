import express from "express";
import request from "supertest";
import twilio from "twilio";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WHATSAPP_INBOUND_PATH } from "../server/integrations/whatsapp/types";

const AUTH = "test_twilio_auth_token_not_real";
const PUBLIC = "https://escalas-staging.onrender.com" + WHATSAPP_INBOUND_PATH;

async function loadRouter() {
  const { twilioWhatsAppRouter } = await import(
    "../server/routes/twilio-whatsapp"
  );
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(WHATSAPP_INBOUND_PATH, twilioWhatsAppRouter);
  return app;
}

describe("WhatsApp webhook HTTP — fail-closed de porta", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("secret ausente → 503", async () => {
    vi.stubEnv("TWILIO_AUTH_TOKEN", "");
    vi.stubEnv("APP_PUBLIC_URL", "https://escalas-staging.onrender.com");
    vi.stubEnv("NODE_ENV", "test");
    const app = await loadRouter();
    const res = await request(app)
      .post(WHATSAPP_INBOUND_PATH)
      .type("form")
      .send({ MessageSid: "SMx", From: "whatsapp:+5585999999999" });
    expect(res.status).toBe(503);
    expect(res.text).toBe("");
  });

  it("URL canônica irresolvível em produção → 503", async () => {
    vi.stubEnv("TWILIO_AUTH_TOKEN", AUTH);
    vi.stubEnv("APP_PUBLIC_URL", "");
    vi.stubEnv("NODE_ENV", "production");
    const app = await loadRouter();
    const res = await request(app)
      .post(WHATSAPP_INBOUND_PATH)
      .set("X-Twilio-Signature", "abc")
      .type("form")
      .send({ MessageSid: "SMx" });
    expect(res.status).toBe(503);
  });

  it("assinatura ausente → 403", async () => {
    vi.stubEnv("TWILIO_AUTH_TOKEN", AUTH);
    vi.stubEnv("APP_PUBLIC_URL", "https://escalas-staging.onrender.com");
    vi.stubEnv("NODE_ENV", "test");
    const app = await loadRouter();
    const res = await request(app)
      .post(WHATSAPP_INBOUND_PATH)
      .type("form")
      .send({ MessageSid: "SMx", From: "whatsapp:+5585999999999" });
    expect(res.status).toBe(403);
    expect(res.text).toBe("");
  });

  it("assinatura inválida → 403", async () => {
    vi.stubEnv("TWILIO_AUTH_TOKEN", AUTH);
    vi.stubEnv("APP_PUBLIC_URL", "https://escalas-staging.onrender.com");
    vi.stubEnv("NODE_ENV", "test");
    const app = await loadRouter();
    const res = await request(app)
      .post(WHATSAPP_INBOUND_PATH)
      .set("X-Twilio-Signature", "forged")
      .type("form")
      .send({ MessageSid: "SMx", From: "whatsapp:+5585999999999" });
    expect(res.status).toBe(403);
  });

  it("assinatura válida e MessageSid ausente → 400", async () => {
    vi.stubEnv("TWILIO_AUTH_TOKEN", AUTH);
    vi.stubEnv("APP_PUBLIC_URL", "https://escalas-staging.onrender.com");
    vi.stubEnv("NODE_ENV", "test");
    const params = { From: "whatsapp:+5585999999999", Body: "oi" };
    const signature = twilio.getExpectedTwilioSignature(AUTH, PUBLIC, params);
    const app = await loadRouter();
    const res = await request(app)
      .post(WHATSAPP_INBOUND_PATH)
      .set("X-Twilio-Signature", signature)
      .type("form")
      .send(params);
    expect(res.status).toBe(400);
  });
});

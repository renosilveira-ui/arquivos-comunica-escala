import { describe, expect, it } from "vitest";
import twilio from "twilio";
import { resolveTwilioWhatsAppCanonicalUrl } from "../server/integrations/whatsapp/canonical-url";
import {
  stripWhatsAppChannelPrefix,
  whatsappFromToE164,
} from "../server/integrations/whatsapp/from-address";
import { TwilioWhatsAppProvider } from "../server/integrations/whatsapp/twilio-provider";
import { WHATSAPP_INBOUND_PATH } from "../server/integrations/whatsapp/types";

const AUTH = "test_twilio_auth_token_not_real";
const PUBLIC =
  "https://escalas-staging.onrender.com" + WHATSAPP_INBOUND_PATH;
const provider = new TwilioWhatsAppProvider();

function signed(params: Record<string, string>, url = PUBLIC) {
  return twilio.getExpectedTwilioSignature(AUTH, url, params);
}

describe("WhatsApp Twilio provider — assinatura e envelope", () => {
  it("assinatura válida na URL pública esperada", () => {
    const params = { MessageSid: "SMvalid1", From: "whatsapp:+5585999999999" };
    expect(
      provider.validateInboundRequest({
        signature: signed(params),
        authToken: AUTH,
        canonicalUrl: PUBLIC,
        params,
      }),
    ).toBe(true);
  });

  it("assinatura ausente é rejeitada", () => {
    expect(
      provider.validateInboundRequest({
        signature: undefined,
        authToken: AUTH,
        canonicalUrl: PUBLIC,
        params: { MessageSid: "SMmissing" },
      }),
    ).toBe(false);
  });

  it("assinatura inválida é rejeitada", () => {
    expect(
      provider.validateInboundRequest({
        signature: "not-a-real-signature",
        authToken: AUTH,
        canonicalUrl: PUBLIC,
        params: { MessageSid: "SMinvalid" },
      }),
    ).toBe(false);
  });

  it("URL canônica de staging é HTTPS pública, sem Host da request", () => {
    const resolved = resolveTwilioWhatsAppCanonicalUrl({
      NODE_ENV: "production",
      APP_PUBLIC_URL: "https://escalas-staging.onrender.com",
    });
    expect(resolved).toEqual({ ok: true, url: PUBLIC });
  });

  it("produção sem APP_PUBLIC_URL falha fechado", () => {
    expect(
      resolveTwilioWhatsAppCanonicalUrl({ NODE_ENV: "production" }),
    ).toEqual({
      ok: false,
      code: "TWILIO_SIGNATURE_CANONICAL_URL_UNRESOLVED",
    });
  });

  it("produção com Host local em APP_PUBLIC_URL falha fechado", () => {
    expect(
      resolveTwilioWhatsAppCanonicalUrl({
        NODE_ENV: "production",
        APP_PUBLIC_URL: "https://localhost:8081",
      }),
    ).toEqual({
      ok: false,
      code: "TWILIO_SIGNATURE_CANONICAL_URL_UNRESOLVED",
    });
  });

  it("TEXT classifica Body sem mídia", () => {
    const parsed = provider.parseInboundEnvelope({
      MessageSid: "SMtext1",
      From: "whatsapp:+5585999999999",
      Body: "trocar plantão",
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.envelope.content).toEqual({
      kind: "TEXT",
      text: "trocar plantão",
      forwarded: false,
    });
  });

  it("Forwarded=true permanece TEXT com metadata", () => {
    const parsed = provider.parseInboundEnvelope({
      MessageSid: "SMfwd1",
      From: "whatsapp:+5585999999999",
      Body: "Débora, pode ir por mim dia 10?",
      Forwarded: "true",
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.envelope.content).toMatchObject({
      kind: "TEXT",
      forwarded: true,
    });
  });

  it("áudio sem MediaUrl0 vira UNSUPPORTED_MEDIA", () => {
    const parsed = provider.parseInboundEnvelope({
      MessageSid: "SMnoaudio",
      From: "whatsapp:+5585999999999",
      NumMedia: "1",
      MediaContentType0: "audio/ogg",
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.envelope.content.kind).toBe("UNSUPPORTED_MEDIA");
  });

  it("Body vazio continua TEXT sem inventar conteúdo", () => {
    const parsed = provider.parseInboundEnvelope({
      MessageSid: "SMempty",
      From: "whatsapp:+5585999999999",
      Body: "",
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.envelope.content).toEqual({
      kind: "TEXT",
      text: "",
      forwarded: false,
    });
  });

  it("AUDIO classifica mídia audio/* sem transcrever", () => {
    const parsed = provider.parseInboundEnvelope({
      MessageSid: "SMaudio1",
      From: "whatsapp:+5585999999999",
      NumMedia: "1",
      MediaContentType0: "audio/ogg",
      MediaUrl0: "https://api.twilio.com/media/example",
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.envelope.content.kind).toBe("AUDIO");
  });

  it("imagem/PDF é UNSUPPORTED_MEDIA", () => {
    const parsed = provider.parseInboundEnvelope({
      MessageSid: "SMimg1",
      From: "whatsapp:+5585999999999",
      NumMedia: "1",
      MediaContentType0: "image/jpeg",
      MediaUrl0: "https://api.twilio.com/media/photo",
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.envelope.content).toEqual({
      kind: "UNSUPPORTED_MEDIA",
      mimeType: "image/jpeg",
    });
  });

  it("From whatsapp:+E.164 vira E.164 canônico", () => {
    expect(stripWhatsAppChannelPrefix("whatsapp:+5585999999999")).toBe(
      "+5585999999999",
    );
    expect(whatsappFromToE164("whatsapp:+5585999999999")).toBe(
      "+5585999999999",
    );
  });

  it("From sem prefixo whatsapp: não é aceito", () => {
    expect(whatsappFromToE164("+5585999999999")).toBeNull();
    expect(whatsappFromToE164("sms:+5585999999999")).toBeNull();
  });

  it("MessageSid ausente falha fechado", () => {
    expect(
      provider.parseInboundEnvelope({
        From: "whatsapp:+5585999999999",
        Body: "oi",
      }),
    ).toEqual({ ok: false, code: "TWILIO_MESSAGE_SID_MISSING" });
  });

  it("payload malformado (From inválido) falha fechado", () => {
    expect(
      provider.parseInboundEnvelope({
        MessageSid: "SMbadfrom",
        From: "whatsapp:abc",
      }),
    ).toEqual({ ok: false, code: "TWILIO_FROM_INVALID" });
  });

  it("assinatura de outra URL não vale para a URL canônica", () => {
    const params = { MessageSid: "SMurl", From: "whatsapp:+5585999999999" };
    const forged = signed(params, "https://evil.example/api/integrations/twilio/whatsapp");
    expect(
      provider.validateInboundRequest({
        signature: forged,
        authToken: AUTH,
        canonicalUrl: PUBLIC,
        params,
      }),
    ).toBe(false);
  });
});

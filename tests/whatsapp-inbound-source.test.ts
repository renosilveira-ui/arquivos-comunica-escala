import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const store = readFileSync(
  new URL("../server/integrations/whatsapp/inbound-store.ts", import.meta.url),
  "utf8",
);
const identity = readFileSync(
  new URL("../server/integrations/whatsapp/resolve-identity.ts", import.meta.url),
  "utf8",
);
const provider = readFileSync(
  new URL("../server/integrations/whatsapp/twilio-provider.ts", import.meta.url),
  "utf8",
);
const router = readFileSync(
  new URL("../server/routes/twilio-whatsapp.ts", import.meta.url),
  "utf8",
);
const boot = readFileSync(
  new URL("../server/_core/index.ts", import.meta.url),
  "utf8",
);
const schema = readFileSync(
  new URL("../drizzle/schema.ts", import.meta.url),
  "utf8",
);

describe("WhatsApp inbound — source contracts", () => {
  it("não materializa troca/cessão nem chama o NL", () => {
    for (const src of [store, identity, provider, router]) {
      expect(src).not.toMatch(/createSwapOffer/);
      expect(src).not.toMatch(/natural-language/);
      expect(src).not.toMatch(/parseSwapIntent|resolveSwapIntent/);
    }
  });

  it("provider Twilio não resolve usuário nem consulta escala", () => {
    expect(provider).not.toMatch(/user_contact_channels|userContactChannels/);
    expect(provider).not.toMatch(/shiftInstances|createSwapOffer/);
    expect(provider).toContain("validateRequest");
  });

  it("identidade reutiliza user_contact_channels e E.164", () => {
    expect(identity).toContain("userContactChannels");
    expect(identity).toContain("WHATSAPP_CHANNEL");
    expect(identity).toContain("decideVerifiedWhatsAppIdentity");
    expect(identity).toContain("limit(2)");
  });

  it("formParams serializa números para a assinatura Twilio", () => {
    expect(router).toContain("typeof value === \"number\"");
    expect(router).toContain("params[key] = String(value)");
  });

  it("boot monta POST /api/integrations/twilio/whatsapp", () => {
    expect(boot).toContain('"/api/integrations/twilio/whatsapp"');
    expect(boot).toContain("twilioWhatsAppRouter");
  });

  it("schema não persiste Body, signature nem telefone", () => {
    const start = schema.indexOf("export const whatsappInboundMessages");
    const end = schema.indexOf("export type WhatsappInboundMessage");
    const inboundBlock = schema.slice(start, end);
    expect(inboundBlock).toContain("providerMessageId");
    expect(inboundBlock).toContain('mysqlEnum("provider"');
    expect(inboundBlock).toContain('mysqlEnum("content_kind"');
    expect(inboundBlock).toContain('mysqlEnum("processing_status"');
    expect(inboundBlock).toContain("senderAddressHash");
    expect(inboundBlock).not.toMatch(/\bbody\b/i);
    expect(inboundBlock).not.toMatch(/signature/i);
    expect(inboundBlock).not.toMatch(/normalizedAddress|fromE164|phone/i);
    expect(inboundBlock).not.toMatch(/rawPayload|mediaUrl/i);
  });

  it("não há pending intents sem contrato nesta PR", () => {
    expect(schema).not.toContain("whatsappPendingIntents");
    expect(schema).not.toContain("whatsapp_pending_intents");
  });
});

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
const formParams = readFileSync(
  new URL(
    "../server/integrations/whatsapp/inbound-form-params.ts",
    import.meta.url,
  ),
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
const contract = readFileSync(
  new URL(
    "../docs/CONTRACT_WHATSAPP_CONVERSATIONAL_OPERATIONS_V1.md",
    import.meta.url,
  ),
  "utf8",
);
const payload = readFileSync(
  new URL(
    "../server/integrations/whatsapp/operational-payload.ts",
    import.meta.url,
  ),
  "utf8",
);

describe("WhatsApp inbound — source contracts", () => {
  it("não baixa mídia nem chama HTTP a partir do inbound", () => {
    for (const src of [store, identity, provider, router, payload, formParams]) {
      expect(src).not.toMatch(/\bfetch\s*\(/);
      expect(src).not.toMatch(/\baxios\b/);
      expect(src).not.toMatch(/http\.get|https\.get/);
      expect(src).not.toMatch(/createSwapOffer/);
    }
  });

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

  it("formParams serializa números e recusa chaves injetáveis", () => {
    expect(router).toContain("formParamsFromBody");
    expect(formParams).toContain("typeof value === \"number\"");
    expect(formParams).toContain("params[key] = String(value)");
    expect(formParams).toContain("isTwilioInboundFormKey");
    expect(formParams).toContain("constructor");
    expect(formParams).toContain("prototype");
    expect(formParams).toMatch(/A-Za-z0-9/);
  });

  it("boot monta POST /api/integrations/twilio/whatsapp", () => {
    expect(boot).toContain('"/api/integrations/twilio/whatsapp"');
    expect(boot).toContain("twilioWhatsAppRouter");
  });

  it("schema persiste payload operacional temporário sem dump Twilio", () => {
    const start = schema.indexOf("export const whatsappInboundMessages");
    const end = schema.indexOf("export type WhatsappInboundMessage");
    const inboundBlock = schema.slice(start, end);
    expect(inboundBlock).toContain("providerMessageId");
    expect(inboundBlock).toContain('mysqlEnum("provider"');
    expect(inboundBlock).toContain('mysqlEnum("content_kind"');
    expect(inboundBlock).toContain('mysqlEnum("processing_status"');
    expect(inboundBlock).toContain("RETRYABLE");
    expect(inboundBlock).toContain("senderAddressHash");
    expect(inboundBlock).toContain("operationalText");
    expect(inboundBlock).toContain("mediaUrl");
    expect(inboundBlock).toContain("payloadExpiresAt");
    expect(inboundBlock).toContain("payloadClearedAt");
    expect(inboundBlock).not.toMatch(/\bbody\b/i);
    expect(inboundBlock).not.toMatch(/signature/i);
    expect(inboundBlock).not.toMatch(/normalizedAddress|fromE164|phone/i);
    expect(inboundBlock).not.toMatch(/rawPayload|authToken/i);
  });

  it("não há pending intents sem contrato nesta PR", () => {
    expect(schema).not.toContain("whatsappPendingIntents");
    expect(schema).not.toContain("whatsapp_pending_intents");
  });

  it("identidade não converte DB indisponível em IDENTITY_NOT_FOUND", () => {
    expect(identity).toContain('code: "DB_UNAVAILABLE"');
    expect(identity).toContain('code: "IDENTITY_QUERY_FAILED"');
    expect(identity).not.toMatch(
      /if\s*\(\s*!db\s*\)\s*return\s*\{\s*ok:\s*false,\s*code:\s*"IDENTITY_NOT_FOUND"/,
    );
  });

  it("fila incompleta retoma; terminal faz replay; HTTP retryable é 503", () => {
    expect(store).toContain("RETRYABLE");
    expect(store).toContain("isWhatsAppInboundIncompleteStatus");
    expect(store).toContain("isWhatsAppInboundTerminalStatus");
    expect(store).not.toMatch(/WhatsAppInboundStatuses\.FAILED/);
    expect(router).toContain('result.outcome === "retryable"');
    expect(router).toContain("empty(res, 503)");
  });

  it("contrato define READY_FOR_* como material persistido e retenção curta", () => {
    expect(contract).toContain(
      "há material persistido suficiente para o próximo estágio",
    );
    expect(contract).toContain("clearWhatsAppInboundOperationalPayload");
    expect(contract).toContain("WHATSAPP_INBOUND_PAYLOAD_TTL_MS");
    expect(payload).toContain("clearWhatsAppInboundOperationalPayload");
    expect(payload).toContain("clearExpiredWhatsAppInboundPayloads");
    expect(payload).toContain("isWhatsAppInboundPayloadUsable");
    expect(payload).toContain("READY_FOR_NL");
    expect(payload).toContain("READY_FOR_TRANSCRIPTION");
    expect(payload).not.toMatch(/logger\.(info|warn|error)/);
    expect(payload).toContain("clearExpiredWhatsAppInboundPayloads");
    expect(contract).toContain("independentemente");
  });
});

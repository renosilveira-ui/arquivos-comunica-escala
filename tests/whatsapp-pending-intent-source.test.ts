import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const store = readFileSync(
  new URL(
    "../server/integrations/whatsapp/pending-intent-store.ts",
    import.meta.url,
  ),
  "utf8",
);
const types = readFileSync(
  new URL(
    "../server/integrations/whatsapp/pending-intent-types.ts",
    import.meta.url,
  ),
  "utf8",
);
const payload = readFileSync(
  new URL("../server/integrations/whatsapp/pending-payload.ts", import.meta.url),
  "utf8",
);
const inboundStore = readFileSync(
  new URL("../server/integrations/whatsapp/inbound-store.ts", import.meta.url),
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

function pendingSchemaBlock(): string {
  const start = schema.indexOf("export const whatsappPendingIntents");
  const end = schema.indexOf("export type WhatsappPendingIntent");
  return schema.slice(start, end);
}

describe("WhatsApp pending intent — source contracts", () => {
  it("B1 não importa parser NL, createSwapOffer nem Twilio SDK", () => {
    for (const src of [store, types, payload]) {
      expect(src).not.toMatch(/from ["'][^"']*natural-language/);
      expect(src).not.toMatch(/parseSwapIntent|resolveSwapIntent/);
      expect(src).not.toMatch(/from ["'][^"']*createSwapOffer|import\s+.*createSwapOffer/);
      expect(src).not.toMatch(/from ["']twilio["']|require\(["']twilio["']\)/);
      expect(src).not.toMatch(/twilio-provider|MessagingResponse/);
    }
  });

  it("inbound continua parando em READY_FOR_NL sem criar pending", () => {
    expect(inboundStore).not.toMatch(/pending-intent-store/);
    expect(inboundStore).not.toMatch(/createWhatsAppPendingIntent/);
    expect(inboundStore).not.toMatch(/whatsappPendingIntents/);
    expect(inboundStore).toContain("READY_FOR_NL");
  });

  it("schema não persiste telefone, Body Twilio, signature ou token", () => {
    const block = pendingSchemaBlock();
    expect(block).toContain("sourceInboundMessageId");
    expect(block).toContain("openSlot");
    expect(block).toContain("parsedPayload");
    expect(block).toContain("resolvedPayload");
    expect(block).not.toMatch(/phone|e164|fromE164|normalizedAddress/i);
    expect(block).not.toMatch(/\bbody\b/i);
    expect(block).not.toMatch(/signature|authToken|publicToken/i);
    expect(block).not.toMatch(/providerMessageId/);
  });

  it("create nunca lê institutionId livre do caller", () => {
    expect(store).toContain("institutionId: null");
    expect(store).not.toMatch(/input\.institutionId/);
    expect(store).not.toMatch(/institutionId:\s*input/);
    expect(types).not.toMatch(/institutionId\?:/);
  });

  it("contrato documenta status+stage e um OPEN por usuário", () => {
    expect(contract).toContain("whatsapp_pending_intents");
    expect(contract).toContain("WHATSAPP_PENDING_INTENT_TTL_MS");
    expect(contract).toContain("uniq_whatsapp_pending_open_user");
    expect(contract).toContain("status + stage");
    expect(store).toContain("clearExpiredWhatsAppPendingIntents");
    expect(store).not.toMatch(/confirmAndExecute|markConsumed/);
  });

  it("logs técnicos usam JSON.stringify sem texto/telefone", () => {
    expect(store).toContain("logger.info(JSON.stringify(payload))");
    expect(store).toContain("pendingId");
    expect(store).toContain("sourceInboundId");
    const logFields = store.slice(
      store.indexOf("function technicalLogFields"),
      store.indexOf("function clearedConversationPayload"),
    );
    expect(logFields).not.toMatch(/operationalText|fromE164|parsedPayload/);
  });
});

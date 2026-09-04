import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  WHATSAPP_PENDING_INTENT_TTL_MS,
  pendingExpiresAtFrom,
} from "../server/integrations/whatsapp/pending-intent-types";

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

function createInputTypeBlock(): string {
  const start = types.indexOf("export type CreateWhatsAppPendingIntentInput");
  const end = types.indexOf("export type WhatsAppPendingIntentRecord");
  return types.slice(start, end);
}

describe("WhatsApp pending intent — source contracts", () => {
  it("B1 não importa parser NL, createSwapOffer nem Twilio SDK", () => {
    for (const src of [store, types]) {
      expect(src).not.toMatch(/from ["'][^"']*natural-language/);
      expect(src).not.toMatch(/parseSwapIntent|resolveSwapIntent/);
      expect(src).not.toMatch(/from ["'][^"']*createSwapOffer|import\s+.*createSwapOffer/);
      expect(src).not.toMatch(/from ["']twilio["']|require\(["']twilio["']\)/);
      expect(src).not.toMatch(/twilio-provider|MessagingResponse/);
    }
    expect(store).not.toMatch(/pending-payload|assertSemanticParsedPayload/);
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

  it("create B1 aceita só sourceInboundMessageId", () => {
    const createType = createInputTypeBlock();
    expect(createType).toContain("sourceInboundMessageId: number");
    expect(createType).not.toMatch(/userId|intentKind|parsedPayload|institutionId/);
    expect(store).not.toMatch(/input\.userId|input\.intentKind|input\.parsedPayload|input\.institutionId/);
    expect(store).toContain("emptyFoundationInsert");
    expect(store).toContain("intentKind: null");
    expect(store).toContain("parsedPayload: null");
    expect(store).toContain("institutionId: null");
    expect(store).toContain("SOURCE_INBOUND_IDENTITY_MISSING");
    expect(store).not.toMatch(/SOURCE_OWNERSHIP_MISMATCH|PARSED_PAYLOAD_INVALID/);
    expect(types).not.toMatch(/SOURCE_OWNERSHIP_MISMATCH|PARSED_PAYLOAD_INVALID/);
  });

  it("contrato documenta status+stage e um OPEN por usuário", () => {
    expect(contract).toContain("whatsapp_pending_intents");
    expect(contract).toContain("WHATSAPP_PENDING_INTENT_TTL_MS");
    expect(contract).toContain("uniq_whatsapp_pending_open_user");
    expect(contract).toContain("status + stage");
    expect(contract).toContain("sourceInboundMessageId");
    expect(contract).toContain("WhatsAppPendingReadResult");
    expect(contract).toContain('ok: false, code: "DB_UNAVAILABLE"');
    expect(contract).toContain("payloadsCleared = expired + leftovers");
    expect(store).toContain("clearExpiredWhatsAppPendingIntents");
    expect(store).toContain("whatsapp_pending_cleanup_failed");
    expect(store).not.toMatch(/confirmAndExecute|markConsumed/);
  });

  it("reads públicos não colapsam DB indisponível em null", () => {
    expect(types).toContain("WhatsAppPendingReadResult");
    expect(types).toContain("isWhatsAppPendingReadFailure");
    expect(store).toContain("readWithDb");
    expect(store).not.toMatch(/if\s*\(\s*!db\s*\)\s*return\s*null/);
    expect(store).not.toMatch(
      /if\s*\(\s*!db\s*\)[\s\S]{0,160}?return\s*null\s*;/,
    );
    const names = [
      "getWhatsAppPendingIntentByIdForUser",
      "getWhatsAppPendingIntentBySourceForUser",
      "getOpenWhatsAppPendingIntentForUser",
    ];
    for (const name of names) {
      const start = store.indexOf(`export async function ${name}`);
      expect(start).toBeGreaterThan(-1);
      const next = store.indexOf("export async function", start + 1);
      const body = store.slice(start, next);
      expect(body).toContain("Promise<WhatsAppPendingReadResult>");
      expect(body).toContain("readWithDb");
      expect(body).not.toMatch(/if\s*\(\s*!db\s*\)\s*return\s*null/);
      expect(body).not.toMatch(
        /if\s*\(\s*!db\s*\)[\s\S]{0,160}?return\s*null\s*;/,
      );
    }
  });

  it("primitives públicas não colapsam outage em null nem zero de cleanup", () => {
    expect(types).toContain("WhatsAppPendingCleanupResult");
    expect(types).toContain("isWhatsAppPendingCleanupFailure");
    expect(store).toContain("acquireDb");
    expect(store).not.toMatch(/if\s*\(\s*!db\s*\)\s*return\s*null/);
    expect(store).not.toMatch(
      /if\s*\(\s*!db\s*\)[\s\S]{0,160}?return\s*\{\s*expired\s*:\s*0/,
    );
    expect(store).not.toMatch(
      /if\s*\(\s*!db\s*\)[\s\S]{0,80}?return\s*\{\s*expired:\s*0,\s*payloadsCleared:\s*0/,
    );
    const cleanupStart = store.indexOf(
      "export async function clearExpiredWhatsAppPendingIntents",
    );
    const cleanup = store.slice(cleanupStart);
    expect(cleanup).toContain('ok: true');
    expect(cleanup).toContain('persistenceFailed("cleanup")');
    expect(cleanup).not.toMatch(/return\s*\{\s*expired:\s*0/);
    expect(store).toContain("whatsapp_pending_cleanup_failed");
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

  it("TTL conversacional é 15 minutos, distinto do inbound de 24h", () => {
    expect(WHATSAPP_PENDING_INTENT_TTL_MS).toBe(15 * 60 * 1000);
    const now = new Date("2026-09-04T12:00:00.000Z");
    expect(pendingExpiresAtFrom(now).toISOString()).toBe(
      "2026-09-04T12:15:00.000Z",
    );
  });
});

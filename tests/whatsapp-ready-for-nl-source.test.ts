import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ProcessWhatsAppReadyForNlInboundInput } from "../server/integrations/whatsapp/ready-for-nl-types";

const consumer = readFileSync(
  new URL(
    "../server/integrations/whatsapp/ready-for-nl-consumer.ts",
    import.meta.url,
  ),
  "utf8",
);
const source = readFileSync(
  new URL(
    "../server/integrations/whatsapp/ready-for-nl-source.ts",
    import.meta.url,
  ),
  "utf8",
);
const homonym = readFileSync(
  new URL(
    "../server/integrations/whatsapp/ready-for-nl-homonym-projection.ts",
    import.meta.url,
  ),
  "utf8",
);
const types = readFileSync(
  new URL(
    "../server/integrations/whatsapp/ready-for-nl-types.ts",
    import.meta.url,
  ),
  "utf8",
);
const route = readFileSync(
  new URL("../server/routes/twilio-whatsapp.ts", import.meta.url),
  "utf8",
);
const inboundStore = readFileSync(
  new URL("../server/integrations/whatsapp/inbound-store.ts", import.meta.url),
  "utf8",
);
const contract = readFileSync(
  new URL(
    "../docs/CONTRACT_WHATSAPP_CONVERSATIONAL_OPERATIONS_V1.md",
    import.meta.url,
  ),
  "utf8",
);
const schema = readFileSync(
  new URL("../drizzle/schema.ts", import.meta.url),
  "utf8",
);

const production = [consumer, source, homonym, types];

function assertOnlySourceId(value: ProcessWhatsAppReadyForNlInboundInput): void {
  const keys = Object.keys(value).sort();
  expect(keys).toEqual(["sourceInboundMessageId"]);
}

describe("WhatsApp B2-C READY_FOR_NL — source guards", () => {
  it("input público aceita só sourceInboundMessageId", () => {
    assertOnlySourceId({ sourceInboundMessageId: 1 });
    const inputBlock = types.slice(
      types.indexOf("export type ProcessWhatsAppReadyForNlInboundInput"),
      types.indexOf("export type ProcessWhatsAppReadyForNlInboundResult"),
    );
    expect(inputBlock).toContain("sourceInboundMessageId: number");
    expect(inputBlock).not.toMatch(
      /userId|professionalId|institutionId|operationalText|phone|intentKind|parsed/,
    );
    expect(consumer).toContain(
      "export async function processWhatsAppReadyForNlInbound",
    );
    expect(consumer).toContain("input.sourceInboundMessageId");
    expect(consumer).not.toMatch(/input\.userId|input\.professionalId|input\.institutionId/);
    expect(consumer).not.toMatch(/input\.phone|input\.intentKind/);
  });

  it("produção não chama createSwapOffer, push, Twilio outbound, Verify, transcrição ou mobile", () => {
    for (const src of production) {
      expect(src).not.toMatch(/from ["'][^"']*swap-offer-create/);
      expect(src).not.toMatch(/import[\s\S]{0,160}createSwapOffer/);
      expect(src).not.toMatch(/toCreateSwapOfferInput/);
      expect(src).not.toMatch(/from ["']twilio["']/);
      expect(src).not.toMatch(/twilio-provider|MessagingResponse|twilioWhatsAppRouter/);
      expect(src).not.toMatch(/expo-notifications|expo-server-sdk|getExpo/);
      expect(src).not.toMatch(/from ["'][^"']*twilio-verify|TWILIO_VERIFY/);
      expect(src).not.toMatch(/transcribeAudio|whisper|speech-to-text/);
      expect(src).not.toMatch(/from ["'][^"']*app\//);
      expect(src).not.toMatch(/from ["'][^"']*components\//);
    }
    expect(consumer).not.toMatch(/from ["'][^"']*routes\/twilio-whatsapp/);
  });

  it("webhook e inbound store não invocam o consumer NL", () => {
    expect(route).not.toMatch(/ready-for-nl-consumer|processWhatsAppReadyForNlInbound/);
    expect(inboundStore).not.toMatch(/ready-for-nl-consumer|processWhatsAppReadyForNlInbound/);
    expect(route).toContain("processWhatsAppInbound");
    expect(consumer).toContain("Não é route HTTP nem worker");
  });

  it("usa B1, B2-A, B2-B e o núcleo NL sem regra de canal", () => {
    expect(consumer).toContain("createWhatsAppPendingIntent");
    expect(consumer).toContain("advanceWhatsAppPendingFromParse");
    expect(consumer).toContain("classifySwapIntentErrorForConversation");
    expect(consumer).toContain("resolveCanonicalOperationalActorForUser");
    expect(consumer).toContain("parseSwapIntent");
    expect(consumer).toContain("resolveSwapIntent");
    expect(consumer).toMatch(/parseSwapIntent\(input\.text\)/);
    expect(consumer).not.toMatch(/parseSwapIntent\([^)]*WHATSAPP/);
    expect(consumer).not.toMatch(/source:\s*["']WHATSAPP["']/);
    expect(consumer).not.toMatch(/if\s*\(\s*source\s*===\s*["']WHATSAPP["']/);
    expect(consumer).toContain("resolveSwapIntent(parsed, actor.actor)");
    expect(consumer).not.toMatch(/institutionIds:\s*\[[^\]]*\.slice\(0,\s*1\)/);
  });

  it("cleanup do inbound só depois da transição durável", () => {
    expect(consumer).toContain("clearWhatsAppInboundOperationalPayload");
    expect(consumer).toContain("cleanupAfterDurable");
    expect(consumer).toContain("isDurableNlPending");
    const clearIndex = consumer.indexOf(
      "clearWhatsAppInboundOperationalPayload",
    );
    const advanceIndex = consumer.indexOf("advanceWhatsAppPendingFromParse({");
    expect(advanceIndex).toBeGreaterThan(-1);
    expect(clearIndex).toBeGreaterThan(-1);
    expect(consumer).toContain("CLEANUP_FAILED");
    expect(consumer).toContain("kind: \"REPLAY\"");
  });

  it("schema WhatsApp inbound/pending não muda nesta frente", () => {
    expect(schema).toContain("whatsappInboundMessages");
    expect(schema).toContain("whatsappPendingIntents");
    expect(consumer).not.toMatch(/alter table|CREATE TABLE|drizzle\/migrations/i);
    expect(source).not.toMatch(/\.insert\s*\(|\.update\s*\(|\.delete\s*\(/);
  });

  it("contrato registra B2-C como orquestrador sem execução nem outbound", () => {
    expect(contract).toContain("processWhatsAppReadyForNlInbound");
    expect(contract).toContain("READY_FOR_NL");
    expect(contract).toContain("OPEN/CLARIFICATION");
    expect(contract).toContain("OPEN/CONFIRMATION");
    expect(contract).toContain("sem execução");
    expect(contract).toContain("sem outbound");
    expect(contract).toContain("não é worker");
    expect(contract).toContain("replay não reparsa");
    expect(contract).toContain("cleanup somente pós-durabilidade");
  });
});

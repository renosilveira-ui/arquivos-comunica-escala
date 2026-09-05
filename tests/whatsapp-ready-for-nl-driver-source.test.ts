import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ENV } from "../server/_core/env";
import {
  startWhatsAppNlDriver,
  isWhatsAppNlDriverLoopRunning,
} from "../server/integrations/whatsapp/ready-for-nl-driver";

const driver = readFileSync(
  new URL(
    "../server/integrations/whatsapp/ready-for-nl-driver.ts",
    import.meta.url,
  ),
  "utf8",
);
const occupancy = readFileSync(
  new URL(
    "../server/integrations/whatsapp/ready-for-nl-driver-occupancy.ts",
    import.meta.url,
  ),
  "utf8",
);
const boot = readFileSync(
  new URL("../server/_core/index.ts", import.meta.url),
  "utf8",
);
const envSrc = readFileSync(
  new URL("../server/_core/env.ts", import.meta.url),
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
const consumer = readFileSync(
  new URL(
    "../server/integrations/whatsapp/ready-for-nl-consumer.ts",
    import.meta.url,
  ),
  "utf8",
);

const production = [driver, occupancy];

describe("WhatsApp B2-D — source guards", () => {
  it("driver só chama processWhatsAppReadyForNlInbound e não replica parser/resolver", () => {
    expect(driver).toContain("processWhatsAppReadyForNlInbound");
    expect(driver).toContain("sourceInboundMessageId: work.id");
    expect(driver).not.toMatch(/parseSwapIntent|resolveSwapIntent/);
    expect(driver).not.toMatch(/resolveCanonicalOperationalActorForUser/);
    expect(driver).not.toMatch(/createWhatsAppPendingIntent/);
    expect(driver).not.toMatch(/advanceWhatsAppPendingFromParse/);
    expect(driver).not.toMatch(/serializeParsedSwapIntentV1|serializeResolvedSwapIntentV1/);
    expect(occupancy).not.toMatch(/parseSwapIntent|resolveSwapIntent/);
  });

  it("produção não chama createSwapOffer, push, Twilio outbound, transcrição ou mobile", () => {
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
      expect(src).not.toMatch(/sendWhatsApp|twilio\.messages|sendPush/);
    }
  });

  it("webhook não espera B2-C; ACK não depende de NL", () => {
    expect(route).not.toMatch(/ready-for-nl-driver|runWhatsAppNlDriverTick/);
    expect(route).not.toMatch(/ready-for-nl-consumer|processWhatsAppReadyForNlInbound/);
    expect(inboundStore).not.toMatch(/ready-for-nl-driver|runWhatsAppNlDriverTick/);
    expect(inboundStore).not.toMatch(/ready-for-nl-consumer|processWhatsAppReadyForNlInbound/);
    expect(route).toContain("processWhatsAppInbound");
    expect(route).toContain("empty(res, 200)");
  });

  it("bootstrap inicia o driver depois do listen, sem side-effect de import, e para no shutdown", () => {
    expect(boot).toContain("startWhatsAppNlDriver");
    expect(boot).toContain("stopWhatsAppNlDriver");
    expect(boot).toContain("startConfirmationCron();");
    const listenIdx = boot.indexOf('server.listen(port, "0.0.0.0"');
    const startIdx = boot.indexOf("startWhatsAppNlDriver();");
    const stopIdx = boot.indexOf("stopWhatsAppNlDriver();");
    expect(listenIdx).toBeGreaterThan(-1);
    expect(startIdx).toBeGreaterThan(listenIdx);
    expect(boot).toContain("onBeforeExit");
    expect(stopIdx).toBeGreaterThan(boot.indexOf("onBeforeExit"));
    expect(driver).toContain('ENV.nodeEnv === "test"');
    expect(driver).toContain("isWhatsAppNlDriverEnabled");
    expect(envSrc).toContain(
      'getEnvOrDefault("WHATSAPP_NL_DRIVER_ENABLED", "false") === "true"',
    );
    expect(envSrc).not.toMatch(/WHATSAPP_NL_DRIVER_ENABLED[\s\S]{0,80}=== "1"/);
    expect(isWhatsAppNlDriverLoopRunning()).toBe(false);
    startWhatsAppNlDriver();
    expect(isWhatsAppNlDriverLoopRunning()).toBe(false);
  });

  it("WHATSAPP_NL_DRIVER_ENABLED é server-only, default OFF, parse estrito", () => {
    const previous = process.env.WHATSAPP_NL_DRIVER_ENABLED;
    try {
      delete process.env.WHATSAPP_NL_DRIVER_ENABLED;
      expect(ENV.whatsappNlDriverEnabled).toBe(false);
      process.env.WHATSAPP_NL_DRIVER_ENABLED = "false";
      expect(ENV.whatsappNlDriverEnabled).toBe(false);
      process.env.WHATSAPP_NL_DRIVER_ENABLED = "";
      expect(ENV.whatsappNlDriverEnabled).toBe(false);
      process.env.WHATSAPP_NL_DRIVER_ENABLED = "TRUE";
      expect(ENV.whatsappNlDriverEnabled).toBe(false);
      process.env.WHATSAPP_NL_DRIVER_ENABLED = "1";
      expect(ENV.whatsappNlDriverEnabled).toBe(false);
      process.env.WHATSAPP_NL_DRIVER_ENABLED = "true";
      expect(ENV.whatsappNlDriverEnabled).toBe(true);
    } finally {
      if (previous === undefined) {
        delete process.env.WHATSAPP_NL_DRIVER_ENABLED;
      } else {
        process.env.WHATSAPP_NL_DRIVER_ENABLED = previous;
      }
    }
  });

  it("claim é transacional com SKIP LOCKED; WAIT reentra; fence usa token", () => {
    expect(driver).toContain('for("update", { skipLocked: true })');
    expect(driver).toContain("WHATSAPP_NL_DRIVER_CLAIMED");
    expect(driver).toContain("WHATSAPP_NL_DRIVER_WAIT_LIKE");
    expect(driver).toContain("eq(whatsappInboundMessages.errorCode, work.claimCode)");
    expect(driver).toContain("listWhatsAppReadyForNlEligibleIds");
    expect(driver).toContain("applyWhatsAppNlDriverDecision");
    expect(driver).toContain("loopStarted");
    expect(driver).toContain("WHATSAPP_NL_DRIVER_BATCH_SIZE");
    expect(driver).toContain(".limit(batchSize)");
    expect(driver).toContain("receivedAt");
    expect(driver).not.toMatch(/let running = false/);
    expect(occupancy).toContain("WA_NL_DRV_WAIT");
    expect(occupancy).toContain("WAITING_FOR_OTHER_CONVERSATION");
    expect(occupancy).toContain("WHATSAPP_B2D_INDEX_REQUIRED");
    expect(occupancy).not.toContain("WAITING_FOR_DIFFERENT_INPUT");
    expect(occupancy).not.toContain("o seguinte cai em ALREADY_OPEN");
    expect(driver).toContain("WHATSAPP_NL_DRIVER_WAIT_REGEXP");
    expect(driver).toContain("WHATSAPP_NL_DRIVER_MALFORMED_PARK_CODE");
    expect(contract).toContain("ALREADY_OPEN` é WAIT");
    expect(contract).toContain("WHATSAPP_B2D_INDEX_REQUIRED");
    expect(contract).toContain("PR #420");
    expect(contract).toContain("novo source** e cria novo pending");
    expect(contract).not.toContain("cai em `ALREADY_OPEN` → WAIT");
  });

  it("schema inbound/pending não muda nesta frente", () => {
    expect(schema).toContain("whatsappInboundMessages");
    expect(schema).toContain("errorCode: varchar(\"error_code\", { length: 64 })");
    expect(driver).not.toMatch(/alter table|CREATE TABLE|drizzle\/migrations/i);
    expect(occupancy).not.toMatch(/alter table|CREATE TABLE|mysqlTable/i);
    expect(driver).not.toMatch(/attempt_count|next_attempt_at|lease_until|claimed_at/);
  });

  it("contrato descreve webhook → ACK → driver → B2-C → stop, at-least-once", () => {
    expect(contract).toContain("Incremento B2-D");
    expect(contract).toContain("at-least-once");
    expect(contract).toContain("WHATSAPP_NL_DRIVER_ENABLED");
    expect(contract).toContain("não** executa a intenção");
    expect(contract).toContain("Não** responde ao WhatsApp");
    expect(consumer).toContain("ready-for-nl-driver.ts");
    expect(consumer).toContain("Não é route HTTP nem worker");
  });

  it("logs do driver não interpolam texto livre", () => {
    expect(driver).toContain("function logSafe");
    expect(driver).toContain("logger.info(JSON.stringify(payload))");
    expect(driver).not.toMatch(/logger\.(info|warn|error)\([^J]/);
    expect(driver).not.toContain("operational_text");
    const itemLog = driver.slice(
      driver.indexOf('event: "whatsapp_nl_driver_item"'),
      driver.indexOf('event: "whatsapp_nl_driver_tick"'),
    );
    expect(itemLog).not.toMatch(/operationalText|Body|phone|email|cpf/i);
  });
});

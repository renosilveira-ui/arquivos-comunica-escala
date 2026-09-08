import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const interpreter = readFileSync(
  new URL(
    "../server/integrations/whatsapp/continuation-interpreter.ts",
    import.meta.url,
  ),
  "utf8",
);
const attach = readFileSync(
  new URL(
    "../server/integrations/whatsapp/continuation-attach.ts",
    import.meta.url,
  ),
  "utf8",
);
const apply = readFileSync(
  new URL(
    "../server/integrations/whatsapp/continuation-apply.ts",
    import.meta.url,
  ),
  "utf8",
);
const continuationConsumer = readFileSync(
  new URL(
    "../server/integrations/whatsapp/continuation-consumer.ts",
    import.meta.url,
  ),
  "utf8",
);
const consumer = readFileSync(
  new URL(
    "../server/integrations/whatsapp/ready-for-nl-consumer.ts",
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
const parser = readFileSync(
  new URL("../server/natural-language/swap-intent-parser.ts", import.meta.url),
  "utf8",
);

const production = [interpreter, attach, apply, continuationConsumer];

describe("WhatsApp continuation — source guards", () => {
  it("produção não chama createSwapOffer, outbound, Verify, áudio ou mobile", () => {
    for (const src of production) {
      expect(src).not.toMatch(/from ["'][^"']*swap-offer-create/);
      expect(src).not.toMatch(/import[\s\S]{0,160}createSwapOffer/);
      expect(src).not.toMatch(/from ["']twilio["']/);
      expect(src).not.toMatch(/TWILIO_VERIFY|twilio-verify/);
      expect(src).not.toMatch(/transcribeAudio|whisper/);
      expect(src).not.toMatch(/from ["'][^"']*app\//);
    }
  });

  it("não expande parseSwapIntent com categorias de continuação", () => {
    expect(parser).not.toMatch(/CHOICE|AFFIRM|FRESH_INTENT/);
    expect(interpreter).toContain("interpretWhatsAppContinuation");
    expect(interpreter).toContain("CONTINUATION_CHOICE_NEVER_INTERNAL_ID");
    expect(interpreter).toContain("parseSwapIntent");
  });

  it("OPEN/PARSE permanece WAIT; CLARIFICATION|CONFIRMATION anexa", () => {
    expect(consumer).toContain("handleAlreadyOpen");
    expect(consumer).toContain("processWhatsAppContinuation");
    expect(consumer).toContain('WhatsAppPendingStages.PARSE');
    expect(consumer).toContain('blocked("ALREADY_OPEN")');
    expect(occupancy).toContain("OPEN/PARSE");
    expect(occupancy).toContain("WAITING_FOR_OTHER_CONVERSATION");
  });

  it("apply persiste outcome no mesmo commit e não grava NOOP em STATE_CHANGED", () => {
    expect(apply).toContain("CONTINUATION_STAGE_FENCE");
    expect(apply).toContain("CONTINUATION_USER_OWNERSHIP");
    expect(apply).toContain("CONTINUATION_PERSIST_OUTCOME");
    expect(apply).toContain("CONTINUATION_NOOP_NOT_ON_STATE_CHANGED");
    expect(apply).toContain("CONTINUATION_GENERATION_FENCE");
    expect(apply).toContain("writeOutcome");
    expect(apply).toContain("requireOutcomeWrite");
    expect(attach).toContain("CONTINUATION_NO_NEW_ATTACH_WITHOUT_PAYLOAD");
    expect(attach).toContain("PAYLOAD_UNAVAILABLE");
    expect(continuationConsumer).toContain("CONTINUATION_FOUNDING_REQUIRES_PAYLOAD");
    expect(consumer).toContain("CONTINUATION_FOUNDING_REQUIRES_PAYLOAD");
    expect(attach).toContain('.for("update")');
    const txStart = attach.indexOf("db.transaction");
    const pendingLock = attach.indexOf(
      "from(whatsappPendingIntents)",
      txStart,
    );
    const childLock = attach.indexOf(
      "from(whatsappInboundMessages)",
      txStart,
    );
    expect(txStart).toBeGreaterThan(-1);
    expect(pendingLock).toBeGreaterThan(txStart);
    expect(childLock).toBeGreaterThan(pendingLock);
  });

  it("schema tem exatamente as três colunas nullable do contrato", () => {
    const inbound = schema.slice(
      schema.indexOf("export const whatsappInboundMessages"),
      schema.indexOf("export type WhatsappInboundMessage"),
    );
    const pending = schema.slice(
      schema.indexOf("export const whatsappPendingIntents"),
      schema.indexOf("export type WhatsappPendingIntent"),
    );
    expect(inbound).toContain("continuationPendingId");
    expect(inbound).toContain("continuationOutcome");
    expect(inbound).toContain("idx_whatsapp_inbound_continuation_pending");
    expect(pending).toContain("confirmationDisposition");
    expect(schema).not.toContain("last_applied_inbound_id");
    expect(schema).not.toContain("lastAppliedInboundId");
    expect(contract).toContain("continuation_pending_id");
    expect(contract).toContain("KEEP_CURRENT_PENDING");
    expect(contract).toContain("confirmation_disposition=AFFIRMED");
    expect(contract).toContain("adquire `continuation_pending_id`");
    expect(contract).toContain("CAS da geração interpretada");
    expect(contract).not.toContain("esta frente não rebinda source");
  });
});

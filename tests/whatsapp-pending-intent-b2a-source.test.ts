import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const store = readFileSync(
  new URL(
    "../server/integrations/whatsapp/pending-intent-store.ts",
    import.meta.url,
  ),
  "utf8",
);
const payloads = readFileSync(
  new URL(
    "../server/integrations/whatsapp/pending-intent-payloads.ts",
    import.meta.url,
  ),
  "utf8",
);
const classification = readFileSync(
  new URL(
    "../server/integrations/whatsapp/swap-intent-error-classification.ts",
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
const resolver = readFileSync(
  new URL("../server/natural-language/swap-intent-resolver.ts", import.meta.url),
  "utf8",
);
const schema = readFileSync(
  new URL("../drizzle/schema.ts", import.meta.url),
  "utf8",
);

describe("WhatsApp B2-A source guards", () => {
  it("produção não chama parser/resolver NL nem createSwapOffer", () => {
    for (const src of [store, payloads, classification, types]) {
      expect(src).not.toMatch(/import[\s\S]{0,120}parseSwapIntent/);
      expect(src).not.toMatch(/import[\s\S]{0,120}resolveSwapIntent/);
      expect(src).not.toMatch(/import[\s\S]{0,120}createSwapOffer/);
    }
    expect(payloads).toMatch(/import type/);
    expect(store).not.toMatch(/from ["'][^"']*natural-language/);
    expect(store).not.toMatch(/from ["'][^"']*swap-offer-create/);
  });

  it("não consome inbound operacional", () => {
    for (const src of [store, payloads, classification, types]) {
      expect(src).not.toMatch(/readWhatsAppInboundOperationalMaterial/);
      expect(src).not.toMatch(/clearWhatsAppInboundOperationalPayload/);
    }
  });

  it("advance usa guarda SQL do estado esperado", () => {
    expect(store).toContain("export async function advanceWhatsAppPendingFromParse");
    expect(store).toContain("gt(whatsappPendingIntents.expiresAt, now)");
    expect(store).toContain("eq(whatsappPendingIntents.stage, WhatsAppPendingStages.PARSE)");
    expect(store).toContain("eq(whatsappPendingIntents.status, WhatsAppPendingStatuses.OPEN)");
    expect(payloads).toContain("é snapshot semântico");
    expect(payloads).toContain("createSwapOffer()");
  });

  it("clarification humana exige label projetado, não name cru do resolver", () => {
    expect(payloads).toContain("projectWhatsAppTargetProfessionalClarificationV1");
    expect(payloads).toContain("unresolvedGroups");
    expect(payloads).not.toMatch(
      /professionalChoiceSchema[\s\S]{0,120}name: z\.string/,
    );
    expect(payloads).not.toMatch(/ProfessionalCandidate/);
    expect(payloads).not.toMatch(/SectorCandidate/);
    expect(resolver).toMatch(
      /professionalId: colleague\.professionalId,\s*name: colleague\.name/,
    );
    expect(resolver).toMatch(/name: professionals\.name/);
    expect(resolver).not.toMatch(/medicalSpecialtyId: professionals/);
    expect(schema).toContain("uniqSectorTopologyId");
    expect(schema).toContain("name: varchar(\"name\", { length: 255 }).notNull()");
  });
});

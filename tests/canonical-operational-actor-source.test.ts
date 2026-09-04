import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { CanonicalOperationalActor } from "../server/_core/canonical-operational-actor";
import type { SwapIntentActor } from "../server/natural-language/swap-intent-resolver";

const actor = readFileSync(
  new URL("../server/_core/canonical-operational-actor.ts", import.meta.url),
  "utf8",
);
const tenant = readFileSync(
  new URL("../server/_core/tenant.ts", import.meta.url),
  "utf8",
);
const policy = readFileSync(
  new URL("../server/_core/policy.ts", import.meta.url),
  "utf8",
);
const schema = readFileSync(new URL("../drizzle/schema.ts", import.meta.url), "utf8");
const pendingTypes = readFileSync(
  new URL(
    "../server/integrations/whatsapp/pending-intent-types.ts",
    import.meta.url,
  ),
  "utf8",
);
const pendingStore = readFileSync(
  new URL(
    "../server/integrations/whatsapp/pending-intent-store.ts",
    import.meta.url,
  ),
  "utf8",
);
const pendingSchema = schema.slice(
  schema.indexOf("export const whatsappPendingIntents"),
  schema.indexOf("export type WhatsappPendingIntent"),
);
const professionalsSchema = schema.slice(
  schema.indexOf("export const professionals = mysqlTable"),
  schema.indexOf("export const professionalInstitutions = mysqlTable"),
);

function assertSwapIntentActorShape(value: CanonicalOperationalActor): SwapIntentActor {
  return value;
}

describe("Canonical operational actor — source guards (B2-B)", () => {
  it("é primitive interna channel-agnostic, não WhatsAppActor", () => {
    expect(actor).toContain("export async function resolveCanonicalOperationalActorForUser");
    expect(actor).toContain("CanonicalOperationalActor");
    expect(actor).not.toMatch(/\btype WhatsAppActor\b|\bresolveWhatsAppActor\b/);
    expect(actor).not.toMatch(/from ["'][^"']*integrations\/whatsapp/);
    expect(actor).not.toMatch(/from ["']twilio["']/);
    expect(actor).not.toMatch(/from ["'][^"']*twilio/);
    expect(actor).not.toMatch(/import[\s\S]{0,160}parseSwapIntent/);
    expect(actor).not.toMatch(/import[\s\S]{0,160}resolveSwapIntent/);
    expect(actor).not.toMatch(/import[\s\S]{0,160}createSwapOffer/);
    expect(actor).not.toMatch(/from ["'][^"']*natural-language/);
    expect(actor).not.toMatch(/pending-intent|inbound-store|operational_text|operationalText/);
    expect(actor).not.toMatch(/expo-notifications|expo-server-sdk|getExpo/);
    expect(actor).not.toMatch(/from ["'][^"']*\/tenant["']/);
    expect(actor).not.toMatch(/from ["'][^"']*\/policy["']/);
  });

  it("é read-only: não INSERT/UPDATE/DELETE nem transação de escrita", () => {
    expect(actor).not.toMatch(/\.insert\s*\(/);
    expect(actor).not.toMatch(/\.update\s*\(/);
    expect(actor).not.toMatch(/\.delete\s*\(/);
    expect(actor).not.toMatch(/\.transaction\s*\(/);
    expect(actor).toMatch(/\.select\s*\(/);
    expect(actor).toContain("leftJoin");
  });

  it("não cria identidade por papel, access ou manager_scope", () => {
    expect(actor).not.toMatch(/GESTOR_PLUS|GESTOR_MEDICO|roleInInstitution|userRole/);
    expect(actor).not.toMatch(/managerScope|professionalAccess/);
    expect(actor).not.toMatch(/AMBIGUOUS_INSTITUTION/);
    expect(actor).not.toMatch(/\.limit\s*\(\s*1\s*\)/);
  });

  it("membership canônica casa professionalId+userId, user APPROVED e institution ativa", () => {
    expect(actor).toContain("eq(professionalInstitutions.professionalId, professionals.id)");
    expect(actor).toContain("eq(professionalInstitutions.userId, users.id)");
    expect(actor).toContain('eq(professionalInstitutions.active, true)');
    expect(actor).toContain('eq(users.approvalStatus, "APPROVED")');
    expect(actor).toContain("isNull(users.deletedAt)");
    expect(actor).toContain("eq(institutions.isActive, true)");
    expect(tenant).toContain("eq(professionals.id, professionalInstitutions.professionalId)");
    expect(tenant).toContain("eq(professionals.userId, professionalInstitutions.userId)");
    expect(tenant).toContain('eq(professionalInstitutions.active, true)');
    expect(policy).toContain("eq(professionals.id, professionalInstitutions.professionalId)");
    expect(policy).toContain('eq(professionalInstitutions.active, true)');
  });

  it("professionals.user_id não tem UNIQUE estrutural — >1 professional é possível", () => {
    expect(professionalsSchema).not.toMatch(/unique\(\)\.on\(\s*table\.userId/);
    expect(professionalsSchema).not.toMatch(/unique\(["'][^"']*["']\)\.on\(\s*table\.userId/);
    expect(professionalsSchema).toContain("chkProfessionalsAtMostOneMedicalQualification");
    expect(actor).toContain("ACTOR_PROFESSIONAL_AMBIGUOUS");
  });

  it("B2-B não persiste actor no pending nem altera schema de pending", () => {
    expect(pendingSchema).not.toMatch(/professionalId|professional_id/);
    expect(pendingSchema).not.toMatch(/institutionIds|institution_ids/);
    expect(pendingTypes).not.toMatch(/canonicalOperationalActor|CanonicalOperationalActor/);
    expect(pendingStore).not.toMatch(/resolveCanonicalOperationalActorForUser/);
  });

  it("SwapIntentActor aceita o actor B2-B sem adapter de canal", () => {
    const sample: CanonicalOperationalActor = {
      userId: 1,
      professionalId: 2,
      institutionIds: [3, 5],
    };
    const fed: SwapIntentActor = assertSwapIntentActorShape(sample);
    expect(fed).toEqual(sample);
    expect(Object.keys(fed).sort()).toEqual([
      "institutionIds",
      "professionalId",
      "userId",
    ]);
  });
});

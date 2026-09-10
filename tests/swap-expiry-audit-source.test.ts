import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("auditoria da expiração automática de oferta", () => {
  it("encerra expiração auditada antes de iniciar a transação de criação", () => {
    const source = readFileSync("server/swap-offer-create.ts", "utf8");
    const helperStart = source.indexOf(
      "async function expireStaleSwapOffersBeforeReoffer",
    );
    const createStart = source.indexOf("export async function createSwapOffer");
    const helper = source.slice(helperStart, createStart);
    const helperCall = source.indexOf(
      "await expireStaleSwapOffersBeforeReoffer",
    );
    const creationTransaction = source.indexOf(
      "return db.transaction",
      helperCall,
    );
    const creationBlock = source.slice(creationTransaction);

    expect(helperStart).toBeGreaterThan(-1);
    expect(createStart).toBeGreaterThan(helperStart);
    expect(helper).toContain("await input.db.transaction");
    expect(helper).not.toContain("bloqueia somente swap_requests");
    expect(helper).toContain("nunca mantém lock de");
    expect(helper).toContain("isNotNull(swapRequests.expiresAt)");
    expect(helper).toContain("eq(swapRequests.fromUserId, input.userId)");
    expect(helper).toContain(
      "eq(swapRequests.fromProfessionalId, input.professionalId)",
    );
    expect(helper).toContain('.for("update")');
    expect(helper.indexOf('.for("update")')).toBeLessThan(
      helper.indexOf("await requireCanonicalProfessional"),
    );
    expect(helper).toContain(
      "expectedSessionVersion: input.expectedSessionVersion",
    );
    expect(helper).toContain("lockForUpdate: true");
    expect(helper).toContain("eq(swapRequests.version, expired.version)");
    expect(helper).toContain("updated.affectedRows !== 1");
    expect(helper).toContain('lifecycleReason: "AUTO_EXPIRED"');
    expect(helper).toContain('trigger: "REOFFER"');
    expect(helper).toContain('auditNames(expired.type, "EXPIRED")');
    expect(helper).not.toContain('auditNames(expired.type, "CANCELLED")');
    expect(helper).toContain("await recordAudit(");
    expect(helper).toContain("{ db: tx, strict: true }");
    expect(helper).not.toContain("actorName:");
    expect(helper).not.toContain("reason:");
    expect(helperCall).toBeGreaterThan(createStart);
    expect(creationTransaction).toBeGreaterThan(helperCall);
    expect(creationBlock).not.toContain('.for("update")');
  });

  it("mantém ações de expiração distintas em schema, domínio e leitura", () => {
    const schema = readFileSync("drizzle/schema.ts", "utf8");
    const domain = readFileSync("server/swap-domain.ts", "utf8");
    const auditTrail = readFileSync("server/audit-trail.ts", "utf8");
    const auditRouter = readFileSync("server/audit-router.ts", "utf8");
    const auditScreen = readFileSync("app/audit-log.tsx", "utf8");

    for (const action of [
      "SWAP_EXPIRED",
      "TRANSFER_EXPIRED",
      "CESSAO_EXPIRED",
    ]) {
      expect(schema).toContain(`"${action}"`);
      expect(domain).toContain(`"${action}"`);
      expect(auditTrail).toContain(`"${action}"`);
      expect(auditRouter).toContain(`${action}:`);
      expect(auditRouter).toContain(`"${action}"`);
      expect(auditScreen).toContain(`"${action}"`);
    }
    expect(schema).toContain('index("idx_swap_expiry_reoffer").on(');
    expect(schema).toContain("table.fromAssignmentId,");
    expect(schema).toContain("table.expiresAt,");
    expect(schema.indexOf('"SECTOR_SERVICE_SPECIALTIES_UPDATED"')).toBeLessThan(
      schema.indexOf('"INSTITUTION_FEATURE_UPDATED"'),
    );
    expect(schema.indexOf('"INSTITUTION_FEATURE_UPDATED"')).toBeLessThan(
      schema.indexOf('"SWAP_EXPIRED"'),
    );
  });
});

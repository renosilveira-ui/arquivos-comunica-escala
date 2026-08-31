import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  new URL("../server/month-guards.ts", import.meta.url),
  "utf8",
);

describe("publicação com fence de prontidão", () => {
  it("materializa o rascunho antes de reter a fence, então a confere antes de publicar", () => {
    const draft = source.indexOf(
      ".values({ institutionId, hospitalId, yearMonth, status: \"DRAFT\" })",
    );
    const lock = source.indexOf(
      "materializeAndLockInstitutionReadinessFence(tx, institutionId)",
    );
    const report = source.indexOf("const readiness = await getCorporateReadinessReport");
    const acknowledgement = source.indexOf(
      "requirePublishReadinessAcknowledgement(readiness, readinessAcknowledgement)",
    );
    const recheck = source.indexOf(
      "assertInstitutionReadinessFenceUnchanged(tx, readinessFence)",
    );
    const publish = source.indexOf(".update(monthlyRosters)", recheck);

    expect(draft).toBeGreaterThanOrEqual(0);
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(lock).toBeGreaterThan(draft);
    expect(report).toBeGreaterThan(lock);
    expect(acknowledgement).toBeGreaterThan(report);
    expect(recheck).toBeGreaterThan(acknowledgement);
    expect(publish).toBeGreaterThan(recheck);
  });

  it("vincula o recibo apenas ao relatório local e não expõe fábrica genérica", () => {
    expect(source).toContain("snapshotHash: readiness.snapshotHash");
    expect(source).toContain("readinessFenceRevision: readinessFenceReceipt.revision");
    expect(source).toContain("READINESS_FENCE_COVERAGE_HASH");
    expect(source).not.toContain("createReadinessFenceAcknowledgementBinding");
  });
});

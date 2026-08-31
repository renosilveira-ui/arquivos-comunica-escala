import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("router administrativo de especialidades assistenciais", () => {
  it("exige gestão institucional e escopo de hospital/setor antes de ler", () => {
    const source = readFileSync("server/schedule-contexts.ts", "utf8");
    const start = source.indexOf(
      "getSectorServiceSpecialties: protectedProcedure",
    );
    const end = source.indexOf(
      "replaceSectorServiceSpecialties: protectedProcedure",
      start,
    );
    const endpoint = source.slice(start, end);

    expect(endpoint).toContain("assertCanManageInstitutionSchedule(actor)");
    expect(endpoint).toContain(
      "assertManagerScopeAccess(actor, input.hospitalId, input.sectorId)",
    );
    expect(endpoint).toContain("institutionId: actor.institutionId");
  });

  it("revalida o escopo sob transação e audita apenas mudanças", () => {
    const source = readFileSync("server/schedule-contexts.ts", "utf8");
    const start = source.indexOf(
      "replaceSectorServiceSpecialties: protectedProcedure",
    );
    const endpoint = source.slice(start);

    expect(endpoint).toContain("return db.transaction(async (tx) =>");
    expect(endpoint).toContain("assertManagerScopeAccessForUpdate");
    expect(endpoint).toContain('action: "SECTOR_SERVICE_SPECIALTIES_UPDATED"');
    expect(endpoint).toContain('entityType: "SECTOR"');
    expect(endpoint).toContain("if (result.changed)");
    expect(endpoint).toContain("strict: true");
  });
});

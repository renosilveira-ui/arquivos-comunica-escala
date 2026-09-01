import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TRPC_MUTATION_NOTIFICATION_TARGETS } from "../server/mutation-notification-policy";

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
    expect(endpoint).toContain("readSectorServiceSpecialties");
    expect(endpoint).toContain("...result");
  });

  it("revalida o escopo sob transação e audita apenas mudanças", () => {
    const source = readFileSync("server/schedule-contexts.ts", "utf8");
    const start = source.indexOf(
      "replaceSectorServiceSpecialties: protectedProcedure",
    );
    const endpoint = source.slice(start);

    expect(endpoint).toContain("return await db.transaction(async (tx) =>");
    expect(endpoint).toContain("assertManagerScopeAccessForUpdate");
    expect(endpoint).toContain('action: "SECTOR_SERVICE_SPECIALTIES_UPDATED"');
    expect(endpoint).toContain('entityType: "SECTOR"');
    expect(endpoint).toContain("if (result.changed)");
    expect(endpoint).toContain("strict: true");
    expect(endpoint).toContain("isSectorServiceSpecialtiesTableMissing(error)");
    expect(endpoint).toContain("sectorServiceSpecialtiesMigrationPendingError()");
  });

  it("permanece silenciosa e auditada por ser metadado descritivo", () => {
    expect(
      TRPC_MUTATION_NOTIFICATION_TARGETS[
        "scheduleContexts.replaceSectorServiceSpecialties"
      ],
    ).toEqual({
      targets: [
        {
          policy: "SILENT_AUDITED",
          when:
            "quando somente o metadado assistencial descritivo do setor é alterado sem mudar acesso, elegibilidade ou alocação",
          audience: [],
        },
      ],
    });
  });
});

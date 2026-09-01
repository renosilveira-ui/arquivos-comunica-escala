import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  accessCoversContext,
  accessCoversScheduleContext,
  managerScopeCoversContext,
  projectEffectiveScheduleContextIds,
  type ActiveScheduleContext,
} from "../server/schedule-contexts";

function allowlistContext(
  sectorId: number,
  overrides: Partial<ActiveScheduleContext> = {},
): ActiveScheduleContext {
  return {
    id: 10,
    institutionId: 1,
    hospitalId: 100,
    hospitalName: "Hospital São Carlos",
    sectorId,
    sectorName: `Setor ${sectorId}`,
    medicalSpecialtyId: null,
    medicalSpecialtyCode: null,
    medicalSpecialtyName: null,
    operationalProfileCode: null,
    admissionPolicy: "QUALIFICATION_ALLOWLIST",
    // Caso de regressão de Sala de Recuperação: ausência de metadado clínico
    // não altera a ACL exata do setor.
    allowedQualifications: [],
    active: true,
    ...overrides,
  };
}

function legacyBroadContext(sectorId: number): ActiveScheduleContext {
  return {
    id: sectorId,
    institutionId: 1,
    hospitalId: 100,
    hospitalName: "Hospital São Carlos",
    sectorId,
    sectorName: `Setor ${sectorId}`,
    medicalSpecialtyId: null,
    medicalSpecialtyCode: null,
    medicalSpecialtyName: null,
    operationalProfileCode: null,
    admissionPolicy: "ALL_CFM_SPECIALTIES",
    active: true,
  };
}

const professionalId = 55;

describe("accessCoversScheduleContext — regra canônica allowlist", () => {
  const salaRecuperacao = allowlistContext(101);

  it("allowlist clínica vazia + setor exato → permitido", () => {
    expect(
      accessCoversScheduleContext(
        {
          institutionId: 1,
          professionalId,
          hospitalId: 100,
          sectorId: 101,
          canAccess: true,
        },
        professionalId,
        salaRecuperacao,
      ),
    ).toBe(true);
  });

  it("allowlist + hospital-wide null → negado", () => {
    expect(
      accessCoversScheduleContext(
        {
          institutionId: 1,
          professionalId,
          hospitalId: 100,
          sectorId: null,
          canAccess: true,
        },
        professionalId,
        salaRecuperacao,
      ),
    ).toBe(false);
  });

  it("allowlist + setor diferente → negado", () => {
    expect(
      accessCoversScheduleContext(
        {
          institutionId: 1,
          professionalId,
          hospitalId: 100,
          sectorId: 102,
          canAccess: true,
        },
        professionalId,
        salaRecuperacao,
      ),
    ).toBe(false);
  });

  it("outro hospital → negado", () => {
    expect(
      accessCoversScheduleContext(
        {
          institutionId: 1,
          professionalId,
          hospitalId: 999,
          sectorId: 101,
          canAccess: true,
        },
        professionalId,
        salaRecuperacao,
      ),
    ).toBe(false);
  });

  it("outro tenant → negado", () => {
    expect(
      accessCoversScheduleContext(
        {
          institutionId: 2,
          professionalId,
          hospitalId: 100,
          sectorId: 101,
          canAccess: true,
        },
        professionalId,
        salaRecuperacao,
      ),
    ).toBe(false);
  });

  it("contexto legado compatível preserva hospital-wide", () => {
    const emergencia = legacyBroadContext(201);
    expect(
      accessCoversScheduleContext(
        {
          institutionId: 1,
          professionalId,
          hospitalId: 100,
          sectorId: null,
          canAccess: true,
        },
        professionalId,
        emergencia,
      ),
    ).toBe(true);
    expect(
      accessCoversContext(
        {
          institutionId: 1,
          professionalId,
          hospitalId: 100,
          sectorId: null,
          canAccess: true,
        },
        professionalId,
        emergencia,
      ),
    ).toBe(true);
  });

  it("projectEffectiveScheduleContextIds nega allowlist com acesso hospital-wide", () => {
    const contexts = [allowlistContext(101), allowlistContext(102, { id: 11 })];
    expect(
      projectEffectiveScheduleContextIds({
        institutionId: 1,
        professionalId,
        contexts,
        accesses: [
          {
            institutionId: 1,
            professionalId,
            hospitalId: 100,
            sectorId: 101,
            canAccess: true,
          },
        ],
      }),
    ).toEqual([10]);
    expect(
      projectEffectiveScheduleContextIds({
        institutionId: 1,
        professionalId,
        contexts,
        accesses: [
          {
            institutionId: 1,
            professionalId,
            hospitalId: 100,
            sectorId: null,
            canAccess: true,
          },
        ],
      }),
    ).toEqual([]);
  });

  it("manager scope hospital-wide continua cobrindo allowlist", () => {
    expect(
      managerScopeCoversContext(
        {
          institutionId: 1,
          managerProfessionalId: professionalId,
          hospitalId: 100,
          sectorId: null,
          active: true,
        },
        professionalId,
        allowlistContext(101),
      ),
    ).toBe(true);
  });
});

describe("leitores SQL alinhados com accessCoversScheduleContext", () => {
  it("listAssignableForShift e listReplacementCandidates ramificam allowlist", () => {
    const assignable = readFileSync("server/aux-routers.ts", "utf8");
    const replacement = readFileSync("server/confirmation-router.ts", "utf8");

    for (const source of [assignable, replacement]) {
      expect(source).toContain("QUALIFICATION_ALLOWLIST");
      expect(source).toContain("pa.sector_id =");
      expect(source).toContain("pa.sector_id IS NULL OR");
    }
  });

  it("swap-router aplica a mesma fronteira em professional_access", () => {
    const source = readFileSync("server/swap-router.ts", "utf8");
    expect(source).toContain(
      "fsc.admission_policy = 'QUALIFICATION_ALLOWLIST'",
    );
    expect(source).toContain(
      "tsc.admission_policy = 'QUALIFICATION_ALLOWLIST'",
    );
    expect(source).toContain("source_access.sector_id = fsi.sector_id");
    expect(source).toContain("actor_target_access.sector_id = tsi.sector_id");
  });

  it("assignDirect e listAssignable concordam no bloqueio hospital-wide", () => {
    const editor = readFileSync("tests/editor-assign-direct.test.ts", "utf8");
    const assignable = readFileSync(
      "tests/assignable-professionals.test.ts",
      "utf8",
    );
    expect(editor).toContain(
      "bloqueia bypass de alocação direta com acesso só hospitalar",
    );
    expect(assignable).toContain(
      "expect(ids).not.toContain(hospitalWideProfessionalId)",
    );
  });
});

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  filterScheduleContextsForActor,
  listAssumableScheduleContextIds,
  projectEffectiveScheduleContextIds,
  type ActiveScheduleContext,
  type ProfessionalQualification,
  type ScheduleContextAccess,
} from "../server/schedule-contexts";

const professionalId = 55;

function context(
  overrides: Partial<ActiveScheduleContext> = {},
): ActiveScheduleContext {
  return {
    id: 1,
    institutionId: 1,
    hospitalId: 100,
    hospitalName: "Hospital São Carlos",
    sectorId: 101,
    sectorName: "Sala de Recuperação",
    medicalSpecialtyId: 99,
    medicalSpecialtyCode: "MEDICINA_DE_EMERGENCIA",
    medicalSpecialtyName: "Medicina de emergência",
    operationalProfileCode: null,
    admissionPolicy: "PINNED_QUALIFICATION",
    active: true,
    ...overrides,
  };
}

function access(
  overrides: Partial<ScheduleContextAccess> = {},
): ScheduleContextAccess {
  return {
    institutionId: 1,
    professionalId,
    hospitalId: 100,
    sectorId: 101,
    canAccess: true,
    ...overrides,
  };
}

const actor = {
  institutionId: 1,
  professionalId,
  roleInInstitution: "USER" as const,
  isGlobalAdmin: false,
};

const missingQualification: ProfessionalQualification = {
  medicalSpecialtyId: null,
  operationalProfileCode: null,
};

const matchingQualification: ProfessionalQualification = {
  medicalSpecialtyId: 99,
  operationalProfileCode: null,
};

const divergentQualification: ProfessionalQualification = {
  medicalSpecialtyId: 77,
  operationalProfileCode: null,
};

function project(
  contexts: ActiveScheduleContext[],
  accesses: ScheduleContextAccess[],
  qualification: ProfessionalQualification = missingQualification,
): number[] {
  return projectEffectiveScheduleContextIds({
    institutionId: 1,
    professionalId,
    qualification,
    contexts,
    accesses,
  });
}

/**
 * Mock estreito do caminho de leitura de listAssumable. Com USER não há
 * carregamento de manager_scope; assim a fila reproduz apenas os três selects
 * que a função usa (contextos, vínculo/papel e ACL).
 */
function assumableDb(results: unknown[]): any {
  let next = 0;
  return {
    select: () => {
      const result = results[next++];
      const chain: any = {
        from: () => chain,
        innerJoin: () => chain,
        leftJoin: () => chain,
        where: () => chain,
        orderBy: () => chain,
        limit: () => Promise.resolve(result),
        then: (onFulfilled: any, onRejected: any) =>
          Promise.resolve(result).then(onFulfilled, onRejected),
      };
      return chain;
    },
  };
}

async function listAssumable(
  contexts: ActiveScheduleContext[],
  accesses: ScheduleContextAccess[],
  professionalRows: unknown[] = [{ roleInInstitution: "USER" }],
): Promise<number[]> {
  const allowlistRows = contexts.flatMap((current) =>
    current.admissionPolicy === "QUALIFICATION_ALLOWLIST"
      ? (current.allowedQualifications ?? []).map((qualification) => ({
          scheduleContextId: current.id,
          medicalSpecialtyId: qualification.medicalSpecialtyId,
          operationalProfileCode: qualification.operationalProfileCode,
        }))
      : [],
  );
  return listAssumableScheduleContextIds(
    1,
    professionalId,
    assumableDb([
      contexts,
      ...(allowlistRows.length > 0 ? [allowlistRows] : []),
      professionalRows,
      accesses,
    ]),
  );
}

function sourceBlock(source: string, start: string, end: string): string {
  const startAt = source.indexOf(start);
  const endAt = source.indexOf(end, startAt + start.length);
  expect(startAt, `âncora ausente: ${start}`).toBeGreaterThanOrEqual(0);
  expect(endAt, `âncora ausente: ${end}`).toBeGreaterThan(startAt);
  return source.slice(startAt, endAt);
}

describe("descoberta de contextos é ACL/topologia, não especialidade", () => {
  it("mantém o contexto visível com ACL ativa mesmo quando a especialidade está ausente ou diverge", async () => {
    const base = context();
    const annotated = {
      ...base,
      serviceSpecialties: [
        {
          medicalSpecialtyId: 3,
          code: "ANESTESIOLOGIA",
          name: "Anestesiologia",
          sortOrder: 3,
          active: true,
        },
      ],
    };
    const accesses = [access()];

    for (const current of [base, annotated]) {
      for (const qualification of [
        missingQualification,
        divergentQualification,
        matchingQualification,
      ]) {
        expect(
          filterScheduleContextsForActor({
            actor,
            contexts: [current],
            professional: qualification,
            accesses,
            managerScopes: [],
          }).map((row) => row.id),
        ).toEqual([1]);
        expect(project([current], accesses, qualification)).toEqual([1]);
      }
    }

    expect(await listAssumable([annotated], accesses)).toEqual([1]);
  });

  it("especialidade compatível sem ACL continua bloqueada", async () => {
    const current = context();

    expect(
      filterScheduleContextsForActor({
        actor,
        contexts: [current],
        professional: matchingQualification,
        accesses: [],
        managerScopes: [],
      }),
    ).toEqual([]);
    expect(project([current], [], matchingQualification)).toEqual([]);
    expect(await listAssumable([current], [])).toEqual([]);
  });

  it("preserva a exigência de identidade profissional vinculada", async () => {
    const current = context();
    const accesses = [access()];

    expect(
      filterScheduleContextsForActor({
        actor,
        contexts: [current],
        professional: null,
        accesses,
        managerScopes: [],
      }),
    ).toEqual([]);
    expect(await listAssumable([current], accesses, [])).toEqual([]);
  });

  it("preserva tenant, hospital, setor e contexto ativo como fronteiras de descoberta", () => {
    const local = context();
    const otherHospital = context({
      id: 2,
      hospitalId: 200,
      hospitalName: "Hospital Unimed Sul",
    });
    const otherSector = context({
      id: 3,
      sectorId: 102,
      sectorName: "Emergência",
    });
    const otherTenant = context({
      id: 4,
      institutionId: 2,
      hospitalId: 900,
      hospitalName: "Hospital de outro tenant",
    });
    const inactive = context({ id: 5, active: false });
    const contexts = [local, otherHospital, otherSector, otherTenant, inactive];
    const accesses = [access()];

    expect(
      filterScheduleContextsForActor({
        actor,
        contexts,
        professional: missingQualification,
        accesses,
        managerScopes: [],
      }).map((row) => row.id),
    ).toEqual([1]);
    expect(project(contexts, accesses)).toEqual([1]);
  });

  it("preserva fail-closed: QUALIFICATION_ALLOWLIST requer ACL setorial explícita", async () => {
    const allowlist = context({
      admissionPolicy: "QUALIFICATION_ALLOWLIST",
      medicalSpecialtyId: null,
      medicalSpecialtyCode: null,
      medicalSpecialtyName: null,
      allowedQualifications: [matchingQualification],
    });
    const hospitalWide = [access({ sectorId: null })];

    expect(
      filterScheduleContextsForActor({
        actor,
        contexts: [allowlist],
        professional: matchingQualification,
        accesses: hospitalWide,
        managerScopes: [],
      }),
    ).toEqual([]);
    expect(project([allowlist], hospitalWide, matchingQualification)).toEqual([]);
    expect(await listAssumable([allowlist], hospitalWide)).toEqual([]);
  });

  it("preserva ACL hospitalar ampla para contextos que não são QUALIFICATION_ALLOWLIST", async () => {
    const broad = context({
      admissionPolicy: "ALL_CFM_SPECIALTIES",
      medicalSpecialtyId: null,
      medicalSpecialtyCode: null,
      medicalSpecialtyName: null,
    });
    const hospitalWide = [access({ sectorId: null })];

    expect(
      filterScheduleContextsForActor({
        actor,
        contexts: [broad],
        professional: missingQualification,
        accesses: hospitalWide,
        managerScopes: [],
      }).map((row) => row.id),
    ).toEqual([1]);
    expect(project([broad], hospitalWide)).toEqual([1]);
    expect(await listAssumable([broad], hospitalWide)).toEqual([1]);
  });

  it("não permite que os três leitores voltem a chamar qualificationMatches", () => {
    const source = readFileSync("server/schedule-contexts.ts", "utf8");
    const filter = sourceBlock(
      source,
      "export function filterScheduleContextsForActor",
      "export function filterScheduleContextsForRosterRead",
    );
    const effective = sourceBlock(
      source,
      "export function projectEffectiveScheduleContextIds",
      "export async function listAdministrativeScheduleContexts",
    );
    const assumable = sourceBlock(
      source,
      "export async function listAssumableScheduleContextIds",
      "export async function assertProfessionalEligibleForScheduleContext",
    );

    for (const reader of [filter, effective, assumable]) {
      expect(reader).not.toMatch(/\bqualificationMatches\s*\(/);
    }
    expect(filter).toContain("accessCoversScheduleContext");
    expect(effective).toContain("accessCoversScheduleContext");
    expect(assumable).toContain("accessCoversScheduleContext");
  });
});

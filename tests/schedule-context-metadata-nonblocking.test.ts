import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  managerScope,
  professionalAccess,
  professionalInstitutions,
  professionals,
  scheduleContexts,
} from "../drizzle/schema";
import {
  assertProfessionalEligibleForScheduleContext,
  describeScheduleContext,
  filterScheduleContextsForActor,
  listAssumableScheduleContextIds,
  projectEffectiveScheduleContextIds,
  selectActiveScheduleContexts,
  specialtyForScheduleContextShift,
  type ActiveScheduleContext,
  type ScheduleContextAccess,
} from "../server/schedule-contexts";

const institutionId = 1;
const professionalId = 55;

function context(
  overrides: Partial<ActiveScheduleContext> = {},
): ActiveScheduleContext {
  return {
    id: 202,
    institutionId,
    hospitalId: 10,
    hospitalName: "Hospital São Carlos",
    sectorId: 20,
    sectorName: "Sala de Recuperação",
    medicalSpecialtyId: 99,
    medicalSpecialtyCode: "ANESTESIOLOGIA",
    medicalSpecialtyName: "Anestesiologia",
    medicalSpecialtyActive: true,
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
    institutionId,
    professionalId,
    hospitalId: 10,
    sectorId: 20,
    canAccess: true,
    ...overrides,
  };
}

function sequentialSelectDb(results: unknown[]) {
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
        for: () => Promise.resolve(result),
        then: (onFulfilled: any, onRejected: any) =>
          Promise.resolve(result).then(onFulfilled, onRejected),
      };
      return chain;
    },
  };
}

function tableSelectDb(rowsByTable: Map<unknown, unknown[][]>) {
  return {
    select: vi.fn(() => {
      let selectedTable: unknown;
      const chain: any = {
        from(table: unknown) {
          selectedTable = table;
          return chain;
        },
        innerJoin: () => chain,
        leftJoin: () => chain,
        where: () => chain,
        orderBy: () => chain,
        limit: () => chain,
        for: () => chain,
        then: (resolve: (value: unknown[]) => unknown) => {
          const queue = rowsByTable.get(selectedTable) ?? [];
          return Promise.resolve(queue.shift() ?? []).then(resolve);
        },
      };
      return chain;
    }),
  };
}

async function listAssumable(
  contexts: ActiveScheduleContext[],
  accesses: ScheduleContextAccess[],
): Promise<number[]> {
  return listAssumableScheduleContextIds(
    institutionId,
    professionalId,
    sequentialSelectDb([
      contexts,
      [{ roleInInstitution: "USER" }],
      accesses,
    ]) as any,
  );
}

function allocationDb(activeContext: ActiveScheduleContext) {
  return tableSelectDb(
    new Map([
      [
        scheduleContexts,
        [
          [{ id: activeContext.id }],
          [activeContext],
        ],
      ],
      [professionals, [[{ userId: 9 }]]],
      [professionalInstitutions, [[]]],
      [managerScope, [[]]],
      [professionalAccess, [[access({ sectorId: activeContext.sectorId })]]],
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

describe("metadado clínico degradado não bloqueia contexto topológico", () => {
  it("seleciona PINNED com catálogo inativo ou referência ausente sem opt-out clínico", async () => {
    const inactiveCatalog = context({
      id: 203,
      medicalSpecialtyActive: false,
    });
    const missingReference = context({
      id: 204,
      medicalSpecialtyId: null,
      medicalSpecialtyCode: null,
      medicalSpecialtyName: null,
      medicalSpecialtyActive: null,
      operationalProfileCode: null,
    });

    await expect(
      selectActiveScheduleContexts(
        sequentialSelectDb([[inactiveCatalog, missingReference]]) as any,
        institutionId,
      ),
    ).resolves.toMatchObject([{ id: 203 }, { id: 204 }]);

    const source = readFileSync("server/schedule-contexts.ts", "utf8");
    const selection = sourceBlock(
      source,
      "export async function selectActiveScheduleContexts",
      "export function parseScheduleContextIds",
    );
    expect(selection).not.toContain("requireQualificationConfiguration");
    expect(selection).not.toContain("qualificationConfigurationCondition");
    expect(selection).not.toMatch(/eq\(medicalSpecialties\.active,\s*true\)/);
    expect(selection).toContain(
      "eq(hospitals.institutionId, scheduleContexts.institutionId)",
    );
    expect(selection).toContain(
      "eq(sectors.hospitalId, scheduleContexts.hospitalId)",
    );
    expect(selection).toContain("eq(scheduleContexts.active, true)");
  });

  it("mantém contexto visível, assumível e alocável com ACL válida", async () => {
    const degradedContexts = [
      context({ id: 203, medicalSpecialtyActive: false }),
      context({
        id: 204,
        medicalSpecialtyId: null,
        medicalSpecialtyCode: null,
        medicalSpecialtyName: null,
        medicalSpecialtyActive: null,
        operationalProfileCode: null,
      }),
    ];

    for (const current of degradedContexts) {
      const currentAccess = access({ sectorId: current.sectorId });
      expect(
        filterScheduleContextsForActor({
          actor: {
            institutionId,
            professionalId,
            roleInInstitution: "USER",
            isGlobalAdmin: false,
          },
          contexts: [current],
          professional: {
            medicalSpecialtyId: null,
            operationalProfileCode: null,
          },
          accesses: [currentAccess],
          managerScopes: [],
        }).map(({ id }) => id),
      ).toEqual([current.id]);
      expect(
        projectEffectiveScheduleContextIds({
          institutionId,
          professionalId,
          qualification: {
            medicalSpecialtyId: null,
            operationalProfileCode: null,
          },
          contexts: [current],
          accesses: [currentAccess],
        }),
      ).toEqual([current.id]);
      await expect(listAssumable([current], [currentAccess])).resolves.toEqual([
        current.id,
      ]);
      await expect(
        assertProfessionalEligibleForScheduleContext({
          institutionId,
          professionalId,
          scheduleContextId: current.id,
          db: allocationDb(current) as any,
          lockForShare: true,
        }),
      ).resolves.toBeUndefined();
    }
  });

  it("preserva bloqueios por ACL, hospital, setor, tenant e atividade", () => {
    const local = context({ id: 203 });
    const otherHospital = context({ id: 204, hospitalId: 11 });
    const otherSector = context({ id: 205, sectorId: 21 });
    const otherTenant = context({
      id: 206,
      institutionId: 2,
      hospitalId: 30,
      sectorId: 40,
    });
    const inactive = context({ id: 207, active: false });
    const actor = {
      institutionId,
      professionalId,
      roleInInstitution: "USER" as const,
      isGlobalAdmin: false,
    };

    expect(
      filterScheduleContextsForActor({
        actor,
        contexts: [local, otherHospital, otherSector, otherTenant, inactive],
        professional: {
          medicalSpecialtyId: 99,
          operationalProfileCode: null,
        },
        accesses: [access({ sectorId: local.sectorId })],
        managerScopes: [],
      }).map(({ id }) => id),
    ).toEqual([local.id]);
    expect(
      filterScheduleContextsForActor({
        actor,
        contexts: [local],
        professional: {
          medicalSpecialtyId: 99,
          operationalProfileCode: null,
        },
        accesses: [],
        managerScopes: [],
      }),
    ).toEqual([]);
  });

  it("descreve PINNED degradado sem undefined/null ou especialidade falsa", () => {
    const inactive = describeScheduleContext(
      context({ id: 203, medicalSpecialtyActive: false }),
      false,
    );
    const pending = describeScheduleContext(
      context({
        id: 204,
        medicalSpecialtyId: null,
        medicalSpecialtyCode: null,
        medicalSpecialtyName: null,
        medicalSpecialtyActive: null,
        operationalProfileCode: null,
      }),
      false,
    );

    expect(inactive).toMatchObject({
      qualificationCode: "CLINICAL_METADATA_INACTIVE",
      qualificationName: "Metadado clínico inativo",
      clinicalMetadataStatus: "INACTIVE",
      displayName: "Hospital São Carlos — Sala de Recuperação — Escala #203",
    });
    expect(pending).toMatchObject({
      qualificationCode: "CLINICAL_METADATA_PENDING",
      qualificationName: "Metadado clínico pendente",
      clinicalMetadataStatus: "PENDING",
      displayName: "Hospital São Carlos — Sala de Recuperação — Escala #204",
    });
    for (const current of [inactive, pending]) {
      for (const value of [
        current.qualificationCode,
        current.qualificationName,
        current.displayName,
      ]) {
        expect(value).not.toMatch(/undefined|null/i);
      }
      expect(specialtyForScheduleContextShift(current)).toBeNull();
    }
    expect(
      specialtyForScheduleContextShift(
        describeScheduleContext(context(), false),
      ),
    ).toBe("Anestesiologia");
  });

  it("não grava aviso de metadado em novas criações e preserva specialty histórico nas replicações", () => {
    const source = readFileSync("server/shifts-crud.ts", "utf8");
    expect(source).not.toContain("specialty: context.qualificationName");
    expect(source).not.toContain("specialty: activeContext.qualificationName");
    expect(
      source.match(/specialty:\s+specialtyForScheduleContextShift\(/g),
    ).toHaveLength(3);
    expect(source).not.toContain("sanitizeShiftSpecialtyMetadataLabel");
    expect(source).toContain("specialty: c.source.specialty");
    expect(source).toContain("specialty: source.specialty");
  });
});

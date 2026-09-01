import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  filterScheduleContextsForActor,
  parseScheduleContextIds,
  resolveScheduleContextAclSelection,
  shouldRewriteScheduleContextAccess,
  type ActiveScheduleContext,
  type ContextDb,
} from "../server/schedule-contexts";

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
    medicalSpecialtyCode: "ANESTESIOLOGIA",
    medicalSpecialtyName: "Anestesiologia",
    operationalProfileCode: null,
    admissionPolicy: "PINNED_QUALIFICATION",
    active: true,
    ...overrides,
  };
}

/**
 * O resolvedor seleciona com lock compartilhado e só precisa de uma consulta
 * de contextos quando os fixtures não usam QUALIFICATION_ALLOWLIST.
 */
function selectionDb(rows: ActiveScheduleContext[]): ContextDb {
  return {
    select: () => {
      const chain: any = {
        from: () => chain,
        innerJoin: () => chain,
        leftJoin: () => chain,
        where: () => chain,
        orderBy: () => chain,
        for: () => Promise.resolve(rows),
        then: (resolve: (value: ActiveScheduleContext[]) => unknown) =>
          Promise.resolve(rows).then(resolve),
      };
      return chain;
    },
  } as ContextDb;
}

function sourceBlock(source: string, start: string, end: string): string {
  const startAt = source.indexOf(start);
  const endAt = source.indexOf(end, startAt + start.length);
  expect(startAt, `âncora ausente: ${start}`).toBeGreaterThanOrEqual(0);
  expect(endAt, `âncora ausente: ${end}`).toBeGreaterThan(startAt);
  return source.slice(startAt, endAt);
}

describe("concessão administrativa de ACL por contexto", () => {
  it("concede somente o ID ativo explícito, independente do metadado de especialidade", async () => {
    const anesthesia = context();
    const generalist = context({
      id: 2,
      sectorId: 102,
      sectorName: "TRR",
      medicalSpecialtyId: null,
      medicalSpecialtyCode: null,
      medicalSpecialtyName: null,
      operationalProfileCode: "MEDICO_GENERALISTA",
    });

    await expect(
      resolveScheduleContextAclSelection({
        db: selectionDb([anesthesia, generalist]),
        institutionId: 1,
        requestedScheduleContextIds: [2],
      }),
    ).resolves.toEqual([generalist]);
  });

  it("mantém omissão fail-closed: infere uma escala, mas exige escolha com múltiplas ou nenhuma", async () => {
    const only = context();
    await expect(
      resolveScheduleContextAclSelection({
        db: selectionDb([only]),
        institutionId: 1,
        requestedScheduleContextIds: undefined,
      }),
    ).resolves.toEqual([only]);

    await expect(
      resolveScheduleContextAclSelection({
        db: selectionDb([only, context({ id: 2, sectorId: 102 })]),
        institutionId: 1,
        requestedScheduleContextIds: undefined,
      }),
    ).rejects.toThrow(/mais de uma escala ativa/i);

    await expect(
      resolveScheduleContextAclSelection({
        db: selectionDb([]),
        institutionId: 1,
        requestedScheduleContextIds: undefined,
      }),
    ).rejects.toThrow(/nenhuma escala operacional ativa/i);
  });

  it("rejeita lista explícita vazia e IDs de outro tenant", async () => {
    expect(() => parseScheduleContextIds([])).toThrow(/ao menos uma escala/i);

    const local = context();
    const otherTenant = context({
      id: 2,
      institutionId: 2,
      hospitalId: 200,
      sectorId: 201,
    });
    await expect(
      resolveScheduleContextAclSelection({
        db: selectionDb([local, otherTenant]),
        institutionId: 1,
        requestedScheduleContextIds: [2],
      }),
    ).rejects.toThrow(/inexistente, inativa ou fora do tenant/i);
  });

  it("não recria ACL por mudança isolada de especialidade", () => {
    expect(
      shouldRewriteScheduleContextAccess({
        isDoctor: true,
        requestedScheduleContextIds: undefined,
      }),
    ).toBe(false);
    expect(
      shouldRewriteScheduleContextAccess({
        isDoctor: true,
        requestedScheduleContextIds: [1],
      }),
    ).toBe(true);
    expect(
      shouldRewriteScheduleContextAccess({
        isDoctor: false,
        requestedScheduleContextIds: [1],
      }),
    ).toBe(false);
  });

  it("especialidade coincidente sem professional_access não concede leitura", () => {
    expect(
      filterScheduleContextsForActor({
        actor: {
          institutionId: 1,
          professionalId: 55,
          roleInInstitution: "USER",
          isGlobalAdmin: false,
        },
        contexts: [context()],
        professional: {
          medicalSpecialtyId: 99,
          operationalProfileCode: null,
        },
        accesses: [],
        managerScopes: [],
      }),
    ).toEqual([]);
  });

  it("impede retorno da especialidade como autoridade no resolvedor ou no update administrativo", () => {
    const contextsSource = readFileSync("server/schedule-contexts.ts", "utf8");
    const resolver = sourceBlock(
      contextsSource,
      "export async function resolveScheduleContextAclSelection",
      "export function shouldRewriteScheduleContextAccess",
    );
    const activeSelection = sourceBlock(
      contextsSource,
      "export async function selectActiveScheduleContexts",
      "export function parseScheduleContextIds",
    );
    const adminSource = readFileSync("server/routes/admin.ts", "utf8");
    const update = sourceBlock(
      adminSource,
      "const shouldRewriteScheduleAccess =",
      'if (\n                target.globalRole !== "doctor"',
    );

    expect(resolver).not.toMatch(/\bqualificationMatches\s*\(/);
    expect(resolver).not.toContain("medicalSpecialtyId");
    expect(resolver).not.toContain("operationalProfileCode");
    expect(resolver).toContain("requireQualificationConfiguration: false");
    expect(activeSelection).toContain(
      "eq(scheduleContexts.institutionId, institutionId)",
    );
    expect(activeSelection).toContain("eq(scheduleContexts.active, true)");
    expect(activeSelection).toContain(
      "eq(hospitals.institutionId, scheduleContexts.institutionId)",
    );
    expect(activeSelection).toContain(
      "eq(sectors.hospitalId, scheduleContexts.hospitalId)",
    );
    expect(update).toContain("shouldRewriteScheduleContextAccess");
    expect(update).not.toContain("qualificationUpdateRequested");
  });
});

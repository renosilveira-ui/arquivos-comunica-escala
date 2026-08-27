import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  professionalAccess,
  professionals,
  scheduleContexts,
} from "../drizzle/schema";
import {
  assertProfessionalEligibleForScheduleContext,
  qualificationMatches,
} from "../server/schedule-contexts";
import { specialtiesConflict } from "../server/specialty";

type RowsQueue = Map<unknown, unknown[][]>;

function fakeSelectDb(rowsByTable: RowsQueue) {
  return {
    select: vi.fn(() => {
      let selectedTable: unknown;
      const chain: any = {
        from(table: unknown) {
          selectedTable = table;
          return chain;
        },
        innerJoin() {
          return chain;
        },
        leftJoin() {
          return chain;
        },
        where() {
          return chain;
        },
        orderBy() {
          return chain;
        },
        limit() {
          return chain;
        },
        for() {
          return chain;
        },
        then(
          resolve: (value: unknown[]) => unknown,
          reject: (error: unknown) => unknown,
        ) {
          const queues = rowsByTable.get(selectedTable) ?? [];
          return Promise.resolve(queues.shift() ?? []).then(resolve, reject);
        },
      };
      return chain;
    }),
  };
}

function twoContextsSameSectorDb() {
  return fakeSelectDb(
    new Map([
      // 1) lock exato do contexto B; 2) catálogo ativo do tenant.
      [
        scheduleContexts,
        [
          [{ id: 202 }],
          [
            {
              id: 201,
              institutionId: 1,
              hospitalId: 10,
              hospitalName: "Hospital São Carlos",
              sectorId: 20,
              sectorName: "Sala de Recuperação",
              medicalSpecialtyId: 100,
              medicalSpecialtyCode: "ANESTESIOLOGIA",
              medicalSpecialtyName: "Qualificação exibida",
              operationalProfileCode: null,
              active: true,
            },
            {
              id: 202,
              institutionId: 1,
              hospitalId: 10,
              hospitalName: "Hospital São Carlos",
              sectorId: 20,
              sectorName: "Sala de Recuperação",
              medicalSpecialtyId: 200,
              medicalSpecialtyCode: "CLINICA_MEDICA",
              // Mesmo texto proposital: a autorização não pode usá-lo.
              medicalSpecialtyName: "Qualificação exibida",
              operationalProfileCode: null,
              active: true,
            },
          ],
        ],
      ],
      [
        professionals,
        [[{ medicalSpecialtyId: 100, operationalProfileCode: null }]],
      ],
      [
        professionalAccess,
        [
          [
            {
              institutionId: 1,
              professionalId: 55,
              hospitalId: 10,
              sectorId: 20,
              canAccess: true,
            },
          ],
        ],
      ],
    ]),
  );
}

function block(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  expect(from, `âncora inicial ausente: ${start}`).toBeGreaterThanOrEqual(0);
  expect(to, `âncora final ausente: ${end}`).toBeGreaterThan(from);
  return source.slice(from, to);
}

function expectGuardBeforeWrite(
  source: string,
  guard: string,
  write: string,
): void {
  const guardAt = source.indexOf(guard);
  const writeAt = source.indexOf(write);
  expect(guardAt, `guarda ausente: ${guard}`).toBeGreaterThanOrEqual(0);
  expect(writeAt, `escrita ausente: ${write}`).toBeGreaterThanOrEqual(0);
  expect(guardAt).toBeLessThan(writeAt);
}

describe("elegibilidade canônica em toda escrita de alocação", () => {
  it("nega contexto B com mesmo hospital/setor/texto do A antes da escrita", async () => {
    const db = twoContextsSameSectorDb();
    let writes = 0;

    await expect(
      (async () => {
        await assertProfessionalEligibleForScheduleContext({
          institutionId: 1,
          professionalId: 55,
          scheduleContextId: 202,
          db: db as any,
          lockForShare: true,
        });
        writes += 1;
      })(),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(writes).toBe(0);
  });

  it("aliases textuais conflitantes não anulam a qualificação estruturada", () => {
    expect(specialtiesConflict("Clínica Geral", "Médico generalista")).toBe(
      true,
    );
    expect(
      qualificationMatches(
        {
          medicalSpecialtyId: null,
          operationalProfileCode: "MEDICO_GENERALISTA",
        },
        {
          medicalSpecialtyId: null,
          operationalProfileCode: "MEDICO_GENERALISTA",
        },
      ),
    ).toBe(true);

    expect(specialtiesConflict("Ortopedia", "Ortopedia e Traumatologia")).toBe(
      true,
    );
    expect(
      qualificationMatches(
        { medicalSpecialtyId: 42, operationalProfileCode: null },
        { medicalSpecialtyId: 42, operationalProfileCode: null },
      ),
    ).toBe(true);
  });

  it("QUALIFICATION_ALLOWLIST aceita qualquer qualificação da lista fechada", () => {
    const context = {
      medicalSpecialtyId: null,
      operationalProfileCode: null,
      admissionPolicy: "QUALIFICATION_ALLOWLIST" as const,
      allowedQualifications: [
        { medicalSpecialtyId: 10, operationalProfileCode: null },
        {
          medicalSpecialtyId: null,
          operationalProfileCode: "RESIDENTE_ANESTESIOLOGIA" as const,
        },
      ],
    };
    expect(
      qualificationMatches(
        { medicalSpecialtyId: 10, operationalProfileCode: null },
        context,
      ),
    ).toBe(true);
    expect(
      qualificationMatches(
        {
          medicalSpecialtyId: null,
          operationalProfileCode: "RESIDENTE_ANESTESIOLOGIA",
        },
        context,
      ),
    ).toBe(true);
    expect(
      qualificationMatches(
        { medicalSpecialtyId: 99, operationalProfileCode: null },
        context,
      ),
    ).toBe(false);
  });

  it("é mutation-sensitive: assignDirect/assume/swap/nomination não voltam ao texto", () => {
    const editor = readFileSync("server/editor.ts", "utf8");
    const routers = readFileSync("server/routers.ts", "utf8");
    const confirmation = readFileSync("server/confirmation-router.ts", "utf8");
    const swap = readFileSync("server/swap-router.ts", "utf8");
    const shifts = readFileSync("server/shifts-crud.ts", "utf8");
    const validations = readFileSync("server/shift-validations-v2.ts", "utf8");

    const writeGuard = block(
      validations,
      "export async function assertAssignmentWritesAllowedForUpdate",
      "export async function assertShiftAssignmentCapacityForUpdate",
    );
    const legacyBranch = block(
      writeGuard,
      "if (candidate.scheduleContextId === null)",
      "} else {",
    );
    const structuredBranch = block(
      writeGuard,
      "} else {",
      "let activeSchedule",
    );
    expect(legacyBranch).toContain("assertSpecialtyCompatible");
    expect(structuredBranch).toContain(
      "assertProfessionalEligibleForScheduleContext",
    );
    expect(structuredBranch).toContain("assertActiveScheduleContextTopology");
    expect(structuredBranch).not.toContain("assertSpecialtyCompatible");

    const direct = block(
      editor,
      "  assignDirect: protectedProcedure",
      "  markVacant: protectedProcedure",
    );
    expect(direct).toContain(
      "scheduleContextId: lockedShift.scheduleContextId",
    );
    expectGuardBeforeWrite(
      direct,
      "assertAssignmentWritesAllowedForUpdate",
      "insert(shiftAssignmentsV2)",
    );

    const assume = block(
      routers,
      "  assumeVacancy: protectedProcedure",
      "  listPending: protectedProcedure",
    );
    expect(assume).toContain(
      "scheduleContextId: lockedShift.scheduleContextId",
    );
    expectGuardBeforeWrite(
      assume,
      "assertAssignmentWritesAllowedForUpdate",
      "insert(shiftAssignmentsV2)",
    );

    const approve = block(
      routers,
      "  approveAssignment: protectedProcedure",
      "  rejectAssignment: protectedProcedure",
    );
    expect(approve).toContain(
      "scheduleContextId: lockedAssignment.scheduleContextId",
    );
    expectGuardBeforeWrite(
      approve,
      "assertAssignmentWritesAllowedForUpdate",
      '.set({ status: "OCUPADO" })',
    );

    expect(confirmation).toContain(
      "scheduleContextId: current.shift.scheduleContextId",
    );
    expectGuardBeforeWrite(
      block(
        confirmation,
        "const replacementPro = current.replacement!",
        "const intent: TrackedPushInput",
      ),
      "assertAssignmentWritesAllowedForUpdate",
      "insert(shiftAssignmentsV2)",
    );

    const nomination = block(
      confirmation,
      "const candidateQuery = tx",
      "const TZ =",
    );
    expect(nomination).toContain(
      "if (current.shift.scheduleContextId === null)",
    );
    expectGuardBeforeWrite(
      nomination,
      "assertProfessionalEligibleForScheduleContext",
      "transitionDutyConfirmation",
    );

    const effectuate = block(
      swap,
      "async function effectuateApprovedSwap",
      "export const swapRouter",
    );
    expectGuardBeforeWrite(
      effectuate,
      "assertAssignmentWritesAllowedForUpdate",
      "insert(shiftAssignmentsV2)",
    );
    const swapQualification = block(
      swap,
      "async function assertProfessionalQualifiedForShift",
      "async function requireCanonicalAssignmentTuple",
    );
    expect(swapQualification).toContain("shift.scheduleContextId === null");
    expect(swapQualification).toContain("assertSpecialtyCompatible");
    expect(swapQualification).toContain(
      "assertProfessionalEligibleForScheduleContext",
    );
    expect(
      block(
        swap,
        "async function requireCanonicalAssignmentTuple",
        "async function requireProfessionalCanReceiveShift",
      ),
    ).toContain("assertProfessionalQualifiedForShift");
    expect(
      block(
        swap,
        "async function requireProfessionalCanReceiveShift",
        "async function requireCanonicalShiftOccupant",
      ),
    ).toContain("assertProfessionalQualifiedForShift");

    const replicate = block(
      shifts,
      "async function replicateRange(",
      "export const shiftsRouter",
    );
    expect(replicate).toContain(
      "scheduleContextId: c.source.scheduleContextId",
    );
    expectGuardBeforeWrite(
      replicate,
      "assertAssignmentWritesAllowedForUpdate",
      "insert(shiftAssignmentsV2)",
    );

    const update = block(
      shifts,
      "  update: protectedProcedure",
      "  listByPeriod: protectedProcedure",
    );
    expect(update).toContain("scheduleContextId: locked.scheduleContextId");
    expectGuardBeforeWrite(
      update,
      "assertAssignmentWritesAllowedForUpdate",
      ".update(shiftInstances)",
    );
  });
});

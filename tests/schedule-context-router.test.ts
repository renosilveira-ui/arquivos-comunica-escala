import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  managerScope,
  professionals,
  professionalAccess,
  scheduleContexts,
} from "../drizzle/schema";
import { appRouter } from "../server/routers";

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
  getTenantActorFromContext: vi.fn(),
  assertManagerScopeAccess: vi.fn(),
  getCorporateReadinessReport: vi.fn(),
}));

vi.mock("../server/db", () => ({
  getDb: mocks.getDb,
}));

vi.mock("../server/_core/policy", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../server/_core/policy")>();
  return {
    ...actual,
    getTenantActorFromContext: mocks.getTenantActorFromContext,
    assertManagerScopeAccess: mocks.assertManagerScopeAccess,
  };
});

vi.mock("../server/corporate-readiness", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../server/corporate-readiness")>();
  return {
    ...actual,
    getCorporateReadinessReport: mocks.getCorporateReadinessReport,
  };
});

function fakeSelectDb(rowsByTable: Map<unknown, unknown[]>) {
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
        then(
          resolve: (value: unknown[]) => unknown,
          reject: (error: unknown) => unknown,
        ) {
          return Promise.resolve(rowsByTable.get(selectedTable) ?? []).then(
            resolve,
            reject,
          );
        },
      };
      return chain;
    }),
  };
}

describe("scheduleContexts.listMine no appRouter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getTenantActorFromContext.mockResolvedValue({
      userId: 5,
      institutionId: 1,
      professionalId: 55,
      roleInInstitution: "USER",
      isGlobalAdmin: false,
    });
  });

  it("integra tenant, qualificação exata e professional_access em uma lista 0/1/N", async () => {
    mocks.getDb.mockResolvedValue(
      fakeSelectDb(
        new Map([
          [
            scheduleContexts,
            [
              {
                id: 1,
                institutionId: 1,
                hospitalId: 100,
                hospitalName: "Hospital São Carlos",
                sectorId: 101,
                sectorName: "Emergência",
                medicalSpecialtyId: 10,
                medicalSpecialtyCode: "CLINICA_MEDICA",
                medicalSpecialtyName: "Clínica médica",
                operationalProfileCode: null,
                active: true,
              },
              {
                id: 2,
                institutionId: 1,
                hospitalId: 100,
                hospitalName: "Hospital São Carlos",
                sectorId: 102,
                sectorName: "Sala de Recuperação",
                medicalSpecialtyId: 10,
                medicalSpecialtyCode: "CLINICA_MEDICA",
                medicalSpecialtyName: "Clínica médica",
                operationalProfileCode: null,
                active: true,
              },
              {
                id: 3,
                institutionId: 1,
                hospitalId: 100,
                hospitalName: "Hospital São Carlos",
                sectorId: 103,
                sectorName: "UTI",
                medicalSpecialtyId: 11,
                medicalSpecialtyCode: "MEDICINA_INTENSIVA",
                medicalSpecialtyName: "Medicina intensiva",
                operationalProfileCode: null,
                active: true,
              },
            ],
          ],
          [
            professionals,
            [{ medicalSpecialtyId: 10, operationalProfileCode: null }],
          ],
          [
            professionalAccess,
            [
              {
                institutionId: 1,
                professionalId: 55,
                hospitalId: 100,
                sectorId: 101,
                canAccess: true,
              },
              {
                institutionId: 1,
                professionalId: 55,
                hospitalId: 100,
                sectorId: 102,
                canAccess: true,
              },
              {
                institutionId: 1,
                professionalId: 55,
                hospitalId: 100,
                sectorId: 103,
                canAccess: true,
              },
            ],
          ],
          [managerScope, []],
        ]),
      ),
    );

    const caller = appRouter.createCaller({
      user: {
        id: 5,
        role: "doctor",
        name: "Médico teste",
        email: "medico@test.local",
        sessionVersion: 1,
      },
      institutionId: 1,
      allowedInstitutionIds: [1],
    } as any);

    const result = await caller.scheduleContexts.listMine();

    expect(result.map((row) => row.id)).toEqual([1, 2]);
    expect(result.map((row) => row.sectorName)).toEqual([
      "Emergência",
      "Sala de Recuperação",
    ]);
    expect(
      result.every((row) => row.qualificationCode === "CLINICA_MEDICA"),
    ).toBe(true);
  });

  it("listReadable inclui escalas do tenant que o USER não pratica", async () => {
    mocks.getDb.mockResolvedValue(
      fakeSelectDb(
        new Map([
          [
            scheduleContexts,
            [
              {
                id: 1,
                institutionId: 1,
                hospitalId: 100,
                hospitalName: "Hospital São Carlos",
                sectorId: 101,
                sectorName: "Emergência",
                medicalSpecialtyId: 10,
                medicalSpecialtyCode: "CLINICA_MEDICA",
                medicalSpecialtyName: "Clínica médica",
                operationalProfileCode: null,
                active: true,
              },
              {
                id: 3,
                institutionId: 1,
                hospitalId: 100,
                hospitalName: "Hospital São Carlos",
                sectorId: 103,
                sectorName: "UTI",
                medicalSpecialtyId: 11,
                medicalSpecialtyCode: "MEDICINA_INTENSIVA",
                medicalSpecialtyName: "Medicina intensiva",
                operationalProfileCode: null,
                active: true,
              },
            ],
          ],
          [
            professionals,
            [{ medicalSpecialtyId: 10, operationalProfileCode: null }],
          ],
          [
            professionalAccess,
            [
              {
                institutionId: 1,
                professionalId: 55,
                hospitalId: 100,
                sectorId: 101,
                canAccess: true,
              },
            ],
          ],
          [managerScope, []],
        ]),
      ),
    );

    const caller = appRouter.createCaller({
      user: {
        id: 5,
        role: "doctor",
        name: "Médico teste",
        email: "medico@test.local",
        sessionVersion: 1,
      },
      institutionId: 1,
      allowedInstitutionIds: [1],
    } as any);

    const mine = await caller.scheduleContexts.listMine();
    const readable = await caller.scheduleContexts.listReadable();

    expect(mine.map((row) => row.id)).toEqual([1]);
    expect(readable.map((row) => row.id)).toEqual([1, 3]);
    expect(readable.every((row) => row.canManage === false)).toBe(true);
  });
});

describe("scheduleContexts.getCorporateReadiness no appRouter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.assertManagerScopeAccess.mockResolvedValue(undefined);
    mocks.getCorporateReadinessReport.mockImplementation(
      async (
        _db: unknown,
        scope: {
          institutionId: number;
          hospitalId: number;
          sectorId?: number;
          yearMonth: string;
        },
      ) => ({
        version: "v1",
        scope,
        rosterStatus: "DRAFT",
        generatedAt: "2032-03-01T00:00:00.000Z",
        snapshotHash: "a".repeat(64),
        summary: {
          SECURITY_BLOCKER: 0,
          OPERATIONAL_WARNING: 0,
          INFO: 0,
        },
        hospitalIssues: [],
        sectors: [
          {
            sectorId: 101,
            sectorName: "Recuperação",
            metrics: {
              activeScheduleContextCount: 1,
              resolvedActiveTemplateCount: 1,
              calendarMonthShiftCount: 0,
              vacantShiftCount: 0,
              assignedShiftCount: 0,
              activeManagerCount: 1,
              eligibleProfessionalCount: 1,
              allocatedProfessionalCount: 0,
              allocatedProfessionalsWithPushTokenCount: 0,
              allocatedProfessionalsWithEmailCount: 0,
              confirmationCompatibleShiftCount: 0,
            },
            issues: [],
          },
        ],
        acknowledgement: {
          required: false,
          operationalWarningCodes: [],
        },
        integrations: {
          serviceSpecialtyMetadata: "PENDING_RELATION",
        },
        visibility: {
          detailsRedacted: false,
          hiddenSectorCount: 0,
        },
      }),
    );
  });

  it("recusa a leitura para quem não é gestor antes de consultar o banco", async () => {
    mocks.getTenantActorFromContext.mockResolvedValue({
      userId: 5,
      institutionId: 1,
      professionalId: 55,
      roleInInstitution: "USER",
      isGlobalAdmin: false,
    });
    const caller = appRouter.createCaller({
      user: {
        id: 5,
        role: "doctor",
        name: "Médico teste",
        email: "medico@test.local",
        sessionVersion: 1,
      },
      institutionId: 1,
      allowedInstitutionIds: [1],
    } as any);

    await expect(
      caller.scheduleContexts.getCorporateReadiness({
        hospitalId: 100,
        yearMonth: "2032-03",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(mocks.getDb).not.toHaveBeenCalled();
    expect(mocks.getCorporateReadinessReport).not.toHaveBeenCalled();
  });

  it("revalida escopo exato antes de gerar o relatório setorial", async () => {
    mocks.getTenantActorFromContext.mockResolvedValue({
      userId: 5,
      institutionId: 1,
      professionalId: 55,
      roleInInstitution: "GESTOR_MEDICO",
      isGlobalAdmin: false,
    });
    mocks.getDb.mockResolvedValue(
      fakeSelectDb(
        new Map([
          [
            managerScope,
            [
              {
                hospitalId: 100,
                sectorId: 101,
              },
            ],
          ],
        ]),
      ),
    );
    const caller = appRouter.createCaller({
      user: {
        id: 5,
        role: "doctor",
        name: "Gestor teste",
        email: "gestor@test.local",
        sessionVersion: 1,
      },
      institutionId: 1,
      allowedInstitutionIds: [1],
    } as any);

    const result = await caller.scheduleContexts.getCorporateReadiness({
      hospitalId: 100,
      sectorId: 101,
      yearMonth: "2032-03",
    });

    expect(mocks.assertManagerScopeAccess).toHaveBeenCalledWith(
      expect.objectContaining({ institutionId: 1, professionalId: 55 }),
      100,
      101,
      undefined,
    );
    expect(mocks.getCorporateReadinessReport).toHaveBeenCalledWith(
      expect.anything(),
      {
        institutionId: 1,
        hospitalId: 100,
        sectorId: 101,
        yearMonth: "2032-03",
      },
    );
    expect(result.reports).toHaveLength(1);
    expect(result.reports[0]?.sectors.map((sector) => sector.sectorId)).toEqual(
      [101],
    );
    expect(result.reports[0]?.visibility).toEqual({
      detailsRedacted: true,
      hiddenSectorCount: null,
    });
    expect(result.reports[0]?.snapshotHash).not.toBe("a".repeat(64));
  });
});

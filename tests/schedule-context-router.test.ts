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
});

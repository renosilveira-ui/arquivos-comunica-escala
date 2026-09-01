import { TRPCError } from "@trpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { appRouter } from "../server/routers";

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
  getTenantActorFromContext: vi.fn(),
  assertCanManageInstitutionSchedule: vi.fn(),
  assertManagerScopeAccess: vi.fn(),
  getCorporateReadinessReport: vi.fn(),
}));

vi.mock("../server/db", () => ({ getDb: mocks.getDb }));

vi.mock("../server/_core/policy", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../server/_core/policy")>();
  return {
    ...actual,
    getTenantActorFromContext: mocks.getTenantActorFromContext,
    assertCanManageInstitutionSchedule:
      mocks.assertCanManageInstitutionSchedule,
    assertManagerScopeAccess: mocks.assertManagerScopeAccess,
  };
});

vi.mock("../server/corporate-readiness-v1", () => ({
  getCorporateReadinessReport: mocks.getCorporateReadinessReport,
}));

const actor = {
  userId: 7,
  institutionId: 17,
  professionalId: 70,
  roleInInstitution: "GESTOR_MEDICO" as const,
  isGlobalAdmin: false,
};

function caller() {
  return appRouter.createCaller({
    user: {
      id: 7,
      role: "doctor",
      name: "Gestor",
      email: "gestor@test.local",
      sessionVersion: 1,
    },
    institutionId: 17,
    allowedInstitutionIds: [17],
  } as any);
}

describe("corporateReadiness.get", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.getTenantActorFromContext.mockResolvedValue(actor);
    mocks.assertCanManageInstitutionSchedule.mockReturnValue(undefined);
    mocks.assertManagerScopeAccess.mockResolvedValue(undefined);
    mocks.getDb.mockResolvedValue({ select: vi.fn() });
    mocks.getCorporateReadinessReport.mockResolvedValue({ ok: true });
  });

  it("deriva o tenant do ator e exige escopo exato quando há setor", async () => {
    await expect(
      caller().corporateReadiness.get({
        hospitalId: 171,
        sectorId: 172,
        yearMonth: "2026-09",
        institutionId: 999999,
      } as any),
    ).resolves.toEqual({ ok: true });

    expect(mocks.assertCanManageInstitutionSchedule).toHaveBeenCalledWith(
      actor,
    );
    expect(mocks.assertManagerScopeAccess).toHaveBeenCalledWith(
      actor,
      171,
      172,
    );
    expect(mocks.getCorporateReadinessReport).toHaveBeenCalledWith(
      expect.anything(),
      {
        institutionId: 17,
        hospitalId: 171,
        sectorId: 172,
        yearMonth: "2026-09",
      },
    );
  });

  it("não executa leitura se o policy negar o escopo do gestor", async () => {
    mocks.assertManagerScopeAccess.mockRejectedValue(
      new TRPCError({ code: "FORBIDDEN", message: "Setor fora da jurisdição" }),
    );

    await expect(
      caller().corporateReadiness.get({
        hospitalId: 171,
        sectorId: 999,
        yearMonth: "2026-09",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(mocks.getCorporateReadinessReport).not.toHaveBeenCalled();
  });

  it("encaminha consulta sem setor à mesma porta que exige escopo hospitalar", async () => {
    await caller().corporateReadiness.get({
      hospitalId: 171,
      yearMonth: "2026-09",
    });

    expect(mocks.assertManagerScopeAccess).toHaveBeenCalledWith(
      actor,
      171,
      undefined,
    );
    expect(mocks.getCorporateReadinessReport).toHaveBeenCalledWith(
      expect.anything(),
      {
        institutionId: 17,
        hospitalId: 171,
        yearMonth: "2026-09",
      },
    );
  });
});

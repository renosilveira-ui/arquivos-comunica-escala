import { beforeEach, describe, expect, it, vi } from "vitest";
import { TRPCError } from "@trpc/server";
import { appRouter } from "../server/routers";
import { parseInviteCode, ScheduleInviteError } from "../server/schedule-invites";

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
  getTenantActorFromContext: vi.fn(),
  listAuthorizedScheduleContexts: vi.fn(),
  selectActiveScheduleContexts: vi.fn(),
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

vi.mock("../server/schedule-contexts", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../server/schedule-contexts")>();
  return {
    ...actual,
    listAuthorizedScheduleContexts: mocks.listAuthorizedScheduleContexts,
    selectActiveScheduleContexts: mocks.selectActiveScheduleContexts,
  };
});

function caller() {
  return appRouter.createCaller({
    user: {
      id: 9,
      role: "doctor",
      name: "Gestor teste",
      email: "gestor@test.local",
      sessionVersion: 1,
    },
    institutionId: 4,
    allowedInstitutionIds: [4],
  } as never);
}

describe("scheduleInvites no appRouter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getTenantActorFromContext.mockResolvedValue({
      userId: 9,
      institutionId: 4,
      professionalId: 90,
      roleInInstitution: "GESTOR_MEDICO",
      isGlobalAdmin: false,
    });
  });

  it("recusa gerar convite de setor que o ator não gerencia", async () => {
    mocks.listAuthorizedScheduleContexts.mockResolvedValue([
      {
        hospitalId: 10,
        sectorId: 20,
        canManage: false,
      },
    ]);

    await expect(
      caller().scheduleInvites.create({ hospitalId: 10, sectorId: 20 }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
    } satisfies Partial<TRPCError>);
    expect(mocks.getDb).not.toHaveBeenCalled();
  });

  it("recusa gerar convite de escala ainda não aberta", async () => {
    mocks.listAuthorizedScheduleContexts.mockResolvedValue([
      {
        hospitalId: 10,
        sectorId: 20,
        canManage: true,
      },
    ]);
    mocks.getDb.mockResolvedValue({});
    mocks.selectActiveScheduleContexts.mockResolvedValue([]);

    await expect(
      caller().scheduleInvites.create({ hospitalId: 10, sectorId: 20 }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
    } satisfies Partial<TRPCError>);
  });

  it("parseia o código com a mesma falha fechada do resgate", () => {
    expect(parseInviteCode("abcd-efgh")).toBe("ABCDEFGH");
    expect(() => parseInviteCode("")).toThrow(ScheduleInviteError);
    expect(() => parseInviteCode("ABC")).toThrow(ScheduleInviteError);
    expect(() => parseInviteCode(12)).toThrow(ScheduleInviteError);
  });
});

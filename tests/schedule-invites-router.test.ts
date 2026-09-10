import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TRPCError } from "@trpc/server";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { appRouter } from "../server/routers";
import {
  foldCandidateSearch,
  parseInviteCode,
  ScheduleInviteError,
} from "../server/schedule-invites";

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

  afterEach(() => {
    vi.useRealTimers();
  });

  it("lista somente convites vigentes e resgatáveis do tenant e escopo gerenciado", async () => {
    const now = new Date("2026-09-10T12:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    mocks.listAuthorizedScheduleContexts.mockResolvedValue([
      { hospitalId: 10, sectorId: 20, canManage: true },
      { hospitalId: 10, sectorId: 21, canManage: false },
    ]);

    const rows = [
      {
        id: 1,
        hospitalId: 10,
        sectorId: 20,
        hospitalName: "Hospital A",
        sectorName: "Setor gerenciado",
        invitedUserId: 51,
        invitedName: "Convidado válido",
        maxRedemptions: 3,
        redeemedCount: 1,
        expiresAt: new Date("2026-09-11T12:00:00.000Z"),
        createdAt: new Date("2026-09-10T10:00:00.000Z"),
      },
      {
        id: 2,
        hospitalId: 10,
        sectorId: 21,
        hospitalName: "Hospital A",
        sectorName: "Setor não gerenciado",
        invitedUserId: 52,
        invitedName: "Convidado fora do escopo",
        maxRedemptions: 3,
        redeemedCount: 0,
        expiresAt: new Date("2026-09-11T12:00:00.000Z"),
        createdAt: new Date("2026-09-10T10:00:00.000Z"),
      },
    ];
    const where = vi.fn().mockResolvedValue(rows);
    const builder = {
      from: vi.fn(),
      innerJoin: vi.fn(),
      leftJoin: vi.fn(),
      where,
    };
    builder.from.mockReturnValue(builder);
    builder.innerJoin.mockReturnValue(builder);
    builder.leftJoin.mockReturnValue(builder);
    mocks.getDb.mockResolvedValue({
      select: vi.fn(() => builder),
    });

    await expect(caller().scheduleInvites.listActive()).resolves.toEqual([
      rows[0],
    ]);

    const query = new MySqlDialect().sqlToQuery(where.mock.calls[0]![0]);
    expect(query.sql).toContain("`schedule_invites`.`institution_id` = ?");
    expect(query.sql).toContain("`schedule_invites`.`revoked_at` is null");
    expect(query.sql).toContain("`schedule_invites`.`declined_at` is null");
    expect(query.sql).toContain("`schedule_invites`.`expires_at` > ?");
    expect(query.sql).toContain(
      "`schedule_invites`.`redeemed_count` < `schedule_invites`.`max_redemptions`",
    );
    expect(query.params).toEqual([4, "2026-09-10 12:00:00.000"]);
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
      caller().scheduleInvites.create({
        hospitalId: 10,
        sectorId: 20,
        userIds: [51],
      }),
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
      caller().scheduleInvites.create({
        hospitalId: 10,
        sectorId: 20,
        userIds: [51],
      }),
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

  it("a busca por nome ignora acento e maiúscula", () => {
    expect(foldCandidateSearch("José da Silva")).toBe("jose da silva");
    expect(foldCandidateSearch("  JOSÉ ")).toBe("jose");
    expect(foldCandidateSearch("José da Silva").includes("jose")).toBe(true);
  });
});

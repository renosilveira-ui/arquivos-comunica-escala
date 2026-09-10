import { beforeEach, describe, expect, it, vi } from "vitest";
import { TRPCError } from "@trpc/server";
import { appRouter } from "../server/routers";
import {
  foldCandidateSearch,
  parseInviteCode,
  ScheduleInviteError,
} from "../server/schedule-invites";

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
  getTenantActorFromContext: vi.fn(),
  assertManagerScopeAccessForUpdate: vi.fn(),
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
    assertManagerScopeAccessForUpdate: mocks.assertManagerScopeAccessForUpdate,
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

type RevokeInviteRow = {
  id: number;
  hospitalId: number;
  sectorId: number;
  revokedAt?: Date | null;
};

function createRevokeDb(input: {
  events: string[];
  observed?: RevokeInviteRow | null;
  locked?: RevokeInviteRow | null;
  affectedRows?: number;
}) {
  let selectCount = 0;
  const update = vi.fn(() => ({
    set: vi.fn(() => ({
      where: vi.fn(async () => {
        input.events.push("update-cas");
        return [{ affectedRows: input.affectedRows ?? 1 }];
      }),
    })),
  }));
  const select = vi.fn(() => {
    selectCount += 1;
    if (selectCount === 1) {
      return {
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(async () => {
              input.events.push("observe-tenant-target");
              return input.observed === null
                ? []
                : [
                    input.observed ?? {
                      id: 71,
                      hospitalId: 10,
                      sectorId: 20,
                    },
                  ];
            }),
          })),
        })),
      };
    }
    if (selectCount === 2) {
      return {
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(() => ({
              for: vi.fn(async (mode: string) => {
                input.events.push(`lock-${mode}`);
                return input.locked === null
                  ? []
                  : [
                      input.locked ?? {
                        id: 71,
                        hospitalId: 10,
                        sectorId: 20,
                        revokedAt: null,
                      },
                    ];
              }),
            })),
          })),
        })),
      };
    }
    throw new Error("unexpected revoke select");
  });
  const tx = { select, update };
  const db = {
    transaction: vi.fn(
      async (callback: (transaction: typeof tx) => unknown) => {
        input.events.push("transaction");
        return callback(tx);
      },
    ),
  };
  return { db, tx, update };
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
    mocks.assertManagerScopeAccessForUpdate.mockResolvedValue("GESTOR_MEDICO");
  });

  it("revoga somente após revalidar autoridade e bloquear o convite no tenant", async () => {
    const events: string[] = [];
    const { db, tx, update } = createRevokeDb({ events });
    mocks.getDb.mockResolvedValue(db);
    mocks.assertManagerScopeAccessForUpdate.mockImplementation(async () => {
      events.push("authority-for-update");
      return "GESTOR_MEDICO";
    });

    await expect(
      caller().scheduleInvites.revoke({ inviteId: 71 }),
    ).resolves.toEqual({ ok: true });

    expect(events).toEqual([
      "transaction",
      "observe-tenant-target",
      "authority-for-update",
      "lock-update",
      "update-cas",
    ]);
    expect(mocks.assertManagerScopeAccessForUpdate).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        userId: 9,
        institutionId: 4,
        professionalId: 90,
      }),
      1,
      10,
      20,
    );
    expect(update).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["sessão", "CONFLICT" as const],
    ["manager_scope", "FORBIDDEN" as const],
  ])(
    "nega revogação quando %s perde autoridade antes da escrita",
    async (_case, code) => {
      const events: string[] = [];
      const { db, tx, update } = createRevokeDb({ events });
      mocks.getDb.mockResolvedValue(db);
      mocks.assertManagerScopeAccessForUpdate.mockImplementation(async () => {
        events.push("authority-for-update");
        throw new TRPCError({ code, message: "autoridade revogada" });
      });

      await expect(
        caller().scheduleInvites.revoke({ inviteId: 71 }),
      ).rejects.toMatchObject({ code } satisfies Partial<TRPCError>);

      expect(events).toEqual([
        "transaction",
        "observe-tenant-target",
        "authority-for-update",
      ]);
      expect(mocks.assertManagerScopeAccessForUpdate).toHaveBeenCalledWith(
        tx,
        expect.any(Object),
        1,
        10,
        20,
      );
      expect(update).not.toHaveBeenCalled();
    },
  );

  it("mantém a revogação repetida idempotente sem girar o timestamp", async () => {
    const events: string[] = [];
    const { db, update } = createRevokeDb({
      events,
      locked: {
        id: 71,
        hospitalId: 10,
        sectorId: 20,
        revokedAt: new Date("2026-09-10T00:00:00.000Z"),
      },
    });
    mocks.getDb.mockResolvedValue(db);
    mocks.assertManagerScopeAccessForUpdate.mockImplementation(async () => {
      events.push("authority-for-update");
      return "GESTOR_MEDICO";
    });

    await expect(
      caller().scheduleInvites.revoke({ inviteId: 71 }),
    ).resolves.toEqual({ ok: true });
    expect(events).toEqual([
      "transaction",
      "observe-tenant-target",
      "authority-for-update",
      "lock-update",
    ]);
    expect(update).not.toHaveBeenCalled();
  });

  it("não revela nem autoriza convite ausente no tenant ativo", async () => {
    const events: string[] = [];
    const { db, update } = createRevokeDb({ events, observed: null });
    mocks.getDb.mockResolvedValue(db);

    await expect(
      caller().scheduleInvites.revoke({ inviteId: 71 }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" } satisfies Partial<TRPCError>);
    expect(events).toEqual(["transaction", "observe-tenant-target"]);
    expect(mocks.assertManagerScopeAccessForUpdate).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it("falha fechado quando o CAS não confirma exatamente uma revogação", async () => {
    const events: string[] = [];
    const { db } = createRevokeDb({ events, affectedRows: 0 });
    mocks.getDb.mockResolvedValue(db);
    mocks.assertManagerScopeAccessForUpdate.mockImplementation(async () => {
      events.push("authority-for-update");
      return "GESTOR_MEDICO";
    });

    await expect(
      caller().scheduleInvites.revoke({ inviteId: 71 }),
    ).rejects.toMatchObject({ code: "CONFLICT" } satisfies Partial<TRPCError>);
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

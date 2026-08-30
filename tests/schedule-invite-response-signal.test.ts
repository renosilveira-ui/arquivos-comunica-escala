import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  enqueueScheduleInviteAcceptedSignal,
  INVITE_ACCEPTED_PUSH_TYPE,
} from "../server/schedule-invite-response-signal";

const enqueueTrackedPushNotification = vi.hoisted(() => vi.fn());

vi.mock("../server/push-delivery", () => ({
  enqueueTrackedPushNotification: (...args: unknown[]) =>
    enqueueTrackedPushNotification(...args),
}));

function selectDb(sequence: unknown[][]) {
  let call = 0;
  const chain: {
    from: () => unknown;
    innerJoin: () => unknown;
    where: () => unknown;
    limit: () => Promise<unknown[]>;
  } = {
    from: () => chain,
    innerJoin: () => chain,
    where: () => chain,
    limit: async () => sequence[call++] ?? [],
  };
  return { select: () => chain, insert: vi.fn(), update: vi.fn() };
}

function baseInput() {
  return {
    scheduleInviteId: 91,
    institutionId: 3,
    hospitalId: 8,
    sectorId: 9,
    hospitalName: "Hospital São Carlos",
    sectorName: "Centro Cirúrgico",
    createdByUserId: 42,
    invitedUserId: 77,
  };
}

describe("sinal de convite aceito", () => {
  beforeEach(() => {
    enqueueTrackedPushNotification.mockReset();
  });

  it("enfileira intenção para o createdByUserId com copy e payload mínimo", async () => {
    enqueueTrackedPushNotification.mockResolvedValue({
      notificationId: 15,
      status: "PENDING",
      phase: "QUEUED",
    });
    const db = selectDb([
      [{ userId: 42 }],
      [{ name: "Dra. Ana Silva" }],
    ]);

    const persisted = await enqueueScheduleInviteAcceptedSignal({
      db: db as never,
      ...baseInput(),
    });

    expect(persisted).toBe(1);
    expect(enqueueTrackedPushNotification).toHaveBeenCalledTimes(1);
    expect(enqueueTrackedPushNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        institutionId: 3,
        userId: 42,
        dedupKey: "schedule-invite:91:accepted:42",
        deepLink: "/schedule-invites",
        payload: expect.objectContaining({
          title: "Convite aceito",
          body: "Dra. Ana Silva aceitou o convite para Hospital São Carlos · Centro Cirúrgico.",
          data: {
            type: INVITE_ACCEPTED_PUSH_TYPE,
            institutionId: 3,
            scheduleInviteId: 91,
            hospitalId: 8,
            sectorId: 9,
            invitedUserId: 77,
          },
        }),
      }),
      expect.any(Date),
      db,
    );
    const payload = enqueueTrackedPushNotification.mock.calls[0][0].payload;
    expect(payload.data).not.toHaveProperty("createdByUserId");
    expect(JSON.stringify(payload)).not.toMatch(/token|hash|código|codigo/i);
  });

  it("usa fallback de copy quando hospital ou setor não estão disponíveis", async () => {
    enqueueTrackedPushNotification.mockResolvedValue({
      notificationId: 16,
      status: "PENDING",
      phase: "QUEUED",
    });
    const db = selectDb([
      [{ userId: 42 }],
      [{ name: "Dr. João" }],
    ]);

    await enqueueScheduleInviteAcceptedSignal({
      db: db as never,
      ...baseInput(),
      hospitalName: "",
      sectorName: "Centro Cirúrgico",
    });

    expect(enqueueTrackedPushNotification.mock.calls[0][0].payload.body).toBe(
      "Dr. João aceitou o convite de escala.",
    );
  });

  it("não enfileira quando o criador não tem vínculo ativo no tenant", async () => {
    const db = selectDb([]);
    const persisted = await enqueueScheduleInviteAcceptedSignal({
      db: db as never,
      ...baseInput(),
    });
    expect(persisted).toBe(0);
    expect(enqueueTrackedPushNotification).not.toHaveBeenCalled();
  });

  it("não enfileira quando criador e convidado são o mesmo usuário", async () => {
    const db = selectDb([]);
    const persisted = await enqueueScheduleInviteAcceptedSignal({
      db: db as never,
      ...baseInput(),
      createdByUserId: 77,
      invitedUserId: 77,
    });
    expect(persisted).toBe(0);
    expect(enqueueTrackedPushNotification).not.toHaveBeenCalled();
  });

  it("não propaga falha ao resolver destinatário", async () => {
    const db = {
      select: () => ({
        from: () => ({
          innerJoin: () => ({
            where: () => ({
              limit: async () => {
                throw new Error("forced resolve failure");
              },
            }),
          }),
          where: () => ({
            limit: async () => [{ name: "Dra. Ana Silva" }],
          }),
        }),
      }),
    };

    await expect(
      enqueueScheduleInviteAcceptedSignal({
        db: db as never,
        ...baseInput(),
      }),
    ).resolves.toBe(0);
    expect(enqueueTrackedPushNotification).not.toHaveBeenCalled();
  });

  it("não propaga falha ao carregar nome do convidado", async () => {
    const db = {
      select: () => ({
        from: () => ({
          innerJoin: () => ({
            where: () => ({
              limit: async () => [{ userId: 42 }],
            }),
          }),
          where: () => ({
            limit: async () => {
              throw new Error("forced name failure");
            },
          }),
        }),
      }),
    };

    await expect(
      enqueueScheduleInviteAcceptedSignal({
        db: db as never,
        ...baseInput(),
      }),
    ).resolves.toBe(0);
    expect(enqueueTrackedPushNotification).not.toHaveBeenCalled();
  });

  it("não propaga falha de persistência do outbox", async () => {
    enqueueTrackedPushNotification.mockRejectedValue(new Error("forced outbox failure"));
    const db = selectDb([
      [{ userId: 42 }],
      [{ name: "Dra. Ana Silva" }],
    ]);

    const persisted = await enqueueScheduleInviteAcceptedSignal({
      db: db as never,
      ...baseInput(),
    });

    expect(persisted).toBe(0);
  });
});

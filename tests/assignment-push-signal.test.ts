import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  enqueueShiftAssignedPush,
  enqueueShiftUnassignedPush,
} from "../server/assignment-push-signal";

const enqueueTrackedPushNotification = vi.hoisted(() => vi.fn());

vi.mock("../server/push-delivery", () => ({
  enqueueTrackedPushNotification: (...args: unknown[]) =>
    enqueueTrackedPushNotification(...args),
}));

function shiftInput() {
  return {
    id: 44,
    institutionId: 3,
    hospitalId: 8,
    sectorId: 9,
    startAt: new Date("2026-09-02T10:00:00.000-03:00"),
    endAt: new Date("2026-09-02T16:00:00.000-03:00"),
  };
}

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

describe("outbox de alocação direta", () => {
  beforeEach(() => {
    enqueueTrackedPushNotification.mockReset();
  });

  it("enfileira intenção para o userId do profissional persistido", async () => {
    enqueueTrackedPushNotification.mockResolvedValue({
      notificationId: 15,
      status: "PENDING",
      phase: "QUEUED",
    });
    const db = selectDb([
      [{ userId: 77 }],
      [{ name: "Hospital São Carlos" }],
      [{ name: "Centro Cirúrgico" }],
    ]);

    const persisted = await enqueueShiftAssignedPush({
      db: db as never,
      assignmentId: 501,
      professionalId: 12,
      shift: shiftInput(),
    });

    expect(persisted).toBe(1);
    expect(enqueueTrackedPushNotification).toHaveBeenCalledTimes(1);
    expect(enqueueTrackedPushNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        institutionId: 3,
        userId: 77,
        shiftInstanceId: 44,
        dedupKey: "shift-assigned:44:12:501",
        deepLink: "/shift-details?id=44",
        payload: expect.objectContaining({
          title: "Novo plantão na sua escala",
          body: expect.stringContaining("Hospital São Carlos"),
          data: {
            type: "shift_assigned",
            institutionId: 3,
            shiftInstanceId: 44,
            assignmentId: 501,
            professionalId: 12,
            userId: 77,
          },
        }),
      }),
      expect.any(Date),
      db,
    );
    expect(enqueueTrackedPushNotification.mock.calls[0][0].payload.body).toMatch(
      /02\/09\/2026/,
    );
    expect(enqueueTrackedPushNotification.mock.calls[0][0].payload.body).toMatch(
      /10:00–16:00/,
    );
    expect(enqueueTrackedPushNotification.mock.calls[0][0].userId).not.toBe(1);
  });

  it("omite o hospital no corpo quando o nome não está disponível", async () => {
    enqueueTrackedPushNotification.mockResolvedValue({
      notificationId: 16,
      status: "PENDING",
      phase: "QUEUED",
    });
    const db = selectDb([[{ userId: 77 }], [], [{ name: "UTI" }]]);

    await enqueueShiftAssignedPush({
      db: db as never,
      assignmentId: 501,
      professionalId: 12,
      shift: shiftInput(),
    });

    expect(enqueueTrackedPushNotification.mock.calls[0][0].payload.body).toBe(
      "Você foi escalado para UTI, 02/09/2026, 10:00–16:00.",
    );
  });

  it("não enfileira quando o profissional não tem vínculo ativo no tenant", async () => {
    const db = selectDb([]);
    const persisted = await enqueueShiftAssignedPush({
      db: db as never,
      assignmentId: 501,
      professionalId: 12,
      shift: shiftInput(),
    });
    expect(persisted).toBe(0);
    expect(enqueueTrackedPushNotification).not.toHaveBeenCalled();
  });

  it("propaga falha de persistência para abortar a transação da alocação", async () => {
    enqueueTrackedPushNotification.mockRejectedValue(new Error("forced outbox failure"));
    const db = selectDb([
      [{ userId: 77 }],
      [{ name: "Hospital" }],
      [{ name: "UTI" }],
    ]);
    await expect(
      enqueueShiftAssignedPush({
        db: db as never,
        assignmentId: 501,
        professionalId: 12,
        shift: shiftInput(),
      }),
    ).rejects.toThrow(/forced outbox failure/);
  });
});

describe("outbox de remoção direta", () => {
  beforeEach(() => {
    enqueueTrackedPushNotification.mockReset();
  });

  it("enfileira intenção para o userId do profissional removido, sem userId no payload do aparelho", async () => {
    enqueueTrackedPushNotification.mockResolvedValue({
      notificationId: 21,
      status: "PENDING",
      phase: "QUEUED",
    });
    const db = selectDb([
      [{ userId: 77 }],
      [{ name: "Hospital São Carlos" }],
      [{ name: "Centro Cirúrgico" }],
    ]);

    const persisted = await enqueueShiftUnassignedPush({
      db: db as never,
      assignmentId: 501,
      professionalId: 12,
      shift: shiftInput(),
    });

    expect(persisted).toBe(1);
    expect(enqueueTrackedPushNotification).toHaveBeenCalledTimes(1);
    expect(enqueueTrackedPushNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        institutionId: 3,
        userId: 77,
        shiftInstanceId: 44,
        dedupKey: "shift-unassigned:44:12:501",
        deepLink: "/shift-details?id=44",
        payload: expect.objectContaining({
          title: "Alteração na sua escala",
          body: "Você não está mais alocado no plantão de Hospital São Carlos · Centro Cirúrgico, 02/09/2026, 10:00–16:00.",
          data: {
            type: "shift_unassigned",
            institutionId: 3,
            shiftInstanceId: 44,
            assignmentId: 501,
            professionalId: 12,
          },
        }),
      }),
      expect.any(Date),
      db,
    );
    expect(enqueueTrackedPushNotification.mock.calls[0][0].payload.data).not.toHaveProperty(
      "userId",
    );
    expect(enqueueTrackedPushNotification.mock.calls[0][0].userId).not.toBe(1);
  });

  it("omite o hospital no corpo quando o nome não está disponível", async () => {
    enqueueTrackedPushNotification.mockResolvedValue({
      notificationId: 22,
      status: "PENDING",
      phase: "QUEUED",
    });
    const db = selectDb([[{ userId: 77 }], [], [{ name: "UTI" }]]);

    await enqueueShiftUnassignedPush({
      db: db as never,
      assignmentId: 501,
      professionalId: 12,
      shift: shiftInput(),
    });

    expect(enqueueTrackedPushNotification.mock.calls[0][0].payload.body).toBe(
      "Você não está mais alocado no plantão de UTI, 02/09/2026, 10:00–16:00.",
    );
  });

  it("não enfileira quando o profissional não tem vínculo ativo no tenant", async () => {
    const db = selectDb([]);
    const persisted = await enqueueShiftUnassignedPush({
      db: db as never,
      assignmentId: 501,
      professionalId: 12,
      shift: shiftInput(),
    });
    expect(persisted).toBe(0);
    expect(enqueueTrackedPushNotification).not.toHaveBeenCalled();
  });

  it("propaga falha de persistência para abortar a transação da remoção", async () => {
    enqueueTrackedPushNotification.mockRejectedValue(new Error("forced outbox failure"));
    const db = selectDb([
      [{ userId: 77 }],
      [{ name: "Hospital" }],
      [{ name: "UTI" }],
    ]);
    await expect(
      enqueueShiftUnassignedPush({
        db: db as never,
        assignmentId: 501,
        professionalId: 12,
        shift: shiftInput(),
      }),
    ).rejects.toThrow(/forced outbox failure/);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  enqueueVacancyAvailableSignals,
  vacancyBroadcastPushCopy,
} from "../server/vacancy-broadcast-signal";
import {
  VACANCY_AVAILABLE_DEEP_LINK,
  VACANCY_AVAILABLE_PUSH_TITLE,
  vacancyBroadcastDedupKey,
} from "../lib/vacancy-broadcast";

const enqueueTrackedPushNotification = vi.hoisted(() => vi.fn());

vi.mock("../server/push-delivery", () => ({
  enqueueTrackedPushNotification: (...args: unknown[]) =>
    enqueueTrackedPushNotification(...args),
}));

function signalDb(eligibleUserIds: number[], sectorName = "Sala de Recuperação") {
  return {
    execute: async () => eligibleUserIds.map((userId) => ({ userId })),
    select: () => {
      const chain: {
        from: () => unknown;
        where: () => unknown;
        limit: () => Promise<{ name: string }[]>;
      } = {
        from: () => chain,
        where: () => chain,
        limit: async () => [{ name: sectorName }],
      };
      return chain;
    },
  };
}

const shift = {
  id: 44,
  institutionId: 3,
  hospitalId: 8,
  sectorId: 9,
  startAt: new Date("2026-09-01T22:00:00.000Z"),
  endAt: new Date("2026-09-02T10:00:00.000Z"),
  label: "Noturno",
};

describe("outbox de aviso de plantão vago", () => {
  beforeEach(() => {
    enqueueTrackedPushNotification.mockReset();
  });

  it("monta copy sem PII: setor · dd/MM · faixa horária", () => {
    expect(
      vacancyBroadcastPushCopy({
        sectorName: "SR",
        startAt: shift.startAt,
        endAt: shift.endAt,
      }),
    ).toEqual({
      title: VACANCY_AVAILABLE_PUSH_TITLE,
      body: "SR · 01/09 · 19h–07h",
    });
  });

  it("enfileira intenção rastreada para cada plantonista elegível", async () => {
    enqueueTrackedPushNotification.mockResolvedValue({
      notificationId: 1,
      status: "PENDING",
      phase: "QUEUED",
    });
    const now = new Date("2026-08-31T14:00:00.000Z");
    const persisted = await enqueueVacancyAvailableSignals({
      db: signalDb([22, 33]) as never,
      shift,
      now,
    });
    expect(persisted).toBe(2);
    expect(enqueueTrackedPushNotification).toHaveBeenCalledTimes(2);
    expect(enqueueTrackedPushNotification).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        institutionId: 3,
        userId: 22,
        shiftInstanceId: 44,
        dedupKey: vacancyBroadcastDedupKey({
          shiftInstanceId: 44,
          userId: 22,
          now,
        }),
        deepLink: VACANCY_AVAILABLE_DEEP_LINK,
        payload: expect.objectContaining({
          title: VACANCY_AVAILABLE_PUSH_TITLE,
          body: "Sala de Recuperação · 01/09 · 19h–07h",
          data: {
            type: "vacancy_available",
            institutionId: 3,
            shiftInstanceId: 44,
            userId: 22,
          },
        }),
      }),
      now,
      expect.anything(),
    );
  });

  it("não enfileira quando não há elegíveis", async () => {
    const persisted = await enqueueVacancyAvailableSignals({
      db: signalDb([]) as never,
      shift,
    });
    expect(persisted).toBe(0);
    expect(enqueueTrackedPushNotification).not.toHaveBeenCalled();
  });

  it("propaga falha de persistência (SIGNAL_TRACKING_FAILED)", async () => {
    enqueueTrackedPushNotification.mockRejectedValue(new Error("outbox down"));
    const error = console.error;
    console.error = vi.fn();
    await expect(
      enqueueVacancyAvailableSignals({
        db: signalDb([22]) as never,
        shift,
      }),
    ).rejects.toThrow("outbox down");
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("SIGNAL_TRACKING_FAILED"),
    );
    console.error = error;
  });
});

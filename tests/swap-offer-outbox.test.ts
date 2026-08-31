import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  enqueueSwapOfferSignals,
  enqueueSwapTakenSignals,
  swapOfferPushCopy,
} from "../server/swap-offer-signal";
import { SWAP_OFFER_DEEP_LINK, SWAP_OFFER_PUSH_TITLE } from "../lib/swap-offer-badge-refresh";
import type { swapRequests } from "../drizzle/schema";

const enqueueTrackedPushNotification = vi.hoisted(() => vi.fn());

vi.mock("../server/push-delivery", () => ({
  enqueueTrackedPushNotification: (...args: unknown[]) =>
    enqueueTrackedPushNotification(...args),
}));

type SwapRow = typeof swapRequests.$inferSelect;

function offerSignalDb(eligibleUserIds: number[]) {
  return {
    execute: async () => eligibleUserIds.map((userId) => ({ userId })),
    select: () => {
      throw new Error("lookup de setor não deveria ocorrer com copy completa");
    },
  };
}

function offerRow(overrides: Partial<SwapRow> = {}): SwapRow {
  return {
    id: 91,
    type: "CESSAO",
    status: "PENDING",
    fromProfessionalId: 1,
    fromUserId: 11,
    fromShiftInstanceId: 7,
    fromAssignmentId: 8,
    toProfessionalId: 2,
    toUserId: 22,
    toShiftInstanceId: null,
    toAssignmentId: null,
    reviewedByUserId: null,
    reviewedAt: null,
    reviewNote: null,
    institutionId: 3,
    hospitalId: 4,
    sectorId: 5,
    reason: null,
    expiresAt: null,
    createdAt: new Date("2026-08-28T00:00:00.000Z"),
    updatedAt: new Date("2026-08-28T00:00:00.000Z"),
    version: 0,
    ...overrides,
  };
}

function emptySelectDb() {
  const chain: { from: () => unknown; innerJoin: () => unknown; where: () => Promise<unknown[]> } =
    {
      from: () => chain,
      innerJoin: () => chain,
      where: async () => [],
    };
  return { select: () => chain };
}

describe("outbox de sinal de oferta", () => {
  beforeEach(() => {
    enqueueTrackedPushNotification.mockReset();
  });

  it("enfileira a intenção rastreada para o destinatário direcionado elegível", async () => {
    enqueueTrackedPushNotification.mockResolvedValue({
      notificationId: 1,
      status: "PENDING",
      phase: "QUEUED",
    });
    const startAt = new Date("2026-09-02T11:00:00.000Z");
    const persisted = await enqueueSwapOfferSignals({
      db: offerSignalDb([22]) as never,
      swap: offerRow(),
      shiftLabel: "Manhã",
      sectorName: "Sala de Recuperação",
      startAt,
    });
    expect(persisted).toBe(1);
    expect(enqueueTrackedPushNotification).toHaveBeenCalledTimes(1);
    expect(enqueueTrackedPushNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        institutionId: 3,
        userId: 22,
        shiftInstanceId: 7,
        dedupKey: "swap-offer:91:22",
        deepLink: SWAP_OFFER_DEEP_LINK,
        payload: expect.objectContaining({
          title: SWAP_OFFER_PUSH_TITLE,
          body: "Sala de Recuperação · Manhã · 02/09/2026 08:00",
          data: expect.objectContaining({
            type: "swap_offer",
            swapRequestId: 91,
            userId: 22,
          }),
        }),
      }),
      expect.any(Date),
      expect.anything(),
    );
  });

  it("não enfileira quando a consulta batch não devolve elegíveis", async () => {
    const persisted = await enqueueSwapOfferSignals({
      db: offerSignalDb([]) as never,
      swap: offerRow({ toProfessionalId: null, toUserId: null }),
      shiftLabel: "Manhã",
      sectorName: "UTI",
      startAt: new Date("2026-09-02T11:00:00.000Z"),
    });
    expect(persisted).toBe(0);
    expect(enqueueTrackedPushNotification).not.toHaveBeenCalled();
  });

  it("fan-out deduplica a chave por usuário e não inclui o ofertante", async () => {
    enqueueTrackedPushNotification.mockResolvedValue({
      notificationId: 1,
      status: "PENDING",
      phase: "QUEUED",
    });
    const persisted = await enqueueSwapOfferSignals({
      db: offerSignalDb([22, 22, 11, 33]) as never,
      swap: offerRow({ toProfessionalId: null, toUserId: null }),
      shiftLabel: "Manhã",
      sectorName: "UTI",
      startAt: new Date("2026-09-02T11:00:00.000Z"),
    });
    expect(persisted).toBe(2);
    const userIds = enqueueTrackedPushNotification.mock.calls.map(
      (call) => (call[0] as { userId: number }).userId,
    );
    expect(userIds).toEqual([22, 33]);
    expect(
      enqueueTrackedPushNotification.mock.calls.map(
        (call) => (call[0] as { dedupKey: string }).dedupKey,
      ),
    ).toEqual(["swap-offer:91:22", "swap-offer:91:33"]);
  });

  it("não engole falha do outbox: loga com JSON.stringify e relança", async () => {
    const failure = new Error("outbox insert failed");
    enqueueTrackedPushNotification.mockRejectedValue(failure);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      enqueueSwapOfferSignals({
        db: offerSignalDb([22]) as never,
        swap: offerRow(),
        shiftLabel: "Manhã",
        sectorName: "UTI",
        startAt: new Date("2026-09-02T11:00:00.000Z"),
      }),
    ).rejects.toBe(failure);
    expect(errorSpy).toHaveBeenCalledWith(
      `[SwapOffer] SIGNAL_TRACKING_FAILED userId=${JSON.stringify(22)} swapId=${JSON.stringify(91)}`,
    );
    errorSpy.mockRestore();
  });

  it("copy de oferta não inclui nome do ofertante", () => {
    const copy = swapOfferPushCopy({
      sectorName: "UTI",
      shiftLabel: "Noite",
      startAt: new Date("2026-09-02T11:00:00.000Z"),
    });
    expect(copy.title).toBe(SWAP_OFFER_PUSH_TITLE);
    expect(copy.body).toBe("UTI · Noite · 02/09/2026 08:00");
    expect(copy.body).not.toMatch(/Ana|ofert/);
  });

  it("enfileira o aviso de plantão assumido para o ofertante", async () => {
    enqueueTrackedPushNotification.mockResolvedValue({
      notificationId: 2,
      status: "PENDING",
      phase: "QUEUED",
    });
    const persisted = await enqueueSwapTakenSignals({
      db: emptySelectDb() as never,
      swap: offerRow(),
      takerName: "Reno",
      shiftLabel: "Manhã",
    });
    expect(persisted).toBe(1);
    expect(enqueueTrackedPushNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        institutionId: 3,
        userId: 11,
        shiftInstanceId: 7,
        dedupKey: "swap-taken:91:11",
        deepLink: "/my-offers",
        payload: expect.objectContaining({
          title: "Plantão assumido",
          body: "Reno assumiu o plantão Manhã.",
        }),
      }),
      expect.any(Date),
      expect.anything(),
    );
  });
});

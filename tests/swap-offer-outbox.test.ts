import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  enqueueSwapOfferSignals,
  enqueueSwapTakenSignals,
} from "../server/swap-offer-signal";
import type { swapRequests } from "../drizzle/schema";

const enqueueTrackedPushNotification = vi.hoisted(() => vi.fn());

vi.mock("../server/push-delivery", () => ({
  enqueueTrackedPushNotification: (...args: unknown[]) =>
    enqueueTrackedPushNotification(...args),
}));

type SwapRow = typeof swapRequests.$inferSelect;

function emptySelectDb() {
  const chain: { from: () => unknown; innerJoin: () => unknown; where: () => Promise<unknown[]> } =
    {
      from: () => chain,
      innerJoin: () => chain,
      where: async () => [],
    };
  return { select: () => chain };
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

describe("outbox de sinal de oferta", () => {
  beforeEach(() => {
    enqueueTrackedPushNotification.mockReset();
  });

  it("enfileira a intenção rastreada para o destinatário direcionado", async () => {
    enqueueTrackedPushNotification.mockResolvedValue({
      notificationId: 1,
      status: "PENDING",
      phase: "QUEUED",
    });
    const persisted = await enqueueSwapOfferSignals({
      db: emptySelectDb() as never,
      swap: offerRow(),
      offererName: "Ana",
      shiftLabel: "Manhã",
    });
    expect(persisted).toBe(1);
    expect(enqueueTrackedPushNotification).toHaveBeenCalledTimes(1);
    expect(enqueueTrackedPushNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        institutionId: 3,
        userId: 22,
        shiftInstanceId: 7,
        dedupKey: "swap-offer:91:22",
        deepLink: "/(tabs)/trocas",
        payload: expect.objectContaining({
          title: "Oferta de plantão",
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

  it("não engole falha do outbox: loga com JSON.stringify e relança", async () => {
    const failure = new Error("outbox insert failed");
    enqueueTrackedPushNotification.mockRejectedValue(failure);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      enqueueSwapOfferSignals({
        db: emptySelectDb() as never,
        swap: offerRow(),
        offererName: "Ana",
        shiftLabel: "Manhã",
      }),
    ).rejects.toBe(failure);
    expect(errorSpy).toHaveBeenCalledWith(
      `[SwapOffer] SIGNAL_TRACKING_FAILED userId=${JSON.stringify(22)} swapId=${JSON.stringify(91)}`,
    );
    errorSpy.mockRestore();
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

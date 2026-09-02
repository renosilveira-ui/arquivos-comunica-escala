import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  ACCOUNT_WIDE_BADGE_SNAPSHOT_DATA,
  isAccountWideBadgeNotificationType,
  isAccountWideBadgeSnapshotNotificationData,
  shouldRefreshAccountWideBadgeForReceivedNotification,
  shouldRefreshAccountWideBadgeForReceivedSnapshot,
  shouldRefreshAccountWideBadgeOnAppStateChange,
} from "../lib/account-wide-native-badge";
import {
  createAccountWideNativeBadgeReconcileFence,
  createAccountWideNativeBadgeReconciliationQueue,
  reconcileAccountWideNativeBadge,
  refreshAccountWideNativeBadge,
} from "../lib/account-wide-native-badge-reconcile";
import { createAccountScopedNotificationCleanupSteps } from "../lib/session-cleanup";

describe("badge nativo account-wide — reconciliação local", () => {
  it("usa somente a resposta canônica do acknowledgement", async () => {
    const acknowledge = vi.fn(async () => ({ count: 4 }));
    const getUnreadCount = vi.fn(async () => ({ count: 99 }));
    const setLocalBadgeCount = vi.fn(async () => true);

    await expect(
      reconcileAccountWideNativeBadge({
        acknowledge,
        getUnreadCount,
        setLocalBadgeCount,
        isCurrent: () => true,
      }),
    ).resolves.toEqual({
      state: "APPLIED",
      source: "ACKNOWLEDGEMENT",
      count: 4,
    });
    expect(setLocalBadgeCount).toHaveBeenCalledWith(4);
    expect(getUnreadCount).not.toHaveBeenCalled();
  });

  it("preserva a verdade do servidor se o acknowledgement falhar", async () => {
    const acknowledge = vi.fn(async () => {
      throw new Error("temporário");
    });
    const getUnreadCount = vi.fn(async () => ({ count: 7 }));
    const setLocalBadgeCount = vi.fn(async () => true);

    await expect(
      reconcileAccountWideNativeBadge({
        acknowledge,
        getUnreadCount,
        setLocalBadgeCount,
        isCurrent: () => true,
      }),
    ).resolves.toEqual({ state: "APPLIED", source: "COUNT", count: 7 });
    expect(setLocalBadgeCount).toHaveBeenCalledWith(7);
  });

  it("não zera o ícone se a mutation de acknowledgement falhar", async () => {
    const setLocalBadgeCount = vi.fn(async () => true);

    await expect(
      reconcileAccountWideNativeBadge({
        acknowledge: async () => {
          throw new Error("temporário");
        },
        getUnreadCount: async () => ({ count: 0 }),
        setLocalBadgeCount,
        isCurrent: () => true,
      }),
    ).resolves.toEqual({ state: "PRESERVED" });
    expect(setLocalBadgeCount).not.toHaveBeenCalled();
  });

  it("reconcilia snapshot foreground por contagem sem marcar alertas como lidos", async () => {
    const getUnreadCount = vi.fn(async () => ({ count: 0 }));
    const setLocalBadgeCount = vi.fn(async () => true);

    await expect(
      refreshAccountWideNativeBadge({
        getUnreadCount,
        setLocalBadgeCount,
        isCurrent: () => true,
      }),
    ).resolves.toEqual({ state: "APPLIED", source: "COUNT", count: 0 });
    expect(getUnreadCount).toHaveBeenCalledTimes(1);
    expect(setLocalBadgeCount).toHaveBeenCalledWith(0);
  });

  it("serializa acknowledgement antes de refresh foreground para não restaurar contagem antiga", async () => {
    const queue = createAccountWideNativeBadgeReconciliationQueue();
    let signalAcknowledgementStarted!: () => void;
    const acknowledgementStarted = new Promise<void>((resolve) => {
      signalAcknowledgementStarted = resolve;
    });
    let releaseAcknowledgement!: (value: { count: number }) => void;
    const acknowledge = vi.fn(() => {
      signalAcknowledgementStarted();
      return new Promise<{ count: number }>((release) => {
        releaseAcknowledgement = release;
      });
    });
    const getUnreadCount = vi.fn(async () => ({ count: 0 }));
    const setLocalBadgeCount = vi.fn(async () => true);

    const acknowledgement = queue.enqueue(() =>
      reconcileAccountWideNativeBadge({
        acknowledge,
        getUnreadCount,
        setLocalBadgeCount,
        isCurrent: () => true,
      }),
    );

    await acknowledgementStarted;
    const refresh = queue.enqueue(() =>
      refreshAccountWideNativeBadge({
        getUnreadCount,
        setLocalBadgeCount,
        isCurrent: () => true,
      }),
    );
    await Promise.resolve();
    expect(getUnreadCount).not.toHaveBeenCalled();

    releaseAcknowledgement({ count: 0 });
    await expect(acknowledgement).resolves.toEqual({
      state: "APPLIED",
      source: "ACKNOWLEDGEMENT",
      count: 0,
    });
    await expect(refresh).resolves.toEqual({
      state: "APPLIED",
      source: "COUNT",
      count: 0,
    });
    expect(getUnreadCount).toHaveBeenCalledTimes(1);
    expect(setLocalBadgeCount).toHaveBeenNthCalledWith(1, 0);
    expect(setLocalBadgeCount).toHaveBeenNthCalledWith(2, 0);
  });

  it("não escreve badge tardio depois de logout ou revogação", async () => {
    let current = true;
    const setLocalBadgeCount = vi.fn(async () => true);

    await expect(
      reconcileAccountWideNativeBadge({
        acknowledge: async () => {
          current = false;
          return { count: 3 };
        },
        getUnreadCount: async () => ({ count: 3 }),
        setLocalBadgeCount,
        isCurrent: () => current,
      }),
    ).resolves.toEqual({ state: "STALE" });
    expect(setLocalBadgeCount).not.toHaveBeenCalled();
  });

  it("serializa escrita pendente de sessão antiga antes do valor canônico novo", async () => {
    const oldSessionFence = createAccountWideNativeBadgeReconcileFence();
    const newSessionFence = createAccountWideNativeBadgeReconcileFence();
    let releaseOldWrite!: (value: boolean) => void;
    const oldWrite = new Promise<boolean>((resolve) => {
      releaseOldWrite = resolve;
    });
    let signalOldWriteStarted!: () => void;
    const oldWriteStarted = new Promise<void>((resolve) => {
      signalOldWriteStarted = resolve;
    });
    const writtenCounts: number[] = [];
    const setLocalBadgeCount = vi.fn((count: number) => {
      writtenCounts.push(count);
      if (count === 1) {
        signalOldWriteStarted();
        return oldWrite;
      }
      return Promise.resolve(true);
    });

    const oldRun = reconcileAccountWideNativeBadge({
      acknowledge: async () => ({ count: 1 }),
      getUnreadCount: async () => ({ count: 1 }),
      setLocalBadgeCount,
      isCurrent: oldSessionFence.begin(),
    });
    await oldWriteStarted;
    oldSessionFence.invalidate();

    const newRun = reconcileAccountWideNativeBadge({
      acknowledge: async () => ({ count: 0 }),
      getUnreadCount: async () => ({ count: 0 }),
      setLocalBadgeCount,
      isCurrent: newSessionFence.begin(),
    });
    await Promise.resolve();
    expect(writtenCounts).toEqual([1]);

    releaseOldWrite(true);
    await expect(oldRun).resolves.toEqual({ state: "STALE" });
    await expect(newRun).resolves.toEqual({
      state: "APPLIED",
      source: "ACKNOWLEDGEMENT",
      count: 0,
    });
    expect(writtenCounts).toEqual([1, 0]);
  });

  it("faz o clear de logout vencer escrita de reconciliação já iniciada", async () => {
    const reconciliationFence = createAccountWideNativeBadgeReconcileFence();
    let releaseOldWrite!: (value: boolean) => void;
    const oldWrite = new Promise<boolean>((resolve) => {
      releaseOldWrite = resolve;
    });
    let signalOldWriteStarted!: () => void;
    const oldWriteStarted = new Promise<void>((resolve) => {
      signalOldWriteStarted = resolve;
    });
    const writtenCounts: number[] = [];
    const setBadgeCountAsync = vi.fn((count: number): Promise<boolean> => {
      writtenCounts.push(count);
      if (count === 1) {
        signalOldWriteStarted();
        return oldWrite;
      }
      return Promise.resolve(true);
    });

    const oldRun = reconcileAccountWideNativeBadge({
      acknowledge: async () => ({ count: 1 }),
      getUnreadCount: async () => ({ count: 1 }),
      setLocalBadgeCount: setBadgeCountAsync,
      isCurrent: reconciliationFence.begin(),
    });
    await oldWriteStarted;
    reconciliationFence.invalidate();

    const [badgeCleanup] = createAccountScopedNotificationCleanupSteps(
      "ios",
      async () => ({
        setBadgeCountAsync,
        dismissAllNotificationsAsync: async () => undefined,
        cancelAllScheduledNotificationsAsync: async () => undefined,
        clearLastNotificationResponse: () => undefined,
      }),
    );
    if (!badgeCleanup) throw new Error("Etapa de badge ausente");
    const cleanup = badgeCleanup.run();
    await Promise.resolve();
    expect(writtenCounts).toEqual([1]);

    releaseOldWrite(true);
    await expect(oldRun).resolves.toEqual({ state: "STALE" });
    await expect(cleanup).resolves.toBeUndefined();
    expect(writtenCounts).toEqual([1, 0]);
  });

  it("não bloqueia a próxima reconciliação quando a API nativa rejeita", async () => {
    const firstFence = createAccountWideNativeBadgeReconcileFence();
    const secondFence = createAccountWideNativeBadgeReconcileFence();
    let attempts = 0;
    const setLocalBadgeCount = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("badge indisponível");
      return true;
    });

    await expect(
      reconcileAccountWideNativeBadge({
        acknowledge: async () => ({ count: 2 }),
        getUnreadCount: async () => ({ count: 2 }),
        setLocalBadgeCount,
        isCurrent: firstFence.begin(),
      }),
    ).resolves.toEqual({ state: "UNAVAILABLE" });

    await expect(
      reconcileAccountWideNativeBadge({
        acknowledge: async () => ({ count: 0 }),
        getUnreadCount: async () => ({ count: 0 }),
        setLocalBadgeCount,
        isCurrent: secondFence.begin(),
      }),
    ).resolves.toEqual({
      state: "APPLIED",
      source: "ACKNOWLEDGEMENT",
      count: 0,
    });
    expect(setLocalBadgeCount).toHaveBeenCalledTimes(2);
  });

  it("não deixa um clear enfileirado apagar sessão que o substituiu", async () => {
    const reconciliationFence = createAccountWideNativeBadgeReconcileFence();
    let releaseOldWrite!: (value: boolean) => void;
    const oldWrite = new Promise<boolean>((resolve) => {
      releaseOldWrite = resolve;
    });
    let signalOldWriteStarted!: () => void;
    const oldWriteStarted = new Promise<void>((resolve) => {
      signalOldWriteStarted = resolve;
    });
    const writtenCounts: number[] = [];
    const setBadgeCountAsync = vi.fn((count: number): Promise<boolean> => {
      writtenCounts.push(count);
      if (count === 1) {
        signalOldWriteStarted();
        return oldWrite;
      }
      return Promise.resolve(true);
    });

    const oldRun = reconcileAccountWideNativeBadge({
      acknowledge: async () => ({ count: 1 }),
      getUnreadCount: async () => ({ count: 1 }),
      setLocalBadgeCount: setBadgeCountAsync,
      isCurrent: reconciliationFence.begin(),
    });
    await oldWriteStarted;
    reconciliationFence.invalidate();

    let cleanupCurrent = true;
    const [badgeCleanup] = createAccountScopedNotificationCleanupSteps(
      "ios",
      async () => ({
        setBadgeCountAsync,
        dismissAllNotificationsAsync: async () => undefined,
        cancelAllScheduledNotificationsAsync: async () => undefined,
        clearLastNotificationResponse: () => undefined,
      }),
      () => cleanupCurrent,
    );
    if (!badgeCleanup) throw new Error("Etapa de badge ausente");
    const cleanup = badgeCleanup.run();
    cleanupCurrent = false;

    releaseOldWrite(true);
    await expect(oldRun).resolves.toEqual({ state: "STALE" });
    await expect(cleanup).resolves.toBeUndefined();
    expect(writtenCounts).toEqual([1]);
  });

  it("nunca converte erro ou dado inválido em badge zero", async () => {
    const setLocalBadgeCount = vi.fn(async () => true);

    await expect(
      reconcileAccountWideNativeBadge({
        acknowledge: async () => ({ count: -1 }),
        getUnreadCount: async () => ({ count: -1 }),
        setLocalBadgeCount,
        isCurrent: () => true,
      }),
    ).resolves.toEqual({ state: "UNAVAILABLE" });
    expect(setLocalBadgeCount).not.toHaveBeenCalled();
  });

  it("reconcilia somente na retomada nativa, nunca por troca de instituição", () => {
    expect(
      shouldRefreshAccountWideBadgeOnAppStateChange({
        platform: "ios",
        previousState: "background",
        nextState: "active",
      }),
    ).toBe(true);
    expect(
      shouldRefreshAccountWideBadgeOnAppStateChange({
        platform: "android",
        previousState: "active",
        nextState: "active",
      }),
    ).toBe(false);
    expect(
      shouldRefreshAccountWideBadgeOnAppStateChange({
        platform: "web",
        previousState: "background",
        nextState: "active",
      }),
    ).toBe(false);
  });

  it("usa push foreground apenas como gatilho de refresh autenticado", () => {
    expect(
      shouldRefreshAccountWideBadgeForReceivedNotification({
        recipientUserId: 31,
        currentUserId: 31,
        isSessionAuthorizationCurrent: true,
      }),
    ).toBe(true);
    expect(
      shouldRefreshAccountWideBadgeForReceivedNotification({
        recipientUserId: 32,
        currentUserId: 31,
        isSessionAuthorizationCurrent: true,
      }),
    ).toBe(false);
    expect(
      shouldRefreshAccountWideBadgeForReceivedNotification({
        recipientUserId: 31,
        currentUserId: 31,
        isSessionAuthorizationCurrent: false,
      }),
    ).toBe(false);
  });

  it("reconhece somente o marcador estático de snapshot sem identidade", () => {
    expect(
      isAccountWideBadgeSnapshotNotificationData(ACCOUNT_WIDE_BADGE_SNAPSHOT_DATA),
    ).toBe(true);
    expect(
      isAccountWideBadgeSnapshotNotificationData({
        ...ACCOUNT_WIDE_BADGE_SNAPSHOT_DATA,
        recipientUserId: 31,
      }),
    ).toBe(false);
    expect(
      isAccountWideBadgeSnapshotNotificationData({
        ...ACCOUNT_WIDE_BADGE_SNAPSHOT_DATA,
        unexpected: true,
      }),
    ).toBe(false);
    expect(
      isAccountWideBadgeSnapshotNotificationData({
        accountWideBadgeSnapshotVersion: 2,
      }),
    ).toBe(false);
    expect(
      shouldRefreshAccountWideBadgeForReceivedSnapshot({
        data: ACCOUNT_WIDE_BADGE_SNAPSHOT_DATA,
        isSessionAuthorizationCurrent: true,
      }),
    ).toBe(true);
    expect(
      shouldRefreshAccountWideBadgeForReceivedSnapshot({
        data: ACCOUNT_WIDE_BADGE_SNAPSHOT_DATA,
        isSessionAuthorizationCurrent: false,
      }),
    ).toBe(false);
  });

  it("limita o selector a tipos de alerta visíveis e o hook não depende de tenant", () => {
    expect(isAccountWideBadgeNotificationType("vacancy_available")).toBe(true);
    expect(isAccountWideBadgeNotificationType("transport_test")).toBe(false);

    const hook = readFileSync("hooks/use-account-wide-native-badge.ts", "utf8");
    expect(hook).toContain("acknowledgeAccountBadge");
    expect(hook).toContain("getUnreadAccountBadgeCount");
    expect(hook).toContain(
      "shouldRefreshAccountWideBadgeForReceivedNotification",
    );
    expect(hook).toContain("shouldRefreshAccountWideBadgeForReceivedSnapshot");
    expect(hook).toContain("refreshAccountWideNativeBadge");
    expect(hook).not.toContain("useTenantState");
    expect(hook).not.toContain("accountWideBadgeCount");
    expect(hook).not.toContain("notificationId");

    const receivedListenerStart = hook.indexOf(
      "Notifications.addNotificationReceivedListener",
    );
    const receivedListenerEnd = hook.indexOf(
      "return () =>",
      receivedListenerStart,
    );
    const receivedListener = hook.slice(
      receivedListenerStart,
      receivedListenerEnd,
    );
    expect(receivedListener).toContain("refreshCurrentAccount()");
    expect(receivedListener).not.toContain("reconcileCurrentAccount()");
  });

  it("mantém o marker interno fora do envelope enviado ao provedor", () => {
    const delivery = readFileSync("server/push-delivery.ts", "utf8");
    const submissionStart = delivery.indexOf(
      "const submission = await sendPushNotification(",
    );
    const submissionEnd = delivery.indexOf(
      "if (submissionClaimLost) return;",
      submissionStart,
    );
    const envelope = delivery.slice(submissionStart, submissionEnd);

    expect(delivery).toContain(
      "accountWideBadgeVersion: ACCOUNT_WIDE_BADGE_VERSION",
    );
    expect(envelope).toContain("data: claimed.payloadData");
    expect(envelope).not.toContain("accountWideBadgeVersion");
    expect(envelope).not.toMatch(/\\bbadge\\s*:/);
  });
});

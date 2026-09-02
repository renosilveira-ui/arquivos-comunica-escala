import { useCallback, useEffect, useRef } from "react";
import { AppState, Platform } from "react-native";
import * as Notifications from "expo-notifications";
import { trpc } from "@/lib/trpc";
import {
  createAccountWideNativeBadgeReconcileFence,
  createAccountWideNativeBadgeReconciliationQueue,
  reconcileAccountWideNativeBadge,
  refreshAccountWideNativeBadge,
  type AccountWideNativeBadgeReconcileResult,
} from "@/lib/account-wide-native-badge-reconcile";
import {
  shouldRefreshAccountWideBadgeForReceivedNotification,
  shouldRefreshAccountWideBadgeForReceivedSnapshot,
  shouldRefreshAccountWideBadgeOnAppStateChange,
} from "@/lib/account-wide-native-badge";
import { parseNotificationRecipientUserId } from "@/lib/notification-foreground-subject";

type UseAccountWideNativeBadgeOptions = Readonly<{
  userId: number | null;
  isSessionAuthorizationCurrent: () => boolean;
}>;

/**
 * Mantém o badge local preso à conta autenticada, nunca ao tenant ativo.
 *
 * Sem alterar o envelope Expo, este hook só consegue reconciliar quando o
 * app está visível. Background/killed continua dependente de decisão própria
 * sobre payload/provedor; o listener recebido abaixo usa o payload somente
 * como gatilho e fence de destinatário, nunca como origem de contagem.
 */
export function useAccountWideNativeBadge({
  userId,
  isSessionAuthorizationCurrent,
}: UseAccountWideNativeBadgeOptions): void {
  const { mutateAsync: acknowledgeAccountBadge } =
    trpc.notifications.acknowledgeAccountBadge.useMutation();
  const { refetch: refetchUnreadAccountBadgeCount } =
    trpc.notifications.getUnreadAccountBadgeCount.useQuery(undefined, {
      enabled: false,
    });
  const userIdRef = useRef<number | null>(userId);
  const sessionAuthorizationRef = useRef(isSessionAuthorizationCurrent);
  userIdRef.current = userId;
  sessionAuthorizationRef.current = isSessionAuthorizationCurrent;

  const reconcile = useCallback(
    async (
      isCurrent: () => boolean,
    ): Promise<AccountWideNativeBadgeReconcileResult> =>
      reconcileAccountWideNativeBadge({
        acknowledge: () => acknowledgeAccountBadge(),
        getUnreadCount: async () => {
          const result = await refetchUnreadAccountBadgeCount();
          if (result.error || !result.data) {
            throw result.error ?? new Error("Contagem de badge indisponível");
          }
          return result.data;
        },
        setLocalBadgeCount: (count) => Notifications.setBadgeCountAsync(count),
        isCurrent,
      }),
    [acknowledgeAccountBadge, refetchUnreadAccountBadgeCount],
  );

  const refresh = useCallback(
    async (
      isCurrent: () => boolean,
    ): Promise<AccountWideNativeBadgeReconcileResult> =>
      refreshAccountWideNativeBadge({
        getUnreadCount: async () => {
          const result = await refetchUnreadAccountBadgeCount();
          if (result.error || !result.data) {
            throw result.error ?? new Error("Contagem de badge indisponível");
          }
          return result.data;
        },
        setLocalBadgeCount: (count) => Notifications.setBadgeCountAsync(count),
        isCurrent,
      }),
    [refetchUnreadAccountBadgeCount],
  );

  useEffect(() => {
    if (
      Platform.OS === "web" ||
      userId === null ||
      !isSessionAuthorizationCurrent()
    ) {
      return undefined;
    }

    let active = true;
    const reconciliationFence = createAccountWideNativeBadgeReconcileFence();
    const reconciliationQueue =
      createAccountWideNativeBadgeReconciliationQueue();
    const isCurrentSessionRun = reconciliationFence.begin();
    const isCurrent = () =>
      active &&
      userIdRef.current === userId &&
      sessionAuthorizationRef.current() &&
      isCurrentSessionRun();
    const reconcileCurrentAccount = () => {
      void reconciliationQueue.enqueue(() => reconcile(isCurrent)).then((result) => {
        if (result.state === "UNAVAILABLE" && isCurrent()) {
          console.warn("[Notifications] ACCOUNT_BADGE_RECONCILE_UNAVAILABLE");
        }
      });
    };
    const refreshCurrentAccount = () => {
      void reconciliationQueue.enqueue(() => refresh(isCurrent)).then((result) => {
        if (result.state === "UNAVAILABLE" && isCurrent()) {
          console.warn("[Notifications] ACCOUNT_BADGE_REFRESH_UNAVAILABLE");
        }
      });
    };

    // Abertura/retomada é o acknowledgement explícito que impede acúmulo
    // indefinido se o médico dispensou a notificação no sistema operacional.
    reconcileCurrentAccount();

    const previousAppStateRef = { current: AppState.currentState };
    const appStateSubscription = AppState.addEventListener(
      "change",
      (nextState) => {
        const previousState = previousAppStateRef.current;
        previousAppStateRef.current = nextState;
        if (
          shouldRefreshAccountWideBadgeOnAppStateChange({
            platform: Platform.OS,
            previousState,
            nextState,
          })
        ) {
          reconcileCurrentAccount();
        }
      },
    );
    const receivedSubscription = Notifications.addNotificationReceivedListener(
      (notification) => {
        const data = notification.request.content.data;
        // O snapshot remoto nunca concede confiança ao próprio número. Com o
        // app em primeiro plano ele só dispara uma leitura server-side, sem
        // acknowledgement, para corrigir a fotografia eventualmente atrasada.
        if (
          shouldRefreshAccountWideBadgeForReceivedSnapshot({
            data,
            isSessionAuthorizationCurrent: isCurrent(),
          })
        ) {
          refreshCurrentAccount();
          return;
        }
        const recipientUserId = parseNotificationRecipientUserId(
          data?.recipientUserId,
        );
        if (
          !shouldRefreshAccountWideBadgeForReceivedNotification({
            recipientUserId,
            currentUserId: userId,
            isSessionAuthorizationCurrent: isCurrent(),
          })
        ) {
          return;
        }
        // Entrega push não é uma ação local do médico e pode chegar fora de
        // ordem. Mesmo o payload normal só pode atualizar a contagem
        // canônica; acknowledgement fica limitado à abertura/retomada.
        refreshCurrentAccount();
      },
    );

    return () => {
      active = false;
      reconciliationFence.invalidate();
      appStateSubscription.remove();
      receivedSubscription.remove();
    };
  }, [isSessionAuthorizationCurrent, reconcile, refresh, userId]);
}

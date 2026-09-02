import { useCallback, useEffect, useRef } from "react";
import { AppState, Platform } from "react-native";
import * as Notifications from "expo-notifications";
import { trpc } from "@/lib/trpc";
import {
  createAccountWideNativeBadgeReconcileFence,
  reconcileAccountWideNativeBadge,
  type AccountWideNativeBadgeReconcileResult,
} from "@/lib/account-wide-native-badge-reconcile";
import {
  shouldReconcileAccountWideBadgeForReceivedNotification,
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
    const isCurrent = () =>
      active &&
      userIdRef.current === userId &&
      sessionAuthorizationRef.current();
    const reconcileCurrentAccount = () => {
      const isCurrentRun = reconciliationFence.begin();
      const isCurrentForRun = () => isCurrentRun() && isCurrent();
      void reconcile(isCurrentForRun).then((result) => {
        if (result.state === "UNAVAILABLE" && isCurrentForRun()) {
          console.warn("[Notifications] ACCOUNT_BADGE_RECONCILE_UNAVAILABLE");
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
        const recipientUserId = parseNotificationRecipientUserId(
          notification.request.content.data?.recipientUserId,
        );
        if (
          !shouldReconcileAccountWideBadgeForReceivedNotification({
            recipientUserId,
            currentUserId: userId,
            isSessionAuthorizationCurrent: isCurrent(),
          })
        ) {
          return;
        }
        reconcileCurrentAccount();
      },
    );

    return () => {
      active = false;
      reconciliationFence.invalidate();
      appStateSubscription.remove();
      receivedSubscription.remove();
    };
  }, [isSessionAuthorizationCurrent, reconcile, userId]);
}

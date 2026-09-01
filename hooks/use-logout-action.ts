import { useCallback, useRef, useState } from "react";
import * as Haptics from "expo-haptics";

import { useAuth } from "@/hooks/use-auth";
import {
  logoutFailureFeedback,
  runGuardedLogoutAction,
} from "@/lib/logout-action";
import { uiAlert } from "@/lib/ui/alert";
import { confirmAction } from "@/lib/ui/confirm";

export function useLogoutAction(options: {
  scope: string;
  confirmMessage?: string;
}) {
  const { logout } = useAuth();
  const lock = useRef({ current: false });
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const confirmMessage = options.confirmMessage;

  const requestLogout = useCallback(() => {
    void runGuardedLogoutAction({
      lock: lock.current,
      logout,
      confirm:
        confirmMessage === undefined
          ? undefined
          : () => confirmAction(confirmMessage),
      onBusyChange: setIsLoggingOut,
      onSuccess: () =>
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success),
      onSuccessEffectError: (error) => {
        console.warn(`[${options.scope}] logout success haptic failed`, error);
      },
      onFailure: (error) => {
        console.warn(`[${options.scope}] logout failed`, error);
        const feedback = logoutFailureFeedback(error);
        uiAlert(feedback.title, feedback.message);
      },
    });
  }, [confirmMessage, logout, options.scope]);

  return { isLoggingOut, requestLogout } as const;
}

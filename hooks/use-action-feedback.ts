// hooks/use-action-feedback.ts — o único jeito de dar retorno de ação.
//
//   success(msg)                 → toast verde + háptico (nativo)
//   error(msg, { retry? })       → toast vermelho 5 s, com "Tentar novamente"
//   info(msg)                    → toast neutro
//   confirmDestructive(t, m, l)  → diálogo modal SÓ para ação irreversível
//
// Funciona igual em web e nativo. Substitui window.alert / Alert.alert
// espalhados pelas telas (que no web eram no-op ou modais bloqueantes).

import { useCallback, useMemo } from "react";
import { Platform } from "react-native";
import * as Haptics from "expo-haptics";
import { useToast } from "@/components/ui/Toast";
import { confirmDestructive } from "@/lib/ui/confirm";

const FALLBACK_ERROR = "Algo deu errado. Tente novamente.";

export function useActionFeedback() {
  const { show } = useToast();

  const success = useCallback(
    (message: string) => {
      if (Platform.OS !== "web") {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      }
      show(message, { tone: "success" });
    },
    [show],
  );

  const error = useCallback(
    (message: string | undefined, options?: { retry?: () => void }) => {
      if (Platform.OS !== "web") {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
      }
      show(message?.trim() || FALLBACK_ERROR, {
        tone: "danger",
        durationMs: 5000,
        action: options?.retry ? { label: "Tentar novamente", onPress: options.retry } : undefined,
      });
    },
    [show],
  );

  const info = useCallback((message: string) => show(message, { tone: "neutral" }), [show]);

  return useMemo(() => ({ success, error, info, confirmDestructive }), [success, error, info]);
}

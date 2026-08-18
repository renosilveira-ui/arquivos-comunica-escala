/**
 * Componente que escuta notificações push e roteia para a tela correta.
 * Também monta o registro do push token quando há usuário logado.
 */

import { useEffect } from "react";
import { Linking } from "react-native";
import { useRouter } from "expo-router";
import * as Notifications from "expo-notifications";
import { useAuth } from "@/hooks/use-auth";
import { useNotifications } from "@/hooks/use-notifications";

/**
 * Pede permissão de push e registra o Expo token no backend
 * (confirmations.registerPushToken). Renderizado apenas com usuário
 * logado — a mutation exige sessão. Sem este mount, NENHUM token era
 * registrado (bug descoberto no teste E2E de 2026-08-18: o hook
 * useNotifications existia mas nunca era montado).
 */
function PushTokenRegistrar() {
  useNotifications();
  return null;
}

export function NotificationListener() {
  const router = useRouter();
  const { user } = useAuth();

  useEffect(() => {
    const subscription = Notifications.addNotificationResponseReceivedListener(async (response) => {
      const data = response.notification.request.content.data;
      if (!data?.type) return;

      switch (data.type) {
        case "duty_confirmation":
          router.push({
            pathname: "/confirm-duty" as any,
            params: { token: String(data.confirmationToken ?? "") },
          });
          break;

        case "duty_nomination":
          router.push({
            pathname: "/confirm-duty" as any,
            params: { token: String(data.confirmationToken ?? "") },
          });
          break;

        case "sso_ready": {
          // Login de verdade: launch-code one-time → browser abre o
          // Comunica+ já logado (form auto-submit no servidor).
          const { openComunicaViaLaunchCode } = await import("@/lib/sso-launch");
          const result = await openComunicaViaLaunchCode();
          if (!result.ok) {
            // Fallback: abre o Comunica+ deslogado (melhor que nada) ou
            // volta pra agenda, onde o botão manual está disponível.
            if (data.comunicaUrl) {
              Linking.openURL(String(data.comunicaUrl)).catch(() => {
                router.push("/(tabs)/agenda" as any);
              });
            } else {
              router.push("/(tabs)/agenda" as any);
            }
          }
          break;
        }

        case "duty_auto_confirmed":
        case "replacement_accepted":
        case "replacement_declined":
          router.push("/(tabs)/agenda" as any);
          break;

        case "sync_error": {
          const { processIntegrationQueue } = await import("@/lib/integrationQueueProcessor");
          await processIntegrationQueue();
          break;
        }
      }
    });

    return () => {
      subscription.remove();
    };
  }, [router]);

  return user ? <PushTokenRegistrar /> : null;
}

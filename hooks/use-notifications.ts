import { useEffect, useRef, useState } from "react";
import * as Notifications from "expo-notifications";
import * as Device from "expo-device";
import { Platform } from "react-native";
import Constants from "expo-constants";
import { trpc } from "@/lib/trpc";
import { setLastPushToken } from "@/lib/push-token";

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

function pushPlatform(): "ios" | "android" | "web" {
  return Platform.OS === "ios" ? "ios" : Platform.OS === "android" ? "android" : "web";
}

function expoProjectId(): string | null {
  return Constants.expoConfig?.extra?.eas?.projectId ??
    (Constants as { easConfig?: { projectId?: string } }).easConfig?.projectId ??
    null;
}

export function useNotifications(expectedUserId: number) {
  const [expoPushToken, setExpoPushToken] = useState<string | undefined>();
  const [notification, setNotification] = useState<Notifications.Notification | undefined>();
  const notificationListener = useRef<Notifications.Subscription>(undefined!);
  const registrationGeneration = useRef(0);
  const registerMutation = trpc.confirmations.registerPushToken.useMutation();
  const registerPushToken = registerMutation.mutateAsync;

  useEffect(() => {
    const scopeGeneration = ++registrationGeneration.current;
    let active = true;
    let attemptRevision = 0;
    const isCurrent = (attempt: number) =>
      active &&
      registrationGeneration.current === scopeGeneration &&
      attemptRevision === attempt;

    const registerCurrentToken = async (token: string): Promise<void> => {
      const attempt = ++attemptRevision;
      try {
        const result = await registerPushToken({
          token,
          platform: pushPlatform(),
          expectedUserId,
        });
        // O token só se torna observável para o logout depois que o servidor
        // confirmou ownership para esta mesma sessão/geração de usuário.
        if (!isCurrent(attempt) || !result.success) return;
        setExpoPushToken(token);
        setLastPushToken(token);
      } catch {
        if (isCurrent(attempt)) console.warn("[Push] TOKEN_REGISTER_FAILED");
      }
    };

    void registerForPushNotificationsAsync()
      .then((token) => {
        if (!token || !active || registrationGeneration.current !== scopeGeneration) return;
        return registerCurrentToken(token);
      })
      // Registro de push NUNCA pode derrubar o app. O Expo lança em builds
      // instalados quando projectId/permissão/provedor estão indisponíveis.
      .catch(() => {
        if (active && registrationGeneration.current === scopeGeneration) {
          console.warn("[Push] TOKEN_SETUP_FAILED");
        }
      });

    notificationListener.current = Notifications.addNotificationReceivedListener((next) => {
      if (active && registrationGeneration.current === scopeGeneration) {
        setNotification(next);
      }
    });

    const pushTokenListener = Notifications.addPushTokenListener((devicePushToken) => {
      const projectId = expoProjectId();
      if (!projectId || !active || registrationGeneration.current !== scopeGeneration) return;
      void Notifications.getExpoPushTokenAsync({ projectId, devicePushToken })
        .then(({ data }) => {
          if (!active || registrationGeneration.current !== scopeGeneration) return;
          return registerCurrentToken(data);
        })
        .catch(() => {
          if (active && registrationGeneration.current === scopeGeneration) {
            console.warn("[Push] TOKEN_ROLLOVER_FAILED");
          }
        });
    });

    return () => {
      active = false;
      registrationGeneration.current += 1;
      notificationListener.current?.remove();
      pushTokenListener.remove();
    };
  }, [expectedUserId, registerPushToken]);

  return {
    expoPushToken,
    notification,
    scheduleNotification,
    cancelAllNotifications,
  };
}

// Agendar notificação local
export async function scheduleNotification(
  title: string,
  body: string,
  data?: any,
  trigger?: Notifications.NotificationTriggerInput,
) {
  await Notifications.scheduleNotificationAsync({
    content: {
      title,
      body,
      data,
      sound: true,
    },
    trigger: trigger || null,
  });
}

// Cancelar todas as notificações agendadas
export async function cancelAllNotifications() {
  await Notifications.cancelAllScheduledNotificationsAsync();
}

async function registerForPushNotificationsAsync(): Promise<string | undefined> {
  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync("default", {
      name: "default",
      importance: Notifications.AndroidImportance.MAX,
      vibrationPattern: [0, 250, 250, 250],
      lightColor: "#4DA3FF",
    });
  }

  if (!Device.isDevice) {
    console.warn("Deve usar um dispositivo físico para Push Notifications");
    return undefined;
  }

  const { status: existingStatus } = await Notifications.getPermissionsAsync();
  const finalStatus = existingStatus === "granted"
    ? existingStatus
    : (await Notifications.requestPermissionsAsync()).status;
  if (finalStatus !== "granted") {
    console.warn("Permissão de notificação negada");
    return undefined;
  }

  const projectId = expoProjectId();
  if (!projectId) {
    console.warn("[Push] projectId ausente — push desabilitado neste build");
    return undefined;
  }
  return (await Notifications.getExpoPushTokenAsync({ projectId })).data;
}

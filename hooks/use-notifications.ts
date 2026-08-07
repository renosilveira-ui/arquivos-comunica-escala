import { useEffect, useRef, useState } from 'react';
import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import { Platform } from 'react-native';
import Constants from 'expo-constants';
import { trpc } from '@/lib/trpc';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

export function useNotifications() {
  const [expoPushToken, setExpoPushToken] = useState<string | undefined>();
  const [notification, setNotification] = useState<Notifications.Notification | undefined>();
  const notificationListener = useRef<Notifications.Subscription>(undefined!);
  const responseListener = useRef<Notifications.Subscription>(undefined!);
  const registerMutation = trpc.confirmations.registerPushToken.useMutation();

  useEffect(() => {
    registerForPushNotificationsAsync()
      .then((token) => {
        if (!token) return;
        setExpoPushToken(token);
        const platform = Platform.OS === "ios" ? "ios" : Platform.OS === "android" ? "android" : "web";
        registerMutation.mutate(
          { token, platform },
          { onError: (err) => console.warn("[Push] Failed to register token:", err.message) },
        );
      })
      // Registro de push NUNCA pode derrubar o app: roda no mount
      // pós-login. getExpoPushTokenAsync lança em standalone builds
      // quando algo está mal configurado (ex.: projectId ausente) —
      // sem este catch a rejection ficava unhandled (crash reportado
      // pelo PO no primeiro teste iOS, 2026-08-06).
      .catch((err) => {
        console.warn("[Push] Registro de push falhou (não-fatal):", err?.message ?? err);
      });

    notificationListener.current = Notifications.addNotificationReceivedListener((n) => {
      setNotification(n);
    });

    responseListener.current = Notifications.addNotificationResponseReceivedListener((response) => {
      console.log('[Push] Notification tapped:', response.notification.request.content.data?.type);
    });

    return () => {
      notificationListener.current?.remove();
      responseListener.current?.remove();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
  trigger?: Notifications.NotificationTriggerInput
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

// Registrar para receber push notifications
async function registerForPushNotificationsAsync() {
  let token;

  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('default', {
      name: 'default',
      importance: Notifications.AndroidImportance.MAX,
      vibrationPattern: [0, 250, 250, 250],
      lightColor: '#4DA3FF',
    });
  }

  if (Device.isDevice) {
    const { status: existingStatus } = await Notifications.getPermissionsAsync();
    let finalStatus = existingStatus;
    
    if (existingStatus !== 'granted') {
      const { status } = await Notifications.requestPermissionsAsync();
      finalStatus = status;
    }
    
    if (finalStatus !== 'granted') {
      console.warn('Permissão de notificação negada');
      return;
    }

    // projectId é OBRIGATÓRIO em standalone builds (EAS) — sem ele o
    // expo-notifications lança "No projectId found". No Expo Go ele é
    // inferido, por isso o bug só aparecia em build instalado.
    const projectId =
      Constants.expoConfig?.extra?.eas?.projectId ??
      (Constants as { easConfig?: { projectId?: string } }).easConfig?.projectId;
    if (!projectId) {
      console.warn('[Push] projectId ausente — push desabilitado neste build');
      return;
    }
    token = (await Notifications.getExpoPushTokenAsync({ projectId })).data;
  } else {
    console.warn('Deve usar um dispositivo físico para Push Notifications');
  }

  return token;
}

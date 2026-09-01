import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

/** Marca navy (`theme.palette.brand[500]` / plugin expo-notifications). Sem import de theme: testes SSO mockam react-native sem Platform.select. */
const ANDROID_NOTIFICATION_COLOR = "#01304A";
const LOCAL_NEUTRAL_NOTIFICATION_TITLE = "Escala+";
const LOCAL_NEUTRAL_NOTIFICATION_BODY =
  "Há uma atualização disponível. Abra o aplicativo para consultar.";

export type AccountScopedLocalNotification = Readonly<{
  recipientUserId: number;
  data?: Readonly<Record<string, unknown>>;
}>;

function accountScopedNotificationContent(
  input: AccountScopedLocalNotification,
) {
  if (!input || !Number.isSafeInteger(input.recipientUserId) || input.recipientUserId <= 0) {
    throw new Error("Destinatário da notificação local inválido");
  }
  if (
    input.data !== undefined &&
    (typeof input.data !== "object" || input.data === null || Array.isArray(input.data))
  ) {
    throw new Error("Dados da notificação local inválidos");
  }
  return {
    // O SO pode apresentar lembrete local em background/killed sem executar o
    // handler JS. A cópia local é sempre neutra; o app busca detalhes apenas
    // depois de confirmar a sessão e o destinatário.
    title: LOCAL_NEUTRAL_NOTIFICATION_TITLE,
    body: LOCAL_NEUTRAL_NOTIFICATION_BODY,
    data: {
      ...(input.data ?? {}),
      recipientUserId: input.recipientUserId,
    },
    sound: true,
  };
}

/**
 * Solicitar permissões de notificação
 */
export async function requestNotificationPermissions(): Promise<boolean> {
  const { status: existingStatus } = await Notifications.getPermissionsAsync();
  let finalStatus = existingStatus;

  if (existingStatus !== 'granted') {
    const { status } = await Notifications.requestPermissionsAsync();
    finalStatus = status;
  }

  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('escalas-default', {
      name: 'Plantões e ofertas',
      importance: Notifications.AndroidImportance.MAX,
      vibrationPattern: [0, 250, 250, 250],
      lightColor: ANDROID_NOTIFICATION_COLOR,
    });
  }

  return finalStatus === 'granted';
}

/** Envia somente uma notificação local neutra e vinculada a uma conta. */
export async function sendLocalNotification(
  input: AccountScopedLocalNotification,
) {
  await Notifications.scheduleNotificationAsync({
    content: accountScopedNotificationContent(input),
    trigger: null, // Imediato
  });
}

/** Agenda somente uma notificação local neutra e vinculada a uma conta. */
export async function scheduleNotification(
  input: AccountScopedLocalNotification,
  date: Date,
) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new Error("Data da notificação local inválida");
  }
  await Notifications.scheduleNotificationAsync({
    content: accountScopedNotificationContent(input),
    trigger: {
      type: Notifications.SchedulableTriggerInputTypes.DATE,
      date,
    } as Notifications.DateTriggerInput,
  });
}

/**
 * Lembrete de plantão (30 minutos antes)
 */
export async function scheduleShiftReminder(
  userId: number,
  shiftDate: Date,
) {
  if (!Number.isSafeInteger(userId) || userId <= 0) {
    throw new Error("Destinatário do lembrete local inválido");
  }
  const reminderDate = new Date(shiftDate);
  reminderDate.setMinutes(reminderDate.getMinutes() - 30);
  
  // Não agendar se já passou
  if (reminderDate < new Date()) return;
  
  await scheduleNotification(
    {
      recipientUserId: userId,
      data: {
        type: 'reminder',
        shiftDate: shiftDate.toISOString(),
      },
    },
    reminderDate,
  );
}

/**
 * Cancelar todas as notificações agendadas
 */
export async function cancelAllNotifications() {
  await Notifications.cancelAllScheduledNotificationsAsync();
}

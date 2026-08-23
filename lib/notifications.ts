import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

// Configurar comportamento das notificações
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

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
    await Notifications.setNotificationChannelAsync('default', {
      name: 'Escalas Hospitalares',
      importance: Notifications.AndroidImportance.MAX,
      vibrationPattern: [0, 250, 250, 250],
      lightColor: '#4DA3FF',
    });
  }

  return finalStatus === 'granted';
}

/**
 * Enviar notificação local imediata
 */
export async function sendLocalNotification(
  title: string,
  body: string,
  data?: Record<string, any>
) {
  await Notifications.scheduleNotificationAsync({
    content: {
      title,
      body,
      data: data || {},
    },
    trigger: null, // Imediato
  });
}

/**
 * Agendar notificação para data/hora específica
 */
export async function scheduleNotification(
  title: string,
  body: string,
  date: Date,
  data?: Record<string, any>
) {
  await Notifications.scheduleNotificationAsync({
    content: {
      title,
      body,
      data: data || {},
    },
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
  sectorName: string,
  shiftDate: Date,
  shiftTime: string
) {
  const reminderDate = new Date(shiftDate);
  reminderDate.setMinutes(reminderDate.getMinutes() - 30);
  
  // Não agendar se já passou
  if (reminderDate < new Date()) return;
  
  await scheduleNotification(
    '⏰ Lembrete de Plantão',
    `Seu plantão começa em 30 minutos: ${sectorName} às ${shiftTime}`,
    reminderDate,
    { type: 'reminder', shiftDate: shiftDate.toISOString() }
  );
}

/**
 * Cancelar todas as notificações agendadas
 */
export async function cancelAllNotifications() {
  await Notifications.cancelAllScheduledNotificationsAsync();
}

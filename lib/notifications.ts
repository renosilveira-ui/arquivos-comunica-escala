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
 * Notificar sobre nova escala
 */
export async function notifyNewShift(
  sectorName: string,
  shiftDate: Date,
  shiftTime: string
) {
  const dateStr = shiftDate.toLocaleDateString('pt-BR', { 
    day: '2-digit', 
    month: 'long' 
  });
  
  await sendLocalNotification(
    '🏥 Nova Escala Disponível',
    `${sectorName} - ${dateStr} (${shiftTime})`,
    { type: 'new_shift', date: shiftDate.toISOString() }
  );
}

/**
 * Notificar sobre troca de plantão
 */
export async function notifyShiftChange(
  sectorName: string,
  oldDate: Date,
  newDate: Date
) {
  const oldDateStr = oldDate.toLocaleDateString('pt-BR', { 
    day: '2-digit', 
    month: 'short' 
  });
  const newDateStr = newDate.toLocaleDateString('pt-BR', { 
    day: '2-digit', 
    month: 'short' 
  });
  
  await sendLocalNotification(
    '🔄 Troca de Plantão',
    `${sectorName}: ${oldDateStr} → ${newDateStr}`,
    { type: 'shift_change' }
  );
}

/**
 * Notificar sobre cancelamento
 */
export async function notifyShiftCancellation(
  sectorName: string,
  shiftDate: Date,
  reason?: string
) {
  const dateStr = shiftDate.toLocaleDateString('pt-BR', { 
    day: '2-digit', 
    month: 'long' 
  });
  
  await sendLocalNotification(
    '❌ Plantão Cancelado',
    `${sectorName} - ${dateStr}${reason ? `: ${reason}` : ''}`,
    { type: 'cancellation' }
  );
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
  
  const dateStr = shiftDate.toLocaleDateString('pt-BR', { 
    day: '2-digit', 
    month: 'long' 
  });
  
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

import { getDb } from "./db";
import { pushTokens, notifications as notificationsTable } from "../drizzle/schema";
import { eq } from "drizzle-orm";

/**
 * Serviço de Notificações Push
 * Gerencia envio de notificações para usuários via Expo Push API
 */

export interface PushNotificationPayload {
  title: string;
  body: string;
  data?: Record<string, any>;
}

/**
 * Envia notificação push via Expo Push API (HTTP)
 */
async function sendExpoPushNotification(token: string, payload: PushNotificationPayload) {
  try {
    const response = await fetch("https://exp.host/--/api/v2/push/send", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        to: token,
        title: payload.title,
        body: payload.body,
        data: payload.data || {},
        sound: "default",
        priority: "high",
      }),
    });

    const result = await response.json();
    
    if (!response.ok) {
      console.error("[Push] Erro ao enviar notificação:", result);
      return false;
    }

    return true;
  } catch (error) {
    console.error("[Push] Erro ao enviar notificação:", error);
    return false;
  }
}

/**
 * Registra token de push notification para um usuário
 */
export async function registerPushToken(
  userId: number,
  token: string,
  platform: "ios" | "android" | "web"
): Promise<{ success: boolean; message: string }> {
  try {
    const db = await getDb();
    if (!db) throw new Error("Database not available");

    // Verificar se token já existe
    const existing = await db
      .select()
      .from(pushTokens)
      .where(eq(pushTokens.token, token))
      .limit(1);

    if (existing.length > 0) {
      return { success: true, message: "Token já registrado" };
    }

    // Inserir novo token
    await db.insert(pushTokens).values({
      institutionId: 1,
      userId,
      token,
      platform,
    });

    return { success: true, message: "Token registrado com sucesso" };
  } catch (error) {
    console.error("[Notifications] Erro ao registrar token:", error);
    return {
      success: false,
      message: error instanceof Error ? error.message : "Erro desconhecido",
    };
  }
}

/**
 * Envia notificação push para um usuário
 */
export async function sendPushNotification(
  userId: number,
  payload: PushNotificationPayload
): Promise<{ success: boolean; message: string }> {
  try {
    const db = await getDb();
    if (!db) throw new Error("Database not available");

    // Buscar tokens do usuário
    const tokens = await db
      .select()
      .from(pushTokens)
      .where(eq(pushTokens.userId, userId));

    if (tokens.length === 0) {
      return { success: false, message: "Nenhum token encontrado para o usuário" };
    }

    // Enviar notificação para cada token via HTTP
    const results = await Promise.all(
      tokens.map((tokenData: any) => sendExpoPushNotification(tokenData.token, payload))
    );

    const successCount = results.filter((r: any) => r === true).length;

    console.log(`[Notifications] Notificação enviada para usuário ${userId}: ${payload.title} (${successCount}/${tokens.length} dispositivos)`);

    return { 
      success: successCount > 0, 
      message: `Notificação enviada para ${successCount}/${tokens.length} dispositivo(s)` 
    };
  } catch (error) {
    console.error("[Notifications] Erro ao enviar notificação:", error);
    return {
      success: false,
      message: error instanceof Error ? error.message : "Erro desconhecido",
    };
  }
}

/**
 * Envia notificação de nova escala
 */
export async function notifyNewShift(
  userId: number,
  shiftId: number,
  sectorName: string,
  startTime: Date
): Promise<void> {
  const formattedDate = startTime.toLocaleDateString("pt-BR", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
  const formattedTime = startTime.toLocaleTimeString("pt-BR", {
    hour: "2-digit",
    minute: "2-digit",
  });

  await sendPushNotification(userId, {
    title: "Nova escala atribuída",
    body: `Você foi alocado em ${sectorName} - ${formattedDate} às ${formattedTime}`,
    data: { shiftId, type: "nova_escala" },
  });
}

/**
 * Envia notificação de mudança de escala
 */
export async function notifyShiftChange(
  userId: number,
  shiftId: number,
  changeDescription: string
): Promise<void> {
  await sendPushNotification(userId, {
    title: "Escala alterada",
    body: changeDescription,
    data: { shiftId, type: "mudanca_escala" },
  });
}

/**
 * Envia notificação de cancelamento de escala
 */
export async function notifyShiftCancellation(
  userId: number,
  shiftId: number,
  sectorName: string
): Promise<void> {
  await sendPushNotification(userId, {
    title: "Escala cancelada",
    body: `Sua escala em ${sectorName} foi cancelada`,
    data: { shiftId, type: "cancelamento_escala" },
  });
}

/**
 * Envia lembrete de início de plantão
 */
export async function notifyShiftReminder(
  userId: number,
  shiftId: number,
  sectorName: string,
  minutesBefore: number
): Promise<void> {
  await sendPushNotification(userId, {
    title: "Lembrete de plantão",
    body: `Seu plantão em ${sectorName} começa em ${minutesBefore} minutos`,
    data: { shiftId, type: "lembrete_plantao" },
  });
}

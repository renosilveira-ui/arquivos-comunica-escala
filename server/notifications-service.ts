import { and, asc, eq } from "drizzle-orm";
import { getDb } from "./db";
import { notifications as notificationsTable, pushTokens } from "../drizzle/schema";
import { recordAudit } from "./audit-trail";

export interface PushNotificationPayload {
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

type ExpoLike = {
  chunkPushNotifications: (messages: any[]) => any[][];
  sendPushNotificationsAsync: (chunk: any[]) => Promise<any[]>;
};

let dispatcherTimer: ReturnType<typeof setInterval> | null = null;

async function getExpoClient(): Promise<ExpoLike | null> {
  try {
    const moduleName = "expo-server-sdk";
    const expoModule = (await import(moduleName as string)) as any;
    if (!expoModule?.Expo) return null;
    return new expoModule.Expo();
  } catch {
    return null;
  }
}

function buildDedupKey(params: {
  institutionId: number;
  userId: number;
  shiftInstanceId?: number | null;
  reminderType?: "RADAR_11H" | "RADAR_3H" | null;
  explicitDedupKey?: string | null;
}) {
  if (params.explicitDedupKey) return params.explicitDedupKey;
  if (params.shiftInstanceId && params.reminderType) {
    return `shift:${params.shiftInstanceId}:user:${params.userId}:type:${params.reminderType}:inst:${params.institutionId}`;
  }
  return null;
}

function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as any).code === "ER_DUP_ENTRY"
  );
}

export async function enqueueNotification(params: {
  institutionId: number;
  userId: number;
  title: string;
  body: string;
  type?: "GENERAL" | "SHIFT_REMINDER";
  shiftInstanceId?: number;
  reminderType?: "RADAR_11H" | "RADAR_3H";
  deepLink?: string;
  data?: Record<string, unknown>;
  dedupKey?: string;
}): Promise<{ queued: boolean; notificationId?: number; reason?: string }> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const dedupKey = buildDedupKey({
    institutionId: params.institutionId,
    userId: params.userId,
    shiftInstanceId: params.shiftInstanceId,
    reminderType: params.reminderType ?? null,
    explicitDedupKey: params.dedupKey ?? null,
  });

  try {
    const [inserted] = await db.insert(notificationsTable).values({
      institutionId: params.institutionId,
      userId: params.userId,
      title: params.title,
      body: params.body,
      type: params.type ?? "GENERAL",
      status: "PENDING",
      shiftInstanceId: params.shiftInstanceId ?? null,
      reminderType: params.reminderType ?? null,
      dedupKey: dedupKey ?? null,
      deepLink: params.deepLink ?? null,
      providerReceipt: params.data ?? null,
      errorMessage: null,
      sentAt: null,
      read: false,
    } as any);
    return { queued: true, notificationId: (inserted as any).insertId as number };
  } catch (error) {
    if (dedupKey && isDuplicateKeyError(error)) {
      return { queued: false, reason: "duplicate" };
    }
    throw error;
  }
}

export async function enqueueShiftReminderNotification(params: {
  institutionId: number;
  userId: number;
  shiftInstanceId: number;
  reminderType: "RADAR_11H" | "RADAR_3H";
  title: string;
  body: string;
  deepLink: string;
}): Promise<{ queued: boolean; notificationId?: number; reason?: string }> {
  return enqueueNotification({
    institutionId: params.institutionId,
    userId: params.userId,
    title: params.title,
    body: params.body,
    type: "SHIFT_REMINDER",
    shiftInstanceId: params.shiftInstanceId,
    reminderType: params.reminderType,
    deepLink: params.deepLink,
  });
}

export async function registerPushToken(
  institutionId: number,
  userId: number,
  token: string,
  platform: "ios" | "android" | "web",
): Promise<{ success: boolean; message: string }> {
  try {
    const db = await getDb();
    if (!db) throw new Error("Database not available");

    const existing = await db
      .select({ id: pushTokens.id })
      .from(pushTokens)
      .where(and(eq(pushTokens.token, token), eq(pushTokens.institutionId, institutionId)))
      .limit(1);

    if (existing.length > 0) {
      return { success: true, message: "Token já registrado" };
    }

    await db.insert(pushTokens).values({
      institutionId,
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

export async function dispatchPendingNotifications(options?: { limit?: number }) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const pending = await db
    .select()
    .from(notificationsTable)
    .where(eq(notificationsTable.status, "PENDING"))
    .orderBy(asc(notificationsTable.createdAt))
    .limit(options?.limit ?? 200);

  if (pending.length === 0) {
    return { processed: 0, sent: 0, failed: 0 };
  }

  const expo = await getExpoClient();
  if (!expo) {
    for (const item of pending) {
      await db
        .update(notificationsTable)
        .set({
          status: "FAILED",
          errorMessage: "expo-server-sdk indisponível no runtime",
          sentAt: new Date(),
        })
        .where(eq(notificationsTable.id, item.id));
    }
    return { processed: pending.length, sent: 0, failed: pending.length };
  }

  const byInstitution = new Map<number, typeof pending>();
  for (const item of pending) {
    const list = byInstitution.get(item.institutionId) ?? [];
    list.push(item);
    byInstitution.set(item.institutionId, list);
  }

  let processed = 0;
  let sent = 0;
  let failed = 0;

  for (const [institutionId, notifications] of byInstitution.entries()) {
    const messages: Array<{
      notificationId: number;
      to: string;
      title: string;
      body: string;
      data: Record<string, unknown>;
      userId: number;
    }> = [];

    for (const notification of notifications) {
      const tokens = await db
        .select({ token: pushTokens.token })
        .from(pushTokens)
        .where(
          and(
            eq(pushTokens.userId, notification.userId),
            eq(pushTokens.institutionId, notification.institutionId),
          ),
        );

      if (tokens.length === 0) {
        await db
          .update(notificationsTable)
          .set({
            status: "FAILED",
            errorMessage: "Nenhum token de push encontrado para o usuário/tenant",
            sentAt: new Date(),
          })
          .where(eq(notificationsTable.id, notification.id));
        processed += 1;
        failed += 1;
        continue;
      }

      for (const tokenRow of tokens) {
        messages.push({
          notificationId: notification.id,
          to: tokenRow.token,
          title: notification.title,
          body: notification.body ?? "",
          userId: notification.userId,
          data: {
            type: notification.type,
            shiftId: notification.shiftInstanceId ?? undefined,
            url: notification.deepLink ?? undefined,
            notificationId: notification.id,
          },
        });
      }
    }

    if (messages.length === 0) continue;

    const chunks = expo.chunkPushNotifications(
      messages.map((m) => ({
        to: m.to,
        title: m.title,
        body: m.body,
        data: m.data,
        sound: "default",
        priority: "high",
      })),
    );

    const ticketMap = new Map<number, any[]>();
    let cursor = 0;

    for (const chunk of chunks) {
      const tickets = await expo.sendPushNotificationsAsync(chunk);
      for (let i = 0; i < tickets.length; i++) {
        const source = messages[cursor + i];
        if (!source) continue;
        const list = ticketMap.get(source.notificationId) ?? [];
        list.push(tickets[i]);
        ticketMap.set(source.notificationId, list);
      }
      cursor += chunk.length;
    }

    const successfulReceipts: Array<{ notificationId: number; tickets: any[] }> = [];

    for (const notification of notifications) {
      const tickets = ticketMap.get(notification.id) ?? [];
      if (tickets.length === 0) continue;

      const hasSuccess = tickets.some((t) => t?.status === "ok");
      const firstError = tickets.find((t) => t?.status !== "ok");

      await db
        .update(notificationsTable)
        .set({
          status: hasSuccess ? "SENT" : "FAILED",
          providerReceipt: tickets,
          errorMessage: hasSuccess
            ? null
            : firstError?.message || firstError?.details?.error || "Expo push error",
          sentAt: new Date(),
        } as any)
        .where(eq(notificationsTable.id, notification.id));

      processed += 1;
      if (hasSuccess) {
        sent += 1;
        successfulReceipts.push({ notificationId: notification.id, tickets });
      } else {
        failed += 1;
      }
    }

    if (successfulReceipts.length > 0) {
      const first = notifications[0]!;
      await recordAudit({
        actorUserId: first.userId,
        actorRole: "system",
        actorName: "ShiftRadarWorker",
        action: "PUSH_DISPATCHED",
        entityType: "USER",
        entityId: first.userId,
        description: `Lote de push processado (${successfulReceipts.length} notificações)`,
        institutionId,
        metadata: {
          provider: "expo",
          notifications: successfulReceipts,
        },
      });
    }
  }

  return { processed, sent, failed };
}

export function startNotificationsDispatcher(intervalMs = 60_000) {
  if (dispatcherTimer) return;
  const run = async () => {
    try {
      await dispatchPendingNotifications();
    } catch (error) {
      console.error("[NotificationsDispatcher] erro:", error);
    }
  };
  void run();
  dispatcherTimer = setInterval(() => {
    void run();
  }, intervalMs);
}

export async function sendPushNotification(
  institutionId: number,
  userId: number,
  payload: PushNotificationPayload,
): Promise<{ success: boolean; message: string }> {
  try {
    const queued = await enqueueNotification({
      institutionId,
      userId,
      title: payload.title,
      body: payload.body,
      type: "GENERAL",
      data: payload.data,
    });
    if (!queued.queued) {
      return { success: true, message: "Notificação duplicada ignorada" };
    }
    const result = await dispatchPendingNotifications({ limit: 50 });
    const success = result.sent > 0;
    return {
      success,
      message: success
        ? `Notificação enviada (${result.sent} sent / ${result.failed} failed)`
        : "Notificação enfileirada, sem entrega imediata",
    };
  } catch (error) {
    console.error("[Notifications] Erro ao enviar notificação:", error);
    return {
      success: false,
      message: error instanceof Error ? error.message : "Erro desconhecido",
    };
  }
}

export async function notifyNewShift(
  institutionId: number,
  userId: number,
  shiftId: number,
  sectorName: string,
  startTime: Date,
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

  await sendPushNotification(institutionId, userId, {
    title: "Nova escala atribuída",
    body: `Você foi alocado em ${sectorName} - ${formattedDate} às ${formattedTime}`,
    data: { shiftId, type: "nova_escala" },
  });
}

export async function notifyShiftChange(
  institutionId: number,
  userId: number,
  shiftId: number,
  changeDescription: string,
): Promise<void> {
  await sendPushNotification(institutionId, userId, {
    title: "Escala alterada",
    body: changeDescription,
    data: { shiftId, type: "mudanca_escala" },
  });
}

export async function notifyShiftCancellation(
  institutionId: number,
  userId: number,
  shiftId: number,
  sectorName: string,
): Promise<void> {
  await sendPushNotification(institutionId, userId, {
    title: "Escala cancelada",
    body: `Sua escala em ${sectorName} foi cancelada`,
    data: { shiftId, type: "cancelamento_escala" },
  });
}

export async function notifyShiftReminder(
  institutionId: number,
  userId: number,
  shiftId: number,
  sectorName: string,
  minutesBefore: number,
): Promise<void> {
  await sendPushNotification(institutionId, userId, {
    title: "Lembrete de plantão",
    body: `Seu plantão em ${sectorName} começa em ${minutesBefore} minutos`,
    data: { shiftId, type: "lembrete_plantao" },
  });
}

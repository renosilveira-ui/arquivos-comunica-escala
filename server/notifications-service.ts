import { getDb } from "./db";
import { drizzle } from "drizzle-orm/mysql2";
import { createHash } from "node:crypto";
import {
  institutions,
  professionals,
  pushTokens,
  professionalInstitutions,
  users,
} from "../drizzle/schema";
import { eq, and, inArray, isNull, sql } from "drizzle-orm";

/**
 * Serviço de Notificações Push
 * Gerencia envio de notificações para usuários via Expo Push API
 */

export interface PushNotificationPayload {
  title: string;
  body: string;
  data?: Record<string, any>;
}

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

const PUSH_TOKEN_MUTATION_LOCK_TIMEOUT_SEC = 20;

class PushTokenLockTimeoutError extends Error {}

function namedLockResultEquals(result: unknown, field: "acquired" | "released"): boolean {
  if (!Array.isArray(result)) return false;
  const rows = result[0];
  if (!Array.isArray(rows)) return false;
  const first = rows[0];
  if (typeof first !== "object" || first === null) return false;
  return Number((first as Record<string, unknown>)[field]) === 1;
}

function pushTokenLockName(token: string): string {
  const tokenHash = createHash("sha256").update(token).digest("hex").slice(0, 40);
  return `escala-push:${tokenHash}`;
}

function logPushTokenMutationFailure(operation: "REGISTER" | "UNREGISTER"): void {
  // Nunca anexar o erro: parâmetros do driver podem conter o token Expo.
  console.error(`[Notifications] PUSH_TOKEN_${operation}_FAILED`);
}

/** Serializa ownership do token entre instâncias sem registrar o token em logs. */
async function withPushTokenMutex<T>(
  db: Db,
  token: string,
  callback: (connectionDb: Db) => Promise<T>,
): Promise<T> {
  const connection = await db.$client.promise().getConnection();
  const connectionDb = drizzle(connection) as unknown as Db;
  const lockName = pushTokenLockName(token);
  let acquired = false;
  let releaseSucceeded = true;
  try {
    const lockResult = await connectionDb.execute(sql`
      SELECT GET_LOCK(${lockName}, ${PUSH_TOKEN_MUTATION_LOCK_TIMEOUT_SEC}) AS acquired
    `);
    if (!namedLockResultEquals(lockResult, "acquired")) {
      throw new PushTokenLockTimeoutError("Timeout ao serializar ownership do push token");
    }
    acquired = true;
    return await callback(connectionDb);
  } finally {
    if (acquired) {
      try {
        const releaseResult = await connectionDb.execute(sql`
          SELECT RELEASE_LOCK(${lockName}) AS released
        `);
        if (!namedLockResultEquals(releaseResult, "released")) {
          throw new Error("MySQL não confirmou a liberação do mutex do push token");
        }
      } catch {
        releaseSucceeded = false;
        console.error("[Notifications] Falha ao liberar mutex do push token");
      }
    }
    if (releaseSucceeded) {
      connection.release();
    } else {
      connection.destroy();
    }
  }
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
  platform: "ios" | "android" | "web",
  institutionId: number,
  expectedSessionVersion: number,
): Promise<{ success: boolean; message: string }> {
  try {
    const db = await getDb();
    if (!db) throw new Error("Database not available");

    return await withPushTokenMutex(db, token, async (connectionDb) =>
      connectionDb.transaction(async (tx) => {
        // A pré-leitura resolve as chaves. Autoridade só nasce sob a ordem
        // global users → professionals → PI → institution → push token.
        const [identitySnapshot] = await tx
          .select({
            membershipId: professionalInstitutions.id,
            professionalId: professionals.id,
          })
          .from(professionalInstitutions)
          .innerJoin(
            professionals,
            and(
              eq(professionals.id, professionalInstitutions.professionalId),
              eq(professionals.userId, professionalInstitutions.userId),
            ),
          )
          .where(
            and(
              eq(professionalInstitutions.userId, userId),
              eq(professionalInstitutions.institutionId, institutionId),
              eq(professionalInstitutions.active, true),
            ),
          )
          .limit(1);

        const [currentUser] = await tx
          .select({ id: users.id, sessionVersion: users.sessionVersion })
          .from(users)
          .where(
            and(
              eq(users.id, userId),
              eq(users.approvalStatus, "APPROVED"),
              isNull(users.deletedAt),
            ),
          )
          .limit(1)
          .for("update");
        const [currentProfessional] = identitySnapshot
          ? await tx
              .select({ id: professionals.id })
              .from(professionals)
              .where(
                and(
                  eq(professionals.id, identitySnapshot.professionalId),
                  eq(professionals.userId, userId),
                ),
              )
              .limit(1)
              .for("update")
          : [];
        const [membership] = identitySnapshot
          ? await tx
              .select({ id: professionalInstitutions.id })
              .from(professionalInstitutions)
              .where(
                and(
                  eq(professionalInstitutions.id, identitySnapshot.membershipId),
                  eq(professionalInstitutions.professionalId, identitySnapshot.professionalId),
                  eq(professionalInstitutions.userId, userId),
                  eq(professionalInstitutions.institutionId, institutionId),
                  eq(professionalInstitutions.active, true),
                ),
              )
              .limit(1)
              .for("update")
          : [];
        const [activeInstitution] = membership
          ? await tx
              .select({ id: institutions.id })
              .from(institutions)
              .where(
                and(
                  eq(institutions.id, institutionId),
                  eq(institutions.isActive, true),
                ),
              )
              .limit(1)
              .for("share")
          : [];

        if (
          !currentUser ||
          currentUser.sessionVersion !== expectedSessionVersion ||
          !currentProfessional ||
          !membership ||
          !activeInstitution
        ) {
          if (currentUser && currentUser.sessionVersion !== expectedSessionVersion) {
            return { success: false, message: "Sessão revogada" };
          }
          return { success: false, message: "Vínculo institucional ativo não encontrado" };
        }

        const existing = await tx
          .select()
          .from(pushTokens)
          .where(eq(pushTokens.token, token))
          .for("update");
        if (existing.length > 0) {
          const [keeper, ...duplicates] = existing.sort((left, right) => left.id - right.id);
          await tx
            .update(pushTokens)
            .set({ userId, institutionId, platform })
            .where(eq(pushTokens.id, keeper.id));
          if (duplicates.length > 0) {
            await tx
              .delete(pushTokens)
              .where(inArray(pushTokens.id, duplicates.map((row) => row.id)));
          }
          return {
            success: true,
            message:
              keeper.userId === userId && keeper.institutionId === institutionId
                ? "Token já registrado"
                : "Token associado ao usuário e tenant atuais",
          };
        }

        await tx.insert(pushTokens).values({ institutionId, userId, token, platform });
        return { success: true, message: "Token registrado com sucesso" };
      }),
    );
  } catch {
    logPushTokenMutationFailure("REGISTER");
    return { success: false, message: "Não foi possível registrar o token" };
  }
}

/** Remove o token do aparelho (logout / troca de conta). */
export async function unregisterPushToken(userId: number, token: string): Promise<{ success: boolean }> {
  const db = await getDb();
  if (!db) return { success: false };
  try {
    return await withPushTokenMutex(db, token, async (connectionDb) =>
      connectionDb.transaction(async (tx) => {
        await tx
          .delete(pushTokens)
          .where(and(eq(pushTokens.token, token), eq(pushTokens.userId, userId)));
        return { success: true };
      }),
    );
  } catch {
    logPushTokenMutationFailure("UNREGISTER");
    return { success: false };
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
  // timeZone explícito: instantes UTC formatados no fuso do hospital.
  const TZ = "America/Sao_Paulo";
  const formattedDate = startTime.toLocaleDateString("pt-BR", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: TZ,
  });
  const formattedTime = startTime.toLocaleTimeString("pt-BR", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: TZ,
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

import { getDb } from "./db";
import { createHash } from "node:crypto";
import {
  institutions,
  professionals,
  pushTokens,
  professionalInstitutions,
  users,
} from "../drizzle/schema";
import { eq, and, asc, inArray, isNull, sql } from "drizzle-orm";
import { isCanonicalDutyConfirmationRejection } from "./confirmation-integrity";
import {
  PUSH_ACCOUNT_MUTATION_LOCK_TIMEOUT_SEC,
  PushOwnershipLockTimeoutError,
  withPushAccountAndTokenMutex,
  withPushAccountAndTokenMutexes,
  withPushAccountMutex,
} from "./push-registration-revocation";

/**
 * Serviço de Notificações Push
 * Gerencia envio de notificações para usuários via Expo Push API
 */

export interface PushNotificationPayload {
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

export type PushRetryability = "RETRYABLE" | "TERMINAL";
export type PushTokenDisposition = "UNCHANGED" | "REMOVED" | "REMOVE_FAILED";

export type PushTicketEvidence =
  | {
      state: "TICKET_ACCEPTED";
      pushTokenId: number;
      ticketId: string;
      expectedUserId: number;
      tokenFingerprint: string;
    }
  | {
      state: "TICKET_REJECTED";
      pushTokenId: number;
      retryability: PushRetryability;
      failureKind:
        | "NETWORK_ERROR"
        | "HTTP_ERROR"
        | "PROVIDER_TICKET_ERROR"
        | "MALFORMED_RESPONSE"
        | "TOKEN_LOCK_TIMEOUT"
        | "TOKEN_OWNERSHIP_CHANGED"
        | "RECIPIENT_AUTHORITY_REVOKED";
      message: string;
      httpStatus?: number;
      providerCode?: string;
      tokenDisposition: PushTokenDisposition;
    };

interface PushSendResultBase {
  message: string;
  tickets: PushTicketEvidence[];
  acceptedCount: number;
  rejectedCount: number;
}

export type PushSendResult =
  | (PushSendResultBase & { status: "TICKETS_ACCEPTED" })
  | (PushSendResultBase & { status: "PARTIAL_TICKET_ACCEPTANCE" })
  | (PushSendResultBase & { status: "ALL_TICKETS_REJECTED" })
  | (PushSendResultBase & { status: "NO_REGISTERED_TOKENS" })
  | (PushSendResultBase & { status: "SERVICE_ERROR" });

export interface ExpoReceiptTarget {
  ticketId: string;
  pushTokenId: number;
  expectedUserId: number;
  tokenFingerprint: string;
}

export type PushReceiptEvidence =
  | {
      state: "PROVIDER_ACCEPTED";
      ticketId: string;
      pushTokenId: number;
    }
  | {
      state: "RECEIPT_PENDING";
      ticketId: string;
      pushTokenId: number;
    }
  | {
      state: "RECEIPT_REJECTED";
      ticketId: string;
      pushTokenId: number;
      retryability: PushRetryability;
      message: string;
      providerCode?: string;
      tokenDisposition: PushTokenDisposition;
    }
  | {
      state: "RECEIPT_LOOKUP_FAILED";
      ticketId: string;
      pushTokenId: number;
      retryability: PushRetryability;
      failureKind: "NETWORK_ERROR" | "HTTP_ERROR" | "MALFORMED_RESPONSE";
      message: string;
      httpStatus?: number;
      providerCode?: string;
    };

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;
type TokenTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
type TokenMutationDb = Pick<Db, "delete"> | Pick<TokenTransaction, "delete">;
export type PushSubmissionGuard = (tx: TokenTransaction) => Promise<void>;
type JsonRecord = Record<string, unknown>;

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
const EXPO_RECEIPTS_URL = "https://exp.host/--/api/v2/push/getReceipts";
const EXPO_RECEIPT_BATCH_SIZE = 1_000;
const EXPO_HTTP_TIMEOUT_MS = 15_000;
// Um owner do outbox precisa conservar o claim durante todo fetch Expo.
// O lease renovado usa este horizonte (timeout + margem), nunca só o lease
// curto injetado em testes.
export const PUSH_SUBMISSION_LEASE_HORIZON_MS = EXPO_HTTP_TIMEOUT_MS + 5_000;
const PUSH_SEND_LOCK_TIMEOUT_SEC = 5;
const PUSH_TOKEN_MUTATION_LOCK_TIMEOUT_SEC = Math.ceil(EXPO_HTTP_TIMEOUT_MS / 1_000) + 5;
// O pool possui 10 conexões. Cada submissão mantém uma conexão dedicada para
// o advisory lock durante a rede; quatro slots preservam capacidade para
// logout, registro, cron e tráfego clínico concorrente.
const MAX_CONCURRENT_EXPO_SUBMISSIONS = 4;
const PUSH_NETWORK_ERROR_MESSAGE = "Falha temporária ao contatar Expo Push";
const PUSH_OWNERSHIP_ERROR_MESSAGE = "Falha temporária ao validar ownership do token";
const PUSH_SERVICE_ERROR_MESSAGE = "Serviço de push temporariamente indisponível";
const RECEIPT_NETWORK_ERROR_MESSAGE = "Falha temporária ao consultar Expo Receipts";
const RECIPIENT_AUTHORITY_REVOKED_MESSAGE = "Autoridade do destinatário revogada";
let activeExpoSubmissions = 0;
const expoSubmissionWaiters: (() => void)[] = [];

async function acquireExpoSubmissionSlot(): Promise<void> {
  if (activeExpoSubmissions < MAX_CONCURRENT_EXPO_SUBMISSIONS) {
    activeExpoSubmissions += 1;
    return;
  }
  await new Promise<void>((resolve) => expoSubmissionWaiters.push(resolve));
}

function releaseExpoSubmissionSlot(): void {
  const next = expoSubmissionWaiters.shift();
  if (next) {
    // O slot passa diretamente ao próximo waiter; o contador não oscila.
    next();
    return;
  }
  activeExpoSubmissions -= 1;
}

async function withExpoSubmissionSlot<T>(callback: () => Promise<T>): Promise<T> {
  await acquireExpoSubmissionSlot();
  try {
    return await callback();
  } finally {
    releaseExpoSubmissionSlot();
  }
}

function asRecord(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function nestedProviderCode(value: unknown): string | undefined {
  const details = asRecord(asRecord(value)?.details);
  return typeof details?.error === "string" ? details.error : undefined;
}

function firstProviderError(body: unknown): JsonRecord | null {
  const errors = asRecord(body)?.errors;
  if (!Array.isArray(errors)) return null;
  return asRecord(errors[0]);
}

function retryabilityForHttp(status: number): PushRetryability {
  return status === 408 || status === 425 || status === 429 || status >= 500
    ? "RETRYABLE"
    : "TERMINAL";
}

function retryabilityForProviderCode(code?: string): PushRetryability {
  return code === "MessageRateExceeded" || code === "TOO_MANY_REQUESTS"
    ? "RETRYABLE"
    : "TERMINAL";
}

function pushTokenFingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function isCanonicalExpoPushToken(token: unknown): token is string {
  return typeof token === "string" &&
    token.length > 0 &&
    token.length <= 512 &&
    token.trim() === token &&
    !/\s/.test(token);
}

function mutationAffectedRows(result: unknown): number {
  if (Array.isArray(result)) {
    return Number((result[0] as { affectedRows?: unknown } | undefined)?.affectedRows ?? 0);
  }
  return Number((result as { affectedRows?: unknown } | null)?.affectedRows ?? 0);
}

async function removeInvalidPushToken(
  db: TokenMutationDb | null,
  expected: Pick<ExpoReceiptTarget, "pushTokenId" | "expectedUserId" | "tokenFingerprint">,
): Promise<PushTokenDisposition> {
  if (!db) return "REMOVE_FAILED";
  try {
    const result = await db.delete(pushTokens).where(
      and(
        eq(pushTokens.id, expected.pushTokenId),
        eq(pushTokens.userId, expected.expectedUserId),
        sql`SHA2(${pushTokens.token}, 256) = ${expected.tokenFingerprint}`,
      ),
    );
    return mutationAffectedRows(result) === 1 ? "REMOVED" : "UNCHANGED";
  } catch {
    console.error(`[Push] REMOVE_INVALID_TOKEN_FAILED pushTokenId=${expected.pushTokenId}`);
    return "REMOVE_FAILED";
  }
}

async function removeInvalidPushTokenFromReceipt(
  db: Db | null,
  expected: ExpoReceiptTarget,
): Promise<PushTokenDisposition> {
  if (!db) return "REMOVE_FAILED";
  try {
    return await withPushAccountMutex(
      db,
      expected.expectedUserId,
      PUSH_ACCOUNT_MUTATION_LOCK_TIMEOUT_SEC,
      (connectionDb) => removeInvalidPushToken(connectionDb, expected),
    );
  } catch {
    console.error(`[Push] REMOVE_INVALID_TOKEN_LOCK_FAILED pushTokenId=${expected.pushTokenId}`);
    return "REMOVE_FAILED";
  }
}

function logPushTokenMutationFailure(operation: "REGISTER" | "UNREGISTER"): void {
  // DrizzleQueryError inclui query, params e cause na própria mensagem. Nunca
  // anexar o erro aqui: params podem conter o token Expo em claro.
  console.error(`[Notifications] PUSH_TOKEN_${operation}_FAILED`);
}


async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/**
 * Submete uma mensagem ao Expo e retorna somente evidência de ticket.
 * Ticket aceito não representa receipt positivo nem entrega ao aparelho.
 */
async function submitExpoPushTicket(
  db: TokenMutationDb,
  tokenData: {
    id: number;
    token: string;
    expectedUserId: number;
    tokenFingerprint: string;
  },
  payload: PushNotificationPayload,
): Promise<PushTicketEvidence> {
  try {
    const response = await fetch(EXPO_PUSH_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        to: tokenData.token,
        title: payload.title,
        body: payload.body,
        data: payload.data ?? {},
        sound: "default",
        priority: "high",
        // Precisa coincidir com o plugin expo-notifications e o canal runtime
        // (escalas-default). Sem channelId o Android cai no canal "default" e
        // o LED/importância configurados no app não valem.
        channelId: "escalas-default",
      }),
      signal: AbortSignal.timeout(EXPO_HTTP_TIMEOUT_MS),
    });

    const body = await readJson(response);
    if (!response.ok) {
      const providerError = firstProviderError(body);
      const providerCode =
        (typeof providerError?.code === "string" ? providerError.code : undefined) ??
        nestedProviderCode(providerError);
      return {
        state: "TICKET_REJECTED",
        pushTokenId: tokenData.id,
        retryability: retryabilityForHttp(response.status),
        failureKind: "HTTP_ERROR",
        httpStatus: response.status,
        ...(providerCode ? { providerCode } : {}),
        message: `Expo Push respondeu HTTP ${response.status}`,
        tokenDisposition: "UNCHANGED",
      };
    }

    const bodyRecord = asRecord(body);
    const rawData = bodyRecord?.data;
    const ticket = Array.isArray(rawData) ? asRecord(rawData[0]) : asRecord(rawData);

    if (ticket?.status === "ok") {
      if (typeof ticket.id !== "string" || !ticket.id.trim()) {
        return {
          state: "TICKET_REJECTED",
          pushTokenId: tokenData.id,
          retryability: "TERMINAL",
          failureKind: "MALFORMED_RESPONSE",
          message: "Expo aceitou o ticket sem fornecer receipt id",
          tokenDisposition: "UNCHANGED",
        };
      }
      return {
        state: "TICKET_ACCEPTED",
        pushTokenId: tokenData.id,
        ticketId: ticket.id,
        expectedUserId: tokenData.expectedUserId,
        tokenFingerprint: tokenData.tokenFingerprint,
      };
    }

    const providerError = ticket?.status === "error" ? ticket : firstProviderError(body);
    if (providerError) {
      const providerCode =
        nestedProviderCode(providerError) ??
        (typeof providerError.code === "string" ? providerError.code : undefined);
      const tokenDisposition =
        providerCode === "DeviceNotRegistered"
          ? await removeInvalidPushToken(db, {
              pushTokenId: tokenData.id,
              expectedUserId: tokenData.expectedUserId,
              tokenFingerprint: tokenData.tokenFingerprint,
            })
          : "UNCHANGED";
      return {
        state: "TICKET_REJECTED",
        pushTokenId: tokenData.id,
        retryability: retryabilityForProviderCode(providerCode),
        failureKind: "PROVIDER_TICKET_ERROR",
        ...(providerCode ? { providerCode } : {}),
        message: "Expo rejeitou o ticket",
        tokenDisposition,
      };
    }

    return {
      state: "TICKET_REJECTED",
      pushTokenId: tokenData.id,
      retryability: "TERMINAL",
      failureKind: "MALFORMED_RESPONSE",
      message: "Resposta do Expo não contém ticket válido",
      tokenDisposition: "UNCHANGED",
    };
  } catch {
    return {
      state: "TICKET_REJECTED",
      pushTokenId: tokenData.id,
      retryability: "RETRYABLE",
      failureKind: "NETWORK_ERROR",
      message: PUSH_NETWORK_ERROR_MESSAGE,
      tokenDisposition: "UNCHANGED",
    };
  }
}

async function submitOwnedExpoPushTicket(
  db: Db,
  expected: {
    id: number;
    token: string;
    userId: number;
    institutionId: number;
  },
  payload: PushNotificationPayload,
  submissionGuard?: PushSubmissionGuard,
  submissionClaimGuard?: () => Promise<boolean>,
): Promise<PushTicketEvidence | null> {
  try {
    type PushTicketClaim =
      | PushTicketEvidence
      | {
          tokenData: {
            id: number;
            token: string;
            expectedUserId: number;
            tokenFingerprint: string;
          };
        };
    return await withExpoSubmissionSlot(() =>
      withPushAccountAndTokenMutex(
        db,
        expected.userId,
        expected.token,
        PUSH_SEND_LOCK_TIMEOUT_SEC,
        async (connectionDb) => {
        const claimed = await connectionDb.transaction<PushTicketClaim>(async (tx) => {
          // Ordem global: autoridade operacional primeiro; depois
          // users → professionals → PI → token. A transação termina antes do
          // fetch, enquanto o advisory lock da conexão dedicada permanece.
          if (submissionGuard) {
            try {
              await submissionGuard(tx);
            } catch (error) {
              if (isCanonicalDutyConfirmationRejection(error)) {
                return {
                  state: "TICKET_REJECTED" as const,
                  pushTokenId: expected.id,
                  retryability: "TERMINAL" as const,
                  failureKind: "RECIPIENT_AUTHORITY_REVOKED" as const,
                  message: RECIPIENT_AUTHORITY_REVOKED_MESSAGE,
                  tokenDisposition: "UNCHANGED" as const,
                };
              }
              throw error;
            }
          }
          const [identitySnapshot] = await tx
            .select({
              professionalId: professionals.id,
              membershipId: professionalInstitutions.id,
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
                eq(professionalInstitutions.userId, expected.userId),
                eq(professionalInstitutions.institutionId, expected.institutionId),
                eq(professionalInstitutions.active, true),
              ),
            )
            .limit(1);
          const [currentUser] = await tx
            .select({ id: users.id })
            .from(users)
            .where(
              and(
                eq(users.id, expected.userId),
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
                    eq(professionals.userId, expected.userId),
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
                    eq(professionalInstitutions.userId, expected.userId),
                    eq(professionalInstitutions.institutionId, expected.institutionId),
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
                    eq(institutions.id, expected.institutionId),
                    eq(institutions.isActive, true),
                  ),
                )
                .limit(1)
                .for("share")
            : [];
          if (!currentUser || !currentProfessional || !membership || !activeInstitution) {
            return {
              state: "TICKET_REJECTED" as const,
              pushTokenId: expected.id,
              retryability: "TERMINAL" as const,
              failureKind: "RECIPIENT_AUTHORITY_REVOKED" as const,
              message: "Destinatário sem conta e vínculo institucional ativos",
              tokenDisposition: "UNCHANGED" as const,
            };
          }
          const query = tx
            .select({
              id: pushTokens.id,
              userId: pushTokens.userId,
            })
            .from(pushTokens)
            .where(eq(pushTokens.token, expected.token));
          const current = await query.for("update");
          if (
            current.length === 0 ||
            !current.some((row) => row.id === expected.id) ||
            current.some((row) => row.userId !== expected.userId)
          ) {
            return {
              state: "TICKET_REJECTED" as const,
              pushTokenId: expected.id,
              retryability: "TERMINAL" as const,
              failureKind: "TOKEN_OWNERSHIP_CHANGED" as const,
              message: "Ownership do push token mudou antes da submissão",
              tokenDisposition: "UNCHANGED" as const,
            };
          }
          return {
            tokenData: {
              id: expected.id,
              token: expected.token,
              expectedUserId: expected.userId,
              tokenFingerprint: pushTokenFingerprint(expected.token),
            },
          };
        });
        if (!("tokenData" in claimed)) return claimed;

        // A transação de autoridade já terminou e nenhum lock de linha fica
        // aberto durante a rede. Renova o claim JSON por CAS imediatamente
        // antes do fetch; se outro worker já tomou a revisão, este owner
        // encerra a iteração sem submeter o token seguinte.
        if (submissionClaimGuard && !(await submissionClaimGuard())) return null;

        // O claim acima é o ponto de linearização de ownership/autoridade. O
        // Expo não oferece idempotency key: crash após o ticket e antes da
        // persistência pode gerar duplicata at-least-once no retry.
        return submitExpoPushTicket(connectionDb, claimed.tokenData, payload);
        },
      ),
    );
  } catch (error) {
    if (error instanceof PushOwnershipLockTimeoutError) {
      return {
        state: "TICKET_REJECTED",
        pushTokenId: expected.id,
        retryability: "RETRYABLE",
        failureKind: "TOKEN_LOCK_TIMEOUT",
        message: "Timeout ao serializar ownership do push token",
        tokenDisposition: "UNCHANGED",
      };
    }
    return {
      state: "TICKET_REJECTED",
      pushTokenId: expected.id,
      retryability: "RETRYABLE",
      failureKind: "NETWORK_ERROR",
      message: PUSH_OWNERSHIP_ERROR_MESSAGE,
      tokenDisposition: "UNCHANGED",
    };
  }
}

/**
 * Consulta receipts do Expo. PROVIDER_ACCEPTED significa apenas que FCM/APNs
 * aceitou a mensagem; não comprova recebimento, visualização ou resposta.
 */
export async function getExpoPushReceipts(
  targets: readonly ExpoReceiptTarget[],
): Promise<PushReceiptEvidence[]> {
  if (targets.length === 0) return [];

  let db: Db | null = null;
  try {
    db = await getDb();
  } catch {
    console.error("[Push] RECEIPT_DATABASE_UNAVAILABLE");
  }

  const evidence: PushReceiptEvidence[] = [];
  for (let offset = 0; offset < targets.length; offset += EXPO_RECEIPT_BATCH_SIZE) {
    const chunk = targets.slice(offset, offset + EXPO_RECEIPT_BATCH_SIZE);
    try {
      const response = await fetch(EXPO_RECEIPTS_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: chunk.map((target) => target.ticketId) }),
        signal: AbortSignal.timeout(EXPO_HTTP_TIMEOUT_MS),
      });
      const body = await readJson(response);

      if (!response.ok) {
        const providerError = firstProviderError(body);
        const providerCode =
          (typeof providerError?.code === "string" ? providerError.code : undefined) ??
          nestedProviderCode(providerError);
        evidence.push(
          ...chunk.map(
            (target): PushReceiptEvidence => ({
              state: "RECEIPT_LOOKUP_FAILED",
              ticketId: target.ticketId,
              pushTokenId: target.pushTokenId,
              retryability: retryabilityForHttp(response.status),
              failureKind: "HTTP_ERROR",
              httpStatus: response.status,
              ...(providerCode ? { providerCode } : {}),
              message: `Expo Receipts respondeu HTTP ${response.status}`,
            }),
          ),
        );
        continue;
      }

      const receipts = asRecord(asRecord(body)?.data);
      if (!receipts) {
        evidence.push(
          ...chunk.map(
            (target): PushReceiptEvidence => ({
              state: "RECEIPT_LOOKUP_FAILED",
              ticketId: target.ticketId,
              pushTokenId: target.pushTokenId,
              retryability: "TERMINAL",
              failureKind: "MALFORMED_RESPONSE",
              message: "Resposta do Expo não contém mapa de receipts",
            }),
          ),
        );
        continue;
      }

      for (const target of chunk) {
        const receipt = asRecord(receipts[target.ticketId]);
        if (!receipt) {
          evidence.push({
            state: "RECEIPT_PENDING",
            ticketId: target.ticketId,
            pushTokenId: target.pushTokenId,
          });
          continue;
        }
        if (receipt.status === "ok") {
          evidence.push({
            state: "PROVIDER_ACCEPTED",
            ticketId: target.ticketId,
            pushTokenId: target.pushTokenId,
          });
          continue;
        }
        if (receipt.status === "error") {
          const providerCode = nestedProviderCode(receipt);
          const tokenDisposition =
            providerCode === "DeviceNotRegistered"
              ? await removeInvalidPushTokenFromReceipt(db, target)
              : "UNCHANGED";
          evidence.push({
            state: "RECEIPT_REJECTED",
            ticketId: target.ticketId,
            pushTokenId: target.pushTokenId,
            retryability: retryabilityForProviderCode(providerCode),
            ...(providerCode ? { providerCode } : {}),
            message: "Expo retornou receipt com erro",
            tokenDisposition,
          });
          continue;
        }
        evidence.push({
          state: "RECEIPT_LOOKUP_FAILED",
          ticketId: target.ticketId,
          pushTokenId: target.pushTokenId,
          retryability: "TERMINAL",
          failureKind: "MALFORMED_RESPONSE",
          message: "Receipt do Expo possui status inválido",
        });
      }
    } catch {
      evidence.push(
        ...chunk.map(
          (target): PushReceiptEvidence => ({
            state: "RECEIPT_LOOKUP_FAILED",
            ticketId: target.ticketId,
            pushTokenId: target.pushTokenId,
            retryability: "RETRYABLE",
            failureKind: "NETWORK_ERROR",
            message: RECEIPT_NETWORK_ERROR_MESSAGE,
          }),
        ),
      );
    }
  }
  return evidence;
}

/**
 * Registra token de push notification para um usuário
 */
export async function registerPushToken(
  userId: number,
  token: string,
  platform: "ios" | "android" | "web",
  provenanceInstitutionId: number | null,
  expectedSessionVersion: number,
  previousToken?: string,
): Promise<{ success: boolean; message: string }> {
  if (
    !isCanonicalExpoPushToken(token) ||
    (previousToken !== undefined && !isCanonicalExpoPushToken(previousToken))
  ) {
    return { success: false, message: "Push token inválido" };
  }
  const replaceablePreviousToken = previousToken !== token ? previousToken : undefined;
  try {
    const db = await getDb();
    if (!db) throw new Error("Database not available");

    return await withPushAccountAndTokenMutexes(
      db,
      userId,
      replaceablePreviousToken ? [token, replaceablePreviousToken] : [token],
      PUSH_TOKEN_MUTATION_LOCK_TIMEOUT_SEC,
      async (connectionDb) =>
        connectionDb.transaction(async (tx) => {
      // Ownership é conta/dispositivo. O registro pode ocorrer antes da
      // hidratação do tenant; instituição/PI/ACL só autorizam uma entrega,
      // nunca a posse física do token.
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
      if (
        !currentUser ||
        currentUser.sessionVersion !== expectedSessionVersion
      ) {
        if (currentUser && currentUser.sessionVersion !== expectedSessionVersion) {
          return { success: false, message: "Sessão revogada" };
        }
        return { success: false, message: "Conta ativa não encontrada" };
      }

      const lockedTokens = await tx
        .select()
        .from(pushTokens)
        .where(inArray(
          pushTokens.token,
          replaceablePreviousToken ? [token, replaceablePreviousToken] : [token],
        ))
        .orderBy(asc(pushTokens.token), asc(pushTokens.id))
        .for("update");
      const existing = lockedTokens.filter((row) => row.token === token);
      if (existing.length > 1) {
        // Estado pré-UNIQUE é ambíguo: nunca escolher silenciosamente um
        // owner. Remove todas as cópias e exige um novo registro autenticado.
        await tx.delete(pushTokens).where(eq(pushTokens.token, token));
        return { success: false, message: "Token duplicado removido; registre novamente" };
      }
      let message: string;
      if (existing.length === 1) {
        const keeper = existing[0];
        await tx
          .update(pushTokens)
          .set({ userId, institutionId: provenanceInstitutionId, platform })
          .where(eq(pushTokens.id, keeper.id));
        const unchanged =
          keeper.userId === userId &&
          keeper.institutionId === provenanceInstitutionId &&
          keeper.platform === platform;
        message = unchanged
          ? "Token já registrado"
          : "Token associado à conta atual";
      } else {
        await tx.insert(pushTokens).values({
          institutionId: provenanceInstitutionId,
          userId,
          token,
          platform,
        });
        message = "Token registrado com sucesso";
      }

      if (replaceablePreviousToken) {
        const previousRows = lockedTokens.filter(
          (row) => row.token === replaceablePreviousToken,
        );
        if (previousRows.length === 1 && previousRows[0].userId === userId) {
          await tx
            .delete(pushTokens)
            .where(and(
              eq(pushTokens.id, previousRows[0].id),
              eq(pushTokens.userId, userId),
              eq(pushTokens.token, replaceablePreviousToken),
            ));
        }
      }

      return { success: true, message };
      }),
    );
  } catch {
    logPushTokenMutationFailure("REGISTER");
    return {
      success: false,
      message: "Não foi possível registrar o token",
    };
  }
}

/** Remove o token do aparelho (logout / troca de conta). */
export async function unregisterPushToken(
  userId: number,
  token: string,
  expectedSessionVersion: number,
): Promise<{ success: boolean }> {
  if (!isCanonicalExpoPushToken(token)) return { success: false };
  const db = await getDb();
  if (!db) return { success: false };
  try {
    return await withPushAccountAndTokenMutex(
      db,
      userId,
      token,
      PUSH_TOKEN_MUTATION_LOCK_TIMEOUT_SEC,
      async (connectionDb) =>
        connectionDb.transaction(async (tx) => {
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
        if (!currentUser || currentUser.sessionVersion !== expectedSessionVersion) {
          return { success: false };
        }
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
  payload: PushNotificationPayload,
  institutionId: number,
  submissionGuard?: PushSubmissionGuard,
  submissionClaimGuard?: () => Promise<boolean>,
): Promise<PushSendResult> {
  try {
    const db = await getDb();
    if (!db) throw new Error("Database not available");

    // O token pertence à conta/dispositivo. O tenant abaixo autoriza a
    // intenção e é revalidado sob lock antes de cada submissão.
    const tokens = await db
      .select({ id: pushTokens.id, token: pushTokens.token })
      .from(pushTokens)
      .where(eq(pushTokens.userId, userId));

    if (tokens.length === 0) {
      return {
        status: "NO_REGISTERED_TOKENS",
        message: "Nenhum token registrado para submissão ao Expo",
        tickets: [],
        acceptedCount: 0,
        rejectedCount: 0,
      };
    }

    const uniqueTokens = [...new Map(tokens.map((row) => [row.token, row])).values()];
    const tickets: PushTicketEvidence[] = [];
    // Sequencial por usuário limita pressão no Expo. Cada token tem seu claim
    // de ownership/autoridade transacional, mas o fetch ocorre após o commit.
    for (const tokenData of uniqueTokens) {
      const ticket = await submitOwnedExpoPushTicket(db, {
        ...tokenData,
        userId,
        institutionId,
      }, payload, submissionGuard, submissionClaimGuard);
      if (!ticket) {
        return {
          status: "SERVICE_ERROR",
          message: PUSH_SERVICE_ERROR_MESSAGE,
          tickets,
          acceptedCount: tickets.filter((item) => item.state === "TICKET_ACCEPTED").length,
          rejectedCount: tickets.filter((item) => item.state === "TICKET_REJECTED").length,
        };
      }
      tickets.push(ticket);
    }
    const acceptedCount = tickets.filter((ticket) => ticket.state === "TICKET_ACCEPTED").length;
    const rejectedCount = tickets.length - acceptedCount;

    console.log(
      `[Notifications] Expo aceitou ${acceptedCount}/${uniqueTokens.length} ticket(s) para userId=${userId}; delivery não comprovada`,
    );

    if (acceptedCount === tickets.length) {
      return {
        status: "TICKETS_ACCEPTED",
        message: `Expo aceitou tickets para ${acceptedCount}/${tickets.length} token(s); receipts pendentes`,
        tickets,
        acceptedCount,
        rejectedCount,
      };
    }
    if (acceptedCount > 0) {
      return {
        status: "PARTIAL_TICKET_ACCEPTANCE",
        message: `Expo aceitou tickets para ${acceptedCount}/${tickets.length} token(s); houve rejeições`,
        tickets,
        acceptedCount,
        rejectedCount,
      };
    }
    return {
      status: "ALL_TICKETS_REJECTED",
      message: `Expo não aceitou ticket para nenhum dos ${tickets.length} token(s)`,
      tickets,
      acceptedCount,
      rejectedCount,
    };
  } catch {
    console.error("[Notifications] PUSH_SERVICE_FAILED");
    return {
      status: "SERVICE_ERROR",
      message: PUSH_SERVICE_ERROR_MESSAGE,
      tickets: [],
      acceptedCount: 0,
      rejectedCount: 0,
    };
  }
}

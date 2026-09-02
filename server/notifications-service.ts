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
import { isCanonicalPushAuthorityRejection } from "./push-authority-rejection";
import {
  PUSH_ACCOUNT_MUTATION_LOCK_TIMEOUT_SEC,
  PushOwnershipLockTimeoutError,
  withPushAccountAndTokenMutex,
  withPushAccountAndTokenMutexes,
  withPushAccountMutex,
} from "./push-registration-revocation";
import {
  ACCOUNT_WIDE_BADGE_SNAPSHOT_COLLAPSE_ID,
  ACCOUNT_WIDE_BADGE_SNAPSHOT_DATA,
  ACCOUNT_WIDE_BADGE_SNAPSHOT_TTL_SECONDS,
  parseAccountWideBadgeCount,
} from "../lib/account-wide-native-badge";
import { countUnreadAccountBadgeNotifications } from "./account-wide-notification-badge";

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
        | "RECIPIENT_AUTHORITY_REVOKED"
        | "BADGE_SNAPSHOT_UNAVAILABLE";
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

type AccountWideBadgeSnapshotPayload = Readonly<{
  kind: "ACCOUNT_WIDE_BADGE_SNAPSHOT";
}>;

type OutboundPushPayload = PushNotificationPayload | AccountWideBadgeSnapshotPayload;

/**
 * O token Expo pertence a uma conta, não ao payload que um chamador montou.
 * Mantém esse vínculo explícito no envelope enviado ao dispositivo e nunca
 * aceita um recipientUserId fornecido pelo produtor da notificação.
 */
export function withAuthoritativePushRecipient(
  data: JsonRecord | undefined,
  recipientUserId: number,
): JsonRecord {
  if (!Number.isSafeInteger(recipientUserId) || recipientUserId <= 0) {
    throw new Error("Destinatário de push inválido");
  }
  return {
    ...(data ?? {}),
    recipientUserId,
  };
}

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
const EXPO_RECEIPTS_URL = "https://exp.host/--/api/v2/push/getReceipts";
const EXPO_NEUTRAL_NOTIFICATION_TITLE = "Escala+";
const EXPO_NEUTRAL_NOTIFICATION_BODY =
  "Há uma atualização disponível. Abra o aplicativo para consultar.";
const EXPO_RECEIPT_BATCH_SIZE = 1_000;
const EXPO_HTTP_TIMEOUT_MS = 15_000;
// Snapshot de badge é projeção eventual e nunca pode disputar 15 segundos do
// mutex de conta com um push operacional. Se o Expo ou o mutex estiverem
// ocupados, a próxima entrega/retomada reconcilia a fotografia novamente.
const ACCOUNT_WIDE_BADGE_SNAPSHOT_HTTP_TIMEOUT_MS = 2_000;
const ACCOUNT_WIDE_BADGE_SNAPSHOT_LOCK_TIMEOUT_SEC = 0;
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
const BADGE_SNAPSHOT_UNAVAILABLE_MESSAGE = "Não foi possível atualizar o badge da conta";
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

function isAccountWideBadgeSnapshotPayload(
  payload: OutboundPushPayload,
): payload is AccountWideBadgeSnapshotPayload {
  return "kind" in payload && payload.kind === "ACCOUNT_WIDE_BADGE_SNAPSHOT";
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
    platform: string;
    badgeCount?: number;
  },
  payload: OutboundPushPayload,
): Promise<PushTicketEvidence> {
  try {
    const message = isAccountWideBadgeSnapshotPayload(payload)
      ? {
          // O snapshot iOS não apresenta alerta, conteúdo ou identidade: ele
          // atualiza exclusivamente o número do ícone no sistema operacional.
          // O marker estático só permite que o app aberto faça uma leitura
          // canônica local; não contém usuário, tenant nem dado operacional.
          to: tokenData.token,
          badge: tokenData.badgeCount,
          collapseId: ACCOUNT_WIDE_BADGE_SNAPSHOT_COLLAPSE_ID,
          data: ACCOUNT_WIDE_BADGE_SNAPSHOT_DATA,
          ttl: ACCOUNT_WIDE_BADGE_SNAPSHOT_TTL_SECONDS,
        }
      : {
          to: tokenData.token,
          // Em background/killed, o sistema operacional pode apresentar esta
          // mensagem antes de o JS conhecer o usuário atual. A visualização
          // remota é propositalmente neutra; o app só obtém detalhes depois da
          // autenticação e da cerca recipientUserId no listener.
          title: EXPO_NEUTRAL_NOTIFICATION_TITLE,
          body: EXPO_NEUTRAL_NOTIFICATION_BODY,
          // O owner foi revalidado sob mutex imediatamente antes do fetch. O
          // campo do produtor é deliberadamente sobrescrito para impedir que um
          // payload stale ou forjado seja aceito pelo listener da outra conta.
          data: withAuthoritativePushRecipient(
            payload.data,
            tokenData.expectedUserId,
          ),
          sound: "default",
          priority: "high",
          // Precisa coincidir com o plugin expo-notifications e o canal runtime
          // (escalas-default). Sem channelId o Android cai no canal "default" e
          // o LED/importância configurados no app não valem.
          channelId: "escalas-default",
        };
    const response = await fetch(EXPO_PUSH_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(
        isAccountWideBadgeSnapshotPayload(payload)
          ? ACCOUNT_WIDE_BADGE_SNAPSHOT_HTTP_TIMEOUT_MS
          : EXPO_HTTP_TIMEOUT_MS,
      ),
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
    platform: string;
    userId: number;
    institutionId: number;
  },
  payload: OutboundPushPayload,
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
            platform: string;
            badgeCount?: number;
          };
        };
    return await withExpoSubmissionSlot(() =>
      withPushAccountAndTokenMutex(
        db,
        expected.userId,
        expected.token,
        isAccountWideBadgeSnapshotPayload(payload)
          ? ACCOUNT_WIDE_BADGE_SNAPSHOT_LOCK_TIMEOUT_SEC
          : PUSH_SEND_LOCK_TIMEOUT_SEC,
        async (connectionDb) => {
        const claimed = await connectionDb.transaction<PushTicketClaim>(async (tx) => {
          // Ordem global: autoridade operacional primeiro; depois
          // users → professionals → PI → token. A transação termina antes do
          // fetch, enquanto o advisory lock da conexão dedicada permanece.
          if (submissionGuard) {
            try {
              await submissionGuard(tx);
            } catch (error) {
              if (isCanonicalPushAuthorityRejection(error)) {
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
            .select({ id: users.id, sessionVersion: users.sessionVersion })
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

          let badgeCount: number | undefined;
          if (isAccountWideBadgeSnapshotPayload(payload)) {
            if (expected.platform !== "ios") {
              return {
                state: "TICKET_REJECTED" as const,
                pushTokenId: expected.id,
                retryability: "TERMINAL" as const,
                failureKind: "BADGE_SNAPSHOT_UNAVAILABLE" as const,
                message: BADGE_SNAPSHOT_UNAVAILABLE_MESSAGE,
                tokenDisposition: "UNCHANGED" as const,
              };
            }
            try {
              const resolved = parseAccountWideBadgeCount(
                await countUnreadAccountBadgeNotifications(tx, {
                  userId: expected.userId,
                  sessionVersion: currentUser.sessionVersion,
                }),
              );
              if (resolved === null) {
                return {
                  state: "TICKET_REJECTED" as const,
                  pushTokenId: expected.id,
                  retryability: "TERMINAL" as const,
                  failureKind: "BADGE_SNAPSHOT_UNAVAILABLE" as const,
                  message: BADGE_SNAPSHOT_UNAVAILABLE_MESSAGE,
                  tokenDisposition: "UNCHANGED" as const,
                };
              }
              badgeCount = resolved;
            } catch {
              return {
                state: "TICKET_REJECTED" as const,
                pushTokenId: expected.id,
                retryability: "RETRYABLE" as const,
                failureKind: "BADGE_SNAPSHOT_UNAVAILABLE" as const,
                message: BADGE_SNAPSHOT_UNAVAILABLE_MESSAGE,
                tokenDisposition: "UNCHANGED" as const,
              };
            }
          }
          const query = tx
            .select({
              id: pushTokens.id,
              userId: pushTokens.userId,
              platform: pushTokens.platform,
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
          if (
            isAccountWideBadgeSnapshotPayload(payload) &&
            !current.some(
              (row) =>
                row.id === expected.id &&
                row.userId === expected.userId &&
                row.platform === "ios",
            )
          ) {
            // O registro pode trocar a plataforma do mesmo token enquanto o
            // sender aguarda o mutex. Releia sob lock para nunca submeter o
            // envelope iOS de badge a um destino que virou Android/web.
            return {
              state: "TICKET_REJECTED" as const,
              pushTokenId: expected.id,
              retryability: "TERMINAL" as const,
              failureKind: "BADGE_SNAPSHOT_UNAVAILABLE" as const,
              message: BADGE_SNAPSHOT_UNAVAILABLE_MESSAGE,
              tokenDisposition: "UNCHANGED" as const,
            };
          }
          return {
            tokenData: {
              id: expected.id,
              token: expected.token,
              expectedUserId: expected.userId,
              tokenFingerprint: pushTokenFingerprint(expected.token),
              platform: expected.platform,
              ...(badgeCount === undefined ? {} : { badgeCount }),
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
      if (isAccountWideBadgeSnapshotPayload(payload)) {
        return {
          state: "TICKET_REJECTED",
          pushTokenId: expected.id,
          retryability: "RETRYABLE",
          failureKind: "BADGE_SNAPSHOT_UNAVAILABLE",
          message: BADGE_SNAPSHOT_UNAVAILABLE_MESSAGE,
          tokenDisposition: "UNCHANGED",
        };
      }
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
async function sendOutboundPushNotification(
  userId: number,
  payload: OutboundPushPayload,
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
      .select({
        id: pushTokens.id,
        token: pushTokens.token,
        platform: pushTokens.platform,
      })
      .from(pushTokens)
      .where(eq(pushTokens.userId, userId));

    const deliverableTokens = isAccountWideBadgeSnapshotPayload(payload)
      ? tokens.filter((token) => token.platform === "ios")
      : tokens;
    if (deliverableTokens.length === 0) {
      return {
        status: "NO_REGISTERED_TOKENS",
        message: isAccountWideBadgeSnapshotPayload(payload)
          ? "Nenhum token iOS registrado para snapshot de badge"
          : "Nenhum token registrado para submissão ao Expo",
        tickets: [],
        acceptedCount: 0,
        rejectedCount: 0,
      };
    }

    const uniqueTokens = [
      ...new Map(deliverableTokens.map((row) => [row.token, row])).values(),
    ];
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

/**
 * Envia uma notificação visível ao usuário. O caminho de snapshot de badge
 * não é público: assim nenhum caller pode injetar contagem ou payload externo
 * no envelope que chega ao sistema operacional.
 */
export async function sendPushNotification(
  userId: number,
  payload: PushNotificationPayload,
  institutionId: number,
  submissionGuard?: PushSubmissionGuard,
  submissionClaimGuard?: () => Promise<boolean>,
): Promise<PushSendResult> {
  return sendOutboundPushNotification(
    userId,
    payload,
    institutionId,
    submissionGuard,
    submissionClaimGuard,
  );
}

/**
 * Atualiza somente o badge de aparelhos iOS da conta. A contagem é obtida
 * internamente do selector server-side e o envelope contém exclusivamente
 * token, número inteiro e collapseId estático.
 */
export async function sendAccountWideNativeBadgeSnapshot(
  userId: number,
  institutionId: number,
): Promise<PushSendResult> {
  return sendOutboundPushNotification(
    userId,
    {
      kind: "ACCOUNT_WIDE_BADGE_SNAPSHOT",
    },
    institutionId,
  );
}

const pendingAccountWideBadgeSnapshotDispatches = new Set<Promise<void>>();

/**
 * O badge remoto é uma projeção eventual e jamais pode atrasar a mutação ou
 * a entrega operacional que originou a nova contagem. A mesma autorização
 * institucional do envio permanece obrigatória; falhas ficam restritas à
 * observabilidade e a abertura/retomada reconcilia novamente a fonte canônica.
 */
export function dispatchAccountWideNativeBadgeSnapshot(
  userId: number,
  institutionId: number,
): void {
  const dispatch = sendAccountWideNativeBadgeSnapshot(userId, institutionId)
    .then((result) => {
      if (
        result.status !== "TICKETS_ACCEPTED" &&
        result.status !== "PARTIAL_TICKET_ACCEPTANCE" &&
        result.status !== "NO_REGISTERED_TOKENS"
      ) {
        console.error("[Notifications] ACCOUNT_BADGE_SNAPSHOT_UNAVAILABLE");
      }
    })
    .catch(() => {
      console.error("[Notifications] ACCOUNT_BADGE_SNAPSHOT_UNAVAILABLE");
    })
    .finally(() => {
      pendingAccountWideBadgeSnapshotDispatches.delete(dispatch);
    });
  pendingAccountWideBadgeSnapshotDispatches.add(dispatch);
}

/**
 * Barreira de graceful shutdown e de testes: a resposta HTTP nunca a aguarda,
 * mas o processo pode drenar projeções já iniciadas antes de encerrar ou
 * desmontar fixtures que compartilham o mesmo banco/token.
 */
export async function drainAccountWideNativeBadgeSnapshotDispatches(): Promise<void> {
  while (pendingAccountWideBadgeSnapshotDispatches.size > 0) {
    await Promise.all([...pendingAccountWideBadgeSnapshotDispatches]);
  }
}

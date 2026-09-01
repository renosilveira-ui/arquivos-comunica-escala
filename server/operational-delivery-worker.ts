import { createHash } from "node:crypto";
import {
  and,
  asc,
  eq,
  gt,
  gte,
  isNotNull,
  isNull,
  lt,
  lte,
  or,
  sql,
} from "drizzle-orm";
import type { MySql2Database } from "drizzle-orm/mysql2";
import {
  institutions,
  managerScope,
  notificationDeliveries,
  operationalDeliveryRequeueAudits,
  operationalEventRecipients,
  operationalEvents,
  professionalAccess,
  professionalInstitutions,
  scheduleInvites,
  userOperationalEmailTrust,
  users,
} from "../drizzle/schema";
import {
  OPERATIONAL_DELIVERY_MAX_ATTEMPTS,
  isTrustedOperationalEmail,
  operationalDeliveryRetryDelayMs,
  type OperationalDeliveryChannel,
  type OperationalEventEmissionMode,
  type OperationalDeliveryStatus,
} from "./operational-events";

/**
 * O worker continua opt-in. A presença da flag não configura transporte,
 * destinatário ou adaptador externo.
 */
export const OPERATIONAL_DELIVERY_WORKER_ENABLED_FLAG =
  "OPERATIONAL_DELIVERY_WORKER_ENABLED";
export const OPERATIONAL_DELIVERY_LEASE_MS = 120_000;
export const OPERATIONAL_DELIVERY_BATCH_LIMIT = 100;

export type OperationalDeliveryRecipientKind = "USER" | "SCHEDULE_INVITE";
export type OperationalDeliveryEmissionMode = OperationalEventEmissionMode;

export const OPERATIONAL_DELIVERY_FAILURE_CODES = [
  "ACCESS_REVALIDATION_UNAVAILABLE",
  "RECIPIENT_ACCESS_REVOKED",
  "RECIPIENT_SCOPE_ACCESS_REVOKED",
  "RECIPIENT_UNAVAILABLE",
  "LEASE_EXPIRED",
  "TRANSPORT_EXCEPTION",
  "TRANSPORT_INVALID_RESULT",
  "TRANSPORT_REJECTED",
] as const;

export type OperationalDeliveryFailureCode =
  (typeof OPERATIONAL_DELIVERY_FAILURE_CODES)[number];

/**
 * Só ACTIVE pode chegar à fila. Ausência de coluna/valor é bloqueada enquanto
 * a migration de emission_mode não estiver integrada.
 */
export function canClaimOperationalDeliveryForEmissionMode(
  emissionMode: unknown,
): emissionMode is "ACTIVE" {
  return emissionMode === "ACTIVE";
}

/**
 * Representação mínima de notification_deliveries já unida a event/recipient.
 * Não inclui e-mail, token, corpo ou PHI.
 */
export type OperationalDeliveryRecord = Readonly<{
  id: number;
  operationalEventId: number;
  institutionId: number;
  recipientKind: OperationalDeliveryRecipientKind;
  recipientReferenceId: number;
  channel: OperationalDeliveryChannel;
  status: OperationalDeliveryStatus;
  attemptCount: number;
  availableAt: Date;
  leaseUntil: Date | null;
  providerAcceptedAt: Date | null;
  deliveredAt: Date | null;
  lastErrorCode: OperationalDeliveryFailureCode | null;
  dedupKey: string;
  emissionMode?: OperationalDeliveryEmissionMode | null;
}>;

type MutableOperationalDeliveryRecord = {
  -readonly [
    K in keyof OperationalDeliveryRecord
  ]: OperationalDeliveryRecord[K];
};

export type OperationalDeliveryClaim = Readonly<{
  delivery: OperationalDeliveryRecord;
  claimToken: string;
}>;

export type OperationalDeliveryAccessDecision =
  | Readonly<{ state: "AUTHORIZED" }>
  | Readonly<{
      state: "REVOKED";
      code:
        | "ACCESS_REVALIDATION_UNAVAILABLE"
        | "RECIPIENT_ACCESS_REVOKED"
        | "RECIPIENT_SCOPE_ACCESS_REVOKED"
        | "RECIPIENT_UNAVAILABLE";
    }>;

/**
 * Transporte deliberadamente cego a alvo/conteúdo. Nenhum adaptador real é
 * incluído nesta frente.
 */
export type OperationalDeliveryTransportRequest = Readonly<{
  /** Identidade estável para correlação interna do adaptador injetado. */
  deliveryId: number;
  /**
   * Chave opaca e estável para o provider coalescer retries/requeues da mesma
   * notificação. Ela não pode ser registrada em observabilidade.
   */
  idempotencyKey: string;
  operationalEventId: number;
  institutionId: number;
  channel: OperationalDeliveryChannel;
  attempt: number;
}>;

export type OperationalDeliveryTransportResult =
  | Readonly<{ state: "DELIVERED" }>
  | Readonly<{ state: "PROVIDER_ACCEPTED" }>
  | Readonly<{
      state: "FAILED";
      retryable: boolean;
      code?: OperationalDeliveryFailureCode;
    }>;

export interface OperationalDeliveryTransport {
  /**
   * O adaptador deve coalescer qualquer repetição pelo idempotencyKey. Isso é
   * obrigatório para recuperar crash/partição entre side effect e CAS final.
   */
  deliver(
    request: OperationalDeliveryTransportRequest,
  ): Promise<OperationalDeliveryTransportResult>;
}

export type OperationalDeliveryTransition = Readonly<{
  status: "DELIVERED" | "PROVIDER_ACCEPTED" | "FAILED" | "DEAD" | "SKIPPED";
  at: Date;
  availableAt?: Date;
  errorCode?: OperationalDeliveryFailureCode;
}>;

export type OperationalDeliveryTransitionResult = Readonly<{
  applied: boolean;
  delivery: OperationalDeliveryRecord | null;
}>;

export type OperationalDeliveryRequeueActor = Readonly<{
  userId: number;
  role: "GESTOR_MEDICO" | "GESTOR_PLUS" | "GLOBAL_ADMIN";
}>;

export type OperationalDeliveryRequeueResult =
  | Readonly<{ state: "REQUEUED"; delivery: OperationalDeliveryRecord }>
  | Readonly<{
      state:
        "NOT_FOUND" | "NOT_DEAD" | "NOT_CLAIMABLE" | "AUTHORIZATION_DENIED";
    }>;

export interface OperationalDeliveryStore {
  claimNext(
    input: Readonly<{
      now: Date;
      leaseMs: number;
    }>,
  ): Promise<OperationalDeliveryClaim | null>;
  renewClaimLease(
    claim: OperationalDeliveryClaim,
    input: Readonly<{
      now: Date;
      leaseMs: number;
    }>,
  ): Promise<OperationalDeliveryClaim | null>;
  revalidateRecipientAccess(
    claim: OperationalDeliveryClaim,
  ): Promise<OperationalDeliveryAccessDecision>;
  applyTransition(
    claim: OperationalDeliveryClaim,
    transition: OperationalDeliveryTransition,
  ): Promise<OperationalDeliveryTransitionResult>;
}

export type OperationalDeliveryObservabilityEvent = Readonly<{
  kind:
    | "CLAIMED"
    | "DELIVERED"
    | "PROVIDER_ACCEPTED"
    | "RETRY_SCHEDULED"
    | "DEAD"
    | "SKIPPED_ACCESS_REVOKED"
    | "CLAIM_LOST"
    | "STORE_UNAVAILABLE";
  deliveryId: number;
  operationalEventId: number;
  institutionId: number;
  channel: OperationalDeliveryChannel;
  attempt: number;
  status: OperationalDeliveryStatus;
  code?: OperationalDeliveryFailureCode;
}>;

export interface OperationalDeliveryObservability {
  record(event: OperationalDeliveryObservabilityEvent): void | Promise<void>;
}

export type OperationalDeliveryBatchResult = Readonly<{
  claimed: number;
  providerAccepted: number;
  delivered: number;
  failed: number;
  dead: number;
  skipped: number;
  claimLost: number;
}>;

export type OperationalDeliveryBatchOptions = Readonly<{
  store: OperationalDeliveryStore;
  transport: OperationalDeliveryTransport;
  now?: Date;
  leaseMs?: number;
  limit?: number;
  jitter?: (
    input: Readonly<{
      deliveryId: number;
      attempt: number;
      dedupKey: string;
    }>,
  ) => number;
  observability?: OperationalDeliveryObservability;
}>;

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function isOperationalDeliveryFailureCode(
  value: unknown,
): value is OperationalDeliveryFailureCode {
  return (
    typeof value === "string" &&
    (OPERATIONAL_DELIVERY_FAILURE_CODES as readonly string[]).includes(value)
  );
}

function safeFailureCode(
  value: unknown,
  fallback: OperationalDeliveryFailureCode,
): OperationalDeliveryFailureCode {
  return isOperationalDeliveryFailureCode(value) ? value : fallback;
}

function cloneDate(value: Date): Date {
  return new Date(value.getTime());
}

function isDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function isKnownStatus(value: unknown): value is OperationalDeliveryStatus {
  return (
    typeof value === "string" &&
    [
      "QUEUED",
      "PROCESSING",
      "PROVIDER_ACCEPTED",
      "DELIVERED",
      "FAILED",
      "DEAD",
      "SKIPPED",
    ].includes(value)
  );
}

function cloneRecord(
  record: OperationalDeliveryRecord,
): OperationalDeliveryRecord {
  return Object.freeze({
    ...record,
    availableAt: cloneDate(record.availableAt),
    leaseUntil: record.leaseUntil ? cloneDate(record.leaseUntil) : null,
    providerAcceptedAt: record.providerAcceptedAt
      ? cloneDate(record.providerAcceptedAt)
      : null,
    deliveredAt: record.deliveredAt ? cloneDate(record.deliveredAt) : null,
  });
}

function assertRecord(record: OperationalDeliveryRecord): void {
  if (
    !isPositiveInteger(record.id) ||
    !isPositiveInteger(record.operationalEventId) ||
    !isPositiveInteger(record.institutionId) ||
    !isPositiveInteger(record.recipientReferenceId) ||
    !isKnownStatus(record.status) ||
    !Number.isSafeInteger(record.attemptCount) ||
    record.attemptCount < 0 ||
    !isDate(record.availableAt) ||
    (record.leaseUntil !== null && !isDate(record.leaseUntil)) ||
    (record.providerAcceptedAt !== null &&
      !isDate(record.providerAcceptedAt)) ||
    (record.deliveredAt !== null && !isDate(record.deliveredAt)) ||
    !/^[a-f0-9]{64}$/i.test(record.dedupKey)
  ) {
    throw new Error("Registro de entrega operacional inválido");
  }
  if (
    record.emissionMode !== undefined &&
    record.emissionMode !== null &&
    !canClaimOperationalDeliveryForEmissionMode(record.emissionMode) &&
    record.emissionMode !== "SHADOW"
  ) {
    throw new Error("Modo de emissão operacional inválido");
  }
  if (
    record.recipientKind !== "USER" &&
    record.recipientKind !== "SCHEDULE_INVITE"
  ) {
    throw new Error("Tipo de destinatário operacional inválido");
  }
  if (record.channel !== "PUSH" && record.channel !== "EMAIL") {
    throw new Error("Canal de entrega operacional inválido");
  }
  if (
    record.lastErrorCode !== null &&
    !isOperationalDeliveryFailureCode(record.lastErrorCode)
  ) {
    throw new Error("Código de falha operacional inválido");
  }
}

function buildClaimToken(
  deliveryId: number,
  generation: number,
  leaseUntil: Date,
): string {
  return createHash("sha256")
    .update(
      String(deliveryId) +
        ":" +
        String(generation) +
        ":" +
        leaseUntil.toISOString(),
    )
    .digest("hex");
}

function defaultJitter(
  input: Readonly<{
    deliveryId: number;
    attempt: number;
    dedupKey: string;
  }>,
): number {
  const digest = createHash("sha256")
    .update(
      String(input.deliveryId) +
        ":" +
        String(input.attempt) +
        ":" +
        input.dedupKey,
    )
    .digest();
  return digest.readUInt32BE(0) / 0x1_0000_0000;
}

/**
 * A chave não inclui endereço, conteúdo, token de acesso nem identificador de
 * pessoa em claro. Um requeue é reprocessamento do mesmo fato/canal e mantém a
 * chave para nunca transformá-lo em uma autorização de duplicação externa.
 */
export function operationalDeliveryTransportIdempotencyKey(
  delivery: Pick<OperationalDeliveryRecord, "dedupKey">,
): string {
  return createHash("sha256")
    .update(`operational-delivery/v1:${delivery.dedupKey}`)
    .digest("hex");
}

/**
 * Jitter determinístico por delivery/tentativa. Não depende de Math.random.
 */
export function operationalDeliveryRetryDelayForClaim(
  claim: OperationalDeliveryClaim,
  jitter: NonNullable<
    OperationalDeliveryBatchOptions["jitter"]
  > = defaultJitter,
): number {
  const entropy = jitter({
    deliveryId: claim.delivery.id,
    attempt: claim.delivery.attemptCount,
    dedupKey: claim.delivery.dedupKey,
  });
  return operationalDeliveryRetryDelayMs(
    claim.delivery.attemptCount,
    () => entropy,
  );
}

function transportResult(value: unknown): OperationalDeliveryTransportResult {
  if (!value || typeof value !== "object") {
    return {
      state: "FAILED",
      retryable: true,
      code: "TRANSPORT_INVALID_RESULT",
    };
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.state === "DELIVERED") return { state: "DELIVERED" };
  if (candidate.state === "PROVIDER_ACCEPTED") {
    return { state: "PROVIDER_ACCEPTED" };
  }
  if (
    candidate.state === "FAILED" &&
    typeof candidate.retryable === "boolean"
  ) {
    return {
      state: "FAILED",
      retryable: candidate.retryable,
      code: safeFailureCode(candidate.code, "TRANSPORT_REJECTED"),
    };
  }
  return {
    state: "FAILED",
    retryable: true,
    code: "TRANSPORT_INVALID_RESULT",
  };
}

/**
 * Revalidação negativa sempre ganha: um claim não oferece autoridade para
 * entregar depois que o acesso tenha sido revogado.
 */
export function planOperationalDeliveryTransition(
  input: Readonly<{
    claim: OperationalDeliveryClaim;
    now: Date;
    access: OperationalDeliveryAccessDecision;
    transport?: OperationalDeliveryTransportResult;
    retryDelayMs?: number;
  }>,
): OperationalDeliveryTransition {
  if (input.access.state !== "AUTHORIZED") {
    if (input.access.code === "ACCESS_REVALIDATION_UNAVAILABLE") {
      const retryDelayMs = Number.isFinite(input.retryDelayMs)
        ? Math.max(0, Math.floor(input.retryDelayMs ?? 0))
        : 0;
      if (
        input.claim.delivery.attemptCount >= OPERATIONAL_DELIVERY_MAX_ATTEMPTS
      ) {
        return {
          status: "DEAD",
          at: cloneDate(input.now),
          errorCode: input.access.code,
        };
      }
      return {
        status: "FAILED",
        at: cloneDate(input.now),
        availableAt: new Date(input.now.getTime() + retryDelayMs),
        errorCode: input.access.code,
      };
    }
    return {
      status: "SKIPPED",
      at: cloneDate(input.now),
      errorCode: input.access.code,
    };
  }

  const result = transportResult(input.transport);
  if (result.state === "DELIVERED") {
    return { status: "DELIVERED", at: cloneDate(input.now) };
  }
  if (result.state === "PROVIDER_ACCEPTED") {
    return { status: "PROVIDER_ACCEPTED", at: cloneDate(input.now) };
  }

  const code = safeFailureCode(result.code, "TRANSPORT_REJECTED");
  if (
    !result.retryable ||
    input.claim.delivery.attemptCount >= OPERATIONAL_DELIVERY_MAX_ATTEMPTS
  ) {
    return { status: "DEAD", at: cloneDate(input.now), errorCode: code };
  }

  const retryDelayMs = Number.isFinite(input.retryDelayMs)
    ? Math.max(0, Math.floor(input.retryDelayMs ?? 0))
    : 0;
  return {
    status: "FAILED",
    at: cloneDate(input.now),
    availableAt: new Date(input.now.getTime() + retryDelayMs),
    errorCode: code,
  };
}

function isValidTransition(transition: OperationalDeliveryTransition): boolean {
  if (!isDate(transition.at)) return false;
  if (
    transition.status !== "DELIVERED" &&
    transition.status !== "PROVIDER_ACCEPTED" &&
    transition.status !== "FAILED" &&
    transition.status !== "DEAD" &&
    transition.status !== "SKIPPED"
  ) {
    return false;
  }
  if (
    transition.errorCode !== undefined &&
    !isOperationalDeliveryFailureCode(transition.errorCode)
  ) {
    return false;
  }
  if (transition.status === "FAILED") {
    return isDate(transition.availableAt) && transition.errorCode !== undefined;
  }
  if (transition.status === "DEAD" || transition.status === "SKIPPED") {
    return (
      transition.errorCode !== undefined && transition.availableAt === undefined
    );
  }
  return (
    transition.availableAt === undefined && transition.errorCode === undefined
  );
}

function canClaim(record: OperationalDeliveryRecord, now: Date): boolean {
  if (
    !canClaimOperationalDeliveryForEmissionMode(record.emissionMode) ||
    record.attemptCount >= OPERATIONAL_DELIVERY_MAX_ATTEMPTS
  ) {
    return false;
  }
  if (record.status === "QUEUED" || record.status === "FAILED") {
    return record.availableAt.getTime() <= now.getTime();
  }
  return (
    record.status === "PROCESSING" &&
    record.leaseUntil !== null &&
    record.leaseUntil.getTime() <= now.getTime()
  );
}

function compareClaimCandidates(
  left: OperationalDeliveryRecord,
  right: OperationalDeliveryRecord,
): number {
  const byAvailableAt =
    left.availableAt.getTime() - right.availableAt.getTime();
  return byAvailableAt !== 0 ? byAvailableAt : left.id - right.id;
}

function noOpObservation(): OperationalDeliveryObservability {
  return { record: () => undefined };
}

async function emitObservation(
  sink: OperationalDeliveryObservability,
  event: OperationalDeliveryObservabilityEvent,
): Promise<void> {
  try {
    await sink.record(event);
  } catch {
    // Observabilidade não pode reabrir claim nem causar nova entrega.
  }
}

function observationFor(
  kind: OperationalDeliveryObservabilityEvent["kind"],
  delivery: OperationalDeliveryRecord,
  code?: OperationalDeliveryFailureCode,
): OperationalDeliveryObservabilityEvent {
  return {
    kind,
    deliveryId: delivery.id,
    operationalEventId: delivery.operationalEventId,
    institutionId: delivery.institutionId,
    channel: delivery.channel,
    attempt: delivery.attemptCount,
    status: delivery.status,
    ...(code === undefined ? {} : { code }),
  };
}

type MutableBatchResult = {
  claimed: number;
  providerAccepted: number;
  delivered: number;
  failed: number;
  dead: number;
  skipped: number;
  claimLost: number;
};

function increment(
  result: MutableBatchResult,
  key: keyof OperationalDeliveryBatchResult,
): void {
  result[key] += 1;
}

function executionNow(fixedNow: Date | undefined): Date {
  return fixedNow ? cloneDate(fixedNow) : new Date();
}

function workerLeaseMs(value: number | undefined): number {
  const requested =
    Number.isFinite(value) && (value ?? 0) > 0
      ? Math.floor(value ?? OPERATIONAL_DELIVERY_LEASE_MS)
      : OPERATIONAL_DELIVERY_LEASE_MS;
  // DATETIME persiste em segundos neste esquema. O heartbeat precisa de um
  // intervalo inteiro estritamente menor que o lease e de uma renovação que
  // realmente altere a coluna; a configuração padrão é 120 s.
  return Math.max(1_000, requested);
}

function leaseHeartbeatIntervalMs(leaseMs: number): number {
  return Math.max(1, Math.floor(leaseMs / 3));
}

/**
 * Sem import de mailer, token de acesso ou chamada de rede. A revalidação fica
 * entre claim e transporte e todo resultado usa a mesma identidade de claim.
 */
export async function processOperationalDeliveryBatch(
  options: OperationalDeliveryBatchOptions,
): Promise<OperationalDeliveryBatchResult> {
  const leaseMs = workerLeaseMs(options.leaseMs);
  const limit =
    Number.isSafeInteger(options.limit) && (options.limit ?? 0) > 0
      ? Math.min(
          options.limit ?? OPERATIONAL_DELIVERY_BATCH_LIMIT,
          OPERATIONAL_DELIVERY_BATCH_LIMIT,
        )
      : OPERATIONAL_DELIVERY_BATCH_LIMIT;
  const observability = options.observability ?? noOpObservation();
  const result: MutableBatchResult = {
    claimed: 0,
    providerAccepted: 0,
    delivered: 0,
    failed: 0,
    dead: 0,
    skipped: 0,
    claimLost: 0,
  };

  for (let count = 0; count < limit; count += 1) {
    // Em produção o relógio avança a cada claim. Só testes que fornecem
    // options.now recebem um instante estável e reprodutível.
    const claimNow = executionNow(options.now);
    let claim: OperationalDeliveryClaim | null;
    try {
      claim = await options.store.claimNext({ now: claimNow, leaseMs });
    } catch {
      await emitObservation(observability, {
        kind: "STORE_UNAVAILABLE",
        deliveryId: 0,
        operationalEventId: 0,
        institutionId: 0,
        channel: "PUSH",
        attempt: 0,
        status: "QUEUED",
      });
      break;
    }
    if (!claim) break;

    // O adapter persistente filtra ACTIVE, mas a fronteira de injeção também
    // precisa ser segura contra store defeituoso ou futuro. Nunca promovemos,
    // transicionamos ou chamamos transporte para um fato sem modo ACTIVE.
    if (
      !canClaimOperationalDeliveryForEmissionMode(claim.delivery.emissionMode)
    ) {
      increment(result, "claimLost");
      await emitObservation(
        observability,
        observationFor("CLAIM_LOST", claim.delivery),
      );
      continue;
    }

    increment(result, "claimed");
    await emitObservation(
      observability,
      observationFor("CLAIMED", claim.delivery),
    );

    let access: OperationalDeliveryAccessDecision;
    try {
      access = await options.store.revalidateRecipientAccess(claim);
    } catch {
      access = {
        state: "REVOKED",
        code: "ACCESS_REVALIDATION_UNAVAILABLE",
      };
    }

    let activeClaim = claim;
    let transport: OperationalDeliveryTransportResult | undefined;
    if (access.state === "AUTHORIZED") {
      // Revalidação e renovação falham fechado. Sem um lease CAS renovado
      // imediatamente antes da chamada, o worker não inicia side effect.
      try {
        const renewed = await options.store.renewClaimLease(activeClaim, {
          now: executionNow(options.now),
          leaseMs,
        });
        if (!renewed) {
          increment(result, "claimLost");
          await emitObservation(
            observability,
            observationFor("CLAIM_LOST", activeClaim.delivery),
          );
          continue;
        }
        activeClaim = renewed;
      } catch {
        increment(result, "claimLost");
        await emitObservation(
          observability,
          observationFor("CLAIM_LOST", activeClaim.delivery),
        );
        continue;
      }

      let leaseRenewalLost = false;
      let renewalChain: Promise<void> = Promise.resolve();
      const heartbeat = setInterval(() => {
        renewalChain = renewalChain.then(async () => {
          if (leaseRenewalLost) return;
          try {
            const renewed = await options.store.renewClaimLease(activeClaim, {
              now: executionNow(options.now),
              leaseMs,
            });
            if (!renewed) {
              leaseRenewalLost = true;
              return;
            }
            activeClaim = renewed;
          } catch {
            // Após perder a renovação, não iniciamos outra chamada. A chave
            // idempotente recebida pelo transport protege recuperação extrema.
            leaseRenewalLost = true;
          }
        });
      }, leaseHeartbeatIntervalMs(leaseMs));
      try {
        transport = transportResult(
          await options.transport.deliver({
            deliveryId: activeClaim.delivery.id,
            idempotencyKey: operationalDeliveryTransportIdempotencyKey(
              activeClaim.delivery,
            ),
            operationalEventId: activeClaim.delivery.operationalEventId,
            institutionId: activeClaim.delivery.institutionId,
            channel: activeClaim.delivery.channel,
            attempt: activeClaim.delivery.attemptCount,
          }),
        );
      } catch {
        transport = {
          state: "FAILED",
          retryable: true,
          code: "TRANSPORT_EXCEPTION",
        };
      } finally {
        clearInterval(heartbeat);
        await renewalChain;
      }
    }

    const transitionNow = executionNow(options.now);
    const transition = planOperationalDeliveryTransition({
      claim: activeClaim,
      now: transitionNow,
      access,
      transport,
      retryDelayMs: operationalDeliveryRetryDelayForClaim(
        activeClaim,
        options.jitter ?? defaultJitter,
      ),
    });
    const applied = await options.store.applyTransition(
      activeClaim,
      transition,
    );
    if (!applied.applied || !applied.delivery) {
      increment(result, "claimLost");
      await emitObservation(
        observability,
        observationFor("CLAIM_LOST", activeClaim.delivery),
      );
      continue;
    }

    if (transition.status === "DELIVERED") {
      increment(result, "delivered");
      await emitObservation(
        observability,
        observationFor("DELIVERED", applied.delivery),
      );
      continue;
    }
    if (transition.status === "PROVIDER_ACCEPTED") {
      increment(result, "providerAccepted");
      await emitObservation(
        observability,
        observationFor("PROVIDER_ACCEPTED", applied.delivery),
      );
      continue;
    }
    if (transition.status === "SKIPPED") {
      increment(result, "skipped");
      await emitObservation(
        observability,
        observationFor(
          "SKIPPED_ACCESS_REVOKED",
          applied.delivery,
          transition.errorCode,
        ),
      );
      continue;
    }

    increment(result, "failed");
    if (transition.status === "DEAD") {
      increment(result, "dead");
      await emitObservation(
        observability,
        observationFor("DEAD", applied.delivery, transition.errorCode),
      );
    } else {
      await emitObservation(
        observability,
        observationFor(
          "RETRY_SCHEDULED",
          applied.delivery,
          transition.errorCode,
        ),
      );
    }
  }

  return Object.freeze(result);
}

/**
 * Store de testes/simulações: serializa claim e aplica identidade de geração
 * para impedir que um worker expirado confirme a geração seguinte.
 */
export class InMemoryOperationalDeliveryStore implements OperationalDeliveryStore {
  private readonly records = new Map<
    number,
    MutableOperationalDeliveryRecord
  >();
  private readonly claimGenerations = new Map<number, number>();
  private readonly activeClaimTokens = new Map<number, string>();
  private serial: Promise<void> = Promise.resolve();
  private readonly accessResolver: (
    record: OperationalDeliveryRecord,
  ) =>
    | Promise<OperationalDeliveryAccessDecision>
    | OperationalDeliveryAccessDecision;

  constructor(
    input: Readonly<{
      deliveries: readonly OperationalDeliveryRecord[];
      accessResolver?: (
        record: OperationalDeliveryRecord,
      ) =>
        | Promise<OperationalDeliveryAccessDecision>
        | OperationalDeliveryAccessDecision;
    }>,
  ) {
    for (const record of input.deliveries) {
      assertRecord(record);
      if (this.records.has(record.id)) {
        throw new Error("Delivery operacional duplicada");
      }
      this.records.set(record.id, { ...cloneRecord(record) });
      this.claimGenerations.set(record.id, 0);
    }
    this.accessResolver =
      input.accessResolver ?? (() => ({ state: "AUTHORIZED" }));
  }

  private async exclusive<T>(operation: () => Promise<T> | T): Promise<T> {
    const previous = this.serial;
    let release: (() => void) | undefined;
    this.serial = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release?.();
    }
  }

  snapshot(deliveryId: number): OperationalDeliveryRecord | null {
    const record = this.records.get(deliveryId);
    return record ? cloneRecord(record) : null;
  }

  async claimNext(
    input: Readonly<{
      now: Date;
      leaseMs: number;
    }>,
  ): Promise<OperationalDeliveryClaim | null> {
    return this.exclusive(() => {
      if (
        !isDate(input.now) ||
        !Number.isFinite(input.leaseMs) ||
        input.leaseMs <= 0
      ) {
        throw new Error("Parâmetros de claim operacional inválidos");
      }
      for (const record of this.records.values()) {
        if (
          canClaimOperationalDeliveryForEmissionMode(record.emissionMode) &&
          record.status === "PROCESSING" &&
          record.attemptCount >= OPERATIONAL_DELIVERY_MAX_ATTEMPTS &&
          record.leaseUntil !== null &&
          record.leaseUntil.getTime() <= input.now.getTime()
        ) {
          record.status = "DEAD";
          record.leaseUntil = null;
          record.availableAt = cloneDate(input.now);
          record.lastErrorCode = "LEASE_EXPIRED";
          this.activeClaimTokens.delete(record.id);
        }
      }
      const candidate = [...this.records.values()]
        .filter((record) => canClaim(record, input.now))
        .sort(compareClaimCandidates)[0];
      if (!candidate) return null;

      const leaseUntil = new Date(
        input.now.getTime() + Math.floor(input.leaseMs),
      );
      const generation = (this.claimGenerations.get(candidate.id) ?? 0) + 1;
      const token = buildClaimToken(candidate.id, generation, leaseUntil);
      candidate.status = "PROCESSING";
      candidate.attemptCount += 1;
      candidate.leaseUntil = leaseUntil;
      candidate.lastErrorCode = null;
      this.claimGenerations.set(candidate.id, generation);
      this.activeClaimTokens.set(candidate.id, token);
      return Object.freeze({
        delivery: cloneRecord(candidate),
        claimToken: token,
      });
    });
  }

  async renewClaimLease(
    claim: OperationalDeliveryClaim,
    input: Readonly<{
      now: Date;
      leaseMs: number;
    }>,
  ): Promise<OperationalDeliveryClaim | null> {
    return this.exclusive(() => {
      if (
        !isDate(input.now) ||
        !Number.isFinite(input.leaseMs) ||
        input.leaseMs <= 0
      ) {
        return null;
      }
      const current = this.records.get(claim.delivery.id);
      if (
        !current ||
        current.status !== "PROCESSING" ||
        current.attemptCount !== claim.delivery.attemptCount ||
        current.leaseUntil === null ||
        current.leaseUntil.getTime() !== claim.delivery.leaseUntil?.getTime() ||
        this.activeClaimTokens.get(current.id) !== claim.claimToken
      ) {
        return null;
      }
      const requestedLeaseUntil = new Date(
        input.now.getTime() + Math.floor(input.leaseMs),
      );
      const renewedLeaseUntil =
        requestedLeaseUntil.getTime() > current.leaseUntil.getTime()
          ? requestedLeaseUntil
          : new Date(current.leaseUntil.getTime() + Math.floor(input.leaseMs));
      const generation = this.claimGenerations.get(current.id);
      if (!generation) return null;
      const claimToken = buildClaimToken(
        current.id,
        generation,
        renewedLeaseUntil,
      );
      current.leaseUntil = renewedLeaseUntil;
      this.activeClaimTokens.set(current.id, claimToken);
      return Object.freeze({
        delivery: cloneRecord(current),
        claimToken,
      });
    });
  }

  async revalidateRecipientAccess(
    claim: OperationalDeliveryClaim,
  ): Promise<OperationalDeliveryAccessDecision> {
    const current = this.records.get(claim.delivery.id);
    if (
      !current ||
      this.activeClaimTokens.get(current.id) !== claim.claimToken
    ) {
      return { state: "REVOKED", code: "RECIPIENT_UNAVAILABLE" };
    }
    try {
      const decision = await this.accessResolver(cloneRecord(current));
      if (decision?.state === "AUTHORIZED") return { state: "AUTHORIZED" };
      if (decision?.state === "REVOKED") {
        if (decision.code === "ACCESS_REVALIDATION_UNAVAILABLE") {
          return decision;
        }
        if (decision.code === "RECIPIENT_ACCESS_REVOKED") return decision;
        if (decision.code === "RECIPIENT_SCOPE_ACCESS_REVOKED") return decision;
        if (decision.code === "RECIPIENT_UNAVAILABLE") return decision;
      }
    } catch {
      // Falha de infraestrutura é negação de autoridade.
    }
    return {
      state: "REVOKED",
      code: "ACCESS_REVALIDATION_UNAVAILABLE",
    };
  }

  async applyTransition(
    claim: OperationalDeliveryClaim,
    transition: OperationalDeliveryTransition,
  ): Promise<OperationalDeliveryTransitionResult> {
    return this.exclusive(() => {
      const current = this.records.get(claim.delivery.id);
      if (
        !current ||
        current.status !== "PROCESSING" ||
        this.activeClaimTokens.get(current.id) !== claim.claimToken ||
        current.attemptCount !== claim.delivery.attemptCount ||
        !isValidTransition(transition)
      ) {
        return { applied: false, delivery: null };
      }

      current.status = transition.status;
      current.leaseUntil = null;
      current.availableAt =
        transition.status === "FAILED" && transition.availableAt
          ? cloneDate(transition.availableAt)
          : cloneDate(transition.at);
      current.lastErrorCode =
        transition.status === "FAILED" ||
        transition.status === "DEAD" ||
        transition.status === "SKIPPED"
          ? (transition.errorCode ?? null)
          : null;
      current.providerAcceptedAt =
        transition.status === "PROVIDER_ACCEPTED"
          ? cloneDate(transition.at)
          : current.providerAcceptedAt;
      current.deliveredAt =
        transition.status === "DELIVERED"
          ? cloneDate(transition.at)
          : current.deliveredAt;
      this.activeClaimTokens.delete(current.id);
      return { applied: true, delivery: cloneRecord(current) };
    });
  }
}

/**
 * O banco é sempre recebido por injeção. O worker não abre conexão nem inicia
 * processamento por conta própria.
 */
type OperationalDeliveryDb = MySql2Database;
type OperationalDeliveryReadDb = Pick<OperationalDeliveryDb, "select">;

type DrizzleDeliveryRow = Readonly<{
  id: number;
  operationalEventId: number;
  institutionId: number;
  recipientKind: OperationalDeliveryRecipientKind;
  recipientUserId: number | null;
  scheduleInviteId: number | null;
  channel: OperationalDeliveryChannel;
  status: OperationalDeliveryStatus;
  attemptCount: number;
  availableAt: Date;
  leaseUntil: Date | null;
  providerAcceptedAt: Date | null;
  deliveredAt: Date | null;
  lastErrorCode: string | null;
  dedupKey: string;
  emissionMode: OperationalDeliveryEmissionMode;
  scopeKind: "INSTITUTION" | "HOSPITAL" | "SECTOR";
  hospitalId: number | null;
  sectorId: number | null;
}>;

const drizzleDeliverySelection = {
  id: notificationDeliveries.id,
  operationalEventId: operationalEventRecipients.operationalEventId,
  institutionId: operationalEvents.institutionId,
  recipientKind: operationalEventRecipients.recipientKind,
  recipientUserId: operationalEventRecipients.userId,
  scheduleInviteId: operationalEventRecipients.scheduleInviteId,
  channel: notificationDeliveries.channel,
  status: notificationDeliveries.status,
  attemptCount: notificationDeliveries.attemptCount,
  availableAt: notificationDeliveries.availableAt,
  leaseUntil: notificationDeliveries.leaseUntil,
  providerAcceptedAt: notificationDeliveries.providerAcceptedAt,
  deliveredAt: notificationDeliveries.deliveredAt,
  lastErrorCode: notificationDeliveries.lastErrorCode,
  dedupKey: notificationDeliveries.dedupKey,
  emissionMode: operationalEvents.emissionMode,
  scopeKind: operationalEvents.scopeKind,
  hospitalId: operationalEvents.hospitalId,
  sectorId: operationalEvents.sectorId,
};

function databaseInstant(value: Date): Date {
  return new Date(Math.floor(value.getTime() / 1_000) * 1_000);
}

function affectedRows(result: unknown): number {
  const payload = Array.isArray(result) ? result[0] : result;
  if (!payload || typeof payload !== "object") return 0;
  const value = (payload as { affectedRows?: unknown }).affectedRows;
  return Number.isSafeInteger(value) ? Number(value) : 0;
}

function recordFromDrizzleRow(
  row: DrizzleDeliveryRow,
): OperationalDeliveryRecord | null {
  const recipientReferenceId =
    row.recipientKind === "USER" ? row.recipientUserId : row.scheduleInviteId;
  if (!isPositiveInteger(recipientReferenceId)) return null;
  const record: OperationalDeliveryRecord = {
    id: row.id,
    operationalEventId: row.operationalEventId,
    institutionId: row.institutionId,
    recipientKind: row.recipientKind,
    recipientReferenceId,
    channel: row.channel,
    status: row.status,
    attemptCount: row.attemptCount,
    availableAt: row.availableAt,
    leaseUntil: row.leaseUntil,
    providerAcceptedAt: row.providerAcceptedAt,
    deliveredAt: row.deliveredAt,
    lastErrorCode: isOperationalDeliveryFailureCode(row.lastErrorCode)
      ? row.lastErrorCode
      : null,
    dedupKey: row.dedupKey,
    emissionMode: row.emissionMode,
  };
  try {
    assertRecord(record);
    return cloneRecord(record);
  } catch {
    return null;
  }
}

function sameClaimIdentity(
  record: OperationalDeliveryRecord,
  row: DrizzleDeliveryRow,
): boolean {
  const recipientReferenceId =
    row.recipientKind === "USER" ? row.recipientUserId : row.scheduleInviteId;
  return (
    record.id === row.id &&
    record.operationalEventId === row.operationalEventId &&
    record.institutionId === row.institutionId &&
    record.recipientKind === row.recipientKind &&
    record.recipientReferenceId === recipientReferenceId &&
    record.channel === row.channel &&
    record.status === row.status &&
    record.attemptCount === row.attemptCount &&
    record.emissionMode === row.emissionMode
  );
}

function claimTokenMatches(claim: OperationalDeliveryClaim): boolean {
  const leaseUntil = claim.delivery.leaseUntil;
  return (
    leaseUntil !== null &&
    claim.claimToken ===
      buildClaimToken(
        claim.delivery.id,
        claim.delivery.attemptCount,
        leaseUntil,
      )
  );
}

/**
 * Adapter persistente das tabelas notification_deliveries,
 * operational_event_recipients e operational_events. O claim usa lock de
 * linha e CAS de status/tentativa/lease; a finalização exige o mesmo lease.
 * Nenhum código o instancia automaticamente e ele não contém provider ou cron.
 */
export class DrizzleOperationalDeliveryStore implements OperationalDeliveryStore {
  constructor(private readonly db: OperationalDeliveryDb) {}

  async claimNext(
    input: Readonly<{
      now: Date;
      leaseMs: number;
    }>,
  ): Promise<OperationalDeliveryClaim | null> {
    if (
      !isDate(input.now) ||
      !Number.isFinite(input.leaseMs) ||
      input.leaseMs <= 0
    ) {
      throw new Error("Parâmetros de claim operacional inválidos");
    }
    const now = databaseInstant(input.now);
    const leaseUntil = databaseInstant(
      new Date(now.getTime() + Math.floor(input.leaseMs)),
    );

    return this.db.transaction(async (tx) => {
      const [candidate] = await tx
        .select(drizzleDeliverySelection)
        .from(notificationDeliveries)
        .innerJoin(
          operationalEventRecipients,
          eq(
            operationalEventRecipients.id,
            notificationDeliveries.operationalEventRecipientId,
          ),
        )
        .innerJoin(
          operationalEvents,
          and(
            eq(
              operationalEvents.id,
              operationalEventRecipients.operationalEventId,
            ),
            eq(
              operationalEvents.institutionId,
              operationalEventRecipients.institutionId,
            ),
          ),
        )
        .where(
          and(
            eq(operationalEvents.emissionMode, "ACTIVE"),
            or(
              and(
                lt(
                  notificationDeliveries.attemptCount,
                  OPERATIONAL_DELIVERY_MAX_ATTEMPTS,
                ),
                or(
                  and(
                    eq(notificationDeliveries.status, "QUEUED"),
                    lte(notificationDeliveries.availableAt, now),
                  ),
                  and(
                    eq(notificationDeliveries.status, "FAILED"),
                    lte(notificationDeliveries.availableAt, now),
                  ),
                  and(
                    eq(notificationDeliveries.status, "PROCESSING"),
                    lte(notificationDeliveries.leaseUntil, now),
                  ),
                ),
              ),
              and(
                gte(
                  notificationDeliveries.attemptCount,
                  OPERATIONAL_DELIVERY_MAX_ATTEMPTS,
                ),
                eq(notificationDeliveries.status, "PROCESSING"),
                lte(notificationDeliveries.leaseUntil, now),
              ),
            ),
          ),
        )
        .orderBy(
          asc(notificationDeliveries.availableAt),
          asc(notificationDeliveries.id),
        )
        .limit(1)
        .for("update");
      if (!candidate) return null;

      const record = recordFromDrizzleRow(candidate as DrizzleDeliveryRow);
      if (
        record &&
        canClaimOperationalDeliveryForEmissionMode(record.emissionMode) &&
        record.status === "PROCESSING" &&
        record.attemptCount >= OPERATIONAL_DELIVERY_MAX_ATTEMPTS &&
        record.leaseUntil !== null &&
        record.leaseUntil.getTime() <= now.getTime()
      ) {
        await tx
          .update(notificationDeliveries)
          .set({
            status: "DEAD",
            availableAt: now,
            leaseUntil: null,
            lastErrorCode: "LEASE_EXPIRED",
          })
          .where(
            and(
              eq(notificationDeliveries.id, record.id),
              eq(notificationDeliveries.status, "PROCESSING"),
              eq(notificationDeliveries.attemptCount, record.attemptCount),
              eq(notificationDeliveries.leaseUntil, record.leaseUntil),
            ),
          );
        return null;
      }
      if (
        !record ||
        !canClaimOperationalDeliveryForEmissionMode(record.emissionMode) ||
        !canClaim(record, now)
      ) {
        return null;
      }

      const timePredicate =
        record.status === "PROCESSING"
          ? and(
              eq(notificationDeliveries.leaseUntil, record.leaseUntil!),
              lte(notificationDeliveries.leaseUntil, now),
            )
          : and(
              eq(notificationDeliveries.availableAt, record.availableAt),
              lte(notificationDeliveries.availableAt, now),
            );
      const updateResult = await tx
        .update(notificationDeliveries)
        .set({
          status: "PROCESSING",
          attemptCount: record.attemptCount + 1,
          leaseUntil,
          lastErrorCode: null,
        })
        .where(
          and(
            eq(notificationDeliveries.id, record.id),
            eq(notificationDeliveries.status, record.status),
            eq(notificationDeliveries.attemptCount, record.attemptCount),
            timePredicate,
          ),
        );
      if (affectedRows(updateResult) !== 1) return null;

      const claimed = cloneRecord({
        ...record,
        status: "PROCESSING",
        attemptCount: record.attemptCount + 1,
        leaseUntil,
        lastErrorCode: null,
      });
      return Object.freeze({
        delivery: claimed,
        claimToken: buildClaimToken(
          claimed.id,
          claimed.attemptCount,
          leaseUntil,
        ),
      });
    });
  }

  async renewClaimLease(
    claim: OperationalDeliveryClaim,
    input: Readonly<{
      now: Date;
      leaseMs: number;
    }>,
  ): Promise<OperationalDeliveryClaim | null> {
    if (
      !claimTokenMatches(claim) ||
      !isDate(input.now) ||
      !Number.isFinite(input.leaseMs) ||
      input.leaseMs <= 0
    ) {
      return null;
    }
    const previousLeaseUntil = claim.delivery.leaseUntil!;
    const requestedLeaseUntil = databaseInstant(
      new Date(input.now.getTime() + Math.floor(input.leaseMs)),
    );
    const renewedLeaseUntil =
      requestedLeaseUntil.getTime() > previousLeaseUntil.getTime()
        ? requestedLeaseUntil
        : databaseInstant(
            new Date(previousLeaseUntil.getTime() + Math.floor(input.leaseMs)),
          );
    const result = await this.db
      .update(notificationDeliveries)
      .set({ leaseUntil: renewedLeaseUntil })
      .where(
        and(
          eq(notificationDeliveries.id, claim.delivery.id),
          eq(notificationDeliveries.status, "PROCESSING"),
          eq(notificationDeliveries.attemptCount, claim.delivery.attemptCount),
          eq(notificationDeliveries.leaseUntil, previousLeaseUntil),
        ),
      );
    if (affectedRows(result) !== 1) return null;
    const delivery = cloneRecord({
      ...claim.delivery,
      leaseUntil: renewedLeaseUntil,
    });
    return Object.freeze({
      delivery,
      claimToken: buildClaimToken(
        delivery.id,
        delivery.attemptCount,
        renewedLeaseUntil,
      ),
    });
  }

  async revalidateRecipientAccess(
    claim: OperationalDeliveryClaim,
  ): Promise<OperationalDeliveryAccessDecision> {
    if (!claimTokenMatches(claim)) {
      return { state: "REVOKED", code: "RECIPIENT_UNAVAILABLE" };
    }
    const leaseUntil = claim.delivery.leaseUntil!;
    const observedAt = databaseInstant(new Date());
    const [identity] = await this.db
      .select(drizzleDeliverySelection)
      .from(notificationDeliveries)
      .innerJoin(
        operationalEventRecipients,
        eq(
          operationalEventRecipients.id,
          notificationDeliveries.operationalEventRecipientId,
        ),
      )
      .innerJoin(
        operationalEvents,
        and(
          eq(
            operationalEvents.id,
            operationalEventRecipients.operationalEventId,
          ),
          eq(
            operationalEvents.institutionId,
            operationalEventRecipients.institutionId,
          ),
        ),
      )
      .where(
        and(
          eq(notificationDeliveries.id, claim.delivery.id),
          eq(notificationDeliveries.status, "PROCESSING"),
          eq(notificationDeliveries.attemptCount, claim.delivery.attemptCount),
          eq(notificationDeliveries.leaseUntil, leaseUntil),
          gt(notificationDeliveries.leaseUntil, observedAt),
          eq(operationalEvents.emissionMode, "ACTIVE"),
        ),
      )
      .limit(1);
    if (
      !identity ||
      !sameClaimIdentity(claim.delivery, identity as DrizzleDeliveryRow) ||
      !canClaimOperationalDeliveryForEmissionMode(
        (identity as DrizzleDeliveryRow).emissionMode,
      )
    ) {
      return { state: "REVOKED", code: "RECIPIENT_UNAVAILABLE" };
    }

    const row = identity as DrizzleDeliveryRow;
    if (claim.delivery.recipientKind === "SCHEDULE_INVITE") {
      return this.revalidateScheduleInvite(claim.delivery, row, observedAt);
    }
    return this.revalidateUserRecipient(claim.delivery, row, observedAt);
  }

  private async revalidateUserRecipient(
    delivery: OperationalDeliveryRecord,
    event: DrizzleDeliveryRow,
    now: Date,
  ): Promise<OperationalDeliveryAccessDecision> {
    const [membership] = await this.db
      .select({
        professionalId: professionalInstitutions.professionalId,
        email: users.email,
        emailTrustState: userOperationalEmailTrust.state,
        emailTrustHash: userOperationalEmailTrust.emailHash,
      })
      .from(professionalInstitutions)
      .innerJoin(
        users,
        and(
          eq(users.id, professionalInstitutions.userId),
          eq(users.approvalStatus, "APPROVED"),
          isNull(users.deletedAt),
        ),
      )
      .innerJoin(
        institutions,
        and(
          eq(institutions.id, professionalInstitutions.institutionId),
          eq(institutions.isActive, true),
        ),
      )
      .leftJoin(
        userOperationalEmailTrust,
        eq(userOperationalEmailTrust.userId, professionalInstitutions.userId),
      )
      .where(
        and(
          eq(professionalInstitutions.userId, delivery.recipientReferenceId),
          eq(professionalInstitutions.institutionId, delivery.institutionId),
          eq(professionalInstitutions.active, true),
        ),
      )
      .limit(1);
    if (!membership) {
      return { state: "REVOKED", code: "RECIPIENT_ACCESS_REVOKED" };
    }

    if (
      delivery.channel === "EMAIL" &&
      (membership.emailTrustState !== "TRUSTED" ||
        !membership.emailTrustHash ||
        !isTrustedOperationalEmail({
          state: membership.emailTrustState,
          trustedEmailHash: membership.emailTrustHash,
          currentEmail: membership.email,
        }))
    ) {
      return { state: "REVOKED", code: "RECIPIENT_ACCESS_REVOKED" };
    }

    if (event.scopeKind === "INSTITUTION") {
      return { state: "AUTHORIZED" };
    }
    if (
      !isPositiveInteger(event.hospitalId) ||
      (event.scopeKind === "SECTOR" && !isPositiveInteger(event.sectorId))
    ) {
      return { state: "REVOKED", code: "RECIPIENT_SCOPE_ACCESS_REVOKED" };
    }
    const scopePredicate =
      event.scopeKind === "SECTOR"
        ? or(
            isNull(professionalAccess.sectorId),
            eq(professionalAccess.sectorId, event.sectorId!),
          )
        : isNull(professionalAccess.sectorId);
    const [scope] = await this.db
      .select({ id: professionalAccess.id })
      .from(professionalAccess)
      .where(
        and(
          eq(professionalAccess.institutionId, delivery.institutionId),
          eq(professionalAccess.professionalId, membership.professionalId),
          eq(professionalAccess.hospitalId, event.hospitalId),
          eq(professionalAccess.canAccess, true),
          scopePredicate,
        ),
      )
      .limit(1);
    return scope
      ? { state: "AUTHORIZED" }
      : { state: "REVOKED", code: "RECIPIENT_SCOPE_ACCESS_REVOKED" };
  }

  private async revalidateScheduleInvite(
    delivery: OperationalDeliveryRecord,
    event: DrizzleDeliveryRow,
    now: Date,
  ): Promise<OperationalDeliveryAccessDecision> {
    if (delivery.channel !== "EMAIL") {
      return { state: "REVOKED", code: "RECIPIENT_UNAVAILABLE" };
    }
    const [invite] = await this.db
      .select({
        hospitalId: scheduleInvites.hospitalId,
        sectorId: scheduleInvites.sectorId,
      })
      .from(scheduleInvites)
      .innerJoin(
        users,
        and(
          eq(users.id, scheduleInvites.invitedUserId),
          eq(users.approvalStatus, "APPROVED"),
          isNull(users.deletedAt),
          isNotNull(users.email),
          sql`CHAR_LENGTH(TRIM(${users.email})) > 0`,
          sql`LOWER(TRIM(${scheduleInvites.invitedEmail})) = LOWER(TRIM(${users.email}))`,
        ),
      )
      .innerJoin(
        institutions,
        and(
          eq(institutions.id, scheduleInvites.institutionId),
          eq(institutions.isActive, true),
        ),
      )
      .where(
        and(
          eq(scheduleInvites.id, delivery.recipientReferenceId),
          eq(scheduleInvites.institutionId, delivery.institutionId),
          isNull(scheduleInvites.revokedAt),
          isNull(scheduleInvites.declinedAt),
          gt(scheduleInvites.expiresAt, now),
          lt(scheduleInvites.redeemedCount, scheduleInvites.maxRedemptions),
          isNotNull(scheduleInvites.invitedUserId),
          sql`CHAR_LENGTH(TRIM(${scheduleInvites.invitedEmail})) > 0`,
        ),
      )
      .limit(1);
    if (!invite) {
      return { state: "REVOKED", code: "RECIPIENT_ACCESS_REVOKED" };
    }
    if (
      event.scopeKind === "HOSPITAL" &&
      event.hospitalId !== invite.hospitalId
    ) {
      return { state: "REVOKED", code: "RECIPIENT_SCOPE_ACCESS_REVOKED" };
    }
    if (
      event.scopeKind === "SECTOR" &&
      (event.hospitalId !== invite.hospitalId ||
        event.sectorId !== invite.sectorId)
    ) {
      return { state: "REVOKED", code: "RECIPIENT_SCOPE_ACCESS_REVOKED" };
    }
    return { state: "AUTHORIZED" };
  }

  async applyTransition(
    claim: OperationalDeliveryClaim,
    transition: OperationalDeliveryTransition,
  ): Promise<OperationalDeliveryTransitionResult> {
    if (!claimTokenMatches(claim) || !isValidTransition(transition)) {
      return { applied: false, delivery: null };
    }
    const at = databaseInstant(transition.at);
    const availableAt =
      transition.status === "FAILED" && transition.availableAt
        ? databaseInstant(transition.availableAt)
        : at;
    const result = await this.db
      .update(notificationDeliveries)
      .set({
        status: transition.status,
        availableAt,
        leaseUntil: null,
        providerAcceptedAt:
          transition.status === "PROVIDER_ACCEPTED" ? at : null,
        deliveredAt: transition.status === "DELIVERED" ? at : null,
        lastErrorCode:
          transition.status === "FAILED" ||
          transition.status === "DEAD" ||
          transition.status === "SKIPPED"
            ? (transition.errorCode ?? null)
            : null,
      })
      .where(
        and(
          eq(notificationDeliveries.id, claim.delivery.id),
          eq(notificationDeliveries.status, "PROCESSING"),
          eq(notificationDeliveries.attemptCount, claim.delivery.attemptCount),
          eq(notificationDeliveries.leaseUntil, claim.delivery.leaseUntil!),
        ),
      );
    if (affectedRows(result) !== 1) {
      return { applied: false, delivery: null };
    }
    return {
      applied: true,
      delivery: cloneRecord({
        ...claim.delivery,
        status: transition.status,
        availableAt,
        leaseUntil: null,
        providerAcceptedAt:
          transition.status === "PROVIDER_ACCEPTED" ? at : null,
        deliveredAt: transition.status === "DELIVERED" ? at : null,
        lastErrorCode:
          transition.status === "FAILED" ||
          transition.status === "DEAD" ||
          transition.status === "SKIPPED"
            ? (transition.errorCode ?? null)
            : null,
      }),
    };
  }

  private async hasCanonicalRequeueActor(
    db: OperationalDeliveryReadDb,
    actor: OperationalDeliveryRequeueActor,
    event: DrizzleDeliveryRow,
  ): Promise<boolean> {
    const [activeInstitution] = await db
      .select({ id: institutions.id })
      .from(institutions)
      .where(
        and(
          eq(institutions.id, event.institutionId),
          eq(institutions.isActive, true),
        ),
      )
      .limit(1);
    if (!activeInstitution) return false;

    if (actor.role === "GLOBAL_ADMIN") {
      const [user] = await db
        .select({ id: users.id })
        .from(users)
        .where(
          and(
            eq(users.id, actor.userId),
            eq(users.role, "admin"),
            eq(users.approvalStatus, "APPROVED"),
            isNull(users.deletedAt),
          ),
        )
        .limit(1);
      return Boolean(user);
    }
    const [membership] = await db
      .select({ professionalId: professionalInstitutions.professionalId })
      .from(professionalInstitutions)
      .innerJoin(
        users,
        and(
          eq(users.id, professionalInstitutions.userId),
          eq(users.approvalStatus, "APPROVED"),
          isNull(users.deletedAt),
        ),
      )
      .innerJoin(
        institutions,
        and(
          eq(institutions.id, professionalInstitutions.institutionId),
          eq(institutions.isActive, true),
        ),
      )
      .where(
        and(
          eq(professionalInstitutions.userId, actor.userId),
          eq(professionalInstitutions.institutionId, event.institutionId),
          eq(professionalInstitutions.active, true),
          eq(professionalInstitutions.roleInInstitution, actor.role),
        ),
      )
      .limit(1);
    if (!membership || actor.role === "GESTOR_PLUS") return Boolean(membership);
    if (
      actor.role !== "GESTOR_MEDICO" ||
      event.scopeKind === "INSTITUTION" ||
      !isPositiveInteger(event.hospitalId) ||
      (event.scopeKind === "SECTOR" && !isPositiveInteger(event.sectorId))
    ) {
      return false;
    }
    const sectorPredicate =
      event.scopeKind === "SECTOR"
        ? or(
            isNull(managerScope.sectorId),
            eq(managerScope.sectorId, event.sectorId!),
          )
        : isNull(managerScope.sectorId);
    const [scope] = await db
      .select({ id: managerScope.id })
      .from(managerScope)
      .where(
        and(
          eq(managerScope.institutionId, event.institutionId),
          eq(managerScope.managerProfessionalId, membership.professionalId),
          eq(managerScope.hospitalId, event.hospitalId),
          eq(managerScope.active, true),
          sectorPredicate,
        ),
      )
      .limit(1);
    return Boolean(scope);
  }

  async requeueDead(
    input: Readonly<{
      deliveryId: number;
      actor: OperationalDeliveryRequeueActor;
      now: Date;
    }>,
  ): Promise<OperationalDeliveryRequeueResult> {
    if (
      !isPositiveInteger(input.deliveryId) ||
      !isDate(input.now) ||
      !isPositiveInteger(input.actor.userId)
    ) {
      return { state: "AUTHORIZATION_DENIED" };
    }
    const now = databaseInstant(input.now);
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .select(drizzleDeliverySelection)
        .from(notificationDeliveries)
        .innerJoin(
          operationalEventRecipients,
          eq(
            operationalEventRecipients.id,
            notificationDeliveries.operationalEventRecipientId,
          ),
        )
        .innerJoin(
          operationalEvents,
          and(
            eq(
              operationalEvents.id,
              operationalEventRecipients.operationalEventId,
            ),
            eq(
              operationalEvents.institutionId,
              operationalEventRecipients.institutionId,
            ),
          ),
        )
        .where(eq(notificationDeliveries.id, input.deliveryId))
        .limit(1)
        .for("update");
      if (!row) return { state: "NOT_FOUND" };
      const record = recordFromDrizzleRow(row as DrizzleDeliveryRow);
      if (!record) return { state: "NOT_FOUND" };
      if (record.status !== "DEAD") return { state: "NOT_DEAD" };
      if (!canClaimOperationalDeliveryForEmissionMode(record.emissionMode)) {
        return { state: "NOT_CLAIMABLE" };
      }
      if (
        !(await this.hasCanonicalRequeueActor(
          tx,
          input.actor,
          row as DrizzleDeliveryRow,
        ))
      ) {
        return { state: "AUTHORIZATION_DENIED" };
      }

      const updateResult = await tx
        .update(notificationDeliveries)
        .set({
          status: "QUEUED",
          attemptCount: 0,
          availableAt: now,
          leaseUntil: null,
          providerAcceptedAt: null,
          deliveredAt: null,
          lastErrorCode: null,
        })
        .where(
          and(
            eq(notificationDeliveries.id, record.id),
            eq(notificationDeliveries.status, "DEAD"),
            eq(notificationDeliveries.attemptCount, record.attemptCount),
          ),
        );
      if (affectedRows(updateResult) !== 1) return { state: "NOT_DEAD" };
      await tx.insert(operationalDeliveryRequeueAudits).values({
        notificationDeliveryId: record.id,
        operationalEventId: record.operationalEventId,
        institutionId: record.institutionId,
        actorUserId: input.actor.userId,
        actorRole: input.actor.role,
        previousAttemptCount: record.attemptCount,
        createdAt: now,
      });
      return {
        state: "REQUEUED",
        delivery: cloneRecord({
          ...record,
          status: "QUEUED",
          attemptCount: 0,
          availableAt: now,
          leaseUntil: null,
          providerAcceptedAt: null,
          deliveredAt: null,
          lastErrorCode: null,
        }),
      };
    });
  }
}

export type OperationalDeliveryWorkerRun = {
  mode: "DISABLED" | "INERT_NO_TRANSPORT" | "ACTIVE_INJECTED";
  claimed: number;
  providerAccepted: number;
  delivered: number;
  failed: number;
};

export type OperationalDeliveryWorkerOptions = Readonly<{
  store?: OperationalDeliveryStore;
  transport?: OperationalDeliveryTransport;
  now?: Date;
  leaseMs?: number;
  limit?: number;
  jitter?: OperationalDeliveryBatchOptions["jitter"];
  observability?: OperationalDeliveryObservability;
}>;

/**
 * Só o literal true ativa a fundação. Valores como 1, yes ou ausência
 * permanecem desabilitados.
 */
export function isOperationalDeliveryWorkerEnabled(
  environment: Record<string, string | undefined> = process.env,
): boolean {
  return environment[OPERATIONAL_DELIVERY_WORKER_ENABLED_FLAG] === "true";
}

export async function runOperationalDeliveryWorker(
  environment: Record<string, string | undefined> = process.env,
  options: OperationalDeliveryWorkerOptions = {},
): Promise<OperationalDeliveryWorkerRun> {
  if (!isOperationalDeliveryWorkerEnabled(environment)) {
    return {
      mode: "DISABLED",
      claimed: 0,
      providerAccepted: 0,
      delivered: 0,
      failed: 0,
    };
  }
  if (!options.store || !options.transport) {
    return {
      mode: "INERT_NO_TRANSPORT",
      claimed: 0,
      providerAccepted: 0,
      delivered: 0,
      failed: 0,
    };
  }

  const result = await processOperationalDeliveryBatch({
    store: options.store,
    transport: options.transport,
    now: options.now,
    leaseMs: options.leaseMs,
    limit: options.limit,
    jitter: options.jitter,
    observability: options.observability,
  });
  return {
    mode: "ACTIVE_INJECTED",
    claimed: result.claimed,
    providerAccepted: result.providerAccepted,
    delivered: result.delivered,
    failed: result.failed,
  };
}

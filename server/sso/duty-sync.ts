// server/sso/duty-sync.ts — Fase 1 da integração: o Escala DECLARA o
// plantonista no Comunica+ (substitui a pergunta "você é o plantonista?"
// para quem está na escala oficial).
//
// CONFIRM declara responsabilidade pelo intervalo [dutyStart, dutyEnd).
// Não significa plantão agora, login, sessão ou presença imediata.
// Presença ativa é derivada no Comunica+ (confirmedAt + relógio).
// WITHDRAW anula a declaração quando o Escala+ já não considera aquele
// profissional responsável (recusa após confirmado, remoção, substituto).
//
// Auth: JWT RS256 assinado com a MESMA chave do SSO de handoff
// (o Comunica+ valida pela JWKS que já consome), com scope "duty:sync"
// e jti de uso único. Sem senha compartilhada.
//
// A intenção nasce na mesma transação da confirmação e é entregue por
// outbox idempotente. Falha de rede não desfaz a verdade local, mas também
// não é tratada como sucesso silencioso.

import { SignJWT } from "jose";
import { createHash, randomUUID } from "crypto";
import { and, eq, isNull, notExists, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/mysql-core";
import { getPrivateKey, KID, ALG } from "./keys";
import { getComunicaOrgId } from "./org-mapping";
import { getDb } from "../db";
import { dutyConfirmations, notifications, users } from "../../drizzle/schema";
import { ENV } from "../_core/env";
import {
  dutyShiftSnapshot,
  isCanonicalDutyConfirmationRejection,
  requireValidDutyConfirmation,
  type DutyShiftSnapshot,
} from "../confirmation-integrity";
import { resolveTrustedSsoTargetUrl } from "./url-policy";

const TOKEN_TTL_SEC = 90;
const DUTY_SYNC_VERSION = 1 as const;
export { DUTY_SYNC_VERSION };
const DUTY_SYNC_FETCH_TIMEOUT_MS = 15_000;
const DUTY_SYNC_LEASE_MARGIN_MS = 15_000;
const DUTY_SYNC_LEASE_MS =
  DUTY_SYNC_FETCH_TIMEOUT_MS + DUTY_SYNC_LEASE_MARGIN_MS;
const DUTY_SYNC_BATCH_SIZE = 8;
const DUTY_SYNC_CONCURRENCY = 4;
const DUTY_SYNC_MAX_RETRY_DELAY_MS = 30 * 60_000;
const DUTY_SYNC_AUTHORITY_REVOKED_MESSAGE = "Autoridade canônica do duty-sync revogada";
const DUTY_SYNC_INFRASTRUCTURE_MESSAGE = "Duty-sync temporariamente indisponível";
const DUTY_SYNC_SIGNING_MESSAGE = "Assinatura do duty-sync temporariamente indisponível";
const DUTY_SYNC_NETWORK_MESSAGE = "Comunica+ temporariamente indisponível";
const DUTY_SYNC_ORGANIZATION_CHANGED_MESSAGE =
  "Organização do duty-sync mudou desde a criação da intenção";
const DUTY_SYNC_UNMAPPED_ORGANIZATION_REASON =
  "UNMAPPED_COMUNICA_ORGANIZATION";
export const DUTY_SYNC_MISSING_EXTERNAL_SUBJECT_REASON =
  "MISSING_CANONICAL_EXTERNAL_SUBJECT";
const ORGANIZATION_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EXTERNAL_SUBJECT_PATTERN = /^[^\s@]+@[^\s@]+$/;
// O receptor Comunica+ persiste users.email em VARCHAR(160). Emitir um JWT
// maior produziria 4xx terminal depois de a verdade clínica já ter commitado.
const MAX_COMUNICA_EXTERNAL_SUBJECT_LENGTH = 160;
const DUTY_CONFIRMATION_STATUSES: readonly ConfirmationStatus[] = [
  "PENDING",
  "CONFIRMED",
  "DECLINED",
  "AUTO_CONFIRMED",
  "NOMINATED",
  "REPLACEMENT_CONFIRMED",
  "REPLACEMENT_DECLINED",
];

export type DutySyncAction = "CONFIRM" | "WITHDRAW";

type ConfirmationStatus = typeof dutyConfirmations.$inferSelect.status;

export type DutySyncProcessOptions = Readonly<{
  /** Limite menor usado por testes de ordenação; produção permanece em 4. */
  concurrency?: number;
}>;

export const DUTY_SYNC_STATUS_POLICY: Record<
  DutySyncAction,
  readonly ConfirmationStatus[]
> = {
  CONFIRM: ["CONFIRMED", "REPLACEMENT_CONFIRMED"],
  // WITHDRAW pode partir de CONFIRMED/AUTO_CONFIRMED (desistência ou
  // remoção operacional) sem estado novo: o envelope congela o status
  // canônico no momento da intenção.
  WITHDRAW: [
    "DECLINED",
    "NOMINATED",
    "REPLACEMENT_DECLINED",
    "REPLACEMENT_CONFIRMED",
    "CONFIRMED",
    "AUTO_CONFIRMED",
  ],
};

interface DutySyncResult {
  ok: boolean;
  error?: string;
  retryable?: boolean;
}

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;
type EnqueueDb = Pick<Db, "insert" | "select" | "update">;

type DutySyncQueued = {
  dutySyncVersion: typeof DUTY_SYNC_VERSION;
  phase: "QUEUED" | "PROCESSING";
  revision: number;
  confirmationId: number;
  sourceSequence: number;
  idempotencyKeySha256: string;
  organizationId: string;
  action: DutySyncAction;
  confirmationStatus: ConfirmationStatus;
  expectedStatuses: ConfirmationStatus[];
  targetUserId: number;
  shiftInstanceId: number;
  externalSubject: string;
  shiftSnapshot: DutyShiftSnapshot;
  dutyType: "PLANTAO" | "SOBREAVISO";
  serviceName?: string;
  attemptCount: number;
  availableAt: string;
  leaseUntil?: string;
  lastError?: string;
};

type DutySyncTerminal = Omit<DutySyncQueued, "phase"> & {
  phase: "SENT" | "FAILED";
  terminalAt: string;
  evidence: unknown;
};

type DutySyncSuppressed = {
  dutySyncVersion: typeof DUTY_SYNC_VERSION;
  phase: "FAILED";
  revision: number;
  confirmationId: number;
  sourceSequence: number;
  idempotencyKeySha256: string;
  organizationId?: string;
  action: DutySyncAction;
  confirmationStatus: ConfirmationStatus;
  expectedStatuses: ConfirmationStatus[];
  targetUserId: number;
  shiftInstanceId: number;
  externalSubject?: string;
  shiftSnapshot: DutyShiftSnapshot;
  dutyType: "PLANTAO" | "SOBREAVISO";
  serviceName?: string;
  attemptCount: number;
  terminalAt: string;
  evidence: {
    reason:
      | typeof DUTY_SYNC_UNMAPPED_ORGANIZATION_REASON
      | typeof DUTY_SYNC_MISSING_EXTERNAL_SUBJECT_REASON;
  };
};

export type DutySyncExternalSubjectBinding =
  | {
      externalSubject: string;
      externalSubjectUnavailableReason?: never;
    }
  | {
      externalSubject?: never;
      externalSubjectUnavailableReason: typeof DUTY_SYNC_MISSING_EXTERNAL_SUBJECT_REASON;
    };

export type DutySyncIntentInput = {
  confirmationId: number;
  institutionId: number;
  shiftInstanceId: number;
  targetUserId: number;
  shiftSnapshot: DutyShiftSnapshot;
  action: DutySyncAction;
  confirmationStatus: ConfirmationStatus;
  expectedStatuses: ConfirmationStatus[];
  dutyType: "PLANTAO" | "SOBREAVISO";
  serviceName?: string | null;
  dedupKey: string;
} & DutySyncExternalSubjectBinding;

const dutySyncPredecessor = alias(notifications, "duty_sync_predecessor");

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function canonicalizeDutySyncExternalSubject(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const canonical = value.trim().toLowerCase();
  return canonical &&
      canonical.length <= MAX_COMUNICA_EXTERNAL_SUBJECT_LENGTH &&
      EXTERNAL_SUBJECT_PATTERN.test(canonical)
    ? canonical
    : null;
}

function validDutySyncPurpose(
  action: DutySyncAction,
  expectedStatuses: readonly ConfirmationStatus[],
): boolean {
  const allowed = DUTY_SYNC_STATUS_POLICY[action];
  return (
    expectedStatuses.length > 0 &&
    new Set(expectedStatuses).size === expectedStatuses.length &&
    expectedStatuses.every((status) => allowed.includes(status))
  );
}

function parseShiftSnapshot(value: unknown): DutyShiftSnapshot | null {
  const snapshot = asRecord(value);
  if (
    !snapshot ||
    !Number.isSafeInteger(snapshot.institutionId) ||
    (snapshot.institutionId as number) <= 0 ||
    !Number.isSafeInteger(snapshot.hospitalId) ||
    (snapshot.hospitalId as number) <= 0 ||
    !Number.isSafeInteger(snapshot.sectorId) ||
    (snapshot.sectorId as number) <= 0 ||
    typeof snapshot.label !== "string" ||
    !snapshot.label.trim() ||
    typeof snapshot.startAt !== "string" ||
    typeof snapshot.endAt !== "string"
  ) return null;
  const startAt = new Date(snapshot.startAt);
  const endAt = new Date(snapshot.endAt);
  if (
    !Number.isFinite(startAt.getTime()) ||
    !Number.isFinite(endAt.getTime()) ||
    startAt.toISOString() !== snapshot.startAt ||
    endAt.toISOString() !== snapshot.endAt ||
    endAt <= startAt
  ) return null;
  return snapshot as DutyShiftSnapshot;
}

function sameShiftSnapshot(
  current: DutyShiftSnapshot,
  expected: DutyShiftSnapshot,
): boolean {
  return current.institutionId === expected.institutionId &&
    current.hospitalId === expected.hospitalId &&
    current.sectorId === expected.sectorId &&
    current.label === expected.label &&
    current.startAt === expected.startAt &&
    current.endAt === expected.endAt;
}

function isCanonicalIsoDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function idempotencyKeySha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function parseDutySyncState(value: unknown): DutySyncQueued | null {
  const state = asRecord(value);
  const externalSubject = canonicalizeDutySyncExternalSubject(state?.externalSubject);
  if (
    state?.dutySyncVersion !== DUTY_SYNC_VERSION ||
    (state.phase !== "QUEUED" && state.phase !== "PROCESSING") ||
    !Number.isInteger(state.revision) ||
    (state.revision as number) < 0 ||
    !Number.isSafeInteger(state.confirmationId) ||
    (state.confirmationId as number) <= 0 ||
    !Number.isSafeInteger(state.sourceSequence) ||
    (state.sourceSequence as number) <= 0 ||
    typeof state.idempotencyKeySha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(state.idempotencyKeySha256) ||
    typeof state.organizationId !== "string" ||
    !ORGANIZATION_UUID_PATTERN.test(state.organizationId) ||
    (state.action !== "CONFIRM" && state.action !== "WITHDRAW") ||
    typeof state.confirmationStatus !== "string" ||
    !DUTY_CONFIRMATION_STATUSES.includes(state.confirmationStatus as ConfirmationStatus) ||
    !Array.isArray(state.expectedStatuses) ||
    state.expectedStatuses.length === 0 ||
    !state.expectedStatuses.every(
      (status) =>
        typeof status === "string" &&
        DUTY_CONFIRMATION_STATUSES.includes(status as ConfirmationStatus),
    ) ||
    !validDutySyncPurpose(
      state.action as DutySyncAction,
      state.expectedStatuses as ConfirmationStatus[],
    ) ||
    !Number.isSafeInteger(state.targetUserId) ||
    (state.targetUserId as number) <= 0 ||
    !Number.isSafeInteger(state.shiftInstanceId) ||
    (state.shiftInstanceId as number) <= 0 ||
    !externalSubject ||
    state.externalSubject !== externalSubject ||
    !parseShiftSnapshot(state.shiftSnapshot) ||
    (state.dutyType !== "PLANTAO" && state.dutyType !== "SOBREAVISO") ||
    (state.serviceName !== undefined &&
      (typeof state.serviceName !== "string" || !state.serviceName.trim())) ||
    !Number.isInteger(state.attemptCount) ||
    (state.attemptCount as number) < 0 ||
    !isCanonicalIsoDate(state.availableAt) ||
    (state.phase === "PROCESSING" && !isCanonicalIsoDate(state.leaseUntil))
  ) return null;
  return state as DutySyncQueued;
}

function matchesPersistedDutySyncIntent(
  state: Record<string, unknown> | null,
  input: DutySyncIntentInput,
  externalSubject: string | null,
): boolean {
  if (!state || state.dutySyncVersion !== DUTY_SYNC_VERSION) return false;
  const evidence = asRecord(state.evidence);
  const hasFrozenOrganization =
    typeof state.organizationId === "string" &&
    ORGANIZATION_UUID_PATTERN.test(state.organizationId);
  const isUnmappedSuppression =
    state.organizationId === undefined &&
    state.phase === "FAILED" &&
    evidence?.reason === DUTY_SYNC_UNMAPPED_ORGANIZATION_REASON &&
    canonicalizeDutySyncExternalSubject(state.externalSubject) === state.externalSubject;
  const isMissingSubjectSuppression =
    state.externalSubject === undefined &&
    state.phase === "FAILED" &&
    evidence?.reason === DUTY_SYNC_MISSING_EXTERNAL_SUBJECT_REASON &&
    (state.organizationId === undefined || hasFrozenOrganization);
  const externalBindingMatches = isMissingSubjectSuppression
    ? externalSubject === null
    : state.externalSubject === externalSubject;
  return (
    (hasFrozenOrganization || isUnmappedSuppression || isMissingSubjectSuppression) &&
    externalBindingMatches &&
    state.confirmationId === input.confirmationId &&
    state.idempotencyKeySha256 === idempotencyKeySha256(input.dedupKey) &&
    state.action === input.action &&
    state.confirmationStatus === input.confirmationStatus &&
    state.targetUserId === input.targetUserId &&
    state.shiftInstanceId === input.shiftInstanceId &&
    JSON.stringify(state.shiftSnapshot) === JSON.stringify(input.shiftSnapshot) &&
    state.dutyType === input.dutyType &&
    state.serviceName === (input.serviceName?.trim() || undefined) &&
    JSON.stringify(state.expectedStatuses) === JSON.stringify(input.expectedStatuses)
  );
}

function isDuplicateEntry(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  if ("code" in error && (error as { code?: unknown }).code === "ER_DUP_ENTRY") return true;
  return "cause" in error && isDuplicateEntry((error as { cause?: unknown }).cause);
}

function dutyRevision(state: DutySyncQueued) {
  return and(
    sql`JSON_UNQUOTE(JSON_EXTRACT(${notifications.providerReceipt}, '$.phase')) = ${state.phase}`,
    sql`CAST(JSON_UNQUOTE(JSON_EXTRACT(${notifications.providerReceipt}, '$.revision')) AS UNSIGNED) = ${state.revision}`,
  );
}

function dutySyncRetryDelayMs(attemptCount: number): number {
  const exponent = Math.min(Math.max(attemptCount - 1, 0), 5);
  return Math.min(60_000 * 2 ** exponent, DUTY_SYNC_MAX_RETRY_DELAY_MS);
}

function isRetryableDutySyncHttp(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

export async function enqueueDutySync(
  input: DutySyncIntentInput,
  now = new Date(),
  dbOverride?: EnqueueDb,
): Promise<number> {
  if (
    !Number.isSafeInteger(input.confirmationId) || input.confirmationId <= 0 ||
    !Number.isSafeInteger(input.institutionId) || input.institutionId <= 0 ||
    !Number.isSafeInteger(input.shiftInstanceId) || input.shiftInstanceId <= 0 ||
    !Number.isSafeInteger(input.targetUserId) || input.targetUserId <= 0
  ) {
    throw new Error("IDs inválidos no duty-sync");
  }
  if (!validDutySyncPurpose(input.action, input.expectedStatuses)) {
    throw new Error("Purpose ou status esperado invalido no duty-sync");
  }
  if (
    !input.expectedStatuses.includes(input.confirmationStatus) ||
    (input.dutyType !== "PLANTAO" && input.dutyType !== "SOBREAVISO") ||
    typeof input.dedupKey !== "string" ||
    !input.dedupKey.trim() ||
    (input.serviceName != null && !input.serviceName.trim())
  ) {
    throw new Error("Envelope imutável inválido no duty-sync");
  }
  const externalSubject = canonicalizeDutySyncExternalSubject(input.externalSubject);
  if (!parseShiftSnapshot(input.shiftSnapshot)) {
    throw new Error("Snapshot do plantão inválido no duty-sync");
  }
  if (input.externalSubjectUnavailableReason && externalSubject) {
    throw new Error("Binding externo ambíguo no duty-sync");
  }
  const db = dbOverride ?? await getDb();
  if (!db) throw new Error("Database unavailable");
  const mappedOrganizationId = getComunicaOrgId(input.institutionId);
  const organizationId = mappedOrganizationId &&
      ORGANIZATION_UUID_PATTERN.test(mappedOrganizationId)
    ? mappedOrganizationId
    : null;
  const suppressionReason = !externalSubject
    ? DUTY_SYNC_MISSING_EXTERNAL_SUBJECT_REASON
    : organizationId
      ? null
      : DUTY_SYNC_UNMAPPED_ORGANIZATION_REASON;
  const initial: DutySyncQueued | DutySyncSuppressed = !suppressionReason
    ? {
        dutySyncVersion: DUTY_SYNC_VERSION,
        phase: "QUEUED",
        revision: 1,
        confirmationId: input.confirmationId,
        sourceSequence: 0,
        idempotencyKeySha256: idempotencyKeySha256(input.dedupKey),
        organizationId: organizationId!,
        action: input.action,
        confirmationStatus: input.confirmationStatus,
        expectedStatuses: input.expectedStatuses,
        targetUserId: input.targetUserId,
        shiftInstanceId: input.shiftInstanceId,
        externalSubject: externalSubject!,
        shiftSnapshot: input.shiftSnapshot,
        dutyType: input.dutyType,
        ...(input.serviceName?.trim() ? { serviceName: input.serviceName.trim() } : {}),
        attemptCount: 0,
        availableAt: now.toISOString(),
      }
    : {
        dutySyncVersion: DUTY_SYNC_VERSION,
        phase: "FAILED",
        revision: 1,
        confirmationId: input.confirmationId,
        sourceSequence: 0,
        idempotencyKeySha256: idempotencyKeySha256(input.dedupKey),
        ...(organizationId ? { organizationId } : {}),
        action: input.action,
        confirmationStatus: input.confirmationStatus,
        expectedStatuses: input.expectedStatuses,
        targetUserId: input.targetUserId,
        shiftInstanceId: input.shiftInstanceId,
        ...(externalSubject ? { externalSubject } : {}),
        shiftSnapshot: input.shiftSnapshot,
        dutyType: input.dutyType,
        ...(input.serviceName?.trim() ? { serviceName: input.serviceName.trim() } : {}),
        attemptCount: 0,
        terminalAt: now.toISOString(),
        evidence: {
          reason: suppressionReason!,
        },
      };
  let notificationId: number;
  try {
    const [inserted] = await db
      .insert(notifications)
      .values({
        institutionId: input.institutionId,
        userId: input.targetUserId,
        title: "Duty roster sync",
        body: input.action,
        type: "GENERAL",
        status: suppressionReason ? "FAILED" : "PENDING",
        shiftInstanceId: input.shiftInstanceId,
        dedupKey: input.dedupKey,
        providerReceipt: initial,
        errorMessage: suppressionReason,
      })
      .$returningId();
    notificationId = inserted.id;
    const [bound] = await db
      .update(notifications)
      .set({ providerReceipt: { ...initial, sourceSequence: notificationId } })
      .where(eq(notifications.id, notificationId));
    if (bound.affectedRows !== 1) {
      throw new Error("Falha ao vincular sequência do duty-sync");
    }
  } catch (error) {
    if (!isDuplicateEntry(error)) throw error;
    const [existing] = await db
      .select({
        id: notifications.id,
        institutionId: notifications.institutionId,
        userId: notifications.userId,
        shiftInstanceId: notifications.shiftInstanceId,
        providerReceipt: notifications.providerReceipt,
      })
      .from(notifications)
      .where(eq(notifications.dedupKey, input.dedupKey))
      .limit(1);
    const state = existing ? asRecord(existing.providerReceipt) : null;
    if (
      !existing ||
      !matchesPersistedDutySyncIntent(state, input, externalSubject) ||
      state?.sourceSequence !== existing.id ||
      existing.institutionId !== input.institutionId ||
      existing.userId !== input.targetUserId ||
      existing.shiftInstanceId !== input.shiftInstanceId
    ) {
      throw new Error(`Colisao de dedupKey no duty-sync: ${input.dedupKey}`);
    }
    notificationId = existing.id;
  }
  return notificationId;
}

/**
 * Sincroniza o estado de plantonista de uma duty_confirmation do Escala
 * com o roster do Comunica+.
 *
 * CONFIRM  → declara o intervalo; presença ativa só no horário.
 * WITHDRAW → declaração retirada (desistência, remoção, substituto).
 */
export async function syncDutyToComunica(
  confirmationId: number,
  action: DutySyncAction,
  options: {
    expectedStatuses?: ConfirmationStatus[];
    expectedTargetUserId?: number;
    expectedInstitutionId?: number;
    expectedShiftInstanceId?: number;
    expectedExternalSubject?: string;
    expectedShiftSnapshot?: DutyShiftSnapshot;
    expectedOrganizationId?: string;
    idempotencyKey?: string;
    idempotencyKeySha256?: string;
    sourceSequence?: number;
    confirmationStatus?: ConfirmationStatus;
    dutyType?: "PLANTAO" | "SOBREAVISO";
    serviceName?: string;
  } = {},
): Promise<DutySyncResult> {
  const expectedStatuses =
    options.expectedStatuses ?? DUTY_SYNC_STATUS_POLICY[action];
  if (!validDutySyncPurpose(action, expectedStatuses)) {
    return { ok: false, error: "Purpose ou status esperado invalido", retryable: false };
  }
  const externalSubject = canonicalizeDutySyncExternalSubject(
    options.expectedExternalSubject,
  );
  const shiftSnapshot = parseShiftSnapshot(options.expectedShiftSnapshot);
  const idempotencyKey = options.idempotencyKey;
  const calculatedIdempotencyHash = typeof idempotencyKey === "string"
    ? idempotencyKeySha256(idempotencyKey)
    : null;
  if (
    !Number.isSafeInteger(confirmationId) ||
    confirmationId <= 0 ||
    !externalSubject ||
    externalSubject !== options.expectedExternalSubject ||
    !shiftSnapshot ||
    !Number.isSafeInteger(options.expectedTargetUserId) ||
    (options.expectedTargetUserId ?? 0) <= 0 ||
    !Number.isSafeInteger(options.expectedInstitutionId) ||
    (options.expectedInstitutionId ?? 0) <= 0 ||
    !Number.isSafeInteger(options.expectedShiftInstanceId) ||
    (options.expectedShiftInstanceId ?? 0) <= 0 ||
    typeof options.expectedOrganizationId !== "string" ||
    !ORGANIZATION_UUID_PATTERN.test(options.expectedOrganizationId) ||
    typeof idempotencyKey !== "string" ||
    !idempotencyKey.trim() ||
    typeof options.idempotencyKeySha256 !== "string" ||
    options.idempotencyKeySha256 !== calculatedIdempotencyHash ||
    !Number.isSafeInteger(options.sourceSequence) ||
    (options.sourceSequence ?? 0) <= 0 ||
    typeof options.confirmationStatus !== "string" ||
    !expectedStatuses.includes(options.confirmationStatus) ||
    (options.dutyType !== "PLANTAO" && options.dutyType !== "SOBREAVISO") ||
    (options.serviceName !== undefined && !options.serviceName.trim()) ||
    shiftSnapshot.institutionId !== options.expectedInstitutionId
  ) {
    return {
      ok: false,
      error: "Envelope imutável inválido no duty-sync",
      retryable: false,
    };
  }

  try {
    const frozenRequest = {
      organizationId: options.expectedOrganizationId,
      externalSubject,
      action,
      targetUserId: options.expectedTargetUserId!,
      shiftInstanceId: options.expectedShiftInstanceId!,
      confirmationStatus: options.confirmationStatus!,
      dutyType: options.dutyType!,
      dutyStart: shiftSnapshot.startAt,
      dutyEnd: shiftSnapshot.endAt,
      serviceName: options.serviceName,
      idempotencyKey,
      idempotencyKeySha256: options.idempotencyKeySha256,
      sourceSequence: options.sourceSequence!,
    };

    // WITHDRAW é uma compensação durável. Revalidar tenant, roster, PI/ACL,
    // mapping ou a confirmação atual poderia impedir justamente a remoção do
    // efeito externo antigo. A autoridade aqui é o envelope imutável que o
    // worker acabou de vincular à row/sourceSequence por CAS.
    const prepared = action === "WITHDRAW"
      ? { ok: true as const, request: frozenRequest }
      : await (async () => {
          let db: Db | null;
          try {
            db = await getDb();
          } catch {
            return { ok: false as const, error: DUTY_SYNC_INFRASTRUCTURE_MESSAGE, retryable: true };
          }
          if (!db) {
            return { ok: false as const, error: DUTY_SYNC_INFRASTRUCTURE_MESSAGE, retryable: true };
          }
          return db.transaction(async (tx) => {
            let valid;
            try {
              valid = await requireValidDutyConfirmation(tx, confirmationId, {
                allowedStatuses: expectedStatuses,
                requireOriginalAssignmentActive: false,
                requireEffectiveAssignment: true,
                lockForUpdate: true,
              });
            } catch (error) {
              return isCanonicalDutyConfirmationRejection(error)
                ? { ok: false as const, error: DUTY_SYNC_AUTHORITY_REVOKED_MESSAGE, retryable: false }
                : { ok: false as const, error: DUTY_SYNC_INFRASTRUCTURE_MESSAGE, retryable: true };
            }
            const currentSnapshot = dutyShiftSnapshot(valid.shift);
            const currentOrganizationId = getComunicaOrgId(valid.shift.institutionId);
            const currentDutyType = valid.shift.modality === "SOBREAVISO" ? "SOBREAVISO" : "PLANTAO";
            if (
              valid.confirmation.status !== options.confirmationStatus ||
              valid.shift.institutionId !== options.expectedInstitutionId ||
              valid.shift.id !== frozenRequest.shiftInstanceId ||
              valid.effective.userId !== options.expectedTargetUserId ||
              !sameShiftSnapshot(currentSnapshot, shiftSnapshot) ||
              currentOrganizationId !== options.expectedOrganizationId ||
              currentDutyType !== options.dutyType ||
              (valid.shift.specialty ?? undefined) !== options.serviceName
            ) {
              return {
                ok: false as const,
                error: DUTY_SYNC_ORGANIZATION_CHANGED_MESSAGE,
                retryable: false,
              };
            }
            const [user] = await tx
              .select({ email: users.email })
              .from(users)
              .where(
                and(
                  eq(users.id, valid.effective.userId),
                  eq(users.approvalStatus, "APPROVED"),
                  isNull(users.deletedAt),
                ),
              )
              .limit(1);
            if (canonicalizeDutySyncExternalSubject(user?.email) !== externalSubject) {
              return {
                ok: false as const,
                error: "Subject externo mudou ou deixou de estar ativo",
                retryable: false,
              };
            }
            return { ok: true as const, request: frozenRequest };
          });
        })();
    if (!prepared.ok) return prepared;

    const request = prepared.request;
    if (!request) {
      return { ok: false, error: "Snapshot do duty-sync não foi preparado", retryable: false };
    }
    const targetBaseUrl = resolveTrustedSsoTargetUrl();
    if (!targetBaseUrl) {
      console.error("[DutySync] SSO_TARGET_URL ausente ou invalida; rede bloqueada");
      return { ok: false, error: "Destino Comunica+ invalido", retryable: true };
    }
    const issuedAt = Math.floor(Date.now() / 1000);
    let token: string;
    try {
      const privateKey = await getPrivateKey();
      token = await new SignJWT({
        scope: "duty:sync",
        organizationId: request.organizationId,
        email: request.externalSubject,
        action: request.action,
        sourceSequence: request.sourceSequence,
        idempotencyKeySha256: request.idempotencyKeySha256,
        dutyType: request.dutyType,
        dutyStart: request.dutyStart,
        dutyEnd: request.dutyEnd,
        ...(request.serviceName ? { serviceName: request.serviceName } : {}),
      })
        .setProtectedHeader({ alg: ALG, kid: KID, typ: "JWT" })
        .setIssuer(ENV.ssoIssuer)
        .setAudience(ENV.ssoAudience)
        .setSubject(request.externalSubject)
        .setJti(randomUUID())
        .setIssuedAt(issuedAt)
        .setExpirationTime(issuedAt + TOKEN_TTL_SEC)
        .sign(privateKey);
    } catch {
      return { ok: false, error: DUTY_SYNC_SIGNING_MESSAGE, retryable: true };
    }

    try {
      const res = await fetch(`${targetBaseUrl}/api/integrations/duty-roster`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          "Idempotency-Key": request.idempotencyKey,
          "X-Escala-Confirmation-State": request.confirmationStatus,
        },
        body: JSON.stringify({ sourceSequence: request.sourceSequence }),
        signal: AbortSignal.timeout(DUTY_SYNC_FETCH_TIMEOUT_MS),
      });
      if (!res.ok) {
        console.warn(
          `[DutySync] Comunica+ retornou ${res.status} para ${action} conf=${confirmationId}`,
        );
        return {
          ok: false,
          error: `Comunica+ retornou ${res.status}`,
          retryable: isRetryableDutySyncHttp(res.status),
        };
      }
      console.log(`[DutySync] ${action} ok — conf=${confirmationId} user=${request.targetUserId}`);
      return { ok: true };
    } catch {
      console.error(`[DutySync] NETWORK_FAILED action=${action} confirmation=${confirmationId}`);
      return { ok: false, error: DUTY_SYNC_NETWORK_MESSAGE, retryable: true };
    }
  } catch {
    return { ok: false, error: DUTY_SYNC_INFRASTRUCTURE_MESSAGE, retryable: true };
  }
}

async function processDutySyncRow(
  db: Db,
  row: typeof notifications.$inferSelect,
  state: DutySyncQueued,
  now: Date,
): Promise<boolean> {
  if (
    row.title !== "Duty roster sync" ||
    row.body !== state.action ||
    row.userId !== state.targetUserId ||
    row.shiftInstanceId == null ||
    row.shiftInstanceId !== state.shiftInstanceId ||
    row.institutionId !== state.shiftSnapshot.institutionId ||
    row.id !== state.sourceSequence ||
    typeof row.dedupKey !== "string" ||
    !row.dedupKey.trim() ||
    idempotencyKeySha256(row.dedupKey) !== state.idempotencyKeySha256 ||
    !validDutySyncPurpose(state.action, state.expectedStatuses)
  ) {
    await failMalformedDutySyncRow(db, row, now);
    return true;
  }
  // `now` é o corte do scan, não o instante em que cada grupo conquista sua
  // linha. Um grupo pode esperar outro fetch; seu lease precisa nascer aqui.
  const claimedAt = new Date(Math.max(now.getTime(), Date.now()));
  const claimed: DutySyncQueued = {
    ...state,
    phase: "PROCESSING",
    revision: state.revision + 1,
    attemptCount: state.attemptCount + 1,
    leaseUntil: new Date(claimedAt.getTime() + DUTY_SYNC_LEASE_MS).toISOString(),
  };
  const [claim] = await db
    .update(notifications)
    .set({ providerReceipt: claimed })
    .where(
      and(
        eq(notifications.id, row.id),
        eq(notifications.status, "PENDING"),
        dutyRevision(state),
      ),
    );
  if (claim.affectedRows !== 1) return false;

  const result = await syncDutyToComunica(claimed.confirmationId, claimed.action, {
    expectedStatuses: claimed.expectedStatuses,
    expectedTargetUserId: claimed.targetUserId,
    expectedExternalSubject: claimed.externalSubject,
    expectedShiftSnapshot: claimed.shiftSnapshot,
    expectedOrganizationId: claimed.organizationId,
    expectedInstitutionId: row.institutionId,
    expectedShiftInstanceId: claimed.shiftInstanceId,
    idempotencyKey: row.dedupKey,
    idempotencyKeySha256: claimed.idempotencyKeySha256,
    sourceSequence: claimed.sourceSequence,
    confirmationStatus: claimed.confirmationStatus,
    dutyType: claimed.dutyType,
    serviceName: claimed.serviceName,
  });
  const finishedAt = new Date(Math.max(now.getTime(), Date.now()));
  if (result.ok) {
    const terminal: DutySyncTerminal = {
      ...claimed,
      revision: claimed.revision + 1,
      phase: "SENT",
      terminalAt: finishedAt.toISOString(),
      evidence: { ok: true },
    };
    await db
      .update(notifications)
      .set({
        status: "SENT",
        sentAt: finishedAt,
        providerReceipt: terminal,
        errorMessage: null,
      })
      .where(
        and(
          eq(notifications.id, row.id),
          eq(notifications.status, "PENDING"),
          dutyRevision(claimed),
        ),
      );
    return true;
  }

  if (result.retryable) {
    // A verdade local não expira porque o Comunica+ ficou indisponível.
    // Erros transitórios permanecem recuperáveis com backoff limitado; apenas
    // autoridade/status/topologia inválidos terminam o intent.
    const delayMs = dutySyncRetryDelayMs(claimed.attemptCount);
    const queued: DutySyncQueued = {
      ...claimed,
      phase: "QUEUED",
      revision: claimed.revision + 1,
      availableAt: new Date(finishedAt.getTime() + delayMs).toISOString(),
      lastError: result.error ?? "Falha transitoria no duty-sync",
    };
    delete queued.leaseUntil;
    await db
      .update(notifications)
      .set({ providerReceipt: queued, errorMessage: queued.lastError })
      .where(
        and(
          eq(notifications.id, row.id),
          eq(notifications.status, "PENDING"),
          dutyRevision(claimed),
        ),
      );
    return true;
  }

  const terminal: DutySyncTerminal = {
    ...claimed,
    revision: claimed.revision + 1,
    phase: "FAILED",
    terminalAt: finishedAt.toISOString(),
    evidence: result,
  };
  await db
    .update(notifications)
    .set({
      status: "FAILED",
      providerReceipt: terminal,
      errorMessage: result.error ?? "Duty-sync falhou",
    })
    .where(
      and(
        eq(notifications.id, row.id),
        eq(notifications.status, "PENDING"),
        dutyRevision(claimed),
      ),
    );
  return true;
}

async function failMalformedDutySyncRow(
  db: Db,
  row: typeof notifications.$inferSelect,
  now: Date,
): Promise<void> {
  await db
    .update(notifications)
    .set({
      status: "FAILED",
      providerReceipt: {
        dutySyncVersion: DUTY_SYNC_VERSION,
        phase: "FAILED",
        terminalAt: now.toISOString(),
        evidence: {
          reason: "MALFORMED_DUTY_SYNC_STATE",
        },
      },
      errorMessage: "Estado persistido do duty-sync e invalido",
    })
    .where(and(eq(notifications.id, row.id), eq(notifications.status, "PENDING")));
}

/**
 * Processa somente intents devidas. Um predecessor futuro bloqueia apenas a
 * mesma confirmação ou a mesma identidade externa de plantão
 * (organização + subject + início); chaves independentes seguem vivas.
 */
export async function processPendingDutySyncs(
  now = new Date(),
  options: DutySyncProcessOptions = {},
): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const nowIso = now.toISOString();
  const rows = await db
    .select()
    .from(notifications)
    .where(
      and(
        eq(notifications.status, "PENDING"),
        or(
          eq(notifications.title, "Duty roster sync"),
          sql`CAST(JSON_UNQUOTE(JSON_EXTRACT(${notifications.providerReceipt}, '$.dutySyncVersion')) AS UNSIGNED) = ${DUTY_SYNC_VERSION}`,
        ),
        sql`(
          JSON_EXTRACT(${notifications.providerReceipt}, '$.dutySyncVersion') IS NULL
          OR CAST(JSON_UNQUOTE(JSON_EXTRACT(${notifications.providerReceipt}, '$.dutySyncVersion')) AS UNSIGNED) <> ${DUTY_SYNC_VERSION}
          OR ${notifications.title} <> 'Duty roster sync'
          OR JSON_UNQUOTE(JSON_EXTRACT(${notifications.providerReceipt}, '$.phase')) IS NULL
          OR JSON_UNQUOTE(JSON_EXTRACT(${notifications.providerReceipt}, '$.phase')) NOT IN ('QUEUED', 'PROCESSING')
          OR JSON_EXTRACT(${notifications.providerReceipt}, '$.revision') IS NULL
          OR JSON_EXTRACT(${notifications.providerReceipt}, '$.confirmationId') IS NULL
          OR JSON_EXTRACT(${notifications.providerReceipt}, '$.sourceSequence') IS NULL
          OR JSON_EXTRACT(${notifications.providerReceipt}, '$.idempotencyKeySha256') IS NULL
          OR JSON_EXTRACT(${notifications.providerReceipt}, '$.organizationId') IS NULL
          OR JSON_EXTRACT(${notifications.providerReceipt}, '$.action') IS NULL
          OR JSON_EXTRACT(${notifications.providerReceipt}, '$.confirmationStatus') IS NULL
          OR JSON_EXTRACT(${notifications.providerReceipt}, '$.expectedStatuses') IS NULL
          OR JSON_EXTRACT(${notifications.providerReceipt}, '$.targetUserId') IS NULL
          OR ${notifications.shiftInstanceId} IS NULL
          OR JSON_EXTRACT(${notifications.providerReceipt}, '$.shiftInstanceId') IS NULL
          OR CAST(JSON_UNQUOTE(JSON_EXTRACT(${notifications.providerReceipt}, '$.shiftInstanceId')) AS UNSIGNED) <> ${notifications.shiftInstanceId}
          OR JSON_EXTRACT(${notifications.providerReceipt}, '$.externalSubject') IS NULL
          OR JSON_EXTRACT(${notifications.providerReceipt}, '$.shiftSnapshot') IS NULL
          OR JSON_EXTRACT(${notifications.providerReceipt}, '$.dutyType') IS NULL
          OR JSON_EXTRACT(${notifications.providerReceipt}, '$.attemptCount') IS NULL
          OR (JSON_UNQUOTE(JSON_EXTRACT(${notifications.providerReceipt}, '$.phase')) = 'QUEUED'
            AND JSON_EXTRACT(${notifications.providerReceipt}, '$.availableAt') IS NULL)
          OR (JSON_UNQUOTE(JSON_EXTRACT(${notifications.providerReceipt}, '$.phase')) = 'PROCESSING'
            AND JSON_EXTRACT(${notifications.providerReceipt}, '$.leaseUntil') IS NULL)
          OR (JSON_UNQUOTE(JSON_EXTRACT(${notifications.providerReceipt}, '$.phase')) = 'QUEUED'
            AND JSON_UNQUOTE(JSON_EXTRACT(${notifications.providerReceipt}, '$.availableAt')) <= ${nowIso})
          OR (JSON_UNQUOTE(JSON_EXTRACT(${notifications.providerReceipt}, '$.phase')) = 'PROCESSING'
            AND JSON_UNQUOTE(JSON_EXTRACT(${notifications.providerReceipt}, '$.leaseUntil')) <= ${nowIso})
        )`,
        notExists(
          db
            .select({ id: dutySyncPredecessor.id })
            .from(dutySyncPredecessor)
            .where(
              and(
                eq(dutySyncPredecessor.status, "PENDING"),
                or(
                  eq(dutySyncPredecessor.title, "Duty roster sync"),
                  sql`CAST(JSON_UNQUOTE(JSON_EXTRACT(${dutySyncPredecessor.providerReceipt}, '$.dutySyncVersion')) AS UNSIGNED) = ${DUTY_SYNC_VERSION}`,
                ),
                sql`${dutySyncPredecessor.id} < ${notifications.id}`,
                or(
                  sql`JSON_EXTRACT(${dutySyncPredecessor.providerReceipt}, '$.confirmationId') = JSON_EXTRACT(${notifications.providerReceipt}, '$.confirmationId')`,
                  and(
                    sql`JSON_EXTRACT(${dutySyncPredecessor.providerReceipt}, '$.organizationId') = JSON_EXTRACT(${notifications.providerReceipt}, '$.organizationId')`,
                    sql`JSON_EXTRACT(${dutySyncPredecessor.providerReceipt}, '$.externalSubject') = JSON_EXTRACT(${notifications.providerReceipt}, '$.externalSubject')`,
                    sql`JSON_EXTRACT(${dutySyncPredecessor.providerReceipt}, '$.shiftSnapshot.startAt') = JSON_EXTRACT(${notifications.providerReceipt}, '$.shiftSnapshot.startAt')`,
                  ),
                ),
              ),
            )
            .limit(1),
        ),
      ),
    )
    .orderBy(notifications.id)
    .limit(DUTY_SYNC_BATCH_SIZE);

  let processed = 0;
  const groups = new Map<number, {
    row: typeof notifications.$inferSelect;
    state: DutySyncQueued;
  }[]>();
  for (const row of rows) {
    const state = parseDutySyncState(row.providerReceipt);
    if (!state) {
      await failMalformedDutySyncRow(db, row, now);
      processed += 1;
      continue;
    }
    const group = groups.get(state.confirmationId) ?? [];
    group.push({ row, state });
    groups.set(state.confirmationId, group);
  }

  // O NOT EXISTS acima deixa no lote somente o predecessor de cada
  // confirmação/chave externa. Grupos independentes avançam em paralelo; o
  // limite preserva conexões do pool mesmo se o Comunica+ ficar indisponível.
  const orderedGroups = [...groups.values()];
  const requestedConcurrency = options.concurrency ?? DUTY_SYNC_CONCURRENCY;
  const concurrency = Number.isSafeInteger(requestedConcurrency)
    ? Math.min(DUTY_SYNC_CONCURRENCY, Math.max(1, requestedConcurrency))
    : DUTY_SYNC_CONCURRENCY;
  let cursor = 0;
  await Promise.all(
    Array.from(
      { length: Math.min(concurrency, orderedGroups.length) },
      async () => {
        while (cursor < orderedGroups.length) {
          const group = orderedGroups[cursor++];
          if (!group) return;
          for (const { row, state } of group) {
            try {
              if (await processDutySyncRow(db, row, state, now)) processed += 1;
            } catch {
              console.error(`[DutySync] ROW_PROCESSING_FAILED notification=${row.id}`);
            }
          }
        }
      },
    ),
  );
  return processed;
}

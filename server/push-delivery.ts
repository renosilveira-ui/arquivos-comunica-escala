import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { dutyConfirmations, notifications } from "../drizzle/schema";
import { getDb } from "./db";
import {
  getExpoPushReceipts,
  PUSH_SUBMISSION_LEASE_HORIZON_MS,
  dispatchAccountWideNativeBadgeSnapshot,
  sendPushNotification,
  withAuthoritativePushRecipient,
  type ExpoReceiptTarget,
  type PushNotificationPayload,
  type PushSendResult,
} from "./notifications-service";
import {
  isCanonicalDutyConfirmationRejection,
  PersistedDutyConfirmationBindingError,
  requireAuthorizedDutyConfirmationRecipient,
  type DutyConfirmationRecipientAuthority,
  type DutyConfirmationStatus,
  type DutyShiftSnapshot,
} from "./confirmation-integrity";
import {
  ACCOUNT_WIDE_BADGE_VERSION,
  isAccountWideBadgeNotificationType,
} from "../lib/account-wide-native-badge";

const TRACKING_VERSION = 1 as const;
const SUBMISSION_LEASE_MS = 2 * 60_000;
const RECEIPT_DUE_MS = 15 * 60_000;
const RECEIPT_RETRY_MS = 5 * 60_000;
const MAX_SUBMISSION_ATTEMPTS = 3;
const MAX_RECEIPT_ATTEMPTS = 3;
const DELIVERY_BATCH_SIZE = 10;
const DELIVERY_CONCURRENCY = 5;
const PUSH_AUTHORITY_RETRY_MESSAGE = "Falha temporária ao validar autoridade do destinatário";
const PUSH_AUTHORITY_REVOKED_MESSAGE = "Autoridade do destinatário revogada";
const DUTY_CONFIRMATION_STATUSES: readonly DutyConfirmationStatus[] = [
  "PENDING",
  "CONFIRMED",
  "DECLINED",
  "AUTO_CONFIRMED",
  "NOMINATED",
  "REPLACEMENT_CONFIRMED",
  "REPLACEMENT_DECLINED",
];
const DUTY_CONFIRMATION_RECIPIENTS: readonly DutyConfirmationRecipientAuthority[] = [
  "ORIGINAL",
  "REPLACEMENT",
  "EFFECTIVE",
  "MANAGER",
];
const DUTY_CONFIRMATION_PURPOSES = [
  "CONFIRMATION_REQUEST",
  "NOMINATION_REQUEST",
  "REPLACEMENT_ACCEPTED_NOTICE",
  "REPLACEMENT_DECLINED_NOTICE",
  "SSO_READY",
  "MANAGER_ESCALATION",
] as const;

export type DutyConfirmationPushPurpose =
  (typeof DUTY_CONFIRMATION_PURPOSES)[number];

const DUTY_CONFIRMATION_PURPOSE_POLICY: Record<
  DutyConfirmationPushPurpose,
  {
    payloadType: string;
    recipientKind: DutyConfirmationRecipientAuthority;
    allowedStatuses: readonly DutyConfirmationStatus[];
  }
> = {
  CONFIRMATION_REQUEST: {
    payloadType: "duty_confirmation",
    recipientKind: "ORIGINAL",
    allowedStatuses: ["PENDING"],
  },
  NOMINATION_REQUEST: {
    payloadType: "duty_nomination",
    recipientKind: "REPLACEMENT",
    allowedStatuses: ["NOMINATED"],
  },
  REPLACEMENT_ACCEPTED_NOTICE: {
    payloadType: "replacement_accepted",
    recipientKind: "ORIGINAL",
    allowedStatuses: ["REPLACEMENT_CONFIRMED"],
  },
  REPLACEMENT_DECLINED_NOTICE: {
    payloadType: "replacement_declined",
    recipientKind: "ORIGINAL",
    allowedStatuses: ["REPLACEMENT_DECLINED"],
  },
  SSO_READY: {
    payloadType: "sso_ready",
    recipientKind: "EFFECTIVE",
    allowedStatuses: ["CONFIRMED", "REPLACEMENT_CONFIRMED"],
  },
  MANAGER_ESCALATION: {
    payloadType: "manager_confirmation_escalation",
    recipientKind: "MANAGER",
    allowedStatuses: ["PENDING", "DECLINED", "NOMINATED", "REPLACEMENT_DECLINED"],
  },
};

type PayloadData = Record<string, unknown>;

type TrackingBase = {
  trackingVersion: typeof TRACKING_VERSION;
  revision: number;
  payloadData: PayloadData;
  attemptCount: number;
  /** Marker interno do outbox; nunca integra o envelope enviado ao Expo. */
  accountWideBadgeVersion?: typeof ACCOUNT_WIDE_BADGE_VERSION;
  authority?: DutyConfirmationPushAuthority;
};

type QueuedState = TrackingBase & {
  phase: "QUEUED";
  availableAt: string;
  lastError?: string;
};

type SubmittingState = TrackingBase & {
  phase: "SUBMITTING";
  leaseUntil: string;
};

type TicketAcceptedState = TrackingBase & {
  phase: "TICKET_ACCEPTED";
  submittedAt: string;
  receiptDueAt: string;
  receiptAttempts: number;
  tickets: ExpoReceiptTarget[];
  submission: PushSendResult;
};

type ReceiptCheckingState = Omit<TicketAcceptedState, "phase"> & {
  phase: "RECEIPT_CHECKING";
  leaseUntil: string;
};

type PendingTrackingState =
  | QueuedState
  | SubmittingState
  | TicketAcceptedState
  | ReceiptCheckingState;

type TerminalTrackingState = TrackingBase & {
  phase: "PROVIDER_ACCEPTED" | "FAILED";
  terminalAt: string;
  evidence: unknown;
};

export type TrackedPushResult = {
  notificationId: number;
  status: "PENDING" | "SENT" | "FAILED";
  phase: PendingTrackingState["phase"] | TerminalTrackingState["phase"] | "UNKNOWN";
  ticketAccepted: boolean;
  providerAccepted: boolean;
};

export type TrackedPushInput = {
  institutionId: number;
  userId: number;
  shiftInstanceId?: number | null;
  dedupKey: string;
  payload: PushNotificationPayload;
  deepLink?: string | null;
  authority?: DutyConfirmationPushAuthority;
};

export type DutyConfirmationPushAuthority = {
  kind: "DUTY_CONFIRMATION";
  purpose: DutyConfirmationPushPurpose;
  confirmationId: number;
  allowedStatuses: DutyConfirmationStatus[];
  recipientKind: DutyConfirmationRecipientAuthority;
  expectedUserId: number;
  shiftSnapshot: DutyShiftSnapshot;
};

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;
type EnqueueDb = Pick<Db, "insert" | "select" | "update">;
type NotificationRow = typeof notifications.$inferSelect;

export type PushDeliveryExecutionOptions = Readonly<{
  /** Somente testes podem encurtar o claim inicial para exercitar renewal. */
  submissionLeaseMs?: number;
  /** Test hook: pausa depois da leitura do estado e antes do CAS de claim. */
  beforeSubmissionClaim?: (point: Readonly<{
    notificationId: number;
    sourceRevision: number;
  }>) => Promise<void>;
  /** Test hook: pausa o owner imediatamente antes de renovar seu fencing token. */
  beforeSubmissionLeaseRenew?: (point: Readonly<{
    notificationId: number;
    sourceRevision: number;
  }>) => Promise<void>;
}>;

function submissionLeaseMs(options?: PushDeliveryExecutionOptions): number {
  if (
    process.env.NODE_ENV === "test" &&
    Number.isFinite(options?.submissionLeaseMs) &&
    (options?.submissionLeaseMs ?? 0) > 0
  ) {
    return Math.floor(options!.submissionLeaseMs!);
  }
  return SUBMISSION_LEASE_MS;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const record = asRecord(value);
  if (record) {
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function inferLegacyPurpose(
  payloadData: PayloadData,
  recipientKind: DutyConfirmationRecipientAuthority,
): DutyConfirmationPushPurpose | null {
  const matches = DUTY_CONFIRMATION_PURPOSES.filter((purpose) => {
    const policy = DUTY_CONFIRMATION_PURPOSE_POLICY[purpose];
    return policy.payloadType === payloadData.type && policy.recipientKind === recipientKind;
  });
  return matches.length === 1 ? matches[0] : null;
}

function isDutyConfirmationPayload(payloadData: PayloadData): boolean {
  return DUTY_CONFIRMATION_PURPOSES.some(
    (purpose) => DUTY_CONFIRMATION_PURPOSE_POLICY[purpose].payloadType === payloadData.type,
  );
}

function parseShiftSnapshot(value: unknown): DutyShiftSnapshot | null {
  const snapshot = asRecord(value);
  if (
    !snapshot ||
    !Number.isInteger(snapshot.institutionId) ||
    !Number.isInteger(snapshot.hospitalId) ||
    !Number.isInteger(snapshot.sectorId) ||
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

function authorityMatchesPurpose(
  authority: DutyConfirmationPushAuthority,
  payloadData: PayloadData,
  requirePayloadConfirmationId: boolean,
): boolean {
  const policy = DUTY_CONFIRMATION_PURPOSE_POLICY[authority.purpose];
  const payloadConfirmationId = payloadData.confirmationId;
  return (
    policy.payloadType === payloadData.type &&
    policy.recipientKind === authority.recipientKind &&
    authority.allowedStatuses.every((status) => policy.allowedStatuses.includes(status)) &&
    new Set(authority.allowedStatuses).size === authority.allowedStatuses.length &&
    (!requirePayloadConfirmationId || payloadConfirmationId === authority.confirmationId) &&
    (payloadConfirmationId === undefined || payloadConfirmationId === authority.confirmationId)
  );
}

function parseAuthority(
  value: unknown,
  payloadData: PayloadData,
): DutyConfirmationPushAuthority | undefined | null {
  if (value === undefined) return undefined;
  const authority = asRecord(value);
  if (
    authority?.kind !== "DUTY_CONFIRMATION" ||
    !Number.isInteger(authority.confirmationId) ||
    (authority.confirmationId as number) <= 0 ||
    !Array.isArray(authority.allowedStatuses) ||
    authority.allowedStatuses.length === 0 ||
    !authority.allowedStatuses.every(
      (status) =>
        typeof status === "string" &&
        DUTY_CONFIRMATION_STATUSES.includes(status as DutyConfirmationStatus),
    ) ||
    typeof authority.recipientKind !== "string" ||
    !DUTY_CONFIRMATION_RECIPIENTS.includes(
      authority.recipientKind as DutyConfirmationRecipientAuthority,
    ) ||
    !Number.isInteger(authority.expectedUserId) ||
    (authority.expectedUserId as number) <= 0 ||
    !parseShiftSnapshot(authority.shiftSnapshot)
  ) {
    return null;
  }
  const recipientKind = authority.recipientKind as DutyConfirmationRecipientAuthority;
  const purpose =
    typeof authority.purpose === "string" &&
    DUTY_CONFIRMATION_PURPOSES.includes(authority.purpose as DutyConfirmationPushPurpose)
      ? authority.purpose as DutyConfirmationPushPurpose
      : inferLegacyPurpose(payloadData, recipientKind);
  if (!purpose) return null;
  const normalized = { ...authority, purpose } as DutyConfirmationPushAuthority;
  return authorityMatchesPurpose(normalized, payloadData, false) ? normalized : null;
}

function isCanonicalIsoDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function isExpoReceiptTarget(value: unknown): value is ExpoReceiptTarget {
  const target = asRecord(value);
  return !!target &&
    typeof target.ticketId === "string" &&
    !!target.ticketId.trim() &&
    Number.isSafeInteger(target.pushTokenId) &&
    (target.pushTokenId as number) > 0 &&
    Number.isSafeInteger(target.expectedUserId) &&
    (target.expectedUserId as number) > 0 &&
    typeof target.tokenFingerprint === "string" &&
    /^[a-f0-9]{64}$/.test(target.tokenFingerprint);
}

function parseAccountWideBadgeVersion(
  state: Record<string, unknown>,
): typeof ACCOUNT_WIDE_BADGE_VERSION | null | undefined {
  if (!Object.prototype.hasOwnProperty.call(state, "accountWideBadgeVersion")) {
    // Outboxes anteriores continuam processáveis; o selector do badge exige o
    // marker e, portanto, permanece fail-closed para essas rows legadas.
    return undefined;
  }
  return state.accountWideBadgeVersion === ACCOUNT_WIDE_BADGE_VERSION
    ? ACCOUNT_WIDE_BADGE_VERSION
    : null;
}

function receiptTargetsMatchNotification(
  tickets: readonly ExpoReceiptTarget[],
  expectedUserId: number,
): boolean {
  const ticketIds = new Set<string>();
  const pushTokenIds = new Set<number>();
  for (const ticket of tickets) {
    if (
      ticket.expectedUserId !== expectedUserId ||
      ticketIds.has(ticket.ticketId) ||
      pushTokenIds.has(ticket.pushTokenId)
    ) {
      return false;
    }
    ticketIds.add(ticket.ticketId);
    pushTokenIds.add(ticket.pushTokenId);
  }
  return true;
}

function parsePendingState(value: unknown, expectedUserId: number): PendingTrackingState | null {
  const row = asRecord(value);
  const payloadData = asRecord(row?.payloadData);
  const authority = parseAuthority(row?.authority, payloadData ?? {});
  const accountWideBadgeVersion = row
    ? parseAccountWideBadgeVersion(row)
    : null;
  if (
    row?.trackingVersion !== TRACKING_VERSION ||
    !Number.isInteger(row.revision) ||
    (row.revision as number) < 0 ||
    !Number.isInteger(row.attemptCount) ||
    (row.attemptCount as number) < 0 ||
    !payloadData ||
    accountWideBadgeVersion === null ||
    authority === null
  ) {
    return null;
  }
  if (isDutyConfirmationPayload(payloadData) && !authority) return null;
  const normalized = {
    ...row,
    ...(accountWideBadgeVersion === undefined
      ? {}
      : { accountWideBadgeVersion }),
    ...(authority ? { authority } : {}),
  };
  if (row.phase === "QUEUED" && isCanonicalIsoDate(row.availableAt)) {
    return normalized as QueuedState;
  }
  if (row.phase === "SUBMITTING" && isCanonicalIsoDate(row.leaseUntil)) {
    return normalized as SubmittingState;
  }
  if (
    (row.phase === "TICKET_ACCEPTED" || row.phase === "RECEIPT_CHECKING") &&
    isCanonicalIsoDate(row.submittedAt) &&
    isCanonicalIsoDate(row.receiptDueAt) &&
    Number.isInteger(row.receiptAttempts) &&
    (row.receiptAttempts as number) >= 0 &&
    Array.isArray(row.tickets) &&
    row.tickets.length > 0 &&
    row.tickets.every(isExpoReceiptTarget) &&
    receiptTargetsMatchNotification(row.tickets as ExpoReceiptTarget[], expectedUserId) &&
    (row.phase !== "RECEIPT_CHECKING" || isCanonicalIsoDate(row.leaseUntil))
  ) {
    return normalized as TicketAcceptedState | ReceiptCheckingState;
  }
  return null;
}

function phaseOf(value: unknown): TrackedPushResult["phase"] {
  const phase = asRecord(value)?.phase;
  return phase === "QUEUED" ||
    phase === "SUBMITTING" ||
    phase === "TICKET_ACCEPTED" ||
    phase === "RECEIPT_CHECKING" ||
    phase === "PROVIDER_ACCEPTED" ||
    phase === "FAILED"
    ? phase
    : "UNKNOWN";
}

function isDuplicateEntry(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  if ("code" in error && (error as { code?: unknown }).code === "ER_DUP_ENTRY") return true;
  return "cause" in error && isDuplicateEntry((error as { cause?: unknown }).cause);
}

function revisionPredicate(state: PendingTrackingState) {
  return and(
    sql`JSON_UNQUOTE(JSON_EXTRACT(${notifications.providerReceipt}, '$.phase')) = ${state.phase}`,
    sql`CAST(JSON_UNQUOTE(JSON_EXTRACT(${notifications.providerReceipt}, '$.revision')) AS UNSIGNED) = ${state.revision}`,
  );
}

function retryDelayMs(attemptCount: number): number {
  return attemptCount <= 1 ? 60_000 : 5 * 60_000;
}

function isSubmissionRetryable(result: PushSendResult): boolean {
  if (
    result.status === "SERVICE_ERROR" ||
    result.status === "NO_REGISTERED_TOKENS"
  ) return true;
  return result.tickets.some(
    (ticket) => ticket.state === "TICKET_REJECTED" && ticket.retryability === "RETRYABLE",
  );
}

function isManagerEscalation(
  state: Pick<TrackingBase, "authority">,
): boolean {
  return state.authority?.purpose === "MANAGER_ESCALATION";
}

function shouldSyncAccountWideNativeBadge(
  state: Pick<TrackingBase, "accountWideBadgeVersion" | "payloadData">,
): boolean {
  return (
    state.accountWideBadgeVersion === ACCOUNT_WIDE_BADGE_VERSION &&
    isAccountWideBadgeNotificationType(state.payloadData.type)
  );
}

/**
 * A sincronização de ícone nunca altera o resultado da entrega principal.
 * O envelope próprio contém apenas badge/collapseId e o contador é derivado
 * sob o mutex da conta imediatamente antes de cada POST iOS.
 */
function syncAccountWideNativeBadgeSnapshot(
  row: NotificationRow,
  state: Pick<TrackingBase, "accountWideBadgeVersion" | "payloadData">,
): void {
  if (!shouldSyncAccountWideNativeBadge(state)) return;
  dispatchAccountWideNativeBadgeSnapshot(row.userId, row.institutionId);
}

async function loadNotification(db: Pick<Db, "select">, id: number): Promise<NotificationRow | null> {
  const [row] = await db
    .select()
    .from(notifications)
    .where(eq(notifications.id, id))
    .limit(1);
  return row ?? null;
}

function hasOwnRecipientUserId(payloadData: PayloadData): boolean {
  return Object.prototype.hasOwnProperty.call(payloadData, "recipientUserId");
}

function assertSameTrackedIntent(
  row: NotificationRow,
  input: TrackedPushInput,
  allowRecipientOverride: boolean,
): void {
  const storedState = asRecord(row.providerReceipt);
  const storedPayload = asRecord(storedState?.payloadData);
  const suppliedPayload = input.payload.data ?? {};
  const authoritativePayload = withAuthoritativePushRecipient(
    suppliedPayload,
    input.userId,
  );
  const sameIdentity =
    row.institutionId === input.institutionId &&
    row.userId === input.userId &&
    row.shiftInstanceId === (input.shiftInstanceId ?? null) &&
    row.title === input.payload.title &&
    (row.body ?? "") === input.payload.body &&
    (row.deepLink ?? null) === (input.deepLink ?? null) &&
    canonicalJson(storedState?.authority ?? null) === canonicalJson(input.authority ?? null);
  const storedMatchesCanonical =
    storedPayload !== null &&
    canonicalJson(storedPayload) === canonicalJson(authoritativePayload);
  // A única compatibilidade retroativa aceita uma row sem o campo e uma nova
  // intenção também sem ele. A submissão ao Expo a sela sob mutex/ownership;
  // qualquer payload que já declare um destinatário diferente continua sendo
  // uma colisão de dedupKey, não uma oportunidade de sobrescrita.
  const storedMatchesExactLegacy =
    storedPayload !== null &&
    !hasOwnRecipientUserId(storedPayload) &&
    !hasOwnRecipientUserId(suppliedPayload) &&
    canonicalJson(storedPayload) === canonicalJson(suppliedPayload);
  const suppliedRecipientIsCompatible =
    allowRecipientOverride ||
    !hasOwnRecipientUserId(suppliedPayload) ||
    suppliedPayload.recipientUserId === input.userId;
  if (
    !sameIdentity ||
    !suppliedRecipientIsCompatible ||
    (!storedMatchesCanonical && !storedMatchesExactLegacy)
  ) {
    throw new Error(
      `Colisão de dedupKey em notificação rastreada: ${input.dedupKey}`,
    );
  }
}

async function failRevokedAuthority(
  db: Db,
  row: NotificationRow,
  state: QueuedState | SubmittingState,
  now: Date,
): Promise<void> {
  const failed: TerminalTrackingState = {
    ...state,
    revision: state.revision + 1,
    phase: "FAILED",
    terminalAt: now.toISOString(),
    evidence: {
      reason: "RECIPIENT_AUTHORITY_REVOKED",
      message: PUSH_AUTHORITY_REVOKED_MESSAGE,
    },
  };
  await db
    .update(notifications)
    .set({
      status: "FAILED",
      providerReceipt: failed,
      errorMessage: PUSH_AUTHORITY_REVOKED_MESSAGE,
    })
    .where(
      and(
        eq(notifications.id, row.id),
        eq(notifications.status, "PENDING"),
        revisionPredicate(state),
      ),
    );
}

async function requireCurrentPushAuthority(
  db: Pick<Db, "select">,
  row: NotificationRow,
  state: Pick<TrackingBase, "authority" | "payloadData">,
  lockForUpdate = false,
): Promise<void> {
  if (!state.authority) return;
  if (
    row.userId !== state.authority.expectedUserId ||
    !authorityMatchesPurpose(state.authority, state.payloadData, false)
  ) {
    throw new PersistedDutyConfirmationBindingError(
      "Purpose ou destinatário do outbox não corresponde à autoridade persistida",
    );
  }
  const valid = await requireAuthorizedDutyConfirmationRecipient(db, {
    confirmationId: state.authority.confirmationId,
    allowedStatuses: state.authority.allowedStatuses,
    recipientKind: state.authority.recipientKind,
    expectedUserId: state.authority.expectedUserId,
    shiftSnapshot: state.authority.shiftSnapshot,
    allowInactiveOriginalAssignment:
      state.authority.purpose === "SSO_READY" ||
      state.authority.purpose === "REPLACEMENT_ACCEPTED_NOTICE",
    lockForUpdate,
  });
  if (
    row.institutionId !== valid.shift.institutionId ||
    row.shiftInstanceId !== valid.shift.id
  ) {
    throw new PersistedDutyConfirmationBindingError(
      "Tenant ou plantão do outbox não corresponde à confirmação canônica",
    );
  }
}

async function claimSubmission(
  db: Db,
  row: NotificationRow,
  state: QueuedState | SubmittingState,
  now: Date,
  options?: PushDeliveryExecutionOptions,
): Promise<SubmittingState | null> {
  const claimed: SubmittingState = {
    trackingVersion: TRACKING_VERSION,
    revision: state.revision + 1,
    payloadData: state.payloadData,
    attemptCount: state.attemptCount + 1,
    ...(state.accountWideBadgeVersion
      ? { accountWideBadgeVersion: state.accountWideBadgeVersion }
      : {}),
    ...(state.authority ? { authority: state.authority } : {}),
    phase: "SUBMITTING",
    leaseUntil: new Date(now.getTime() + submissionLeaseMs(options)).toISOString(),
  };
  if (process.env.NODE_ENV === "test") {
    await options?.beforeSubmissionClaim?.({
      notificationId: row.id,
      sourceRevision: state.revision,
    });
  }
  const [result] = await db
    .update(notifications)
    .set({ providerReceipt: claimed })
    .where(
      and(
        eq(notifications.id, row.id),
        eq(notifications.status, "PENDING"),
        revisionPredicate(state),
      ),
    );
  return result.affectedRows === 1 ? claimed : null;
}

async function renewSubmissionLease(
  db: Db,
  row: NotificationRow,
  claimed: SubmittingState,
  operationNow: Date,
  options?: PushDeliveryExecutionOptions,
): Promise<boolean> {
  if (process.env.NODE_ENV === "test") {
    await options?.beforeSubmissionLeaseRenew?.({
      notificationId: row.id,
      sourceRevision: claimed.revision,
    });
  }
  const horizonMs = Math.max(
    submissionLeaseMs(options),
    PUSH_SUBMISSION_LEASE_HORIZON_MS,
  );
  const leaseUntil = new Date(
    Math.max(Date.now(), operationNow.getTime()) + horizonMs,
  ).toISOString();
  // A renovação também avança a revisão. Só estender leaseUntil permitiria
  // que um worker que leu o claim expirado antes desta escrita ainda vencesse
  // depois com o mesmo predicate phase+revision e roubasse a submissão.
  const renewed: SubmittingState = {
    ...claimed,
    revision: claimed.revision + 1,
    leaseUntil,
  };
  const [result] = await db
    .update(notifications)
    .set({ providerReceipt: renewed })
    .where(
      and(
        eq(notifications.id, row.id),
        eq(notifications.status, "PENDING"),
        revisionPredicate(claimed),
      ),
    );
  if (result.affectedRows !== 1) return false;
  claimed.revision = renewed.revision;
  claimed.leaseUntil = leaseUntil;
  return true;
}

async function requeueSubmissionAfterInfrastructureFailure(
  db: Db,
  row: NotificationRow,
  claimed: SubmittingState,
  now: Date,
): Promise<void> {
  const queued: QueuedState = {
    trackingVersion: TRACKING_VERSION,
    revision: claimed.revision + 1,
    payloadData: claimed.payloadData,
    attemptCount: claimed.attemptCount,
    ...(claimed.accountWideBadgeVersion
      ? { accountWideBadgeVersion: claimed.accountWideBadgeVersion }
      : {}),
    ...(claimed.authority ? { authority: claimed.authority } : {}),
    phase: "QUEUED",
    availableAt: new Date(now.getTime() + retryDelayMs(claimed.attemptCount)).toISOString(),
    lastError: PUSH_AUTHORITY_RETRY_MESSAGE,
  };
  await db
    .update(notifications)
    .set({ providerReceipt: queued, errorMessage: PUSH_AUTHORITY_RETRY_MESSAGE })
    .where(
      and(
        eq(notifications.id, row.id),
        eq(notifications.status, "PENDING"),
        revisionPredicate(claimed),
      ),
    );
}

async function processSubmission(
  db: Db,
  row: NotificationRow,
  state: QueuedState | SubmittingState,
  now: Date,
  options?: PushDeliveryExecutionOptions,
): Promise<void> {
  const claimed = await claimSubmission(db, row, state, now, options);
  if (!claimed) return;

  try {
    // Revalida em toda tentativa, inclusive recuperacao de lease. Um push
    // antigo nunca herda a autoridade que existia quando foi enfileirado.
    await requireCurrentPushAuthority(db, row, claimed);
  } catch (error) {
    if (isCanonicalDutyConfirmationRejection(error)) {
      await failRevokedAuthority(db, row, claimed, now);
      return;
    }
    // Se o CAS falhar junto com a infraestrutura, o lease continua sendo o
    // fallback recuperável. Nenhuma falha genérica vira revogação.
    await requeueSubmissionAfterInfrastructureFailure(db, row, claimed, now);
    console.error(`[PushDelivery] AUTHORITY_PREFLIGHT_RETRY notification=${row.id}`);
    return;
  }

  let submissionClaimLost = false;
  const submission = await sendPushNotification(
    row.userId,
    {
      title: row.title,
      body: row.body ?? "",
      data: claimed.payloadData,
    },
    row.institutionId,
    claimed.authority
      ? async (tx) => requireCurrentPushAuthority(tx, row, claimed, true)
      : undefined,
    async () => {
      try {
        const renewed = await renewSubmissionLease(db, row, claimed, now, options);
        if (!renewed) submissionClaimLost = true;
        return renewed;
      } catch {
        submissionClaimLost = true;
        console.error(`[PushDelivery] SUBMISSION_LEASE_RENEW_FAILED notification=${row.id}`);
        return false;
      }
    },
  );
  if (submissionClaimLost) return;
  const acceptedTickets = submission.tickets
    .filter((ticket) => ticket.state === "TICKET_ACCEPTED")
    .map((ticket) => ({
      ticketId: ticket.ticketId,
      pushTokenId: ticket.pushTokenId,
      expectedUserId: ticket.expectedUserId,
      tokenFingerprint: ticket.tokenFingerprint,
    }));

  if (acceptedTickets.length > 0) {
    const next: TicketAcceptedState = {
      ...claimed,
      revision: claimed.revision + 1,
      phase: "TICKET_ACCEPTED",
      submittedAt: now.toISOString(),
      receiptDueAt: new Date(now.getTime() + RECEIPT_DUE_MS).toISOString(),
      receiptAttempts: 0,
      tickets: acceptedTickets,
      submission,
    };
    const [persisted] = await db
      .update(notifications)
      .set({ providerReceipt: next, errorMessage: null })
      .where(
        and(
          eq(notifications.id, row.id),
          eq(notifications.status, "PENDING"),
          revisionPredicate(claimed),
        ),
      );
    if (persisted.affectedRows === 1) {
      syncAccountWideNativeBadgeSnapshot(row, next);
    }
    if (persisted.affectedRows === 1 && claimed.authority?.purpose === "CONFIRMATION_REQUEST") {
      await db
        .update(dutyConfirmations)
        .set({ notifiedAt: now })
        .where(
          and(
            eq(dutyConfirmations.id, claimed.authority.confirmationId),
            inArray(dutyConfirmations.status, claimed.authority.allowedStatuses),
            isNull(dutyConfirmations.notifiedAt),
          ),
        );
    }
    if (
      persisted.affectedRows === 1 &&
      claimed.authority?.purpose === "SSO_READY"
    ) {
      // O worker também fecha a evidência de recovery. Se a tentativa
      // imediata caiu e o retry posterior obteve ticket, o timestamp não
      // pode permanecer falsamente nulo.
      await db
        .update(dutyConfirmations)
        .set({ ssoTriggeredAt: now })
        .where(
          and(
            eq(dutyConfirmations.id, claimed.authority.confirmationId),
            inArray(dutyConfirmations.status, claimed.authority.allowedStatuses),
            isNull(dutyConfirmations.ssoTriggeredAt),
          ),
        );
      const shiftStartDedupKey =
        `duty-confirmation:${claimed.authority.confirmationId}:shift-start:${claimed.authority.expectedUserId}`;
      if (row.dedupKey === shiftStartDedupKey) {
        // O disparo imediato pode ter devolvido o claim para NULL e o worker
        // obtido o ticket depois da janela de cinco minutos. O outbox impede
        // duplicata; este campo precisa refletir a recuperação real.
        await db
          .update(dutyConfirmations)
          .set({ startPushSentAt: now })
          .where(
            and(
              eq(dutyConfirmations.id, claimed.authority.confirmationId),
              inArray(dutyConfirmations.status, claimed.authority.allowedStatuses),
              isNull(dutyConfirmations.startPushSentAt),
            ),
          );
      }
    }
    return;
  }

  const retryable = isSubmissionRetryable(submission);
  if (
    (retryable && claimed.attemptCount < MAX_SUBMISSION_ATTEMPTS) ||
    submission.status === "SERVICE_ERROR" ||
    isManagerEscalation(claimed)
  ) {
    const queued: QueuedState = {
      trackingVersion: TRACKING_VERSION,
      revision: claimed.revision + 1,
      payloadData: claimed.payloadData,
      attemptCount: claimed.attemptCount,
      ...(claimed.accountWideBadgeVersion
        ? { accountWideBadgeVersion: claimed.accountWideBadgeVersion }
        : {}),
      ...(claimed.authority ? { authority: claimed.authority } : {}),
      phase: "QUEUED",
      availableAt: new Date(now.getTime() + retryDelayMs(claimed.attemptCount)).toISOString(),
      lastError: submission.message,
    };
    await db
      .update(notifications)
      .set({ providerReceipt: queued, errorMessage: submission.message })
      .where(
        and(
          eq(notifications.id, row.id),
          eq(notifications.status, "PENDING"),
          revisionPredicate(claimed),
        ),
      );
    return;
  }

  const failed: TerminalTrackingState = {
    trackingVersion: TRACKING_VERSION,
    revision: claimed.revision + 1,
    payloadData: claimed.payloadData,
    attemptCount: claimed.attemptCount,
    ...(claimed.accountWideBadgeVersion
      ? { accountWideBadgeVersion: claimed.accountWideBadgeVersion }
      : {}),
    phase: "FAILED",
    terminalAt: now.toISOString(),
    evidence: submission,
  };
  const [persisted] = await db
    .update(notifications)
    .set({
      status: "FAILED",
      providerReceipt: failed,
      errorMessage: submission.message,
    })
    .where(
      and(
        eq(notifications.id, row.id),
        eq(notifications.status, "PENDING"),
        revisionPredicate(claimed),
      ),
    );
  if (persisted.affectedRows === 1) {
    syncAccountWideNativeBadgeSnapshot(row, failed);
  }
}

async function claimReceiptCheck(
  db: Db,
  row: NotificationRow,
  state: TicketAcceptedState | ReceiptCheckingState,
  now: Date,
): Promise<ReceiptCheckingState | null> {
  const claimed: ReceiptCheckingState = {
    ...state,
    revision: state.revision + 1,
    phase: "RECEIPT_CHECKING",
    leaseUntil: new Date(now.getTime() + SUBMISSION_LEASE_MS).toISOString(),
  };
  const [result] = await db
    .update(notifications)
    .set({ providerReceipt: claimed })
    .where(
      and(
        eq(notifications.id, row.id),
        eq(notifications.status, "PENDING"),
        revisionPredicate(state),
      ),
    );
  return result.affectedRows === 1 ? claimed : null;
}

async function processReceiptCheck(
  db: Db,
  row: NotificationRow,
  state: TicketAcceptedState | ReceiptCheckingState,
  now: Date,
): Promise<void> {
  const claimed = await claimReceiptCheck(db, row, state, now);
  if (!claimed) return;

  const receipts = await getExpoPushReceipts(claimed.tickets);
  if (receipts.some((receipt) => receipt.state === "PROVIDER_ACCEPTED")) {
    const accepted: TerminalTrackingState = {
      trackingVersion: TRACKING_VERSION,
      revision: claimed.revision + 1,
      payloadData: claimed.payloadData,
      attemptCount: claimed.attemptCount,
      ...(claimed.accountWideBadgeVersion
        ? { accountWideBadgeVersion: claimed.accountWideBadgeVersion }
        : {}),
      phase: "PROVIDER_ACCEPTED",
      terminalAt: now.toISOString(),
      evidence: receipts,
    };
    await db.transaction(async (tx) => {
      const [persisted] = await tx
        .update(notifications)
        .set({
          status: "SENT",
          providerReceipt: accepted,
          sentAt: now,
          errorMessage: null,
        })
        .where(
          and(
            eq(notifications.id, row.id),
            eq(notifications.status, "PENDING"),
            revisionPredicate(claimed),
          ),
        );
      if (
        persisted.affectedRows === 1 &&
        claimed.authority?.purpose === "MANAGER_ESCALATION"
      ) {
        try {
          // O receipt prova somente que o provedor aceitou o ticket histórico.
          // Ele não pode consumir o handoff se o gestor perdeu a autoridade
          // entre a submissão e esta confirmação atrasada.
          await requireCurrentPushAuthority(tx, row, claimed, true);
        } catch (error) {
          if (!isCanonicalDutyConfirmationRejection(error)) throw error;
          return;
        }
        await tx
          .update(dutyConfirmations)
          .set({ managerNotified: true, recheckAt: null })
          .where(
            and(
              eq(dutyConfirmations.id, claimed.authority.confirmationId),
              inArray(dutyConfirmations.status, claimed.authority.allowedStatuses),
              eq(dutyConfirmations.managerNotified, false),
            ),
          );
      }
    });
    return;
  }

  const receiptAttempts = claimed.receiptAttempts + 1;
  const terminalEvidence = receipts.every(
    (receipt) =>
      receipt.state === "RECEIPT_REJECTED" && receipt.retryability === "TERMINAL",
  );
  if (
    isManagerEscalation(claimed) &&
    (terminalEvidence || receiptAttempts >= MAX_RECEIPT_ATTEMPTS)
  ) {
    const queued: QueuedState = {
      trackingVersion: TRACKING_VERSION,
      revision: claimed.revision + 1,
      payloadData: claimed.payloadData,
      attemptCount: claimed.attemptCount,
      ...(claimed.accountWideBadgeVersion
        ? { accountWideBadgeVersion: claimed.accountWideBadgeVersion }
        : {}),
      ...(claimed.authority ? { authority: claimed.authority } : {}),
      phase: "QUEUED",
      availableAt: new Date(
        now.getTime() + retryDelayMs(Math.max(claimed.attemptCount, receiptAttempts)),
      ).toISOString(),
      lastError: terminalEvidence
        ? "Receipt gerencial rejeitado; nova submissão agendada"
        : "Receipt gerencial permaneceu desconhecido; nova submissão agendada",
    };
    const [persisted] = await db
      .update(notifications)
      .set({ providerReceipt: queued, errorMessage: queued.lastError })
      .where(
        and(
          eq(notifications.id, row.id),
          eq(notifications.status, "PENDING"),
          revisionPredicate(claimed),
        ),
      );
    // A row acabava de participar do snapshot enquanto TICKET_ACCEPTED ou
    // RECEIPT_CHECKING. A reentrada gerencial em QUEUED a remove do selector,
    // portanto o ícone remoto precisa receber a fotografia corrigida.
    if (persisted.affectedRows === 1) {
      syncAccountWideNativeBadgeSnapshot(row, queued);
    }
    return;
  }
  if (!terminalEvidence && receiptAttempts < MAX_RECEIPT_ATTEMPTS) {
    const { leaseUntil: _leaseUntil, ...withoutLease } = claimed;
    const pending: TicketAcceptedState = {
      ...withoutLease,
      revision: claimed.revision + 1,
      phase: "TICKET_ACCEPTED",
      receiptAttempts,
      receiptDueAt: new Date(now.getTime() + RECEIPT_RETRY_MS).toISOString(),
    };
    await db
      .update(notifications)
      .set({ providerReceipt: pending, errorMessage: "Receipt do provedor ainda não confirmado" })
      .where(
        and(
          eq(notifications.id, row.id),
          eq(notifications.status, "PENDING"),
          revisionPredicate(claimed),
        ),
      );
    return;
  }

  const failed: TerminalTrackingState = {
    trackingVersion: TRACKING_VERSION,
    revision: claimed.revision + 1,
    payloadData: claimed.payloadData,
    attemptCount: claimed.attemptCount,
    ...(claimed.accountWideBadgeVersion
      ? { accountWideBadgeVersion: claimed.accountWideBadgeVersion }
      : {}),
    phase: "FAILED",
    terminalAt: now.toISOString(),
    evidence: receipts,
  };
  const [persisted] = await db
    .update(notifications)
    .set({
      status: "FAILED",
      providerReceipt: failed,
      errorMessage: terminalEvidence
        ? "Todos os receipts foram rejeitados pelo provedor"
        : "Receipt do provedor permaneceu desconhecido após as tentativas",
    })
    .where(
      and(
        eq(notifications.id, row.id),
        eq(notifications.status, "PENDING"),
        revisionPredicate(claimed),
      ),
    );
  if (persisted.affectedRows === 1) {
    syncAccountWideNativeBadgeSnapshot(row, failed);
  }
}

async function processTrackedRow(
  db: Db,
  row: NotificationRow,
  now: Date,
  options?: PushDeliveryExecutionOptions,
): Promise<void> {
  if (row.status !== "PENDING") return;
  const state = parsePendingState(row.providerReceipt, row.userId);
  if (!state) {
    await db
      .update(notifications)
      .set({
        status: "FAILED",
        providerReceipt: {
          trackingVersion: TRACKING_VERSION,
          phase: "FAILED",
          terminalAt: now.toISOString(),
          evidence: {
            reason: "MALFORMED_TRACKING_STATE",
            previous: row.providerReceipt,
          },
        },
        errorMessage: "Estado persistido do outbox de push e invalido",
      })
      .where(and(eq(notifications.id, row.id), eq(notifications.status, "PENDING")));
    return;
  }

  if (state.phase === "QUEUED") {
    if (new Date(state.availableAt) <= now) {
      await processSubmission(db, row, state, now, options);
    }
    return;
  }
  if (state.phase === "SUBMITTING") {
    if (new Date(state.leaseUntil) <= now) {
      await processSubmission(db, row, state, now, options);
    }
    return;
  }
  if (state.phase === "TICKET_ACCEPTED") {
    if (new Date(state.receiptDueAt) <= now) await processReceiptCheck(db, row, state, now);
    return;
  }
  if (new Date(state.leaseUntil) <= now) {
    await processReceiptCheck(db, row, state, now);
  }
}

async function trackedResult(
  db: Pick<Db, "select">,
  notificationId: number,
): Promise<TrackedPushResult> {
  const row = await loadNotification(db, notificationId);
  if (!row) throw new Error(`Notificação rastreada ${notificationId} não encontrada`);
  const phase = phaseOf(row.providerReceipt);
  return {
    notificationId,
    status: row.status,
    phase,
    ticketAccepted:
      phase === "TICKET_ACCEPTED" ||
      phase === "RECEIPT_CHECKING" ||
      phase === "PROVIDER_ACCEPTED",
    providerAccepted: phase === "PROVIDER_ACCEPTED",
  };
}

async function persistTrackedPushIntent(
  db: EnqueueDb,
  input: TrackedPushInput,
  now: Date,
): Promise<number> {
  const payloadData = withAuthoritativePushRecipient(
    input.payload.data,
    input.userId,
  );
  if (isDutyConfirmationPayload(payloadData) && !input.authority) {
    throw new Error("Push de confirmacao rastreado exige autoridade canonica");
  }
  if (input.authority) {
    const payloadInstitutionId = payloadData.institutionId;
    if (
      input.userId !== input.authority.expectedUserId ||
      !authorityMatchesPurpose(input.authority, payloadData, true) ||
      payloadInstitutionId !== input.institutionId ||
      payloadInstitutionId !== input.authority.shiftSnapshot.institutionId
    ) {
      throw new Error(
        "Purpose, confirmationId, tenant ou destinatario invalido no push rastreado",
      );
    }
    if (input.shiftInstanceId == null) {
      throw new Error("Push de confirmacao rastreado exige shiftInstanceId");
    }
  }
  const initial: QueuedState = {
    trackingVersion: TRACKING_VERSION,
    revision: 1,
    payloadData,
    attemptCount: 0,
    accountWideBadgeVersion: ACCOUNT_WIDE_BADGE_VERSION,
    ...(input.authority ? { authority: input.authority } : {}),
    phase: "QUEUED",
    availableAt: now.toISOString(),
  };
  let notificationId: number;
  let insertedNew = false;
  try {
    const [inserted] = await db
      .insert(notifications)
      .values({
        institutionId: input.institutionId,
        userId: input.userId,
        title: input.payload.title,
        body: input.payload.body,
        type: "GENERAL",
        status: "PENDING",
        shiftInstanceId: input.shiftInstanceId ?? null,
        dedupKey: input.dedupKey,
        deepLink: input.deepLink ?? null,
        providerReceipt: initial,
      })
      .$returningId();
    notificationId = inserted.id;
    insertedNew = true;
  } catch (error) {
    if (!isDuplicateEntry(error)) throw error;
    const [existing] = await db
      .select({ id: notifications.id })
      .from(notifications)
      .where(eq(notifications.dedupKey, input.dedupKey))
      .limit(1);
    if (!existing) throw error;
    notificationId = existing.id;
  }

  const row = await loadNotification(db, notificationId);
  if (!row) throw new Error(`Notificação rastreada ${notificationId} não encontrada`);
  assertSameTrackedIntent(row, input, insertedNew);
  if (
    row.status === "FAILED" &&
    input.authority?.purpose === "MANAGER_ESCALATION"
  ) {
    // Revogação temporária do gestor ou exaustão de uma versão anterior não
    // pode apagar o handoff. A mesma intenção exata volta ao worker; qualquer
    // mudança de destinatário/tenant/plantão falha antes, no binding acima.
    await db
      .update(notifications)
      .set({
        status: "PENDING",
        providerReceipt: initial,
        errorMessage: null,
        sentAt: null,
      })
      .where(and(eq(notifications.id, notificationId), eq(notifications.status, "FAILED")));
  }
  return notificationId;
}

/**
 * Persiste a intencao sem tocar na rede. Pode participar da mesma transacao
 * que conquistou um CAS de negocio; assim crash entre estado e outbox nao
 * apaga o efeito externo pendente.
 */
export async function enqueueTrackedPushNotification(
  input: TrackedPushInput,
  now = new Date(),
  dbOverride?: EnqueueDb,
): Promise<TrackedPushResult> {
  const db = dbOverride ?? await getDb();
  if (!db) throw new Error("Database not available");
  const notificationId = await persistTrackedPushIntent(db, input, now);
  return trackedResult(db, notificationId);
}

/**
 * Persiste a intenção antes de tocar no Expo. A chave única torna chamadas
 * repetidas idempotentes; leases e revisão JSON evitam dois workers enviando
 * a mesma intenção ao mesmo tempo sem exigir mudança de schema.
 */
export async function sendTrackedPushNotification(
  input: TrackedPushInput,
  now = new Date(),
  options?: PushDeliveryExecutionOptions,
): Promise<TrackedPushResult> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const notificationId = await persistTrackedPushIntent(db, input, now);
  const row = await loadNotification(db, notificationId);
  if (!row) throw new Error(`Notificação rastreada ${notificationId} não encontrada`);
  await processTrackedRow(db, row, now, options);
  return trackedResult(db, notificationId);
}

/** Processa retries e receipts pendentes em lote limitado e idempotente. */
export async function processPendingPushDeliveries(
  now = new Date(),
  options?: PushDeliveryExecutionOptions,
): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const rows = await db
    .select()
    .from(notifications)
    .where(
      and(
        eq(notifications.status, "PENDING"),
        // Não dependa do próprio campo que pode estar corrompido para descobrir
        // uma row corrompida. duty-sync possui namespace próprio e é excluído;
        // os demais marcadores pertencem exclusivamente ao outbox de push.
        sql`(
          JSON_EXTRACT(${notifications.providerReceipt}, '$.dutySyncVersion') IS NULL
          AND ${notifications.title} <> 'Duty roster sync'
          AND JSON_EXTRACT(${notifications.providerReceipt}, '$.comunicaPlusOutboxVersion') IS NULL
          AND ${notifications.title} <> 'Comunica+ structured notice'
          AND (
            JSON_EXTRACT(${notifications.providerReceipt}, '$.trackingVersion') IS NOT NULL
            OR JSON_EXTRACT(${notifications.providerReceipt}, '$.payloadData') IS NOT NULL
            OR JSON_EXTRACT(${notifications.providerReceipt}, '$.authority') IS NOT NULL
            OR ${notifications.dedupKey} LIKE 'duty-confirmation:%'
            OR JSON_UNQUOTE(JSON_EXTRACT(${notifications.providerReceipt}, '$.phase'))
              IN ('QUEUED', 'SUBMITTING', 'TICKET_ACCEPTED', 'RECEIPT_CHECKING')
          )
        )`,
        sql`(
          CAST(JSON_UNQUOTE(JSON_EXTRACT(${notifications.providerReceipt}, '$.trackingVersion')) AS UNSIGNED) <> ${TRACKING_VERSION}
          OR JSON_UNQUOTE(JSON_EXTRACT(${notifications.providerReceipt}, '$.phase')) IS NULL
          OR JSON_UNQUOTE(JSON_EXTRACT(${notifications.providerReceipt}, '$.phase')) NOT IN ('QUEUED', 'SUBMITTING', 'TICKET_ACCEPTED', 'RECEIPT_CHECKING')
          OR JSON_EXTRACT(${notifications.providerReceipt}, '$.revision') IS NULL
          OR JSON_EXTRACT(${notifications.providerReceipt}, '$.attemptCount') IS NULL
          OR JSON_EXTRACT(${notifications.providerReceipt}, '$.payloadData') IS NULL
          OR (JSON_UNQUOTE(JSON_EXTRACT(${notifications.providerReceipt}, '$.phase')) = 'QUEUED'
            AND JSON_EXTRACT(${notifications.providerReceipt}, '$.availableAt') IS NULL)
          OR (JSON_UNQUOTE(JSON_EXTRACT(${notifications.providerReceipt}, '$.phase')) = 'SUBMITTING'
            AND JSON_EXTRACT(${notifications.providerReceipt}, '$.leaseUntil') IS NULL)
          OR (JSON_UNQUOTE(JSON_EXTRACT(${notifications.providerReceipt}, '$.phase')) IN ('TICKET_ACCEPTED', 'RECEIPT_CHECKING')
            AND (JSON_EXTRACT(${notifications.providerReceipt}, '$.receiptDueAt') IS NULL
              OR JSON_EXTRACT(${notifications.providerReceipt}, '$.tickets') IS NULL))
          OR (JSON_UNQUOTE(JSON_EXTRACT(${notifications.providerReceipt}, '$.phase')) = 'RECEIPT_CHECKING'
            AND JSON_EXTRACT(${notifications.providerReceipt}, '$.leaseUntil') IS NULL)
          OR (JSON_UNQUOTE(JSON_EXTRACT(${notifications.providerReceipt}, '$.phase')) = 'QUEUED'
            AND JSON_UNQUOTE(JSON_EXTRACT(${notifications.providerReceipt}, '$.availableAt')) <= ${now.toISOString()})
          OR (JSON_UNQUOTE(JSON_EXTRACT(${notifications.providerReceipt}, '$.phase')) = 'SUBMITTING'
            AND JSON_UNQUOTE(JSON_EXTRACT(${notifications.providerReceipt}, '$.leaseUntil')) <= ${now.toISOString()})
          OR (JSON_UNQUOTE(JSON_EXTRACT(${notifications.providerReceipt}, '$.phase')) = 'TICKET_ACCEPTED'
            AND JSON_UNQUOTE(JSON_EXTRACT(${notifications.providerReceipt}, '$.receiptDueAt')) <= ${now.toISOString()})
          OR (JSON_UNQUOTE(JSON_EXTRACT(${notifications.providerReceipt}, '$.phase')) = 'RECEIPT_CHECKING'
            AND JSON_UNQUOTE(JSON_EXTRACT(${notifications.providerReceipt}, '$.leaseUntil')) <= ${now.toISOString()})
        )`,
      ),
    )
    .orderBy(notifications.id)
    .limit(DELIVERY_BATCH_SIZE);
  let processed = 0;
  let cursor = 0;
  await Promise.all(
    Array.from(
      { length: Math.min(DELIVERY_CONCURRENCY, rows.length) },
      async () => {
        while (cursor < rows.length) {
          const row = rows[cursor++];
          if (!row) return;
          const before = JSON.stringify(row.providerReceipt);
          try {
            await processTrackedRow(db, row, now, options);
            const after = await loadNotification(db, row.id);
            if (after && JSON.stringify(after.providerReceipt) !== before) processed += 1;
          } catch {
            // Uma row defeituosa não pode bloquear as demais entregas do lote;
            // o lease/CAS mantém a row recuperável no próximo tick.
            console.error(`[PushDelivery] ROW_PROCESSING_FAILED notification=${row.id}`);
          }
        }
      },
    ),
  );
  return processed;
}

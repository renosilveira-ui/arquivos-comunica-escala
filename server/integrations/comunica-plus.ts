import { createHash } from "node:crypto";
import {
  and,
  asc,
  eq,
  gte,
  isNull,
  lt,
  or,
  sql,
} from "drizzle-orm";
import {
  monthlyRosters,
  notifications,
  hospitals,
  institutions,
  professionalAccess,
  professionalInstitutions,
  professionals,
  sectors,
  shiftAssignmentsV2,
  shiftInstances,
  swapRequests,
  users,
} from "../../drizzle/schema";
import { isLocalHostname } from "../_core/public-url";
import { getDb } from "../db";
import { getComunicaOrgId } from "../sso/org-mapping";

const OUTBOX_VERSION = 1 as const;
export const COMUNICA_PLUS_OUTBOX_TITLE = "Comunica+ structured notice";
const OUTBOX_BATCH_SIZE = 24;
const OUTBOX_CONCURRENCY = 4;
const OUTBOX_LEASE_MS = 120_000;
const OUTBOX_MAX_RETRY_MS = 30 * 60_000;
const COMUNICA_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 128 * 1024;
const POSITIVE_CACHE_TTL_MS = 5_000;
const NEGATIVE_CACHE_TTL_MS = 15_000;
const MAX_USER_CACHE_ENTRIES = 2_000;
const SESSION_TTL_MS = 15 * 60_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;
type EnqueueDb = Pick<Db, "insert" | "select">;
type OutboxDb = Pick<Db, "select" | "update">;

type ComunicaTemplateCode = "ROSTER_PUBLISHED" | "SHIFT_SWAP_APPROVED";
type Retryability = "RETRYABLE" | "TERMINAL";

type RosterPublishedEvent = {
  kind: "ROSTER_PUBLISHED";
  rosterId: number;
  hospitalId: number;
  yearMonth: string;
  publishedVersion: number;
};

type SwapApprovedEvent = {
  kind: "SHIFT_SWAP_APPROVED";
  swapId: number;
  swapVersion: number;
  shiftInstanceId: number;
  recipientRole: "FROM" | "TO";
};

type ComunicaEvent = RosterPublishedEvent | SwapApprovedEvent;

type MutableOutboxState = {
  comunicaPlusOutboxVersion: typeof OUTBOX_VERSION;
  phase: "QUEUED" | "PROCESSING";
  revision: number;
  templateCode: ComunicaTemplateCode;
  targetUserId: number;
  targetEmailHash: string | null;
  organizationId: string | null;
  externalUserId: string | null;
  event: ComunicaEvent;
  attemptCount: number;
  availableAt: string;
  leaseUntil?: string;
  lastErrorCode?: string;
};

type TerminalOutboxState = Omit<MutableOutboxState, "phase" | "leaseUntil"> & {
  phase: "SENT" | "FAILED" | "SUPPRESSED";
  terminalAt: string;
  evidence: Record<string, unknown>;
};

type OutboxState = MutableOutboxState | TerminalOutboxState;

type TrustedConfig = {
  baseUrl: string;
  systemEmail: string;
  systemPassword: string;
  systemPin: string;
};

type ExternalSession = {
  cookie: string;
  organizationId: string;
  configKey: string;
  expiresAt: number;
};

type ExternalUserResolution =
  | { state: "RESOLVED"; userId: string }
  | { state: "NOT_FOUND" };

type UserCacheEntry =
  | { state: "RESOLVED"; userId: string; expiresAt: number }
  | { state: "NOT_FOUND"; expiresAt: number };

class ComunicaPlusError extends Error {
  readonly code: string;
  readonly retryability: Retryability;
  readonly httpStatus?: number;

  constructor(
    code: string,
    retryability: Retryability,
    options: { httpStatus?: number; cause?: unknown } = {},
  ) {
    super(code, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ComunicaPlusError";
    this.code = code;
    this.retryability = retryability;
    this.httpStatus = options.httpStatus;
  }
}

let externalSession: ExternalSession | null = null;
let externalSessionPromise: Promise<ExternalSession> | null = null;
const externalUserCache = new Map<string, UserCacheEntry>();
const externalUserPromises = new Map<string, Promise<ExternalUserResolution>>();

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function canonicalIso(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function emailDigest(email: string): string {
  return createHash("sha256").update(normalizeEmail(email)).digest("hex");
}

function validOrganizationId(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function eventTemplate(event: ComunicaEvent): ComunicaTemplateCode {
  return event.kind;
}

function buildDedupKey(event: ComunicaEvent, targetUserId: number): string {
  if (event.kind === "ROSTER_PUBLISHED") {
    return `comunica:v1:roster:${event.rosterId}:v${event.publishedVersion}:u${targetUserId}`;
  }
  return `comunica:v1:swap:${event.swapId}:v${event.swapVersion}:${event.recipientRole.toLowerCase()}:u${targetUserId}`;
}

function parseEvent(value: unknown): ComunicaEvent | null {
  const event = asRecord(value);
  if (!event || typeof event.kind !== "string") return null;
  if (event.kind === "ROSTER_PUBLISHED") {
    if (
      !positiveInteger(event.rosterId) ||
      !positiveInteger(event.hospitalId) ||
      typeof event.yearMonth !== "string" ||
      !/^\d{4}-(0[1-9]|1[0-2])$/.test(event.yearMonth) ||
      !positiveInteger(event.publishedVersion)
    ) return null;
    return {
      kind: event.kind,
      rosterId: event.rosterId,
      hospitalId: event.hospitalId,
      yearMonth: event.yearMonth,
      publishedVersion: event.publishedVersion,
    };
  }
  if (
    event.kind === "SHIFT_SWAP_APPROVED" &&
    positiveInteger(event.swapId) &&
    positiveInteger(event.swapVersion) &&
    positiveInteger(event.shiftInstanceId) &&
    (event.recipientRole === "FROM" || event.recipientRole === "TO")
  ) {
    return {
      kind: event.kind,
      swapId: event.swapId,
      swapVersion: event.swapVersion,
      shiftInstanceId: event.shiftInstanceId,
      recipientRole: event.recipientRole,
    };
  }
  return null;
}

function parseOutboxState(value: unknown): OutboxState | null {
  const state = asRecord(value);
  if (
    !state ||
    state.comunicaPlusOutboxVersion !== OUTBOX_VERSION ||
    !["QUEUED", "PROCESSING", "SENT", "FAILED", "SUPPRESSED"].includes(String(state.phase)) ||
    !positiveInteger(state.revision) ||
    (state.templateCode !== "ROSTER_PUBLISHED" && state.templateCode !== "SHIFT_SWAP_APPROVED") ||
    !positiveInteger(state.targetUserId) ||
    !(
      state.targetEmailHash === null ||
      (typeof state.targetEmailHash === "string" && SHA256_PATTERN.test(state.targetEmailHash))
    ) ||
    !(state.organizationId === null || validOrganizationId(state.organizationId)) ||
    !(state.externalUserId === null || validOrganizationId(state.externalUserId)) ||
    !Number.isSafeInteger(state.attemptCount) ||
    (state.attemptCount as number) < 0 ||
    !canonicalIso(state.availableAt)
  ) return null;

  const event = parseEvent(state.event);
  if (!event || eventTemplate(event) !== state.templateCode) return null;
  if (state.phase === "PROCESSING" && !canonicalIso(state.leaseUntil)) return null;
  if (
    (state.phase === "SENT" || state.phase === "FAILED" || state.phase === "SUPPRESSED") &&
    (!canonicalIso(state.terminalAt) || !asRecord(state.evidence))
  ) return null;
  if (state.phase === "QUEUED" || state.phase === "PROCESSING") {
    return {
      comunicaPlusOutboxVersion: OUTBOX_VERSION,
      phase: state.phase,
      revision: state.revision as number,
      templateCode: state.templateCode,
      targetUserId: state.targetUserId as number,
      targetEmailHash: state.targetEmailHash as string | null,
      organizationId: state.organizationId as string | null,
      externalUserId: state.externalUserId as string | null,
      event,
      attemptCount: state.attemptCount as number,
      availableAt: state.availableAt as string,
      ...(state.phase === "PROCESSING" ? { leaseUntil: state.leaseUntil as string } : {}),
      ...(typeof state.lastErrorCode === "string" ? { lastErrorCode: state.lastErrorCode.slice(0, 80) } : {}),
    };
  }
  return {
    comunicaPlusOutboxVersion: OUTBOX_VERSION,
    phase: state.phase as TerminalOutboxState["phase"],
    revision: state.revision as number,
    templateCode: state.templateCode,
    targetUserId: state.targetUserId as number,
    targetEmailHash: state.targetEmailHash as string | null,
    organizationId: state.organizationId as string | null,
    externalUserId: state.externalUserId as string | null,
    event,
    attemptCount: state.attemptCount as number,
    availableAt: state.availableAt as string,
    terminalAt: state.terminalAt as string,
    evidence: asRecord(state.evidence)!,
    ...(typeof state.lastErrorCode === "string" ? { lastErrorCode: state.lastErrorCode.slice(0, 80) } : {}),
  };
}

function stateIdentityMatches(
  state: OutboxState,
  input: {
    targetUserId: number;
    targetEmailHash: string | null;
    organizationId: string | null;
    event: ComunicaEvent;
  },
): boolean {
  return state.targetUserId === input.targetUserId &&
    state.targetEmailHash === input.targetEmailHash &&
    state.organizationId === input.organizationId &&
    state.templateCode === eventTemplate(input.event) &&
    JSON.stringify(state.event) === JSON.stringify(input.event);
}

function isDuplicateEntry(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  if ("code" in error && (error as { code?: unknown }).code === "ER_DUP_ENTRY") return true;
  return "cause" in error && isDuplicateEntry((error as { cause?: unknown }).cause);
}

async function enqueueIntent(
  input: {
    institutionId: number;
    targetUserId: number;
    targetEmail: string | null;
    shiftInstanceId?: number;
    event: ComunicaEvent;
  },
  now: Date,
  db: EnqueueDb,
): Promise<number> {
  const organizationId = getComunicaOrgId(input.institutionId);
  const targetEmailHash = input.targetEmail?.trim()
    ? emailDigest(input.targetEmail)
    : null;
  const dedupKey = buildDedupKey(input.event, input.targetUserId);
  const initial: MutableOutboxState = {
    comunicaPlusOutboxVersion: OUTBOX_VERSION,
    phase: "QUEUED",
    revision: 1,
    templateCode: eventTemplate(input.event),
    targetUserId: input.targetUserId,
    targetEmailHash,
    organizationId,
    externalUserId: null,
    event: input.event,
    attemptCount: 0,
    availableAt: now.toISOString(),
  };

  try {
    const [inserted] = await db
      .insert(notifications)
      .values({
        institutionId: input.institutionId,
        userId: input.targetUserId,
        title: COMUNICA_PLUS_OUTBOX_TITLE,
        body: initial.templateCode,
        type: "GENERAL",
        status: "PENDING",
        shiftInstanceId: input.shiftInstanceId,
        dedupKey,
        providerReceipt: initial,
      })
      .$returningId();
    return inserted.id;
  } catch (error) {
    if (!isDuplicateEntry(error)) throw error;
    const [existing] = await db
      .select({
        id: notifications.id,
        institutionId: notifications.institutionId,
        userId: notifications.userId,
        shiftInstanceId: notifications.shiftInstanceId,
        title: notifications.title,
        body: notifications.body,
        dedupKey: notifications.dedupKey,
        providerReceipt: notifications.providerReceipt,
      })
      .from(notifications)
      .where(eq(notifications.dedupKey, dedupKey))
      .limit(1);
    const state = existing ? parseOutboxState(existing.providerReceipt) : null;
    if (
      !existing ||
      !state ||
      existing.institutionId !== input.institutionId ||
      existing.userId !== input.targetUserId ||
      existing.shiftInstanceId !== (input.shiftInstanceId ?? null) ||
      existing.title !== COMUNICA_PLUS_OUTBOX_TITLE ||
      existing.body !== initial.templateCode ||
      existing.dedupKey !== dedupKey ||
      !stateIdentityMatches(state, {
        targetUserId: input.targetUserId,
        targetEmailHash,
        organizationId,
        event: input.event,
      })
    ) {
      throw new Error(`Colisão de dedupKey no outbox Comunica+: ${dedupKey}`);
    }
    return existing.id;
  }
}

export async function enqueueComunicaRosterPublished(input: {
  rosterId: number;
  institutionId: number;
  hospitalId: number;
  yearMonth: string;
  publishedVersion: number;
  targetUserId: number;
  targetEmail: string | null;
  now?: Date;
  db?: EnqueueDb;
}): Promise<number> {
  const db = input.db ?? await getDb();
  if (!db) throw new Error("Database unavailable");
  return enqueueIntent({
    institutionId: input.institutionId,
    targetUserId: input.targetUserId,
    targetEmail: input.targetEmail,
    event: {
      kind: "ROSTER_PUBLISHED",
      rosterId: input.rosterId,
      hospitalId: input.hospitalId,
      yearMonth: input.yearMonth,
      publishedVersion: input.publishedVersion,
    },
  }, input.now ?? new Date(), db);
}

export async function enqueueComunicaSwapApproved(input: {
  swapId: number;
  swapVersion: number;
  institutionId: number;
  shiftInstanceId: number;
  recipientRole: "FROM" | "TO";
  targetUserId: number;
  targetEmail: string | null;
  now?: Date;
  db?: EnqueueDb;
}): Promise<number> {
  const db = input.db ?? await getDb();
  if (!db) throw new Error("Database unavailable");
  return enqueueIntent({
    institutionId: input.institutionId,
    targetUserId: input.targetUserId,
    targetEmail: input.targetEmail,
    shiftInstanceId: input.shiftInstanceId,
    event: {
      kind: "SHIFT_SWAP_APPROVED",
      swapId: input.swapId,
      swapVersion: input.swapVersion,
      shiftInstanceId: input.shiftInstanceId,
      recipientRole: input.recipientRole,
    },
  }, input.now ?? new Date(), db);
}

function retryDelayMs(attemptCount: number): number {
  const exponent = Math.min(Math.max(attemptCount - 1, 0), 5);
  return Math.min(60_000 * 2 ** exponent, OUTBOX_MAX_RETRY_MS);
}

function revisionPredicate(state: MutableOutboxState) {
  return and(
    sql`JSON_UNQUOTE(JSON_EXTRACT(${notifications.providerReceipt}, '$.phase')) = ${state.phase}`,
    sql`CAST(JSON_UNQUOTE(JSON_EXTRACT(${notifications.providerReceipt}, '$.revision')) AS UNSIGNED) = ${state.revision}`,
  );
}

async function claimRow(
  db: OutboxDb,
  row: typeof notifications.$inferSelect,
  state: MutableOutboxState,
  now: Date,
): Promise<MutableOutboxState | null> {
  if (state.phase === "QUEUED" && new Date(state.availableAt) > now) return null;
  if (state.phase === "PROCESSING" && new Date(state.leaseUntil!) > now) return null;
  const claimed: MutableOutboxState = {
    ...state,
    phase: "PROCESSING",
    revision: state.revision + 1,
    attemptCount: state.attemptCount + 1,
    leaseUntil: new Date(now.getTime() + OUTBOX_LEASE_MS).toISOString(),
  };
  const [updated] = await db
    .update(notifications)
    .set({ providerReceipt: claimed, errorMessage: null })
    .where(
      and(
        eq(notifications.id, row.id),
        eq(notifications.status, "PENDING"),
        revisionPredicate(state),
      ),
    );
  return updated.affectedRows === 1 ? claimed : null;
}

async function bindProcessingState(
  db: OutboxDb,
  notificationId: number,
  state: MutableOutboxState,
  bindings: Partial<Pick<MutableOutboxState, "targetEmailHash" | "organizationId" | "externalUserId">>,
): Promise<MutableOutboxState | null> {
  const bound: MutableOutboxState = {
    ...state,
    ...bindings,
    revision: state.revision + 1,
  };
  const [updated] = await db
    .update(notifications)
    .set({ providerReceipt: bound })
    .where(
      and(
        eq(notifications.id, notificationId),
        eq(notifications.status, "PENDING"),
        revisionPredicate(state),
      ),
    );
  return updated.affectedRows === 1 ? bound : null;
}

async function markTerminal(
  db: OutboxDb,
  notificationId: number,
  state: MutableOutboxState,
  phase: "SENT" | "FAILED" | "SUPPRESSED",
  now: Date,
  evidence: Record<string, unknown>,
): Promise<void> {
  const {
    leaseUntil: _leaseUntil,
    phase: _phase,
    ...terminalBase
  } = state;
  const terminal: TerminalOutboxState = {
    ...terminalBase,
    phase,
    revision: state.revision + 1,
    terminalAt: now.toISOString(),
    evidence,
  };
  await db
    .update(notifications)
    .set({
      status: phase === "SENT" ? "SENT" : "FAILED",
      providerReceipt: terminal,
      errorMessage: phase === "SENT" ? null : String(evidence.code ?? phase).slice(0, 255),
      sentAt: phase === "SENT" ? now : null,
    })
    .where(
      and(
        eq(notifications.id, notificationId),
        eq(notifications.status, "PENDING"),
        revisionPredicate(state),
      ),
    );
}

async function retryOrFail(
  db: OutboxDb,
  notificationId: number,
  state: MutableOutboxState,
  now: Date,
  error: ComunicaPlusError,
): Promise<void> {
  if (error.retryability === "TERMINAL") {
    await markTerminal(db, notificationId, state, "FAILED", now, {
      code: error.code,
      retryability: error.retryability,
      ...(error.httpStatus === undefined ? {} : { httpStatus: error.httpStatus }),
    });
    return;
  }
  const queued: MutableOutboxState = {
    ...state,
    phase: "QUEUED",
    revision: state.revision + 1,
    availableAt: new Date(now.getTime() + retryDelayMs(state.attemptCount)).toISOString(),
    lastErrorCode: error.code,
  };
  delete queued.leaseUntil;
  await db
    .update(notifications)
    .set({ providerReceipt: queued, errorMessage: error.code.slice(0, 255) })
    .where(
      and(
        eq(notifications.id, notificationId),
        eq(notifications.status, "PENDING"),
        revisionPredicate(state),
      ),
    );
}

function monthBounds(yearMonth: string): { start: Date; end: Date } {
  const [yearText, monthText] = yearMonth.split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  return {
    start: new Date(`${yearMonth}-01T00:00:00-03:00`),
    end: new Date(`${nextYear}-${String(nextMonth).padStart(2, "0")}-01T00:00:00-03:00`),
  };
}

async function loadActiveRecipient(
  db: Pick<Db, "select">,
  institutionId: number,
  userId: number,
): Promise<{ professionalId: number; email: string | null } | null> {
  const [recipient] = await db
    .select({ professionalId: professionals.id, email: users.email })
    .from(professionalInstitutions)
    .innerJoin(
      institutions,
      and(
        eq(institutions.id, professionalInstitutions.institutionId),
        eq(institutions.isActive, true),
      ),
    )
    .innerJoin(
      professionals,
      and(
        eq(professionals.id, professionalInstitutions.professionalId),
        eq(professionals.userId, professionalInstitutions.userId),
      ),
    )
    .innerJoin(
      users,
      and(
        eq(users.id, professionalInstitutions.userId),
        eq(users.approvalStatus, "APPROVED"),
        isNull(users.deletedAt),
      ),
    )
    .where(
      and(
        eq(professionalInstitutions.institutionId, institutionId),
        eq(professionalInstitutions.userId, userId),
        eq(professionalInstitutions.active, true),
      ),
    )
    .limit(1);
  return recipient ?? null;
}

async function loadAccessibleShift(
  db: Pick<Db, "select">,
  input: {
    institutionId: number;
    shiftInstanceId: number;
    professionalId: number;
  },
): Promise<{ hospitalId: number; sectorId: number } | null> {
  const [shift] = await db
    .select({
      hospitalId: shiftInstances.hospitalId,
      sectorId: shiftInstances.sectorId,
    })
    .from(shiftInstances)
    .innerJoin(
      hospitals,
      and(
        eq(hospitals.id, shiftInstances.hospitalId),
        eq(hospitals.institutionId, shiftInstances.institutionId),
      ),
    )
    .innerJoin(
      sectors,
      and(
        eq(sectors.id, shiftInstances.sectorId),
        eq(sectors.institutionId, shiftInstances.institutionId),
        eq(sectors.hospitalId, shiftInstances.hospitalId),
      ),
    )
    .innerJoin(
      professionalAccess,
      and(
        eq(professionalAccess.institutionId, shiftInstances.institutionId),
        eq(professionalAccess.professionalId, input.professionalId),
        eq(professionalAccess.hospitalId, shiftInstances.hospitalId),
        eq(professionalAccess.canAccess, true),
        or(
          isNull(professionalAccess.sectorId),
          eq(professionalAccess.sectorId, shiftInstances.sectorId),
        ),
      ),
    )
    .where(
      and(
        eq(shiftInstances.id, input.shiftInstanceId),
        eq(shiftInstances.institutionId, input.institutionId),
      ),
    )
    .limit(1);
  return shift ?? null;
}

type AuthorityResult =
  | { state: "AUTHORIZED"; email: string }
  | { state: "RETRY_LATER"; code: string }
  | { state: "SUPPRESSED"; code: string };

async function revalidateAuthority(
  db: Pick<Db, "select">,
  row: typeof notifications.$inferSelect,
  state: MutableOutboxState,
): Promise<AuthorityResult> {
  if (
    row.institutionId <= 0 ||
    row.userId !== state.targetUserId ||
    row.title !== COMUNICA_PLUS_OUTBOX_TITLE ||
    row.body !== state.templateCode ||
    row.dedupKey !== buildDedupKey(state.event, state.targetUserId)
  ) return { state: "SUPPRESSED", code: "OUTBOX_IDENTITY_MISMATCH" };
  if (
    state.event.kind === "SHIFT_SWAP_APPROVED" &&
    row.shiftInstanceId !== state.event.shiftInstanceId
  ) return { state: "SUPPRESSED", code: "OUTBOX_SHIFT_MISMATCH" };

  const recipient = await loadActiveRecipient(db, row.institutionId, state.targetUserId);
  if (!recipient) return { state: "SUPPRESSED", code: "RECIPIENT_AUTHORITY_REVOKED" };
  const email = recipient.email?.trim() ?? "";
  if (!email) return { state: "RETRY_LATER", code: "RECIPIENT_WITHOUT_EMAIL" };
  if (state.targetEmailHash && emailDigest(email) !== state.targetEmailHash) {
    return { state: "SUPPRESSED", code: "RECIPIENT_EMAIL_CHANGED" };
  }

  if (state.event.kind === "ROSTER_PUBLISHED") {
    const [roster] = await db
      .select({ status: monthlyRosters.status, version: monthlyRosters.version })
      .from(monthlyRosters)
      .where(
        and(
          eq(monthlyRosters.id, state.event.rosterId),
          eq(monthlyRosters.institutionId, row.institutionId),
          eq(monthlyRosters.hospitalId, state.event.hospitalId),
          eq(monthlyRosters.yearMonth, state.event.yearMonth),
        ),
      )
      .limit(1);
    const rosterStillOfficial = roster?.status === "PUBLISHED"
      ? roster.version === state.event.publishedVersion
      : roster?.status === "LOCKED" && roster.version === state.event.publishedVersion + 1;
    if (!rosterStillOfficial) {
      return { state: "SUPPRESSED", code: "ROSTER_AUTHORITY_CHANGED" };
    }
    const { start, end } = monthBounds(state.event.yearMonth);
    const [assignment] = await db
      .select({ id: shiftAssignmentsV2.id })
      .from(shiftAssignmentsV2)
      .innerJoin(
        shiftInstances,
        and(
          eq(shiftInstances.id, shiftAssignmentsV2.shiftInstanceId),
          eq(shiftInstances.institutionId, shiftAssignmentsV2.institutionId),
          eq(shiftInstances.hospitalId, shiftAssignmentsV2.hospitalId),
          eq(shiftInstances.sectorId, shiftAssignmentsV2.sectorId),
        ),
      )
      .innerJoin(
        hospitals,
        and(
          eq(hospitals.id, shiftInstances.hospitalId),
          eq(hospitals.institutionId, shiftInstances.institutionId),
        ),
      )
      .innerJoin(
        sectors,
        and(
          eq(sectors.id, shiftInstances.sectorId),
          eq(sectors.institutionId, shiftInstances.institutionId),
          eq(sectors.hospitalId, shiftInstances.hospitalId),
        ),
      )
      .innerJoin(
        professionalAccess,
        and(
          eq(professionalAccess.institutionId, shiftInstances.institutionId),
          eq(professionalAccess.professionalId, recipient.professionalId),
          eq(professionalAccess.hospitalId, shiftInstances.hospitalId),
          eq(professionalAccess.canAccess, true),
          or(
            isNull(professionalAccess.sectorId),
            eq(professionalAccess.sectorId, shiftInstances.sectorId),
          ),
        ),
      )
      .where(
        and(
          eq(shiftAssignmentsV2.institutionId, row.institutionId),
          eq(shiftAssignmentsV2.hospitalId, state.event.hospitalId),
          eq(shiftAssignmentsV2.professionalId, recipient.professionalId),
          eq(shiftAssignmentsV2.status, "OCUPADO"),
          eq(shiftAssignmentsV2.isActive, true),
          gte(shiftInstances.startAt, start),
          lt(shiftInstances.startAt, end),
        ),
      )
      .limit(1);
    if (!assignment) return { state: "SUPPRESSED", code: "ROSTER_RECIPIENT_CHANGED" };
  } else {
    const accessibleShift = await loadAccessibleShift(db, {
      institutionId: row.institutionId,
      shiftInstanceId: state.event.shiftInstanceId,
      professionalId: recipient.professionalId,
    });
    if (!accessibleShift) {
      return { state: "SUPPRESSED", code: "RECIPIENT_SHIFT_ACCESS_REVOKED" };
    }
    const [swap] = await db
      .select({
        status: swapRequests.status,
        version: swapRequests.version,
        fromUserId: swapRequests.fromUserId,
        toUserId: swapRequests.toUserId,
        fromShiftInstanceId: swapRequests.fromShiftInstanceId,
        hospitalId: swapRequests.hospitalId,
        sectorId: swapRequests.sectorId,
      })
      .from(swapRequests)
      .where(
        and(
          eq(swapRequests.id, state.event.swapId),
          eq(swapRequests.institutionId, row.institutionId),
        ),
      )
      .limit(1);
    const expectedUserId = state.event.recipientRole === "FROM"
      ? swap?.fromUserId
      : swap?.toUserId;
    if (
      !swap ||
      swap.status !== "APPROVED" ||
      swap.version !== state.event.swapVersion ||
      swap.fromShiftInstanceId !== state.event.shiftInstanceId ||
      swap.hospitalId !== accessibleShift.hospitalId ||
      (swap.sectorId !== null && swap.sectorId !== accessibleShift.sectorId) ||
      expectedUserId !== state.targetUserId
    ) return { state: "SUPPRESSED", code: "SWAP_AUTHORITY_CHANGED" };
  }
  return { state: "AUTHORIZED", email };
}

export function resolveTrustedComunicaPlusBaseUrl(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | null {
  const configured = (env.COMUNICA_PLUS_URL ?? "").trim();
  if (!configured) return env.NODE_ENV === "development" || env.NODE_ENV === "test"
    ? "http://localhost:3001"
    : null;
  try {
    const url = new URL(configured);
    const production = env.NODE_ENV === "production";
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      (production && url.protocol !== "https:") ||
      !url.hostname ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (production && isLocalHostname(url.hostname))
    ) return null;
    if (production) {
      const trustedRaw = (env.SSO_TARGET_URL ?? "").trim();
      if (!trustedRaw) return null;
      const trusted = new URL(trustedRaw);
      if (
        trusted.protocol !== "https:" ||
        isLocalHostname(trusted.hostname) ||
        trusted.username ||
        trusted.password ||
        trusted.search ||
        trusted.hash ||
        trusted.origin !== url.origin
      ) return null;
    }
    const path = url.pathname.replace(/\/+$/, "");
    return `${url.origin}${path}`;
  } catch {
    return null;
  }
}

function getConfig(): TrustedConfig {
  if (process.env.COMUNICA_PLUS_OUTBOUND_ENABLED !== "1") {
    throw new ComunicaPlusError("COMUNICA_OUTBOUND_DISABLED", "RETRYABLE");
  }
  const baseUrl = resolveTrustedComunicaPlusBaseUrl();
  if (!baseUrl) throw new ComunicaPlusError("UNTRUSTED_COMUNICA_URL", "RETRYABLE");
  const devOrTest = process.env.NODE_ENV === "development" || process.env.NODE_ENV === "test";
  const systemEmail = normalizeEmail(
    process.env.COMUNICA_PLUS_SYSTEM_EMAIL ?? (devOrTest ? "system.escalas@hospital.com" : ""),
  );
  const systemPassword = (
    process.env.COMUNICA_PLUS_SYSTEM_PASSWORD ?? (devOrTest ? "system123" : "")
  ).trim();
  const systemPin = (
    process.env.COMUNICA_PLUS_SYSTEM_PIN ?? (devOrTest ? "9999" : "")
  ).trim();
  if (!systemEmail || !systemEmail.includes("@") || !systemPassword || !/^\d{4,6}$/.test(systemPin)) {
    throw new ComunicaPlusError("INVALID_COMUNICA_CREDENTIAL_CONFIG", "RETRYABLE");
  }
  return { baseUrl, systemEmail, systemPassword, systemPin };
}

function safeJsonData(value: unknown): unknown {
  const record = asRecord(value);
  const result = asRecord(record?.result);
  const data = result?.data ?? record?.data;
  const json = asRecord(data)?.json;
  return json ?? data;
}

async function readJsonResponse(response: Response): Promise<unknown> {
  const declaredLength = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw new ComunicaPlusError("COMUNICA_RESPONSE_TOO_LARGE", "RETRYABLE");
  }
  const text = await response.text();
  if (text.length > MAX_RESPONSE_BYTES) {
    throw new ComunicaPlusError("COMUNICA_RESPONSE_TOO_LARGE", "RETRYABLE");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new ComunicaPlusError("MALFORMED_COMUNICA_RESPONSE", "RETRYABLE", { cause: error });
  }
}

function retryabilityForHttp(status: number): Retryability {
  return status === 408 || status === 425 || status === 429 || status >= 500
    ? "RETRYABLE"
    : "TERMINAL";
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(COMUNICA_TIMEOUT_MS) });
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    throw new ComunicaPlusError(
      name === "AbortError" || name === "TimeoutError" ? "COMUNICA_TIMEOUT" : "COMUNICA_NETWORK_ERROR",
      "RETRYABLE",
      { cause: error },
    );
  }
}

function extractSessionCookie(setCookieHeader: string | null): string {
  const cookie = setCookieHeader?.match(/(?:^|,\s*)session=[^;]+/)?.[0]?.replace(/^,\s*/, "") ?? null;
  if (!cookie) throw new ComunicaPlusError("MISSING_COMUNICA_SESSION_COOKIE", "RETRYABLE");
  return cookie;
}

async function createExternalSession(config: TrustedConfig): Promise<ExternalSession> {
  const response = await fetchWithTimeout(`${config.baseUrl}/api/trpc/auth.login?batch=1`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      "0": { email: config.systemEmail, password: config.systemPassword },
    }),
  });
  if (!response.ok) {
    throw new ComunicaPlusError("COMUNICA_AUTH_REJECTED", retryabilityForHttp(response.status), {
      httpStatus: response.status,
    });
  }
  const payload = await readJsonResponse(response);
  const result = asRecord(safeJsonData(Array.isArray(payload) ? payload[0] : null));
  const organizationId = result?.organizationId;
  const authenticatedEmail = typeof result?.email === "string" ? normalizeEmail(result.email) : "";
  if (!validOrganizationId(organizationId) || authenticatedEmail !== config.systemEmail) {
    throw new ComunicaPlusError("INVALID_COMUNICA_AUTH_IDENTITY", "TERMINAL");
  }
  return {
    cookie: extractSessionCookie(response.headers.get("set-cookie")),
    organizationId: organizationId.toLowerCase(),
    configKey: createHash("sha256").update(`${config.baseUrl}\n${config.systemEmail}`).digest("hex"),
    expiresAt: Date.now() + SESSION_TTL_MS,
  };
}

async function ensureExternalSession(
  config: TrustedConfig,
  expectedOrganizationId: string,
): Promise<ExternalSession> {
  const configKey = createHash("sha256").update(`${config.baseUrl}\n${config.systemEmail}`).digest("hex");
  if (
    !externalSession ||
    externalSession.configKey !== configKey ||
    externalSession.expiresAt <= Date.now()
  ) {
    externalSession = null;
    externalSessionPromise ??= createExternalSession(config).finally(() => {
      externalSessionPromise = null;
    });
    externalSession = await externalSessionPromise;
  }
  if (externalSession.organizationId !== expectedOrganizationId.toLowerCase()) {
    throw new ComunicaPlusError("COMUNICA_ORGANIZATION_MISMATCH", "RETRYABLE");
  }
  return externalSession;
}

async function trpcRequest(
  procedure: string,
  input: Record<string, unknown>,
  method: "GET" | "POST",
  expectedOrganizationId: string,
  retried = false,
): Promise<unknown> {
  const config = getConfig();
  const session = await ensureExternalSession(config, expectedOrganizationId);
  const encoded = encodeURIComponent(JSON.stringify({ "0": input }));
  const response = await fetchWithTimeout(
    method === "GET"
      ? `${config.baseUrl}/api/trpc/${procedure}?batch=1&input=${encoded}`
      : `${config.baseUrl}/api/trpc/${procedure}?batch=1`,
    {
      method,
      headers: {
        ...(method === "POST" ? { "content-type": "application/json" } : {}),
        Cookie: session.cookie,
      },
      ...(method === "POST" ? { body: JSON.stringify({ "0": input }) } : {}),
    },
  );
  if (response.status === 401 && !retried) {
    externalSession = null;
    return trpcRequest(procedure, input, method, expectedOrganizationId, true);
  }
  if (!response.ok) {
    throw new ComunicaPlusError("COMUNICA_HTTP_ERROR", retryabilityForHttp(response.status), {
      httpStatus: response.status,
    });
  }
  const payload = await readJsonResponse(response);
  if (!Array.isArray(payload) || payload.length !== 1) {
    throw new ComunicaPlusError("MALFORMED_COMUNICA_RESPONSE", "RETRYABLE");
  }
  const item = asRecord(payload[0]);
  if (!item || item.error) {
    throw new ComunicaPlusError("COMUNICA_TRPC_ERROR", "TERMINAL");
  }
  const data = safeJsonData(item);
  if (data === undefined) {
    throw new ComunicaPlusError("MALFORMED_COMUNICA_RESPONSE", "RETRYABLE");
  }
  return data;
}

function pruneUserCache(now: number): void {
  for (const [key, entry] of externalUserCache) {
    if (entry.expiresAt <= now) externalUserCache.delete(key);
  }
  while (externalUserCache.size >= MAX_USER_CACHE_ENTRIES) {
    const oldest = externalUserCache.keys().next().value as string | undefined;
    if (!oldest) break;
    externalUserCache.delete(oldest);
  }
}

async function resolveExternalUser(
  email: string,
  organizationId: string,
): Promise<ExternalUserResolution> {
  const normalized = normalizeEmail(email);
  const key = `${organizationId}:${normalized}`;
  const now = Date.now();
  const cached = externalUserCache.get(key);
  if (cached && cached.expiresAt > now) {
    return cached.state === "RESOLVED"
      ? { state: "RESOLVED", userId: cached.userId }
      : { state: "NOT_FOUND" };
  }
  pruneUserCache(now);
  const existingPromise = externalUserPromises.get(key);
  if (existingPromise) return existingPromise;
  const resolution = (async (): Promise<ExternalUserResolution> => {
    const data = asRecord(await trpcRequest(
      "integrations.resolveUserIdByEmail",
      { email: normalized },
      "GET",
      organizationId,
    ));
    const userId = data?.userId;
    if (validOrganizationId(userId)) {
      externalUserCache.set(key, {
        state: "RESOLVED",
        userId: userId.toLowerCase(),
        expiresAt: Date.now() + POSITIVE_CACHE_TTL_MS,
      });
      return { state: "RESOLVED", userId: userId.toLowerCase() };
    }
    externalUserCache.set(key, {
      state: "NOT_FOUND",
      expiresAt: Date.now() + NEGATIVE_CACHE_TTL_MS,
    });
    return { state: "NOT_FOUND" };
  })().finally(() => {
    externalUserPromises.delete(key);
  });
  externalUserPromises.set(key, resolution);
  return resolution;
}

async function createStructuredNotice(
  state: MutableOutboxState,
  organizationId: string,
  externalUserId: string,
): Promise<{ state: "NOTICE_CREATED"; noticeId: string }> {
  const config = getConfig();
  const data = asRecord(await trpcRequest(
    "notices.createStructuredNotice",
    {
      organizationId,
      pin: config.systemPin,
      templateCode: state.templateCode,
      targetType: "USER",
      targetUserId: externalUserId,
    },
    "POST",
    organizationId,
  ));
  const noticeId = data?.id;
  if (typeof noticeId !== "string" || !noticeId.trim()) {
    throw new ComunicaPlusError("MISSING_EXTERNAL_NOTICE_ID", "RETRYABLE");
  }
  return { state: "NOTICE_CREATED", noticeId: noticeId.trim().slice(0, 191) };
}

async function processClaimedRow(
  db: Db,
  row: typeof notifications.$inferSelect,
  initialState: MutableOutboxState,
  now: Date,
): Promise<void> {
  let state = initialState;
  try {
    const authority = await revalidateAuthority(db, row, state);
    if (authority.state === "SUPPRESSED") {
      await markTerminal(db, row.id, state, "SUPPRESSED", now, { code: authority.code });
      return;
    }
    if (authority.state === "RETRY_LATER") {
      throw new ComunicaPlusError(authority.code, "RETRYABLE");
    }

    const currentOrganizationId = getComunicaOrgId(row.institutionId);
    if (!currentOrganizationId) {
      throw new ComunicaPlusError("UNMAPPED_COMUNICA_ORGANIZATION", "RETRYABLE");
    }
    if (state.organizationId && state.organizationId !== currentOrganizationId) {
      await markTerminal(db, row.id, state, "SUPPRESSED", now, {
        code: "COMUNICA_ORGANIZATION_CHANGED",
      });
      return;
    }
    const currentEmailHash = emailDigest(authority.email);
    if (state.targetEmailHash && state.targetEmailHash !== currentEmailHash) {
      await markTerminal(db, row.id, state, "SUPPRESSED", now, {
        code: "RECIPIENT_EMAIL_CHANGED",
      });
      return;
    }
    if (!state.organizationId || !state.targetEmailHash) {
      const bound = await bindProcessingState(db, row.id, state, {
        organizationId: currentOrganizationId,
        targetEmailHash: currentEmailHash,
      });
      if (!bound) return;
      state = bound;
    }

    const external = await resolveExternalUser(authority.email, currentOrganizationId);
    if (external.state === "NOT_FOUND") {
      throw new ComunicaPlusError("COMUNICA_USER_NOT_FOUND", "RETRYABLE");
    }
    if (state.externalUserId && state.externalUserId !== external.userId) {
      await markTerminal(db, row.id, state, "SUPPRESSED", now, {
        code: "COMUNICA_USER_IDENTITY_CHANGED",
      });
      return;
    }
    if (!state.externalUserId) {
      const bound = await bindProcessingState(db, row.id, state, {
        externalUserId: external.userId,
      });
      if (!bound) return;
      state = bound;
    }

    const evidence = await createStructuredNotice(
      state,
      currentOrganizationId,
      external.userId,
    );
    await markTerminal(db, row.id, state, "SENT", now, evidence);
  } catch (error) {
    const classified = error instanceof ComunicaPlusError
      ? error
      : new ComunicaPlusError("UNEXPECTED_COMUNICA_ERROR", "RETRYABLE", { cause: error });
    await retryOrFail(db, row.id, state, now, classified);
    console.warn(
      "[Comunica+] outbound deferred",
      JSON.stringify({ notificationId: row.id, code: classified.code }),
    );
  }
}

async function failMalformedRow(
  db: OutboxDb,
  row: typeof notifications.$inferSelect,
  now: Date,
): Promise<void> {
  await db
    .update(notifications)
    .set({
      status: "FAILED",
      providerReceipt: {
        comunicaPlusOutboxVersion: OUTBOX_VERSION,
        phase: "FAILED",
        terminalAt: now.toISOString(),
        evidence: { code: "MALFORMED_COMUNICA_OUTBOX_STATE" },
      },
      errorMessage: "MALFORMED_COMUNICA_OUTBOX_STATE",
    })
    .where(and(eq(notifications.id, row.id), eq(notifications.status, "PENDING")));
}

export async function processPendingComunicaPlusOutbox(now = new Date()): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const nowIso = now.toISOString();
  const rows = await db
    .select()
    .from(notifications)
    .where(
      and(
        eq(notifications.status, "PENDING"),
        eq(notifications.title, COMUNICA_PLUS_OUTBOX_TITLE),
        or(
          sql`JSON_EXTRACT(${notifications.providerReceipt}, '$.comunicaPlusOutboxVersion') IS NULL`,
          sql`CAST(JSON_UNQUOTE(JSON_EXTRACT(${notifications.providerReceipt}, '$.comunicaPlusOutboxVersion')) AS UNSIGNED) <> ${OUTBOX_VERSION}`,
          sql`JSON_EXTRACT(${notifications.providerReceipt}, '$.phase') IS NULL`,
          sql`JSON_UNQUOTE(JSON_EXTRACT(${notifications.providerReceipt}, '$.phase')) NOT IN ('QUEUED', 'PROCESSING')`,
          sql`JSON_EXTRACT(${notifications.providerReceipt}, '$.revision') IS NULL`,
          sql`(JSON_UNQUOTE(JSON_EXTRACT(${notifications.providerReceipt}, '$.phase')) = 'QUEUED' AND (JSON_EXTRACT(${notifications.providerReceipt}, '$.availableAt') IS NULL OR JSON_UNQUOTE(JSON_EXTRACT(${notifications.providerReceipt}, '$.availableAt')) <= ${nowIso}))`,
          sql`(JSON_UNQUOTE(JSON_EXTRACT(${notifications.providerReceipt}, '$.phase')) = 'PROCESSING' AND (JSON_EXTRACT(${notifications.providerReceipt}, '$.leaseUntil') IS NULL OR JSON_UNQUOTE(JSON_EXTRACT(${notifications.providerReceipt}, '$.leaseUntil')) <= ${nowIso}))`,
        ),
      ),
    )
    .orderBy(asc(notifications.createdAt), asc(notifications.id))
    .limit(OUTBOX_BATCH_SIZE);

  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(OUTBOX_CONCURRENCY, rows.length) }, async () => {
    while (cursor < rows.length) {
      const row = rows[cursor++];
      if (!row) return;
      const parsed = parseOutboxState(row.providerReceipt);
      if (!parsed || (parsed.phase !== "QUEUED" && parsed.phase !== "PROCESSING")) {
        await failMalformedRow(db, row, now);
        continue;
      }
      const claimed = await claimRow(db, row, parsed, now);
      if (!claimed) continue;
      await processClaimedRow(db, row, claimed, now);
    }
  }));
  return rows.length;
}

/** Limpa somente caches process-local; exportado para regressões determinísticas. */
export function resetComunicaPlusIntegrationStateForTests(): void {
  externalSession = null;
  externalSessionPromise = null;
  externalUserCache.clear();
  externalUserPromises.clear();
}

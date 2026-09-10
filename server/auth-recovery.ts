import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { and, eq, gt, isNull, lt, lte, ne, or, sql } from "drizzle-orm";
import {
  authRecoveryRequests,
  passwordResets,
  professionalInstitutions,
  users,
} from "../drizzle/schema";
import { getDb } from "./db";
import { resolveTrustedPublicBaseUrl } from "./_core/public-url";
import {
  MAIL_HTTP_TIMEOUT_MS,
  mailer,
  type MailResult,
  type MailMessage,
} from "./mailer";
import {
  PUSH_ACCOUNT_MUTATION_LOCK_TIMEOUT_SEC,
  withPushAccountMutex,
} from "./push-registration-revocation";
import { isSafeBcryptHash } from "./password-credential";

const PAYLOAD_VERSION = "v2";
const PAYLOAD_CONTEXT = "escala:auth-recovery-outbox:v2";
const DEVELOPMENT_ENCRYPTION_SECRET =
  "development-only-auth-recovery-secret-not-for-production";
// O lease excede com folga o timeout máximo do único transporte operacional.
// Se um processo morrer, o retry reabre o MESMO payload/token selado; nunca
// gera uma segunda credencial, e a ativação continua protegida por lease/CAS.
const DELIVERY_LEASE_MS =
  PUSH_ACCOUNT_MUTATION_LOCK_TIMEOUT_SEC * 1_000 +
  MAIL_HTTP_TIMEOUT_MS +
  40_000;
export const AUTH_RECOVERY_DELIVERY_BATCH_SIZE = 3;
export const AUTH_RECOVERY_TICK_BUDGET_MS = 45_000;
export const AUTH_RECOVERY_MAX_DELIVERY_ATTEMPTS = 5;
export const AUTH_RECOVERY_RESET_TOKEN_TTL_MS = 30 * 60 * 1000;
export const AUTH_RECOVERY_DELIVERY_WINDOW_MS = 24 * 60 * 60 * 1000;
const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000] as const;

type RecoveryPayload = { email: string; token?: string };
type AuthRecoveryKind = typeof authRecoveryRequests.$inferSelect.kind;

/** SELF_SERVICE é account-wide; somente o fluxo admin pertence a um tenant. */
export function hasValidAuthRecoveryMembershipBinding(
  kind: AuthRecoveryKind,
  targetMembershipId: number | null,
): boolean {
  return kind === "SELF_SERVICE"
    ? targetMembershipId === null
    : Number.isInteger(targetMembershipId) && (targetMembershipId ?? 0) > 0;
}

export type AuthRecoveryMailTransport = {
  sendMail(
    message: MailMessage,
    options?: { idempotencyKey?: string },
  ): Promise<MailResult>;
};
type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;
type RecoveryWriteDb = Pick<Db, "insert" | "update">;

function affectedRows(result: unknown): number {
  if (Array.isArray(result)) {
    const header = result[0] as { affectedRows?: unknown } | undefined;
    return Number(header?.affectedRows ?? 0);
  }
  return Number(
    (result as { affectedRows?: unknown } | null)?.affectedRows ?? 0,
  );
}

type AuthRecoveryEncryptionKey = { kid: string; secret: string };

function parseEncryptionKey(
  kidValue: string | undefined,
  secretValue: string | undefined,
): AuthRecoveryEncryptionKey | null {
  const kid = (kidValue ?? "").trim();
  const secret = (secretValue ?? "").trim();
  if (!kid && !secret) return null;
  if (
    !/^[a-zA-Z0-9_-]{1,32}$/.test(kid) ||
    Buffer.byteLength(secret, "utf8") < 32 ||
    Buffer.byteLength(secret, "utf8") > 1024
  ) {
    throw new Error("AUTH_RECOVERY_ENCRYPTION_CONFIG_INVALID");
  }
  return { kid, secret };
}

export function authRecoveryEncryptionKeyRing(
  env: NodeJS.ProcessEnv = process.env,
): {
  current: AuthRecoveryEncryptionKey;
  previous: AuthRecoveryEncryptionKey | null;
} {
  const configuredCurrent = parseEncryptionKey(
    env.AUTH_RECOVERY_ENCRYPTION_CURRENT_KID,
    env.AUTH_RECOVERY_ENCRYPTION_CURRENT_SECRET,
  );
  const current =
    configuredCurrent ??
    (env.NODE_ENV === "production"
      ? (() => {
          throw new Error("AUTH_RECOVERY_ENCRYPTION_CONFIG_MISSING");
        })()
      : { kid: "development-v1", secret: DEVELOPMENT_ENCRYPTION_SECRET });
  const previous = parseEncryptionKey(
    env.AUTH_RECOVERY_ENCRYPTION_PREVIOUS_KID,
    env.AUTH_RECOVERY_ENCRYPTION_PREVIOUS_SECRET,
  );
  if (!configuredCurrent && previous) {
    throw new Error("AUTH_RECOVERY_ENCRYPTION_CURRENT_KEY_REQUIRED");
  }
  if (previous?.kid === current.kid) {
    throw new Error("AUTH_RECOVERY_ENCRYPTION_KID_REUSED");
  }
  if (previous?.secret === current.secret) {
    throw new Error("AUTH_RECOVERY_ENCRYPTION_SECRET_REUSED");
  }
  const cookieSecret = (env.COOKIE_SECRET ?? "").trim();
  if (
    cookieSecret &&
    (current.secret === cookieSecret || previous?.secret === cookieSecret)
  ) {
    throw new Error("AUTH_RECOVERY_ENCRYPTION_COOKIE_SECRET_REUSED");
  }
  return { current, previous };
}

function encryptionKey(key: AuthRecoveryEncryptionKey): Buffer {
  return createHash("sha256")
    .update(PAYLOAD_CONTEXT)
    .update("\0")
    .update(key.kid)
    .update("\0")
    .update(key.secret)
    .digest();
}

/** AES-GCM: nenhuma recuperação persiste e-mail ou token em claro. */
export function sealAuthRecoveryPayload(payload: RecoveryPayload): string {
  const { current } = authRecoveryEncryptionKeyRing();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(current), iv);
  cipher.setAAD(Buffer.from(`${PAYLOAD_CONTEXT}:${current.kid}`));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    PAYLOAD_VERSION,
    current.kid,
    iv.toString("base64url"),
    ciphertext.toString("base64url"),
    tag.toString("base64url"),
  ].join(".");
}

export function openAuthRecoveryPayload(sealed: string): RecoveryPayload {
  const [version, kid, ivText, ciphertextText, tagText, extra] =
    sealed.split(".");
  if (
    version !== PAYLOAD_VERSION ||
    !kid ||
    !ivText ||
    !ciphertextText ||
    !tagText ||
    extra !== undefined
  ) {
    throw new Error("AUTH_RECOVERY_PAYLOAD_INVALID");
  }
  const iv = Buffer.from(ivText, "base64url");
  const ciphertext = Buffer.from(ciphertextText, "base64url");
  const tag = Buffer.from(tagText, "base64url");
  if (iv.length !== 12 || tag.length !== 16 || ciphertext.length === 0) {
    throw new Error("AUTH_RECOVERY_PAYLOAD_INVALID");
  }
  const ring = authRecoveryEncryptionKeyRing();
  const selected = [ring.current, ring.previous].find(
    (key) => key?.kid === kid,
  );
  if (!selected) throw new Error("AUTH_RECOVERY_PAYLOAD_KEY_UNAVAILABLE");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(selected), iv);
  decipher.setAAD(Buffer.from(`${PAYLOAD_CONTEXT}:${kid}`));
  decipher.setAuthTag(tag);
  const decoded = JSON.parse(
    Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString(
      "utf8",
    ),
  ) as unknown;
  if (!decoded || typeof decoded !== "object") {
    throw new Error("AUTH_RECOVERY_PAYLOAD_INVALID");
  }
  const email = (decoded as { email?: unknown }).email;
  const token = (decoded as { token?: unknown }).token;
  if (
    typeof email !== "string" ||
    !email ||
    email.length > 320 ||
    email !== email.trim().toLowerCase() ||
    (token !== undefined &&
      (typeof token !== "string" || !/^[0-9a-f]{64}$/.test(token)))
  ) {
    throw new Error("AUTH_RECOVERY_PAYLOAD_INVALID");
  }
  return token === undefined ? { email } : { email, token };
}

export function hashAuthRecoveryValue(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export async function enqueueForgotPasswordRecovery(
  db: RecoveryWriteDb,
  normalizedEmail: string,
  now = new Date(),
): Promise<void> {
  const token = randomBytes(32).toString("hex");
  await db.insert(authRecoveryRequests).values({
    kind: "SELF_SERVICE",
    requestActorKind: "UNAUTHENTICATED",
    state: "QUEUED",
    tokenHash: hashAuthRecoveryValue(token),
    sealedPayload: sealAuthRecoveryPayload({ email: normalizedEmail, token }),
    availableAt: now,
    deliveryDeadlineAt: new Date(
      now.getTime() + AUTH_RECOVERY_DELIVERY_WINDOW_MS,
    ),
  });
}

export type AdminRecoveryEnqueueInput = {
  targetUserId: number;
  targetMembershipId: number;
  targetSessionVersion: number;
  targetEmail: string;
  requestedByUserId: number;
  requestedByMembershipId: number;
  actorSessionVersion: number;
  institutionId: number;
};

/** Persiste intenção e credencial selada; nenhum egress ocorre na requisição. */
export async function enqueueAdminPasswordRecovery(
  db: RecoveryWriteDb,
  input: AdminRecoveryEnqueueInput,
  now = new Date(),
): Promise<number> {
  const token = randomBytes(32).toString("hex");
  const tokenHash = hashAuthRecoveryValue(token);
  const normalizedEmail = input.targetEmail.toLowerCase().trim();
  const [inserted] = await db
    .insert(authRecoveryRequests)
    .values({
      kind: "ADMIN_INITIATED",
      requestActorKind: "AUTHENTICATED_ADMIN",
      state: "QUEUED",
      targetUserId: input.targetUserId,
      targetMembershipId: input.targetMembershipId,
      requestedByUserId: input.requestedByUserId,
      requestedByMembershipId: input.requestedByMembershipId,
      institutionId: input.institutionId,
      expectedTargetSessionVersion: input.targetSessionVersion,
      expectedActorSessionVersion: input.actorSessionVersion,
      emailHash: hashAuthRecoveryValue(normalizedEmail),
      tokenHash,
      sealedPayload: sealAuthRecoveryPayload({
        email: normalizedEmail,
        token,
      }),
      availableAt: now,
      deliveryDeadlineAt: new Date(
        now.getTime() + AUTH_RECOVERY_DELIVERY_WINDOW_MS,
      ),
    })
    .$returningId();
  return inserted.id;
}

/** Revoga links sem apagar o histórico/outbox e sem reabrir estados terminais. */
export async function revokeOutstandingAuthRecoveryRequests(
  db: RecoveryWriteDb,
  userId: number,
  now = new Date(),
  excludeId?: number,
): Promise<void> {
  await db
    .update(authRecoveryRequests)
    .set({
      state: "REVOKED",
      finishedAt: now,
      activeSlot: null,
      sealedPayload: null,
      leaseToken: null,
      leaseUntil: null,
      lastErrorCode: "CREDENTIAL_STATE_CHANGED",
    })
    .where(
      and(
        eq(authRecoveryRequests.targetUserId, userId),
        sql`${authRecoveryRequests.state} IN ('QUEUED', 'PROCESSING', 'ACTIVE')`,
        excludeId === undefined
          ? undefined
          : ne(authRecoveryRequests.id, excludeId),
      ),
    );
}

async function markTerminal(
  db: Db,
  id: number,
  leaseToken: string,
  state: "SKIPPED" | "DEAD" | "REVOKED",
  errorCode: string,
  now = new Date(),
): Promise<void> {
  await db
    .update(authRecoveryRequests)
    .set({
      state,
      finishedAt: now,
      activeSlot: null,
      sealedPayload: null,
      leaseToken: null,
      leaseUntil: null,
      lastErrorCode: errorCode,
    })
    .where(
      and(
        eq(authRecoveryRequests.id, id),
        eq(authRecoveryRequests.state, "PROCESSING"),
        eq(authRecoveryRequests.leaseToken, leaseToken),
      ),
    );
}

async function requeueOrDead(
  db: Db,
  row: Pick<
    typeof authRecoveryRequests.$inferSelect,
    "id" | "attemptCount" | "deliveryDeadlineAt"
  >,
  leaseToken: string,
  now: Date,
  errorCode: string,
): Promise<void> {
  const retryDelay =
    RETRY_DELAYS_MS[
      Math.min(row.attemptCount - 1, RETRY_DELAYS_MS.length - 1)
    ]!;
  const retryAt = new Date(now.getTime() + retryDelay);
  if (
    row.attemptCount >= AUTH_RECOVERY_MAX_DELIVERY_ATTEMPTS ||
    retryAt.getTime() >= row.deliveryDeadlineAt.getTime()
  ) {
    await markTerminal(db, row.id, leaseToken, "DEAD", errorCode, now);
    return;
  }
  await db
    .update(authRecoveryRequests)
    .set({
      state: "QUEUED",
      availableAt: retryAt,
      leaseToken: null,
      leaseUntil: null,
      lastErrorCode: errorCode,
    })
    .where(
      and(
        eq(authRecoveryRequests.id, row.id),
        eq(authRecoveryRequests.state, "PROCESSING"),
        eq(authRecoveryRequests.leaseToken, leaseToken),
      ),
    );
}

async function resolveSingleActiveUser(db: Db, normalizedEmail: string) {
  const rows = await db
    .select()
    .from(users)
    .where(sql`LOWER(TRIM(${users.email})) = ${normalizedEmail}`)
    .orderBy(users.id)
    .limit(2);
  if (rows.length !== 1 || rows[0]!.deletedAt || !rows[0]!.email) return null;
  return rows[0]!;
}

async function bindSelfServiceRequest(
  db: Db,
  row: typeof authRecoveryRequests.$inferSelect,
  leaseToken: string,
  payload: Required<RecoveryPayload>,
  user: typeof users.$inferSelect,
): Promise<typeof authRecoveryRequests.$inferSelect | null> {
  const tokenHash = hashAuthRecoveryValue(payload.token);
  const emailHash = hashAuthRecoveryValue(payload.email);
  const bound = await db.transaction(async (tx) => {
    const [lockedUser] = await tx
      .select()
      .from(users)
      .where(eq(users.id, user.id))
      .limit(1)
      .for("update");
    if (
      !lockedUser ||
      lockedUser.deletedAt ||
      lockedUser.approvalStatus !== "APPROVED" ||
      !isSafeBcryptHash(lockedUser.passwordHash) ||
      lockedUser.sessionVersion !== user.sessionVersion ||
      lockedUser.email?.toLowerCase().trim() !== payload.email
    ) {
      return false;
    }
    const [lockedRequest] = await tx
      .select()
      .from(authRecoveryRequests)
      .where(eq(authRecoveryRequests.id, row.id))
      .limit(1)
      .for("update");
    if (
      !lockedRequest ||
      lockedRequest.kind !== "SELF_SERVICE" ||
      lockedRequest.requestActorKind !== "UNAUTHENTICATED" ||
      lockedRequest.state !== "PROCESSING" ||
      lockedRequest.leaseToken !== leaseToken ||
      lockedRequest.tokenHash !== tokenHash ||
      lockedRequest.targetMembershipId !== null
    ) {
      return false;
    }
    if (
      lockedRequest.targetUserId !== null &&
      (lockedRequest.targetUserId !== lockedUser.id ||
        lockedRequest.expectedTargetSessionVersion !==
          lockedUser.sessionVersion ||
        lockedRequest.emailHash !== emailHash)
    ) {
      return false;
    }
    const update = await tx
      .update(authRecoveryRequests)
      .set({
        targetUserId: lockedUser.id,
        // Recuperação self-service é da conta, não de um tenant. A
        // própria linha durável preserva a trilha sem inventar/eleger PI.
        targetMembershipId: null,
        expectedTargetSessionVersion: lockedUser.sessionVersion,
        emailHash,
      })
      .where(
        and(
          eq(authRecoveryRequests.id, lockedRequest.id),
          eq(authRecoveryRequests.state, "PROCESSING"),
          eq(authRecoveryRequests.leaseToken, leaseToken),
          eq(authRecoveryRequests.tokenHash, tokenHash),
        ),
      );
    return affectedRows(update) === 1;
  });
  if (!bound) return null;
  const [updated] = await db
    .select()
    .from(authRecoveryRequests)
    .where(eq(authRecoveryRequests.id, row.id))
    .limit(1);
  return updated ?? null;
}

type AdminDeliveryProof = { targetName: string | null };
class AuthRecoveryActivationCasError extends Error {}

async function lockAndValidateAdminRequest(
  db: Db,
  row: typeof authRecoveryRequests.$inferSelect,
  leaseToken: string,
  payload: Required<RecoveryPayload>,
): Promise<AdminDeliveryProof | null> {
  if (
    !row.targetUserId ||
    !row.targetMembershipId ||
    !row.requestedByUserId ||
    !row.requestedByMembershipId ||
    !row.institutionId ||
    row.expectedTargetSessionVersion === null ||
    row.expectedActorSessionVersion === null
  ) {
    return null;
  }
  return db.transaction(async (tx) => {
    const [lockedRequest] = await tx
      .select()
      .from(authRecoveryRequests)
      .where(eq(authRecoveryRequests.id, row.id))
      .limit(1)
      .for("update");
    if (
      !lockedRequest ||
      lockedRequest.kind !== "ADMIN_INITIATED" ||
      lockedRequest.requestActorKind !== "AUTHENTICATED_ADMIN" ||
      lockedRequest.state !== "PROCESSING" ||
      lockedRequest.leaseToken !== leaseToken ||
      lockedRequest.tokenHash !== hashAuthRecoveryValue(payload.token) ||
      lockedRequest.emailHash !== hashAuthRecoveryValue(payload.email) ||
      lockedRequest.targetUserId !== row.targetUserId ||
      lockedRequest.targetMembershipId !== row.targetMembershipId ||
      lockedRequest.requestedByUserId !== row.requestedByUserId ||
      lockedRequest.requestedByMembershipId !== row.requestedByMembershipId ||
      lockedRequest.institutionId !== row.institutionId ||
      lockedRequest.expectedTargetSessionVersion !==
        row.expectedTargetSessionVersion ||
      lockedRequest.expectedActorSessionVersion !==
        row.expectedActorSessionVersion
    ) {
      return null;
    }
    const userIds = [row.targetUserId!, row.requestedByUserId!].sort(
      (left, right) => left - right,
    );
    const lockedUsers = new Map<number, typeof users.$inferSelect>();
    for (const userId of userIds) {
      const [lockedUser] = await tx
        .select()
        .from(users)
        .where(eq(users.id, userId))
        .limit(1)
        .for("update");
      if (!lockedUser) return null;
      lockedUsers.set(userId, lockedUser);
    }
    const target = lockedUsers.get(row.targetUserId!);
    const actor = lockedUsers.get(row.requestedByUserId!);
    if (
      !target ||
      !actor ||
      target.deletedAt ||
      actor.deletedAt ||
      !isSafeBcryptHash(target.passwordHash) ||
      target.approvalStatus !== "APPROVED" ||
      actor.approvalStatus !== "APPROVED" ||
      actor.role !== "admin" ||
      target.sessionVersion !== row.expectedTargetSessionVersion ||
      actor.sessionVersion !== row.expectedActorSessionVersion ||
      target.email?.toLowerCase().trim() !== payload.email
    ) {
      return null;
    }
    const membershipIds = [
      row.targetMembershipId!,
      row.requestedByMembershipId!,
    ].sort((left, right) => left - right);
    const memberships = new Map<
      number,
      typeof professionalInstitutions.$inferSelect
    >();
    for (const membershipId of membershipIds) {
      const [membership] = await tx
        .select()
        .from(professionalInstitutions)
        .where(eq(professionalInstitutions.id, membershipId))
        .limit(1)
        .for("update");
      if (!membership) return null;
      memberships.set(membershipId, membership);
    }
    const targetMembership = memberships.get(row.targetMembershipId!);
    const actorMembership = memberships.get(row.requestedByMembershipId!);
    if (
      !targetMembership?.active ||
      !actorMembership?.active ||
      targetMembership.userId !== target.id ||
      actorMembership.userId !== actor.id ||
      targetMembership.institutionId !== row.institutionId ||
      actorMembership.institutionId !== row.institutionId
    ) {
      return null;
    }
    return { targetName: target.name };
  });
}

async function activateAcceptedRequest(
  db: Db,
  row: typeof authRecoveryRequests.$inferSelect,
  leaseToken: string,
  payload: Required<RecoveryPayload>,
): Promise<boolean> {
  if (
    !row.targetUserId ||
    row.expectedTargetSessionVersion === null ||
    !row.emailHash ||
    !hasValidAuthRecoveryMembershipBinding(row.kind, row.targetMembershipId) ||
    (row.kind === "SELF_SERVICE" &&
      row.requestActorKind !== "UNAUTHENTICATED") ||
    (row.kind === "ADMIN_INITIATED" &&
      row.requestActorKind !== "AUTHENTICATED_ADMIN")
  ) {
    return false;
  }
  const now = new Date();
  try {
    return await db.transaction(async (tx) => {
      const userIds = [
        row.targetUserId!,
        ...(row.kind === "ADMIN_INITIATED" && row.requestedByUserId
          ? [row.requestedByUserId]
          : []),
      ].sort((left, right) => left - right);
      const lockedUsers = new Map<number, typeof users.$inferSelect>();
      for (const userId of userIds) {
        const [locked] = await tx
          .select()
          .from(users)
          .where(eq(users.id, userId))
          .limit(1)
          .for("update");
        if (!locked) return false;
        lockedUsers.set(userId, locked);
      }
      const lockedUser = lockedUsers.get(row.targetUserId!);
      if (
        !lockedUser ||
        lockedUser.deletedAt ||
        lockedUser.approvalStatus !== "APPROVED" ||
        !isSafeBcryptHash(lockedUser.passwordHash) ||
        lockedUser.sessionVersion !== row.expectedTargetSessionVersion ||
        lockedUser.email?.toLowerCase().trim() !== payload.email ||
        hashAuthRecoveryValue(payload.email) !== row.emailHash
      ) {
        return false;
      }
      if (row.kind === "ADMIN_INITIATED") {
        if (
          !row.requestedByUserId ||
          !row.requestedByMembershipId ||
          !row.targetMembershipId ||
          !row.institutionId ||
          row.expectedActorSessionVersion === null
        )
          return false;
        const actor = lockedUsers.get(row.requestedByUserId);
        const membershipIds = [
          row.targetMembershipId,
          row.requestedByMembershipId,
        ].sort((left, right) => left - right);
        const lockedMemberships = new Map<
          number,
          typeof professionalInstitutions.$inferSelect
        >();
        for (const membershipId of membershipIds) {
          const [lockedMembership] = await tx
            .select()
            .from(professionalInstitutions)
            .where(eq(professionalInstitutions.id, membershipId))
            .limit(1)
            .for("update");
          if (!lockedMembership) return false;
          lockedMemberships.set(membershipId, lockedMembership);
        }
        const targetMembership = lockedMemberships.get(row.targetMembershipId);
        const actorMembership = lockedMemberships.get(
          row.requestedByMembershipId,
        );
        if (
          !actor ||
          actor.deletedAt ||
          actor.approvalStatus !== "APPROVED" ||
          actor.role !== "admin" ||
          actor.sessionVersion !== row.expectedActorSessionVersion ||
          !targetMembership?.active ||
          !actorMembership?.active ||
          targetMembership.userId !== lockedUser.id ||
          actorMembership.userId !== actor.id ||
          targetMembership.institutionId !== row.institutionId ||
          actorMembership.institutionId !== row.institutionId
        )
          return false;
      }
      // A aceitação do provedor já foi obtida. Revogar irmãos e ativar o
      // substituto na mesma transação preserva o link anterior se qualquer CAS
      // falhar e também sustenta a unicidade de um único ACTIVE por conta.
      await revokeOutstandingAuthRecoveryRequests(
        tx,
        lockedUser.id,
        now,
        row.id,
      );
      const activation = await tx
        .update(authRecoveryRequests)
        .set({
          state: "ACTIVE",
          expiresAt: new Date(now.getTime() + AUTH_RECOVERY_RESET_TOKEN_TTL_MS),
          providerAcceptedAt: now,
          activeSlot: 1,
          sealedPayload: null,
          leaseToken: null,
          leaseUntil: null,
          lastErrorCode: null,
        })
        .where(
          and(
            eq(authRecoveryRequests.id, row.id),
            eq(authRecoveryRequests.state, "PROCESSING"),
            eq(authRecoveryRequests.leaseToken, leaseToken),
            eq(
              authRecoveryRequests.tokenHash,
              hashAuthRecoveryValue(payload.token),
            ),
            eq(authRecoveryRequests.kind, row.kind),
            eq(authRecoveryRequests.targetUserId, row.targetUserId!),
            row.targetMembershipId === null
              ? isNull(authRecoveryRequests.targetMembershipId)
              : eq(
                  authRecoveryRequests.targetMembershipId,
                  row.targetMembershipId,
                ),
            eq(
              authRecoveryRequests.expectedTargetSessionVersion,
              row.expectedTargetSessionVersion,
            ),
            eq(authRecoveryRequests.emailHash, row.emailHash),
            ...(row.kind === "ADMIN_INITIATED"
              ? [
                  eq(
                    authRecoveryRequests.requestedByUserId,
                    row.requestedByUserId!,
                  ),
                  eq(
                    authRecoveryRequests.requestedByMembershipId,
                    row.requestedByMembershipId!,
                  ),
                  eq(authRecoveryRequests.institutionId, row.institutionId!),
                  eq(
                    authRecoveryRequests.expectedActorSessionVersion,
                    row.expectedActorSessionVersion!,
                  ),
                ]
              : []),
          ),
        );
      if (affectedRows(activation) !== 1) {
        // Retornar false faria o driver COMMITAR a revogação dos links irmãos.
        // A exceção sentinela força rollback integral e é convertida fora da tx.
        throw new AuthRecoveryActivationCasError();
      }
      await tx
        .update(passwordResets)
        .set({ usedAt: now })
        .where(
          and(
            eq(passwordResets.userId, lockedUser.id),
            isNull(passwordResets.usedAt),
          ),
        );
      return true;
    });
  } catch (error) {
    if (error instanceof AuthRecoveryActivationCasError) return false;
    throw error;
  }
}

function recoveryMail(
  kind: typeof authRecoveryRequests.$inferSelect.kind,
  payload: Required<RecoveryPayload>,
  publicBaseUrl: string,
  targetName?: string | null,
): MailMessage {
  const firstName = targetName?.trim().split(/\s+/)[0] || "usuário";
  const intro =
    kind === "ADMIN_INITIATED"
      ? "Um administrador autorizou a redefinição da sua senha no Escala+."
      : "Recebemos um pedido para redefinir a senha da sua conta no Escala+.";
  return {
    to: payload.email,
    subject: "Escala+ — redefinir sua senha",
    text: [
      `Olá, ${firstName}.`,
      "",
      intro,
      "Abra o link abaixo para escolher uma nova senha (válido por 30 minutos):",
      "",
      `${publicBaseUrl}/reset-password?token=${payload.token}`,
      "",
      "Se você não esperava esta mensagem, ignore-a; sua senha continua a mesma.",
    ].join("\n"),
  };
}

async function processClaimedRequest(
  db: Db,
  claimed: typeof authRecoveryRequests.$inferSelect,
  leaseToken: string,
  now: Date,
  mailTransport: AuthRecoveryMailTransport,
): Promise<void> {
  if (!claimed.sealedPayload) {
    await markTerminal(db, claimed.id, leaseToken, "DEAD", "PAYLOAD_MISSING");
    return;
  }
  let payload: Required<RecoveryPayload>;
  try {
    const opened = openAuthRecoveryPayload(claimed.sealedPayload);
    if (
      !opened.token ||
      claimed.tokenHash !== hashAuthRecoveryValue(opened.token)
    ) {
      throw new Error("TOKEN_BINDING_INVALID");
    }
    payload = { email: opened.email, token: opened.token };
  } catch {
    await markTerminal(db, claimed.id, leaseToken, "DEAD", "PAYLOAD_INVALID");
    return;
  }
  const publicBaseUrl = resolveTrustedPublicBaseUrl();
  if (!publicBaseUrl) {
    await requeueOrDead(db, claimed, leaseToken, now, "PUBLIC_URL_UNAVAILABLE");
    return;
  }

  let targetUserId = claimed.targetUserId;
  let selfUser: typeof users.$inferSelect | null = null;
  if (claimed.kind === "SELF_SERVICE") {
    selfUser = await resolveSingleActiveUser(db, payload.email);
    if (!selfUser) {
      await markTerminal(
        db,
        claimed.id,
        leaseToken,
        "SKIPPED",
        "RECIPIENT_NOT_FOUND",
      );
      return;
    }
    targetUserId = selfUser.id;
  }
  if (!targetUserId) {
    await markTerminal(db, claimed.id, leaseToken, "DEAD", "BINDING_INVALID");
    return;
  }

  await withPushAccountMutex(
    db,
    targetUserId,
    PUSH_ACCOUNT_MUTATION_LOCK_TIMEOUT_SEC,
    async (connectionDb) => {
      let currentRow = claimed;
      let targetName: string | null = selfUser?.name ?? null;
      if (claimed.kind === "SELF_SERVICE") {
        const bound = await bindSelfServiceRequest(
          connectionDb,
          claimed,
          leaseToken,
          payload,
          selfUser!,
        );
        if (!bound) {
          await markTerminal(
            connectionDb,
            claimed.id,
            leaseToken,
            "REVOKED",
            "IDENTITY_CHANGED",
          );
          return;
        }
        currentRow = bound;
      } else {
        const proof = await lockAndValidateAdminRequest(
          connectionDb,
          claimed,
          leaseToken,
          payload,
        );
        if (!proof) {
          await markTerminal(
            connectionDb,
            claimed.id,
            leaseToken,
            "REVOKED",
            "IDENTITY_OR_AUTHORITY_CHANGED",
          );
          return;
        }
        targetName = proof.targetName;
      }

      if (currentRow.deliveryDeadlineAt.getTime() <= Date.now()) {
        await markTerminal(
          connectionDb,
          currentRow.id,
          leaseToken,
          "DEAD",
          "DELIVERY_WINDOW_EXPIRED",
        );
        return;
      }

      const delivery = await mailTransport.sendMail(
        recoveryMail(currentRow.kind, payload, publicBaseUrl, targetName),
        { idempotencyKey: currentRow.tokenHash! },
      );
      if (delivery.kind === "UNKNOWN") {
        await requeueOrDead(
          connectionDb,
          currentRow,
          leaseToken,
          now,
          `PROVIDER_${delivery.reason}`,
        );
        return;
      }
      if (delivery.kind === "REJECTED") {
        await markTerminal(
          connectionDb,
          currentRow.id,
          leaseToken,
          "DEAD",
          `PROVIDER_${delivery.reason}`,
        );
        return;
      }
      const activated = await activateAcceptedRequest(
        connectionDb,
        currentRow,
        leaseToken,
        payload,
      );
      if (!activated) {
        await markTerminal(
          connectionDb,
          currentRow.id,
          leaseToken,
          "REVOKED",
          "IDENTITY_OR_AUTHORITY_CHANGED",
        );
      }
    },
  );
}

/**
 * Fecha leases envenenados e payloads fora da janela antes de selecionar o
 * lote. ACTIVE expirado também deixa de ocupar o slot único da conta.
 */
async function closeExpiredAuthRecoveryRows(db: Db, now: Date): Promise<void> {
  await db
    .update(authRecoveryRequests)
    .set({
      state: "DEAD",
      activeSlot: null,
      sealedPayload: null,
      leaseToken: null,
      leaseUntil: null,
      finishedAt: now,
      lastErrorCode: "DELIVERY_WINDOW_OR_ATTEMPTS_EXHAUSTED",
    })
    .where(
      or(
        and(
          eq(authRecoveryRequests.state, "QUEUED"),
          or(
            lte(authRecoveryRequests.deliveryDeadlineAt, now),
            sql`${authRecoveryRequests.attemptCount} >= ${AUTH_RECOVERY_MAX_DELIVERY_ATTEMPTS}`,
          ),
        ),
        and(
          eq(authRecoveryRequests.state, "PROCESSING"),
          lte(authRecoveryRequests.leaseUntil, now),
          or(
            lte(authRecoveryRequests.deliveryDeadlineAt, now),
            sql`${authRecoveryRequests.attemptCount} >= ${AUTH_RECOVERY_MAX_DELIVERY_ATTEMPTS}`,
          ),
        ),
      ),
    );

  await db
    .update(authRecoveryRequests)
    .set({
      state: "REVOKED",
      activeSlot: null,
      finishedAt: now,
      lastErrorCode: "RESET_LINK_EXPIRED",
    })
    .where(
      and(
        eq(authRecoveryRequests.state, "ACTIVE"),
        lte(authRecoveryRequests.expiresAt, now),
      ),
    );
}

/**
 * Worker recuperável: claim por lease/CAS, sem e-mail/token em logs e sem
 * tornar o link utilizável antes da aceitação do provedor.
 */
export async function processPendingAuthRecoveryEmails(
  now = new Date(),
  mailTransport: AuthRecoveryMailTransport = mailer,
): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  await closeExpiredAuthRecoveryRows(db, now);
  const deadline = Date.now() + AUTH_RECOVERY_TICK_BUDGET_MS;
  const candidates = await db
    .select()
    .from(authRecoveryRequests)
    .where(
      or(
        and(
          eq(authRecoveryRequests.state, "QUEUED"),
          lte(authRecoveryRequests.availableAt, now),
          gt(authRecoveryRequests.deliveryDeadlineAt, now),
          lt(
            authRecoveryRequests.attemptCount,
            AUTH_RECOVERY_MAX_DELIVERY_ATTEMPTS,
          ),
        ),
        and(
          eq(authRecoveryRequests.state, "PROCESSING"),
          lte(authRecoveryRequests.leaseUntil, now),
          gt(authRecoveryRequests.deliveryDeadlineAt, now),
          lt(
            authRecoveryRequests.attemptCount,
            AUTH_RECOVERY_MAX_DELIVERY_ATTEMPTS,
          ),
        ),
      ),
    )
    .orderBy(authRecoveryRequests.id)
    .limit(AUTH_RECOVERY_DELIVERY_BATCH_SIZE);

  let processed = 0;
  for (const candidate of candidates) {
    if (Date.now() >= deadline) break;
    const claimNow = new Date();
    const leaseToken = randomUUID();
    const leaseUntil = new Date(claimNow.getTime() + DELIVERY_LEASE_MS);
    const claim = await db
      .update(authRecoveryRequests)
      .set({
        state: "PROCESSING",
        leaseToken,
        leaseUntil,
        attemptCount: sql`${authRecoveryRequests.attemptCount} + 1`,
      })
      .where(
        and(
          eq(authRecoveryRequests.id, candidate.id),
          or(
            and(
              eq(authRecoveryRequests.state, "QUEUED"),
              lte(authRecoveryRequests.availableAt, now),
              gt(authRecoveryRequests.deliveryDeadlineAt, now),
              lt(
                authRecoveryRequests.attemptCount,
                AUTH_RECOVERY_MAX_DELIVERY_ATTEMPTS,
              ),
            ),
            and(
              eq(authRecoveryRequests.state, "PROCESSING"),
              lte(authRecoveryRequests.leaseUntil, now),
              gt(authRecoveryRequests.deliveryDeadlineAt, now),
              lt(
                authRecoveryRequests.attemptCount,
                AUTH_RECOVERY_MAX_DELIVERY_ATTEMPTS,
              ),
            ),
          ),
        ),
      );
    if (affectedRows(claim) !== 1) continue;
    let claimed: typeof authRecoveryRequests.$inferSelect | undefined;
    try {
      [claimed] = await db
        .select()
        .from(authRecoveryRequests)
        .where(
          and(
            eq(authRecoveryRequests.id, candidate.id),
            eq(authRecoveryRequests.leaseToken, leaseToken),
          ),
        )
        .limit(1);
      if (!claimed) {
        await markTerminal(
          db,
          candidate.id,
          leaseToken,
          "DEAD",
          "CLAIM_READ_MISSING",
          claimNow,
        );
        processed += 1;
        continue;
      }
      await processClaimedRequest(
        db,
        claimed,
        leaseToken,
        claimNow,
        mailTransport,
      );
    } catch {
      try {
        await requeueOrDead(
          db,
          claimed ?? {
            id: candidate.id,
            attemptCount: candidate.attemptCount + 1,
            deliveryDeadlineAt: candidate.deliveryDeadlineAt,
          },
          leaseToken,
          new Date(),
          "UNEXPECTED_ATTEMPT_FAILURE",
        );
      } catch {
        // O lease continua sendo o último mecanismo de recuperação. Uma linha
        // envenenada não impede que o lote avance para a próxima intenção.
        console.error("[auth-recovery] LEASE_RELEASE_FAILED", {
          recoveryRequestId: candidate.id,
        });
      }
      console.error("[auth-recovery] DELIVERY_ATTEMPT_FAILED", {
        recoveryRequestId: candidate.id,
      });
    }
    processed += 1;
  }
  return processed;
}

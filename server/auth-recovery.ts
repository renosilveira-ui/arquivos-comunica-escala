import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import {
  and,
  eq,
  isNull,
  lte,
  ne,
  or,
  sql,
} from "drizzle-orm";
import {
  authRecoveryRequests,
  passwordResets,
  users,
} from "../drizzle/schema";
import {
  lockCanonicalAuditMembership,
  readCanonicalAuditMembership,
  type AuditMembershipSnapshot,
} from "./auth-audit-membership";
import { recordAudit } from "./audit-trail";
import { getDb } from "./db";
import { ENV } from "./_core/env";
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

const PAYLOAD_VERSION = "v1";
const PAYLOAD_CONTEXT = "escala:auth-recovery-outbox:v1";
// O lease excede com folga o timeout máximo do único transporte operacional.
// Se um processo morrer, o retry reabre o MESMO payload/token selado; nunca
// gera uma segunda credencial, e a ativação continua protegida por lease/CAS.
const DELIVERY_LEASE_MS = MAIL_HTTP_TIMEOUT_MS + 45_000;
const DELIVERY_BATCH_SIZE = 10;
const MAX_DELIVERY_ATTEMPTS = 5;
const RESET_TOKEN_TTL_MS = 30 * 60 * 1000;
const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000] as const;

type RecoveryPayload = { email: string; token?: string };
export type AuthRecoveryMailTransport = {
  sendMail(message: MailMessage): Promise<MailResult>;
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

function encryptionKey(): Buffer {
  return createHash("sha256")
    .update(PAYLOAD_CONTEXT)
    .update("\0")
    .update(ENV.cookieSecret)
    .digest();
}

/** AES-GCM: nenhuma recuperação persiste e-mail ou token em claro. */
export function sealAuthRecoveryPayload(payload: RecoveryPayload): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  cipher.setAAD(Buffer.from(PAYLOAD_CONTEXT));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    PAYLOAD_VERSION,
    iv.toString("base64url"),
    ciphertext.toString("base64url"),
    tag.toString("base64url"),
  ].join(".");
}

export function openAuthRecoveryPayload(sealed: string): RecoveryPayload {
  const [version, ivText, ciphertextText, tagText, extra] = sealed.split(".");
  if (
    version !== PAYLOAD_VERSION ||
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
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), iv);
  decipher.setAAD(Buffer.from(PAYLOAD_CONTEXT));
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
  await db.insert(authRecoveryRequests).values({
    kind: "SELF_SERVICE",
    state: "QUEUED",
    sealedPayload: sealAuthRecoveryPayload({ email: normalizedEmail }),
    availableAt: now,
  });
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
      usedAt: now,
      sealedPayload: null,
      leaseToken: null,
      leaseUntil: null,
      lastErrorCode: "CREDENTIAL_STATE_CHANGED",
    })
    .where(
      and(
        eq(authRecoveryRequests.targetUserId, userId),
        sql`${authRecoveryRequests.state} IN ('QUEUED', 'PROCESSING', 'PENDING_DELIVERY', 'ACTIVE')`,
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
): Promise<void> {
  await db
    .update(authRecoveryRequests)
    .set({
      state,
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
  row: typeof authRecoveryRequests.$inferSelect,
  leaseToken: string,
  now: Date,
  errorCode: string,
): Promise<void> {
  if (row.attemptCount >= MAX_DELIVERY_ATTEMPTS) {
    await markTerminal(db, row.id, leaseToken, "DEAD", errorCode);
    return;
  }
  const retryDelay =
    RETRY_DELAYS_MS[Math.min(row.attemptCount - 1, RETRY_DELAYS_MS.length - 1)]!;
  await db
    .update(authRecoveryRequests)
    .set({
      state: "QUEUED",
      availableAt: new Date(now.getTime() + retryDelay),
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
  payload: RecoveryPayload,
): Promise<{
  row: typeof authRecoveryRequests.$inferSelect;
  payload: Required<RecoveryPayload>;
} | null> {
  if (payload.token) return { row, payload: { ...payload, token: payload.token } };

  const user = await resolveSingleActiveUser(db, payload.email);
  if (!user) {
    await markTerminal(db, row.id, leaseToken, "SKIPPED", "RECIPIENT_NOT_FOUND");
    return null;
  }
  const membership = await readCanonicalAuditMembership(db, user.id);
  if (!membership) {
    await markTerminal(db, row.id, leaseToken, "SKIPPED", "RECIPIENT_NOT_ELIGIBLE");
    return null;
  }

  const token = randomBytes(32).toString("hex");
  const tokenHash = hashAuthRecoveryValue(token);
  const emailHash = hashAuthRecoveryValue(payload.email);
  const sealedPayload = sealAuthRecoveryPayload({ email: payload.email, token });

  const bound = await withPushAccountMutex(
    db,
    user.id,
    PUSH_ACCOUNT_MUTATION_LOCK_TIMEOUT_SEC,
    (connectionDb) =>
      connectionDb.transaction(async (tx) => {
        const [lockedUser] = await tx
          .select()
          .from(users)
          .where(eq(users.id, user.id))
          .limit(1)
          .for("update");
        if (
          !lockedUser ||
          lockedUser.deletedAt ||
          lockedUser.sessionVersion !== user.sessionVersion ||
          lockedUser.email?.toLowerCase().trim() !== payload.email
        ) {
          return false;
        }
        await lockCanonicalAuditMembership(tx, lockedUser.id, membership);
        const [lockedRequest] = await tx
          .select()
          .from(authRecoveryRequests)
          .where(eq(authRecoveryRequests.id, row.id))
          .limit(1)
          .for("update");
        if (
          !lockedRequest ||
          lockedRequest.state !== "PROCESSING" ||
          lockedRequest.leaseToken !== leaseToken ||
          lockedRequest.tokenHash
        ) {
          return false;
        }

        const issuedAt = new Date();
        await tx
          .update(passwordResets)
          .set({ usedAt: issuedAt })
          .where(
            and(
              eq(passwordResets.userId, lockedUser.id),
              isNull(passwordResets.usedAt),
            ),
          );
        await revokeOutstandingAuthRecoveryRequests(
          tx,
          lockedUser.id,
          issuedAt,
          lockedRequest.id,
        );
        const update = await tx
          .update(authRecoveryRequests)
          .set({
            targetUserId: lockedUser.id,
            targetMembershipId: membership.membershipId,
            expectedTargetSessionVersion: lockedUser.sessionVersion,
            emailHash,
            tokenHash,
            sealedPayload,
          })
          .where(
            and(
              eq(authRecoveryRequests.id, lockedRequest.id),
              eq(authRecoveryRequests.state, "PROCESSING"),
              eq(authRecoveryRequests.leaseToken, leaseToken),
              isNull(authRecoveryRequests.tokenHash),
            ),
          );
        if (affectedRows(update) !== 1) return false;

        await recordAudit(
          {
            actorUserId: lockedUser.id,
            actorRole: lockedUser.role,
            actorName: lockedUser.name?.trim().slice(0, 255) || undefined,
            action: "USER_UPDATED",
            entityType: "USER",
            entityId: lockedUser.id,
            description: "Pedido de redefinição de senha enfileirado",
            metadata: { recoveryRequestId: lockedRequest.id },
            institutionId: membership.institutionId,
          },
          { db: tx, strict: true },
        );
        return true;
      }),
  );
  if (!bound) {
    await markTerminal(db, row.id, leaseToken, "REVOKED", "IDENTITY_CHANGED");
    return null;
  }
  const [updated] = await db
    .select()
    .from(authRecoveryRequests)
    .where(eq(authRecoveryRequests.id, row.id))
    .limit(1);
  return updated ? { row: updated, payload: { email: payload.email, token } } : null;
}

async function activateSelfServiceRequest(
  db: Db,
  row: typeof authRecoveryRequests.$inferSelect,
  leaseToken: string,
  payload: Required<RecoveryPayload>,
  membership: AuditMembershipSnapshot,
  now: Date,
): Promise<boolean> {
  if (!row.targetUserId || !row.expectedTargetSessionVersion || !row.emailHash) {
    return false;
  }
  return withPushAccountMutex(
    db,
    row.targetUserId,
    PUSH_ACCOUNT_MUTATION_LOCK_TIMEOUT_SEC,
    (connectionDb) =>
      connectionDb.transaction(async (tx) => {
        const [lockedUser] = await tx
          .select()
          .from(users)
          .where(eq(users.id, row.targetUserId!))
          .limit(1)
          .for("update");
        if (
          !lockedUser ||
          lockedUser.deletedAt ||
          lockedUser.sessionVersion !== row.expectedTargetSessionVersion ||
          hashAuthRecoveryValue(lockedUser.email?.toLowerCase().trim() ?? "") !==
            row.emailHash ||
          lockedUser.email?.toLowerCase().trim() !== payload.email
        ) {
          return false;
        }
        await lockCanonicalAuditMembership(tx, lockedUser.id, membership);
        const activation = await tx
          .update(authRecoveryRequests)
          .set({
            state: "ACTIVE",
            expiresAt: new Date(now.getTime() + RESET_TOKEN_TTL_MS),
            providerAcceptedAt: now,
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
              eq(authRecoveryRequests.tokenHash, hashAuthRecoveryValue(payload.token)),
            ),
          );
        return affectedRows(activation) === 1;
      }),
  );
}

async function processClaimedSelfServiceRequest(
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
  let payload: RecoveryPayload;
  try {
    payload = openAuthRecoveryPayload(claimed.sealedPayload);
  } catch {
    await markTerminal(db, claimed.id, leaseToken, "DEAD", "PAYLOAD_INVALID");
    return;
  }

  const bound = await bindSelfServiceRequest(db, claimed, leaseToken, payload);
  if (!bound) return;
  const row = bound.row;
  const boundPayload = bound.payload;
  if (!row.targetUserId || !row.targetMembershipId) {
    await markTerminal(db, row.id, leaseToken, "DEAD", "BINDING_INVALID");
    return;
  }
  const membership = await readCanonicalAuditMembership(db, row.targetUserId);
  if (!membership || membership.membershipId !== row.targetMembershipId) {
    await markTerminal(db, row.id, leaseToken, "REVOKED", "AUTHORITY_CHANGED");
    return;
  }
  const publicBaseUrl = resolveTrustedPublicBaseUrl();
  if (!publicBaseUrl) {
    await requeueOrDead(db, row, leaseToken, now, "PUBLIC_URL_UNAVAILABLE");
    return;
  }

  const link = `${publicBaseUrl}/reset-password?token=${boundPayload.token}`;
  const firstName = boundPayload.email.split("@")[0] || "usuário";
  const delivery = await mailTransport.sendMail({
    to: boundPayload.email,
    subject: "Escala+ — redefinir sua senha",
    text: [
      `Olá, ${firstName}.`,
      "",
      "Recebemos um pedido para redefinir a senha da sua conta no Escala+.",
      "Abra o link abaixo para escolher uma nova senha (válido por 30 minutos):",
      "",
      link,
      "",
      "Se você não pediu isso, ignore este e-mail — sua senha continua a mesma.",
    ].join("\n"),
  });
  if (!delivery.delivered) {
    await requeueOrDead(
      db,
      row,
      leaseToken,
      now,
      delivery.error ? "PROVIDER_REJECTED" : "PROVIDER_UNAVAILABLE",
    );
    return;
  }

  const activated = await activateSelfServiceRequest(
    db,
    row,
    leaseToken,
    boundPayload,
    membership,
    new Date(),
  );
  if (!activated) {
    await markTerminal(db, row.id, leaseToken, "REVOKED", "IDENTITY_CHANGED");
  }
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
  const candidates = await db
    .select()
    .from(authRecoveryRequests)
    .where(
      and(
        eq(authRecoveryRequests.kind, "SELF_SERVICE"),
        or(
          and(
            eq(authRecoveryRequests.state, "QUEUED"),
            lte(authRecoveryRequests.availableAt, now),
          ),
          and(
            eq(authRecoveryRequests.state, "PROCESSING"),
            lte(authRecoveryRequests.leaseUntil, now),
          ),
        ),
      ),
    )
    .orderBy(authRecoveryRequests.id)
    .limit(DELIVERY_BATCH_SIZE);

  let processed = 0;
  for (const candidate of candidates) {
    const leaseToken = randomUUID();
    const leaseUntil = new Date(now.getTime() + DELIVERY_LEASE_MS);
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
          eq(authRecoveryRequests.kind, "SELF_SERVICE"),
          or(
            and(
              eq(authRecoveryRequests.state, "QUEUED"),
              lte(authRecoveryRequests.availableAt, now),
            ),
            and(
              eq(authRecoveryRequests.state, "PROCESSING"),
              lte(authRecoveryRequests.leaseUntil, now),
            ),
          ),
        ),
      );
    if (affectedRows(claim) !== 1) continue;
    const [claimed] = await db
      .select()
      .from(authRecoveryRequests)
      .where(
        and(
          eq(authRecoveryRequests.id, candidate.id),
          eq(authRecoveryRequests.leaseToken, leaseToken),
        ),
      )
      .limit(1);
    if (!claimed) continue;
    try {
      await processClaimedSelfServiceRequest(
        db,
        claimed,
        leaseToken,
        now,
        mailTransport,
      );
    } catch {
      // O lease mantém a intenção recuperável; nada sensível cruza o log.
      console.error("[auth-recovery] DELIVERY_ATTEMPT_FAILED", {
        recoveryRequestId: claimed.id,
      });
    }
    processed += 1;
  }
  return processed;
}

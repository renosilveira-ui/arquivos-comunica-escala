import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import {
  institutions,
  operationalEmailVerificationTokens,
  professionalInstitutions,
  professionals,
  users,
  userOperationalEmailTrust,
} from "../drizzle/schema";
import { getDb } from "./db";
import {
  hashOperationalEmailAddress,
  type OperationalDeliveryChannel,
  type OperationalEmailTrustSource,
  type OperationalEmailTrustState,
} from "./operational-events";

/**
 * A confirmação de e-mail é uma prova de posse do endereço, não uma prova de
 * acesso institucional. A autorização no tenant continua sendo conferida no
 * vínculo profissional ativo, imediatamente antes de qualquer entrega.
 */
export const OPERATIONAL_EMAIL_VERIFICATION_TTL_MS = 30 * 60 * 1000;

const OPERATIONAL_EMAIL_TOKEN_DOMAIN =
  "escala-operational-email-verification:v1:";
const OPERATIONAL_EMAIL_TOKEN_BYTES = 32;

type OperationalEmailTrustDb = NonNullable<Awaited<ReturnType<typeof getDb>>>;

/**
 * Superfície mínima exigida por esta camada. Todo chamador de produção deve
 * fornecer a transação que contém a mutação de conta ou de convite; não há
 * operação em autocommit nesta API.
 */
export type OperationalEmailTrustTx = Pick<
  OperationalEmailTrustDb,
  "select" | "insert" | "update"
>;

type OperationalEmailUser = {
  id: number;
  email: string | null;
  approvalStatus: "PENDING" | "APPROVED";
  deletedAt: Date | null;
};

type StoredOperationalEmailTrust = {
  id: number;
  userId: number;
  emailHash: string;
  state: OperationalEmailTrustState;
  source: OperationalEmailTrustSource;
  trustedAt: Date | null;
  invalidatedAt: Date | null;
};

type StoredOperationalEmailVerificationToken = {
  id: number;
  userId: number;
  emailHash: string;
  tokenHash: string;
  expiresAt: Date;
  usedAt: Date | null;
};

type OperationalInstitutionAuthorization =
  | { kind: "AUTHORIZED"; user: OperationalEmailUser }
  | {
      kind: "INELIGIBLE";
      reason:
        | "NO_ACTIVE_INSTITUTION_MEMBERSHIP"
        | "INSTITUTION_INACTIVE"
        | "INSTITUTIONAL_IDENTITY_MISMATCH"
        | "USER_NOT_APPROVED"
        | "USER_UNAVAILABLE";
    };

type OperationalEmailInstitution = {
  id: number;
  isActive: boolean;
};

type OperationalEmailProfessional = {
  id: number;
  userId: number;
};

type OperationalEmailInstitutionMembership = {
  id: number;
  professionalId: number;
  userId: number;
  active: boolean;
};

/**
 * Porta de persistência intencionalmente pequena. Ela permite testar os
 * invariantes de concorrência e de origem sem precisar de um banco real, mas
 * a implementação de produção abaixo sempre emite SELECT ... FOR UPDATE.
 */
export type OperationalEmailTrustStore = {
  lockInstitution(
    institutionId: number,
  ): Promise<OperationalEmailInstitution | null>;
  lockProfessionalsByUser(
    userId: number,
  ): Promise<readonly OperationalEmailProfessional[]>;
  lockInstitutionMembership(input: {
    userId: number;
    institutionId: number;
  }): Promise<OperationalEmailInstitutionMembership | null>;
  lockUser(userId: number): Promise<OperationalEmailUser | null>;
  lockTrust(userId: number): Promise<StoredOperationalEmailTrust | null>;
  saveTrust(input: {
    existing: StoredOperationalEmailTrust | null;
    userId: number;
    emailHash: string;
    state: OperationalEmailTrustState;
    source: OperationalEmailTrustSource;
    trustedAt: Date | null;
    invalidatedAt: Date | null;
  }): Promise<void>;
  invalidateUnusedTokens(userId: number, at: Date): Promise<void>;
  createVerificationToken(input: {
    userId: number;
    emailHash: string;
    tokenHash: string;
    expiresAt: Date;
  }): Promise<void>;
  findTokenByHash(tokenHash: string): Promise<{ userId: number } | null>;
  lockTokenByHash(
    tokenHash: string,
  ): Promise<StoredOperationalEmailVerificationToken | null>;
  markTokenUsedIfUsable(input: {
    tokenId: number;
    now: Date;
  }): Promise<boolean>;
};

export class OperationalEmailTrustError extends Error {
  constructor(
    readonly code:
      | "INVALID_INPUT"
      | "USER_UNAVAILABLE"
      | "USER_EMAIL_UNAVAILABLE"
      | "INVALID_OR_EXPIRED_TOKEN",
    message: string,
  ) {
    super(message);
    this.name = "OperationalEmailTrustError";
  }
}

export type OperationalEmailTrustWriteResult = {
  state: OperationalEmailTrustState;
  source: OperationalEmailTrustSource;
  changed: boolean;
};

export type OperationalEmailVerificationIssueResult =
  | {
      kind: "ISSUED";
      /** Só existe em memória para o adaptador de envio futuro. Nunca logar. */
      token: string;
      expiresAt: Date;
    }
  | { kind: "ALREADY_TRUSTED" };

/**
 * INVALID_OR_EXPIRED não diferencia inexistente, expirado, e-mail alterado ou
 * replay inseguro. Uma API pública futura deve manter esse resultado opaco.
 */
export type OperationalEmailVerificationConsumeResult =
  | { kind: "CONSUMED" }
  | { kind: "ALREADY_CONSUMED" }
  | { kind: "INVALID_OR_EXPIRED" };

export type OperationalEmailEligibility =
  | {
      kind: "ELIGIBLE";
      userId: number;
      institutionId: number;
    }
  | {
      kind: "INELIGIBLE";
      reason:
        | "NO_ACTIVE_INSTITUTION_MEMBERSHIP"
        | "INSTITUTION_INACTIVE"
        | "INSTITUTIONAL_IDENTITY_MISMATCH"
        | "USER_UNAVAILABLE"
        | "USER_NOT_APPROVED"
        | "USER_EMAIL_UNAVAILABLE"
        | "NO_TRUST_RECORD"
        | "EMAIL_CHANGED"
        | "TRUST_PENDING"
        | "TRUST_REVOKED"
        | "TRUST_SOURCE_UNVERIFIED"
        | "TRUST_UNKNOWN_STATE";
    };

export type OperationalDeliveryChannelResolution = {
  eligibleChannels: readonly OperationalDeliveryChannel[];
  emailEligibility: OperationalEmailEligibility | null;
};

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function assertPositiveId(
  value: unknown,
  label: string,
): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new OperationalEmailTrustError(
      "INVALID_INPUT",
      `${label} deve ser um inteiro positivo`,
    );
  }
}

function assertOperationalEmailTrustSource(
  source: unknown,
): asserts source is OperationalEmailTrustSource {
  if (
    source !== "ADMIN_CREATED" &&
    source !== "INVITE_ACTIVATED" &&
    source !== "USER_CONFIRMED" &&
    source !== "LEGACY"
  ) {
    throw new OperationalEmailTrustError(
      "INVALID_INPUT",
      "Origem de confiança de e-mail operacional inválida",
    );
  }
}

function targetStateForSource(
  source: OperationalEmailTrustSource,
): OperationalEmailTrustState {
  // LEGACY representa tanto contas preexistentes sem prova de origem quanto
  // autocadastros antes da confirmação do endereço. Ela nunca cria confiança.
  return source === "LEGACY" ? "PENDING" : "TRUSTED";
}

function hasCurrentTrustedEmail(
  trust: StoredOperationalEmailTrust | null,
  emailHash: string,
): boolean {
  return (
    trust?.state === "TRUSTED" &&
    trust.emailHash === emailHash &&
    isDeliverableOperationalEmailTrustSource(trust.source)
  );
}

function isDeliverableOperationalEmailTrustSource(
  source: unknown,
): source is Exclude<OperationalEmailTrustSource, "LEGACY"> {
  return (
    source === "ADMIN_CREATED" ||
    source === "INVITE_ACTIVATED" ||
    source === "USER_CONFIRMED"
  );
}

function isOperationalEmailHash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function hashOperationalEmailVerificationToken(rawToken: string): string {
  if (
    typeof rawToken !== "string" ||
    rawToken.length < 32 ||
    rawToken.length > 256 ||
    !/^[A-Za-z0-9_-]+$/.test(rawToken)
  ) {
    throw new OperationalEmailTrustError(
      "INVALID_OR_EXPIRED_TOKEN",
      "Token de confirmação inválido ou expirado",
    );
  }
  return sha256(`${OPERATIONAL_EMAIL_TOKEN_DOMAIN}${rawToken}`);
}

export function generateOperationalEmailVerificationToken(): string {
  return randomBytes(OPERATIONAL_EMAIL_TOKEN_BYTES).toString("base64url");
}

export function hashOperationalEmailVerificationTokenForStorage(
  rawToken: string,
): string {
  return hashOperationalEmailVerificationToken(rawToken);
}

function createOperationalEmailTrustStore(
  tx: OperationalEmailTrustTx,
): OperationalEmailTrustStore {
  return {
    async lockInstitution(institutionId) {
      const [institution] = await tx
        .select({ id: institutions.id, isActive: institutions.isActive })
        .from(institutions)
        .where(eq(institutions.id, institutionId))
        .limit(1)
        .for("update");
      return institution ?? null;
    },
    async lockProfessionalsByUser(userId) {
      return tx
        .select({ id: professionals.id, userId: professionals.userId })
        .from(professionals)
        .where(eq(professionals.userId, userId))
        .for("update");
    },
    async lockInstitutionMembership({ userId, institutionId }) {
      const [membership] = await tx
        .select({
          id: professionalInstitutions.id,
          professionalId: professionalInstitutions.professionalId,
          userId: professionalInstitutions.userId,
          active: professionalInstitutions.active,
        })
        .from(professionalInstitutions)
        .where(
          and(
            eq(professionalInstitutions.userId, userId),
            eq(professionalInstitutions.institutionId, institutionId),
          ),
        )
        .limit(1)
        .for("update");
      return membership ?? null;
    },
    async lockUser(userId) {
      const [user] = await tx
        .select({
          id: users.id,
          email: users.email,
          approvalStatus: users.approvalStatus,
          deletedAt: users.deletedAt,
        })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1)
        .for("update");
      return user ?? null;
    },
    async lockTrust(userId) {
      const [trust] = await tx
        .select({
          id: userOperationalEmailTrust.id,
          userId: userOperationalEmailTrust.userId,
          emailHash: userOperationalEmailTrust.emailHash,
          state: userOperationalEmailTrust.state,
          source: userOperationalEmailTrust.source,
          trustedAt: userOperationalEmailTrust.trustedAt,
          invalidatedAt: userOperationalEmailTrust.invalidatedAt,
        })
        .from(userOperationalEmailTrust)
        .where(eq(userOperationalEmailTrust.userId, userId))
        .limit(1)
        .for("update");
      return trust ?? null;
    },
    async saveTrust(input) {
      const values = {
        emailHash: input.emailHash,
        state: input.state,
        source: input.source,
        trustedAt: input.trustedAt,
        invalidatedAt: input.invalidatedAt,
      };
      if (input.existing) {
        await tx
          .update(userOperationalEmailTrust)
          .set(values)
          .where(eq(userOperationalEmailTrust.id, input.existing.id));
        return;
      }
      await tx.insert(userOperationalEmailTrust).values({
        userId: input.userId,
        ...values,
      });
    },
    async invalidateUnusedTokens(userId, at) {
      await tx
        .update(operationalEmailVerificationTokens)
        .set({ usedAt: at })
        .where(
          and(
            eq(operationalEmailVerificationTokens.userId, userId),
            isNull(operationalEmailVerificationTokens.usedAt),
          ),
        );
    },
    async createVerificationToken(input) {
      await tx.insert(operationalEmailVerificationTokens).values(input);
    },
    async findTokenByHash(tokenHash) {
      // Esta leitura não é decisória. O token é relido FOR UPDATE depois de
      // bloquear o usuário, mantendo a ordem de lock user -> token para não
      // cruzar emissão, consumo e invalidação concorrentes.
      const [token] = await tx
        .select({ userId: operationalEmailVerificationTokens.userId })
        .from(operationalEmailVerificationTokens)
        .where(eq(operationalEmailVerificationTokens.tokenHash, tokenHash))
        .limit(1);
      return token ?? null;
    },
    async lockTokenByHash(tokenHash) {
      const [token] = await tx
        .select({
          id: operationalEmailVerificationTokens.id,
          userId: operationalEmailVerificationTokens.userId,
          emailHash: operationalEmailVerificationTokens.emailHash,
          tokenHash: operationalEmailVerificationTokens.tokenHash,
          expiresAt: operationalEmailVerificationTokens.expiresAt,
          usedAt: operationalEmailVerificationTokens.usedAt,
        })
        .from(operationalEmailVerificationTokens)
        .where(eq(operationalEmailVerificationTokens.tokenHash, tokenHash))
        .limit(1)
        .for("update");
      return token ?? null;
    },
    async markTokenUsedIfUsable({ tokenId, now }) {
      const result = await tx
        .update(operationalEmailVerificationTokens)
        .set({ usedAt: now })
        .where(
          and(
            eq(operationalEmailVerificationTokens.id, tokenId),
            isNull(operationalEmailVerificationTokens.usedAt),
            gt(operationalEmailVerificationTokens.expiresAt, now),
          ),
        );
      return affectedRows(result) === 1;
    },
  };
}

function affectedRows(result: unknown): number {
  if (result && typeof result === "object" && "affectedRows" in result) {
    return Number((result as { affectedRows?: unknown }).affectedRows ?? 0);
  }
  if (Array.isArray(result)) {
    return Number(
      (result[0] as { affectedRows?: unknown } | undefined)?.affectedRows ?? 0,
    );
  }
  return 0;
}

function normalizeOperationalEmailHashOrNull(email: unknown): string | null {
  if (typeof email !== "string") return null;
  try {
    return hashOperationalEmailAddress(email);
  } catch {
    return null;
  }
}

/**
 * Ordem canônica de identidade compartilhada com Admin: usuário ->
 * profissional -> vínculo institucional -> instituição -> trust. Cada linha
 * é relida bloqueada antes de liberar o canal para não aceitar identidade
 * parcialmente alterada ou criar ciclo com mutações administrativas.
 */
async function lockCanonicalInstitutionAuthorization(
  store: OperationalEmailTrustStore,
  input: { userId: number; institutionId: number },
): Promise<OperationalInstitutionAuthorization> {
  const user = await store.lockUser(input.userId);
  if (!user || user.deletedAt) {
    return { kind: "INELIGIBLE", reason: "USER_UNAVAILABLE" };
  }
  if (user.approvalStatus !== "APPROVED") {
    return { kind: "INELIGIBLE", reason: "USER_NOT_APPROVED" };
  }

  const professionals = await store.lockProfessionalsByUser(input.userId);
  const membership = await store.lockInstitutionMembership(input);
  if (!membership || !membership.active) {
    return {
      kind: "INELIGIBLE",
      reason: "NO_ACTIVE_INSTITUTION_MEMBERSHIP",
    };
  }
  const professional = professionals.find(
    (candidate) => candidate.id === membership.professionalId,
  );
  if (
    membership.userId !== input.userId ||
    !professional ||
    professional.userId !== membership.userId
  ) {
    return {
      kind: "INELIGIBLE",
      reason: "INSTITUTIONAL_IDENTITY_MISMATCH",
    };
  }
  if (user.id !== membership.userId) {
    return {
      kind: "INELIGIBLE",
      reason: "INSTITUTIONAL_IDENTITY_MISMATCH",
    };
  }
  const institution = await store.lockInstitution(input.institutionId);
  if (!institution || !institution.isActive) {
    return { kind: "INELIGIBLE", reason: "INSTITUTION_INACTIVE" };
  }
  return { kind: "AUTHORIZED", user };
}

async function lockCurrentUserEmail(
  store: OperationalEmailTrustStore,
  userId: number,
): Promise<{ user: OperationalEmailUser; emailHash: string }> {
  assertPositiveId(userId, "userId");
  const user = await store.lockUser(userId);
  if (!user || user.deletedAt) {
    throw new OperationalEmailTrustError(
      "USER_UNAVAILABLE",
      "Conta indisponível para e-mail operacional",
    );
  }
  const emailHash = normalizeOperationalEmailHashOrNull(user.email);
  if (!emailHash) {
    throw new OperationalEmailTrustError(
      "USER_EMAIL_UNAVAILABLE",
      "Conta sem e-mail operacional utilizável",
    );
  }
  return { user, emailHash };
}

async function writeTrustForOrigin(
  store: OperationalEmailTrustStore,
  input: {
    userId: number;
    source: OperationalEmailTrustSource;
    now: Date;
  },
): Promise<OperationalEmailTrustWriteResult> {
  assertOperationalEmailTrustSource(input.source);
  const { emailHash } = await lockCurrentUserEmail(store, input.userId);
  const existing = await store.lockTrust(input.userId);

  // Uma fonte fraca não pode rebaixar nem apagar uma prova forte já associada
  // ao mesmo endereço. Isso cobre a recuperação de shell no autocadastro.
  if (
    input.source === "LEGACY" &&
    hasCurrentTrustedEmail(existing, emailHash)
  ) {
    return {
      state: existing!.state,
      source: existing!.source,
      changed: false,
    };
  }

  const state = targetStateForSource(input.source);
  const unchanged =
    existing?.emailHash === emailHash &&
    existing.state === state &&
    existing.source === input.source &&
    (state !== "TRUSTED" || existing.invalidatedAt === null);
  if (!unchanged) {
    await store.saveTrust({
      existing,
      userId: input.userId,
      emailHash,
      state,
      source: input.source,
      trustedAt: state === "TRUSTED" ? input.now : null,
      invalidatedAt: null,
    });
  }

  // Um token anterior não deve poder reescrever a origem ou confirmar um
  // endereço depois de a confiança administrativa/por convite já existir.
  if (state === "TRUSTED") {
    await store.invalidateUnusedTokens(input.userId, input.now);
  }

  return { state, source: input.source, changed: !unchanged };
}

/**
 * Entrada privada de origem. As portas exportadas abaixo fixam a origem no
 * próprio nome para que nenhum caller de produção possa fabricar
 * USER_CONFIRMED ou trocar uma origem fraca por forte via payload.
 */
async function recordOperationalEmailTrustForOrigin(
  store: OperationalEmailTrustStore,
  input: {
    userId: number;
    source: Exclude<OperationalEmailTrustSource, "USER_CONFIRMED">;
    now?: Date;
  },
): Promise<OperationalEmailTrustWriteResult> {
  return writeTrustForOrigin(store, {
    userId: input.userId,
    source: input.source,
    now: input.now ?? new Date(),
  });
}

async function recordOperationalEmailTrustForOriginInTransaction(
  tx: OperationalEmailTrustTx,
  input: {
    userId: number;
    source: Exclude<OperationalEmailTrustSource, "USER_CONFIRMED">;
    now?: Date;
  },
): Promise<OperationalEmailTrustWriteResult> {
  return recordOperationalEmailTrustForOrigin(
    createOperationalEmailTrustStore(tx),
    input,
  );
}

/** Conta criada ou e-mail legado confirmado por gestor autorizado. */
export async function trustOperationalEmailFromAdministrativeOrigin(
  store: OperationalEmailTrustStore,
  input: { userId: number; now?: Date },
): Promise<OperationalEmailTrustWriteResult> {
  return recordOperationalEmailTrustForOrigin(store, {
    ...input,
    source: "ADMIN_CREATED",
  });
}

export async function trustOperationalEmailFromAdministrativeOriginInTransaction(
  tx: OperationalEmailTrustTx,
  input: { userId: number; now?: Date },
): Promise<OperationalEmailTrustWriteResult> {
  return recordOperationalEmailTrustForOriginInTransaction(tx, {
    ...input,
    source: "ADMIN_CREATED",
  });
}

export type OperationalEmailInviteActivationResult =
  | {
      kind: "PROMOTED";
      trust: OperationalEmailTrustWriteResult;
    }
  | {
      kind: "NOT_PROMOTED";
      reason: "INVITED_EMAIL_MISSING_OR_MISMATCH" | "USER_UNAVAILABLE";
    };

/**
 * A ativação canônica do convite só é prova do endereço se o hash de e-mail
 * gravado no convite ainda corresponde ao e-mail atual, bloqueado, da conta.
 * Um convite antigo continua podendo conceder acesso à escala, mas jamais
 * converte divergência de endereço em confiança de e-mail operacional.
 */
export async function trustOperationalEmailFromActivatedInvite(
  store: OperationalEmailTrustStore,
  input: { userId: number; expectedEmailHash: string | null; now?: Date },
): Promise<OperationalEmailInviteActivationResult> {
  const now = input.now ?? new Date();
  const reconciled = await reconcileCurrentEmailTrust(store, {
    userId: input.userId,
    now,
  });
  if (!reconciled.user || reconciled.user.deletedAt) {
    return { kind: "NOT_PROMOTED", reason: "USER_UNAVAILABLE" };
  }
  if (
    !reconciled.emailHash ||
    !isOperationalEmailHash(input.expectedEmailHash) ||
    reconciled.emailHash !== input.expectedEmailHash
  ) {
    return {
      kind: "NOT_PROMOTED",
      reason: "INVITED_EMAIL_MISSING_OR_MISMATCH",
    };
  }
  return {
    kind: "PROMOTED",
    trust: await recordOperationalEmailTrustForOrigin(store, {
      userId: input.userId,
      source: "INVITE_ACTIVATED",
      now,
    }),
  };
}

export async function trustOperationalEmailFromActivatedInviteInTransaction(
  tx: OperationalEmailTrustTx,
  input: { userId: number; expectedEmailHash: string | null; now?: Date },
): Promise<OperationalEmailInviteActivationResult> {
  return trustOperationalEmailFromActivatedInvite(
    createOperationalEmailTrustStore(tx),
    input,
  );
}

/** Autocadastro e conta legada ficam pendentes até uma prova posterior. */
export async function markOperationalEmailTrustPendingForSelfSignup(
  store: OperationalEmailTrustStore,
  input: { userId: number; now?: Date },
): Promise<OperationalEmailTrustWriteResult> {
  return recordOperationalEmailTrustForOrigin(store, {
    ...input,
    source: "LEGACY",
  });
}

export async function markOperationalEmailTrustPendingForSelfSignupInTransaction(
  tx: OperationalEmailTrustTx,
  input: { userId: number; now?: Date },
): Promise<OperationalEmailTrustWriteResult> {
  return recordOperationalEmailTrustForOriginInTransaction(tx, {
    ...input,
    source: "LEGACY",
  });
}

/**
 * Deve ser chamado no mesmo commit da mudança efetiva de users.email (ou do
 * soft-delete). Não concede confiança ao novo e-mail: apenas revoga a antiga
 * e inutiliza todos os tokens pendentes.
 */
export async function invalidateOperationalEmailTrustAfterEmailChange(
  store: OperationalEmailTrustStore,
  input: { userId: number; now?: Date },
): Promise<{ invalidated: boolean }> {
  assertPositiveId(input.userId, "userId");
  const now = input.now ?? new Date();
  const user = await store.lockUser(input.userId);
  if (!user) {
    throw new OperationalEmailTrustError(
      "USER_UNAVAILABLE",
      "Conta indisponível para e-mail operacional",
    );
  }
  const trust = await store.lockTrust(input.userId);
  if (trust && trust.state !== "REVOKED") {
    await store.saveTrust({
      existing: trust,
      userId: input.userId,
      emailHash: trust.emailHash,
      state: "REVOKED",
      source: trust.source,
      trustedAt: trust.trustedAt,
      invalidatedAt: now,
    });
  }
  await store.invalidateUnusedTokens(input.userId, now);
  return { invalidated: Boolean(trust && trust.state !== "REVOKED") };
}

export async function invalidateOperationalEmailTrustAfterEmailChangeInTransaction(
  tx: OperationalEmailTrustTx,
  input: { userId: number; now?: Date },
): Promise<{ invalidated: boolean }> {
  return invalidateOperationalEmailTrustAfterEmailChange(
    createOperationalEmailTrustStore(tx),
    input,
  );
}

/**
 * Reconciliador defensivo para o worker futuro: mesmo que uma escrita legada
 * tenha escapado da porta canônica, divergência de hash jamais é tratada como
 * elegível e a confiança pendente é revogada na transação de checagem.
 */
async function reconcileCurrentEmailTrust(
  store: OperationalEmailTrustStore,
  input: { userId: number; now: Date; lockedUser?: OperationalEmailUser | null },
): Promise<{
  user: OperationalEmailUser | null;
  emailHash: string | null;
  trust: StoredOperationalEmailTrust | null;
  changed: boolean;
}> {
  assertPositiveId(input.userId, "userId");
  const user = input.lockedUser ?? (await store.lockUser(input.userId));
  const emailHash =
    user && !user.deletedAt
      ? normalizeOperationalEmailHashOrNull(user.email)
      : null;
  if (!user || user.deletedAt || !emailHash) {
    const trust = await store.lockTrust(input.userId);
    if (trust && trust.state !== "REVOKED") {
      await store.saveTrust({
        existing: trust,
        userId: input.userId,
        emailHash: trust.emailHash,
        state: "REVOKED",
        source: trust.source,
        trustedAt: trust.trustedAt,
        invalidatedAt: input.now,
      });
      await store.invalidateUnusedTokens(input.userId, input.now);
      return { user, emailHash: null, trust, changed: true };
    }
    return { user, emailHash: null, trust, changed: false };
  }

  const trust = await store.lockTrust(input.userId);
  if (trust && trust.emailHash !== emailHash && trust.state !== "REVOKED") {
    await store.saveTrust({
      existing: trust,
      userId: input.userId,
      emailHash: trust.emailHash,
      state: "REVOKED",
      source: trust.source,
      trustedAt: trust.trustedAt,
      invalidatedAt: input.now,
    });
    await store.invalidateUnusedTokens(input.userId, input.now);
    return { user, emailHash, trust, changed: true };
  }
  return { user, emailHash, trust, changed: false };
}

/**
 * Emite no máximo um token vigente por usuário. O token puro é retornado
 * somente ao adaptador interno que futuramente montará o e-mail; esta frente
 * não tem endpoint ou provider e portanto não o registra nem o transmite.
 */
export async function issueOperationalEmailVerificationToken(
  store: OperationalEmailTrustStore,
  input: { userId: number; now?: Date; ttlMs?: number },
): Promise<OperationalEmailVerificationIssueResult> {
  assertPositiveId(input.userId, "userId");
  const now = input.now ?? new Date();
  const ttlMs = input.ttlMs ?? OPERATIONAL_EMAIL_VERIFICATION_TTL_MS;
  if (
    !Number.isSafeInteger(ttlMs) ||
    ttlMs <= 0 ||
    ttlMs > 24 * 60 * 60 * 1000
  ) {
    throw new OperationalEmailTrustError(
      "INVALID_INPUT",
      "TTL de confirmação de e-mail operacional inválido",
    );
  }
  const reconciled = await reconcileCurrentEmailTrust(store, {
    userId: input.userId,
    now,
  });
  if (!reconciled.user || reconciled.user.deletedAt) {
    throw new OperationalEmailTrustError(
      "USER_UNAVAILABLE",
      "Conta indisponível para e-mail operacional",
    );
  }
  if (!reconciled.emailHash) {
    throw new OperationalEmailTrustError(
      "USER_EMAIL_UNAVAILABLE",
      "Conta sem e-mail operacional utilizável",
    );
  }
  if (hasCurrentTrustedEmail(reconciled.trust, reconciled.emailHash)) {
    return { kind: "ALREADY_TRUSTED" };
  }

  const existing = reconciled.trust;
  await store.saveTrust({
    existing,
    userId: input.userId,
    emailHash: reconciled.emailHash,
    state: "PENDING",
    source: "LEGACY",
    trustedAt: null,
    invalidatedAt: null,
  });
  await store.invalidateUnusedTokens(input.userId, now);

  const token = generateOperationalEmailVerificationToken();
  const expiresAt = new Date(now.getTime() + ttlMs);
  await store.createVerificationToken({
    userId: input.userId,
    emailHash: reconciled.emailHash,
    tokenHash: hashOperationalEmailVerificationToken(token),
    expiresAt,
  });
  return { kind: "ISSUED", token, expiresAt };
}

export async function issueOperationalEmailVerificationTokenInTransaction(
  tx: OperationalEmailTrustTx,
  input: { userId: number; now?: Date; ttlMs?: number },
): Promise<OperationalEmailVerificationIssueResult> {
  return issueOperationalEmailVerificationToken(
    createOperationalEmailTrustStore(tx),
    input,
  );
}

function isIdempotentlyConsumedTrust(
  trust: StoredOperationalEmailTrust | null,
  emailHash: string,
): boolean {
  return (
    trust?.state === "TRUSTED" &&
    trust.source === "USER_CONFIRMED" &&
    trust.emailHash === emailHash
  );
}

/**
 * Consumo é serializado por usuário antes de bloquear o token. O primeiro
 * consumidor grava used_at e TRUSTED; um retry concorrente só recebe sucesso
 * idempotente se reencontrar exatamente a mesma prova final.
 */
export async function consumeOperationalEmailVerificationToken(
  store: OperationalEmailTrustStore,
  input: { token: string; now?: Date },
): Promise<OperationalEmailVerificationConsumeResult> {
  const now = input.now ?? new Date();
  let tokenHash: string;
  try {
    tokenHash = hashOperationalEmailVerificationToken(input.token);
  } catch (error) {
    if (error instanceof OperationalEmailTrustError) {
      return { kind: "INVALID_OR_EXPIRED" };
    }
    throw error;
  }
  const preliminary = await store.findTokenByHash(tokenHash);
  if (!preliminary) return { kind: "INVALID_OR_EXPIRED" };

  const user = await store.lockUser(preliminary.userId);
  if (!user || user.deletedAt || !user.email) {
    return { kind: "INVALID_OR_EXPIRED" };
  }
  const currentEmailHash = normalizeOperationalEmailHashOrNull(user.email);
  if (!currentEmailHash) return { kind: "INVALID_OR_EXPIRED" };
  const token = await store.lockTokenByHash(tokenHash);
  if (!token || token.userId !== user.id) {
    return { kind: "INVALID_OR_EXPIRED" };
  }
  const trust = await store.lockTrust(user.id);

  if (token.emailHash !== currentEmailHash) {
    if (trust && trust.state !== "REVOKED") {
      await store.saveTrust({
        existing: trust,
        userId: user.id,
        emailHash: trust.emailHash,
        state: "REVOKED",
        source: trust.source,
        trustedAt: trust.trustedAt,
        invalidatedAt: now,
      });
    }
    await store.invalidateUnusedTokens(user.id, now);
    return { kind: "INVALID_OR_EXPIRED" };
  }
  if (token.expiresAt.getTime() <= now.getTime()) {
    return { kind: "INVALID_OR_EXPIRED" };
  }
  if (token.usedAt) {
    return isIdempotentlyConsumedTrust(trust, currentEmailHash)
      ? { kind: "ALREADY_CONSUMED" }
      : { kind: "INVALID_OR_EXPIRED" };
  }
  const consumed = await store.markTokenUsedIfUsable({
    tokenId: token.id,
    now,
  });
  if (!consumed) {
    // Em uma segunda transação, a linha usada é relida depois do lock do
    // usuário. Só tratamos como idempotente se a prova final já foi gravada;
    // uma falha/interrupção entre etapas jamais vira sucesso por inferência.
    const currentToken = await store.lockTokenByHash(tokenHash);
    const currentTrust = await store.lockTrust(user.id);
    return currentToken?.usedAt &&
      isIdempotentlyConsumedTrust(currentTrust, currentEmailHash)
      ? { kind: "ALREADY_CONSUMED" }
      : { kind: "INVALID_OR_EXPIRED" };
  }

  await store.saveTrust({
    existing: trust,
    userId: user.id,
    emailHash: currentEmailHash,
    state: "TRUSTED",
    source: "USER_CONFIRMED",
    trustedAt: now,
    invalidatedAt: null,
  });
  await store.invalidateUnusedTokens(user.id, now);
  return { kind: "CONSUMED" };
}

export async function consumeOperationalEmailVerificationTokenInTransaction(
  tx: OperationalEmailTrustTx,
  input: { token: string; now?: Date },
): Promise<OperationalEmailVerificationConsumeResult> {
  return consumeOperationalEmailVerificationToken(
    createOperationalEmailTrustStore(tx),
    input,
  );
}

/**
 * Esta decisão é exclusiva do canal EMAIL. PUSH permanece elegível conforme
 * sua própria prova de dispositivo e jamais é removido por e-mail pendente.
 */
export async function assessOperationalEmailEligibility(
  store: OperationalEmailTrustStore,
  input: { userId: number; institutionId: number; now?: Date },
): Promise<OperationalEmailEligibility> {
  assertPositiveId(input.userId, "userId");
  assertPositiveId(input.institutionId, "institutionId");
  const now = input.now ?? new Date();
  // A autorização institucional usa a ordem documentada pelo helper antes da
  // confiança de e-mail, evitando ciclo de locks com o resgate de convite.
  const authorization = await lockCanonicalInstitutionAuthorization(store, {
    userId: input.userId,
    institutionId: input.institutionId,
  });
  if (authorization.kind === "INELIGIBLE") {
    return authorization;
  }
  const reconciled = await reconcileCurrentEmailTrust(store, {
    userId: input.userId,
    now,
    lockedUser: authorization.user,
  });
  if (!reconciled.user || reconciled.user.deletedAt) {
    return { kind: "INELIGIBLE", reason: "USER_UNAVAILABLE" };
  }
  if (!reconciled.emailHash) {
    return { kind: "INELIGIBLE", reason: "USER_EMAIL_UNAVAILABLE" };
  }
  if (!reconciled.trust) {
    return { kind: "INELIGIBLE", reason: "NO_TRUST_RECORD" };
  }
  if (reconciled.trust.emailHash !== reconciled.emailHash) {
    return { kind: "INELIGIBLE", reason: "EMAIL_CHANGED" };
  }
  if (reconciled.trust.state === "PENDING") {
    return { kind: "INELIGIBLE", reason: "TRUST_PENDING" };
  }
  if (reconciled.trust.state === "REVOKED") {
    return { kind: "INELIGIBLE", reason: "TRUST_REVOKED" };
  }
  if (reconciled.trust.state !== "TRUSTED") {
    return { kind: "INELIGIBLE", reason: "TRUST_UNKNOWN_STATE" };
  }
  if (!isDeliverableOperationalEmailTrustSource(reconciled.trust.source)) {
    return { kind: "INELIGIBLE", reason: "TRUST_SOURCE_UNVERIFIED" };
  }
  return {
    kind: "ELIGIBLE",
    userId: input.userId,
    institutionId: input.institutionId,
  };
}

export async function assessOperationalEmailEligibilityInTransaction(
  tx: OperationalEmailTrustTx,
  input: { userId: number; institutionId: number; now?: Date },
): Promise<OperationalEmailEligibility> {
  return assessOperationalEmailEligibility(
    createOperationalEmailTrustStore(tx),
    input,
  );
}

/**
 * Aplica a decisão somente ao canal e-mail. Não há booleano global de
 * "destinatário elegível" que outro canal possa interpretar como bloqueado.
 */
export function resolveOperationalDeliveryChannels(input: {
  requestedChannels: readonly OperationalDeliveryChannel[];
  emailEligibility: OperationalEmailEligibility | null;
}): OperationalDeliveryChannelResolution {
  const requested = [...new Set(input.requestedChannels)];
  const eligibleChannels = requested.filter(
    (channel) =>
      channel !== "EMAIL" || input.emailEligibility?.kind === "ELIGIBLE",
  );
  return {
    eligibleChannels,
    emailEligibility: input.emailEligibility,
  };
}

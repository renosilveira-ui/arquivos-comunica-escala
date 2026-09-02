import { Router, type Request, type Response } from "express";
import bcrypt from "bcryptjs";
import { createHash, randomBytes } from "node:crypto";
import { parse as parseCookieHeader } from "cookie";
import { and, asc, desc, eq, gt, inArray, isNull } from "drizzle-orm";
import { getDb, getUserByEmail } from "../db";
import {
  users,
  professionals,
  institutions,
  professionalInstitutions,
  professionalAccess,
  medicalSpecialties,
  passwordResets,
  shiftAssignmentsV2,
  shiftInstances,
  userContactChannels,
  type User,
} from "../../drizzle/schema";
import {
  AuthenticationInfrastructureError,
  sdk,
  sessionFenceSnapshot,
  sessionFenceDigestForValue,
  requestPresentedSessionCredential,
} from "../_core/sdk";
import { COOKIE_NAME, SESSION_FENCE_COOKIE_NAME } from "../../shared/const.js";
import { recordAudit } from "../audit-trail";
import { mailer } from "../mailer";
import {
  resolveClearCookieOptions,
  resolveSetCookieOptions,
} from "../_core/cookie-policy";
import { parseTenantIdHeader } from "../_core/tenant";
import { resolveTrustedPublicBaseUrl } from "../_core/public-url";
import {
  assertExpectedUserConstraint,
  EXPECTED_USER_ID_HEADER,
  ExpectedUserConstraintError,
} from "../_core/expected-user";
import {
  assertSessionInstanceConstraint,
  parseRequestedSessionBindingVersion,
  resolveSessionBindingVersionForRotation,
  SESSION_BINDING_VERSION,
  SESSION_INSTANCE_HEADER,
  SESSION_PROTOCOL_HEADER,
  sessionBindingCapabilityState,
  SessionBindingProtocolError,
  sessionBindingState,
  sessionInstanceProof,
  SessionInstanceConstraintError,
  type SessionBindingVersion,
} from "../_core/session-instance";
import { ENV } from "../_core/env";
import {
  PUSH_ACCOUNT_MUTATION_LOCK_TIMEOUT_SEC,
  revokeUserPushRegistrations,
  withPushAccountMutex,
} from "../push-registration-revocation";
import {
  parseMedicalQualification,
  type CanonicalMedicalQualification,
} from "../medical-qualification";
import {
  parseScheduleContextIds,
  resolveScheduleContextAclSelection,
  scheduleContextsToSpecificAccessTargets,
  ScheduleContextAclError,
} from "../schedule-contexts";
import { parseManagerScopes } from "../../lib/manager-scope-admin";
import {
  ManagerScopeAdminError,
  replaceManagerScopesForProfessional,
  resolveManagerScopesForRole,
} from "../manager-scope-write";
import {
  parseInviteCode,
  declineScheduleInviteInTransaction,
  redeemScheduleInviteInTransaction,
  ScheduleInviteError,
} from "../schedule-invites";
import {
  enqueueScheduleInviteAcceptedSignal,
  enqueueScheduleInviteDeclinedSignal,
} from "../schedule-invite-response-signal";

type UserRole = "admin" | "manager" | "doctor" | "nurse" | "tech";
type ProfessionalRole = "doctor" | "nurse" | "tech";
type InstitutionRole = "USER" | "GESTOR_MEDICO" | "GESTOR_PLUS";

const VALID_LEGACY_ROLES: readonly UserRole[] = [
  "admin",
  "manager",
  "doctor",
  "nurse",
  "tech",
];
const VALID_PROFESSIONAL_ROLES: readonly ProfessionalRole[] = [
  "doctor",
  "nurse",
  "tech",
];
const VALID_INSTITUTION_ROLES: readonly InstitutionRole[] = [
  "USER",
  "GESTOR_MEDICO",
  "GESTOR_PLUS",
];

function mapRoleToLabel(role: UserRole): string {
  const labels: Record<UserRole, string> = {
    admin: "Administrador",
    manager: "Gestor",
    doctor: "Médico",
    nurse: "Enfermeiro",
    tech: "Técnico de Enfermagem",
  };
  return labels[role];
}

function mapProfessionalRoleToLabel(role: ProfessionalRole): string {
  return mapRoleToLabel(role);
}

export const authRouter = Router();

const BCRYPT_ROUNDS = 12;
const EMAIL_ALREADY_REGISTERED =
  "Este e-mail já tem conta. Entre ou use Esqueci minha senha.";

function sendNeutralSignupAccepted(
  res: Response,
  hasInstitution: boolean,
): void {
  // Anti-enumeração: mesma forma para cadastro novo e e-mail já existente.
  res.status(201).json({
    ok: true,
    pending: hasInstitution,
    awaitingScale: !hasInstitution,
  });
}

function hasUsablePasswordHash(hash: string | null | undefined): boolean {
  return typeof hash === "string" && hash.startsWith("$2") && hash.length >= 50;
}

function sendSessionBindingProtocolError(
  res: Response,
  error: SessionBindingProtocolError,
): void {
  res.status(error.status).json({ error: error.message, code: error.code });
}

function sendAuthenticationInfrastructureError(
  res: Response,
  error: unknown,
): boolean {
  if (!(error instanceof AuthenticationInfrastructureError)) return false;
  res.status(error.status).json({
    error: "Infraestrutura de autenticação indisponível",
    code: error.code,
  });
  return true;
}

function sendUnauthenticated(req: Request, res: Response): void {
  res.status(401).json({
    error: "Não autenticado",
    credentialPresented: requestPresentedSessionCredential(req),
  });
}

type LogoutRevocationProof = "ROTATED" | "ALREADY_INVALID";

function sendLogoutRevocationProof(
  req: Request,
  res: Response,
  proof: LogoutRevocationProof,
  revocationUserId: number | null,
): void {
  clearBrowserSession(req, res);
  res.json({
    ok: true,
    sessionFenceRotated: true,
    revocation: proof,
    ...(revocationUserId === null ? {} : { revocationUserId }),
  });
}

function rotateBrowserSessionFence(req: Request, res: Response): string {
  const { domain: _configuredDomain, ...hostOnlyOptions } =
    resolveSetCookieOptions(req);
  const nextValue = randomBytes(32).toString("base64url");
  res.cookie(SESSION_FENCE_COOKIE_NAME, nextValue, hostOnlyOptions);
  return nextValue;
}

function restoreBrowserSessionFence(
  req: Request,
  res: Response,
  previousValue: string | undefined,
): void {
  const { domain: _configuredDomain, ...hostOnlySetOptions } =
    resolveSetCookieOptions(req);
  const { maxAge: _configuredMaxAge, ...hostOnlyClearOptions } =
    hostOnlySetOptions;
  if (previousValue === undefined) {
    res.clearCookie(SESSION_FENCE_COOKIE_NAME, hostOnlyClearOptions);
    return;
  }
  res.cookie(SESSION_FENCE_COOKIE_NAME, previousValue, hostOnlySetOptions);
}

function clearBrowserSession(req: Request, res: Response): void {
  res.clearCookie(COOKIE_NAME, resolveClearCookieOptions({ req }));
  // Invalida também cookies emitidos antes da migração same-origin.
  const isSecure =
    req.protocol === "https" ||
    String(req.headers["x-forwarded-proto"] ?? "").includes("https") ||
    process.env.NODE_ENV === "production";
  res.clearCookie(COOKIE_NAME, {
    httpOnly: true,
    secure: isSecure,
    sameSite: "none",
    path: "/",
  });
}

class AuthMutationError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 409,
    message: string,
  ) {
    super(message);
  }
}

/** Signup com e-mail já cadastrado — resposta neutra fora da transação. */
class SignupDuplicateEmailError extends Error {
  constructor(readonly hasInstitution: boolean) {
    super("signup_duplicate_email");
    this.name = "SignupDuplicateEmailError";
  }
}

function affectedRows(result: unknown): number {
  if (Array.isArray(result)) {
    const header = result[0] as { affectedRows?: unknown } | undefined;
    return Number(header?.affectedRows ?? 0);
  }
  return Number(
    (result as { affectedRows?: unknown } | null)?.affectedRows ?? 0,
  );
}

function auditActorName(name: string | null | undefined): string | undefined {
  const normalized = String(name ?? "").trim();
  return normalized ? normalized.slice(0, 255) : undefined;
}

function resolveProfessionalName(user: User): string {
  const explicitName = String(user.name ?? "").trim();
  if (explicitName) return explicitName;
  const email = String(user.email ?? "").trim();
  if (email.includes("@")) return email.split("@")[0]!;
  return `Usuário ${user.id}`;
}

async function handleSsoExchange(_req: Request, res: Response): Promise<void> {
  res.status(301).json({
    error:
      "Endpoint migrado. Use POST /api/sso/generate para gerar handoff token.",
    redirect: "/api/sso/generate",
  });
}

// GET /api/auth/session-binding-capability
//
// Preflight público e sem estado. O cliente exact-v1 chama este endpoint antes
// de qualquer POST de sessão; `supported:false` é bloqueante para o cliente
// exact-v1, enquanto clientes antigos continuam no contrato legacy.
authRouter.get(
  "/session-binding-capability",
  (_req: Request, res: Response): void => {
    res.setHeader("Cache-Control", "no-store");
    res.json(sessionBindingCapabilityState(ENV.sessionExactBindingSupported));
  },
);

// POST /api/auth/login
authRouter.post(
  "/login",
  async (req: Request, res: Response): Promise<void> => {
    let sessionBindingVersion: SessionBindingVersion | null;
    try {
      sessionBindingVersion = parseRequestedSessionBindingVersion(
        req.headers[SESSION_PROTOCOL_HEADER],
        ENV.sessionExactBindingSupported,
      );
    } catch (error) {
      if (error instanceof SessionBindingProtocolError) {
        sendSessionBindingProtocolError(res, error);
        return;
      }
      throw error;
    }
    const { email, password: rawPassword } = req.body as {
      email?: unknown;
      password?: unknown;
    };
    const password =
      typeof rawPassword === "string" ? rawPassword.trim() : rawPassword;

    if (
      typeof email !== "string" ||
      typeof password !== "string" ||
      !email ||
      !password
    ) {
      res.status(400).json({ error: "email e password são obrigatórios" });
      return;
    }

    const user = await getUserByEmail(email.toLowerCase().trim());

    // Conta excluída (soft-delete) responde igual a credencial inválida —
    // não revela que o e-mail já existiu.
    if (!user || !user.passwordHash || user.deletedAt) {
      res.status(401).json({ error: "Credenciais inválidas" });
      return;
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      res.status(401).json({ error: "Credenciais inválidas" });
      return;
    }

    const db = await getDb();
    if (!db) {
      res.status(503).json({ error: "Banco de dados indisponível" });
      return;
    }

    // Login gira sessionVersion. O mesmo commit precisa revogar os tokens Expo
    // da geração anterior, caso contrário uma fotografia de badge poderia
    // alcançar um aparelho cuja sessão já perdeu autoridade. O mutex é o
    // mesmo de registro/submissão push: user → push_tokens, sem egress entre
    // a revogação e a emissão do novo JWT.
    let freshUser: {
      id: number;
      name: string | null;
      email: string | null;
      role: User["role"];
      approvalStatus: User["approvalStatus"];
      mustChangePassword: boolean;
      sessionVersion: number;
    } | null;
    try {
      freshUser = await withPushAccountMutex(
        db,
        user.id,
        PUSH_ACCOUNT_MUTATION_LOCK_TIMEOUT_SEC,
        (connectionDb) =>
          connectionDb.transaction(
            async (tx) => {
              const [lockedUser] = await tx
                .select({
                  id: users.id,
                  name: users.name,
                  email: users.email,
                  role: users.role,
                  approvalStatus: users.approvalStatus,
                  mustChangePassword: users.mustChangePassword,
                  passwordHash: users.passwordHash,
                  sessionVersion: users.sessionVersion,
                  deletedAt: users.deletedAt,
                })
                .from(users)
                .where(eq(users.id, user.id))
                .limit(1)
                .for("update");
              // A senha foi verificada antes do lock. Se ela mudou enquanto
              // bcrypt trabalhava, esta tentativa antiga não pode criar uma
              // sessão nova nem revogar o aparelho da sessão válida.
              if (
                !lockedUser ||
                lockedUser.deletedAt ||
                !lockedUser.passwordHash ||
                lockedUser.passwordHash !== user.passwordHash
              ) {
                return null;
              }

              const nextSessionVersion = lockedUser.sessionVersion + 1;
              const updateResult = await tx
                .update(users)
                .set({ sessionVersion: nextSessionVersion })
                .where(
                  and(
                    eq(users.id, lockedUser.id),
                    eq(users.sessionVersion, lockedUser.sessionVersion),
                    eq(users.passwordHash, lockedUser.passwordHash),
                    isNull(users.deletedAt),
                  ),
                );
              if (affectedRows(updateResult) !== 1) {
                throw new Error("Concorrência inesperada ao iniciar sessão");
              }

              await revokeUserPushRegistrations(tx, lockedUser.id);
              return {
                id: lockedUser.id,
                name: lockedUser.name,
                email: lockedUser.email,
                role: lockedUser.role,
                approvalStatus: lockedUser.approvalStatus,
                mustChangePassword: lockedUser.mustChangePassword,
                sessionVersion: nextSessionVersion,
              };
            },
            { isolationLevel: "read committed" },
          ),
      );
    } catch {
      // O commit é fail-closed: se a revogação do destino push não for
      // confirmada, não existe novo JWT que possa disparar egress posterior.
      console.error("[login] SESSION_ROTATION_FAILED");
      res.status(503).json({ error: "Não foi possível iniciar sessão. Tente novamente." });
      return;
    }
    if (!freshUser) {
      res.status(401).json({ error: "Credenciais inválidas" });
      return;
    }

    // O fence só é emitido após a rotação transacional ter sido confirmada.
    const loginFenceValue = rotateBrowserSessionFence(req, res);
    const loginFence = sessionFenceDigestForValue(loginFenceValue);

    const token = await sdk.createSessionToken(String(freshUser.id), {
      name: freshUser.name ?? "",
      sessionVersion: freshUser.sessionVersion,
      sessionFenceDigest: loginFence.digest,
      sessionBindingVersion: sessionBindingVersion ?? undefined,
    });
    res.cookie(COOKIE_NAME, token, resolveSetCookieOptions(req));
    res.json({
      user: {
        id: freshUser.id,
        name: freshUser.name,
        email: freshUser.email,
        role: freshUser.role,
        approvalStatus: freshUser.approvalStatus,
        mustChangePassword: freshUser.mustChangePassword,
      },
      token,
      ...(sessionBindingVersion === SESSION_BINDING_VERSION
        ? {
            sessionInstance: sessionInstanceProof(token),
            sessionBinding: sessionBindingState(
              ENV.sessionExactBindingSupported,
              sessionBindingVersion,
            ),
          }
        : {}),
    });
  },
);

// POST /api/auth/ssoExchange (camelCase alias)
authRouter.post("/ssoExchange", handleSsoExchange);
// POST /api/auth/sso-exchange (kebab-case canonical)
authRouter.post("/sso-exchange", handleSsoExchange);

// POST /api/auth/change-password
//
// Permite que um usuário autenticado troque a própria senha.
// Requer:
//   - sessão válida (cookie session)
//   - currentPassword para evitar token-stealing → password change
//   - newPassword com regras mínimas (≥8 chars, distinto da atual)
//
// Hash, rotação de sessão e auditoria são um único commit. A sessão atual
// recebe JWT novo; todas as demais ficam inválidas.
authRouter.post(
  "/change-password",
  async (req: Request, res: Response): Promise<void> => {
    const requestFence = sessionFenceSnapshot(req);
    let authUser: User;
    try {
      authUser = await sdk.authenticateRequest(req, {
        allowMustChangePassword: true,
      });
    } catch (error) {
      if (sendAuthenticationInfrastructureError(res, error)) return;
      if (
        error instanceof ExpectedUserConstraintError ||
        error instanceof SessionInstanceConstraintError
      ) {
        res
          .status(error.status)
          .json({ error: error.message, code: error.code });
        return;
      }
      res.status(401).json({ error: "Não autenticado" });
      return;
    }

    let nextSessionBindingVersion: SessionBindingVersion | null;
    try {
      nextSessionBindingVersion = resolveSessionBindingVersionForRotation(
        req.headers[SESSION_PROTOCOL_HEADER],
        ENV.sessionExactBindingSupported,
        sdk.sessionBindingVersionForAuthenticatedRequest(req),
      );
    } catch (error) {
      if (error instanceof SessionBindingProtocolError) {
        sendSessionBindingProtocolError(res, error);
        return;
      }
      throw error;
    }

    const { currentPassword, newPassword } = req.body as {
      currentPassword?: unknown;
      newPassword?: unknown;
    };

    if (
      typeof currentPassword !== "string" ||
      typeof newPassword !== "string" ||
      !currentPassword ||
      !newPassword
    ) {
      res
        .status(400)
        .json({ error: "currentPassword e newPassword são obrigatórios" });
      return;
    }
    if (
      currentPassword.length > 128 ||
      newPassword.length < 8 ||
      newPassword.length > 128
    ) {
      res
        .status(400)
        .json({ error: "Nova senha precisa ter entre 8 e 128 caracteres" });
      return;
    }

    if (newPassword === currentPassword) {
      res
        .status(400)
        .json({ error: "Nova senha precisa ser diferente da atual" });
      return;
    }

    const db = await getDb();
    if (!db) {
      res.status(500).json({ error: "Database not available" });
      return;
    }

    if (!authUser.passwordHash) {
      res.status(401).json({ error: "Conta sem senha definida" });
      return;
    }

    const valid = await bcrypt.compare(currentPassword, authUser.passwordHash);
    if (!valid) {
      res.status(401).json({ error: "Senha atual incorreta" });
      return;
    }

    const auditMembership = await readCanonicalAuditMembership(db, authUser.id);
    if (!auditMembership) {
      res.status(409).json({
        error:
          "Conta sem vínculo institucional canônico ativo; procure um administrador",
      });
      return;
    }

    const newHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);

    try {
      const committed = await withPushAccountMutex(
        db,
        authUser.id,
        PUSH_ACCOUNT_MUTATION_LOCK_TIMEOUT_SEC,
        (connectionDb) =>
          connectionDb.transaction(async (tx) => {
            const [lockedUser] = await tx
              .select()
              .from(users)
              .where(eq(users.id, authUser.id))
              .limit(1)
              .for("update");
            if (
              !lockedUser ||
              lockedUser.deletedAt ||
              !lockedUser.passwordHash
            ) {
              throw new AuthMutationError(401, "Conta sem senha definida");
            }
            if (
              lockedUser.sessionVersion !== authUser.sessionVersion ||
              lockedUser.passwordHash !== authUser.passwordHash
            ) {
              throw new AuthMutationError(
                409,
                "A credencial mudou durante a operação. Entre novamente e repita.",
              );
            }

            const lockedAuditMembership = await lockCanonicalAuditMembership(
              tx,
              lockedUser.id,
              auditMembership,
            );

            const nextSessionVersion = lockedUser.sessionVersion + 1;
            const updateResult = await tx
              .update(users)
              .set({
                passwordHash: newHash,
                mustChangePassword: false,
                sessionVersion: nextSessionVersion,
              })
              .where(
                and(
                  eq(users.id, lockedUser.id),
                  eq(users.sessionVersion, lockedUser.sessionVersion),
                  eq(users.passwordHash, lockedUser.passwordHash),
                  isNull(users.deletedAt),
                ),
              );
            if (affectedRows(updateResult) !== 1) {
              throw new AuthMutationError(
                409,
                "A credencial mudou durante a operação",
              );
            }

            const revokedPushTokenCount = await revokeUserPushRegistrations(
              tx,
              lockedUser.id,
            );

            const resetInvalidation = await tx
              .delete(passwordResets)
              .where(eq(passwordResets.userId, lockedUser.id));

            await recordAudit(
              {
                actorUserId: lockedUser.id,
                actorRole: lockedUser.role,
                actorName: auditActorName(lockedUser.name),
                action: "USER_UPDATED",
                entityType: "USER",
                entityId: lockedUser.id,
                description: "Senha alterada pelo próprio usuário",
                institutionId: lockedAuditMembership.institutionId,
                metadata: {
                  sessionVersionBefore: lockedUser.sessionVersion,
                  sessionVersionAfter: nextSessionVersion,
                  revokedPushTokenCount,
                  invalidatedPasswordResetCount:
                    affectedRows(resetInvalidation),
                },
              },
              { db: tx, strict: true },
            );
            return {
              id: lockedUser.id,
              name: lockedUser.name,
              sessionVersion: nextSessionVersion,
            };
          }),
      );

      const refreshedToken = await sdk.createSessionToken(
        String(committed.id),
        {
          name: committed.name ?? "",
          sessionVersion: committed.sessionVersion,
          sessionFenceDigest: requestFence.digest,
          sessionBindingVersion: nextSessionBindingVersion ?? undefined,
        },
      );
      res.cookie(COOKIE_NAME, refreshedToken, resolveSetCookieOptions(req));
      res.json({
        ok: true,
        token: refreshedToken,
        ...(nextSessionBindingVersion === SESSION_BINDING_VERSION
          ? {
              sessionInstance: sessionInstanceProof(refreshedToken),
              sessionBinding: sessionBindingState(
                ENV.sessionExactBindingSupported,
                nextSessionBindingVersion,
              ),
            }
          : {}),
      });
    } catch (error) {
      if (error instanceof AuthMutationError) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      console.error("[change-password] Falha transacional", String(error));
      res.status(500).json({ error: "Falha ao alterar senha" });
    }
  },
);

// ---------------------------------------------------------------------------
// Esqueci minha senha (frente A3)
//
// POST /forgot-password {email} → sempre 200 (sem enumeração de contas).
// Se o e-mail existir, estiver ativo (não excluído) e tiver senha, gera
// token aleatório (32 bytes), grava só o sha256 com TTL de 30 min e envia
// o link por e-mail (server/mailer.ts — loga no console sem RESEND_API_KEY).
//
// POST /reset-password {token, newPassword} → uso único por CAS, revoga
// todos os links irmãos e todas as sessões anteriores no mesmo commit.
// ---------------------------------------------------------------------------

const RESET_TOKEN_TTL_MS = 30 * 60 * 1000;
const FORGOT_RATE_LIMIT_MAX = 3;
const FORGOT_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;

/** Rate-limit em memória: 3 pedidos por e-mail por hora. */
const forgotAttemptsByEmail = new Map<string, number[]>();

function isForgotRateLimited(email: string, now = Date.now()): boolean {
  const recent = (forgotAttemptsByEmail.get(email) ?? []).filter(
    (ts) => now - ts < FORGOT_RATE_LIMIT_WINDOW_MS,
  );
  if (recent.length >= FORGOT_RATE_LIMIT_MAX) {
    forgotAttemptsByEmail.set(email, recent);
    return true;
  }
  recent.push(now);
  forgotAttemptsByEmail.set(email, recent);
  // Poda oportunista para o Map não crescer indefinidamente.
  if (forgotAttemptsByEmail.size > 5000) {
    for (const [key, stamps] of forgotAttemptsByEmail) {
      if (!stamps.some((ts) => now - ts < FORGOT_RATE_LIMIT_WINDOW_MS)) {
        forgotAttemptsByEmail.delete(key);
      }
    }
  }
  return false;
}

function hashResetToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Marca o token recém-emitido como usado quando o correio não entregou.
 * Guarda por hash + usedAt IS NULL: se o reset venceu a corrida, não reabre.
 * Reusa o `db` do caller (não chama getDb de novo) e devolve se o UPDATE
 * chegou a ser executado — o log não pode afirmar revogação sem isso.
 */
async function revokeFreshPasswordResetToken(
  db: NonNullable<Awaited<ReturnType<typeof getDb>>>,
  userId: number,
  tokenHash: string,
): Promise<boolean> {
  try {
    await db
      .update(passwordResets)
      .set({ usedAt: new Date() })
      .where(
        and(
          eq(passwordResets.userId, userId),
          eq(passwordResets.tokenHash, tokenHash),
          isNull(passwordResets.usedAt),
        ),
      );
    return true;
  } catch {
    return false;
  }
}

type AuditMembershipSnapshot = {
  membershipId: number;
  professionalId: number;
  institutionId: number;
  isPrimary: boolean;
};

type AuthAuditQueryDb = Pick<
  NonNullable<Awaited<ReturnType<typeof getDb>>>,
  "select"
>;

/**
 * Resolve uma topologia canônica. Mutações ordinárias exigem PI ativa;
 * revogação de sessão pode admitir a PI inativa, ainda vinculada de forma
 * inequívoca a user/pro/instituição, para não tornar um Bearer irrevogável.
 */
async function readCanonicalAuditMembership(
  db: AuthAuditQueryDb,
  userId: number,
  options: { allowInactive?: boolean } = {},
): Promise<AuditMembershipSnapshot | null> {
  const [membership] = await db
    .select({
      membershipId: professionalInstitutions.id,
      professionalId: professionals.id,
      institutionId: professionalInstitutions.institutionId,
      isPrimary: professionalInstitutions.isPrimary,
    })
    .from(professionalInstitutions)
    .innerJoin(
      professionals,
      and(
        eq(professionals.id, professionalInstitutions.professionalId),
        eq(professionals.userId, professionalInstitutions.userId),
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
        eq(professionalInstitutions.userId, userId),
        options.allowInactive
          ? undefined
          : eq(professionalInstitutions.active, true),
      ),
    )
    .orderBy(
      desc(professionalInstitutions.active),
      desc(professionalInstitutions.isPrimary),
      asc(professionalInstitutions.id),
    )
    .limit(1);
  return membership ?? null;
}

/** Ordem global de identidade: users (já travado pelo chamador) → pro → PI → instituição. */
async function lockCanonicalAuditMembership(
  db: AuthAuditQueryDb,
  userId: number,
  expected: AuditMembershipSnapshot,
  options: { allowInactive?: boolean } = {},
): Promise<AuditMembershipSnapshot> {
  const [professional] = await db
    .select({ id: professionals.id, userId: professionals.userId })
    .from(professionals)
    .where(eq(professionals.id, expected.professionalId))
    .limit(1)
    .for("update");
  const [membership] = professional
    ? await db
        .select({
          membershipId: professionalInstitutions.id,
          professionalId: professionalInstitutions.professionalId,
          userId: professionalInstitutions.userId,
          institutionId: professionalInstitutions.institutionId,
          isPrimary: professionalInstitutions.isPrimary,
          active: professionalInstitutions.active,
        })
        .from(professionalInstitutions)
        .where(eq(professionalInstitutions.id, expected.membershipId))
        .limit(1)
        .for("update")
    : [];
  const [institution] = membership
    ? await db
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

  if (
    professional?.userId !== userId ||
    !membership ||
    membership.professionalId !== expected.professionalId ||
    membership.userId !== userId ||
    membership.institutionId !== expected.institutionId ||
    membership.isPrimary !== expected.isPrimary ||
    (!options.allowInactive && !membership.active) ||
    !institution
  ) {
    throw new AuthMutationError(
      409,
      "Vínculo institucional canônico mudou durante a operação; tente novamente",
    );
  }

  return expected;
}

authRouter.post(
  "/forgot-password",
  async (req: Request, res: Response): Promise<void> => {
    const { email } = req.body as { email?: unknown };
    if (typeof email !== "string" || !email.trim()) {
      res.status(400).json({ error: "email é obrigatório" });
      return;
    }
    const normalizedEmail = email.toLowerCase().trim();

    // Resposta neutra em TODOS os caminhos abaixo (inclusive rate-limit):
    // quem pede não descobre se a conta existe.
    const neutral = { ok: true };

    const publicBaseUrl = resolveTrustedPublicBaseUrl();
    if (!publicBaseUrl) {
      console.error(
        "[forgot-password] APP_PUBLIC_URL ausente ou inválida; emissão de token bloqueada",
      );
      res.json(neutral);
      return;
    }

    if (isForgotRateLimited(normalizedEmail)) {
      res.json(neutral);
      return;
    }

    const db = await getDb();
    if (!db) {
      res.json(neutral);
      return;
    }

    const user = await getUserByEmail(normalizedEmail);
    if (!user || user.deletedAt || !user.email) {
      res.json(neutral);
      return;
    }

    const auditMembership = await readCanonicalAuditMembership(db, user.id);
    if (!auditMembership) {
      res.json(neutral);
      return;
    }

    const token = randomBytes(32).toString("hex");
    const tokenHash = hashResetToken(token);
    const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS);

    try {
      const delivery = await db.transaction(async (tx) => {
        // Credential mutations use one global order: users → reset tokens.
        const [lockedUser] = await tx
          .select()
          .from(users)
          .where(eq(users.id, user.id))
          .limit(1)
          .for("update");
        if (
          !lockedUser ||
          lockedUser.deletedAt ||
          !lockedUser.email ||
          lockedUser.email !== normalizedEmail ||
          lockedUser.sessionVersion !== user.sessionVersion ||
          lockedUser.passwordHash !== user.passwordHash ||
          lockedUser.approvalStatus !== user.approvalStatus
        ) {
          return null;
        }

        const lockedAuditMembership = await lockCanonicalAuditMembership(
          tx,
          lockedUser.id,
          auditMembership,
        );

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
        await tx.insert(passwordResets).values({
          userId: lockedUser.id,
          tokenHash,
          expiresAt,
        });
        await recordAudit(
          {
            actorUserId: lockedUser.id,
            actorRole: lockedUser.role,
            actorName: auditActorName(lockedUser.name),
            action: "USER_UPDATED",
            entityType: "USER",
            entityId: lockedUser.id,
            description: "Pedido de redefinição de senha (esqueci minha senha)",
            // O entityId já permite correlação; não persiste e-mail bruto no audit trail.
            metadata: { expiresAt: expiresAt.toISOString() },
            institutionId: lockedAuditMembership.institutionId,
          },
          { db: tx, strict: true },
        );
        return {
          email: lockedUser.email!,
          firstName: resolveProfessionalName(lockedUser).split(" ")[0],
        };
      });

      if (delivery) {
        const link = `${publicBaseUrl}/reset-password?token=${token}`;
        let delivered = false;
        try {
          const mailResult = await mailer.sendMail({
            to: delivery.email,
            subject: "Escala+ — redefinir sua senha",
            text: [
              `Olá, ${delivery.firstName}.`,
              "",
              "Recebemos um pedido para redefinir a senha da sua conta no Escala+.",
              "Abra o link abaixo para escolher uma nova senha (válido por 30 minutos):",
              "",
              link,
              "",
              "Se você não pediu isso, ignore este e-mail — sua senha continua a mesma.",
            ].join("\n"),
          });
          delivered = mailResult.delivered;
        } catch {
          // sendMail hoje devolve delivered=false em vez de lançar; se passar
          // a lançar, o token recém-gravado não pode ficar utilizável.
        }
        if (!delivered) {
          const revoked = await revokeFreshPasswordResetToken(
            db,
            user.id,
            tokenHash,
          );
          console.error(
            revoked
              ? "[forgot-password] E-mail não entregue; token recém-emitido revogado"
              : "[forgot-password] E-mail não entregue; revogação do token recém-emitido não confirmada",
          );
        }
      }
    } catch (error) {
      // The public response is deliberately indistinguishable for missing
      // accounts, audit/DB failures and mail transport failures.
      console.error("[forgot-password] Falha interna mascarada", String(error));
    }

    res.json(neutral);
  },
);

authRouter.post(
  "/reset-password",
  async (req: Request, res: Response): Promise<void> => {
    const { token, newPassword } = req.body as {
      token?: unknown;
      newPassword?: unknown;
    };

    if (
      typeof token !== "string" ||
      !token.trim() ||
      typeof newPassword !== "string" ||
      !newPassword
    ) {
      res.status(400).json({ error: "token e newPassword são obrigatórios" });
      return;
    }
    if (newPassword.length < 8 || newPassword.length > 128) {
      res
        .status(400)
        .json({ error: "Nova senha precisa ter entre 8 e 128 caracteres" });
      return;
    }

    const db = await getDb();
    if (!db) {
      res.status(503).json({ error: "Banco de dados indisponível" });
      return;
    }

    const INVALID =
      "Link inválido ou expirado. Peça uma nova redefinição de senha.";

    const tokenHash = hashResetToken(token.trim());
    const [resetCandidate] = await db
      .select({
        id: passwordResets.id,
        userId: passwordResets.userId,
        expiresAt: passwordResets.expiresAt,
        usedAt: passwordResets.usedAt,
      })
      .from(passwordResets)
      .where(eq(passwordResets.tokenHash, tokenHash))
      .orderBy(asc(passwordResets.id))
      .limit(1);

    if (
      !resetCandidate ||
      resetCandidate.usedAt ||
      resetCandidate.expiresAt.getTime() <= Date.now()
    ) {
      res.status(400).json({ error: INVALID });
      return;
    }

    const auditMembership = await readCanonicalAuditMembership(
      db,
      resetCandidate.userId,
    );
    if (!auditMembership) {
      res.status(400).json({ error: INVALID });
      return;
    }

    const newHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);

    try {
      await withPushAccountMutex(
        db,
        resetCandidate.userId,
        PUSH_ACCOUNT_MUTATION_LOCK_TIMEOUT_SEC,
        (connectionDb) =>
          connectionDb.transaction(async (tx) => {
            // User first, token second: same total lock order as forgot/admin reset.
            const [lockedUser] = await tx
              .select()
              .from(users)
              .where(eq(users.id, resetCandidate.userId))
              .limit(1)
              .for("update");
            if (!lockedUser || lockedUser.deletedAt) {
              throw new AuthMutationError(400, INVALID);
            }

            const lockedAuditMembership = await lockCanonicalAuditMembership(
              tx,
              lockedUser.id,
              auditMembership,
            );

            const [lockedReset] = await tx
              .select()
              .from(passwordResets)
              .where(
                and(
                  eq(passwordResets.id, resetCandidate.id),
                  eq(passwordResets.userId, lockedUser.id),
                  eq(passwordResets.tokenHash, tokenHash),
                ),
              )
              .limit(1)
              .for("update");
            const usedAt = new Date();
            if (
              !lockedReset ||
              lockedReset.usedAt ||
              lockedReset.expiresAt.getTime() <= usedAt.getTime()
            ) {
              throw new AuthMutationError(400, INVALID);
            }

            const consumeResult = await tx
              .update(passwordResets)
              .set({ usedAt })
              .where(
                and(
                  eq(passwordResets.id, lockedReset.id),
                  isNull(passwordResets.usedAt),
                  gt(passwordResets.expiresAt, usedAt),
                ),
              );
            if (affectedRows(consumeResult) !== 1) {
              throw new AuthMutationError(400, INVALID);
            }

            const nextSessionVersion = lockedUser.sessionVersion + 1;
            const userUpdate = await tx
              .update(users)
              .set({
                passwordHash: newHash,
                mustChangePassword: false,
                sessionVersion: nextSessionVersion,
              })
              .where(
                and(
                  eq(users.id, lockedUser.id),
                  eq(users.sessionVersion, lockedUser.sessionVersion),
                  isNull(users.deletedAt),
                ),
              );
            if (affectedRows(userUpdate) !== 1) {
              throw new AuthMutationError(
                409,
                "A credencial mudou durante a redefinição",
              );
            }

            const revokedPushTokenCount = await revokeUserPushRegistrations(
              tx,
              lockedUser.id,
            );

            // A successful reset invalidates every outstanding link for this user.
            await tx
              .update(passwordResets)
              .set({ usedAt })
              .where(
                and(
                  eq(passwordResets.userId, lockedUser.id),
                  isNull(passwordResets.usedAt),
                ),
              );
            await recordAudit(
              {
                actorUserId: lockedUser.id,
                actorRole: lockedUser.role,
                actorName: auditActorName(lockedUser.name),
                action: "USER_UPDATED",
                entityType: "USER",
                entityId: lockedUser.id,
                description:
                  "Senha redefinida via link de 'esqueci minha senha'",
                institutionId: lockedAuditMembership.institutionId,
                metadata: {
                  sessionVersionBefore: lockedUser.sessionVersion,
                  sessionVersionAfter: nextSessionVersion,
                  revokedPushTokenCount,
                },
              },
              { db: tx, strict: true },
            );
          }),
      );
      res.json({ ok: true });
    } catch (error) {
      if (error instanceof AuthMutationError) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      console.error("[reset-password] Falha transacional", String(error));
      res.status(500).json({ error: "Falha ao redefinir senha" });
    }
  },
);

// ---------------------------------------------------------------------------
// Exclusão de conta pelo próprio usuário (Apple 5.1.1(v))
//
// DELETE /me {password} → exige a senha correta. Bloqueia (409) se houver
// plantão futuro alocado — o gestor precisa realocar antes. Caso contrário
// faz soft-delete: anonimiza nome/e-mail, marca deleted_at, desativa os
// vínculos institucionais, apaga push tokens e encerra a sessão.
//
// A linha de users permanece (FKs em audit_trail, shift_assignments,
// swap_requests etc.) — apenas anonimizada.
// ---------------------------------------------------------------------------

const FUTURE_SHIFTS_MESSAGE =
  "Você tem plantões futuros alocados ou plantão em andamento — peça ao gestor para realocá-los antes de excluir a conta.";

authRouter.delete("/me", async (req: Request, res: Response): Promise<void> => {
  let authUser: User;
  try {
    authUser = await sdk.authenticateRequest(req);
  } catch (error) {
    if (sendAuthenticationInfrastructureError(res, error)) return;
    if (
      error instanceof ExpectedUserConstraintError ||
      error instanceof SessionInstanceConstraintError
    ) {
      res.status(error.status).json({ error: error.message, code: error.code });
      return;
    }
    res.status(401).json({ error: "Não autenticado" });
    return;
  }

  const { password } = req.body as { password?: unknown };
  if (typeof password !== "string" || !password) {
    res.status(400).json({ error: "password é obrigatório" });
    return;
  }

  const db = await getDb();
  if (!db) {
    res.status(503).json({ error: "Banco de dados indisponível" });
    return;
  }

  if (!authUser.passwordHash) {
    res.status(400).json({ error: "Conta sem senha definida" });
    return;
  }

  const valid = await bcrypt.compare(password, authUser.passwordHash);
  if (!valid) {
    res.status(401).json({ error: "Senha incorreta" });
    return;
  }

  const auditMembershipSnapshot = await readCanonicalAuditMembership(
    db,
    authUser.id,
  );
  if (!auditMembershipSnapshot) {
    res.status(409).json({
      error:
        "Conta sem vínculo institucional canônico ativo; procure um administrador",
    });
    return;
  }

  const professionalSnapshot = await db
    .select({ id: professionals.id, userId: professionals.userId })
    .from(professionals)
    .where(eq(professionals.userId, authUser.id))
    .orderBy(asc(professionals.id));
  const membershipSnapshot = await db
    .select({
      id: professionalInstitutions.id,
      professionalId: professionalInstitutions.professionalId,
      userId: professionalInstitutions.userId,
      institutionId: professionalInstitutions.institutionId,
      roleInInstitution: professionalInstitutions.roleInInstitution,
      active: professionalInstitutions.active,
      isPrimary: professionalInstitutions.isPrimary,
    })
    .from(professionalInstitutions)
    .where(eq(professionalInstitutions.userId, authUser.id))
    .orderBy(asc(professionalInstitutions.id));
  const administeredInstitutionIds = [
    ...new Set(
      membershipSnapshot
        .filter(
          (membership) =>
            membership.active && membership.roleInInstitution === "GESTOR_PLUS",
        )
        .map((membership) => membership.institutionId),
    ),
  ];
  const adminAuthoritySnapshot =
    administeredInstitutionIds.length > 0
      ? await db
          .select({
            userId: users.id,
            professionalId: professionals.id,
            membershipId: professionalInstitutions.id,
            institutionId: professionalInstitutions.institutionId,
          })
          .from(professionalInstitutions)
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
              inArray(
                professionalInstitutions.institutionId,
                administeredInstitutionIds,
              ),
              eq(professionalInstitutions.roleInInstitution, "GESTOR_PLUS"),
              eq(professionalInstitutions.active, true),
            ),
          )
      : [];
  // A superfície HTTP administrativa ainda exige users.role=admin + PI
  // canônica ativa. Enquanto esse contrato legado existir, a exclusão não
  // pode preservar apenas GESTOR_PLUS: precisa manter ao menos um operador
  // global provisionado em cada tenant do admin que sai e no sistema.
  const globalAdminAuthoritySnapshot =
    authUser.role === "admin" && authUser.approvalStatus === "APPROVED"
      ? await db
          .select({
            userId: users.id,
            professionalId: professionals.id,
            membershipId: professionalInstitutions.id,
            institutionId: professionalInstitutions.institutionId,
          })
          .from(professionalInstitutions)
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
              eq(users.role, "admin"),
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
          .where(eq(professionalInstitutions.active, true))
      : [];
  const identityAuthoritySnapshot = [
    ...new Map(
      [...adminAuthoritySnapshot, ...globalAdminAuthoritySnapshot].map(
        (authority) => [authority.membershipId, authority],
      ),
    ).values(),
  ];

  let previousFenceValue: string | undefined;
  try {
    previousFenceValue = req.headers.cookie
      ? parseCookieHeader(req.headers.cookie)[SESSION_FENCE_COOKIE_NAME]
      : undefined;
  } catch {
    previousFenceValue = undefined;
  }
  // Assim como logout/change-password, a exclusão gira o fence antes do
  // commit remoto. Uma resposta anterior não pode reinstalar um cookie que a
  // transação abaixo revogou; falhas precommit restauram o valor observado.
  rotateBrowserSessionFence(req, res);

  try {
    await withPushAccountMutex(
      db,
      authUser.id,
      PUSH_ACCOUNT_MUTATION_LOCK_TIMEOUT_SEC,
      (connectionDb) =>
        connectionDb.transaction(
          async (tx) => {
            // Global identity order: every relevant user by id, then every
            // professional by id, then every membership by id. Locking the whole
            // canonical admin set also serializes concurrent last-admin deletes.
            const lockedUsers = new Map<number, User>();
            const identityUserIds = [
              ...new Set([
                authUser.id,
                ...identityAuthoritySnapshot.map(
                  (authority) => authority.userId,
                ),
              ]),
            ].sort((left, right) => left - right);
            for (const userId of identityUserIds) {
              const [user] = await tx
                .select()
                .from(users)
                .where(eq(users.id, userId))
                .limit(1)
                .for("update");
              if (user) lockedUsers.set(user.id, user);
            }
            const lockedUser = lockedUsers.get(authUser.id);
            if (
              !lockedUser ||
              lockedUser.deletedAt ||
              !lockedUser.passwordHash
            ) {
              throw new AuthMutationError(401, "Não autenticado");
            }
            if (
              lockedUser.sessionVersion !== authUser.sessionVersion ||
              lockedUser.passwordHash !== authUser.passwordHash ||
              lockedUser.role !== authUser.role ||
              lockedUser.approvalStatus !== authUser.approvalStatus
            ) {
              throw new AuthMutationError(
                409,
                "A conta mudou durante a exclusão. Entre novamente e repita.",
              );
            }

            const lockedProfessionals = new Map<
              number,
              { id: number; userId: number }
            >();
            const expectedProfessionalIds = professionalSnapshot.map(
              (row) => row.id,
            );
            const identityProfessionalIds = [
              ...new Set([
                ...expectedProfessionalIds,
                ...identityAuthoritySnapshot.map(
                  (authority) => authority.professionalId,
                ),
              ]),
            ].sort((left, right) => left - right);
            for (const professionalId of identityProfessionalIds) {
              const [professional] = await tx
                .select({ id: professionals.id, userId: professionals.userId })
                .from(professionals)
                .where(eq(professionals.id, professionalId))
                .limit(1)
                .for("update");
              if (professional)
                lockedProfessionals.set(professional.id, professional);
            }
            const currentProfessionals = await tx
              .select({ id: professionals.id })
              .from(professionals)
              .where(eq(professionals.userId, lockedUser.id))
              .orderBy(asc(professionals.id));
            if (
              currentProfessionals.length !== expectedProfessionalIds.length ||
              currentProfessionals.some(
                (professional, index) =>
                  professional.id !== expectedProfessionalIds[index],
              ) ||
              expectedProfessionalIds.some(
                (professionalId) =>
                  lockedProfessionals.get(professionalId)?.userId !==
                  lockedUser.id,
              )
            ) {
              throw new AuthMutationError(
                409,
                "Identidade profissional mudou; tente novamente",
              );
            }

            const lockedMembershipsById = new Map<
              number,
              {
                id: number;
                professionalId: number;
                userId: number;
                institutionId: number;
                roleInInstitution: InstitutionRole;
                active: boolean;
              }
            >();
            const identityMembershipIds = [
              ...new Set([
                ...membershipSnapshot.map((membership) => membership.id),
                ...identityAuthoritySnapshot.map(
                  (authority) => authority.membershipId,
                ),
              ]),
            ].sort((left, right) => left - right);
            for (const membershipId of identityMembershipIds) {
              const [membership] = await tx
                .select({
                  id: professionalInstitutions.id,
                  professionalId: professionalInstitutions.professionalId,
                  userId: professionalInstitutions.userId,
                  institutionId: professionalInstitutions.institutionId,
                  roleInInstitution: professionalInstitutions.roleInInstitution,
                  active: professionalInstitutions.active,
                })
                .from(professionalInstitutions)
                .where(eq(professionalInstitutions.id, membershipId))
                .limit(1)
                .for("update");
              if (membership)
                lockedMembershipsById.set(membership.id, membership);
            }
            const currentMemberships = await tx
              .select({ id: professionalInstitutions.id })
              .from(professionalInstitutions)
              .where(eq(professionalInstitutions.userId, lockedUser.id))
              .orderBy(asc(professionalInstitutions.id));
            const lockedMemberships = membershipSnapshot.map(
              (expected, index) => {
                const current = lockedMembershipsById.get(expected.id);
                if (
                  !current ||
                  currentMemberships[index]?.id !== expected.id ||
                  current.professionalId !== expected.professionalId ||
                  current.userId !== expected.userId ||
                  current.institutionId !== expected.institutionId ||
                  current.roleInInstitution !== expected.roleInInstitution ||
                  current.active !== expected.active ||
                  !expectedProfessionalIds.includes(current.professionalId)
                ) {
                  throw new AuthMutationError(
                    409,
                    "Vínculos mudaram durante a exclusão; atualize e tente novamente",
                  );
                }
                return current;
              },
            );
            if (currentMemberships.length !== membershipSnapshot.length) {
              throw new AuthMutationError(
                409,
                "Vínculos mudaram durante a exclusão; atualize e tente novamente",
              );
            }

            // Topology is read only after the complete identity order. SHARE
            // prevents an institution activation/deactivation from changing who
            // is an effective HTTP admin until this delete commits or rolls back.
            const activeInstitutionIds = new Set<number>();
            const authorityInstitutionIds = [
              ...new Set([
                ...lockedMemberships
                  .filter((membership) => membership.active)
                  .map((membership) => membership.institutionId),
                ...globalAdminAuthoritySnapshot.map(
                  (authority) => authority.institutionId,
                ),
              ]),
            ].sort((left, right) => left - right);
            for (const institutionId of authorityInstitutionIds) {
              const [institution] = await tx
                .select({ id: institutions.id })
                .from(institutions)
                .where(
                  and(
                    eq(institutions.id, institutionId),
                    eq(institutions.isActive, true),
                  ),
                )
                .limit(1)
                .for("share");
              if (institution) activeInstitutionIds.add(institution.id);
            }

            const lockedAuditProfessional = lockedProfessionals.get(
              auditMembershipSnapshot.professionalId,
            );
            const lockedAuditMembership = lockedMembershipsById.get(
              auditMembershipSnapshot.membershipId,
            );
            if (
              lockedAuditProfessional?.userId !== lockedUser.id ||
              !lockedAuditMembership ||
              lockedAuditMembership.professionalId !==
                auditMembershipSnapshot.professionalId ||
              lockedAuditMembership.userId !== lockedUser.id ||
              lockedAuditMembership.institutionId !==
                auditMembershipSnapshot.institutionId ||
              !lockedAuditMembership.active ||
              !activeInstitutionIds.has(auditMembershipSnapshot.institutionId)
            ) {
              throw new AuthMutationError(
                409,
                "Vínculo institucional canônico mudou durante a exclusão; tente novamente",
              );
            }
            const auditInstitutionId = auditMembershipSnapshot.institutionId;

            if (administeredInstitutionIds.length > 0) {
              const validAuthorities = adminAuthoritySnapshot.filter(
                (authority) => {
                  const authorityUser = lockedUsers.get(authority.userId);
                  const authorityProfessional = lockedProfessionals.get(
                    authority.professionalId,
                  );
                  const authorityMembership = lockedMembershipsById.get(
                    authority.membershipId,
                  );
                  return (
                    authorityUser?.approvalStatus === "APPROVED" &&
                    !authorityUser.deletedAt &&
                    authorityProfessional?.userId === authority.userId &&
                    authorityMembership?.userId === authority.userId &&
                    authorityMembership.professionalId ===
                      authority.professionalId &&
                    authorityMembership.institutionId ===
                      authority.institutionId &&
                    authorityMembership.roleInInstitution === "GESTOR_PLUS" &&
                    authorityMembership.active
                  );
                },
              );
              const currentAdministeredInstitutionIds = [
                ...new Set(
                  lockedMemberships
                    .filter(
                      (membership) =>
                        membership.active &&
                        membership.roleInInstitution === "GESTOR_PLUS",
                    )
                    .map((membership) => membership.institutionId),
                ),
              ];
              for (const institutionId of currentAdministeredInstitutionIds) {
                if (
                  !validAuthorities.some(
                    (authority) =>
                      authority.institutionId === institutionId &&
                      authority.userId !== lockedUser.id,
                  )
                ) {
                  throw new AuthMutationError(
                    409,
                    "Transfira a administração institucional antes de excluir esta conta",
                  );
                }
              }
            }

            if (
              lockedUser.role === "admin" &&
              lockedUser.approvalStatus === "APPROVED"
            ) {
              const targetAdminInstitutionIds = [
                ...new Set(
                  lockedMemberships
                    .filter(
                      (membership) =>
                        membership.active &&
                        activeInstitutionIds.has(membership.institutionId),
                    )
                    .map((membership) => membership.institutionId),
                ),
              ];
              if (targetAdminInstitutionIds.length > 0) {
                const validGlobalAuthorities =
                  globalAdminAuthoritySnapshot.filter((authority) => {
                    const authorityUser = lockedUsers.get(authority.userId);
                    const authorityProfessional = lockedProfessionals.get(
                      authority.professionalId,
                    );
                    const authorityMembership = lockedMembershipsById.get(
                      authority.membershipId,
                    );
                    return (
                      authorityUser?.role === "admin" &&
                      authorityUser.approvalStatus === "APPROVED" &&
                      !authorityUser.deletedAt &&
                      authorityProfessional?.userId === authority.userId &&
                      authorityMembership?.userId === authority.userId &&
                      authorityMembership.professionalId ===
                        authority.professionalId &&
                      authorityMembership.institutionId ===
                        authority.institutionId &&
                      authorityMembership.active &&
                      activeInstitutionIds.has(authority.institutionId)
                    );
                  });
                const remainingGlobalAdminUserIds = new Set(
                  validGlobalAuthorities
                    .filter((authority) => authority.userId !== lockedUser.id)
                    .map((authority) => authority.userId),
                );
                if (remainingGlobalAdminUserIds.size === 0) {
                  throw new AuthMutationError(
                    409,
                    "Transfira a administração global antes de excluir esta conta",
                  );
                }
                for (const institutionId of targetAdminInstitutionIds) {
                  if (
                    !validGlobalAuthorities.some(
                      (authority) =>
                        authority.institutionId === institutionId &&
                        authority.userId !== lockedUser.id,
                    )
                  ) {
                    throw new AuthMutationError(
                      409,
                      "Outro administrador global precisa de vínculo canônico ativo neste tenant",
                    );
                  }
                }
              }
            }

            // Every assignment writer uses the same professional mutex. Under
            // READ COMMITTED this read sees the latest commit after we acquire it,
            // and no new assignment can pass authority while deletion is pending.
            const now = new Date();
            for (const professionalId of expectedProfessionalIds) {
              const [unfinished] = await tx
                .select({ id: shiftAssignmentsV2.id })
                .from(shiftAssignmentsV2)
                .innerJoin(
                  shiftInstances,
                  eq(shiftInstances.id, shiftAssignmentsV2.shiftInstanceId),
                )
                .where(
                  and(
                    eq(shiftAssignmentsV2.professionalId, professionalId),
                    eq(shiftAssignmentsV2.isActive, true),
                    gt(shiftInstances.endAt, now),
                  ),
                )
                .limit(1);
              if (unfinished) {
                throw new AuthMutationError(409, FUTURE_SHIFTS_MESSAGE);
              }
            }

            const nextSessionVersion = lockedUser.sessionVersion + 1;
            const updateResult = await tx
              .update(users)
              .set({
                deletedAt: now,
                name: "Conta removida",
                email: `removido+${lockedUser.id}@anon.local`,
                openId: null,
                loginMethod: null,
                passwordHash: null,
                mustChangePassword: false,
                sessionVersion: nextSessionVersion,
              })
              .where(
                and(
                  eq(users.id, lockedUser.id),
                  eq(users.sessionVersion, lockedUser.sessionVersion),
                  eq(users.passwordHash, lockedUser.passwordHash),
                  isNull(users.deletedAt),
                ),
              );
            if (affectedRows(updateResult) !== 1) {
              throw new AuthMutationError(
                409,
                "A conta mudou durante a exclusão",
              );
            }
            await tx
              .update(professionals)
              .set({ name: "Conta removida" })
              .where(eq(professionals.userId, lockedUser.id));
            await tx
              .update(professionalInstitutions)
              .set({ active: false })
              .where(eq(professionalInstitutions.userId, lockedUser.id));
            await tx
              .update(userContactChannels)
              .set({ active: false, verifiedAt: null })
              .where(eq(userContactChannels.userId, lockedUser.id));
            const revokedPushTokenCount = await revokeUserPushRegistrations(
              tx,
              lockedUser.id,
            );
            await tx
              .delete(passwordResets)
              .where(eq(passwordResets.userId, lockedUser.id));
            await recordAudit(
              {
                actorUserId: lockedUser.id,
                actorRole: lockedUser.role,
                actorName: auditActorName(lockedUser.name),
                action: "USER_UPDATED",
                entityType: "USER",
                entityId: lockedUser.id,
                description:
                  "Conta excluída pelo próprio usuário (soft-delete, dados anonimizados)",
                metadata: {
                  emailHash: lockedUser.email
                    ? hashResetToken(lockedUser.email)
                    : null,
                  sessionVersionBefore: lockedUser.sessionVersion,
                  sessionVersionAfter: nextSessionVersion,
                  revokedPushTokenCount,
                },
                institutionId: auditInstitutionId,
              },
              { db: tx, strict: true },
            );
          },
          { isolationLevel: "read committed" },
        ),
    );
  } catch (error) {
    restoreBrowserSessionFence(req, res, previousFenceValue);
    if (error instanceof AuthMutationError) {
      res.status(error.status).json({ error: error.message });
      return;
    }
    console.error("[delete-account] Falha transacional", String(error));
    res.status(500).json({ error: "Falha ao excluir conta" });
    return;
  }

  // O commit já tornou toda sessão antiga inválida por sessionVersion. A
  // resposta terminal limpa o cookie e carrega a prova explícita exigida pelo
  // cliente antes de declarar a exclusão concluída.
  clearBrowserSession(req, res);
  res.json({ ok: true, sessionFenceRotated: true });
});

// POST /api/auth/logout
authRouter.post(
  "/logout",
  async (req: Request, res: Response): Promise<void> => {
    let parsedCookies: Record<string, string | undefined> = {};
    if (req.headers.cookie) {
      try {
        parsedCookies = parseCookieHeader(req.headers.cookie);
      } catch {
        // O snapshot abaixo marca o header malformado como um fence impossível.
      }
    }
    const authorization = req.headers.authorization;
    const bearerToken =
      typeof authorization === "string" && authorization.startsWith("Bearer ")
        ? authorization.slice("Bearer ".length).trim()
        : "";
    const cookieToken = bearerToken ? "" : (parsedCookies[COOKIE_NAME] ?? "");
    const sessionToken = bearerToken || cookieToken;
    const transport = bearerToken ? "BEARER" : cookieToken ? "COOKIE" : null;
    const expectedUserHeader = req.headers[EXPECTED_USER_ID_HEADER];
    const sessionInstanceHeader = req.headers[SESSION_INSTANCE_HEADER];
    const sessionBindingVersionHint =
      sdk.sessionBindingVersionHint(sessionToken);

    // Um cliente que declarou a identidade esperada não autoriza o logout
    // idempotente de uma credencial diferente. A assinatura e o userId do
    // snapshot são conferidos antes de girar/limpar qualquer fence ou cookie.
    // Sem o header, o caminho legado gira o fence antes do primeiro await. Um
    // cookie com claim exact é verificado antes: sessão ainda atual sem proof
    // precisa falhar sem produzir sequer um Set-Cookie transitório.
    let session =
      (expectedUserHeader !== undefined ||
        sessionInstanceHeader !== undefined ||
        (transport === "COOKIE" &&
          sessionBindingVersionHint === SESSION_BINDING_VERSION)) &&
      sessionToken
        ? await sdk.verifySession(sessionToken)
        : null;
    let sessionUserId = session ? Number(session.userId) : null;
    const requestFence = sessionFenceSnapshot(req);
    const previousFenceValue = parsedCookies[SESSION_FENCE_COOKIE_NAME];
    const requireLogoutDb = async (): Promise<
      NonNullable<Awaited<ReturnType<typeof getDb>>>
    > => {
      try {
        const db = await getDb();
        if (!db) throw new AuthenticationInfrastructureError();
        return db;
      } catch (error) {
        if (error instanceof AuthenticationInfrastructureError) throw error;
        throw new AuthenticationInfrastructureError(undefined, error);
      }
    };
    const currentExactCookieSessionRequiresProof =
      async (): Promise<boolean> => {
        if (
          transport !== "COOKIE" ||
          session?.sessionBindingVersion !== SESSION_BINDING_VERSION ||
          !Number.isSafeInteger(sessionUserId) ||
          (sessionUserId ?? 0) <= 0
        ) {
          return false;
        }
        const fenceMatches =
          session.sessionFenceDigest === undefined
            ? !requestFence.present
            : session.sessionFenceDigest === requestFence.digest;
        if (!fenceMatches) return false;

        try {
          const db = await requireLogoutDb();
          const [currentUser] = await db
            .select({
              sessionVersion: users.sessionVersion,
              deletedAt: users.deletedAt,
            })
            .from(users)
            .where(eq(users.id, sessionUserId!))
            .limit(1);
          return Boolean(
            currentUser &&
            !currentUser.deletedAt &&
            currentUser.sessionVersion === session.sessionVersion,
          );
        } catch (error) {
          if (error instanceof AuthenticationInfrastructureError) throw error;
          throw new AuthenticationInfrastructureError(undefined, error);
        }
      };
    if (expectedUserHeader !== undefined) {
      const canonicalSessionUserId =
        session &&
        Number.isSafeInteger(sessionUserId) &&
        (sessionUserId ?? 0) > 0 &&
        String(sessionUserId) === session.userId
          ? sessionUserId!
          : null;
      try {
        assertExpectedUserConstraint(
          expectedUserHeader,
          // Sem credencial verificável não existe uma identidade B a preservar:
          // valida apenas a sintaxe e segue pelo logout idempotente. Uma sessão
          // válida de outro user continua produzindo 409 antes de qualquer fence.
          canonicalSessionUserId ?? Number(expectedUserHeader),
        );
      } catch (error) {
        if (error instanceof ExpectedUserConstraintError) {
          res.status(error.status).json({
            error: error.message,
            code: error.code,
            ...(error.code === "EXPECTED_USER_MISMATCH" &&
            canonicalSessionUserId !== null
              ? { currentSessionUserId: canonicalSessionUserId }
              : {}),
          });
          return;
        }
        throw error;
      }
    }
    let initialExactProofRequired: boolean;
    try {
      initialExactProofRequired =
        await currentExactCookieSessionRequiresProof();
    } catch (error) {
      if (sendAuthenticationInfrastructureError(res, error)) return;
      console.error(
        "[logout] Falha ao validar autoridade da sessão exact",
        JSON.stringify(error instanceof Error ? error.message : String(error)),
      );
      res.status(500).json({ error: "Falha ao validar sessão para logout" });
      return;
    }
    try {
      assertSessionInstanceConstraint(
        sessionInstanceHeader,
        session ? sessionToken : undefined,
        {
          allowMissingCredential: true,
          required: initialExactProofRequired,
        },
      );
    } catch (error) {
      if (error instanceof SessionInstanceConstraintError) {
        res
          .status(error.status)
          .json({ error: error.message, code: error.code });
        return;
      }
      throw error;
    }

    rotateBrowserSessionFence(req, res);

    if (
      expectedUserHeader === undefined &&
      sessionInstanceHeader === undefined
    ) {
      session = sessionToken ? await sdk.verifySession(sessionToken) : null;
      sessionUserId = session ? Number(session.userId) : null;
      let exactProofRequired: boolean;
      try {
        exactProofRequired = await currentExactCookieSessionRequiresProof();
      } catch (error) {
        restoreBrowserSessionFence(req, res, previousFenceValue);
        if (sendAuthenticationInfrastructureError(res, error)) return;
        console.error(
          "[logout] Falha ao validar autoridade da sessão exact",
          JSON.stringify(
            error instanceof Error ? error.message : String(error),
          ),
        );
        res.status(500).json({ error: "Falha ao validar sessão para logout" });
        return;
      }
      try {
        assertSessionInstanceConstraint(
          sessionInstanceHeader,
          session ? sessionToken : undefined,
          {
            allowMissingCredential: true,
            required: exactProofRequired,
          },
        );
      } catch (error) {
        restoreBrowserSessionFence(req, res, previousFenceValue);
        if (error instanceof SessionInstanceConstraintError) {
          res
            .status(error.status)
            .json({ error: error.message, code: error.code });
          return;
        }
        throw error;
      }
    }
    const cookieFenceMatches =
      transport !== "COOKIE" || !session
        ? true
        : session.sessionFenceDigest === undefined
          ? !requestFence.present
          : session.sessionFenceDigest === requestFence.digest;

    // Sessão ausente, malformada, já revogada ou superada pelo fence continua
    // sendo um logout idempotente. Nenhum token push é tocado sem identidade
    // atual comprovada no commit abaixo.
    if (
      !session ||
      !Number.isSafeInteger(sessionUserId) ||
      (sessionUserId ?? 0) <= 0 ||
      !cookieFenceMatches
    ) {
      const revocationUserId =
        Number.isSafeInteger(sessionUserId) && (sessionUserId ?? 0) > 0
          ? sessionUserId
          : await sdk.verifiedSessionUserIdHint(sessionToken);
      sendLogoutRevocationProof(req, res, "ALREADY_INVALID", revocationUserId);
      return;
    }

    try {
      const db = await requireLogoutDb();

      const revocation = await withPushAccountMutex(
        db,
        sessionUserId!,
        PUSH_ACCOUNT_MUTATION_LOCK_TIMEOUT_SEC,
        (connectionDb) =>
          connectionDb.transaction(
            async (
              tx,
            ): Promise<{
              userId: number;
              sessionVersionBefore: number;
              sessionVersionAfter: number;
              auditInstitutionId: number | null;
              revokedPushTokenCount: number;
            } | null> => {
              const [lockedUser] = await tx
                .select()
                .from(users)
                .where(eq(users.id, sessionUserId!))
                .limit(1)
                .for("update");

              // Não diferencia conta inexistente, excluída ou sessão obsoleta. Esses
              // casos já não possuem autoridade e não podem apagar token de aparelho.
              if (
                !lockedUser ||
                lockedUser.deletedAt ||
                lockedUser.sessionVersion !== session.sessionVersion
              ) {
                return null;
              }

              const auditMembership = await readCanonicalAuditMembership(
                tx,
                lockedUser.id,
                { allowInactive: true },
              );
              const lockedAuditMembership = auditMembership
                ? await lockCanonicalAuditMembership(
                    tx,
                    lockedUser.id,
                    auditMembership,
                    { allowInactive: true },
                  )
                : null;

              const nextSessionVersion = lockedUser.sessionVersion + 1;
              const updateResult = await tx
                .update(users)
                .set({ sessionVersion: nextSessionVersion })
                .where(
                  and(
                    eq(users.id, lockedUser.id),
                    eq(users.sessionVersion, lockedUser.sessionVersion),
                    isNull(users.deletedAt),
                  ),
                );
              if (affectedRows(updateResult) !== 1) {
                throw new Error("Concorrência inesperada ao revogar sessão");
              }

              const revokedPushTokenCount = await revokeUserPushRegistrations(
                tx,
                lockedUser.id,
              );

              if (lockedAuditMembership) {
                await recordAudit(
                  {
                    actorUserId: lockedUser.id,
                    actorRole: lockedUser.role,
                    actorName: auditActorName(lockedUser.name),
                    action: "USER_UPDATED",
                    entityType: "USER",
                    entityId: lockedUser.id,
                    description: "Sessões encerradas pelo próprio usuário",
                    institutionId: lockedAuditMembership.institutionId,
                    metadata: {
                      sessionVersionBefore: lockedUser.sessionVersion,
                      sessionVersionAfter: nextSessionVersion,
                      revokedPushTokenCount,
                      transport,
                    },
                  },
                  { db: tx, strict: true },
                );
              }
              return {
                userId: lockedUser.id,
                sessionVersionBefore: lockedUser.sessionVersion,
                sessionVersionAfter: nextSessionVersion,
                auditInstitutionId:
                  lockedAuditMembership?.institutionId ?? null,
                revokedPushTokenCount,
              };
            },
            { isolationLevel: "read committed" },
          ),
      );

      if (revocation && revocation.auditInstitutionId === null) {
        // audit_trail exige institution_id. Sem PI sequer inativa, atribuir o
        // evento a outro tenant seria falsificar escopo. O CAS durável em
        // users.session_version prevalece sobre deixar o Bearer vivo; este log
        // explicita a exceção sem projetar autoridade institucional inexistente.
        console.error(
          "[logout] Sessão órfã revogada sem escopo institucional",
          JSON.stringify({
            userId: revocation.userId,
            sessionVersionBefore: revocation.sessionVersionBefore,
            sessionVersionAfter: revocation.sessionVersionAfter,
            revokedPushTokenCount: revocation.revokedPushTokenCount,
          }),
        );
      }

      sendLogoutRevocationProof(
        req,
        res,
        revocation ? "ROTATED" : "ALREADY_INVALID",
        sessionUserId,
      );
    } catch (error) {
      // O fence foi girado sincronicamente para bloquear respostas antigas,
      // mas uma revogação que não commitou não pode destruir a sessão atual.
      // O último Set-Cookie restaura exatamente o fence observado; o cookie de
      // sessão não foi limpo e a UI pode manter estado e repetir a operação.
      restoreBrowserSessionFence(req, res, previousFenceValue);
      if (sendAuthenticationInfrastructureError(res, error)) return;
      console.error(
        "[logout] Falha transacional",
        JSON.stringify(error instanceof Error ? error.message : String(error)),
      );
      res.status(500).json({ error: "Falha ao encerrar sessão" });
    }
  },
);

// GET /api/auth/me
authRouter.get("/me", async (req: Request, res: Response): Promise<void> => {
  res.setHeader("Cache-Control", "no-store");
  try {
    const user = await sdk.authenticateRequest(req, {
      allowMustChangePassword: true,
      allowSessionInstanceBootstrap: true,
    });
    const sessionInstance =
      sdk.sessionInstanceProofForAuthenticatedRequest(req);
    const sessionBindingVersion =
      sdk.sessionBindingVersionForAuthenticatedRequest(req);
    if (!sessionInstance) {
      sendUnauthenticated(req, res);
      return;
    }
    res.json({
      sessionInstance,
      sessionBinding: sessionBindingState(
        ENV.sessionExactBindingSupported,
        sessionBindingVersion,
      ),
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        approvalStatus: user.approvalStatus,
        mustChangePassword: user.mustChangePassword,
      },
    });
  } catch (error) {
    if (sendAuthenticationInfrastructureError(res, error)) return;
    if (
      error instanceof ExpectedUserConstraintError ||
      error instanceof SessionInstanceConstraintError
    ) {
      res.status(error.status).json({
        error: error.message,
        code: error.code,
        credentialPresented: true,
      });
      return;
    }
    sendUnauthenticated(req, res);
  }
});

class RegisterValidationError extends Error {
  constructor(
    readonly status: 400 | 403 | 409,
    message: string,
  ) {
    super(message);
  }
}

type RegisterQueryDb = Pick<
  NonNullable<Awaited<ReturnType<typeof getDb>>>,
  "select"
>;

async function requireCanonicalRegisterActor(
  db: RegisterQueryDb,
  callerUserId: number,
  institutionId: number,
  lockForUpdate = false,
  expectedSessionVersion?: number,
): Promise<number> {
  if (!lockForUpdate) {
    const [canonical] = await db
      .select({ membershipId: professionalInstitutions.id })
      .from(professionalInstitutions)
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
      .innerJoin(
        institutions,
        and(
          eq(institutions.id, professionalInstitutions.institutionId),
          eq(institutions.isActive, true),
        ),
      )
      .where(
        and(
          eq(professionalInstitutions.userId, callerUserId),
          eq(professionalInstitutions.institutionId, institutionId),
          eq(professionalInstitutions.roleInInstitution, "GESTOR_PLUS"),
          eq(professionalInstitutions.active, true),
        ),
      )
      .limit(1);
    if (canonical) return canonical.membershipId;
  } else {
    const [candidate] = await db
      .select({
        membershipId: professionalInstitutions.id,
        professionalId: professionalInstitutions.professionalId,
      })
      .from(professionalInstitutions)
      .where(
        and(
          eq(professionalInstitutions.userId, callerUserId),
          eq(professionalInstitutions.institutionId, institutionId),
          eq(professionalInstitutions.active, true),
        ),
      )
      .limit(1);
    if (candidate) {
      // Global identity order: user → professional → PI. Topology is a
      // shared canonical read only after identity is stable.
      const [lockedUser] = await db
        .select({ id: users.id, sessionVersion: users.sessionVersion })
        .from(users)
        .where(
          and(
            eq(users.id, callerUserId),
            eq(users.approvalStatus, "APPROVED"),
            isNull(users.deletedAt),
          ),
        )
        .limit(1)
        .for("update");
      if (
        lockedUser &&
        expectedSessionVersion !== undefined &&
        lockedUser.sessionVersion !== expectedSessionVersion
      ) {
        throw new RegisterValidationError(
          409,
          "A sessão administrativa foi revogada durante o cadastro; entre novamente",
        );
      }
      const [professional] = lockedUser
        ? await db
            .select({ id: professionals.id })
            .from(professionals)
            .where(
              and(
                eq(professionals.id, candidate.professionalId),
                eq(professionals.userId, callerUserId),
              ),
            )
            .limit(1)
            .for("update")
        : [];
      const [membership] = professional
        ? await db
            .select({ id: professionalInstitutions.id })
            .from(professionalInstitutions)
            .where(
              and(
                eq(professionalInstitutions.id, candidate.membershipId),
                eq(professionalInstitutions.professionalId, professional.id),
                eq(professionalInstitutions.userId, callerUserId),
                eq(professionalInstitutions.institutionId, institutionId),
                eq(professionalInstitutions.roleInInstitution, "GESTOR_PLUS"),
                eq(professionalInstitutions.active, true),
              ),
            )
            .limit(1)
            .for("update")
        : [];
      const [institution] = membership
        ? await db
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
      if (institution) return membership!.id;
    }
  }

  throw new RegisterValidationError(
    403,
    "Usuário sem vínculo GESTOR_PLUS canônico e ativo no tenant informado",
  );
}

function resolveExplicitRegisterTenant(req: Request): number {
  const tenantId = parseTenantIdHeader(req.headers["x-tenant-id"]);
  if (!tenantId) {
    throw new RegisterValidationError(
      400,
      "x-tenant-id válido é obrigatório para cadastrar usuários",
    );
  }

  const rawBodyTenant = (req.body as { institutionId?: unknown })
    ?.institutionId;
  if (rawBodyTenant !== undefined) {
    const bodyTenantId =
      typeof rawBodyTenant === "number"
        ? rawBodyTenant
        : typeof rawBodyTenant === "string" && rawBodyTenant.trim()
          ? Number(rawBodyTenant)
          : NaN;
    if (!Number.isInteger(bodyTenantId) || bodyTenantId <= 0) {
      throw new RegisterValidationError(400, "institutionId inválido");
    }
    if (bodyTenantId !== tenantId) {
      throw new RegisterValidationError(
        400,
        "institutionId deve corresponder ao x-tenant-id explícito",
      );
    }
  }

  return tenantId;
}

function deriveRegistrationRoles(input: {
  legacyRole: unknown;
  professionalRole: unknown;
  roleInInstitution: unknown;
}): { professionalRole: ProfessionalRole; roleInInstitution: InstitutionRole } {
  const { legacyRole, professionalRole, roleInInstitution } = input;

  if (
    legacyRole !== undefined &&
    (typeof legacyRole !== "string" ||
      !VALID_LEGACY_ROLES.includes(legacyRole as UserRole))
  ) {
    throw new RegisterValidationError(
      400,
      `role inválido. Valores aceitos: ${VALID_LEGACY_ROLES.join(", ")}`,
    );
  }
  if (
    professionalRole !== undefined &&
    (typeof professionalRole !== "string" ||
      !VALID_PROFESSIONAL_ROLES.includes(professionalRole as ProfessionalRole))
  ) {
    throw new RegisterValidationError(
      400,
      `professionalRole inválido. Valores aceitos: ${VALID_PROFESSIONAL_ROLES.join(", ")}`,
    );
  }
  if (
    roleInInstitution !== undefined &&
    (typeof roleInInstitution !== "string" ||
      !VALID_INSTITUTION_ROLES.includes(roleInInstitution as InstitutionRole))
  ) {
    throw new RegisterValidationError(
      400,
      `roleInInstitution inválido. Valores aceitos: ${VALID_INSTITUTION_ROLES.join(", ")}`,
    );
  }

  const legacy = legacyRole as UserRole | undefined;
  const legacyProfessionalRole: ProfessionalRole | undefined = legacy
    ? legacy === "nurse" || legacy === "tech"
      ? legacy
      : "doctor"
    : undefined;
  const legacyInstitutionRole: InstitutionRole | undefined = legacy
    ? legacy === "admin"
      ? "GESTOR_PLUS"
      : legacy === "manager"
        ? "GESTOR_MEDICO"
        : "USER"
    : undefined;

  const explicitProfessionalRole = professionalRole as
    ProfessionalRole | undefined;
  const explicitInstitutionRole = roleInInstitution as
    InstitutionRole | undefined;
  if (
    legacyProfessionalRole &&
    explicitProfessionalRole &&
    legacyProfessionalRole !== explicitProfessionalRole
  ) {
    throw new RegisterValidationError(
      400,
      "role e professionalRole representam funções profissionais conflitantes",
    );
  }
  if (
    legacyInstitutionRole &&
    explicitInstitutionRole &&
    legacyInstitutionRole !== explicitInstitutionRole
  ) {
    throw new RegisterValidationError(
      400,
      "role e roleInInstitution representam papéis institucionais conflitantes",
    );
  }

  return {
    professionalRole:
      explicitProfessionalRole ?? legacyProfessionalRole ?? "doctor",
    roleInInstitution:
      explicitInstitutionRole ?? legacyInstitutionRole ?? "USER",
  };
}

// POST /api/auth/register — somente GESTOR_PLUS canônico no tenant explícito
authRouter.post(
  "/register",
  async (req: Request, res: Response): Promise<void> => {
    let caller;
    try {
      caller = await sdk.authenticateRequest(req);
    } catch (error) {
      if (sendAuthenticationInfrastructureError(res, error)) return;
      if (error instanceof SessionInstanceConstraintError) {
        res
          .status(error.status)
          .json({ error: error.message, code: error.code });
        return;
      }
      if (error instanceof ExpectedUserConstraintError) {
        res
          .status(error.status)
          .json({ error: error.message, code: error.code });
        return;
      }
      res.status(401).json({ error: "Não autenticado" });
      return;
    }

    const {
      name,
      email,
      password: rawPassword,
      role,
      professionalRole,
      roleInInstitution,
      medicalSpecialtyCode,
      operationalProfileCode,
      specialty,
      scheduleContextIds,
      managerScopes,
    } = req.body as {
      name?: unknown;
      email?: unknown;
      password?: unknown;
      role?: unknown;
      professionalRole?: unknown;
      roleInInstitution?: unknown;
      medicalSpecialtyCode?: unknown;
      operationalProfileCode?: unknown;
      specialty?: unknown;
      scheduleContextIds?: unknown;
      managerScopes?: unknown;
    };
    const password =
      typeof rawPassword === "string" ? rawPassword.trim() : rawPassword;

    if (
      typeof name !== "string" ||
      typeof email !== "string" ||
      typeof password !== "string" ||
      !name.trim() ||
      !email.trim() ||
      !password
    ) {
      res
        .status(400)
        .json({ error: "name, email e password são obrigatórios" });
      return;
    }
    if (password.length < 8 || password.length > 128) {
      res
        .status(400)
        .json({ error: "password deve ter entre 8 e 128 caracteres" });
      return;
    }
    if (name.trim().length > 255 || email.trim().length > 320) {
      res
        .status(400)
        .json({ error: "name ou email excede o tamanho permitido" });
      return;
    }

    let targetInstitutionId: number;
    let requestedRoles: ReturnType<typeof deriveRegistrationRoles>;
    let qualification: CanonicalMedicalQualification;
    let requestedScheduleContextIds: number[] | undefined;
    try {
      targetInstitutionId = resolveExplicitRegisterTenant(req);
      requestedRoles = deriveRegistrationRoles({
        legacyRole: role,
        professionalRole,
        roleInInstitution,
      });
      const parsedQualification = parseMedicalQualification({
        medicalSpecialtyCode,
        operationalProfileCode,
        legacySpecialty: specialty,
        allowMissing: true,
      });
      if (!parsedQualification.ok) {
        throw new RegisterValidationError(400, parsedQualification.error);
      }
      qualification = parsedQualification.value;
      if (
        requestedRoles.professionalRole !== "doctor" &&
        (qualification.medicalSpecialtyCode ||
          qualification.operationalProfileCode)
      ) {
        throw new RegisterValidationError(
          400,
          "Qualificação médica só pode ser atribuída a médicos",
        );
      }
      if (requestedRoles.professionalRole === "doctor") {
        requestedScheduleContextIds =
          parseScheduleContextIds(scheduleContextIds);
      } else if (scheduleContextIds !== undefined) {
        throw new RegisterValidationError(
          400,
          "Escalas médicas só podem ser atribuídas a médicos",
        );
      }
    } catch (error) {
      if (error instanceof ScheduleContextAclError) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      if (error instanceof RegisterValidationError) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      throw error;
    }

    let requestedManagerScopes: ReturnType<typeof parseManagerScopes>;
    try {
      requestedManagerScopes = parseManagerScopes(managerScopes);
    } catch (error) {
      res.status(400).json({
        error:
          error instanceof Error ? error.message : "managerScopes inválido",
      });
      return;
    }

    const normalizedEmail = email.toLowerCase().trim();
    const normalizedName = name.trim();

    const db = await getDb();
    if (!db) {
      res.status(503).json({ error: "Banco de dados indisponível" });
      return;
    }

    // Nega autoridade antes de consultar e-mail global ou gastar CPU com bcrypt.
    // A mesma prova é refeita sob lock na transação para fechar TOCTOU.
    try {
      await requireCanonicalRegisterActor(db, caller.id, targetInstitutionId);
    } catch (error) {
      if (error instanceof RegisterValidationError) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      throw error;
    }

    const existing = await getUserByEmail(normalizedEmail);
    if (
      existing?.deletedAt ||
      (existing && hasUsablePasswordHash(existing.passwordHash))
    ) {
      res.status(409).json({ error: EMAIL_ALREADY_REGISTERED });
      return;
    }
    const existingShellId =
      existing && !hasUsablePasswordHash(existing.passwordHash)
        ? existing.id
        : null;

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    try {
      const created = await db.transaction(async (tx) => {
        const actorMembershipId = await requireCanonicalRegisterActor(
          tx,
          caller.id,
          targetInstitutionId,
          true,
          caller.sessionVersion,
        );

        const medicalSpecialtyId = qualification.medicalSpecialtyCode
          ? (
              await tx
                .select({ id: medicalSpecialties.id })
                .from(medicalSpecialties)
                .where(
                  and(
                    eq(
                      medicalSpecialties.code,
                      qualification.medicalSpecialtyCode,
                    ),
                    eq(medicalSpecialties.active, true),
                  ),
                )
                .limit(1)
                .for("share")
            )[0]?.id
          : null;
        if (qualification.medicalSpecialtyCode && !medicalSpecialtyId) {
          throw new RegisterValidationError(
            400,
            "Especialidade médica não está ativa no catálogo",
          );
        }

        const selectedScheduleContexts =
          requestedRoles.professionalRole === "doctor"
            ? await resolveScheduleContextAclSelection({
                db: tx,
                institutionId: targetInstitutionId,
                requestedScheduleContextIds,
              })
            : [];

        let newUserId: number;
        if (existingShellId) {
          const [locked] = await tx
            .select({
              id: users.id,
              passwordHash: users.passwordHash,
              deletedAt: users.deletedAt,
            })
            .from(users)
            .where(eq(users.id, existingShellId))
            .limit(1)
            .for("update");
          if (
            !locked ||
            locked.deletedAt ||
            hasUsablePasswordHash(locked.passwordHash)
          ) {
            throw new RegisterValidationError(409, EMAIL_ALREADY_REGISTERED);
          }
          await tx
            .update(users)
            .set({
              name: normalizedName,
              email: normalizedEmail,
              passwordHash,
              loginMethod: "email",
              role: requestedRoles.professionalRole,
            })
            .where(and(eq(users.id, locked.id), isNull(users.deletedAt)));
          newUserId = locked.id;
        } else {
          const [inserted] = await tx
            .insert(users)
            .values({
              name: normalizedName,
              email: normalizedEmail,
              passwordHash,
              // Papel global administrativo nunca nasce deste fluxo tenant-scoped.
              role: requestedRoles.professionalRole,
              loginMethod: "email",
            })
            .$returningId();
          newUserId = inserted.id;
        }

        const [persistedSecret] = await tx
          .select({ passwordHash: users.passwordHash })
          .from(users)
          .where(eq(users.id, newUserId))
          .limit(1);
        if (!hasUsablePasswordHash(persistedSecret?.passwordHash)) {
          throw new Error("password-hash-not-persisted");
        }

        const [existingProfessional] = await tx
          .select({ id: professionals.id })
          .from(professionals)
          .where(eq(professionals.userId, newUserId))
          .limit(1);
        let professionalId = existingProfessional?.id;
        if (!professionalId) {
          const [createdProfessional] = await tx
            .insert(professionals)
            .values({
              userId: newUserId,
              name: normalizedName,
              role: mapProfessionalRoleToLabel(requestedRoles.professionalRole),
              // Projeção legada para a build atual; autorização lê exclusivamente PI.
              userRole: requestedRoles.roleInInstitution,
              specialty: qualification.legacyLabel,
              medicalSpecialtyId,
              operationalProfileCode: qualification.operationalProfileCode,
            })
            .$returningId();
          professionalId = createdProfessional.id;
        } else {
          await tx
            .update(professionals)
            .set({
              name: normalizedName,
              role: mapProfessionalRoleToLabel(requestedRoles.professionalRole),
              userRole: requestedRoles.roleInInstitution,
              specialty: qualification.legacyLabel,
              medicalSpecialtyId,
              operationalProfileCode: qualification.operationalProfileCode,
            })
            .where(eq(professionals.id, professionalId));
        }

        const [existingMembership] = await tx
          .select({ id: professionalInstitutions.id })
          .from(professionalInstitutions)
          .where(
            and(
              eq(professionalInstitutions.userId, newUserId),
              eq(professionalInstitutions.institutionId, targetInstitutionId),
            ),
          )
          .limit(1);
        if (!existingMembership) {
          await tx.insert(professionalInstitutions).values({
            professionalId,
            userId: newUserId,
            institutionId: targetInstitutionId,
            roleInInstitution: requestedRoles.roleInInstitution,
            isPrimary: true,
            active: true,
          });
        } else {
          await tx
            .update(professionalInstitutions)
            .set({
              roleInInstitution: requestedRoles.roleInInstitution,
              active: true,
            })
            .where(eq(professionalInstitutions.id, existingMembership.id));
        }

        await tx
          .delete(professionalAccess)
          .where(
            and(
              eq(professionalAccess.professionalId, professionalId),
              eq(professionalAccess.institutionId, targetInstitutionId),
            ),
          );
        for (const access of scheduleContextsToSpecificAccessTargets(
          selectedScheduleContexts,
        )) {
          await tx.insert(professionalAccess).values({
            institutionId: targetInstitutionId,
            professionalId,
            hospitalId: access.hospitalId,
            sectorId: access.sectorId,
            canAccess: true,
          });
        }

        const nextScopes = await resolveManagerScopesForRole({
          db: tx,
          institutionId: targetInstitutionId,
          role: requestedRoles.roleInInstitution,
          requested: requestedManagerScopes,
          existing: [],
        });
        if (nextScopes.length > 0) {
          await replaceManagerScopesForProfessional(tx, {
            institutionId: targetInstitutionId,
            professionalId,
            scopes: nextScopes,
          });
        }

        await recordAudit(
          {
            institutionId: targetInstitutionId,
            action: existingShellId ? "USER_UPDATED" : "USER_CREATED",
            entityType: "USER",
            entityId: newUserId,
            actorUserId: caller.id,
            actorRole: "GESTOR_PLUS",
            actorName: auditActorName(caller.name),
            description: existingShellId
              ? `Senha definida para o usuário #${newUserId} pelo usuário #${caller.id}`
              : `Usuário #${newUserId} criado pelo usuário #${caller.id}`,
            metadata: {
              professionalRole: requestedRoles.professionalRole,
              roleInInstitution: requestedRoles.roleInInstitution,
              medicalSpecialtyCode: qualification.medicalSpecialtyCode,
              operationalProfileCode: qualification.operationalProfileCode,
              scheduleContextIds: selectedScheduleContexts.map(
                (context) => context.id,
              ),
              actorMembershipId,
            },
          },
          { db: tx, strict: true },
        );

        return {
          id: newUserId,
          name: normalizedName,
          email: normalizedEmail,
          role: requestedRoles.professionalRole,
          professionalRole: requestedRoles.professionalRole,
          roleInInstitution: requestedRoles.roleInInstitution,
          scheduleContextIds: selectedScheduleContexts.map(
            (context) => context.id,
          ),
        };
      });

      res.status(201).json({ user: created });
    } catch (error) {
      if (error instanceof RegisterValidationError) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      if (error instanceof ScheduleContextAclError) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      if (error instanceof ManagerScopeAdminError) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      const code =
        error && typeof error === "object" && "cause" in error
          ? (error as { cause?: { code?: unknown } }).cause?.code
          : error && typeof error === "object" && "code" in error
            ? (error as { code?: unknown }).code
            : undefined;
      if (code === "ER_DUP_ENTRY") {
        res.status(409).json({ error: EMAIL_ALREADY_REGISTERED });
        return;
      }
      console.error(
        "[register] Falha transacional ao criar usuário",
        code ? String(code) : "unknown",
      );
      res.status(500).json({ error: "Falha ao cadastrar usuário" });
    }
  },
);

// ---------------------------------------------------------------------------
// Auto-cadastro público (feat/self-signup)
//
// Fluxo: qualquer pessoa cria conta escolhendo a instituição → a conta
// nasce com approval_status PENDING e vínculo institucional INATIVO
// (invisível para escalas/alocação) → um administrador aprova na aba
// Admin, o que ativa o vínculo e concede acesso aos hospitais.
//
// Defesa em profundidade: mesmo logado, o usuário PENDING não passa nas
// procedures de tenant (sem vínculo ativo) e o app bloqueia na tela
// "Aguardando aprovação".
// ---------------------------------------------------------------------------

// GET /api/auth/signup-institutions — público: instituições disponíveis
// para o seletor da tela de cadastro (somente id + nome).
authRouter.get(
  "/signup-institutions",
  async (_req: Request, res: Response): Promise<void> => {
    const db = await getDb();
    if (!db) {
      res.status(503).json({ error: "Banco de dados indisponível" });
      return;
    }
    const rows = await db
      .select({ id: institutions.id, name: institutions.name })
      .from(institutions)
      .where(eq(institutions.isActive, true))
      .orderBy(institutions.name);
    res.json({ institutions: rows });
  },
);

// POST /api/auth/signup — público: cria conta pendente de aprovação.
authRouter.post(
  "/signup",
  async (req: Request, res: Response): Promise<void> => {
    const {
      name,
      email,
      password: rawSignupPassword,
      institutionId,
      inviteCode,
      medicalSpecialtyCode,
      operationalProfileCode,
      specialty,
    } = req.body as {
      name?: unknown;
      email?: unknown;
      password?: unknown;
      institutionId?: unknown;
      inviteCode?: unknown;
      medicalSpecialtyCode?: unknown;
      operationalProfileCode?: unknown;
      specialty?: unknown;
    };
    const password =
      typeof rawSignupPassword === "string"
        ? rawSignupPassword.trim()
        : rawSignupPassword;

    if (
      typeof name !== "string" ||
      typeof email !== "string" ||
      typeof password !== "string" ||
      !name.trim() ||
      !email.trim() ||
      !password
    ) {
      res
        .status(400)
        .json({ error: "name, email e password são obrigatórios" });
      return;
    }

    if (password.length < 8 || password.length > 128) {
      res
        .status(400)
        .json({ error: "A senha deve ter entre 8 e 128 caracteres" });
      return;
    }
    if (name.trim().length > 255 || email.trim().length > 320) {
      res
        .status(400)
        .json({ error: "name ou email excede o tamanho permitido" });
      return;
    }
    const parsedQualification = parseMedicalQualification({
      medicalSpecialtyCode,
      operationalProfileCode,
      legacySpecialty: specialty,
      // Sem instituição: a qualificação ainda identifica o perfil clínico do
      // profissional. Com instituição, o acesso operacional é escolhido pelo
      // hospital e setor, independentemente desse metadado.
      allowMissing: Boolean(
        institutionId !== undefined &&
        institutionId !== null &&
        institutionId !== "",
      ),
    });
    if (!parsedQualification.ok) {
      res.status(400).json({ error: parsedQualification.error });
      return;
    }

    if (inviteCode !== undefined && inviteCode !== null && inviteCode !== "") {
      res.status(400).json({
        error:
          "O cadastro não usa código de convite. Crie a conta e aguarde o e-mail do gestor.",
      });
      return;
    }

    const db = await getDb();
    if (!db) {
      res.status(503).json({ error: "Banco de dados indisponível" });
      return;
    }

    const wantsInstitution =
      institutionId !== undefined &&
      institutionId !== null &&
      institutionId !== "";
    const instId = Number(institutionId);
    const hasInstitution =
      wantsInstitution && Number.isInteger(instId) && instId > 0;
    if (wantsInstitution && !hasInstitution) {
      res.status(400).json({ error: "Instituição inválida" });
      return;
    }

    const [institution] = hasInstitution
      ? await db
          .select({ id: institutions.id })
          .from(institutions)
          .where(
            and(eq(institutions.id, instId), eq(institutions.isActive, true)),
          )
          .limit(1)
      : [];
    if (hasInstitution && !institution) {
      res.status(400).json({ error: "Instituição não encontrada ou inativa" });
      return;
    }

    const normalizedEmail = email.toLowerCase().trim();
    const existing = await getUserByEmail(normalizedEmail);
    if (
      existing?.deletedAt ||
      (existing && hasUsablePasswordHash(existing.passwordHash))
    ) {
      sendNeutralSignupAccepted(res, hasInstitution);
      return;
    }
    const existingShellId =
      existing && !hasUsablePasswordHash(existing.passwordHash)
        ? existing.id
        : null;

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const trimmedName = name.trim();
    const qualification = parsedQualification.value;

    let awaitingApproval = hasInstitution;
    try {
      await db.transaction(async (tx) => {
        const lockedInstitution = institution
          ? (
              await tx
                .select({ id: institutions.id })
                .from(institutions)
                .where(
                  and(
                    eq(institutions.id, institution.id),
                    eq(institutions.isActive, true),
                  ),
                )
                .limit(1)
                .for("share")
            )[0]
          : null;
        if (hasInstitution && !lockedInstitution) {
          throw new AuthMutationError(
            400,
            "Instituição não encontrada ou inativa",
          );
        }

        let existingMembership: { id: number; active: boolean } | undefined;
        if (existingShellId && lockedInstitution) {
          existingMembership = (
            await tx
              .select({
                id: professionalInstitutions.id,
                active: professionalInstitutions.active,
              })
              .from(professionalInstitutions)
              .where(
                and(
                  eq(professionalInstitutions.userId, existingShellId),
                  eq(
                    professionalInstitutions.institutionId,
                    lockedInstitution.id,
                  ),
                ),
              )
              .limit(1)
          )[0];
          if (existingMembership?.active) {
            awaitingApproval = false;
          }
        }
        const nextApproval = awaitingApproval ? "PENDING" : "APPROVED";

        const medicalSpecialtyId = qualification.medicalSpecialtyCode
          ? (
              await tx
                .select({ id: medicalSpecialties.id })
                .from(medicalSpecialties)
                .where(
                  and(
                    eq(
                      medicalSpecialties.code,
                      qualification.medicalSpecialtyCode,
                    ),
                    eq(medicalSpecialties.active, true),
                  ),
                )
                .limit(1)
                .for("share")
            )[0]?.id
          : null;
        if (qualification.medicalSpecialtyCode && !medicalSpecialtyId) {
          throw new AuthMutationError(
            400,
            "Especialidade médica não está ativa no catálogo",
          );
        }

        let newUserId: number;
        if (existingShellId) {
          const [locked] = await tx
            .select({
              id: users.id,
              passwordHash: users.passwordHash,
              deletedAt: users.deletedAt,
            })
            .from(users)
            .where(eq(users.id, existingShellId))
            .limit(1)
            .for("update");
          if (
            !locked ||
            locked.deletedAt ||
            hasUsablePasswordHash(locked.passwordHash)
          ) {
            throw new SignupDuplicateEmailError(hasInstitution);
          }
          await tx
            .update(users)
            .set({
              name: trimmedName,
              email: normalizedEmail,
              passwordHash,
              loginMethod: "email",
              role: "doctor",
              approvalStatus: nextApproval,
            })
            .where(and(eq(users.id, locked.id), isNull(users.deletedAt)));
          newUserId = locked.id;
        } else {
          const [inserted] = await tx
            .insert(users)
            .values({
              name: trimmedName,
              email: normalizedEmail,
              passwordHash,
              role: "doctor",
              loginMethod: "email",
              approvalStatus: nextApproval,
            })
            .$returningId();
          newUserId = inserted.id;
        }

        const [persistedSecret] = await tx
          .select({ passwordHash: users.passwordHash })
          .from(users)
          .where(eq(users.id, newUserId))
          .limit(1);
        if (!hasUsablePasswordHash(persistedSecret?.passwordHash)) {
          throw new Error("password-hash-not-persisted");
        }

        const [existingProfessional] = await tx
          .select({ id: professionals.id })
          .from(professionals)
          .where(eq(professionals.userId, newUserId))
          .limit(1);
        let professionalId = existingProfessional?.id;
        if (!professionalId) {
          const [createdProfessional] = await tx
            .insert(professionals)
            .values({
              userId: newUserId,
              name: trimmedName,
              role: mapRoleToLabel("doctor"),
              userRole: "USER",
              specialty: qualification.legacyLabel,
              medicalSpecialtyId,
              operationalProfileCode: qualification.operationalProfileCode,
            })
            .$returningId();
          professionalId = createdProfessional.id;
        } else {
          await tx
            .update(professionals)
            .set({
              name: trimmedName,
              role: mapRoleToLabel("doctor"),
              userRole: "USER",
              specialty: qualification.legacyLabel,
              medicalSpecialtyId,
              operationalProfileCode: qualification.operationalProfileCode,
            })
            .where(eq(professionals.id, professionalId));
        }

        if (lockedInstitution) {
          if (!existingMembership) {
            await tx.insert(professionalInstitutions).values({
              professionalId,
              userId: newUserId,
              institutionId: lockedInstitution.id,
              roleInInstitution: "USER",
              isPrimary: true,
              active: false,
            });
          }
          await recordAudit(
            {
              institutionId: lockedInstitution.id,
              action: existingShellId ? "USER_UPDATED" : "USER_CREATED",
              entityType: "USER",
              entityId: newUserId,
              actorUserId: newUserId,
              actorRole: "doctor",
              actorName: auditActorName(trimmedName),
              description: existingShellId
                ? `Senha definida no auto-cadastro do usuário #${newUserId} na instituição #${lockedInstitution.id}`
                : `Auto-cadastro do usuário #${newUserId} na instituição #${lockedInstitution.id} — aguardando aprovação`,
              metadata: {
                institutionId: lockedInstitution.id,
                selfSignup: true,
                viaInvite: false,
              },
            },
            { db: tx, strict: true },
          );
        }
      });
    } catch (error) {
      if (error instanceof SignupDuplicateEmailError) {
        return sendNeutralSignupAccepted(res, error.hasInstitution);
      }
      if (error instanceof AuthMutationError) {
        if (error.status === 409) {
          return sendNeutralSignupAccepted(res, hasInstitution);
        }
        res.status(error.status).json({ error: error.message });
        return;
      }
      if (error instanceof ScheduleInviteError) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      const code =
        error && typeof error === "object" && "cause" in error
          ? (error as { cause?: { code?: unknown } }).cause?.code
          : error && typeof error === "object" && "code" in error
            ? (error as { code?: unknown }).code
            : undefined;
      if (code === "ER_DUP_ENTRY") {
        return sendNeutralSignupAccepted(res, hasInstitution);
      }
      console.error(
        "[signup] Falha transacional",
        code ? String(code) : "unknown",
      );
      res
        .status(500)
        .json({ error: "Falha ao criar cadastro. Tente novamente." });
      return;
    }

    res.status(201).json({
      ok: true,
      pending: awaitingApproval,
      awaitingScale: !hasInstitution,
    });
  },
);

// POST /api/auth/redeem-invite — médico autenticado entra em outra escala.
authRouter.post(
  "/redeem-invite",
  async (req: Request, res: Response): Promise<void> => {
    let authUser: User;
    try {
      authUser = await sdk.authenticateRequest(req);
    } catch {
      res.status(401).json({ error: "Autenticação necessária" });
      return;
    }

    let parsedInvite: string;
    try {
      parsedInvite = parseInviteCode(
        (req.body as { inviteCode?: unknown })?.inviteCode,
      );
    } catch (error) {
      if (error instanceof ScheduleInviteError) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      throw error;
    }

    const db = await getDb();
    if (!db) {
      res.status(503).json({ error: "Banco de dados indisponível" });
      return;
    }

    try {
      const joined = await db.transaction(async (tx) => {
        const [professional] = await tx
          .select({
            id: professionals.id,
          })
          .from(professionals)
          .where(eq(professionals.userId, authUser.id))
          .limit(1)
          .for("update");
        if (!professional) {
          throw new ScheduleInviteError(409, "Profissional não encontrado");
        }
        return redeemScheduleInviteInTransaction(tx, {
          code: parsedInvite,
          userId: authUser.id,
          professionalId: professional.id,
        });
      });
      await enqueueScheduleInviteAcceptedSignal({
        db,
        scheduleInviteId: joined.scheduleInviteId,
        institutionId: joined.institutionId,
        hospitalId: joined.hospitalId,
        sectorId: joined.sectorId,
        hospitalName: joined.hospitalName,
        sectorName: joined.sectorName,
        createdByUserId: joined.createdByUserId,
        invitedUserId: joined.invitedUserId,
      });
      res.json({
        ok: true,
        institutionId: joined.institutionId,
        hospitalName: joined.hospitalName,
        sectorName: joined.sectorName,
      });
    } catch (error) {
      if (error instanceof ScheduleInviteError) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      console.error("[redeem-invite] Falha transacional");
      res
        .status(500)
        .json({ error: "Falha ao entrar na escala. Tente novamente." });
    }
  },
);

// POST /api/auth/decline-invite — profissional recusa convite nominal.
authRouter.post(
  "/decline-invite",
  async (req: Request, res: Response): Promise<void> => {
    let authUser: User;
    try {
      authUser = await sdk.authenticateRequest(req);
    } catch {
      res.status(401).json({ error: "Autenticação necessária" });
      return;
    }

    let parsedInvite: string;
    try {
      parsedInvite = parseInviteCode(
        (req.body as { inviteCode?: unknown })?.inviteCode,
      );
    } catch (error) {
      if (error instanceof ScheduleInviteError) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      throw error;
    }

    const db = await getDb();
    if (!db) {
      res.status(503).json({ error: "Banco de dados indisponível" });
      return;
    }

    try {
      const declined = await db.transaction(async (tx) =>
        declineScheduleInviteInTransaction(tx, {
          code: parsedInvite,
          userId: authUser.id,
        }),
      );
      await enqueueScheduleInviteDeclinedSignal({
        db,
        scheduleInviteId: declined.scheduleInviteId,
        institutionId: declined.institutionId,
        hospitalId: declined.hospitalId,
        sectorId: declined.sectorId,
        hospitalName: declined.hospitalName,
        sectorName: declined.sectorName,
        createdByUserId: declined.createdByUserId,
        invitedUserId: declined.invitedUserId,
      });
      res.json({
        ok: true,
        institutionId: declined.institutionId,
        hospitalName: declined.hospitalName,
        sectorName: declined.sectorName,
      });
    } catch (error) {
      if (error instanceof ScheduleInviteError) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      console.error("[decline-invite] Falha transacional");
      res
        .status(500)
        .json({ error: "Falha ao recusar o convite. Tente novamente." });
    }
  },
);

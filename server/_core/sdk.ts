import {
  COOKIE_NAME,
  ONE_YEAR_MS,
  SESSION_FENCE_COOKIE_NAME,
} from "../../shared/const.js";
import { ForbiddenError } from "../../shared/_core/errors.js";
import { parse as parseCookieHeader } from "cookie";
import type { Request } from "express";
import { decodeJwt, SignJWT, jwtVerify } from "jose";
import { createHash, randomBytes } from "node:crypto";
import {
  institutions,
  professionalInstitutions,
  professionals,
  users,
  type User,
} from "../../drizzle/schema";
import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "../db";
import { ENV } from "./env";
import {
  assertExpectedUserConstraint,
  EXPECTED_USER_ID_HEADER,
} from "./expected-user";
import {
  assertSessionInstanceConstraint,
  SESSION_INSTANCE_HEADER,
  SESSION_BINDING_VERSION,
  type SessionBindingVersion,
  sessionInstanceProof,
} from "./session-instance";

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

// A prova retornada por /me precisa vir da credencial exata que o SDK
// autenticou. Reinterpretar headers depois da autenticação permitiria que um
// Bearer vazio, o bypass de desenvolvimento ou precedências futuras divergissem
// entre a identidade validada e a instância publicada.
type AuthenticatedSessionCredential = Readonly<{
  token: string;
  sessionBindingVersion: SessionBindingVersion | null;
}>;

const authenticatedSessionCredentials = new WeakMap<
  Request,
  AuthenticatedSessionCredential
>();

export const AUTHENTICATION_INFRASTRUCTURE_ERROR_CODE =
  "AUTHENTICATION_INFRASTRUCTURE_UNAVAILABLE" as const;

/**
 * Falha de infraestrutura durante a prova de identidade.
 *
 * Ela não é uma negativa de autenticação: projetá-la como 401 permitiria que
 * consumidores tratassem indisponibilidade do banco como prova de sessão
 * revogada. O tipo separado precisa sobreviver até a borda HTTP/tRPC.
 */
export class AuthenticationInfrastructureError extends Error {
  readonly status = 503;
  readonly code = AUTHENTICATION_INFRASTRUCTURE_ERROR_CODE;
  readonly cause: unknown;

  constructor(
    message = "Infraestrutura de autenticação indisponível",
    cause?: unknown,
  ) {
    super(message);
    this.name = "AuthenticationInfrastructureError";
    this.cause = cause;
  }
}

export type SessionPayload = {
  userId: string;
  name: string;
  /** users.session_version no momento da emissão; sessões com `sv` antigo são rejeitadas. */
  sessionVersion: number;
  /** Digest do cookie host-only observado na emissão; ausente apenas em JWT legado. */
  sessionFenceDigest?: string;
  /** Protocolo exact-v1 assinado; ausência preserva compatibilidade legacy. */
  sessionBindingVersion?: SessionBindingVersion;
};

export type AuthenticateRequestOptions = {
  /**
   * Used only by the small credential-recovery surface (me, logout and
   * change-password). Operational APIs must keep the default fail-closed.
   */
  allowMustChangePassword?: boolean;
  /**
   * Exceção estreita de bootstrap para GET /auth/me: permite ausência do
   * header em cookie v1, mas um header presente continua sendo validado.
   */
  allowSessionInstanceBootstrap?: boolean;
};

export type ActiveInstitutionMembership = {
  institutionId: number;
  professionalId: number;
  isPrimary: boolean;
};

export type VerifiedSession = {
  userId: string;
  name: string;
  sessionVersion: number;
  sessionFenceDigest?: string;
  sessionBindingVersion: SessionBindingVersion | null;
};

type RequestCredentials = {
  testUserId: number | null;
  sessionCookie: string | undefined;
  sessionTransport: "BEARER" | "COOKIE" | null;
  sessionFence: SessionFenceSnapshot;
};

export type SessionFenceSnapshot = Readonly<{
  present: boolean;
  digest: string;
}>;

function digestSessionFence(value: string | undefined): string {
  const hash = createHash("sha256").update("escala-session-fence-v1\0");
  // Presença faz parte do domínio: o valor literal "<missing>" não pode
  // colidir com a ausência real do cookie.
  hash.update(value === undefined ? "0:" : "1:");
  if (value !== undefined) hash.update(value);
  return hash.digest("base64url");
}

/** Cookie ou Bearer não vazio chegou nesta Request — não é prova de validade. */
export function requestPresentedSessionCredential(req: Request): boolean {
  const authHeader = req.headers.authorization;
  if (typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
    if (authHeader.slice("Bearer ".length).trim()) return true;
  }
  const rawHeader = req.headers.cookie;
  if (!rawHeader) return false;
  try {
    const token = parseCookieHeader(rawHeader)[COOKIE_NAME];
    return typeof token === "string" && token.length > 0;
  } catch {
    return false;
  }
}

/** Snapshot imutável do fence recebido nesta requisição. */
export function sessionFenceSnapshot(req: Request): SessionFenceSnapshot {
  const rawHeader = req.headers.cookie;
  let value: string | undefined;
  if (rawHeader) {
    try {
      value = parseCookieHeader(rawHeader)[SESSION_FENCE_COOKIE_NAME];
    } catch {
      // Header inválido equivale a um valor presente impossível de coincidir
      // com um JWT emitido legitimamente sem fence.
      value = "<malformed>";
    }
  }
  return {
    present: value !== undefined,
    digest: digestSessionFence(value),
  };
}

class SDKServer {
  private async requireAuthenticationDb(): Promise<
    NonNullable<Awaited<ReturnType<typeof getDb>>>
  > {
    try {
      const db = await getDb();
      if (!db) throw new Error("Database unavailable");
      return db;
    } catch (error) {
      if (error instanceof AuthenticationInfrastructureError) throw error;
      throw new AuthenticationInfrastructureError(undefined, error);
    }
  }

  private async runAuthenticationQuery<T>(
    operation: () => Promise<T>,
  ): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof AuthenticationInfrastructureError) throw error;
      throw new AuthenticationInfrastructureError(undefined, error);
    }
  }

  private isSessionInstanceBootstrapRequest(
    req: Request,
    options: AuthenticateRequestOptions,
  ): boolean {
    return (
      options.allowSessionInstanceBootstrap === true &&
      req.method === "GET" &&
      req.baseUrl === "/api/auth" &&
      req.path === "/me"
    );
  }

  private parseCookies(cookieHeader: string | undefined) {
    if (!cookieHeader) {
      return new Map<string, string>();
    }

    const parsed = parseCookieHeader(cookieHeader);
    return new Map(Object.entries(parsed));
  }

  private getSessionSecret() {
    const secret = ENV.cookieSecret;
    return new TextEncoder().encode(secret);
  }

  private readRequestCredentials(req: Request): RequestCredentials {
    const testUserIdHeader =
      process.env.NODE_ENV === "development"
        ? req.headers["x-test-user-id"]
        : undefined;
    const parsedTestUserId =
      typeof testUserIdHeader === "string" && testUserIdHeader.trim()
        ? Number(testUserIdHeader.trim())
        : null;
    const testUserId =
      Number.isSafeInteger(parsedTestUserId) && (parsedTestUserId ?? 0) > 0
        ? parsedTestUserId
        : null;

    const authHeader = req.headers.authorization;
    let bearerToken: string | undefined;
    if (typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
      bearerToken = authHeader.slice("Bearer ".length).trim();
    }
    const cookies = this.parseCookies(req.headers.cookie);
    const cookieToken = cookies.get(COOKIE_NAME);
    return {
      testUserId,
      sessionCookie: bearerToken || cookieToken,
      sessionTransport: bearerToken ? "BEARER" : cookieToken ? "COOKIE" : null,
      sessionFence: sessionFenceSnapshot(req),
    };
  }

  private assertAuthenticatedUser(
    user: User,
    options: AuthenticateRequestOptions,
    authentication:
      | { kind: "TEST_BYPASS" }
      | {
          kind: "SESSION";
          session: VerifiedSession;
          transport: "BEARER" | "COOKIE";
          requestFence: SessionFenceSnapshot;
        },
  ): void {
    if (user.deletedAt) {
      throw new ForbiddenError("User not found");
    }
    if (
      authentication.kind === "SESSION" &&
      authentication.session.sessionVersion !== user.sessionVersion
    ) {
      throw new ForbiddenError("Session revoked");
    }
    if (
      authentication.kind === "SESSION" &&
      authentication.transport === "COOKIE"
    ) {
      const emittedFence = authentication.session.sessionFenceDigest;
      // Migração: JWT legado só é aceito enquanto o navegador também não
      // possui fence. Assim que qualquer logout gira o cookie, toda resposta
      // antiga que tente reinstalar `session` fica inutilizável.
      if (
        emittedFence === undefined
          ? authentication.requestFence.present
          : emittedFence !== authentication.requestFence.digest
      ) {
        throw new ForbiddenError("Session superseded");
      }
    }
    if (user.mustChangePassword && !options.allowMustChangePassword) {
      throw new ForbiddenError("Password change required");
    }
  }

  private logTestBypass(user: User): void {
    console.log("[Auth] Test mode: authenticated as user", user.id, user.name);
  }

  async createSessionToken(
    userId: string,
    options: {
      expiresInMs?: number;
      name?: string;
      sessionVersion?: number;
      sessionFenceDigest?: string;
      sessionBindingVersion?: SessionBindingVersion;
    } = {},
  ): Promise<string> {
    // Sem a versão informada, lê a atual do banco — nunca emitir sessão
    // com versão velha (seria rejeitada na próxima requisição).
    let sessionVersion = options.sessionVersion;
    if (sessionVersion === undefined) {
      const dbInstance = await getDb();
      const [row] = dbInstance
        ? await dbInstance
            .select({ sessionVersion: users.sessionVersion })
            .from(users)
            .where(eq(users.id, Number(userId)))
        : [];
      sessionVersion = row?.sessionVersion ?? 1;
    }
    return this.signSession(
      {
        userId,
        name: options.name || "",
        sessionVersion,
        sessionFenceDigest: options.sessionFenceDigest,
        sessionBindingVersion: options.sessionBindingVersion,
      },
      options,
    );
  }

  async signSession(
    payload: SessionPayload,
    options: { expiresInMs?: number } = {},
  ): Promise<string> {
    if (
      payload.sessionBindingVersion !== undefined &&
      payload.sessionBindingVersion !== SESSION_BINDING_VERSION
    ) {
      throw new TypeError("Unsupported sessionBindingVersion");
    }
    const issuedAt = Date.now();
    const expiresInMs = options.expiresInMs ?? ONE_YEAR_MS;
    const expirationSeconds = Math.floor((issuedAt + expiresInMs) / 1000);
    const secretKey = this.getSessionSecret();

    return (
      new SignJWT({
        userId: payload.userId,
        name: payload.name,
        sv: payload.sessionVersion,
        ...(payload.sessionFenceDigest === undefined
          ? {}
          : { sf: payload.sessionFenceDigest }),
        ...(payload.sessionBindingVersion === undefined
          ? {}
          : { sessionBindingVersion: payload.sessionBindingVersion }),
      })
        .setProtectedHeader({ alg: "HS256", typ: "JWT" })
        // Dois logins do mesmo usuário/fence no mesmo segundo precisam continuar
        // sendo instâncias distintas para o constraint server-bound do cliente.
        .setJti(randomBytes(16).toString("base64url"))
        .setExpirationTime(expirationSeconds)
        .sign(secretKey)
    );
  }

  async verifySession(
    cookieValue: string | undefined | null,
  ): Promise<VerifiedSession | null> {
    if (!cookieValue) {
      console.warn("[Auth] Missing session cookie");
      return null;
    }

    try {
      const secretKey = this.getSessionSecret();
      const { payload } = await jwtVerify(cookieValue, secretKey, {
        algorithms: ["HS256"],
      });
      const { userId, name, sv, sf, sessionBindingVersion } = payload as Record<
        string,
        unknown
      >;

      if (!isNonEmptyString(userId) || !isNonEmptyString(name)) {
        console.warn("[Auth] Session payload missing required fields");
        return null;
      }

      // Sessões emitidas antes da versão de sessão (sem `sv`) valem como v1.
      const sessionVersion =
        typeof sv === "number" && Number.isFinite(sv) ? sv : 1;
      const sessionFenceDigest =
        typeof sf === "string" && sf.length > 0 ? sf : undefined;
      const hasSessionBindingVersion = Object.prototype.hasOwnProperty.call(
        payload,
        "sessionBindingVersion",
      );
      if (
        hasSessionBindingVersion &&
        sessionBindingVersion !== SESSION_BINDING_VERSION
      ) {
        console.warn("[Auth] Unsupported session binding version");
        return null;
      }
      return {
        userId,
        name,
        sessionVersion,
        sessionFenceDigest,
        sessionBindingVersion: hasSessionBindingVersion
          ? SESSION_BINDING_VERSION
          : null,
      };
    } catch (error) {
      console.warn("[Auth] Session verification failed", String(error));
      return null;
    }
  }

  /**
   * Identidade criptograficamente autenticada usada apenas para vincular a
   * limpeza local depois de um logout idempotente. `currentDate=epoch` ignora
   * expiração, mas não assinatura/algoritmo; este valor jamais autentica uma
   * request, publica UI ou autoriza mutação de conta.
   */
  async verifiedSessionUserIdHint(
    token: string | undefined | null,
  ): Promise<number | null> {
    if (!token) return null;
    try {
      const { payload } = await jwtVerify(token, this.getSessionSecret(), {
        algorithms: ["HS256"],
        currentDate: new Date(0),
      });
      const rawUserId = payload.userId;
      if (typeof rawUserId !== "string" || !rawUserId.trim()) return null;
      const userId = Number(rawUserId);
      return Number.isSafeInteger(userId) &&
        userId > 0 &&
        String(userId) === rawUserId
        ? userId
        : null;
    } catch {
      return null;
    }
  }

  /**
   * Synchronous, non-authoritative hint used only to fail closed before the
   * logout route performs its immediate fence rotation. Identity and mutation
   * still depend exclusively on `verifySession`.
   */
  sessionBindingVersionHint(
    token: string | undefined,
  ): SessionBindingVersion | null {
    if (!token) return null;
    try {
      return decodeJwt(token).sessionBindingVersion === SESSION_BINDING_VERSION
        ? SESSION_BINDING_VERSION
        : null;
    } catch {
      return null;
    }
  }

  async authenticateRequest(
    req: Request,
    options: AuthenticateRequestOptions = {},
  ): Promise<User> {
    authenticatedSessionCredentials.delete(req);
    const credentials = this.readRequestCredentials(req);
    if (credentials.testUserId !== null) {
      const dbInstance = await this.requireAuthenticationDb();
      const [testUser] = await this.runAuthenticationQuery(() =>
        dbInstance
          .select()
          .from(users)
          .where(eq(users.id, credentials.testUserId!)),
      );
      if (testUser) {
        this.assertAuthenticatedUser(testUser, options, {
          kind: "TEST_BYPASS",
        });
        assertExpectedUserConstraint(
          req.headers[EXPECTED_USER_ID_HEADER],
          testUser.id,
        );
        assertSessionInstanceConstraint(
          req.headers[SESSION_INSTANCE_HEADER],
          undefined,
        );
        this.logTestBypass(testUser);
        return testUser;
      }
    }

    const session = await this.verifySession(credentials.sessionCookie);

    if (!session) {
      throw new ForbiddenError("Invalid session");
    }

    const dbInstance = await this.requireAuthenticationDb();
    const [user] = await this.runAuthenticationQuery(() =>
      dbInstance
        .select()
        .from(users)
        .where(eq(users.id, Number(session.userId))),
    );

    if (!user) {
      throw new ForbiddenError("User not found");
    }

    this.assertAuthenticatedUser(user, options, {
      kind: "SESSION",
      session,
      transport: credentials.sessionTransport!,
      requestFence: credentials.sessionFence,
    });
    assertExpectedUserConstraint(req.headers[EXPECTED_USER_ID_HEADER], user.id);
    assertSessionInstanceConstraint(
      req.headers[SESSION_INSTANCE_HEADER],
      credentials.sessionCookie,
      {
        required:
          session.sessionBindingVersion === SESSION_BINDING_VERSION &&
          credentials.sessionTransport === "COOKIE" &&
          !this.isSessionInstanceBootstrapRequest(req, options),
      },
    );
    authenticatedSessionCredentials.set(req, {
      token: credentials.sessionCookie!,
      sessionBindingVersion: session.sessionBindingVersion,
    });

    return user;
  }

  /** Prova da credencial exata autenticada nesta mesma Request. */
  sessionInstanceProofForAuthenticatedRequest(req: Request): string | null {
    const credential = authenticatedSessionCredentials.get(req);
    return credential ? sessionInstanceProof(credential.token) : null;
  }

  /** Versão assinada da credencial exata autenticada nesta mesma Request. */
  sessionBindingVersionForAuthenticatedRequest(
    req: Request,
  ): SessionBindingVersion | null {
    return (
      authenticatedSessionCredentials.get(req)?.sessionBindingVersion ?? null
    );
  }

  /**
   * Autentica e carrega os vínculos institucionais na mesma ida ao banco.
   * O usuário base vem por LEFT JOIN mesmo sem vínculo; somente a cadeia
   * professional ↔ PI ativa ↔ instituição ativa produz autoridade de tenant.
   */
  async authenticateRequestWithActiveMemberships(
    req: Request,
    options: Pick<AuthenticateRequestOptions, "allowMustChangePassword"> = {},
  ): Promise<{ user: User; activeMemberships: ActiveInstitutionMembership[] }> {
    authenticatedSessionCredentials.delete(req);
    const credentials = this.readRequestCredentials(req);
    const testUserId = credentials.testUserId;
    const session = credentials.sessionCookie
      ? await this.verifySession(credentials.sessionCookie)
      : null;
    const sessionUserId = session ? Number(session.userId) : null;

    const candidateIds = Array.from(
      new Set(
        [testUserId, sessionUserId].filter(
          (id): id is number =>
            typeof id === "number" && Number.isInteger(id) && id > 0,
        ),
      ),
    );
    if (candidateIds.length === 0) {
      throw new ForbiddenError("Invalid session");
    }

    const dbInstance = await this.requireAuthenticationDb();
    const rows = await this.runAuthenticationQuery(() =>
      dbInstance
        .select({
          user: users,
          professionalId: professionals.id,
          membershipInstitutionId: professionalInstitutions.institutionId,
          membershipIsPrimary: professionalInstitutions.isPrimary,
          activeInstitutionId: institutions.id,
        })
        .from(users)
        .leftJoin(professionals, eq(professionals.userId, users.id))
        .leftJoin(
          professionalInstitutions,
          and(
            eq(professionalInstitutions.userId, users.id),
            eq(professionalInstitutions.professionalId, professionals.id),
            eq(professionalInstitutions.active, true),
          ),
        )
        .leftJoin(
          institutions,
          and(
            eq(institutions.id, professionalInstitutions.institutionId),
            eq(institutions.isActive, true),
          ),
        )
        .where(inArray(users.id, candidateIds)),
    );

    const testUserRow =
      testUserId === null
        ? undefined
        : rows.find((row) => row.user.id === testUserId);
    const selectedUser =
      testUserRow?.user ??
      (sessionUserId === null
        ? undefined
        : rows.find((row) => row.user.id === sessionUserId)?.user);
    if (!selectedUser) {
      throw new ForbiddenError("User not found");
    }
    const usingTestBypass = Boolean(testUserRow);
    if (!usingTestBypass) {
      if (!session || selectedUser.id !== sessionUserId) {
        throw new ForbiddenError("Invalid session");
      }
      this.assertAuthenticatedUser(selectedUser, options, {
        kind: "SESSION",
        session,
        transport: credentials.sessionTransport!,
        requestFence: credentials.sessionFence,
      });
    } else {
      this.assertAuthenticatedUser(selectedUser, options, {
        kind: "TEST_BYPASS",
      });
    }
    assertExpectedUserConstraint(
      req.headers[EXPECTED_USER_ID_HEADER],
      selectedUser.id,
    );
    assertSessionInstanceConstraint(
      req.headers[SESSION_INSTANCE_HEADER],
      usingTestBypass ? undefined : credentials.sessionCookie,
      {
        required:
          session?.sessionBindingVersion === SESSION_BINDING_VERSION &&
          credentials.sessionTransport === "COOKIE",
      },
    );
    if (usingTestBypass) {
      this.logTestBypass(selectedUser);
    } else {
      authenticatedSessionCredentials.set(req, {
        token: credentials.sessionCookie!,
        sessionBindingVersion: session!.sessionBindingVersion,
      });
    }

    const activeMemberships =
      selectedUser.approvalStatus === "APPROVED"
        ? Array.from(
            new Map(
              rows
                .filter(
                  (row) =>
                    row.user.id === selectedUser.id &&
                    row.professionalId !== null &&
                    row.membershipInstitutionId !== null &&
                    row.activeInstitutionId === row.membershipInstitutionId,
                )
                .map((row) => [
                  `${row.membershipInstitutionId}:${row.professionalId}`,
                  {
                    institutionId: row.membershipInstitutionId!,
                    professionalId: row.professionalId!,
                    isPrimary: row.membershipIsPrimary === true,
                  },
                ]),
            ).values(),
          ).sort(
            (left, right) =>
              Number(right.isPrimary) - Number(left.isPrimary) ||
              left.institutionId - right.institutionId ||
              left.professionalId - right.professionalId,
          )
        : [];

    return { user: selectedUser, activeMemberships };
  }
}

export const sdk = new SDKServer();

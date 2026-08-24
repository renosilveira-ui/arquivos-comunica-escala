import {
  COOKIE_NAME,
  ONE_YEAR_MS,
  SESSION_FENCE_COOKIE_NAME,
} from "../../shared/const.js";
import { ForbiddenError } from "../../shared/_core/errors.js";
import { parse as parseCookieHeader } from "cookie";
import type { Request } from "express";
import { SignJWT, jwtVerify } from "jose";
import { createHash } from "node:crypto";
import {
  users,
  type User,
} from "../../drizzle/schema";
import { eq } from "drizzle-orm";
import { getDb } from "../db";
import { ENV } from "./env";

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

export type SessionPayload = {
  userId: string;
  name: string;
  /** users.session_version no momento da emissão; sessões com `sv` antigo são rejeitadas. */
  sessionVersion: number;
  /** Digest do cookie host-only observado na emissão; ausente apenas em JWT legado. */
  sessionFenceDigest?: string;
};

export type AuthenticateRequestOptions = {
  /**
   * Used only by the small credential-recovery surface (me, logout and
   * change-password). Operational APIs must keep the default fail-closed.
   */
  allowMustChangePassword?: boolean;
};

type VerifiedSession = {
  userId: string;
  name: string;
  sessionVersion: number;
  sessionFenceDigest?: string;
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
    const testUserIdHeader = process.env.NODE_ENV === "development"
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
    if (authentication.kind === "SESSION" && authentication.transport === "COOKIE") {
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
    } = {},
  ): Promise<string> {
    // Sem a versão informada, lê a atual do banco — nunca emitir sessão
    // com versão velha (seria rejeitada na próxima requisição).
    let sessionVersion = options.sessionVersion;
    if (sessionVersion === undefined) {
      const dbInstance = await getDb();
      const [row] = dbInstance
        ? await dbInstance.select({ sessionVersion: users.sessionVersion }).from(users).where(eq(users.id, Number(userId)))
        : [];
      sessionVersion = row?.sessionVersion ?? 1;
    }
    return this.signSession({
      userId,
      name: options.name || "",
      sessionVersion,
      sessionFenceDigest: options.sessionFenceDigest,
    }, options);
  }

  async signSession(
    payload: SessionPayload,
    options: { expiresInMs?: number } = {},
  ): Promise<string> {
    const issuedAt = Date.now();
    const expiresInMs = options.expiresInMs ?? ONE_YEAR_MS;
    const expirationSeconds = Math.floor((issuedAt + expiresInMs) / 1000);
    const secretKey = this.getSessionSecret();

    return new SignJWT({
      userId: payload.userId,
      name: payload.name,
      sv: payload.sessionVersion,
      ...(payload.sessionFenceDigest === undefined
        ? {}
        : { sf: payload.sessionFenceDigest }),
    })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setExpirationTime(expirationSeconds)
      .sign(secretKey);
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
      const { userId, name, sv, sf } = payload as Record<string, unknown>;

      if (!isNonEmptyString(userId) || !isNonEmptyString(name)) {
        console.warn("[Auth] Session payload missing required fields");
        return null;
      }

      // Sessões emitidas antes da versão de sessão (sem `sv`) valem como v1.
      const sessionVersion = typeof sv === "number" && Number.isFinite(sv) ? sv : 1;
      const sessionFenceDigest = typeof sf === "string" && sf.length > 0
        ? sf
        : undefined;
      return { userId, name, sessionVersion, sessionFenceDigest };
    } catch (error) {
      console.warn("[Auth] Session verification failed", String(error));
      return null;
    }
  }

  async authenticateRequest(
    req: Request,
    options: AuthenticateRequestOptions = {},
  ): Promise<User> {
    const credentials = this.readRequestCredentials(req);
    if (credentials.testUserId !== null) {
      const dbInstance = await getDb();
      if (dbInstance) {
        const [testUser] = await dbInstance
          .select()
          .from(users)
          .where(eq(users.id, credentials.testUserId));
        if (testUser) {
          this.assertAuthenticatedUser(testUser, options, { kind: "TEST_BYPASS" });
          this.logTestBypass(testUser);
          return testUser;
        }
      }
    }

    const session = await this.verifySession(credentials.sessionCookie);

    if (!session) {
      throw new ForbiddenError("Invalid session");
    }

    const dbInstance = await getDb();
    if (!dbInstance) {
      throw new ForbiddenError("Database unavailable");
    }

    const [user] = await dbInstance
      .select()
      .from(users)
      .where(eq(users.id, Number(session.userId)));

    if (!user) {
      throw new ForbiddenError("User not found");
    }

    this.assertAuthenticatedUser(user, options, {
      kind: "SESSION",
      session,
      transport: credentials.sessionTransport!,
      requestFence: credentials.sessionFence,
    });

    return user;
  }

}

export const sdk = new SDKServer();

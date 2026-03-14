import { COOKIE_NAME, ONE_YEAR_MS } from "../../shared/const.js";
import { ForbiddenError } from "../../shared/_core/errors.js";
import { parse as parseCookieHeader } from "cookie";
import type { Request } from "express";
import { SignJWT, jwtVerify } from "jose";
import { users, type User } from "../../drizzle/schema";
import { eq } from "drizzle-orm";
import { getDb } from "../db";
import { ENV } from "./env";

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

export type SessionPayload = {
  userId: string;
  name: string;
};

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

  async createSessionToken(
    userId: string,
    options: { expiresInMs?: number; name?: string } = {},
  ): Promise<string> {
    return this.signSession({ userId, name: options.name || "" }, options);
  }

  async signSession(
    payload: SessionPayload,
    options: { expiresInMs?: number } = {},
  ): Promise<string> {
    const issuedAt = Date.now();
    const expiresInMs = options.expiresInMs ?? ONE_YEAR_MS;
    const expirationSeconds = Math.floor((issuedAt + expiresInMs) / 1000);
    const secretKey = this.getSessionSecret();

    return new SignJWT({ userId: payload.userId, name: payload.name })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setExpirationTime(expirationSeconds)
      .sign(secretKey);
  }

  async verifySession(
    cookieValue: string | undefined | null,
  ): Promise<{ userId: string; name: string } | null> {
    if (!cookieValue) {
      console.warn("[Auth] Missing session cookie");
      return null;
    }

    try {
      const secretKey = this.getSessionSecret();
      const { payload } = await jwtVerify(cookieValue, secretKey, {
        algorithms: ["HS256"],
      });
      const { userId, name } = payload as Record<string, unknown>;

      if (!isNonEmptyString(userId) || !isNonEmptyString(name)) {
        console.warn("[Auth] Session payload missing required fields");
        return null;
      }

      return { userId, name };
    } catch (error) {
      console.warn("[Auth] Session verification failed", String(error));
      return null;
    }
  }

  async authenticateRequest(req: Request): Promise<User> {
    // Dev bypass: x-test-user-id header
    if (process.env.NODE_ENV === "development") {
      const testUserIdHeader = req.headers["x-test-user-id"];
      if (typeof testUserIdHeader === "string" && testUserIdHeader.trim()) {
        const dbInstance = await getDb();
        if (dbInstance) {
          const [testUser] = await dbInstance
            .select()
            .from(users)
            .where(eq(users.id, Number(testUserIdHeader.trim())));
          if (testUser) {
            console.log("[Auth] Test mode: authenticated as user", testUser.id, testUser.name);
            return testUser;
          }
        }
      }
    }

    const authHeader = req.headers.authorization;
    let token: string | undefined;
    if (typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
      token = authHeader.slice("Bearer ".length).trim();
    }

    const cookies = this.parseCookies(req.headers.cookie);
    const sessionCookie = token || cookies.get(COOKIE_NAME);
    const session = await this.verifySession(sessionCookie);

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

    return user;
  }
}

export const sdk = new SDKServer();

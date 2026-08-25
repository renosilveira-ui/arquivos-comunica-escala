import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, or } from "drizzle-orm";
import bcrypt from "bcryptjs";
import express, { type Express } from "express";
import request, { type Response as SupertestResponse } from "supertest";
import { SignJWT } from "jose";
import {
  auditTrail,
  institutions,
  professionalInstitutions,
  professionals,
  pushTokens,
  users,
} from "../drizzle/schema";
import { sdk } from "../server/_core/sdk";
import { ENV } from "../server/_core/env";
import { sessionInstanceProof } from "../server/_core/session-instance";
import * as auditService from "../server/audit-trail";
import {
  registerPushToken,
  sendPushNotification,
} from "../server/notifications-service";
import * as pushRevocationService from "../server/push-registration-revocation";
import * as dbService from "../server/db";
import { getDb } from "../server/db";
import { authRouter } from "../server/routes/auth";

const STAMP = Date.now();
const EMAIL = `session-fence-${STAMP}@test.local`;
const PASSWORD = "SessionFenceOriginal123";
const ROTATED_PASSWORD = "SessionFenceRotated456";
const FINAL_PASSWORD = "SessionFenceFinal789";

function deferredVoid() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function expoTicketResponse(ticketId: string): Response {
  return {
    ok: true,
    status: 200,
    json: vi.fn(async () => ({ data: { status: "ok", id: ticketId } })),
  } as unknown as Response;
}

async function waitForPushLockWaiter(
  db: NonNullable<Awaited<ReturnType<typeof getDb>>>,
  targetUserId: number,
): Promise<void> {
  const marker = `escala-push-user:${targetUserId}`;
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const [rows] = await db.execute("SHOW FULL PROCESSLIST");
    const waiting = (rows as { Info?: unknown }[]).some(
      (row) =>
        typeof row.Info === "string" &&
        row.Info.includes("GET_LOCK") &&
        row.Info.includes(marker),
    );
    if (waiting) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(
    `Waiter do mutex push não observado para userId=${targetUserId}`,
  );
}

function setCookieHeaders(response: SupertestResponse): string[] {
  const header = response.headers["set-cookie"];
  return Array.isArray(header) ? header : header ? [header] : [];
}

function cookiePair(response: SupertestResponse, name: string): string {
  const header = setCookieHeaders(response).find((candidate) =>
    candidate.startsWith(`${name}=`),
  );
  if (!header) throw new Error(`Cookie ${name} ausente`);
  return header.split(";", 1)[0]!;
}

function cookieHeader(...pairs: string[]): string {
  return pairs.join("; ");
}

function proofForCookieHeader(cookie: string): string {
  const sessionPair = cookie
    .split(/;\s*/)
    .find((pair) => pair.startsWith("session="));
  const token = sessionPair?.slice("session=".length);
  if (!token) throw new Error("Token de sessão ausente no cookie de teste");
  return sessionInstanceProof(token);
}

describe("fence linearizável da sessão web", () => {
  let app: Express;
  let db: NonNullable<Awaited<ReturnType<typeof getDb>>>;
  let userId: number;
  let professionalId: number;
  let institutionId: number;

  async function exactLogin() {
    const previous = process.env.SESSION_EXACT_BINDING_SUPPORTED;
    process.env.SESSION_EXACT_BINDING_SUPPORTED = "1";
    try {
      return await request(app)
        .post("/api/auth/login")
        .set("x-client-session-protocol", "exact-v1")
        .send({ email: EMAIL, password: PASSWORD });
    } finally {
      if (previous === undefined) {
        delete process.env.SESSION_EXACT_BINDING_SUPPORTED;
      } else {
        process.env.SESSION_EXACT_BINDING_SUPPORTED = previous;
      }
    }
  }

  beforeAll(async () => {
    const connection = await getDb();
    if (!connection) throw new Error("Database not available");
    db = connection;
    app = express();
    app.use(express.json());
    app.use("/api/auth", authRouter);

    const [institution] = await db
      .insert(institutions)
      .values({
        name: `Session fence ${STAMP}`,
        cnpj: `${STAMP}97`.slice(-14).padStart(14, "0"),
        legalName: `Session fence ${STAMP}`,
        tradeName: `FENCE${STAMP}`.slice(0, 20),
        isActive: true,
      })
      .$returningId();
    institutionId = institution.id;

    const [user] = await db
      .insert(users)
      .values({
        name: "Session Fence User",
        email: EMAIL,
        passwordHash: await bcrypt.hash(PASSWORD, 4),
        loginMethod: "email",
        role: "doctor",
        approvalStatus: "APPROVED",
        sessionVersion: 1,
      })
      .$returningId();
    userId = user.id;

    const [professional] = await db
      .insert(professionals)
      .values({
        userId,
        name: "Session Fence User",
        role: "Médico",
        userRole: "USER",
      })
      .$returningId();
    professionalId = professional.id;
    await db.insert(professionalInstitutions).values({
      professionalId,
      userId,
      institutionId,
      roleInInstitution: "USER",
      isPrimary: true,
      active: true,
    });
  });

  afterAll(async () => {
    await db.delete(pushTokens).where(eq(pushTokens.userId, userId));
    await db
      .delete(auditTrail)
      .where(
        or(eq(auditTrail.actorUserId, userId), eq(auditTrail.entityId, userId)),
      );
    await db
      .delete(professionalInstitutions)
      .where(eq(professionalInstitutions.userId, userId));
    await db.delete(professionals).where(eq(professionals.userId, userId));
    await db.delete(users).where(eq(users.id, userId));
    await db.delete(institutions).where(eq(institutions.id, institutionId));
  });

  it("emite JWT e proof distintos sob relógio e claims idênticos", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    let first: string;
    let second: string;
    try {
      [first, second] = await Promise.all([
        sdk.signSession({
          userId: String(userId),
          name: "Session Fence User",
          sessionVersion: 1,
        }),
        sdk.signSession({
          userId: String(userId),
          name: "Session Fence User",
          sessionVersion: 1,
        }),
      ]);
    } finally {
      clock.mockRestore();
    }
    expect(first!).not.toBe(second!);
    expect(sessionInstanceProof(first!)).not.toBe(
      sessionInstanceProof(second!),
    );
  });

  it("mantém jti e proof distintos com claims exact-v1 idênticas", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    let first: string;
    let second: string;
    try {
      [first, second] = await Promise.all([
        sdk.signSession({
          userId: String(userId),
          name: "Session Fence User",
          sessionVersion: 1,
          sessionBindingVersion: 1,
        }),
        sdk.signSession({
          userId: String(userId),
          name: "Session Fence User",
          sessionVersion: 1,
          sessionBindingVersion: 1,
        }),
      ]);
    } finally {
      clock.mockRestore();
    }

    expect(first!).not.toBe(second!);
    expect(sessionInstanceProof(first!)).not.toBe(
      sessionInstanceProof(second!),
    );
    await expect(sdk.verifySession(first!)).resolves.toMatchObject({
      sessionBindingVersion: 1,
    });
    await expect(sdk.verifySession(second!)).resolves.toMatchObject({
      sessionBindingVersion: 1,
    });
  });

  it("rejeita versão de binding desconhecida na emissão e na verificação", async () => {
    await expect(
      sdk.signSession({
        userId: String(userId),
        name: "Session Fence User",
        sessionVersion: 1,
        sessionBindingVersion: 2 as 1,
      }),
    ).rejects.toThrow("Unsupported sessionBindingVersion");

    const malformed = await new SignJWT({
      userId: String(userId),
      name: "Session Fence User",
      sv: 1,
      sessionBindingVersion: "1",
    })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode(ENV.cookieSecret));
    await expect(sdk.verifySession(malformed)).resolves.toBeNull();
  });

  it("/me publica a proof do cookie realmente autenticado quando Bearer vazio cai no cookie", async () => {
    const login = await request(app)
      .post("/api/auth/login")
      .send({ email: EMAIL, password: PASSWORD });
    expect(login.status).toBe(200);
    const session = cookiePair(login, "session");
    const me = await request(app)
      .get("/api/auth/me")
      .set("Authorization", "Bearer ")
      .set("Cookie", session);
    expect(me.status).toBe(200);
    expect(me.headers["cache-control"]).toBe("no-store");
    expect(me.body).toMatchObject({
      sessionInstance: proofForCookieHeader(session),
      user: { id: userId },
    });
  });

  it("v1 cookie sem proof bloqueia logout antes de fence, versão ou auditoria; Bearer continua nativo", async () => {
    const login = await exactLogin();
    expect(login.status).toBe(200);
    const session = cookiePair(login, "session");
    const [beforeUser] = await db
      .select({ sessionVersion: users.sessionVersion })
      .from(users)
      .where(eq(users.id, userId));
    const beforeAudits = await db
      .select({ id: auditTrail.id })
      .from(auditTrail)
      .where(
        eq(auditTrail.description, "Sessões encerradas pelo próprio usuário"),
      );

    const missing = await request(app)
      .post("/api/auth/logout")
      .set("Cookie", session)
      .send({});
    expect(missing.status).toBe(428);
    expect(missing.body).toMatchObject({ code: "SESSION_INSTANCE_REQUIRED" });
    expect(setCookieHeaders(missing)).toEqual([]);
    expect(
      (
        await db
          .select({ sessionVersion: users.sessionVersion })
          .from(users)
          .where(eq(users.id, userId))
      )[0],
    ).toEqual(beforeUser);
    expect(
      await db
        .select({ id: auditTrail.id })
        .from(auditTrail)
        .where(
          eq(auditTrail.description, "Sessões encerradas pelo próprio usuário"),
        ),
    ).toEqual(beforeAudits);

    const native = await request(app)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${login.body.token}`);
    expect(native.status).toBe(200);
    expect(native.body.sessionBinding.sessionVersion).toBe(1);
  });

  it("recovery limpa cookie exact já revogado sem proof, sem tocar versão, push ou auditoria", async () => {
    const login = await exactLogin();
    expect(login.status).toBe(200);
    const session = cookiePair(login, "session");
    const [issued] = await db
      .select({ sessionVersion: users.sessionVersion })
      .from(users)
      .where(eq(users.id, userId));
    const revokedSessionVersion = issued.sessionVersion + 1;
    await db
      .update(users)
      .set({ sessionVersion: revokedSessionVersion })
      .where(eq(users.id, userId));
    const pushToken = `ExponentPushToken[exact-stale-recovery-${STAMP}]`;
    await db.insert(pushTokens).values({
      institutionId,
      userId,
      token: pushToken,
      platform: "ios",
    });
    try {
      const auditsBefore = await db
        .select({ id: auditTrail.id })
        .from(auditTrail)
        .where(
          and(
            eq(auditTrail.entityId, userId),
            eq(
              auditTrail.description,
              "Sessões encerradas pelo próprio usuário",
            ),
          ),
        );

      await expect(
        request(app).get("/api/auth/me").set("Cookie", session),
      ).resolves.toMatchObject({ status: 401 });
      const logout = await request(app)
        .post("/api/auth/logout")
        .set("Cookie", session)
        .set("x-client-expected-user-id", String(userId))
        .send({});

      expect(logout.status).toBe(200);
      expect(logout.body).toMatchObject({
        ok: true,
        sessionFenceRotated: true,
        revocation: "ALREADY_INVALID",
        revocationUserId: userId,
      });
      expect(
        setCookieHeaders(logout).some(
          (header) =>
            header.startsWith("session=") &&
            /Expires=Thu, 01 Jan 1970|Max-Age=0/i.test(header),
        ),
      ).toBe(true);
      expect(
        (
          await db
            .select({ sessionVersion: users.sessionVersion })
            .from(users)
            .where(eq(users.id, userId))
        )[0],
      ).toEqual({ sessionVersion: revokedSessionVersion });
      expect(
        await db
          .select({ id: pushTokens.id })
          .from(pushTokens)
          .where(eq(pushTokens.token, pushToken)),
      ).toHaveLength(1);
      expect(
        await db
          .select({ id: auditTrail.id })
          .from(auditTrail)
          .where(
            and(
              eq(auditTrail.entityId, userId),
              eq(
                auditTrail.description,
                "Sessões encerradas pelo próprio usuário",
              ),
            ),
          ),
      ).toEqual(auditsBefore);
    } finally {
      await db.delete(pushTokens).where(eq(pushTokens.token, pushToken));
      await db
        .update(users)
        .set({ sessionVersion: issued.sessionVersion })
        .where(eq(users.id, userId));
    }
  });

  it.each(["missing", "getDb", "query"] as const)(
    "checagem exact com infraestrutura %s falha 503 antes de Set-Cookie",
    async (failureKind) => {
      const login = await exactLogin();
      expect(login.status).toBe(200);
      const session = cookiePair(login, "session");
      const unavailable =
        failureKind === "missing"
          ? vi.spyOn(dbService, "getDb").mockResolvedValueOnce(null)
          : failureKind === "getDb"
            ? vi
                .spyOn(dbService, "getDb")
                .mockRejectedValueOnce(new Error("forced logout db outage"))
            : vi.spyOn(db, "select").mockImplementationOnce(() => {
                throw new Error("forced logout query outage");
              });

      let logout: SupertestResponse;
      try {
        logout = await request(app)
          .post("/api/auth/logout")
          .set("Cookie", session)
          .set("x-client-expected-user-id", String(userId))
          .send({});
      } finally {
        unavailable.mockRestore();
      }

      expect(logout.status).toBe(503);
      expect(logout.body).toMatchObject({
        code: "AUTHENTICATION_INFRASTRUCTURE_UNAVAILABLE",
      });
      expect(setCookieHeaders(logout)).toEqual([]);
      await expect(
        request(app)
          .get("/api/auth/me")
          .set("Cookie", session)
          .set("x-client-session-instance", proofForCookieHeader(session)),
      ).resolves.toMatchObject({ status: 200 });
    },
  );

  it("logout Bearer sem banco retorna 503 tipado e preserva a sessão", async () => {
    const login = await request(app)
      .post("/api/auth/login")
      .send({ email: EMAIL, password: PASSWORD });
    expect(login.status).toBe(200);
    const unavailable = vi
      .spyOn(dbService, "getDb")
      .mockResolvedValueOnce(null);

    let logout: SupertestResponse;
    try {
      logout = await request(app)
        .post("/api/auth/logout")
        .set("Authorization", `Bearer ${login.body.token}`)
        .send({});
    } finally {
      unavailable.mockRestore();
    }

    expect(logout.status).toBe(503);
    expect(logout.body).toMatchObject({
      code: "AUTHENTICATION_INFRASTRUCTURE_UNAVAILABLE",
    });
    await expect(
      request(app)
        .get("/api/auth/me")
        .set("Authorization", `Bearer ${login.body.token}`),
    ).resolves.toMatchObject({ status: 200 });
  });

  it.each(["getDb", "query"] as const)(
    "/me projeta falha de infraestrutura %s como 503, nunca 401",
    async (failureKind) => {
      const login = await request(app)
        .post("/api/auth/login")
        .send({ email: EMAIL, password: PASSWORD });
      expect(login.status).toBe(200);

      const failure =
        failureKind === "getDb"
          ? vi
              .spyOn(dbService, "getDb")
              .mockRejectedValueOnce(
                new Error("forced authentication db outage"),
              )
          : vi.spyOn(db, "select").mockImplementationOnce(() => {
              throw new Error("forced authentication query outage");
            });
      let response: SupertestResponse;
      try {
        response = await request(app)
          .get("/api/auth/me")
          .set("Authorization", `Bearer ${login.body.token}`);
      } finally {
        failure.mockRestore();
      }

      expect(response.status).toBe(503);
      expect(response.body).toMatchObject({
        code: "AUTHENTICATION_INFRASTRUCTURE_UNAVAILABLE",
      });
      await expect(
        request(app)
          .get("/api/auth/me")
          .set("Authorization", `Bearer ${login.body.token}`),
      ).resolves.toMatchObject({ status: 200 });
    },
  );

  it("aceita JWT legado apenas sem fence e emite fence host-only no logout", async () => {
    const legacy = await sdk.signSession({
      userId: String(userId),
      name: "Session Fence User",
      sessionVersion: 1,
    });
    await expect(
      request(app).get("/api/auth/me").set("Cookie", `session=${legacy}`),
    ).resolves.toMatchObject({ status: 200 });
    await expect(
      request(app)
        .get("/api/auth/me")
        .set(
          "Cookie",
          cookieHeader(`session=${legacy}`, "session_fence=rotated"),
        ),
    ).resolves.toMatchObject({ status: 401 });

    const currentLogin = await request(app)
      .post("/api/auth/login")
      .send({ email: EMAIL, password: PASSWORD });
    const oldToken = currentLogin.body.token as string;
    const ownedPushTokens = [
      `ExponentPushToken[logout-success-a-${STAMP}]`,
      `ExponentPushToken[logout-success-b-${STAMP}]`,
    ];
    await db.insert(pushTokens).values([
      {
        institutionId,
        userId,
        token: ownedPushTokens[0],
        platform: "ios",
      },
      {
        institutionId,
        userId,
        token: ownedPushTokens[1],
        platform: "android",
      },
    ]);
    expect(
      await db
        .select({ id: pushTokens.id })
        .from(pushTokens)
        .where(eq(pushTokens.userId, userId)),
    ).toHaveLength(2);
    await expect(
      request(app)
        .get("/api/auth/me")
        .set(
          "Cookie",
          cookieHeader(
            cookiePair(currentLogin, "session"),
            "session_fence=%3Cmissing%3E",
          ),
        ),
    ).resolves.toMatchObject({ status: 401 });
    const logout = await request(app)
      .post("/api/auth/logout")
      .set("Cookie", cookiePair(currentLogin, "session"))
      .set("x-forwarded-proto", "https")
      .send({ pushToken: ownedPushTokens[0] });
    expect(logout.status).toBe(200);
    expect(logout.body).toMatchObject({ ok: true, sessionFenceRotated: true });
    const fenceHeader = setCookieHeaders(logout).find((header) =>
      header.startsWith("session_fence="),
    );
    expect(fenceHeader).toBeTruthy();
    expect(fenceHeader).toMatch(/HttpOnly/i);
    expect(fenceHeader).toMatch(/Secure/i);
    expect(fenceHeader).toMatch(/SameSite=/i);
    expect(fenceHeader).not.toMatch(/Domain=/i);
    expect(
      setCookieHeaders(logout).some(
        (header) =>
          header.startsWith("session=") &&
          /Expires=Thu, 01 Jan 1970|Max-Age=0/i.test(header),
      ),
    ).toBe(true);
    await expect(
      request(app)
        .get("/api/auth/me")
        .set("Cookie", cookiePair(currentLogin, "session")),
    ).resolves.toMatchObject({ status: 401 });
    await expect(
      request(app)
        .get("/api/auth/me")
        .set("Authorization", `Bearer ${oldToken}`),
    ).resolves.toMatchObject({ status: 401 });
    expect(
      await db
        .select({ id: pushTokens.id })
        .from(pushTokens)
        .where(eq(pushTokens.userId, userId)),
    ).toHaveLength(0);

    const [revoked] = await db
      .select({ sessionVersion: users.sessionVersion })
      .from(users)
      .where(eq(users.id, userId));
    expect(revoked.sessionVersion).toBe(2);
    const [logoutAudit] = await db
      .select({ metadata: auditTrail.metadata })
      .from(auditTrail)
      .where(
        and(
          eq(auditTrail.entityId, userId),
          eq(auditTrail.description, "Sessões encerradas pelo próprio usuário"),
        ),
      );
    expect(logoutAudit?.metadata).toMatchObject({
      sessionVersionBefore: 1,
      sessionVersionAfter: 2,
      revokedPushTokenCount: 2,
      transport: "COOKIE",
    });

    const fence = cookiePair(logout, "session_fence");
    const relogin = await request(app)
      .post("/api/auth/login")
      .set("Cookie", fence)
      .send({ email: EMAIL, password: PASSWORD });
    expect(relogin.status).toBe(200);
    expect(
      setCookieHeaders(relogin).some((header) =>
        header.startsWith("session_fence="),
      ),
    ).toBe(false);
    await expect(
      request(app)
        .get("/api/auth/me")
        .set("Cookie", cookieHeader(cookiePair(relogin, "session"), fence)),
    ).resolves.toMatchObject({ status: 200 });
    await expect(
      request(app)
        .get("/api/auth/me")
        .set("Authorization", `Bearer ${relogin.body.token}`),
    ).resolves.toMatchObject({ status: 200 });
  });

  it("expected-user divergente ou malformado não gira fence nem revoga a credencial", async () => {
    const login = await request(app)
      .post("/api/auth/login")
      .send({ email: EMAIL, password: PASSWORD });
    expect(login.status).toBe(200);
    const cookie = cookiePair(login, "session");
    const [beforeUser] = await db
      .select({ sessionVersion: users.sessionVersion })
      .from(users)
      .where(eq(users.id, userId));
    const beforeAudits = await db
      .select({ id: auditTrail.id })
      .from(auditTrail)
      .where(
        eq(auditTrail.description, "Sessões encerradas pelo próprio usuário"),
      );

    const divergent = await request(app)
      .post("/api/auth/logout")
      .set("Cookie", cookie)
      .set("x-client-expected-user-id", String(userId + 1))
      .send({});
    expect(divergent.status).toBe(409);
    expect(divergent.body).toMatchObject({
      code: "EXPECTED_USER_MISMATCH",
      currentSessionUserId: userId,
    });
    expect(setCookieHeaders(divergent)).toEqual([]);

    const malformed = await request(app)
      .post("/api/auth/logout")
      .set("Cookie", cookie)
      .set("x-client-expected-user-id", `0${userId}`)
      .send({});
    expect(malformed.status).toBe(400);
    expect(malformed.body).toMatchObject({
      code: "MALFORMED_EXPECTED_USER_ID",
    });
    expect(setCookieHeaders(malformed)).toEqual([]);

    const meDivergent = await request(app)
      .get("/api/auth/me")
      .set("Cookie", cookie)
      .set("x-client-expected-user-id", String(userId + 1));
    expect(meDivergent.status).toBe(409);
    expect(meDivergent.body).toMatchObject({
      code: "EXPECTED_USER_MISMATCH",
    });

    const [afterUser] = await db
      .select({ sessionVersion: users.sessionVersion })
      .from(users)
      .where(eq(users.id, userId));
    expect(afterUser).toEqual(beforeUser);
    expect(
      await db
        .select({ id: auditTrail.id })
        .from(auditTrail)
        .where(
          eq(auditTrail.description, "Sessões encerradas pelo próprio usuário"),
        ),
    ).toEqual(beforeAudits);
    await expect(
      request(app).get("/api/auth/me").set("Cookie", cookie),
    ).resolves.toMatchObject({ status: 200 });
  });

  it("logout explícito rejeita proof S1 sobre cookie S2 same-user sem girar fence ou revogar S2", async () => {
    const firstLogin = await exactLogin();
    const secondLogin = await exactLogin();
    expect(firstLogin.status).toBe(200);
    expect(secondLogin.status).toBe(200);
    const firstSession = cookiePair(firstLogin, "session");
    const secondSession = cookiePair(secondLogin, "session");
    expect(proofForCookieHeader(firstSession)).not.toBe(
      proofForCookieHeader(secondSession),
    );
    const [beforeUser] = await db
      .select({ sessionVersion: users.sessionVersion })
      .from(users)
      .where(eq(users.id, userId));
    const beforeAudits = await db
      .select({ id: auditTrail.id })
      .from(auditTrail)
      .where(
        eq(auditTrail.description, "Sessões encerradas pelo próprio usuário"),
      );

    const staleLogout = await request(app)
      .post("/api/auth/logout")
      .set("Cookie", secondSession)
      .set("x-client-expected-user-id", String(userId))
      .set("x-client-session-instance", proofForCookieHeader(firstSession))
      .send({});
    expect(staleLogout.status).toBe(409);
    expect(staleLogout.body).toMatchObject({
      code: "SESSION_INSTANCE_MISMATCH",
    });
    expect(setCookieHeaders(staleLogout)).toEqual([]);
    expect(
      (
        await db
          .select({ sessionVersion: users.sessionVersion })
          .from(users)
          .where(eq(users.id, userId))
      )[0],
    ).toEqual(beforeUser);
    expect(
      await db
        .select({ id: auditTrail.id })
        .from(auditTrail)
        .where(
          eq(auditTrail.description, "Sessões encerradas pelo próprio usuário"),
        ),
    ).toEqual(beforeAudits);
    await expect(
      request(app).get("/api/auth/me").set("Cookie", secondSession),
    ).resolves.toMatchObject({ status: 200 });
  });

  it("retry expected-user sem cookie após 2xx perdido continua idempotente", async () => {
    const login = await request(app)
      .post("/api/auth/login")
      .send({ email: EMAIL, password: PASSWORD });
    expect(login.status).toBe(200);

    const first = await request(app)
      .post("/api/auth/logout")
      .set("Cookie", cookiePair(login, "session"))
      .set("x-client-expected-user-id", String(userId))
      .send({});
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      ok: true,
      sessionFenceRotated: true,
      revocation: "ROTATED",
      revocationUserId: userId,
    });

    // Simula resposta 2xx perdida: o browser já descartou o cookie, mas o
    // cliente repete a mesma intenção bindada. Ausência de credencial não é B.
    const retry = await request(app)
      .post("/api/auth/logout")
      .set("x-client-expected-user-id", String(userId))
      .send({});
    expect(retry.status).toBe(200);
    expect(retry.body).toMatchObject({
      ok: true,
      sessionFenceRotated: true,
      revocation: "ALREADY_INVALID",
    });
  });

  it("login iniciado antes do logout não reinstala sessão utilizável no reload", async () => {
    const compareStarted = deferredVoid();
    const releaseCompare = deferredVoid();
    const originalCompare = bcrypt.compare.bind(bcrypt);
    let held = false;
    const compareSpy = vi.spyOn(bcrypt, "compare").mockImplementation((async (
      value: string,
      hash: string,
    ) => {
      if (!held && value === PASSWORD) {
        held = true;
        compareStarted.resolve();
        await releaseCompare.promise;
      }
      return originalCompare(value, hash);
    }) as typeof bcrypt.compare);

    try {
      const pendingLogin = request(app)
        .post("/api/auth/login")
        .send({ email: EMAIL, password: PASSWORD })
        .then((response) => response);
      await compareStarted.promise;

      const logout = await request(app).post("/api/auth/logout").send({});
      const rotatedFence = cookiePair(logout, "session_fence");
      releaseCompare.resolve();
      const staleLogin = await pendingLogin;
      expect(staleLogin.status).toBe(200);
      expect(
        setCookieHeaders(staleLogin).some((header) =>
          header.startsWith("session_fence="),
        ),
      ).toBe(false);

      const staleCookie = cookiePair(staleLogin, "session");
      const reload = await request(app)
        .get("/api/auth/me")
        .set("Cookie", cookieHeader(staleCookie, rotatedFence));
      expect(reload.status).toBe(401);

      // Bearer é o contrato mobile e não herda cookies acidentais.
      const mobile = await request(app)
        .get("/api/auth/me")
        .set("Authorization", `Bearer ${staleLogin.body.token}`)
        .set("Cookie", rotatedFence);
      expect(mobile.status).toBe(200);
    } finally {
      releaseCompare.resolve();
      compareSpy.mockRestore();
    }
  });

  it("logout sem sessão é idempotente e não apaga token push alheio", async () => {
    const victimPushToken = `ExponentPushToken[logout-victim-${STAMP}]`;
    await db.insert(pushTokens).values({
      institutionId,
      userId,
      token: victimPushToken,
      platform: "android",
    });
    const [before] = await db
      .select({ sessionVersion: users.sessionVersion })
      .from(users)
      .where(eq(users.id, userId));

    const missing = await request(app)
      .post("/api/auth/logout")
      .send({ pushToken: victimPushToken });
    const malformed = await request(app)
      .post("/api/auth/logout")
      .set("Authorization", "Bearer assinatura-invalida")
      .send({ pushToken: victimPushToken });

    expect(missing.status).toBe(200);
    expect(missing.body).toMatchObject({
      ok: true,
      sessionFenceRotated: true,
      revocation: "ALREADY_INVALID",
    });
    expect(malformed.status).toBe(200);
    expect(malformed.body).toMatchObject({
      ok: true,
      sessionFenceRotated: true,
      revocation: "ALREADY_INVALID",
    });
    expect(malformed.body).not.toHaveProperty("revocationUserId");
    expect(
      await db
        .select({ id: pushTokens.id })
        .from(pushTokens)
        .where(eq(pushTokens.token, victimPushToken)),
    ).toHaveLength(1);
    const [after] = await db
      .select({ sessionVersion: users.sessionVersion })
      .from(users)
      .where(eq(users.id, userId));
    expect(after.sessionVersion).toBe(before.sessionVersion);
    await db.delete(pushTokens).where(eq(pushTokens.token, victimPushToken));
  });

  it("logout de JWT assinado expirado retorna ALREADY_INVALID com identidade só para cleanup", async () => {
    const expired = await sdk.signSession(
      {
        userId: String(userId),
        name: "Session Fence User",
        sessionVersion: 1,
      },
      { expiresInMs: -1_000 },
    );

    const response = await request(app)
      .post("/api/auth/logout")
      .set("Authorization", `Bearer ${expired}`)
      .send({});

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      ok: true,
      revocation: "ALREADY_INVALID",
      revocationUserId: userId,
    });
  });

  it("falha de auditoria reverte revogação e não publica prova nem remove push", async () => {
    const browser = request.agent(app);
    const fenceSetup = await browser.post("/api/auth/logout").send({});
    const stableFence = cookiePair(fenceSetup, "session_fence");
    const login = await browser
      .post("/api/auth/login")
      .send({ email: EMAIL, password: PASSWORD });
    expect(login.status).toBe(200);
    const pushToken = `ExponentPushToken[logout-audit-rollback-${STAMP}]`;
    await db.insert(pushTokens).values({
      institutionId,
      userId,
      token: pushToken,
      platform: "ios",
    });
    const [before] = await db
      .select({ sessionVersion: users.sessionVersion })
      .from(users)
      .where(eq(users.id, userId));
    const auditFailure = vi
      .spyOn(auditService, "recordAudit")
      .mockRejectedValueOnce(new Error("forced logout audit failure"));

    let failed: SupertestResponse;
    try {
      failed = await browser.post("/api/auth/logout").send({ pushToken });
    } finally {
      auditFailure.mockRestore();
    }

    expect(failed.status).toBe(500);
    expect(failed.body).toEqual({ error: "Falha ao encerrar sessão" });
    expect(
      setCookieHeaders(failed).some(
        (header) =>
          header.startsWith("session=") &&
          /Expires=Thu, 01 Jan 1970|Max-Age=0/i.test(header),
      ),
    ).toBe(false);
    const failureFenceHeaders = setCookieHeaders(failed).filter((header) =>
      header.startsWith("session_fence="),
    );
    expect(failureFenceHeaders).toHaveLength(2);
    expect(failureFenceHeaders.at(-1)?.split(";", 1)[0]).toBe(stableFence);
    const [after] = await db
      .select({ sessionVersion: users.sessionVersion })
      .from(users)
      .where(eq(users.id, userId));
    expect(after.sessionVersion).toBe(before.sessionVersion);
    await expect(
      request(app)
        .get("/api/auth/me")
        .set("Authorization", `Bearer ${login.body.token}`),
    ).resolves.toMatchObject({ status: 200 });
    await expect(browser.get("/api/auth/me")).resolves.toMatchObject({
      status: 200,
    });
    expect(
      await db
        .select({ id: pushTokens.id })
        .from(pushTokens)
        .where(eq(pushTokens.token, pushToken)),
    ).toHaveLength(1);
    await db.delete(pushTokens).where(eq(pushTokens.token, pushToken));
  });

  it("falha ao apagar registros push reverte sessionVersion e auditoria", async () => {
    const login = await request(app)
      .post("/api/auth/login")
      .send({ email: EMAIL, password: PASSWORD });
    expect(login.status).toBe(200);
    const rollbackTokens = [
      `ExponentPushToken[logout-delete-rollback-a-${STAMP}]`,
      `ExponentPushToken[logout-delete-rollback-b-${STAMP}]`,
    ];
    await db.insert(pushTokens).values([
      {
        institutionId,
        userId,
        token: rollbackTokens[0],
        platform: "ios",
      },
      {
        institutionId,
        userId,
        token: rollbackTokens[1],
        platform: "android",
      },
    ]);
    const [beforeUser] = await db
      .select({ sessionVersion: users.sessionVersion })
      .from(users)
      .where(eq(users.id, userId));
    const beforeAudits = await db
      .select({ id: auditTrail.id })
      .from(auditTrail)
      .where(
        eq(auditTrail.description, "Sessões encerradas pelo próprio usuário"),
      );
    const deleteFailure = vi
      .spyOn(pushRevocationService, "revokeUserPushRegistrations")
      .mockRejectedValueOnce(new Error("forced push delete failure"));

    let failed: SupertestResponse;
    try {
      failed = await request(app)
        .post("/api/auth/logout")
        .set("Authorization", `Bearer ${login.body.token}`)
        .send({});
    } finally {
      deleteFailure.mockRestore();
    }

    expect(failed.status).toBe(500);
    const [afterUser] = await db
      .select({ sessionVersion: users.sessionVersion })
      .from(users)
      .where(eq(users.id, userId));
    expect(afterUser.sessionVersion).toBe(beforeUser.sessionVersion);
    expect(
      await db
        .select({ id: pushTokens.id })
        .from(pushTokens)
        .where(eq(pushTokens.userId, userId)),
    ).toHaveLength(2);
    expect(
      await db
        .select({ id: auditTrail.id })
        .from(auditTrail)
        .where(
          eq(auditTrail.description, "Sessões encerradas pelo próprio usuário"),
        ),
    ).toHaveLength(beforeAudits.length);
    await expect(
      request(app)
        .get("/api/auth/me")
        .set("Authorization", `Bearer ${login.body.token}`),
    ).resolves.toMatchObject({ status: 200 });
    await db.delete(pushTokens).where(eq(pushTokens.userId, userId));
  });

  it("serializa register concorrente com logout e não deixa destino da sessão revogada", async () => {
    const login = await request(app)
      .post("/api/auth/login")
      .send({ email: EMAIL, password: PASSWORD });
    expect(login.status).toBe(200);
    const [beforeUser] = await db
      .select({ sessionVersion: users.sessionVersion })
      .from(users)
      .where(eq(users.id, userId));
    const racingToken = `ExponentPushToken[register-logout-race-${STAMP}]`;

    const [registration, logout] = await Promise.all([
      registerPushToken(
        userId,
        racingToken,
        "ios",
        institutionId,
        beforeUser.sessionVersion,
      ),
      request(app)
        .post("/api/auth/logout")
        .set("Authorization", `Bearer ${login.body.token}`)
        .send({}),
    ]);

    expect(typeof registration.success).toBe("boolean");
    if (!registration.success) {
      expect(registration.message).toBe("Sessão revogada");
    }
    expect(logout.status).toBe(200);
    expect(
      await db
        .select({ id: pushTokens.id })
        .from(pushTokens)
        .where(eq(pushTokens.userId, userId)),
    ).toHaveLength(0);
    await expect(
      registerPushToken(
        userId,
        `ExponentPushToken[stale-after-logout-${STAMP}]`,
        "ios",
        institutionId,
        beforeUser.sessionVersion,
      ),
    ).resolves.toEqual({ success: false, message: "Sessão revogada" });
    expect(
      await db
        .select({ id: pushTokens.id })
        .from(pushTokens)
        .where(eq(pushTokens.userId, userId)),
    ).toHaveLength(0);
    const fetchMock = vi.fn(async () => {
      throw new Error("Expo não deve ser chamado sem registro autorizado");
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      await expect(
        sendPushNotification(
          userId,
          { title: "Sessão revogada", body: "não enviar" },
          institutionId,
        ),
      ).resolves.toMatchObject({
        status: "NO_REGISTERED_TOKENS",
        acceptedCount: 0,
        rejectedCount: 0,
      });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
    await expect(
      request(app)
        .get("/api/auth/me")
        .set("Authorization", `Bearer ${login.body.token}`),
    ).resolves.toMatchObject({ status: 401 });
  });

  it("logout real aguarda fetch Expo em voo e revoga antes de qualquer novo envio", async () => {
    const [before] = await db
      .select({ sessionVersion: users.sessionVersion })
      .from(users)
      .where(eq(users.id, userId));
    const bearer = await sdk.signSession({
      userId: String(userId),
      name: "Session Fence User",
      sessionVersion: before.sessionVersion,
    });
    const token = `ExponentPushToken[logout-fetch-race-${STAMP}]`;
    await expect(
      registerPushToken(
        userId,
        token,
        "ios",
        institutionId,
        before.sessionVersion,
      ),
    ).resolves.toEqual({
      success: true,
      message: "Token registrado com sucesso",
    });

    const fetchEntered = deferredVoid();
    const releaseFetch = deferredVoid();
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(async () => {
        fetchEntered.resolve();
        await releaseFetch.promise;
        return expoTicketResponse("ticket-logout-race");
      })
      .mockResolvedValue(expoTicketResponse("ticket-unexpected-after-logout"));
    vi.stubGlobal("fetch", fetchMock);
    let logoutSettled = false;
    let logoutPromise: Promise<SupertestResponse> | undefined;
    try {
      const sendPromise = sendPushNotification(
        userId,
        { title: "Mutex logout", body: "envio já autorizado" },
        institutionId,
      );
      await fetchEntered.promise;
      logoutPromise = request(app)
        .post("/api/auth/logout")
        .set("Authorization", `Bearer ${bearer}`)
        .send({})
        .then((response) => {
          logoutSettled = true;
          return response;
        });

      await waitForPushLockWaiter(db, userId);
      expect(logoutSettled).toBe(false);
      await expect(
        db
          .select({ sessionVersion: users.sessionVersion })
          .from(users)
          .where(eq(users.id, userId)),
      ).resolves.toEqual([{ sessionVersion: before.sessionVersion }]);

      releaseFetch.resolve();
      await expect(sendPromise).resolves.toMatchObject({
        status: "TICKETS_ACCEPTED",
      });
      const logout = await logoutPromise;
      expect(logout.status).toBe(200);
      expect(logout.body).toMatchObject({
        ok: true,
        sessionFenceRotated: true,
      });
      await expect(
        db
          .select({ id: pushTokens.id })
          .from(pushTokens)
          .where(eq(pushTokens.userId, userId)),
      ).resolves.toHaveLength(0);

      await expect(
        sendPushNotification(
          userId,
          { title: "Depois do logout", body: "não enviar" },
          institutionId,
        ),
      ).resolves.toMatchObject({ status: "NO_REGISTERED_TOKENS" });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      releaseFetch.resolve();
      if (logoutPromise) await Promise.allSettled([logoutPromise]);
      vi.unstubAllGlobals();
      await db.delete(pushTokens).where(eq(pushTokens.token, token));
    }
  });

  it("registro é account-scoped, mas entrega falha fechado com instituição desativada", async () => {
    const token = `ExponentPushToken[institution-disabled-${STAMP}]`;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const [currentUser] = await db
      .select({ sessionVersion: users.sessionVersion })
      .from(users)
      .where(eq(users.id, userId));
    await db
      .update(institutions)
      .set({ isActive: false })
      .where(eq(institutions.id, institutionId));

    try {
      await expect(
        registerPushToken(
          userId,
          token,
          "ios",
          institutionId,
          currentUser.sessionVersion,
        ),
      ).resolves.toEqual({
        success: true,
        message: "Token registrado com sucesso",
      });
      expect(
        await db
          .select({ id: pushTokens.id })
          .from(pushTokens)
          .where(eq(pushTokens.token, token)),
      ).toHaveLength(1);
      await expect(
        sendPushNotification(
          userId,
          { title: "Tenant inativo", body: "não enviar" },
          institutionId,
        ),
      ).resolves.toMatchObject({
        status: "ALL_TICKETS_REJECTED",
        tickets: [
          {
            state: "TICKET_REJECTED",
            failureKind: "RECIPIENT_AUTHORITY_REVOKED",
            retryability: "TERMINAL",
          },
        ],
      });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      await db
        .update(institutions)
        .set({ isActive: true })
        .where(eq(institutions.id, institutionId));
      await db.delete(pushTokens).where(eq(pushTokens.token, token));
    }
  });

  it("logout 500 mantém sessão e push; retry 2xx ROTATED revoga ambos", async () => {
    const login = await request(app)
      .post("/api/auth/login")
      .send({ email: EMAIL, password: PASSWORD });
    expect(login.status).toBe(200);
    const pushToken = `ExponentPushToken[logout-db-retry-${STAMP}]`;
    await db.insert(pushTokens).values({
      institutionId,
      userId,
      token: pushToken,
      platform: "ios",
    });
    const [before] = await db
      .select({ sessionVersion: users.sessionVersion })
      .from(users)
      .where(eq(users.id, userId));
    const transactionFailure = vi
      .spyOn(pushRevocationService, "withPushAccountMutex")
      .mockRejectedValueOnce(new Error("forced logout database failure"));

    let failed: SupertestResponse;
    try {
      failed = await request(app)
        .post("/api/auth/logout")
        .set("Authorization", `Bearer ${login.body.token}`)
        .send({ pushToken });
    } finally {
      transactionFailure.mockRestore();
    }

    expect(failed.status).toBe(500);
    expect(failed.body).toEqual({ error: "Falha ao encerrar sessão" });
    const [after] = await db
      .select({ sessionVersion: users.sessionVersion })
      .from(users)
      .where(eq(users.id, userId));
    expect(after.sessionVersion).toBe(before.sessionVersion);
    expect(
      await db
        .select({ id: pushTokens.id })
        .from(pushTokens)
        .where(eq(pushTokens.token, pushToken)),
    ).toHaveLength(1);
    await expect(
      request(app)
        .get("/api/auth/me")
        .set("Authorization", `Bearer ${login.body.token}`),
    ).resolves.toMatchObject({ status: 200 });

    const retry = await request(app)
      .post("/api/auth/logout")
      .set("Authorization", `Bearer ${login.body.token}`)
      .send({ pushToken });
    expect(retry.status).toBe(200);
    expect(retry.body).toMatchObject({
      ok: true,
      revocation: "ROTATED",
      revocationUserId: userId,
    });
    expect(
      await db
        .select({ id: pushTokens.id })
        .from(pushTokens)
        .where(eq(pushTokens.token, pushToken)),
    ).toHaveLength(0);
    const [afterRetry] = await db
      .select({ sessionVersion: users.sessionVersion })
      .from(users)
      .where(eq(users.id, userId));
    expect(afterRetry.sessionVersion).toBe(before.sessionVersion + 1);
    await expect(
      request(app)
        .get("/api/auth/me")
        .set("Authorization", `Bearer ${login.body.token}`),
    ).resolves.toMatchObject({ status: 401 });
  });

  it("logout por Bearer revoga o token atual e cookies irmãos sem bloquear novo login", async () => {
    const deviceA = await request(app)
      .post("/api/auth/login")
      .send({ email: EMAIL, password: PASSWORD });
    const deviceB = await request(app)
      .post("/api/auth/login")
      .send({ email: EMAIL, password: PASSWORD });
    expect(deviceA.status).toBe(200);
    expect(deviceB.status).toBe(200);

    const nativePushTokens = [
      `ExponentPushToken[bearer-logout-a-${STAMP}]`,
      `ExponentPushToken[bearer-logout-b-${STAMP}]`,
    ];
    await db.insert(pushTokens).values([
      {
        institutionId,
        userId,
        token: nativePushTokens[0],
        platform: "ios",
      },
      {
        institutionId,
        userId,
        token: nativePushTokens[1],
        platform: "android",
      },
    ]);
    expect(
      await db
        .select({ id: pushTokens.id })
        .from(pushTokens)
        .where(eq(pushTokens.userId, userId)),
    ).toHaveLength(2);

    const logout = await request(app)
      .post("/api/auth/logout")
      .set("Authorization", `Bearer ${deviceA.body.token}`)
      .set("x-client-expected-user-id", String(userId))
      .send({});
    expect(logout.status).toBe(200);
    expect(logout.body).toMatchObject({ ok: true, sessionFenceRotated: true });
    await expect(
      request(app)
        .get("/api/auth/me")
        .set("Authorization", `Bearer ${deviceA.body.token}`),
    ).resolves.toMatchObject({ status: 401 });
    await expect(
      request(app)
        .get("/api/auth/me")
        .set("Cookie", cookiePair(deviceB, "session")),
    ).resolves.toMatchObject({ status: 401 });
    expect(
      await db
        .select({ id: pushTokens.id })
        .from(pushTokens)
        .where(eq(pushTokens.userId, userId)),
    ).toHaveLength(0);

    const relogin = await request(app)
      .post("/api/auth/login")
      .send({ email: EMAIL, password: PASSWORD });
    expect(relogin.status).toBe(200);
    await expect(
      request(app)
        .get("/api/auth/me")
        .set("Authorization", `Bearer ${relogin.body.token}`),
    ).resolves.toMatchObject({ status: 200 });
  });

  it("PI inativa continua sendo escopo canônico para auditar e revogar logout", async () => {
    const login = await request(app)
      .post("/api/auth/login")
      .send({ email: EMAIL, password: PASSWORD });
    expect(login.status).toBe(200);
    const beforeAudits = await db
      .select({ id: auditTrail.id })
      .from(auditTrail)
      .where(
        eq(auditTrail.description, "Sessões encerradas pelo próprio usuário"),
      );
    await db
      .update(professionalInstitutions)
      .set({ active: false })
      .where(eq(professionalInstitutions.userId, userId));

    try {
      const logout = await request(app)
        .post("/api/auth/logout")
        .set("Authorization", `Bearer ${login.body.token}`)
        .send({});
      expect(logout.status).toBe(200);
      await expect(
        request(app)
          .get("/api/auth/me")
          .set("Authorization", `Bearer ${login.body.token}`),
      ).resolves.toMatchObject({ status: 401 });
      const afterAudits = await db
        .select({ id: auditTrail.id })
        .from(auditTrail)
        .where(
          eq(auditTrail.description, "Sessões encerradas pelo próprio usuário"),
        );
      expect(afterAudits).toHaveLength(beforeAudits.length + 1);
    } finally {
      await db
        .update(professionalInstitutions)
        .set({ active: true })
        .where(eq(professionalInstitutions.userId, userId));
    }
  });

  it("PI hard-deleted não mantém Bearer vivo nem atribui auditoria a tenant alheio", async () => {
    const login = await request(app)
      .post("/api/auth/login")
      .send({ email: EMAIL, password: PASSWORD });
    expect(login.status).toBe(200);
    const [beforeUser] = await db
      .select({ sessionVersion: users.sessionVersion })
      .from(users)
      .where(eq(users.id, userId));
    const beforeAudits = await db
      .select({ id: auditTrail.id })
      .from(auditTrail)
      .where(
        eq(auditTrail.description, "Sessões encerradas pelo próprio usuário"),
      );
    await db
      .delete(professionalInstitutions)
      .where(eq(professionalInstitutions.userId, userId));
    const orphanLog = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    try {
      const logout = await request(app)
        .post("/api/auth/logout")
        .set("Authorization", `Bearer ${login.body.token}`)
        .send({});
      expect(logout.status).toBe(200);
      expect(logout.body).toMatchObject({
        ok: true,
        sessionFenceRotated: true,
      });
      expect(orphanLog).toHaveBeenCalledWith(
        "[logout] Sessão órfã revogada sem escopo institucional",
        expect.stringContaining(`\"userId\":${userId}`),
      );
      const [afterUser] = await db
        .select({ sessionVersion: users.sessionVersion })
        .from(users)
        .where(eq(users.id, userId));
      expect(afterUser.sessionVersion).toBe(beforeUser.sessionVersion + 1);
      await expect(
        request(app)
          .get("/api/auth/me")
          .set("Authorization", `Bearer ${login.body.token}`),
      ).resolves.toMatchObject({ status: 401 });
      const afterAudits = await db
        .select({ id: auditTrail.id })
        .from(auditTrail)
        .where(
          eq(auditTrail.description, "Sessões encerradas pelo próprio usuário"),
        );
      expect(afterAudits).toHaveLength(beforeAudits.length);
    } finally {
      orphanLog.mockRestore();
      await db.insert(professionalInstitutions).values({
        professionalId,
        userId,
        institutionId,
        roleInInstitution: "USER",
        isPrimary: true,
        active: true,
      });
    }
  });

  it("dois logouts concorrentes da mesma versão são idempotentes e auditam uma vez", async () => {
    const login = await request(app)
      .post("/api/auth/login")
      .send({ email: EMAIL, password: PASSWORD });
    expect(login.status).toBe(200);
    const [beforeUser] = await db
      .select({ sessionVersion: users.sessionVersion })
      .from(users)
      .where(eq(users.id, userId));
    const beforeAudits = await db
      .select({ id: auditTrail.id })
      .from(auditTrail)
      .where(
        eq(auditTrail.description, "Sessões encerradas pelo próprio usuário"),
      );

    const [first, second] = await Promise.all([
      request(app)
        .post("/api/auth/logout")
        .set("Authorization", `Bearer ${login.body.token}`)
        .send({}),
      request(app)
        .post("/api/auth/logout")
        .set("Authorization", `Bearer ${login.body.token}`)
        .send({}),
    ]);

    expect([first.status, second.status]).toEqual([200, 200]);
    expect([first.body.revocation, second.body.revocation].sort()).toEqual([
      "ALREADY_INVALID",
      "ROTATED",
    ]);
    expect(first.body.revocationUserId).toBe(userId);
    expect(second.body.revocationUserId).toBe(userId);
    const [afterUser] = await db
      .select({ sessionVersion: users.sessionVersion })
      .from(users)
      .where(eq(users.id, userId));
    expect(afterUser.sessionVersion).toBe(beforeUser.sessionVersion + 1);
    const afterAudits = await db
      .select({ id: auditTrail.id })
      .from(auditTrail)
      .where(
        eq(auditTrail.description, "Sessões encerradas pelo próprio usuário"),
      );
    expect(afterAudits).toHaveLength(beforeAudits.length + 1);
  });

  it("troca de senha iniciada antes do logout não ressuscita cookie v2", async () => {
    const login = await request(app)
      .post("/api/auth/login")
      .send({ email: EMAIL, password: PASSWORD });
    expect(login.status).toBe(200);
    const currentSession = cookiePair(login, "session");

    const hashStarted = deferredVoid();
    const releaseHash = deferredVoid();
    const originalHash = bcrypt.hash.bind(bcrypt);
    const hashSpy = vi.spyOn(bcrypt, "hash").mockImplementation((async (
      value: string,
      rounds: string | number,
    ) => {
      if (value === ROTATED_PASSWORD) {
        hashStarted.resolve();
        await releaseHash.promise;
      }
      return originalHash(value, rounds);
    }) as typeof bcrypt.hash);

    try {
      const pendingChange = request(app)
        .post("/api/auth/change-password")
        .set("Cookie", currentSession)
        .set("x-client-session-instance", proofForCookieHeader(currentSession))
        .send({ currentPassword: PASSWORD, newPassword: ROTATED_PASSWORD })
        .then((response) => response);
      await hashStarted.promise;

      const logout = await request(app)
        .post("/api/auth/logout")
        .set("Cookie", currentSession)
        .send({});
      const rotatedFence = cookiePair(logout, "session_fence");
      releaseHash.resolve();
      const staleChange = await pendingChange;
      expect(staleChange.status).toBe(409);
      expect(staleChange.body.error).toMatch(/credencial mudou/i);
      await expect(
        request(app).get("/api/auth/me").set("Cookie", currentSession),
      ).resolves.toMatchObject({ status: 401 });

      // Controle positivo: uma intenção iniciada depois do logout observa o
      // fence novo; login e rotação subsequente continuam válidos sem alterá-lo.
      const relogin = await request(app)
        .post("/api/auth/login")
        .set("Cookie", rotatedFence)
        .send({ email: EMAIL, password: PASSWORD });
      expect(relogin.status).toBe(200);
      const stableSession = cookieHeader(
        cookiePair(relogin, "session"),
        rotatedFence,
      );
      const stableChange = await request(app)
        .post("/api/auth/change-password")
        .set("Cookie", stableSession)
        .set("x-client-session-instance", proofForCookieHeader(stableSession))
        .send({ currentPassword: PASSWORD, newPassword: FINAL_PASSWORD });
      expect(stableChange.status).toBe(200);
      expect(
        setCookieHeaders(stableChange).some((header) =>
          header.startsWith("session_fence="),
        ),
      ).toBe(false);
      await expect(
        request(app)
          .get("/api/auth/me")
          .set(
            "Cookie",
            cookieHeader(cookiePair(stableChange, "session"), rotatedFence),
          ),
      ).resolves.toMatchObject({ status: 200 });
    } finally {
      releaseHash.resolve();
      hashSpy.mockRestore();
    }
  });
});

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, or } from "drizzle-orm";
import bcrypt from "bcryptjs";
import express, { type Express } from "express";
import request, { type Response as SupertestResponse } from "supertest";
import {
  auditTrail,
  institutions,
  professionalInstitutions,
  professionals,
  pushTokens,
  users,
} from "../drizzle/schema";
import { sdk } from "../server/_core/sdk";
import * as auditService from "../server/audit-trail";
import {
  registerPushToken,
  sendPushNotification,
} from "../server/notifications-service";
import * as pushRevocationService from "../server/push-registration-revocation";
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

describe("fence linearizável da sessão web", () => {
  let app: Express;
  let db: NonNullable<Awaited<ReturnType<typeof getDb>>>;
  let userId: number;
  let professionalId: number;
  let institutionId: number;

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
      .where(or(eq(auditTrail.actorUserId, userId), eq(auditTrail.entityId, userId)));
    await db
      .delete(professionalInstitutions)
      .where(eq(professionalInstitutions.userId, userId));
    await db.delete(professionals).where(eq(professionals.userId, userId));
    await db.delete(users).where(eq(users.id, userId));
    await db.delete(institutions).where(eq(institutions.id, institutionId));
  });

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
        .set("Cookie", cookieHeader(`session=${legacy}`, "session_fence=rotated")),
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
    await expect(
      request(app)
        .get("/api/auth/me")
        .set(
          "Cookie",
          cookieHeader(cookiePair(currentLogin, "session"), "session_fence=%3Cmissing%3E"),
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
      setCookieHeaders(logout).some((header) =>
        header.startsWith("session=") && /Expires=Thu, 01 Jan 1970|Max-Age=0/i.test(header),
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
      await db.select({ id: pushTokens.id }).from(pushTokens).where(eq(pushTokens.userId, userId)),
    ).toHaveLength(0);

    const [revoked] = await db
      .select({ sessionVersion: users.sessionVersion })
      .from(users)
      .where(eq(users.id, userId));
    expect(revoked.sessionVersion).toBe(2);
    const [logoutAudit] = await db
      .select({ metadata: auditTrail.metadata })
      .from(auditTrail)
      .where(eq(auditTrail.description, "Sessões encerradas pelo próprio usuário"));
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
    expect(setCookieHeaders(relogin).some((header) =>
      header.startsWith("session_fence="),
    )).toBe(false);
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
      expect(setCookieHeaders(staleLogin).some((header) =>
        header.startsWith("session_fence="),
      )).toBe(false);

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
    expect(missing.body).toMatchObject({ ok: true, sessionFenceRotated: true });
    expect(malformed.status).toBe(200);
    expect(malformed.body).toMatchObject({ ok: true, sessionFenceRotated: true });
    expect(
      await db.select({ id: pushTokens.id }).from(pushTokens).where(eq(pushTokens.token, victimPushToken)),
    ).toHaveLength(1);
    const [after] = await db
      .select({ sessionVersion: users.sessionVersion })
      .from(users)
      .where(eq(users.id, userId));
    expect(after.sessionVersion).toBe(before.sessionVersion);
    await db.delete(pushTokens).where(eq(pushTokens.token, victimPushToken));
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
      failed = await browser
        .post("/api/auth/logout")
        .send({ pushToken });
    } finally {
      auditFailure.mockRestore();
    }

    expect(failed.status).toBe(500);
    expect(failed.body).toEqual({ error: "Falha ao encerrar sessão" });
    expect(
      setCookieHeaders(failed).some((header) =>
        header.startsWith("session=") && /Expires=Thu, 01 Jan 1970|Max-Age=0/i.test(header),
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
    await expect(browser.get("/api/auth/me")).resolves.toMatchObject({ status: 200 });
    expect(
      await db.select({ id: pushTokens.id }).from(pushTokens).where(eq(pushTokens.token, pushToken)),
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
      .where(eq(auditTrail.description, "Sessões encerradas pelo próprio usuário"));
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
        .where(eq(auditTrail.description, "Sessões encerradas pelo próprio usuário")),
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
        ),
      ).resolves.toEqual({
        success: false,
        message: "Nenhum token encontrado para o usuário",
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

  it("registro push falha fechado quando a instituição é desativada", async () => {
    const token = `ExponentPushToken[institution-disabled-${STAMP}]`;
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
        success: false,
        message: "Vínculo institucional ativo não encontrado",
      });
      expect(
        await db
          .select({ id: pushTokens.id })
          .from(pushTokens)
          .where(eq(pushTokens.token, token)),
      ).toHaveLength(0);
    } finally {
      await db
        .update(institutions)
        .set({ isActive: true })
        .where(eq(institutions.id, institutionId));
      await db.delete(pushTokens).where(eq(pushTokens.token, token));
    }
  });

  it("falha do banco não publica prova e mantém a sessão revogável", async () => {
    const login = await request(app)
      .post("/api/auth/login")
      .send({ email: EMAIL, password: PASSWORD });
    expect(login.status).toBe(200);
    const [before] = await db
      .select({ sessionVersion: users.sessionVersion })
      .from(users)
      .where(eq(users.id, userId));
    const transactionFailure = vi
      .spyOn(db, "transaction")
      .mockRejectedValueOnce(new Error("forced logout database failure"));

    let failed: SupertestResponse;
    try {
      failed = await request(app)
        .post("/api/auth/logout")
        .set("Authorization", `Bearer ${login.body.token}`)
        .send({});
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
    await expect(
      request(app)
        .get("/api/auth/me")
        .set("Authorization", `Bearer ${login.body.token}`),
    ).resolves.toMatchObject({ status: 200 });
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

    const logout = await request(app)
      .post("/api/auth/logout")
      .set("Authorization", `Bearer ${deviceA.body.token}`)
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
      .where(eq(auditTrail.description, "Sessões encerradas pelo próprio usuário"));
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
        .where(eq(auditTrail.description, "Sessões encerradas pelo próprio usuário"));
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
      .where(eq(auditTrail.description, "Sessões encerradas pelo próprio usuário"));
    await db
      .delete(professionalInstitutions)
      .where(eq(professionalInstitutions.userId, userId));
    const orphanLog = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      const logout = await request(app)
        .post("/api/auth/logout")
        .set("Authorization", `Bearer ${login.body.token}`)
        .send({});
      expect(logout.status).toBe(200);
      expect(logout.body).toMatchObject({ ok: true, sessionFenceRotated: true });
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
        .where(eq(auditTrail.description, "Sessões encerradas pelo próprio usuário"));
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
      .where(eq(auditTrail.description, "Sessões encerradas pelo próprio usuário"));

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
    const [afterUser] = await db
      .select({ sessionVersion: users.sessionVersion })
      .from(users)
      .where(eq(users.id, userId));
    expect(afterUser.sessionVersion).toBe(beforeUser.sessionVersion + 1);
    const afterAudits = await db
      .select({ id: auditTrail.id })
      .from(auditTrail)
      .where(eq(auditTrail.description, "Sessões encerradas pelo próprio usuário"));
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
        request(app)
          .get("/api/auth/me")
          .set("Cookie", currentSession),
      ).resolves.toMatchObject({ status: 401 });

      // Controle positivo: uma intenção iniciada depois do logout observa o
      // fence novo; login e rotação subsequente continuam válidos sem alterá-lo.
      const relogin = await request(app)
        .post("/api/auth/login")
        .set("Cookie", rotatedFence)
        .send({ email: EMAIL, password: PASSWORD });
      expect(relogin.status).toBe(200);
      const stableSession = cookieHeader(cookiePair(relogin, "session"), rotatedFence);
      const stableChange = await request(app)
        .post("/api/auth/change-password")
        .set("Cookie", stableSession)
        .send({ currentPassword: PASSWORD, newPassword: FINAL_PASSWORD });
      expect(stableChange.status).toBe(200);
      expect(setCookieHeaders(stableChange).some((header) =>
        header.startsWith("session_fence="),
      )).toBe(false);
      await expect(
        request(app)
          .get("/api/auth/me")
          .set("Cookie", cookieHeader(cookiePair(stableChange, "session"), rotatedFence)),
      ).resolves.toMatchObject({ status: 200 });
    } finally {
      releaseHash.resolve();
      hashSpy.mockRestore();
    }
  });
});

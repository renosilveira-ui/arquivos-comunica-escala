import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { and, eq, or } from "drizzle-orm";
import bcrypt from "bcryptjs";
import request from "supertest";
import express, { type Express } from "express";
import { authRouter } from "../server/routes/auth";
import { getDb } from "../server/db";
import { sdk } from "../server/_core/sdk";
import { sessionInstanceProof } from "../server/_core/session-instance";
import {
  auditTrail,
  institutions,
  professionalInstitutions,
  professionals,
  pushTokens,
  users,
} from "../drizzle/schema";

/**
 * Endpoint /api/auth/change-password.
 *
 * Cobertura:
 *   1. Sem sessão → 401
 *   2. Com sessão mas senha atual errada → 401
 *   3. Nova senha < 8 chars → 400
 *   4. Nova senha igual à atual → 400
 *   5. Felicíssimo: tudo OK → senha persiste com novo hash, login com
 *      nova funciona, login com antiga falha
 */

import { sessionAuthCookies } from "./helpers/session-cookies";

const TEST_EMAIL = "auth-change-password-test@example.com";
const ORIGINAL_PASSWORD = "OriginalPass123";
const NEW_PASSWORD = "NewSecurePass456";

describe("auth.changePassword endpoint", () => {
  let app: Express;
  let db: Awaited<ReturnType<typeof getDb>>;
  let testUserId: number;
  let testInstitutionId: number;

  /**
   * O fluxo de login auto-cria um `professional` para o usuário (ver
   * server/routes/auth.ts). Como `professionals.user_id` referencia
   * `users.id` sem ON DELETE CASCADE, a limpeza precisa apagar o
   * professional ANTES do user. `professional_institutions` cascateia
   * a partir de professional, então não precisa de delete explícito.
   */
  async function cleanupTestUser() {
    const existing = await db!
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, TEST_EMAIL));
    for (const row of existing) {
      await db!.delete(pushTokens).where(eq(pushTokens.userId, row.id));
      await db!
        .delete(auditTrail)
        .where(
          or(
            eq(auditTrail.actorUserId, row.id),
            eq(auditTrail.entityId, row.id),
          ),
        );
      await db!
        .delete(professionalInstitutions)
        .where(eq(professionalInstitutions.userId, row.id));
      await db!.delete(professionals).where(eq(professionals.userId, row.id));
    }
    await db!.delete(users).where(eq(users.email, TEST_EMAIL));
  }

  beforeAll(async () => {
    db = await getDb();
    if (!db) throw new Error("Database not available");

    app = express();
    app.use(express.json());
    app.use("/api/auth", authRouter);

    await cleanupTestUser();
    const stamp = Date.now();
    const [institution] = await db
      .insert(institutions)
      .values({
        name: `Auth change password ${stamp}`,
        cnpj: `${stamp}`.slice(-14).padStart(14, "0"),
        legalName: `Auth change password ${stamp}`,
        tradeName: `AUTHPWD${stamp}`.slice(0, 20),
        isActive: true,
      })
      .$returningId();
    testInstitutionId = institution.id;
    const hash = await bcrypt.hash(ORIGINAL_PASSWORD, 12);
    const [res] = await db.insert(users).values({
      email: TEST_EMAIL,
      name: "Auth Change Password Test",
      passwordHash: hash,
      loginMethod: "email",
      role: "doctor",
    });
    testUserId = (res as any).insertId as number;
    const [professional] = await db
      .insert(professionals)
      .values({
        userId: testUserId,
        name: "Auth Change Password Test",
        role: "Médico",
        userRole: "USER",
      })
      .$returningId();
    await db.insert(professionalInstitutions).values({
      professionalId: professional.id,
      userId: testUserId,
      institutionId: testInstitutionId,
      roleInInstitution: "USER",
      isPrimary: true,
      active: true,
    });
  });

  afterAll(async () => {
    if (!db) return;
    await cleanupTestUser();
    await db.delete(institutions).where(eq(institutions.id, testInstitutionId));
  });

  async function loginAndGetCookie(password: string): Promise<string | null> {
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: TEST_EMAIL, password });
    if (res.status !== 200) return null;
    try {
      return sessionAuthCookies(res);
    } catch {
      return null;
    }
  }

  async function loginExactAndGetResponse(password: string) {
    const previous = process.env.SESSION_EXACT_BINDING_SUPPORTED;
    process.env.SESSION_EXACT_BINDING_SUPPORTED = "1";
    try {
      return await request(app)
        .post("/api/auth/login")
        .set("x-client-session-protocol", "exact-v1")
        .send({ email: TEST_EMAIL, password });
    } finally {
      if (previous === undefined) {
        delete process.env.SESSION_EXACT_BINDING_SUPPORTED;
      } else {
        process.env.SESSION_EXACT_BINDING_SUPPORTED = previous;
      }
    }
  }

  async function loginExactAndGetCookie(
    password: string,
  ): Promise<string | null> {
    const response = await loginExactAndGetResponse(password);
    if (response.status !== 200) return null;
    try {
      return sessionAuthCookies(response);
    } catch {
      return null;
    }
  }

  function proofForCookie(cookie: string): string {
    const token = tokenForCookie(cookie);
    return sessionInstanceProof(token);
  }

  function tokenForCookie(cookie: string): string {
    const sessionPair = cookie
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith("session="));
    const token = sessionPair?.slice("session=".length);
    if (!token) throw new Error("Token de sessão ausente no cookie de teste");
    return token;
  }

  it("rejeita 401 quando não há sessão", async () => {
    const res = await request(app)
      .post("/api/auth/change-password")
      .send({ currentPassword: ORIGINAL_PASSWORD, newPassword: NEW_PASSWORD });
    expect(res.status).toBe(401);
  });

  it("preflight default unsupported e fase supported mantém login legacy em overlap", async () => {
    const previous = process.env.SESSION_EXACT_BINDING_SUPPORTED;
    delete process.env.SESSION_EXACT_BINDING_SUPPORTED;
    try {
      const inactive = await request(app).get(
        "/api/auth/session-binding-capability",
      );
      expect(inactive.status).toBe(200);
      expect(inactive.headers["cache-control"]).toBe("no-store");
      expect(inactive.body).toEqual({
        capability: "exact-v1",
        supported: false,
      });

      process.env.SESSION_EXACT_BINDING_SUPPORTED = "1";
      const supported = await request(app).get(
        "/api/auth/session-binding-capability",
      );
      expect(supported.body).toEqual({
        capability: "exact-v1",
        supported: true,
      });

      const legacy = await request(app)
        .post("/api/auth/login")
        .send({ email: TEST_EMAIL, password: ORIGINAL_PASSWORD });
      expect(legacy.status).toBe(200);
      expect(legacy.headers["set-cookie"]).toBeDefined();
      expect(legacy.body.sessionBinding).toBeUndefined();
      await expect(sdk.verifySession(legacy.body.token)).resolves.toMatchObject(
        {
          sessionBindingVersion: null,
        },
      );
      const legacyCookie = sessionAuthCookies(legacy);
      const oldClientRotation = await request(app)
        .post("/api/auth/change-password")
        .set("Cookie", legacyCookie!)
        .send({
          currentPassword: "SenhaErrada123",
          newPassword: NEW_PASSWORD,
        });
      expect(oldClientRotation.status).toBe(401);
    } finally {
      if (previous === undefined) {
        delete process.env.SESSION_EXACT_BINDING_SUPPORTED;
      } else {
        process.env.SESSION_EXACT_BINDING_SUPPORTED = previous;
      }
    }
  });

  it("opt-in falha tipado com flag 0 e não emite cookie legacy", async () => {
    const previous = process.env.SESSION_EXACT_BINDING_SUPPORTED;
    process.env.SESSION_EXACT_BINDING_SUPPORTED = "0";
    try {
      const response = await request(app)
        .post("/api/auth/login")
        .set("x-client-session-protocol", "exact-v1")
        .send({ email: TEST_EMAIL, password: ORIGINAL_PASSWORD });
      expect(response.status).toBe(503);
      expect(response.body).toMatchObject({
        code: "SESSION_BINDING_CAPABILITY_UNAVAILABLE",
      });
      expect(response.headers["set-cookie"]).toBeUndefined();
    } finally {
      if (previous === undefined) {
        delete process.env.SESSION_EXACT_BINDING_SUPPORTED;
      } else {
        process.env.SESSION_EXACT_BINDING_SUPPORTED = previous;
      }
    }
  });

  it("flag ativa não promove JWT legacy por header/proof durante rotação", async () => {
    const cookie = await loginAndGetCookie(ORIGINAL_PASSWORD);
    expect(cookie).toBeTruthy();
    const [before] = await db!
      .select({
        passwordHash: users.passwordHash,
        sessionVersion: users.sessionVersion,
      })
      .from(users)
      .where(eq(users.id, testUserId));
    const previous = process.env.SESSION_EXACT_BINDING_SUPPORTED;
    process.env.SESSION_EXACT_BINDING_SUPPORTED = "1";
    try {
      const response = await request(app)
        .post("/api/auth/change-password")
        .set("Cookie", cookie!)
        .set("x-client-session-protocol", "exact-v1")
        .set("x-client-session-instance", proofForCookie(cookie!))
        .send({
          currentPassword: ORIGINAL_PASSWORD,
          newPassword: NEW_PASSWORD,
        });
      expect(response.status).toBe(428);
      expect(response.body).toMatchObject({
        code: "SESSION_BINDING_REAUTH_REQUIRED",
      });
      expect(response.headers["set-cookie"]).toBeUndefined();
    } finally {
      if (previous === undefined) {
        delete process.env.SESSION_EXACT_BINDING_SUPPORTED;
      } else {
        process.env.SESSION_EXACT_BINDING_SUPPORTED = previous;
      }
    }
    expect(
      (
        await db!
          .select({
            passwordHash: users.passwordHash,
            sessionVersion: users.sessionVersion,
          })
          .from(users)
          .where(eq(users.id, testUserId))
      )[0],
    ).toEqual(before);
  });

  it("JWT exact-v1 exige proof antes de senha, sessão ou auditoria", async () => {
    const cookie = await loginExactAndGetCookie(ORIGINAL_PASSWORD);
    expect(cookie).toBeTruthy();
    const [before] = await db!
      .select({
        passwordHash: users.passwordHash,
        sessionVersion: users.sessionVersion,
      })
      .from(users)
      .where(eq(users.id, testUserId));
    const beforeAudits = await db!
      .select({ id: auditTrail.id })
      .from(auditTrail)
      .where(
        and(
          eq(auditTrail.entityId, testUserId),
          eq(auditTrail.description, "Senha alterada pelo próprio usuário"),
        ),
      );

    const response = await request(app)
      .post("/api/auth/change-password")
      .set("Cookie", cookie!)
      .set("x-client-expected-user-id", String(testUserId))
      .send({ currentPassword: ORIGINAL_PASSWORD, newPassword: NEW_PASSWORD });

    expect(response.status).toBe(428);
    expect(response.body).toMatchObject({ code: "SESSION_INSTANCE_REQUIRED" });
    expect(
      (
        await db!
          .select({
            passwordHash: users.passwordHash,
            sessionVersion: users.sessionVersion,
          })
          .from(users)
          .where(eq(users.id, testUserId))
      )[0],
    ).toEqual(before);
    expect(
      await db!
        .select({ id: auditTrail.id })
        .from(auditTrail)
        .where(
          and(
            eq(auditTrail.entityId, testUserId),
            eq(auditTrail.description, "Senha alterada pelo próprio usuário"),
          ),
        ),
    ).toEqual(beforeAudits);
  });

  it("distingue duas sessões same-user no mesmo segundo e rejeita proof S1 sobre cookie S2", async () => {
    const fixedNow = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(fixedNow);
    let firstCookie: string | null;
    let secondCookie: string | null;
    try {
      firstCookie = await loginExactAndGetCookie(ORIGINAL_PASSWORD);
      secondCookie = await loginExactAndGetCookie(ORIGINAL_PASSWORD);
    } finally {
      clock.mockRestore();
    }
    expect(firstCookie).toBeTruthy();
    expect(secondCookie).toBeTruthy();
    expect(tokenForCookie(firstCookie!)).not.toBe(
      tokenForCookie(secondCookie!),
    );
    expect(proofForCookie(firstCookie!)).not.toBe(
      proofForCookie(secondCookie!),
    );

    const [before] = await db!
      .select({
        passwordHash: users.passwordHash,
        sessionVersion: users.sessionVersion,
      })
      .from(users)
      .where(eq(users.id, testUserId));
    const response = await request(app)
      .post("/api/auth/change-password")
      .set("Cookie", secondCookie!)
      .set("x-client-expected-user-id", String(testUserId))
      .set("x-client-session-instance", proofForCookie(firstCookie!))
      .send({ currentPassword: ORIGINAL_PASSWORD, newPassword: NEW_PASSWORD });

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ code: "SESSION_INSTANCE_MISMATCH" });
    expect(
      (
        await db!
          .select({
            passwordHash: users.passwordHash,
            sessionVersion: users.sessionVersion,
          })
          .from(users)
          .where(eq(users.id, testUserId))
      )[0],
    ).toEqual(before);

    const me = await request(app)
      .get("/api/auth/me")
      .set("Cookie", secondCookie!);
    expect(me.status).toBe(200);
    expect(me.headers["cache-control"]).toBe("no-store");
    expect(me.body).toMatchObject({
      sessionInstance: proofForCookie(secondCookie!),
      sessionBinding: {
        capability: "exact-v1",
        supported: false,
        sessionVersion: 1,
      },
      user: { id: testUserId },
    });
  });

  it("rejeita 401 quando senha atual está incorreta", async () => {
    const cookie = await loginAndGetCookie(ORIGINAL_PASSWORD);
    expect(cookie).toBeTruthy();

    const res = await request(app)
      .post("/api/auth/change-password")
      .set("Cookie", cookie!)
      .send({ currentPassword: "SenhaErrada123", newPassword: NEW_PASSWORD });
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/atual incorreta/i);
  });

  it("rejeita 400 quando nova senha tem menos de 8 caracteres", async () => {
    const cookie = await loginAndGetCookie(ORIGINAL_PASSWORD);
    expect(cookie).toBeTruthy();

    const res = await request(app)
      .post("/api/auth/change-password")
      .set("Cookie", cookie!)
      .set("x-client-session-instance", proofForCookie(cookie!))
      .send({ currentPassword: ORIGINAL_PASSWORD, newPassword: "curta" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/8 caracteres/i);
  });

  it("rejeita 400 quando nova senha é igual à atual", async () => {
    const cookie = await loginAndGetCookie(ORIGINAL_PASSWORD);
    expect(cookie).toBeTruthy();

    const res = await request(app)
      .post("/api/auth/change-password")
      .set("Cookie", cookie!)
      .set("x-client-session-instance", proofForCookie(cookie!))
      .send({
        currentPassword: ORIGINAL_PASSWORD,
        newPassword: ORIGINAL_PASSWORD,
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/diferente/i);
  });

  it("expected-user divergente ou malformado bloqueia antes de senha, sessão e auditoria", async () => {
    const cookie = await loginAndGetCookie(ORIGINAL_PASSWORD);
    expect(cookie).toBeTruthy();
    const [before] = await db!
      .select({
        passwordHash: users.passwordHash,
        sessionVersion: users.sessionVersion,
        mustChangePassword: users.mustChangePassword,
      })
      .from(users)
      .where(eq(users.id, testUserId));
    const beforeAudits = await db!
      .select({ id: auditTrail.id })
      .from(auditTrail)
      .where(
        and(
          eq(auditTrail.entityId, testUserId),
          eq(auditTrail.description, "Senha alterada pelo próprio usuário"),
        ),
      );

    const divergent = await request(app)
      .post("/api/auth/change-password")
      .set("Cookie", cookie!)
      .set("x-client-expected-user-id", String(testUserId + 1))
      .send({ currentPassword: ORIGINAL_PASSWORD, newPassword: NEW_PASSWORD });
    expect(divergent.status).toBe(409);
    expect(divergent.body).toMatchObject({ code: "EXPECTED_USER_MISMATCH" });

    const malformed = await request(app)
      .post("/api/auth/change-password")
      .set("Cookie", cookie!)
      .set("x-client-expected-user-id", `0${testUserId}`)
      .send({ currentPassword: ORIGINAL_PASSWORD, newPassword: NEW_PASSWORD });
    expect(malformed.status).toBe(400);
    expect(malformed.body).toMatchObject({
      code: "MALFORMED_EXPECTED_USER_ID",
    });

    const [after] = await db!
      .select({
        passwordHash: users.passwordHash,
        sessionVersion: users.sessionVersion,
        mustChangePassword: users.mustChangePassword,
      })
      .from(users)
      .where(eq(users.id, testUserId));
    expect(after).toEqual(before);
    expect(
      await db!
        .select({ id: auditTrail.id })
        .from(auditTrail)
        .where(
          and(
            eq(auditTrail.entityId, testUserId),
            eq(auditTrail.description, "Senha alterada pelo próprio usuário"),
          ),
        ),
    ).toEqual(beforeAudits);
    await expect(
      request(app).get("/api/auth/me").set("Cookie", cookie!),
    ).resolves.toMatchObject({ status: 200 });
  });

  it("happy path: persiste novo hash + nova senha funciona + antiga não", async () => {
    const exactLogin = await loginExactAndGetResponse(ORIGINAL_PASSWORD);
    const cookie = sessionAuthCookies(exactLogin);
    expect(cookie).toBeTruthy();
    expect(exactLogin.body.sessionBinding).toEqual({
      capability: "exact-v1",
      supported: true,
      sessionVersion: 1,
    });
    expect(exactLogin.body.sessionInstance).toBe(proofForCookie(cookie!));
    await db!.insert(pushTokens).values([
      {
        institutionId: testInstitutionId,
        userId: testUserId,
        token: `ExponentPushToken[change-password-a-${testUserId}]`,
        platform: "ios",
      },
      {
        institutionId: testInstitutionId,
        userId: testUserId,
        token: `ExponentPushToken[change-password-b-${testUserId}]`,
        platform: "android",
      },
    ]);

    // 1. Change password
    const res = await request(app)
      .post("/api/auth/change-password")
      .set("Cookie", cookie!)
      .set("x-client-expected-user-id", String(testUserId))
      .set("x-client-session-instance", proofForCookie(cookie!))
      .send({ currentPassword: ORIGINAL_PASSWORD, newPassword: NEW_PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true }); // + token: sessão nova deste aparelho (B3)
    expect(res.body.sessionBinding).toEqual({
      capability: "exact-v1",
      supported: false,
      sessionVersion: 1,
    });
    expect(res.body.sessionInstance).toBe(sessionInstanceProof(res.body.token));
    await expect(sdk.verifySession(res.body.token)).resolves.toMatchObject({
      sessionBindingVersion: 1,
    });
    expect(
      await db!
        .select({ id: pushTokens.id })
        .from(pushTokens)
        .where(eq(pushTokens.userId, testUserId)),
    ).toHaveLength(0);
    const [audit] = await db!
      .select({ metadata: auditTrail.metadata })
      .from(auditTrail)
      .where(
        and(
          eq(auditTrail.entityId, testUserId),
          eq(auditTrail.description, "Senha alterada pelo próprio usuário"),
        ),
      );
    expect(audit?.metadata).toMatchObject({ revokedPushTokenCount: 2 });

    // 2. Hash atualizado no banco
    const [updated] = await db!
      .select()
      .from(users)
      .where(eq(users.id, testUserId));
    expect(updated.passwordHash).toBeTruthy();
    const stillMatchesOld = await bcrypt.compare(
      ORIGINAL_PASSWORD,
      updated.passwordHash!,
    );
    expect(stillMatchesOld).toBe(false);
    const matchesNew = await bcrypt.compare(
      NEW_PASSWORD,
      updated.passwordHash!,
    );
    expect(matchesNew).toBe(true);

    // 3. Login com nova senha funciona
    const newCookie = await loginAndGetCookie(NEW_PASSWORD);
    expect(newCookie).toBeTruthy();

    // 4. Login com senha antiga falha
    const oldLogin = await request(app)
      .post("/api/auth/login")
      .send({ email: TEST_EMAIL, password: ORIGINAL_PASSWORD });
    expect(oldLogin.status).toBe(401);
  });
});

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import bcrypt from "bcryptjs";
import request from "supertest";
import express, { type Express } from "express";
import { authRouter } from "../server/routes/auth";
import { getDb } from "../server/db";
import { users, professionals } from "../drizzle/schema";

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

const TEST_EMAIL = "auth-change-password-test@example.com";
const ORIGINAL_PASSWORD = "OriginalPass123";
const NEW_PASSWORD = "NewSecurePass456";

describe("auth.changePassword endpoint", () => {
  let app: Express;
  let db: Awaited<ReturnType<typeof getDb>>;
  let testUserId: number;

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
    const hash = await bcrypt.hash(ORIGINAL_PASSWORD, 12);
    const [res] = await db.insert(users).values({
      email: TEST_EMAIL,
      name: "Auth Change Password Test",
      passwordHash: hash,
      loginMethod: "email",
      role: "doctor",
    });
    testUserId = (res as any).insertId as number;
  });

  afterAll(async () => {
    if (!db) return;
    await cleanupTestUser();
  });

  async function loginAndGetCookie(password: string): Promise<string | null> {
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: TEST_EMAIL, password });
    if (res.status !== 200) return null;
    const setCookie = res.headers["set-cookie"];
    if (!setCookie) return null;
    const arr = Array.isArray(setCookie) ? setCookie : [setCookie];
    return arr.find((c) => c.startsWith("session=")) ?? null;
  }

  it("rejeita 401 quando não há sessão", async () => {
    const res = await request(app)
      .post("/api/auth/change-password")
      .send({ currentPassword: ORIGINAL_PASSWORD, newPassword: NEW_PASSWORD });
    expect(res.status).toBe(401);
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
      .send({ currentPassword: ORIGINAL_PASSWORD, newPassword: ORIGINAL_PASSWORD });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/diferente/i);
  });

  it("happy path: persiste novo hash + nova senha funciona + antiga não", async () => {
    const cookie = await loginAndGetCookie(ORIGINAL_PASSWORD);
    expect(cookie).toBeTruthy();

    // 1. Change password
    const res = await request(app)
      .post("/api/auth/change-password")
      .set("Cookie", cookie!)
      .send({ currentPassword: ORIGINAL_PASSWORD, newPassword: NEW_PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    // 2. Hash atualizado no banco
    const [updated] = await db!.select().from(users).where(eq(users.id, testUserId));
    expect(updated.passwordHash).toBeTruthy();
    const stillMatchesOld = await bcrypt.compare(ORIGINAL_PASSWORD, updated.passwordHash!);
    expect(stillMatchesOld).toBe(false);
    const matchesNew = await bcrypt.compare(NEW_PASSWORD, updated.passwordHash!);
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

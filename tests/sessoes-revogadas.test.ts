// tests/sessoes-revogadas.test.ts — auditoria 22/08, achado B3.
//
// Trocar a senha (pelo usuário), redefinir via "esqueci minha senha" ou
// receber senha temporária do admin incrementa users.session_version; o JWT
// de sessão carrega `sv` e qualquer sessão antiga (outro aparelho/aba) passa
// a ser rejeitada. No change-password, o aparelho atual recebe sessão nova
// (cookie + token) e continua logado.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import bcrypt from "bcryptjs";
import request from "supertest";
import express, { type Express } from "express";
import { auditTrail, passwordResets, professionalInstitutions, professionals, users } from "../drizzle/schema";
import { sdk } from "../server/_core/sdk";
import { getDb } from "../server/db";
import { mailer } from "../server/mailer";
import { adminRouter } from "../server/routes/admin";
import { authRouter } from "../server/routes/auth";

const STAMP = Date.now();
const PASSWORD = "SenhaOriginal123";
const NEW_PASSWORD = "SenhaNovaForte456";

describe("sessões revogadas ao trocar/redefinir senha", () => {
  let app: Express;
  let db: NonNullable<Awaited<ReturnType<typeof getDb>>>;
  let userId: number;
  let adminId: number;
  const email = `sv-user-${STAMP}@test.local`;
  const adminEmail = `sv-admin-${STAMP}@test.local`;

  const login = (e: string, p: string) => request(app).post("/api/auth/login").send({ email: e, password: p });
  const cookieOf = (res: request.Response) => {
    const sc = res.headers["set-cookie"];
    return (Array.isArray(sc) ? sc : [sc]).find((c: string) => c?.startsWith("session=")) ?? "";
  };
  const me = (cookie: string) => request(app).get("/api/auth/me").set("Cookie", cookie);
  const meBearer = (token: string) => request(app).get("/api/auth/me").set("Authorization", `Bearer ${token}`);

  beforeAll(async () => {
    const conn = await getDb();
    if (!conn) throw new Error("Database not available");
    db = conn;
    app = express();
    app.use(express.json());
    app.use("/api/auth", authRouter);
    app.use("/api/admin", adminRouter);
    const [u] = await db
      .insert(users)
      .values({ name: "SV User", email, passwordHash: await bcrypt.hash(PASSWORD, 4), loginMethod: "email", role: "doctor" })
      .$returningId();
    userId = u.id;
    const [a] = await db
      .insert(users)
      .values({ name: "SV Admin", email: adminEmail, passwordHash: await bcrypt.hash(PASSWORD, 4), loginMethod: "email", role: "admin" })
      .$returningId();
    adminId = a.id;
  });

  afterAll(async () => {
    await db.delete(passwordResets).where(eq(passwordResets.userId, userId));
    await db.delete(auditTrail).where(inArray(auditTrail.entityId, [userId, adminId]));
    await db.delete(professionalInstitutions).where(inArray(professionalInstitutions.userId, [userId, adminId]));
    await db.delete(professionals).where(inArray(professionals.userId, [userId, adminId]));
    await db.delete(users).where(inArray(users.id, [userId, adminId]));
  });

  it("sessão carrega a versão; sessão sem `sv` (legada) vale como v1", async () => {
    const res = await login(email, PASSWORD);
    expect(res.status).toBe(200);
    const session = await sdk.verifySession(res.body.token);
    expect(session?.sessionVersion).toBe(1);
    const legacy = await sdk.signSession({ userId: String(userId), name: "SV User", sessionVersion: undefined as any });
    const parsedLegacy = await sdk.verifySession(legacy);
    expect(parsedLegacy?.sessionVersion).toBe(1);
  });

  it("change-password: outras sessões morrem, o aparelho atual recebe sessão nova", async () => {
    const deviceA = await login(email, PASSWORD);
    const deviceB = await login(email, PASSWORD);
    const cookieA = cookieOf(deviceA);
    const tokenB = deviceB.body.token as string;
    expect((await me(cookieA)).status).toBe(200);
    expect((await meBearer(tokenB)).status).toBe(200);

    const change = await request(app).post("/api/auth/change-password").set("Cookie", cookieA).send({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD });
    expect(change.status).toBe(200);
    expect(typeof change.body.token).toBe("string");

    // Aparelho B (sessão antiga) foi revogado; A continua com a sessão nova.
    expect((await meBearer(tokenB)).status).toBe(401);
    expect((await me(cookieA)).status).toBe(401); // cookie ANTIGO de A também morre…
    expect((await me(cookieOf(change))).status).toBe(200); // …mas a resposta já trouxe o novo
    expect((await meBearer(change.body.token)).status).toBe(200);
  });

  it("reset via 'esqueci minha senha' revoga todas as sessões", async () => {
    const device = await login(email, NEW_PASSWORD);
    const cookie = cookieOf(device);
    expect((await me(cookie)).status).toBe(200);

    const spy = vi.spyOn(mailer, "sendMail").mockResolvedValue({ delivered: false, transport: "console" } as any);
    try {
      expect((await request(app).post("/api/auth/forgot-password").send({ email })).status).toBe(200);
      const text = String(spy.mock.calls[0][0].text ?? spy.mock.calls[0][0].html ?? "");
      const token = text.match(/token=([0-9a-f]{64})/)![1];
      const reset = await request(app).post("/api/auth/reset-password").send({ token, newPassword: `${NEW_PASSWORD}x` });
      expect(reset.status).toBe(200);
    } finally {
      spy.mockRestore();
    }
    expect((await me(cookie)).status).toBe(401);
    expect((await login(email, `${NEW_PASSWORD}x`)).status).toBe(200);
  });

  it("senha temporária do admin revoga as sessões do alvo", async () => {
    const device = await login(email, `${NEW_PASSWORD}x`);
    const cookie = cookieOf(device);
    expect((await me(cookie)).status).toBe(200);
    const adminCookie = cookieOf(await login(adminEmail, PASSWORD));
    const reset = await request(app).post(`/api/admin/users/${userId}/reset-password`).set("Cookie", adminCookie);
    expect(reset.status).toBe(200);
    expect((await me(cookie)).status).toBe(401);
    const [row] = await db.select({ v: users.sessionVersion }).from(users).where(eq(users.id, userId));
    expect(row.v).toBe(4); // v1 → change (2) → reset (3) → admin (4)
  });
});

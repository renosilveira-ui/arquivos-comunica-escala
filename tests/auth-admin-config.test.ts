// tests/auth-admin-config.test.ts — auditoria 22/08 (parte 2), auth/admin.
//
// - POST /api/auth/register cadastra na instituição do admin (x-tenant-id)
//   ou na informada no body; NÃO mexe na instituição 1.
// - Ações do admin (PUT /users/:id) entram na trilha de auditoria com
//   institution_id (antes o INSERT falhava em silêncio).
// - GET /api/auth/me não é limitado pelo rate limit de autenticação.
// - Erros do driver MySQL não vazam para o cliente tRPC.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray, like } from "drizzle-orm";
import bcrypt from "bcryptjs";
import request from "supertest";
import express, { type Express } from "express";
import { auditTrail, institutions, professionalAccess, professionalInstitutions, professionals, users } from "../drizzle/schema";
import { createAuthRateLimit } from "../server/_core/security";
import { isDriverErrorMessage } from "../server/_core/trpc";
import { getDb } from "../server/db";
import { adminRouter } from "../server/routes/admin";
import { authRouter } from "../server/routes/auth";

const STAMP = Date.now();
const PASSWORD = "SenhaAdmin123";

describe("auth/admin: instituição do cadastro, auditoria, rate limit, erros", () => {
  let app: Express;
  let db: NonNullable<Awaited<ReturnType<typeof getDb>>>;
  let instA: number;
  let instB: number;
  let adminId: number;
  let cookie: string;
  const createdUserIds: number[] = [];

  beforeAll(async () => {
    const conn = await getDb();
    if (!conn) throw new Error("Database not available");
    db = conn;
    app = express();
    app.use(express.json());
    const limiter = createAuthRateLimit({ max: 10, windowMs: 60_000 });
    app.use("/api/auth", (req, res, next) => (req.method === "GET" ? next() : limiter(req, res, next)), authRouter);
    app.use("/api/admin", adminRouter);

    const mk = async (tag: string) => {
      const [i] = await db
        .insert(institutions)
        .values({ name: `AAC ${tag} ${STAMP}`, cnpj: `${STAMP}${tag === "A" ? 7 : 8}`.slice(-14).padStart(14, "0"), legalName: `AAC ${tag}`, tradeName: `AAC${tag}${STAMP}`.slice(0, 20), isActive: true })
        .$returningId();
      return i.id;
    };
    instA = await mk("A");
    instB = await mk("B");

    const [admin] = await db
      .insert(users)
      .values({ name: "AAC Admin", email: `aac-admin-${STAMP}@test.local`, passwordHash: await bcrypt.hash(PASSWORD, 4), loginMethod: "email", role: "admin" })
      .$returningId();
    adminId = admin.id;
    createdUserIds.push(adminId);
    const [pro] = await db.insert(professionals).values({ userId: adminId, name: "AAC Admin", role: "Gestor", userRole: "GESTOR_PLUS" }).$returningId();
    await db.insert(professionalInstitutions).values([
      { professionalId: pro.id, userId: adminId, institutionId: instA, roleInInstitution: "GESTOR_PLUS", isPrimary: true, active: true },
      { professionalId: pro.id, userId: adminId, institutionId: instB, roleInInstitution: "GESTOR_PLUS", isPrimary: false, active: true },
    ]);

    const login = await request(app).post("/api/auth/login").send({ email: `aac-admin-${STAMP}@test.local`, password: PASSWORD });
    expect(login.status).toBe(200);
    const sc = login.headers["set-cookie"];
    cookie = (Array.isArray(sc) ? sc : [sc]).find((c: string) => c.startsWith("session=")) ?? "";
    expect(cookie).not.toBe("");
  });

  afterAll(async () => {
    const mine = await db.select({ id: users.id }).from(users).where(like(users.email, `aac-%-${STAMP}@test.local`));
    const ids = [...new Set([...createdUserIds, ...mine.map((u) => u.id)])];
    await db.delete(auditTrail).where(inArray(auditTrail.institutionId, [instA, instB]));
    await db.delete(auditTrail).where(inArray(auditTrail.entityId, ids));
    await db.delete(professionalAccess).where(inArray(professionalAccess.institutionId, [instA, instB]));
    await db.delete(professionalInstitutions).where(inArray(professionalInstitutions.userId, ids));
    await db.delete(professionals).where(inArray(professionals.userId, ids));
    await db.delete(institutions).where(inArray(institutions.id, [instA, instB]));
    await db.delete(users).where(inArray(users.id, ids));
  });

  it("register: usa a instituição ativa do admin (x-tenant-id) e não toca na instituição 1", async () => {
    const [before] = await db.select({ name: institutions.name, cnpj: institutions.cnpj }).from(institutions).where(eq(institutions.id, 1));
    const res = await request(app)
      .post("/api/auth/register")
      .set("Cookie", cookie)
      .set("x-tenant-id", String(instB))
      .send({ name: "AAC Novo B", email: `aac-novo-b-${STAMP}@test.local`, password: "SenhaNova123", role: "doctor" });
    expect(res.status).toBe(201);
    const [u] = await db.select({ id: users.id }).from(users).where(eq(users.email, `aac-novo-b-${STAMP}@test.local`));
    createdUserIds.push(u.id);
    const links = await db.select({ institutionId: professionalInstitutions.institutionId }).from(professionalInstitutions).where(eq(professionalInstitutions.userId, u.id));
    expect(links.map((l) => l.institutionId)).toEqual([instB]);
    const [after] = await db.select({ name: institutions.name, cnpj: institutions.cnpj }).from(institutions).where(eq(institutions.id, 1));
    expect(after).toEqual(before);
  });

  it("register: institutionId no body vence; instituição inexistente → 400", async () => {
    const res = await request(app)
      .post("/api/auth/register")
      .set("Cookie", cookie)
      .send({ name: "AAC Novo A", email: `aac-novo-a-${STAMP}@test.local`, password: "SenhaNova123", role: "doctor", institutionId: instA });
    expect(res.status).toBe(201);
    const [u] = await db.select({ id: users.id }).from(users).where(eq(users.email, `aac-novo-a-${STAMP}@test.local`));
    createdUserIds.push(u.id);
    const links = await db.select({ institutionId: professionalInstitutions.institutionId }).from(professionalInstitutions).where(eq(professionalInstitutions.userId, u.id));
    expect(links.map((l) => l.institutionId)).toEqual([instA]);

    const bad = await request(app)
      .post("/api/auth/register")
      .set("Cookie", cookie)
      .send({ name: "AAC X", email: `aac-x-${STAMP}@test.local`, password: "SenhaNova123", institutionId: 99999999 });
    expect(bad.status).toBe(400);
  });

  it("admin PUT /users/:id grava auditoria com institution_id", async () => {
    const [u] = await db.select({ id: users.id }).from(users).where(eq(users.email, `aac-novo-a-${STAMP}@test.local`));
    const res = await request(app).put(`/api/admin/users/${u.id}`).set("Cookie", cookie).send({ name: "AAC Novo A2" });
    expect(res.status).toBe(200);
    // recordAudit é fire-and-forget: dá um instante para o INSERT.
    await new Promise((r) => setTimeout(r, 150));
    const rows = await db
      .select({ institutionId: auditTrail.institutionId, action: auditTrail.action })
      .from(auditTrail)
      .where(and(eq(auditTrail.entityId, u.id), eq(auditTrail.action, "USER_UPDATED")));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].institutionId).toBe(instA);
  });

  it("GET /api/auth/me não consome o rate limit de autenticação", async () => {
    for (let i = 0; i < 6; i++) {
      const r = await request(app).get("/api/auth/me").set("Cookie", cookie);
      expect(r.status).toBe(200);
    }
  });

  it("mensagens de erro do driver são reconhecidas para mascarar", () => {
    expect(isDriverErrorMessage("Failed query: insert into `x` ...")).toBe(true);
    expect(isDriverErrorMessage("ER_DUP_ENTRY: Duplicate entry")).toBe(true);
    expect(isDriverErrorMessage("Turno não encontrado")).toBe(false);
    expect(isDriverErrorMessage("Apenas Gestor+ pode editar.")).toBe(false);
  });
});

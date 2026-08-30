// tests/admin-created-login.test.ts — cadastro na aba Admin precisa autenticar.
//
// Relato: profissional criado pelo Admin recebe "credenciais inválidas" no
// login e "e-mail já cadastrado" no signup. Causa: conta existente sem
// password_hash (casca) ou senha gravada que o login não encontrava.
// O Admin define a senha; o login e o auto-cadastro precisam honrar isso.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray, like } from "drizzle-orm";
import bcrypt from "bcryptjs";
import request from "supertest";
import express, { type Express } from "express";
import {
  auditTrail,
  hospitals,
  institutionConfig,
  institutions,
  managerScope,
  professionalAccess,
  professionalInstitutions,
  professionals,
  scheduleContextAllowedQualifications,
  scheduleContexts,
  sectors,
  users,
} from "../drizzle/schema";
import { getDb } from "../server/db";
import { adminRouter } from "../server/routes/admin";
import { authRouter } from "../server/routes/auth";

import { sessionAuthCookies } from "./helpers/session-cookies";

const STAMP = Date.now();
const ADMIN_PASSWORD = "SenhaAdmin123";
const USER_PASSWORD = "SenhaProfissional9";

type TestDb = NonNullable<Awaited<ReturnType<typeof getDb>>>;

describe("login após cadastro pelo Admin", () => {
  let app: Express;
  let db: TestDb;
  let institutionId: number;
  let hospitalId: number;
  let sectorId: number;
  let contextId: number;
  let adminCookie: string;

  beforeAll(async () => {
    const conn = await getDb();
    if (!conn) throw new Error("Database not available");
    db = conn;
    app = express();
    app.use(express.json());
    app.use("/api/auth", authRouter);
    app.use("/api/admin", adminRouter);

    const [institution] = await db
      .insert(institutions)
      .values({
        name: `ACL Inst ${STAMP}`,
        cnpj: String(STAMP).slice(-14).padStart(14, "0"),
        legalName: `ACL ${STAMP}`,
        tradeName: `ACL${STAMP}`.slice(0, 20),
        isActive: true,
      })
      .$returningId();
    institutionId = institution.id;
    const [hospital] = await db
      .insert(hospitals)
      .values({ institutionId, name: `ACL Hospital ${STAMP}` })
      .$returningId();
    hospitalId = hospital.id;
    const [sector] = await db
      .insert(sectors)
      .values({
        institutionId,
        hospitalId: hospital.id,
        name: `ACL Setor ${STAMP}`,
        category: "servico",
        color: "#2563EB",
      })
      .$returningId();
    sectorId = sector.id;
    const [context] = await db
      .insert(scheduleContexts)
      .values({
        institutionId,
        hospitalId: hospital.id,
        sectorId: sector.id,
        operationalProfileCode: "MEDICO_GENERALISTA",
        active: true,
      })
      .$returningId();
    contextId = context.id;

    const [admin] = await db
      .insert(users)
      .values({
        name: "ACL Admin",
        email: `acl-admin-${STAMP}@test.local`,
        passwordHash: await bcrypt.hash(ADMIN_PASSWORD, 4),
        loginMethod: "email",
        role: "admin",
      })
      .$returningId();
    const [pro] = await db
      .insert(professionals)
      .values({
        userId: admin.id,
        name: "ACL Admin",
        role: "Gestor",
        userRole: "GESTOR_PLUS",
      })
      .$returningId();
    await db.insert(professionalInstitutions).values({
      professionalId: pro.id,
      userId: admin.id,
      institutionId,
      roleInInstitution: "GESTOR_PLUS",
      isPrimary: true,
      active: true,
    });
    const login = await request(app)
      .post("/api/auth/login")
      .send({ email: `acl-admin-${STAMP}@test.local`, password: ADMIN_PASSWORD });
    adminCookie = sessionAuthCookies(login);
    expect(adminCookie).not.toBe("");
  });

  afterAll(async () => {
    const mine = await db
      .select({ id: users.id })
      .from(users)
      .where(like(users.email, `acl-%-${STAMP}@test.local`));
    const ids = mine.map((row) => row.id);
    if (ids.length === 0) return;
    await db.delete(auditTrail).where(eq(auditTrail.institutionId, institutionId));
    if (ids.length > 0) {
      await db.delete(auditTrail).where(inArray(auditTrail.entityId, ids));
    }
    await db
      .delete(managerScope)
      .where(eq(managerScope.institutionId, institutionId));
    await db
      .delete(professionalAccess)
      .where(eq(professionalAccess.institutionId, institutionId));
    await db
      .delete(professionalInstitutions)
      .where(eq(professionalInstitutions.institutionId, institutionId));
    if (ids.length > 0) {
      await db.delete(professionals).where(inArray(professionals.userId, ids));
      await db.delete(users).where(inArray(users.id, ids));
    }
    await db
      .delete(scheduleContextAllowedQualifications)
      .where(eq(scheduleContextAllowedQualifications.scheduleContextId, contextId));
    await db.delete(scheduleContexts).where(eq(scheduleContexts.id, contextId));
    await db.delete(institutionConfig).where(eq(institutionConfig.institutionId, institutionId));
    await db.delete(sectors).where(eq(sectors.id, sectorId));
    await db.delete(hospitals).where(eq(hospitals.id, hospitalId));
    await db.delete(institutions).where(eq(institutions.id, institutionId));
  });

  it("profissional criado pelo Admin entra com a senha definida no formulário", async () => {
    const email = `acl-novo-${STAMP}@test.local`;
    const created = await request(app)
      .post("/api/auth/register")
      .set("Cookie", adminCookie)
      .set("x-tenant-id", String(institutionId))
      .send({
        name: "ACL Novo",
        email,
        password: USER_PASSWORD,
        professionalRole: "doctor",
        roleInInstitution: "USER",
        medicalSpecialtyCode: null,
        operationalProfileCode: "MEDICO_GENERALISTA",
        scheduleContextIds: [contextId],
      });
    expect(created.status).toBe(201);

    const [row] = await db
      .select({ passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.email, email));
    expect(row.passwordHash?.startsWith("$2")).toBe(true);
    expect(await bcrypt.compare(USER_PASSWORD, row.passwordHash!)).toBe(true);

    const login = await request(app)
      .post("/api/auth/login")
      .send({ email: email.toUpperCase(), password: ` ${USER_PASSWORD} ` });
    expect(login.status).toBe(200);
    expect(login.body.user.email).toBe(email);

    const signup = await request(app).post("/api/auth/signup").send({
      name: "Outro",
      email,
      password: "OutraSenha99",
      operationalProfileCode: "MEDICO_GENERALISTA",
    });
    expect(signup.status).toBe(201);
    expect(signup.body).toMatchObject({ ok: true, awaitingScale: true });
  });

  it("Admin define senha em conta existente sem hash e o login passa", async () => {
    const email = `acl-casca-${STAMP}@test.local`;
    const [shell] = await db
      .insert(users)
      .values({
        name: "ACL Casca",
        email,
        passwordHash: null,
        loginMethod: null,
        role: "doctor",
      })
      .$returningId();
    await db.insert(professionals).values({
      userId: shell.id,
      name: "ACL Casca",
      role: "Médico",
      userRole: "USER",
    });

    const provisioned = await request(app)
      .post("/api/auth/register")
      .set("Cookie", adminCookie)
      .set("x-tenant-id", String(institutionId))
      .send({
        name: "ACL Casca",
        email,
        password: USER_PASSWORD,
        professionalRole: "doctor",
        roleInInstitution: "USER",
        medicalSpecialtyCode: null,
        operationalProfileCode: "MEDICO_GENERALISTA",
        scheduleContextIds: [contextId],
      });
    expect(provisioned.status).toBe(201);

    const login = await request(app)
      .post("/api/auth/login")
      .send({ email, password: USER_PASSWORD });
    expect(login.status).toBe(200);
    expect(login.body.user.id).toBe(shell.id);
  });

  it("signup define senha em casca sem hash em vez de recusar o e-mail", async () => {
    const email = `acl-signup-casca-${STAMP}@test.local`;
    await db.insert(users).values({
      name: "ACL Signup Casca",
      email,
      passwordHash: null,
      role: "doctor",
    });

    const signup = await request(app).post("/api/auth/signup").send({
      name: "ACL Signup Casca",
      email,
      password: USER_PASSWORD,
      operationalProfileCode: "MEDICO_GENERALISTA",
    });
    expect(signup.status).toBe(201);

    const login = await request(app)
      .post("/api/auth/login")
      .send({ email, password: USER_PASSWORD });
    expect(login.status).toBe(200);
  });

  it("signup em casca com vínculo ativo grava senha e não prende em pendente", async () => {
    const email = `acl-casca-ativa-${STAMP}@test.local`;
    const [shell] = await db
      .insert(users)
      .values({
        name: "ACL Casca Ativa",
        email,
        passwordHash: null,
        role: "doctor",
      })
      .$returningId();
    const [pro] = await db
      .insert(professionals)
      .values({
        userId: shell.id,
        name: "ACL Casca Ativa",
        role: "Médico",
        userRole: "USER",
      })
      .$returningId();
    await db.insert(professionalInstitutions).values({
      professionalId: pro.id,
      userId: shell.id,
      institutionId,
      roleInInstitution: "USER",
      isPrimary: true,
      active: true,
    });

    const signup = await request(app).post("/api/auth/signup").send({
      name: "ACL Casca Ativa",
      email,
      password: USER_PASSWORD,
      institutionId,
      operationalProfileCode: "MEDICO_GENERALISTA",
    });
    expect(signup.status).toBe(201);
    expect(signup.body.pending).toBe(false);

    const [row] = await db
      .select({
        approvalStatus: users.approvalStatus,
        active: professionalInstitutions.active,
      })
      .from(users)
      .innerJoin(
        professionalInstitutions,
        eq(professionalInstitutions.userId, users.id),
      )
      .where(eq(users.email, email));
    expect(row.approvalStatus).toBe("APPROVED");
    expect(row.active).toBe(true);

    const login = await request(app)
      .post("/api/auth/login")
      .send({ email, password: USER_PASSWORD });
    expect(login.status).toBe(200);
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcryptjs";
import express, { type Express } from "express";
import request from "supertest";
import { and, eq, inArray, like } from "drizzle-orm";
import {
  auditTrail,
  hospitals,
  institutions,
  managerScope,
  professionalInstitutions,
  professionals,
  users,
} from "../drizzle/schema";
import { getDb } from "../server/db";
import { adminRouter } from "../server/routes/admin";
import { authRouter } from "../server/routes/auth";
import {
  normalizeManagerScopes,
  parseManagerScopes,
} from "../lib/manager-scope-admin";

import { sessionAuthCookies } from "./helpers/session-cookies";

const STAMP = Date.now();
const PASSWORD = "SenhaAdmin123";

type TestDb = NonNullable<Awaited<ReturnType<typeof getDb>>>;

describe("manager-scope-admin: parse", () => {
  it("normaliza hospital-wide e descarta setor do mesmo hospital", () => {
    expect(
      normalizeManagerScopes([
        { hospitalId: 4, sectorId: 1 },
        { hospitalId: 4, sectorId: null },
        { hospitalId: 4, sectorId: 1 },
      ]),
    ).toEqual([{ hospitalId: 4, sectorId: null }]);
  });

  it("rejeita payload que não é lista", () => {
    expect(() => parseManagerScopes({ hospitalId: 1 })).toThrow(
      /lista/,
    );
  });
});

describe("manager-scope-admin: admin concede escopo", () => {
  let app: Express;
  let db: TestDb;
  let institutionId: number;
  let otherInstitutionId: number;
  let hospitalId: number;
  let otherHospitalId: number;
  let adminCookie: string;
  let adminId: number;

  beforeAll(async () => {
    const conn = await getDb();
    if (!conn) throw new Error("Database not available");
    db = conn;
    app = express();
    app.use(express.json());
    app.use("/api/auth", authRouter);
    app.use("/api/admin", adminRouter);

    const [inst] = await db
      .insert(institutions)
      .values({
        name: `ScopeAdmin ${STAMP}`,
        cnpj: `${STAMP}21`.slice(-14).padStart(14, "0"),
        legalName: `ScopeAdmin ${STAMP}`,
        tradeName: `SA${STAMP}`.slice(0, 20),
        isActive: true,
      })
      .$returningId();
    institutionId = inst.id;
    const [other] = await db
      .insert(institutions)
      .values({
        name: `ScopeAdmin Other ${STAMP}`,
        cnpj: `${STAMP}22`.slice(-14).padStart(14, "0"),
        legalName: `ScopeAdmin Other ${STAMP}`,
        tradeName: `SO${STAMP}`.slice(0, 20),
        isActive: true,
      })
      .$returningId();
    otherInstitutionId = other.id;

    const [hospital] = await db
      .insert(hospitals)
      .values({ institutionId, name: `Scope Hospital ${STAMP}` })
      .$returningId();
    hospitalId = hospital.id;
    const [foreignHospital] = await db
      .insert(hospitals)
      .values({
        institutionId: otherInstitutionId,
        name: `Scope Foreign ${STAMP}`,
      })
      .$returningId();
    otherHospitalId = foreignHospital.id;

    const adminEmail = `scope-admin-${STAMP}@test.local`;
    const [admin] = await db
      .insert(users)
      .values({
        name: "Scope Admin",
        email: adminEmail,
        passwordHash: await bcrypt.hash(PASSWORD, 4),
        loginMethod: "email",
        role: "admin",
      })
      .$returningId();
    adminId = admin.id;
    const [pro] = await db
      .insert(professionals)
      .values({
        userId: admin.id,
        name: "Scope Admin",
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
      .send({ email: adminEmail, password: PASSWORD });
    expect(login.status).toBe(200);
    adminCookie = sessionAuthCookies(login);
    expect(adminCookie).not.toBe("");
  });

  afterAll(async () => {
    const mine = await db
      .select({ id: users.id })
      .from(users)
      .where(like(users.email, `scope-%-${STAMP}@test.local`));
    const ids = mine.map((row) => row.id);
    await db
      .delete(auditTrail)
      .where(inArray(auditTrail.institutionId, [institutionId, otherInstitutionId]));
    await db
      .delete(managerScope)
      .where(inArray(managerScope.institutionId, [institutionId, otherInstitutionId]));
    if (ids.length) {
      await db
        .delete(professionalInstitutions)
        .where(inArray(professionalInstitutions.userId, ids));
      await db.delete(professionals).where(inArray(professionals.userId, ids));
      await db.delete(users).where(inArray(users.id, ids));
    }
    await db
      .delete(hospitals)
      .where(inArray(hospitals.institutionId, [institutionId, otherInstitutionId]));
    await db
      .delete(institutions)
      .where(inArray(institutions.id, [institutionId, otherInstitutionId]));
  });

  it("promover a GESTOR_MEDICO com um hospital grava escopo hospitalar", async () => {
    const email = `scope-doc-${STAMP}@test.local`;
    const created = await request(app)
      .post("/api/auth/register")
      .set("Cookie", adminCookie)
      .set("x-tenant-id", String(institutionId))
      .set("x-client-expected-user-id", String(adminId))
      .send({
        name: "Scope Doc",
        email,
        password: PASSWORD,
        professionalRole: "nurse",
        roleInInstitution: "USER",
      });
    expect(created.status).toBe(201);
    const userId = created.body.user.id as number;

    const promoted = await request(app)
      .put(`/api/admin/users/${userId}`)
      .set("Cookie", adminCookie)
      .set("x-tenant-id", String(institutionId))
      .set("x-client-expected-user-id", String(adminId))
      .send({ roleInInstitution: "GESTOR_MEDICO" });
    expect(promoted.status).toBe(200);

    const [pro] = await db
      .select({ id: professionals.id })
      .from(professionals)
      .where(eq(professionals.userId, userId));
    const scopes = await db
      .select({
        hospitalId: managerScope.hospitalId,
        sectorId: managerScope.sectorId,
        active: managerScope.active,
      })
      .from(managerScope)
      .where(
        and(
          eq(managerScope.institutionId, institutionId),
          eq(managerScope.managerProfessionalId, pro.id),
          eq(managerScope.active, true),
        ),
      );
    expect(scopes).toEqual([
      { hospitalId, sectorId: null, active: true },
    ]);
  });

  it("recusa hospital de outro tenant", async () => {
    const email = `scope-foreign-${STAMP}@test.local`;
    const created = await request(app)
      .post("/api/auth/register")
      .set("Cookie", adminCookie)
      .set("x-tenant-id", String(institutionId))
      .set("x-client-expected-user-id", String(adminId))
      .send({
        name: "Scope Foreign",
        email,
        password: PASSWORD,
        professionalRole: "nurse",
        roleInInstitution: "USER",
      });
    expect(created.status).toBe(201);

    const denied = await request(app)
      .put(`/api/admin/users/${created.body.user.id}`)
      .set("Cookie", adminCookie)
      .set("x-tenant-id", String(institutionId))
      .set("x-client-expected-user-id", String(adminId))
      .send({
        roleInInstitution: "GESTOR_MEDICO",
        managerScopes: [{ hospitalId: otherHospitalId, sectorId: null }],
      });
    expect(denied.status).toBe(400);
    expect(denied.body.error).toMatch(/não pertence a esta instituição/);
  });

  it("dois hospitais sem escolha explícita exigem seleção", async () => {
    const [second] = await db
      .insert(hospitals)
      .values({ institutionId, name: `Scope Hospital 2 ${STAMP}` })
      .$returningId();
    const email = `scope-multi-${STAMP}@test.local`;
    const created = await request(app)
      .post("/api/auth/register")
      .set("Cookie", adminCookie)
      .set("x-tenant-id", String(institutionId))
      .set("x-client-expected-user-id", String(adminId))
      .send({
        name: "Scope Multi",
        email,
        password: PASSWORD,
        professionalRole: "nurse",
        roleInInstitution: "USER",
      });
    expect(created.status).toBe(201);
    const denied = await request(app)
      .put(`/api/admin/users/${created.body.user.id}`)
      .set("Cookie", adminCookie)
      .set("x-tenant-id", String(institutionId))
      .set("x-client-expected-user-id", String(adminId))
      .send({ roleInInstitution: "GESTOR_MEDICO" });
    expect(denied.status).toBe(400);
    expect(denied.body.error).toMatch(/Selecione o hospital/);

    const ok = await request(app)
      .put(`/api/admin/users/${created.body.user.id}`)
      .set("Cookie", adminCookie)
      .set("x-tenant-id", String(institutionId))
      .set("x-client-expected-user-id", String(adminId))
      .send({
        roleInInstitution: "GESTOR_MEDICO",
        managerScopes: [{ hospitalId: second.id, sectorId: null }],
      });
    expect(ok.status).toBe(200);
  });
});

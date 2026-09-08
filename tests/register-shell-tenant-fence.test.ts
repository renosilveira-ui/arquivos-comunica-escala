// tests/register-shell-tenant-fence.test.ts
//
// POST /api/auth/register: a ativação administrativa de casca sem senha
// não pode tomar conta de outro tenant, nem escolher professional por
// LIMIT 1, nem divergir professionals / professional_institutions / ACL.
// Instituições, hospitais irmãos e setores nascem nesta suíte — nenhum ID
// de produção é hardcoded.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, asc, eq, inArray, like } from "drizzle-orm";
import bcrypt from "bcryptjs";
import mysql from "mysql2/promise";
import request, { type Test } from "supertest";
import express, { type Express } from "express";
import {
  auditTrail,
  hospitals,
  managerScope,
  professionalAccess,
  professionalInstitutions,
  professionals,
  scheduleContexts,
  sectors,
  users,
  institutions,
} from "../drizzle/schema";
import { getDb } from "../server/db";
import { authRouter } from "../server/routes/auth";
import { sessionAuthCookies } from "./helpers/session-cookies";

const STAMP = Date.now();
const GESTOR_PASSWORD = "SenhaGestor123";
const ATTEMPTED_PASSWORD = "SenhaTomada99";
const EMAIL_ALREADY_REGISTERED =
  "Este e-mail já tem conta. Entre ou use Esqueci minha senha.";

type TestDb = NonNullable<Awaited<ReturnType<typeof getDb>>>;

type TenantGraph = {
  institutionId: number;
  hospitalId: number;
  siblingHospitalId: number;
  sectorId: number;
  siblingSectorId: number;
  contextId: number;
};

type GestorActor = {
  userId: number;
  professionalId: number;
  cookie: string;
};

function generalistRegistration(scheduleContextId: number) {
  return {
    medicalSpecialtyCode: null,
    operationalProfileCode: "MEDICO_GENERALISTA" as const,
    scheduleContextIds: [scheduleContextId],
  };
}

function registerPayload(
  name: string,
  email: string,
  contextId: number,
  password = ATTEMPTED_PASSWORD,
) {
  return {
    name,
    email,
    password,
    professionalRole: "doctor" as const,
    roleInInstitution: "USER" as const,
    ...generalistRegistration(contextId),
  };
}

function testDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL ausente no teste isolado");
  return url;
}

type OverlapProof = {
  usersPrimaryWaiters: number;
  innodbLockWaitTrx: number;
};

async function readOverlapProof(
  observer: mysql.Connection,
): Promise<OverlapProof> {
  const [lockRows] = await observer.query(
    `SELECT COUNT(*) AS n
     FROM performance_schema.data_locks
     WHERE OBJECT_SCHEMA = DATABASE()
       AND OBJECT_NAME = 'users'
       AND INDEX_NAME = 'PRIMARY'
       AND LOCK_STATUS = 'WAITING'`,
  );
  const [trxRows] = await observer.query(
    `SELECT COUNT(*) AS n
     FROM information_schema.innodb_trx
     WHERE trx_state = 'LOCK WAIT'`,
  );
  const lockList = lockRows as { n: number | string }[];
  const trxList = trxRows as { n: number | string }[];
  return {
    usersPrimaryWaiters: Number(lockList[0]?.n ?? 0),
    innodbLockWaitTrx: Number(trxList[0]?.n ?? 0),
  };
}

async function waitForOverlappingShellLock(
  observer: mysql.Connection,
  timeoutMs: number,
): Promise<OverlapProof> {
  const deadline = Date.now() + timeoutMs;
  let last: OverlapProof = { usersPrimaryWaiters: 0, innodbLockWaitTrx: 0 };
  while (Date.now() < deadline) {
    last = await readOverlapProof(observer);
    if (last.usersPrimaryWaiters >= 2 || last.innodbLockWaitTrx >= 2) {
      return last;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(
    `Corrida não sobreposta na casca: ${JSON.stringify(last)}`,
  );
}

async function createTenantGraph(
  db: TestDb,
  tag: string,
): Promise<TenantGraph> {
  const [institution] = await db
    .insert(institutions)
    .values({
      name: `RSTF Inst ${tag} ${STAMP}`,
      cnpj: `${STAMP}${tag === "A" ? "11" : tag === "B" ? "12" : "13"}`
        .slice(-14)
        .padStart(14, "0"),
      legalName: `RSTF ${tag} ${STAMP}`,
      tradeName: `RSTF${tag}${STAMP}`.slice(0, 20),
      isActive: true,
    })
    .$returningId();
  const [hospital] = await db
    .insert(hospitals)
    .values({
      institutionId: institution.id,
      name: `RSTF Hospital ${tag} ${STAMP}`,
    })
    .$returningId();
  const [siblingHospital] = await db
    .insert(hospitals)
    .values({
      institutionId: institution.id,
      name: `RSTF Hospital irmão ${tag} ${STAMP}`,
    })
    .$returningId();
  const [sector] = await db
    .insert(sectors)
    .values({
      institutionId: institution.id,
      hospitalId: hospital.id,
      name: `RSTF Setor ${tag} ${STAMP}`,
      category: "servico",
      color: "#2563EB",
    })
    .$returningId();
  const [siblingSector] = await db
    .insert(sectors)
    .values({
      institutionId: institution.id,
      hospitalId: siblingHospital.id,
      name: `RSTF Setor irmão ${tag} ${STAMP}`,
      category: "servico",
      color: "#7C3AED",
    })
    .$returningId();
  const [context] = await db
    .insert(scheduleContexts)
    .values({
      institutionId: institution.id,
      hospitalId: hospital.id,
      sectorId: sector.id,
      medicalSpecialtyId: null,
      operationalProfileCode: "MEDICO_GENERALISTA",
      active: true,
    })
    .$returningId();
  return {
    institutionId: institution.id,
    hospitalId: hospital.id,
    siblingHospitalId: siblingHospital.id,
    sectorId: sector.id,
    siblingSectorId: siblingSector.id,
    contextId: context.id,
  };
}

async function createGestor(
  db: TestDb,
  app: Express,
  tenant: TenantGraph,
  tag: string,
): Promise<GestorActor> {
  const [user] = await db
    .insert(users)
    .values({
      name: `RSTF Gestor ${tag}`,
      email: `rstf-gestor-${tag}-${STAMP}@test.local`,
      passwordHash: await bcrypt.hash(GESTOR_PASSWORD, 4),
      loginMethod: "email",
      role: "doctor",
    })
    .$returningId();
  const [professional] = await db
    .insert(professionals)
    .values({
      userId: user.id,
      name: `RSTF Gestor ${tag}`,
      role: "Médico",
      userRole: "GESTOR_PLUS",
      professionCode: "MEDIC",
    })
    .$returningId();
  await db.insert(professionalInstitutions).values({
    professionalId: professional.id,
    userId: user.id,
    institutionId: tenant.institutionId,
    roleInInstitution: "GESTOR_PLUS",
    isPrimary: true,
    active: true,
  });
  const login = await request(app)
    .post("/api/auth/login")
    .send({
      email: `rstf-gestor-${tag}-${STAMP}@test.local`,
      password: GESTOR_PASSWORD,
    });
  expect(login.status).toBe(200);
  const cookie = sessionAuthCookies(login);
  expect(cookie).not.toBe("");
  return { userId: user.id, professionalId: professional.id, cookie };
}

async function insertShellUser(
  db: TestDb,
  tag: string,
  extras?: { passwordHash?: string | null; role?: "doctor" | "nurse" },
) {
  const email = `rstf-casca-${tag}-${STAMP}@test.local`;
  const [user] = await db
    .insert(users)
    .values({
      name: `RSTF Casca ${tag}`,
      email,
      passwordHash: extras?.passwordHash ?? null,
      loginMethod: extras?.passwordHash ? "email" : null,
      role: extras?.role ?? "doctor",
    })
    .$returningId();
  return { id: user.id, email };
}

async function insertProfessionalFor(
  db: TestDb,
  userId: number,
  name: string,
) {
  const [row] = await db
    .insert(professionals)
    .values({
      userId,
      name,
      role: "Médico",
      userRole: "USER",
      professionCode: "MEDIC",
      specialty: "Clínica",
    })
    .$returningId();
  return row.id;
}

async function snapshotIdentity(db: TestDb, userId: number) {
  const [user] = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      passwordHash: users.passwordHash,
      loginMethod: users.loginMethod,
      role: users.role,
      approvalStatus: users.approvalStatus,
      mustChangePassword: users.mustChangePassword,
      sessionVersion: users.sessionVersion,
    })
    .from(users)
    .where(eq(users.id, userId));
  const professionalRows = await db
    .select({
      id: professionals.id,
      userId: professionals.userId,
      name: professionals.name,
      role: professionals.role,
      professionCode: professionals.professionCode,
      customProfessionName: professionals.customProfessionName,
      specialty: professionals.specialty,
      medicalSpecialtyId: professionals.medicalSpecialtyId,
      operationalProfileCode: professionals.operationalProfileCode,
      userRole: professionals.userRole,
    })
    .from(professionals)
    .where(eq(professionals.userId, userId))
    .orderBy(asc(professionals.id));
  const membershipRows = await db
    .select({
      id: professionalInstitutions.id,
      professionalId: professionalInstitutions.professionalId,
      userId: professionalInstitutions.userId,
      institutionId: professionalInstitutions.institutionId,
      roleInInstitution: professionalInstitutions.roleInInstitution,
      isPrimary: professionalInstitutions.isPrimary,
      active: professionalInstitutions.active,
    })
    .from(professionalInstitutions)
    .where(eq(professionalInstitutions.userId, userId))
    .orderBy(asc(professionalInstitutions.id));
  const professionalIds = [
    ...new Set([
      ...professionalRows.map((row) => row.id),
      ...membershipRows.map((row) => row.professionalId),
    ]),
  ];
  const accessRows =
    professionalIds.length === 0
      ? []
      : await db
          .select({
            id: professionalAccess.id,
            professionalId: professionalAccess.professionalId,
            institutionId: professionalAccess.institutionId,
            hospitalId: professionalAccess.hospitalId,
            sectorId: professionalAccess.sectorId,
            canAccess: professionalAccess.canAccess,
          })
          .from(professionalAccess)
          .where(inArray(professionalAccess.professionalId, professionalIds))
          .orderBy(asc(professionalAccess.id));
  const scopeRows =
    professionalIds.length === 0
      ? []
      : await db
          .select({
            id: managerScope.id,
            institutionId: managerScope.institutionId,
            managerProfessionalId: managerScope.managerProfessionalId,
            hospitalId: managerScope.hospitalId,
            sectorId: managerScope.sectorId,
            active: managerScope.active,
          })
          .from(managerScope)
          .where(inArray(managerScope.managerProfessionalId, professionalIds))
          .orderBy(asc(managerScope.id));
  return { user, professionalRows, membershipRows, accessRows, scopeRows };
}

function expectIdentityFrozen(
  before: Awaited<ReturnType<typeof snapshotIdentity>>,
  after: Awaited<ReturnType<typeof snapshotIdentity>>,
) {
  expect(after.user).toEqual(before.user);
  expect(after.professionalRows).toEqual(before.professionalRows);
  expect(after.membershipRows).toEqual(before.membershipRows);
  expect(after.accessRows).toEqual(before.accessRows);
  expect(after.scopeRows).toEqual(before.scopeRows);
}

async function accessAndScopeRows(
  db: TestDb,
  professionalIds: number[],
  institutionId: number,
) {
  if (professionalIds.length === 0) {
    return { access: [], scopes: [] };
  }
  const access = await db
    .select({
      professionalId: professionalAccess.professionalId,
      hospitalId: professionalAccess.hospitalId,
      sectorId: professionalAccess.sectorId,
    })
    .from(professionalAccess)
    .where(
      and(
        eq(professionalAccess.institutionId, institutionId),
        inArray(professionalAccess.professionalId, professionalIds),
      ),
    );
  const scopes = await db
    .select({ id: managerScope.id })
    .from(managerScope)
    .where(
      and(
        eq(managerScope.institutionId, institutionId),
        inArray(managerScope.managerProfessionalId, professionalIds),
      ),
    );
  return { access, scopes };
}

async function successAudits(db: TestDb, userId: number) {
  return db
    .select({
      id: auditTrail.id,
      action: auditTrail.action,
      institutionId: auditTrail.institutionId,
    })
    .from(auditTrail)
    .where(
      and(
        eq(auditTrail.entityType, "USER"),
        eq(auditTrail.entityId, userId),
        inArray(auditTrail.action, ["USER_CREATED", "USER_UPDATED"]),
      ),
    );
}

describe("register: cerca de tenant na ativação de casca", () => {
  let app: Express;
  let db: TestDb;
  let tenantA: TenantGraph;
  let tenantB: TenantGraph;
  let gestorA: GestorActor;
  let gestorB: GestorActor;

  beforeAll(async () => {
    const conn = await getDb();
    if (!conn) throw new Error("Database not available");
    db = conn;
    app = express();
    app.use(express.json());
    app.use("/api/auth", authRouter);

    tenantA = await createTenantGraph(db, "A");
    tenantB = await createTenantGraph(db, "B");
    expect(tenantA.institutionId).not.toBe(tenantB.institutionId);
    expect(tenantA.hospitalId).not.toBe(tenantA.siblingHospitalId);
    expect(tenantA.sectorId).not.toBe(tenantA.siblingSectorId);
    expect(tenantB.hospitalId).not.toBe(tenantB.siblingHospitalId);

    gestorA = await createGestor(db, app, tenantA, "A");
    gestorB = await createGestor(db, app, tenantB, "B");
    expect(gestorA.userId).not.toBe(gestorB.userId);
  });

  afterAll(async () => {
    const mine = await db
      .select({ id: users.id })
      .from(users)
      .where(like(users.email, `rstf-%-${STAMP}@test.local`));
    const ids = mine.map((row) => row.id);
    const institutionIds = [tenantA.institutionId, tenantB.institutionId];
    await db
      .delete(auditTrail)
      .where(inArray(auditTrail.institutionId, institutionIds));
    if (ids.length > 0) {
      await db.delete(auditTrail).where(inArray(auditTrail.entityId, ids));
    }
    await db
      .delete(managerScope)
      .where(inArray(managerScope.institutionId, institutionIds));
    await db
      .delete(professionalAccess)
      .where(inArray(professionalAccess.institutionId, institutionIds));
    await db
      .delete(professionalInstitutions)
      .where(inArray(professionalInstitutions.institutionId, institutionIds));
    if (ids.length > 0) {
      await db.delete(professionals).where(inArray(professionals.userId, ids));
      await db.delete(users).where(inArray(users.id, ids));
    }
    await db
      .delete(scheduleContexts)
      .where(inArray(scheduleContexts.institutionId, institutionIds));
    await db
      .delete(sectors)
      .where(inArray(sectors.institutionId, institutionIds));
    await db
      .delete(hospitals)
      .where(inArray(hospitals.institutionId, institutionIds));
    await db.delete(institutions).where(inArray(institutions.id, institutionIds));
  });

  it("A: casca sem senha com vínculo ativo em A recusa gestor de B (fail-closed)", async () => {
    const shell = await insertShellUser(db, "ativa-a");
    const professionalId = await insertProfessionalFor(
      db,
      shell.id,
      "RSTF Casca ativa A",
    );
    await db.insert(professionalInstitutions).values({
      professionalId,
      userId: shell.id,
      institutionId: tenantA.institutionId,
      roleInInstitution: "USER",
      isPrimary: true,
      active: true,
    });
    const before = await snapshotIdentity(db, shell.id);

    const response = await request(app)
      .post("/api/auth/register")
      .set("Cookie", gestorB.cookie)
      .set("x-tenant-id", String(tenantB.institutionId))
      .send(registerPayload("Invasor B", shell.email, tenantB.contextId));

    expect(response.status).toBe(409);
    expect(response.body.error).toBe(EMAIL_ALREADY_REGISTERED);

    const after = await snapshotIdentity(db, shell.id);
    expectIdentityFrozen(before, after);
    expect(after.user.passwordHash).toBeNull();
    expect(after.accessRows).toEqual([]);
    expect(after.scopeRows).toEqual([]);
    expect(await successAudits(db, shell.id)).toEqual([]);

    const login = await request(app)
      .post("/api/auth/login")
      .send({ email: shell.email, password: ATTEMPTED_PASSWORD });
    expect(login.status).toBe(401);
  });

  it("B: vínculo estrangeiro inativo também recusa (identidade institucional permanece)", async () => {
    const shell = await insertShellUser(db, "inativa-a");
    const professionalId = await insertProfessionalFor(
      db,
      shell.id,
      "RSTF Casca inativa A",
    );
    await db.insert(professionalInstitutions).values({
      professionalId,
      userId: shell.id,
      institutionId: tenantA.institutionId,
      roleInInstitution: "USER",
      isPrimary: true,
      active: false,
    });
    const before = await snapshotIdentity(db, shell.id);

    const response = await request(app)
      .post("/api/auth/register")
      .set("Cookie", gestorB.cookie)
      .set("x-tenant-id", String(tenantB.institutionId))
      .send(registerPayload("Invasor inativo", shell.email, tenantB.contextId));

    expect(response.status).toBe(409);
    expect(response.body.error).toBe(EMAIL_ALREADY_REGISTERED);

    const after = await snapshotIdentity(db, shell.id);
    expectIdentityFrozen(before, after);
    expect(after.user.passwordHash).toBeNull();
    expect(after.membershipRows[0]?.active).toBe(false);
    expect(await successAudits(db, shell.id)).toEqual([]);

    const login = await request(app)
      .post("/api/auth/login")
      .send({ email: shell.email, password: ATTEMPTED_PASSWORD });
    expect(login.status).toBe(401);
  });

  it("C: casca sem vínculo e sem professional ativa no tenant do gestor", async () => {
    const shell = await insertShellUser(db, "vazia");
    const before = await snapshotIdentity(db, shell.id);
    expect(before.professionalRows).toHaveLength(0);
    expect(before.membershipRows).toHaveLength(0);

    const response = await request(app)
      .post("/api/auth/register")
      .set("Cookie", gestorB.cookie)
      .set("x-tenant-id", String(tenantB.institutionId))
      .send(registerPayload("RSTF Casca vazia", shell.email, tenantB.contextId));
    expect(response.status).toBe(201);

    const after = await snapshotIdentity(db, shell.id);
    expect(after.user.passwordHash?.startsWith("$2")).toBe(true);
    expect(after.professionalRows).toHaveLength(1);
    expect(after.membershipRows).toEqual([
      expect.objectContaining({
        userId: shell.id,
        professionalId: after.professionalRows[0]?.id,
        institutionId: tenantB.institutionId,
        active: true,
      }),
    ]);
    const sideEffects = await accessAndScopeRows(
      db,
      [after.professionalRows[0]!.id],
      tenantB.institutionId,
    );
    expect(sideEffects.access).toEqual([
      expect.objectContaining({
        professionalId: after.professionalRows[0]?.id,
        hospitalId: tenantB.hospitalId,
        sectorId: tenantB.sectorId,
      }),
    ]);
    expect(
      sideEffects.access.some(
        (row) =>
          row.hospitalId === tenantB.siblingHospitalId ||
          row.sectorId === tenantB.siblingSectorId,
      ),
    ).toBe(false);
    expect(await successAudits(db, shell.id)).toEqual([
      expect.objectContaining({
        action: "USER_UPDATED",
        institutionId: tenantB.institutionId,
      }),
    ]);

    const login = await request(app)
      .post("/api/auth/login")
      .send({ email: shell.email, password: ATTEMPTED_PASSWORD });
    expect(login.status).toBe(200);
    expect(login.body.user.id).toBe(shell.id);
  });

  it("D: casca com exatamente um professional coerente reutiliza o mesmo professionalId", async () => {
    const shell = await insertShellUser(db, "um-pro");
    const professionalId = await insertProfessionalFor(
      db,
      shell.id,
      "RSTF Casca um pro",
    );

    const response = await request(app)
      .post("/api/auth/register")
      .set("Cookie", gestorB.cookie)
      .set("x-tenant-id", String(tenantB.institutionId))
      .send(registerPayload("RSTF Casca um pro", shell.email, tenantB.contextId));
    expect(response.status).toBe(201);

    const after = await snapshotIdentity(db, shell.id);
    expect(after.professionalRows.map((row) => row.id)).toEqual([professionalId]);
    expect(after.membershipRows).toEqual([
      expect.objectContaining({
        userId: shell.id,
        professionalId,
        institutionId: tenantB.institutionId,
        active: true,
      }),
    ]);
    const sideEffects = await accessAndScopeRows(
      db,
      [professionalId],
      tenantB.institutionId,
    );
    expect(sideEffects.access).toEqual([
      expect.objectContaining({
        professionalId,
        hospitalId: tenantB.hospitalId,
        sectorId: tenantB.sectorId,
      }),
    ]);
  });

  it("D2: vínculo coerente no próprio tenant reativa sem criar segundo professional", async () => {
    const shell = await insertShellUser(db, "proprio-tenant");
    const professionalId = await insertProfessionalFor(
      db,
      shell.id,
      "RSTF Casca próprio tenant",
    );
    await db.insert(professionalInstitutions).values({
      professionalId,
      userId: shell.id,
      institutionId: tenantB.institutionId,
      roleInInstitution: "USER",
      isPrimary: true,
      active: false,
    });

    const response = await request(app)
      .post("/api/auth/register")
      .set("Cookie", gestorB.cookie)
      .set("x-tenant-id", String(tenantB.institutionId))
      .send(
        registerPayload(
          "RSTF Casca próprio tenant",
          shell.email,
          tenantB.contextId,
        ),
      );
    expect(response.status).toBe(201);

    const after = await snapshotIdentity(db, shell.id);
    expect(after.professionalRows).toHaveLength(1);
    expect(after.professionalRows[0]?.id).toBe(professionalId);
    expect(after.membershipRows).toHaveLength(1);
    expect(after.membershipRows[0]).toEqual(
      expect.objectContaining({
        professionalId,
        userId: shell.id,
        institutionId: tenantB.institutionId,
        active: true,
      }),
    );
  });

  it("E: dois professionals para o mesmo user recusam sem escolher linha", async () => {
    const shell = await insertShellUser(db, "dois-pro");
    const firstId = await insertProfessionalFor(db, shell.id, "RSTF Casca P1");
    const secondId = await insertProfessionalFor(db, shell.id, "RSTF Casca P2");
    const before = await snapshotIdentity(db, shell.id);
    expect(new Set(before.professionalRows.map((row) => row.id))).toEqual(
      new Set([firstId, secondId]),
    );

    const response = await request(app)
      .post("/api/auth/register")
      .set("Cookie", gestorB.cookie)
      .set("x-tenant-id", String(tenantB.institutionId))
      .send(registerPayload("RSTF dois pro", shell.email, tenantB.contextId));
    expect(response.status).toBe(409);
    expect(response.body.error).toBe(EMAIL_ALREADY_REGISTERED);

    const after = await snapshotIdentity(db, shell.id);
    expectIdentityFrozen(before, after);
    expect(after.user.passwordHash).toBeNull();
    expect(after.membershipRows).toEqual([]);
    expect(after.accessRows).toEqual([]);
    expect(after.scopeRows).toEqual([]);
    expect(await successAudits(db, shell.id)).toEqual([]);
  });

  it("F: vínculo do tenant apontando para professional incompatível recusa", async () => {
    const shell = await insertShellUser(db, "divergente");
    const coherentId = await insertProfessionalFor(
      db,
      shell.id,
      "RSTF Casca coerente",
    );
    const decoy = await insertShellUser(db, "decoy-pro");
    const decoyProfessionalId = await insertProfessionalFor(
      db,
      decoy.id,
      "RSTF Decoy",
    );
    await db.insert(professionalInstitutions).values({
      professionalId: decoyProfessionalId,
      userId: shell.id,
      institutionId: tenantB.institutionId,
      roleInInstitution: "USER",
      isPrimary: true,
      active: true,
    });
    const before = await snapshotIdentity(db, shell.id);
    expect(before.membershipRows[0]?.professionalId).toBe(decoyProfessionalId);
    expect(before.membershipRows[0]?.professionalId).not.toBe(coherentId);

    const response = await request(app)
      .post("/api/auth/register")
      .set("Cookie", gestorB.cookie)
      .set("x-tenant-id", String(tenantB.institutionId))
      .send(registerPayload("RSTF divergente", shell.email, tenantB.contextId));
    expect(response.status).toBe(409);
    expect(response.body.error).toBe(EMAIL_ALREADY_REGISTERED);

    const after = await snapshotIdentity(db, shell.id);
    expectIdentityFrozen(before, after);
    expect(after.user.passwordHash).toBeNull();
    expect(after.accessRows).toEqual([]);
    expect(after.scopeRows).toEqual([]);
    expect(await successAudits(db, shell.id)).toEqual([]);
  });

  it("G: conta com senha utilizável preserva 409 e não muta", async () => {
    const hash = await bcrypt.hash("SenhaJaDefinida1", 4);
    const shell = await insertShellUser(db, "com-senha", {
      passwordHash: hash,
    });
    const professionalId = await insertProfessionalFor(
      db,
      shell.id,
      "RSTF com senha",
    );
    await db.insert(professionalInstitutions).values({
      professionalId,
      userId: shell.id,
      institutionId: tenantA.institutionId,
      roleInInstitution: "USER",
      isPrimary: true,
      active: true,
    });
    const before = await snapshotIdentity(db, shell.id);

    const response = await request(app)
      .post("/api/auth/register")
      .set("Cookie", gestorB.cookie)
      .set("x-tenant-id", String(tenantB.institutionId))
      .send(registerPayload("RSTF com senha", shell.email, tenantB.contextId));
    expect(response.status).toBe(409);
    expect(response.body.error).toBe(EMAIL_ALREADY_REGISTERED);

    const after = await snapshotIdentity(db, shell.id);
    expectIdentityFrozen(before, after);
    expect(after.user.passwordHash).toBe(hash);
    expect(await successAudits(db, shell.id)).toEqual([]);

    const originalLogin = await request(app)
      .post("/api/auth/login")
      .send({ email: shell.email, password: "SenhaJaDefinida1" });
    expect(originalLogin.status).toBe(200);
    const attempted = await request(app)
      .post("/api/auth/login")
      .send({ email: shell.email, password: ATTEMPTED_PASSWORD });
    expect(attempted.status).toBe(401);
  });

  it("H: dois gestores de tenants distintos não ativam a mesma casca em paralelo", async () => {
    const shell = await insertShellUser(db, "corrida");
    const before = await snapshotIdentity(db, shell.id);
    expect(before.professionalRows).toHaveLength(0);
    expect(before.membershipRows).toHaveLength(0);
    expect(before.user.passwordHash).toBeNull();
    expect(before.user.loginMethod).toBeNull();

    const passwordA = "SenhaCorridaA9";
    const passwordB = "SenhaCorridaB8";
    const holder = await mysql.createConnection(testDatabaseUrl());
    const observer = await mysql.createConnection(testDatabaseUrl());
    let fromAPromise: Test | undefined;
    let fromBPromise: Test | undefined;
    let overlap: OverlapProof | null = null;
    try {
      await holder.beginTransaction();
      const [held] = await holder.query(
        "SELECT id FROM users WHERE id = ? FOR UPDATE",
        [shell.id],
      );
      expect((held as { id: number }[]).map((row) => row.id)).toEqual([
        shell.id,
      ]);

      fromAPromise = request(app)
        .post("/api/auth/register")
        .set("Cookie", gestorA.cookie)
        .set("x-tenant-id", String(tenantA.institutionId))
        .send(
          registerPayload(
            "RSTF corrida A",
            shell.email,
            tenantA.contextId,
            passwordA,
          ),
        );
      fromBPromise = request(app)
        .post("/api/auth/register")
        .set("Cookie", gestorB.cookie)
        .set("x-tenant-id", String(tenantB.institutionId))
        .send(
          registerPayload(
            "RSTF corrida B",
            shell.email,
            tenantB.contextId,
            passwordB,
          ),
        );
      // SuperTest só dispara o HTTP ao tratar o Test como thenable.
      void fromAPromise.then(() => undefined);
      void fromBPromise.then(() => undefined);

      overlap = await waitForOverlappingShellLock(observer, 20_000);
      await holder.rollback();
    } catch (error) {
      await holder.rollback().catch(() => undefined);
      if (fromAPromise && fromBPromise) {
        await Promise.allSettled([fromAPromise, fromBPromise]);
      }
      throw error;
    } finally {
      await holder.end();
      await observer.end();
    }

    if (!fromAPromise || !fromBPromise || !overlap) {
      throw new Error("corrida não iniciou sob o lock da casca");
    }

    expect(overlap.usersPrimaryWaiters >= 2 || overlap.innodbLockWaitTrx >= 2).toBe(
      true,
    );

    const [fromA, fromB] = await Promise.all([fromAPromise, fromBPromise]);
    const statuses = [fromA.status, fromB.status];
    expect(statuses.filter((status) => status === 201)).toHaveLength(1);
    expect(statuses.filter((status) => status === 409)).toHaveLength(1);

    const winnerIsA = fromA.status === 201;
    const winner = winnerIsA ? fromA : fromB;
    const loser = winnerIsA ? fromB : fromA;
    const winnerTenant = winnerIsA ? tenantA : tenantB;
    const loserTenant = winnerIsA ? tenantB : tenantA;
    const winnerPassword = winnerIsA ? passwordA : passwordB;
    const loserPassword = winnerIsA ? passwordB : passwordA;
    const winnerName = winnerIsA ? "RSTF corrida A" : "RSTF corrida B";

    expect(loser.status).toBe(409);
    expect(loser.body.error).toBe(EMAIL_ALREADY_REGISTERED);
    expect(winner.body.user.id).toBe(shell.id);

    const after = await snapshotIdentity(db, shell.id);
    expect(after.user.email).toBe(shell.email);
    expect(after.user.name).toBe(winnerName);
    expect(after.user.loginMethod).toBe("email");
    expect(after.user.approvalStatus).toBe(before.user.approvalStatus);
    expect(after.user.mustChangePassword).toBe(before.user.mustChangePassword);
    expect(after.user.passwordHash?.startsWith("$2")).toBe(true);
    expect(await bcrypt.compare(winnerPassword, after.user.passwordHash!)).toBe(
      true,
    );
    expect(await bcrypt.compare(loserPassword, after.user.passwordHash!)).toBe(
      false,
    );

    expect(after.professionalRows).toHaveLength(1);
    const provenId = after.professionalRows[0]!.id;
    expect(after.professionalRows[0]?.userId).toBe(shell.id);
    expect(after.membershipRows).toHaveLength(1);
    expect(after.membershipRows[0]).toEqual(
      expect.objectContaining({
        professionalId: provenId,
        userId: shell.id,
        institutionId: winnerTenant.institutionId,
        active: true,
      }),
    );
    expect(
      after.membershipRows.some(
        (row) => row.institutionId === loserTenant.institutionId,
      ),
    ).toBe(false);

    expect(
      after.accessRows.every(
        (row) =>
          row.professionalId === provenId &&
          row.institutionId === winnerTenant.institutionId,
      ),
    ).toBe(true);
    expect(
      after.accessRows.some(
        (row) => row.institutionId === loserTenant.institutionId,
      ),
    ).toBe(false);
    expect(
      after.scopeRows.some(
        (row) => row.institutionId === loserTenant.institutionId,
      ),
    ).toBe(false);

    const audits = await successAudits(db, shell.id);
    expect(audits).toEqual([
      expect.objectContaining({
        action: "USER_UPDATED",
        institutionId: winnerTenant.institutionId,
      }),
    ]);
    expect(
      audits.some((row) => row.institutionId === loserTenant.institutionId),
    ).toBe(false);

    const winnerLogin = await request(app)
      .post("/api/auth/login")
      .send({ email: shell.email, password: winnerPassword });
    expect(winnerLogin.status).toBe(200);
    expect(winnerLogin.body.user.id).toBe(shell.id);
    const loserLogin = await request(app)
      .post("/api/auth/login")
      .send({ email: shell.email, password: loserPassword });
    expect(loserLogin.status).toBe(401);
  }, 45_000);

  it("I: usuário totalmente novo continua nascendo só no tenant explícito do gestor", async () => {
    const email = `rstf-novo-${STAMP}@test.local`;
    const response = await request(app)
      .post("/api/auth/register")
      .set("Cookie", gestorA.cookie)
      .set("x-tenant-id", String(tenantA.institutionId))
      .send(registerPayload("RSTF Novo", email, tenantA.contextId));
    expect(response.status).toBe(201);

    const [created] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email));
    const after = await snapshotIdentity(db, created.id);
    expect(after.professionalRows).toHaveLength(1);
    expect(after.membershipRows).toEqual([
      expect.objectContaining({
        userId: created.id,
        professionalId: after.professionalRows[0]?.id,
        institutionId: tenantA.institutionId,
        active: true,
      }),
    ]);
    expect(
      after.membershipRows.some(
        (row) => row.institutionId === tenantB.institutionId,
      ),
    ).toBe(false);
    const access = await accessAndScopeRows(
      db,
      [after.professionalRows[0]!.id],
      tenantA.institutionId,
    );
    expect(access.access).toEqual([
      expect.objectContaining({
        hospitalId: tenantA.hospitalId,
        sectorId: tenantA.sectorId,
      }),
    ]);
    expect(
      access.access.some(
        (row) =>
          row.hospitalId === tenantA.siblingHospitalId ||
          row.sectorId === tenantA.siblingSectorId,
      ),
    ).toBe(false);
  });

  it("J: /api/auth/signup anti-tomada de conta permanece intacto", async () => {
    const shell = await insertShellUser(db, "signup-bloqueio");
    const professionalId = await insertProfessionalFor(
      db,
      shell.id,
      "RSTF Signup bloqueio",
    );
    await db.insert(professionalInstitutions).values({
      professionalId,
      userId: shell.id,
      institutionId: tenantA.institutionId,
      roleInInstitution: "USER",
      isPrimary: true,
      active: true,
    });
    const before = await snapshotIdentity(db, shell.id);

    const signup = await request(app).post("/api/auth/signup").send({
      name: "Invasor público",
      email: shell.email,
      password: ATTEMPTED_PASSWORD,
      institutionId: tenantB.institutionId,
      operationalProfileCode: "MEDICO_GENERALISTA",
    });
    expect(signup.status).toBe(201);
    expect(signup.body).toMatchObject({ ok: true });

    const after = await snapshotIdentity(db, shell.id);
    expectIdentityFrozen(before, after);
    expect(after.user.passwordHash).toBeNull();

    const login = await request(app)
      .post("/api/auth/login")
      .send({ email: shell.email, password: ATTEMPTED_PASSWORD });
    expect(login.status).toBe(401);
  });
});

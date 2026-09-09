import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray, sql } from "drizzle-orm";
import bcrypt from "bcryptjs";
import express, { type Express } from "express";
import request from "supertest";
import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";
import {
  auditTrail,
  hospitals,
  institutionFeatureEntitlements,
  institutions,
  professionalAccess,
  professionalInstitutions,
  professionals,
  scheduleContexts,
  sectors,
  shiftAssignmentsV2,
  shiftInstances,
  users,
} from "../drizzle/schema";
import { adminRouter } from "../server/routes/admin";
import { authRouter } from "../server/routes/auth";
import { scheduleContextsRouter } from "../server/schedule-contexts";
import { shiftsRouter } from "../server/shifts-crud";
import { getDb } from "../server/db";
import { mondayOfKey } from "../server/local-time";
import { openTestScale } from "./helpers/open-test-scale";
import { sessionAuthCookies } from "./helpers/session-cookies";

const STAMP = Date.now();
const PASSWORD = "SenhaFeature123";
const SHIFT_DAY = "2026-09-17";
const at = (time: string) => new Date(`${SHIFT_DAY}T${time}-03:00`);

describe("entitlement institucional de leitura entre escalas", () => {
  let app: Express;
  let db: NonNullable<Awaited<ReturnType<typeof getDb>>>;
  let institutionAId: number;
  let institutionBId: number;
  let hospitalA1Id: number;
  let hospitalA2Id: number;
  let hospitalBId: number;
  let sectorA1Id: number;
  let sectorA2Id: number;
  let sectorBId: number;
  let contextA1Id: number;
  let contextA2Id: number;
  let contextBId: number;
  let adminUserId: number;
  let adminProfessionalId: number;
  let readerUserId: number;
  let readerProfessionalId: number;
  let colleagueUserId: number;
  let colleagueProfessionalId: number;
  let outsiderUserId: number;
  let outsiderProfessionalId: number;
  let shiftA1Id: number;
  let shiftA2Id: number;
  let ownShiftA2Id: number;
  let shiftBId: number;
  let adminCookie: string;
  let readerCookie: string;
  const triggerName = `feature_audit_fail_${STAMP}`;

  const ctx = (userId: number, institutionId = institutionAId) =>
    ({
      user: {
        id: userId,
        role: userId === adminUserId ? "admin" : "doctor",
        name: "Feature test",
        email: `feature-${userId}@test.local`,
        sessionVersion: 1,
      },
      institutionId,
      allowedInstitutionIds: [institutionId],
    }) as any;

  const contextsAsReader = () =>
    scheduleContextsRouter.createCaller(ctx(readerUserId));
  const shiftsAsReader = () => shiftsRouter.createCaller(ctx(readerUserId));
  const flattenAgenda = (
    result: Awaited<
      ReturnType<ReturnType<typeof shiftsAsReader>["listAgenda"]>
    >,
  ) =>
    result.weeks.flatMap((week) =>
      week.days.flatMap((day) => day.groups.flatMap((group) => group.shifts)),
    );

  async function waitForAdminUserLockWaiter(
    connection: Connection,
  ): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const [rows] = await connection.query<RowDataPacket[]>(
        "SHOW FULL PROCESSLIST",
      );
      const waiting = rows.some((row) => {
        const info = typeof row.Info === "string" ? row.Info.toLowerCase() : "";
        return (
          info.includes("from `users`") &&
          info.includes("for update") &&
          info.includes(String(adminUserId))
        );
      });
      if (waiting) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("Revalidação transacional do administrador não observada");
  }

  async function createPerson(input: {
    tag: string;
    institutionId: number;
    globalRole?: "admin" | "doctor";
  }) {
    const globalRole = input.globalRole ?? "doctor";
    const [user] = await db
      .insert(users)
      .values({
        name: `Feature ${input.tag} ${STAMP}`,
        email: `feature-${input.tag}-${STAMP}@test.local`,
        passwordHash: await bcrypt.hash(PASSWORD, 4),
        loginMethod: "email",
        role: globalRole,
        approvalStatus: "APPROVED",
      })
      .$returningId();
    const [professional] = await db
      .insert(professionals)
      .values({
        userId: user.id,
        name: `Feature ${input.tag} ${STAMP}`,
        role: "Médico",
        userRole: globalRole === "admin" ? "GESTOR_PLUS" : "USER",
      })
      .$returningId();
    await db.insert(professionalInstitutions).values({
      userId: user.id,
      professionalId: professional.id,
      institutionId: input.institutionId,
      roleInInstitution: globalRole === "admin" ? "GESTOR_PLUS" : "USER",
      isPrimary: true,
      active: true,
    });
    return { userId: user.id, professionalId: professional.id };
  }

  beforeAll(async () => {
    const connection = await getDb();
    if (!connection) throw new Error("Database not available");
    db = connection;
    app = express();
    app.use(express.json());
    app.use("/api/auth", authRouter);
    app.use("/api/admin", adminRouter);

    const makeInstitution = async (tag: string) => {
      const [institution] = await db
        .insert(institutions)
        .values({
          name: `Feature ${tag} ${STAMP}`,
          cnpj: `${STAMP}${tag === "A" ? 81 : 82}`.slice(-14).padStart(14, "0"),
          legalName: `Feature ${tag} ${STAMP}`,
          tradeName: `F${tag}${STAMP}`.slice(0, 20),
          isActive: true,
        })
        .$returningId();
      return institution.id;
    };
    institutionAId = await makeInstitution("A");
    institutionBId = await makeInstitution("B");

    const [hospitalA1] = await db
      .insert(hospitals)
      .values({ institutionId: institutionAId, name: `Hospital A1 ${STAMP}` })
      .$returningId();
    const [hospitalA2] = await db
      .insert(hospitals)
      .values({ institutionId: institutionAId, name: `Hospital A2 ${STAMP}` })
      .$returningId();
    const [hospitalB] = await db
      .insert(hospitals)
      .values({ institutionId: institutionBId, name: `Hospital B ${STAMP}` })
      .$returningId();
    hospitalA1Id = hospitalA1.id;
    hospitalA2Id = hospitalA2.id;
    hospitalBId = hospitalB.id;

    const makeSector = async (
      institutionId: number,
      hospitalId: number,
      tag: string,
    ) => {
      const [sector] = await db
        .insert(sectors)
        .values({
          institutionId,
          hospitalId,
          name: `Setor ${tag} ${STAMP}`,
          category: "servico",
          color: "#2563EB",
        })
        .$returningId();
      return sector.id;
    };
    sectorA1Id = await makeSector(institutionAId, hospitalA1Id, "A1");
    sectorA2Id = await makeSector(institutionAId, hospitalA2Id, "A2");
    sectorBId = await makeSector(institutionBId, hospitalBId, "B");
    contextA1Id = await openTestScale(db, {
      institutionId: institutionAId,
      hospitalId: hospitalA1Id,
      sectorId: sectorA1Id,
    });
    contextA2Id = await openTestScale(db, {
      institutionId: institutionAId,
      hospitalId: hospitalA2Id,
      sectorId: sectorA2Id,
    });
    contextBId = await openTestScale(db, {
      institutionId: institutionBId,
      hospitalId: hospitalBId,
      sectorId: sectorBId,
    });

    const admin = await createPerson({
      tag: "admin",
      institutionId: institutionAId,
      globalRole: "admin",
    });
    adminUserId = admin.userId;
    adminProfessionalId = admin.professionalId;
    const reader = await createPerson({
      tag: "reader",
      institutionId: institutionAId,
    });
    readerUserId = reader.userId;
    readerProfessionalId = reader.professionalId;
    const colleague = await createPerson({
      tag: "colleague",
      institutionId: institutionAId,
    });
    colleagueUserId = colleague.userId;
    colleagueProfessionalId = colleague.professionalId;
    const outsider = await createPerson({
      tag: "outsider",
      institutionId: institutionBId,
    });
    outsiderUserId = outsider.userId;
    outsiderProfessionalId = outsider.professionalId;

    await db.insert(professionalAccess).values({
      institutionId: institutionAId,
      professionalId: readerProfessionalId,
      hospitalId: hospitalA1Id,
      sectorId: sectorA1Id,
      canAccess: true,
    });

    const makeShift = async (input: {
      institutionId: number;
      hospitalId: number;
      sectorId: number;
      scheduleContextId: number;
      label: string;
      start: string;
    }) => {
      const startAt = at(input.start);
      const [shift] = await db
        .insert(shiftInstances)
        .values({
          institutionId: input.institutionId,
          hospitalId: input.hospitalId,
          sectorId: input.sectorId,
          scheduleContextId: input.scheduleContextId,
          label: input.label,
          startAt,
          endAt: new Date(startAt.getTime() + 6 * 60 * 60 * 1000),
          status: "OCUPADO",
        })
        .$returningId();
      return shift.id;
    };
    shiftA1Id = await makeShift({
      institutionId: institutionAId,
      hospitalId: hospitalA1Id,
      sectorId: sectorA1Id,
      scheduleContextId: contextA1Id,
      label: "A1",
      start: "07:00:00",
    });
    shiftA2Id = await makeShift({
      institutionId: institutionAId,
      hospitalId: hospitalA2Id,
      sectorId: sectorA2Id,
      scheduleContextId: contextA2Id,
      label: "A2 colega",
      start: "13:00:00",
    });
    ownShiftA2Id = await makeShift({
      institutionId: institutionAId,
      hospitalId: hospitalA2Id,
      sectorId: sectorA2Id,
      scheduleContextId: contextA2Id,
      label: "A2 próprio",
      start: "19:00:00",
    });
    shiftBId = await makeShift({
      institutionId: institutionBId,
      hospitalId: hospitalBId,
      sectorId: sectorBId,
      scheduleContextId: contextBId,
      label: "B",
      start: "07:00:00",
    });
    await db.insert(shiftAssignmentsV2).values([
      {
        shiftInstanceId: shiftA1Id,
        institutionId: institutionAId,
        hospitalId: hospitalA1Id,
        sectorId: sectorA1Id,
        professionalId: colleagueProfessionalId,
        status: "CONFIRMADO",
        isActive: true,
      },
      {
        shiftInstanceId: shiftA2Id,
        institutionId: institutionAId,
        hospitalId: hospitalA2Id,
        sectorId: sectorA2Id,
        professionalId: colleagueProfessionalId,
        status: "CONFIRMADO",
        isActive: true,
      },
      {
        shiftInstanceId: ownShiftA2Id,
        institutionId: institutionAId,
        hospitalId: hospitalA2Id,
        sectorId: sectorA2Id,
        professionalId: readerProfessionalId,
        status: "CONFIRMADO",
        isActive: true,
      },
      {
        shiftInstanceId: shiftBId,
        institutionId: institutionBId,
        hospitalId: hospitalBId,
        sectorId: sectorBId,
        professionalId: outsiderProfessionalId,
        status: "CONFIRMADO",
        isActive: true,
      },
    ]);

    const adminLogin = await request(app)
      .post("/api/auth/login")
      .send({ email: `feature-admin-${STAMP}@test.local`, password: PASSWORD });
    expect(adminLogin.status).toBe(200);
    adminCookie = sessionAuthCookies(adminLogin);
    const readerLogin = await request(app)
      .post("/api/auth/login")
      .send({
        email: `feature-reader-${STAMP}@test.local`,
        password: PASSWORD,
      });
    expect(readerLogin.status).toBe(200);
    readerCookie = sessionAuthCookies(readerLogin);
  });

  afterAll(async () => {
    if (!db) return;
    try {
      await db.execute(sql.raw(`DROP TRIGGER IF EXISTS \`${triggerName}\``));
    } catch {
      // O trigger pode nunca ter sido criado.
    }
    const institutionIds = [institutionAId, institutionBId];
    const userIds = [
      adminUserId,
      readerUserId,
      colleagueUserId,
      outsiderUserId,
    ];
    const professionalIds = [
      adminProfessionalId,
      readerProfessionalId,
      colleagueProfessionalId,
      outsiderProfessionalId,
    ];
    const shiftIds = [shiftA1Id, shiftA2Id, ownShiftA2Id, shiftBId];
    await db
      .delete(auditTrail)
      .where(inArray(auditTrail.institutionId, institutionIds));
    await db
      .delete(shiftAssignmentsV2)
      .where(inArray(shiftAssignmentsV2.shiftInstanceId, shiftIds));
    await db.delete(shiftInstances).where(inArray(shiftInstances.id, shiftIds));
    await db
      .delete(institutionFeatureEntitlements)
      .where(
        inArray(institutionFeatureEntitlements.institutionId, institutionIds),
      );
    await db
      .delete(professionalAccess)
      .where(inArray(professionalAccess.professionalId, professionalIds));
    await db
      .delete(professionalInstitutions)
      .where(inArray(professionalInstitutions.userId, userIds));
    await db
      .delete(professionals)
      .where(inArray(professionals.id, professionalIds));
    await db
      .delete(scheduleContexts)
      .where(
        inArray(scheduleContexts.id, [contextA1Id, contextA2Id, contextBId]),
      );
    await db
      .delete(sectors)
      .where(inArray(sectors.id, [sectorA1Id, sectorA2Id, sectorBId]));
    await db
      .delete(hospitals)
      .where(inArray(hospitals.id, [hospitalA1Id, hospitalA2Id, hospitalBId]));
    await db
      .delete(institutions)
      .where(inArray(institutions.id, institutionIds));
    await db.delete(users).where(inArray(users.id, userIds));
  });

  it("habilita o produto-base por tenant e permite override explícito sem ampliar escrita", async () => {
    const initial = await request(app)
      .get("/api/admin/institution-features/cross-schedule-roster-view")
      .set("Cookie", adminCookie)
      .set("x-tenant-id", String(institutionAId));
    expect(initial.status).toBe(200);
    expect(initial.body).toMatchObject({
      institutionId: institutionAId,
      featureCode: "CROSS_SCHEDULE_ROSTER_VIEW",
      enabled: true,
      source: null,
      version: 0,
    });
    expect(
      (
        await request(app)
          .get("/api/admin/institution-features/cross-schedule-roster-view")
          .set("Cookie", readerCookie)
          .set("x-tenant-id", String(institutionAId))
      ).status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .get("/api/admin/institution-features/cross-schedule-roster-view")
          .set("Cookie", adminCookie)
          .set("x-tenant-id", String(institutionBId))
      ).status,
    ).toBe(403);

    expect(
      await db
        .select({ id: institutionFeatureEntitlements.id })
        .from(institutionFeatureEntitlements)
        .where(
          and(
            eq(institutionFeatureEntitlements.institutionId, institutionAId),
            eq(
              institutionFeatureEntitlements.featureCode,
              "CROSS_SCHEDULE_ROSTER_VIEW",
            ),
          ),
        ),
    ).toHaveLength(0);

    expect(
      (await contextsAsReader().listReadable())
        .map((row) => row.id)
        .sort((a, b) => a - b),
    ).toEqual([contextA1Id, contextA2Id].sort((a, b) => a - b));
    const defaultGeneral = flattenAgenda(
      await shiftsAsReader().listAgenda({
        startDate: mondayOfKey(SHIFT_DAY),
        weeks: 1,
        scope: "geral",
      }),
    );
    expect(defaultGeneral.map((row) => row.id).sort((a, b) => a - b)).toEqual(
      [shiftA1Id, shiftA2Id, ownShiftA2Id].sort((a, b) => a - b),
    );
    expect(defaultGeneral.some((row) => row.id === shiftBId)).toBe(false);

    const disabled = await request(app)
      .put("/api/admin/institution-features/cross-schedule-roster-view")
      .set("Cookie", adminCookie)
      .set("x-tenant-id", String(institutionAId))
      .send({ enabled: false, expectedVersion: 0 });
    expect(disabled.status).toBe(200);
    expect(disabled.body).toMatchObject({
      enabled: false,
      source: "ADMIN_OVERRIDE",
      version: 1,
    });

    expect(
      (await contextsAsReader().listReadable()).map((row) => row.id),
    ).toEqual([contextA1Id]);
    const closedGeneral = flattenAgenda(
      await shiftsAsReader().listAgenda({
        startDate: mondayOfKey(SHIFT_DAY),
        weeks: 1,
        scope: "geral",
      }),
    );
    expect(closedGeneral.map((row) => row.id)).toEqual([shiftA1Id]);
    const ownAgenda = flattenAgenda(
      await shiftsAsReader().listAgenda({
        startDate: mondayOfKey(SHIFT_DAY),
        weeks: 1,
        scope: "minha",
      }),
    );
    expect(ownAgenda.map((row) => row.id)).toEqual([ownShiftA2Id]);
    const closedPeriod = await shiftsAsReader().listByPeriod({
      startDate: new Date(at("06:00:00").getTime()).toISOString(),
      endDate: new Date(at("23:59:59").getTime()).toISOString(),
    });
    expect(closedPeriod.map((row) => row.id).sort((a, b) => a - b)).toEqual(
      [shiftA1Id, ownShiftA2Id].sort((a, b) => a - b),
    );
    await expect(shiftsAsReader().get({ id: shiftA2Id })).rejects.toMatchObject(
      {
        code: "FORBIDDEN",
      },
    );
    await expect(
      shiftsAsReader().get({ id: ownShiftA2Id }),
    ).resolves.toMatchObject({
      id: ownShiftA2Id,
    });
    await expect(shiftsAsReader().get({ id: shiftBId })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });

    const enabled = await request(app)
      .put("/api/admin/institution-features/cross-schedule-roster-view")
      .set("Cookie", adminCookie)
      .set("x-tenant-id", String(institutionAId))
      .send({ enabled: true, expectedVersion: 1 });
    expect(enabled.status).toBe(200);
    expect(enabled.body).toMatchObject({
      institutionId: institutionAId,
      enabled: true,
      source: "ADMIN_OVERRIDE",
      version: 2,
    });

    expect(
      (await contextsAsReader().listReadable())
        .map((row) => row.id)
        .sort((a, b) => a - b),
    ).toEqual([contextA1Id, contextA2Id].sort((a, b) => a - b));
    const openGeneral = flattenAgenda(
      await shiftsAsReader().listAgenda({
        startDate: mondayOfKey(SHIFT_DAY),
        weeks: 1,
        scope: "geral",
      }),
    );
    expect(openGeneral.map((row) => row.id).sort((a, b) => a - b)).toEqual(
      [shiftA1Id, shiftA2Id, ownShiftA2Id].sort((a, b) => a - b),
    );
    expect(openGeneral.some((row) => row.id === shiftBId)).toBe(false);
    const openPeriod = await shiftsAsReader().listByPeriod({
      startDate: new Date(at("06:00:00").getTime()).toISOString(),
      endDate: new Date(at("23:59:59").getTime()).toISOString(),
    });
    expect(openPeriod.map((row) => row.id).sort((a, b) => a - b)).toEqual(
      [shiftA1Id, shiftA2Id, ownShiftA2Id].sort((a, b) => a - b),
    );
    await expect(
      shiftsAsReader().get({ id: shiftA2Id }),
    ).resolves.toMatchObject({
      id: shiftA2Id,
    });

    const disable = () =>
      request(app)
        .put("/api/admin/institution-features/cross-schedule-roster-view")
        .set("Cookie", adminCookie)
        .set("x-tenant-id", String(institutionAId))
        .send({ enabled: false, expectedVersion: 2 });
    const concurrent = await Promise.all([disable(), disable()]);
    expect(concurrent.map((response) => response.status).sort()).toEqual([
      200, 409,
    ]);
    expect(
      (await contextsAsReader().listReadable()).map((row) => row.id),
    ).toEqual([contextA1Id]);

    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) throw new Error("DATABASE_URL de teste ausente");
    const blocker = await mysql.createConnection(databaseUrl);
    let blockerCommitted = false;
    let revokedResponse: Awaited<ReturnType<typeof request>> | undefined;
    try {
      await blocker.beginTransaction();
      await blocker.execute("SELECT id FROM users WHERE id = ? FOR UPDATE", [
        adminUserId,
      ]);
      const pendingRequest = Promise.resolve(
        request(app)
          .put("/api/admin/institution-features/cross-schedule-roster-view")
          .set("Cookie", adminCookie)
          .set("x-tenant-id", String(institutionAId))
          .send({ enabled: true, expectedVersion: 3 }),
      );
      await waitForAdminUserLockWaiter(blocker);
      await blocker.execute("UPDATE users SET role = 'doctor' WHERE id = ?", [
        adminUserId,
      ]);
      await blocker.commit();
      blockerCommitted = true;
      revokedResponse = await pendingRequest;
    } finally {
      if (!blockerCommitted) await blocker.rollback();
      await blocker.end();
      await db
        .update(users)
        .set({ role: "admin" })
        .where(eq(users.id, adminUserId));
    }
    expect(revokedResponse?.status).toBe(403);
    const [afterAuthorityRevocation] = await db
      .select({
        enabled: institutionFeatureEntitlements.enabled,
        version: institutionFeatureEntitlements.version,
      })
      .from(institutionFeatureEntitlements)
      .where(
        and(
          eq(institutionFeatureEntitlements.institutionId, institutionAId),
          eq(
            institutionFeatureEntitlements.featureCode,
            "CROSS_SCHEDULE_ROSTER_VIEW",
          ),
        ),
      );
    expect(afterAuthorityRevocation).toEqual({ enabled: false, version: 3 });

    const auditRows = await db
      .select({ action: auditTrail.action, metadata: auditTrail.metadata })
      .from(auditTrail)
      .where(
        and(
          eq(auditTrail.institutionId, institutionAId),
          eq(auditTrail.action, "INSTITUTION_FEATURE_UPDATED"),
        ),
      );
    expect(auditRows).toHaveLength(3);
    expect(
      auditRows.map((row) => (row.metadata as any)?.enabled).sort(),
    ).toEqual([false, false, true]);
    expect(
      auditRows.find((row) => (row.metadata as any)?.version === 1)?.metadata,
    ).toMatchObject({
      featureCode: "CROSS_SCHEDULE_ROSTER_VIEW",
      previousEnabled: true,
      enabled: false,
      previousVersion: 0,
      version: 1,
      source: "ADMIN_OVERRIDE",
    });

    await db.execute(
      sql.raw(`
        CREATE TRIGGER \`${triggerName}\`
        BEFORE INSERT ON audit_trail
        FOR EACH ROW
        BEGIN
          IF NEW.action = 'INSTITUTION_FEATURE_UPDATED' THEN
            SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'feature audit failure';
          END IF;
        END
      `),
    );
    const failedAudit = await request(app)
      .put("/api/admin/institution-features/cross-schedule-roster-view")
      .set("Cookie", adminCookie)
      .set("x-tenant-id", String(institutionAId))
      .send({ enabled: true, expectedVersion: 3 });
    expect(failedAudit.status).toBe(500);
    const [afterRollback] = await db
      .select({
        enabled: institutionFeatureEntitlements.enabled,
        version: institutionFeatureEntitlements.version,
      })
      .from(institutionFeatureEntitlements)
      .where(
        and(
          eq(institutionFeatureEntitlements.institutionId, institutionAId),
          eq(
            institutionFeatureEntitlements.featureCode,
            "CROSS_SCHEDULE_ROSTER_VIEW",
          ),
        ),
      );
    expect(afterRollback).toEqual({ enabled: false, version: 3 });
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, gte, inArray, lt } from "drizzle-orm";
import {
  auditTrail,
  hospitals,
  institutions,
  managerScope,
  monthlyRosters,
  professionalInstitutions,
  professionals,
  scheduleContexts,
  sectors,
  shiftAssignmentsV2,
  shiftInstances,
  shiftTemplates,
  users,
} from "../drizzle/schema";
import {
  ensureTestAnesthesiaSpecialty,
  openTestScale,
} from "./helpers/open-test-scale";
import { getDb } from "../server/db";
import { appRouter } from "../server/routers";
import { scheduleContextsRouter } from "../server/schedule-contexts";
import { shiftsRouter } from "../server/shifts-crud";
import { addMonthsYearMonth, yearMonthBrt } from "../server/local-time";

/**
 * Janela operacional do GESTOR_MEDICO: mês corrente e o imediatamente
 * seguinte no relógio do hospital (America/São Paulo, −03:00).
 * Os testes não congelam o relógio — as chaves vêm de yearMonthBrt.
 */
const OFFSET = "-03:00";
const at = (date: string, time: string) => new Date(`${date}T${time}${OFFSET}`);

describe("system review — correções de raiz", () => {
  let db: NonNullable<Awaited<ReturnType<typeof getDb>>>;
  let institutionA: number;
  let institutionB: number;
  let hospitalA: number;
  let hospitalA2: number;
  let hospitalBare: number;
  let hospitalB: number;
  let sectorA: number;
  let sectorDry: number;
  let sectorA2: number;
  let sectorB: number;
  let contextA2: number;
  let contextB: number;
  let medicoAUserId: number;
  let medicoAProId: number;
  let medicoA2UserId: number;
  let medicoA2ProId: number;
  let medicoBUserId: number;
  let medicoBProId: number;
  let doctorAUserId: number;
  let doctorAProId: number;

  const currentYm = yearMonthBrt(new Date());
  const nextYm = addMonthsYearMonth(currentYm, 1);
  const plus2Ym = addMonthsYearMonth(currentYm, 2);

  const ctxFor = (
    userId: number,
    role: string,
    institutionId: number,
  ) =>
    ({
      user: {
        id: userId,
        role,
        name: "Teste",
        email: `${userId}@test.local`,
        sessionVersion: 1,
      },
      institutionId,
      allowedInstitutionIds: [institutionId],
    }) as any;

  const callerApp = (userId: number, role: string, institutionId: number) =>
    appRouter.createCaller(ctxFor(userId, role, institutionId));
  const callerShifts = (userId: number, role: string, institutionId: number) =>
    shiftsRouter.createCaller(ctxFor(userId, role, institutionId));
  const callerContexts = (userId: number, role: string, institutionId: number) =>
    scheduleContextsRouter.createCaller(ctxFor(userId, role, institutionId));

  beforeAll(async () => {
    const conn = await getDb();
    if (!conn) throw new Error("Database not available");
    db = conn;
    const stamp = Date.now();
    await ensureTestAnesthesiaSpecialty(db);

    const [instA] = await db
      .insert(institutions)
      .values({
        name: `Review A ${stamp}`,
        cnpj: `${stamp}`.slice(-14).padStart(14, "0"),
        legalName: `Review A ${stamp}`,
        tradeName: `RA${stamp}`.slice(0, 20),
        isActive: true,
      })
      .$returningId();
    institutionA = instA.id;
    const [instB] = await db
      .insert(institutions)
      .values({
        name: `Review B ${stamp}`,
        cnpj: `${stamp + 1}`.slice(-14).padStart(14, "0"),
        legalName: `Review B ${stamp}`,
        tradeName: `RB${stamp}`.slice(0, 20),
        isActive: true,
      })
      .$returningId();
    institutionB = instB.id;

    const [hA] = await db
      .insert(hospitals)
      .values({ institutionId: institutionA, name: `Hospital A ${stamp}` })
      .$returningId();
    hospitalA = hA.id;
    const [hA2] = await db
      .insert(hospitals)
      .values({ institutionId: institutionA, name: `Hospital A2 ${stamp}` })
      .$returningId();
    hospitalA2 = hA2.id;
    const [hBare] = await db
      .insert(hospitals)
      .values({
        institutionId: institutionA,
        name: `Hospital sem escala ${stamp}`,
      })
      .$returningId();
    hospitalBare = hBare.id;
    const [hB] = await db
      .insert(hospitals)
      .values({ institutionId: institutionB, name: `Hospital B ${stamp}` })
      .$returningId();
    hospitalB = hB.id;

    const [sA] = await db
      .insert(sectors)
      .values({
        institutionId: institutionA,
        hospitalId: hospitalA,
        name: `Setor A ${stamp}`,
        category: "servico",
        color: "#2563EB",
      })
      .$returningId();
    sectorA = sA.id;
    const [sDry] = await db
      .insert(sectors)
      .values({
        institutionId: institutionA,
        hospitalId: hospitalA,
        name: `Setor dry-run ${stamp}`,
        category: "servico",
        color: "#7C3AED",
      })
      .$returningId();
    sectorDry = sDry.id;
    const [sA2] = await db
      .insert(sectors)
      .values({
        institutionId: institutionA,
        hospitalId: hospitalA2,
        name: `Setor A2 ${stamp}`,
        category: "servico",
        color: "#16A34A",
      })
      .$returningId();
    sectorA2 = sA2.id;
    const [sB] = await db
      .insert(sectors)
      .values({
        institutionId: institutionB,
        hospitalId: hospitalB,
        name: `Setor B ${stamp}`,
        category: "servico",
        color: "#DC2626",
      })
      .$returningId();
    sectorB = sB.id;

    contextA2 = await openTestScale(db, {
      institutionId: institutionA,
      hospitalId: hospitalA2,
      sectorId: sectorA2,
    });
    contextB = await openTestScale(db, {
      institutionId: institutionB,
      hospitalId: hospitalB,
      sectorId: sectorB,
    });

    async function person(
      tag: string,
      institutionId: number,
      roleInInstitution: "GESTOR_MEDICO" | "USER",
    ) {
      const [u] = await db
        .insert(users)
        .values({
          name: `Review ${tag} ${stamp}`,
          email: `review-${tag}-${stamp}@test.local`,
          passwordHash: "test",
          role: roleInInstitution === "USER" ? "doctor" : "manager",
        })
        .$returningId();
      const [p] = await db
        .insert(professionals)
        .values({
          userId: u.id,
          name: `Review ${tag} ${stamp}`,
          role: "Médico",
          userRole: roleInInstitution,
        })
        .$returningId();
      await db.insert(professionalInstitutions).values({
        professionalId: p.id,
        userId: u.id,
        institutionId,
        roleInInstitution,
        isPrimary: true,
        active: true,
      });
      return { userId: u.id, proId: p.id };
    }

    const medicoA = await person("medico-a", institutionA, "GESTOR_MEDICO");
    medicoAUserId = medicoA.userId;
    medicoAProId = medicoA.proId;
    const medicoA2 = await person("medico-a2", institutionA, "GESTOR_MEDICO");
    medicoA2UserId = medicoA2.userId;
    medicoA2ProId = medicoA2.proId;
    const medicoB = await person("medico-b", institutionB, "GESTOR_MEDICO");
    medicoBUserId = medicoB.userId;
    medicoBProId = medicoB.proId;
    const doctorA = await person("doctor-a", institutionA, "USER");
    doctorAUserId = doctorA.userId;
    doctorAProId = doctorA.proId;

    await db.insert(managerScope).values([
      {
        institutionId: institutionA,
        managerProfessionalId: medicoAProId,
        hospitalId: hospitalA,
        sectorId: sectorA,
        active: true,
      },
      {
        institutionId: institutionA,
        managerProfessionalId: medicoAProId,
        hospitalId: hospitalA,
        sectorId: sectorDry,
        active: true,
      },
      {
        institutionId: institutionA,
        managerProfessionalId: medicoAProId,
        hospitalId: hospitalBare,
        sectorId: null,
        active: true,
      },
      {
        institutionId: institutionA,
        managerProfessionalId: medicoA2ProId,
        hospitalId: hospitalA2,
        sectorId: sectorA2,
        active: true,
      },
      {
        institutionId: institutionB,
        managerProfessionalId: medicoBProId,
        hospitalId: hospitalB,
        sectorId: sectorB,
        active: true,
      },
    ]);
  });

  afterAll(async () => {
    if (!db) return;
    const tenantIds = [institutionA, institutionB];
    const allShifts = await db
      .select({ id: shiftInstances.id })
      .from(shiftInstances)
      .where(inArray(shiftInstances.institutionId, tenantIds));
    const ids = allShifts.map((row) => row.id);
    if (ids.length) {
      await db
        .delete(shiftAssignmentsV2)
        .where(inArray(shiftAssignmentsV2.shiftInstanceId, ids));
      await db.delete(shiftInstances).where(inArray(shiftInstances.id, ids));
    }
    await db
      .delete(shiftTemplates)
      .where(inArray(shiftTemplates.institutionId, tenantIds));
    await db.delete(auditTrail).where(eq(auditTrail.institutionId, institutionA));
    await db.delete(auditTrail).where(eq(auditTrail.institutionId, institutionB));
    await db
      .delete(monthlyRosters)
      .where(inArray(monthlyRosters.institutionId, tenantIds));
    await db
      .delete(scheduleContexts)
      .where(inArray(scheduleContexts.institutionId, tenantIds));
    await db
      .delete(managerScope)
      .where(inArray(managerScope.institutionId, tenantIds));
    await db
      .delete(professionalInstitutions)
      .where(inArray(professionalInstitutions.institutionId, tenantIds));
    await db
      .delete(professionals)
      .where(
        inArray(professionals.id, [
          medicoAProId,
          medicoA2ProId,
          medicoBProId,
          doctorAProId,
        ]),
      );
    await db.delete(sectors).where(inArray(sectors.institutionId, tenantIds));
    await db.delete(hospitals).where(inArray(hospitals.institutionId, tenantIds));
    await db.delete(institutions).where(inArray(institutions.id, tenantIds));
    await db
      .delete(users)
      .where(
        inArray(users.id, [
          medicoAUserId,
          medicoA2UserId,
          medicoBUserId,
          doctorAUserId,
        ]),
      );
  });

  async function countTemplates(sectorId: number) {
    return db
      .select({ id: shiftTemplates.id })
      .from(shiftTemplates)
      .where(
        and(
          eq(shiftTemplates.institutionId, institutionA),
          eq(shiftTemplates.sectorId, sectorId),
        ),
      );
  }

  async function countShifts(
    institutionId: number,
    sectorId: number,
    yearMonth: string,
  ) {
    const start = at(`${yearMonth}-01`, "00:00:00");
    const end = at(`${addMonthsYearMonth(yearMonth, 1)}-01`, "00:00:00");
    return db
      .select({ id: shiftInstances.id })
      .from(shiftInstances)
      .where(
        and(
          eq(shiftInstances.institutionId, institutionId),
          eq(shiftInstances.sectorId, sectorId),
          gte(shiftInstances.startAt, start),
          lt(shiftInstances.startAt, end),
        ),
      );
  }

  it("1: GESTOR_MEDICO abre o próximo mês e não abre mês+2 (−03:00)", async () => {
    const ensured = await callerContexts(
      medicoAUserId,
      "manager",
      institutionA,
    ).ensureDefaultSectorScale({
      hospitalId: hospitalA,
      sectorId: sectorA,
    });

    const opened = await callerShifts(
      medicoAUserId,
      "manager",
      institutionA,
    ).openMonthShifts({
      hospitalId: hospitalA,
      sectorId: sectorA,
      scheduleContextId: ensured.scheduleContextId,
      yearMonth: nextYm,
      mode: "custom",
      templateNames: ["Manhã"],
    });
    expect(opened.created).toBeGreaterThan(0);
    expect(opened.dryRun).toBe(false);

    await expect(
      callerShifts(medicoAUserId, "manager", institutionA).openMonthShifts({
        hospitalId: hospitalA,
        sectorId: sectorA,
        scheduleContextId: ensured.scheduleContextId,
        yearMonth: plus2Ym,
        mode: "custom",
        templateNames: ["Manhã"],
      }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: expect.stringMatching(/mês corrente ou do próximo/),
    });
    expect(await countShifts(institutionA, sectorA, plus2Ym)).toHaveLength(0);
  });

  it("1b: gestor A não abre o mês da instituição B", async () => {
    await expect(
      callerShifts(medicoAUserId, "manager", institutionA).openMonthShifts({
        hospitalId: hospitalB,
        sectorId: sectorB,
        scheduleContextId: contextB,
        yearMonth: nextYm,
        mode: "custom",
        templateNames: ["Manhã"],
      }),
    ).rejects.toMatchObject({
      code: expect.stringMatching(/FORBIDDEN|NOT_FOUND|BAD_REQUEST/),
    });
  });

  it("2: dryRun não persiste templates nem plantões; apply depois funciona", async () => {
    const dryContextId = await openTestScale(db, {
      institutionId: institutionA,
      hospitalId: hospitalA,
      sectorId: sectorDry,
    });
    expect(await countTemplates(sectorDry)).toHaveLength(0);

    const preview = await callerShifts(
      medicoAUserId,
      "manager",
      institutionA,
    ).openMonthShifts({
      hospitalId: hospitalA,
      sectorId: sectorDry,
      scheduleContextId: dryContextId,
      yearMonth: nextYm,
      mode: "custom",
      templateNames: ["Manhã"],
      dryRun: true,
    });
    expect(preview.dryRun).toBe(true);
    expect(preview.planned).toBeGreaterThan(0);
    expect(preview.created).toBe(preview.planned);
    expect(await countTemplates(sectorDry)).toHaveLength(0);
    expect(await countShifts(institutionA, sectorDry, nextYm)).toHaveLength(0);

    const applied = await callerShifts(
      medicoAUserId,
      "manager",
      institutionA,
    ).openMonthShifts({
      hospitalId: hospitalA,
      sectorId: sectorDry,
      scheduleContextId: dryContextId,
      yearMonth: nextYm,
      mode: "custom",
      templateNames: ["Manhã"],
    });
    expect(applied.dryRun).toBe(false);
    expect(applied.created).toBe(preview.planned);
    expect((await countTemplates(sectorDry)).length).toBeGreaterThanOrEqual(3);
    expect(await countShifts(institutionA, sectorDry, nextYm)).toHaveLength(
      applied.created,
    );
  });

  it("3: Vagas/Pendentes listam o hospital gerível sem schedule_context", async () => {
    const topology = await callerContexts(
      medicoAUserId,
      "manager",
      institutionA,
    ).listManageableTopology();
    expect(topology.institutionHasHospitals).toBe(true);
    expect(topology.hospitals.map((row) => row.id)).toEqual(
      expect.arrayContaining([hospitalA, hospitalBare]),
    );
    expect(topology.hospitals.map((row) => row.id)).not.toContain(hospitalA2);
    expect(topology.hospitals.map((row) => row.id)).not.toContain(hospitalB);

    const listed = await callerApp(
      medicoAUserId,
      "manager",
      institutionA,
    ).hospitals.list();
    expect(listed.map((row) => row.id)).toEqual(
      expect.arrayContaining([hospitalA, hospitalBare]),
    );
    expect(listed.every((row) => row.institutionId === institutionA)).toBe(true);

    const plantonista = await callerApp(
      doctorAUserId,
      "doctor",
      institutionA,
    ).hospitals.list();
    expect(plantonista.map((row) => row.id)).not.toContain(hospitalBare);
    expect(plantonista.map((row) => row.id)).not.toContain(hospitalB);
  });

  it("4: topologia vazia para gestor sem escopo distingue falta de jurisdição", async () => {
    const topology = await callerContexts(
      medicoAUserId,
      "manager",
      institutionA,
    ).listManageableTopology();
    expect(topology.institutionHasHospitals).toBe(true);
    expect(topology.hospitals.length).toBeGreaterThan(0);

    const otherHospitalOnly = await callerContexts(
      medicoA2UserId,
      "manager",
      institutionA,
    ).listManageableTopology();
    expect(otherHospitalOnly.institutionHasHospitals).toBe(true);
    expect(otherHospitalOnly.hospitals.map((row) => row.id)).toEqual([
      hospitalA2,
    ]);
  });

  it("5: gestor de setor publica o mês do próprio hospital e não o de outro", async () => {
    const published = await callerShifts(
      medicoAUserId,
      "manager",
      institutionA,
    ).publish({
      institutionId: institutionA,
      hospitalId: hospitalA,
      yearMonth: nextYm,
    });
    expect(published).toEqual({ ok: true });
    const [roster] = await db
      .select({ status: monthlyRosters.status })
      .from(monthlyRosters)
      .where(
        and(
          eq(monthlyRosters.institutionId, institutionA),
          eq(monthlyRosters.hospitalId, hospitalA),
          eq(monthlyRosters.yearMonth, nextYm),
        ),
      );
    expect(roster?.status).toBe("PUBLISHED");

    await expect(
      callerShifts(medicoAUserId, "manager", institutionA).publish({
        institutionId: institutionA,
        hospitalId: hospitalA2,
        yearMonth: nextYm,
      }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: expect.stringMatching(/jurisdição/),
    });

    await expect(
      callerShifts(medicoAUserId, "manager", institutionA).publish({
        institutionId: institutionB,
        hospitalId: hospitalB,
        yearMonth: nextYm,
      }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
    });

    const [foreign] = await db
      .select({ id: monthlyRosters.id })
      .from(monthlyRosters)
      .where(
        and(
          eq(monthlyRosters.institutionId, institutionB),
          eq(monthlyRosters.hospitalId, hospitalB),
          eq(monthlyRosters.yearMonth, nextYm),
        ),
      );
    expect(foreign).toBeUndefined();
  });

  it("6: assumeVacancy em plantão ocupado devolve CONFLICT em português", async () => {
    const [shift] = await db
      .insert(shiftInstances)
      .values({
        institutionId: institutionA,
        hospitalId: hospitalA2,
        sectorId: sectorA2,
        scheduleContextId: contextA2,
        label: "Manhã",
        specialty: "Anestesiologia",
        startAt: at(`${currentYm}-15`, "07:00:00"),
        endAt: at(`${currentYm}-15`, "13:00:00"),
        status: "OCUPADO",
        createdBy: medicoA2UserId,
      })
      .$returningId();

    await expect(
      callerApp(doctorAUserId, "doctor", institutionA).shiftAssignments.assumeVacancy({
        shiftInstanceId: shift.id,
        assignmentType: "ON_DUTY",
      }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: "Este plantão não está vago.",
    });
  });

  it("7: gestor de setor consulta hasMonthShifts do hospital que opera", async () => {
    const probe = await callerApp(
      medicoAUserId,
      "manager",
      institutionA,
    ).filters.hasMonthShifts({
      hospitalId: hospitalA,
      yearMonth: nextYm,
    });
    expect(probe.hasShifts).toBe(true);

    await expect(
      callerApp(medicoAUserId, "manager", institutionA).filters.hasMonthShifts({
        hospitalId: hospitalA2,
        yearMonth: nextYm,
      }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });
});

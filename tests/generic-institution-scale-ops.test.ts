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
import { getDb } from "../server/db";
import { shiftsRouter } from "../server/shifts-crud";
import { scheduleContextsRouter } from "../server/schedule-contexts";
import { planOpenMonthShifts } from "../lib/open-month-shifts";
import { yearMonthBrt } from "../server/local-time";

const OFFSET = "-03:00";
const at = (date: string, time: string) => new Date(`${date}T${time}${OFFSET}`);

describe("escala operacional genérica por instituição", () => {
  let db: Awaited<ReturnType<typeof getDb>>;
  let institutionA: number;
  let institutionB: number;
  let hospitalA: number;
  let hospitalB: number;
  let sectorA: number;
  let sectorB: number;
  let sectorBOther: number;
  let contextA: number;
  let gestorAUserId: number;
  let gestorAProfessionalId: number;
  let gestorBUserId: number;
  let gestorBProfessionalId: number;
  let scopedUserId: number;
  let scopedProfessionalId: number;

  const callerShifts = (
    userId: number,
    role: string,
    institutionId: number,
    allowed: number[] = [institutionId],
  ) =>
    shiftsRouter.createCaller({
      user: {
        id: userId,
        role,
        name: "Teste",
        email: "teste@test.local",
        sessionVersion: 1,
      },
      institutionId,
      allowedInstitutionIds: allowed,
    } as any);

  const callerContexts = (
    userId: number,
    role: string,
    institutionId: number,
  ) =>
    scheduleContextsRouter.createCaller({
      user: {
        id: userId,
        role,
        name: "Teste",
        email: "teste@test.local",
        sessionVersion: 1,
      },
      institutionId,
      allowedInstitutionIds: [institutionId],
    } as any);

  beforeAll(async () => {
    db = await getDb();
    if (!db) throw new Error("Database not available");
    const stamp = Date.now();

    const [instA] = await db
      .insert(institutions)
      .values({
        name: `Tenant A Escala ${stamp}`,
        cnpj: `${stamp}`.slice(-14).padStart(14, "0"),
        legalName: `Tenant A Escala ${stamp}`,
        tradeName: `TA${stamp}`.slice(0, 20),
        isActive: true,
      })
      .$returningId();
    institutionA = instA.id;
    const [instB] = await db
      .insert(institutions)
      .values({
        name: `Tenant B Escala ${stamp}`,
        cnpj: `${stamp + 1}`.slice(-14).padStart(14, "0"),
        legalName: `Tenant B Escala ${stamp}`,
        tradeName: `TB${stamp}`.slice(0, 20),
        isActive: true,
      })
      .$returningId();
    institutionB = instB.id;

    const [hospA] = await db
      .insert(hospitals)
      .values({ institutionId: institutionA, name: `Hospital A ${stamp}` })
      .$returningId();
    hospitalA = hospA.id;
    const [hospB] = await db
      .insert(hospitals)
      .values({ institutionId: institutionB, name: `Hospital B ${stamp}` })
      .$returningId();
    hospitalB = hospB.id;

    const [secA] = await db
      .insert(sectors)
      .values({
        institutionId: institutionA,
        hospitalId: hospitalA,
        name: `Setor A ${stamp}`,
        category: "servico",
        color: "#2563EB",
      })
      .$returningId();
    sectorA = secA.id;
    const [secB] = await db
      .insert(sectors)
      .values({
        institutionId: institutionB,
        hospitalId: hospitalB,
        name: `Setor B ${stamp}`,
        category: "servico",
        color: "#16A34A",
      })
      .$returningId();
    sectorB = secB.id;
    const [secBOther] = await db
      .insert(sectors)
      .values({
        institutionId: institutionB,
        hospitalId: hospitalB,
        name: `Setor B Outro ${stamp}`,
        category: "servico",
        color: "#7C3AED",
      })
      .$returningId();
    sectorBOther = secBOther.id;

    const [ctxA] = await db
      .insert(scheduleContexts)
      .values({
        institutionId: institutionA,
        hospitalId: hospitalA,
        sectorId: sectorA,
        admissionPolicy: "ALL_CFM_SPECIALTIES",
        medicalSpecialtyId: null,
        operationalProfileCode: null,
        active: true,
      })
      .$returningId();
    contextA = ctxA.id;

    await db.insert(shiftTemplates).values([
      {
        institutionId: institutionA,
        hospitalId: hospitalA,
        sectorId: sectorA,
        name: "Manhã",
        startTime: "07:00:00",
        endTime: "13:00:00",
        isActive: true,
        priority: 10,
      },
      {
        institutionId: institutionA,
        hospitalId: hospitalA,
        sectorId: sectorA,
        name: "Tarde",
        startTime: "13:00:00",
        endTime: "19:00:00",
        isActive: true,
        priority: 20,
      },
      {
        institutionId: institutionA,
        hospitalId: hospitalA,
        sectorId: sectorA,
        name: "Noite",
        startTime: "19:00:00",
        endTime: "07:00:00",
        isActive: true,
        priority: 30,
      },
    ]);

    const [userA] = await db
      .insert(users)
      .values({
        name: `Gestor A ${stamp}`,
        email: `gestor-a-escala-${stamp}@test.local`,
        passwordHash: "test",
        role: "manager",
      })
      .$returningId();
    gestorAUserId = userA.id;
    const [proA] = await db
      .insert(professionals)
      .values({
        userId: gestorAUserId,
        name: `Gestor A ${stamp}`,
        role: "Gestor",
        userRole: "GESTOR_PLUS",
      })
      .$returningId();
    gestorAProfessionalId = proA.id;

    const [userB] = await db
      .insert(users)
      .values({
        name: `Gestor B ${stamp}`,
        email: `gestor-b-escala-${stamp}@test.local`,
        passwordHash: "test",
        role: "manager",
      })
      .$returningId();
    gestorBUserId = userB.id;
    const [proB] = await db
      .insert(professionals)
      .values({
        userId: gestorBUserId,
        name: `Gestor B ${stamp}`,
        role: "Gestor",
        userRole: "GESTOR_PLUS",
      })
      .$returningId();
    gestorBProfessionalId = proB.id;

    const [userScoped] = await db
      .insert(users)
      .values({
        name: `Gestor Escopo ${stamp}`,
        email: `gestor-escopo-escala-${stamp}@test.local`,
        passwordHash: "test",
        role: "manager",
      })
      .$returningId();
    scopedUserId = userScoped.id;
    const [proScoped] = await db
      .insert(professionals)
      .values({
        userId: scopedUserId,
        name: `Gestor Escopo ${stamp}`,
        role: "Gestor",
        userRole: "GESTOR_MEDICO",
      })
      .$returningId();
    scopedProfessionalId = proScoped.id;

    await db.insert(professionalInstitutions).values([
      {
        professionalId: gestorAProfessionalId,
        userId: gestorAUserId,
        institutionId: institutionA,
        roleInInstitution: "GESTOR_PLUS",
        isPrimary: true,
        active: true,
      },
      {
        professionalId: gestorBProfessionalId,
        userId: gestorBUserId,
        institutionId: institutionB,
        roleInInstitution: "GESTOR_PLUS",
        isPrimary: true,
        active: true,
      },
      {
        professionalId: scopedProfessionalId,
        userId: scopedUserId,
        institutionId: institutionB,
        roleInInstitution: "GESTOR_MEDICO",
        isPrimary: true,
        active: true,
      },
    ]);
    await db.insert(managerScope).values({
      institutionId: institutionB,
      managerProfessionalId: scopedProfessionalId,
      hospitalId: hospitalB,
      sectorId: sectorB,
      active: true,
    });
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
    await db.delete(managerScope).where(inArray(managerScope.institutionId, tenantIds));
    await db
      .delete(professionalInstitutions)
      .where(inArray(professionalInstitutions.institutionId, tenantIds));
    await db
      .delete(professionals)
      .where(
        inArray(professionals.id, [
          gestorAProfessionalId,
          gestorBProfessionalId,
          scopedProfessionalId,
        ]),
      );
    await db.delete(sectors).where(inArray(sectors.institutionId, tenantIds));
    await db.delete(hospitals).where(inArray(hospitals.institutionId, tenantIds));
    await db
      .delete(institutions)
      .where(inArray(institutions.id, tenantIds));
    await db
      .delete(users)
      .where(inArray(users.id, [gestorAUserId, gestorBUserId, scopedUserId]));
  });

  async function countMonth(
    institutionId: number,
    sectorId: number,
    yearMonth: string,
  ) {
    const [year, month] = yearMonth.split("-").map(Number);
    const next =
      month === 12
        ? `${year + 1}-01`
        : `${year}-${String(month + 1).padStart(2, "0")}`;
    return db!
      .select({
        id: shiftInstances.id,
        label: shiftInstances.label,
        status: shiftInstances.status,
        startAt: shiftInstances.startAt,
      })
      .from(shiftInstances)
      .where(
        and(
          eq(shiftInstances.institutionId, institutionId),
          eq(shiftInstances.sectorId, sectorId),
          gte(shiftInstances.startAt, at(`${yearMonth}-01`, "00:00:00")),
          lt(shiftInstances.startAt, at(`${next}-01`, "00:00:00")),
        ),
      );
  }

  it("instituição B abre o mês pelo mesmo caminho, sem blueprint de São Carlos", async () => {
    const topology = await callerContexts(
      gestorBUserId,
      "manager",
      institutionB,
    ).listManageableTopology();
    expect(topology).toHaveLength(1);
    expect(topology[0].id).toBe(hospitalB);
    expect(topology[0].sectors[0]?.hasSchedule).toBe(false);

    const ensured = await callerContexts(
      gestorBUserId,
      "manager",
      institutionB,
    ).ensureDefaultSectorScale({
      hospitalId: hospitalB,
      sectorId: sectorB,
    });
    expect(ensured.createdContext).toBe(true);
    expect(ensured.createdTemplates).toBe(3);
    expect(ensured.scheduleContextId).toBeGreaterThan(0);
    const mine = await callerContexts(
      gestorBUserId,
      "manager",
      institutionB,
    ).listMine();
    expect(mine.some((row) => row.id === ensured.scheduleContextId)).toBe(true);
    expect(mine[0]?.canManage).toBe(true);

    const expected = planOpenMonthShifts({
      yearMonth: "2026-09",
      mode: "all-applicable",
    }).length;
    const opened = await callerShifts(
      gestorBUserId,
      "manager",
      institutionB,
    ).openMonthShifts({
      hospitalId: hospitalB,
      sectorId: sectorB,
      scheduleContextId: ensured.scheduleContextId,
      yearMonth: "2026-09",
      mode: "all-applicable",
    });
    expect(opened.created).toBe(expected);
    expect(opened.skipped).toBe(0);
    const rows = await countMonth(institutionB, sectorB, "2026-09");
    expect(rows).toHaveLength(expected);
    expect(rows.every((row) => row.status === "VAGO")).toBe(true);
    expect(
      rows.some(
        (row) =>
          row.label === "Manhã" &&
          row.startAt.getTime() === at("2026-09-07", "07:00:00").getTime(),
      ),
    ).toBe(true);
  });

  it("instituição sem templates cria o blueprint padrão ao abrir os turnos", async () => {
    const extra = await callerContexts(
      gestorBUserId,
      "manager",
      institutionB,
    ).ensureDefaultSectorScale({
      hospitalId: hospitalB,
      sectorName: "Imagem diagnóstica",
    });
    expect(extra.createdSector).toBe(true);
    await db!
      .delete(shiftTemplates)
      .where(
        and(
          eq(shiftTemplates.institutionId, institutionB),
          eq(shiftTemplates.sectorId, extra.sectorId),
        ),
      );

    const opened = await callerShifts(
      gestorBUserId,
      "manager",
      institutionB,
    ).openMonthShifts({
      hospitalId: hospitalB,
      sectorId: extra.sectorId,
      scheduleContextId: extra.scheduleContextId,
      yearMonth: "2026-10",
      mode: "nights-only",
    });
    expect(opened.created).toBeGreaterThan(0);
    const templates = await db!
      .select({ name: shiftTemplates.name })
      .from(shiftTemplates)
      .where(
        and(
          eq(shiftTemplates.institutionId, institutionB),
          eq(shiftTemplates.sectorId, extra.sectorId),
        ),
      );
    expect(templates.map((row) => row.name).sort()).toEqual([
      "Manhã",
      "Noite",
      "Tarde",
    ]);
  });

  it("hospital com templates gerais ainda abre o mês completo do setor", async () => {
    await db!.insert(shiftTemplates).values([
      {
        institutionId: institutionA,
        hospitalId: hospitalA,
        sectorId: null,
        name: "Manhã",
        startTime: "07:00:00",
        endTime: "13:00:00",
        isActive: true,
        priority: 10,
      },
      {
        institutionId: institutionA,
        hospitalId: hospitalA,
        sectorId: null,
        name: "Tarde",
        startTime: "13:00:00",
        endTime: "19:00:00",
        isActive: true,
        priority: 20,
      },
      {
        institutionId: institutionA,
        hospitalId: hospitalA,
        sectorId: null,
        name: "Noite",
        startTime: "19:00:00",
        endTime: "07:00:00",
        isActive: true,
        priority: 30,
      },
      {
        institutionId: institutionB,
        hospitalId: hospitalB,
        sectorId: null,
        name: "Manhã",
        startTime: "08:00:00",
        endTime: "14:00:00",
        isActive: true,
        priority: 15,
      },
    ]);

    const ensuredA = await callerContexts(
      gestorAUserId,
      "manager",
      institutionA,
    ).ensureDefaultSectorScale({
      hospitalId: hospitalA,
      sectorName: "Centro Cirúrgico piloto",
    });
    const ensuredB = await callerContexts(
      gestorBUserId,
      "manager",
      institutionB,
    ).ensureDefaultSectorScale({
      hospitalId: hospitalB,
      sectorName: "Setor parcial hospital",
    });
    expect(ensuredA.createdSector).toBe(true);
    expect(ensuredB.createdSector).toBe(true);
    expect(ensuredA.createdTemplates).toBe(3);
    expect(ensuredB.createdTemplates).toBe(3);

    const templatesA = await db!
      .select({
        name: shiftTemplates.name,
        sectorId: shiftTemplates.sectorId,
        startTime: shiftTemplates.startTime,
      })
      .from(shiftTemplates)
      .where(
        and(
          eq(shiftTemplates.institutionId, institutionA),
          eq(shiftTemplates.sectorId, ensuredA.sectorId),
        ),
      );
    const templatesB = await db!
      .select({
        name: shiftTemplates.name,
        sectorId: shiftTemplates.sectorId,
        startTime: shiftTemplates.startTime,
      })
      .from(shiftTemplates)
      .where(
        and(
          eq(shiftTemplates.institutionId, institutionB),
          eq(shiftTemplates.sectorId, ensuredB.sectorId),
        ),
      );
    expect(templatesA.map((row) => row.name).sort()).toEqual([
      "Manhã",
      "Noite",
      "Tarde",
    ]);
    expect(templatesB.map((row) => row.name).sort()).toEqual([
      "Manhã",
      "Noite",
      "Tarde",
    ]);
    expect(
      String(
        templatesB.find((row) => row.name === "Manhã")?.startTime ?? "",
      ).startsWith("08:00"),
    ).toBe(true);
    expect(
      String(
        templatesB.find((row) => row.name === "Tarde")?.startTime ?? "",
      ).startsWith("13:00"),
    ).toBe(true);

    const yearMonth = "2027-03";
    const expected = planOpenMonthShifts({
      yearMonth,
      mode: "all-applicable",
    }).length;
    const openedA = await callerShifts(
      gestorAUserId,
      "manager",
      institutionA,
    ).openMonthShifts({
      hospitalId: hospitalA,
      sectorId: ensuredA.sectorId,
      scheduleContextId: ensuredA.scheduleContextId,
      yearMonth,
      mode: "all-applicable",
    });
    const openedB = await callerShifts(
      gestorBUserId,
      "manager",
      institutionB,
    ).openMonthShifts({
      hospitalId: hospitalB,
      sectorId: ensuredB.sectorId,
      scheduleContextId: ensuredB.scheduleContextId,
      yearMonth,
      mode: "all-applicable",
    });
    expect(openedA.created).toBe(expected);
    expect(openedB.created).toBe(expected);
    const rowsA = await countMonth(institutionA, ensuredA.sectorId, yearMonth);
    const rowsB = await countMonth(institutionB, ensuredB.sectorId, yearMonth);
    expect(rowsA).toHaveLength(expected);
    expect(rowsB).toHaveLength(expected);
    expect(rowsA.every((row) => row.status === "VAGO")).toBe(true);
    expect(rowsB.every((row) => row.status === "VAGO")).toBe(true);
    expect(
      rowsA.some(
        (row) =>
          row.label === "Manhã" &&
          row.startAt.getTime() === at("2027-03-01", "07:00:00").getTime(),
      ),
    ).toBe(true);
    expect(
      rowsB.some(
        (row) =>
          row.label === "Manhã" &&
          row.startAt.getTime() === at("2027-03-01", "08:00:00").getTime(),
      ),
    ).toBe(true);
    expect(await countMonth(institutionA, ensuredB.sectorId, yearMonth)).toHaveLength(
      0,
    );
    expect(await countMonth(institutionB, ensuredA.sectorId, yearMonth)).toHaveLength(
      0,
    );
  });

  it("gestor A não abre o mês da instituição B", async () => {
    const [contextB] = await db!
      .select({ id: scheduleContexts.id })
      .from(scheduleContexts)
      .where(
        and(
          eq(scheduleContexts.institutionId, institutionB),
          eq(scheduleContexts.sectorId, sectorB),
        ),
      );
    await expect(
      callerShifts(gestorAUserId, "manager", institutionA).openMonthShifts({
        hospitalId: hospitalB,
        sectorId: sectorB,
        scheduleContextId: contextB.id,
        yearMonth: "2026-11",
        mode: "all-applicable",
      }),
    ).rejects.toMatchObject({
      code: expect.stringMatching(/FORBIDDEN|NOT_FOUND|BAD_REQUEST/),
    });
    expect(await countMonth(institutionB, sectorB, "2026-11")).toHaveLength(0);

    await expect(
      callerContexts(gestorAUserId, "manager", institutionA).ensureDefaultSectorScale({
        hospitalId: hospitalB,
        sectorId: sectorB,
      }),
    ).rejects.toMatchObject({
      code: expect.stringMatching(/FORBIDDEN|NOT_FOUND|BAD_REQUEST/),
    });
  });

  it("gestor com escopo de setor não cria setor novo nem opera outro setor", async () => {
    const topology = await callerContexts(
      scopedUserId,
      "manager",
      institutionB,
    ).listManageableTopology();
    expect(topology).toHaveLength(1);
    expect(topology[0].id).toBe(hospitalB);
    expect(topology[0].canCreateSector).toBe(false);
    expect(topology[0].sectors.map((sector) => sector.id)).toEqual([sectorB]);

    await expect(
      callerContexts(scopedUserId, "manager", institutionB).ensureDefaultSectorScale({
        hospitalId: hospitalB,
        sectorName: "Setor fora do escopo",
      }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: expect.stringMatching(/jurisdição hospitalar/),
    });

    await expect(
      callerContexts(scopedUserId, "manager", institutionB).ensureDefaultSectorScale({
        hospitalId: hospitalB,
        sectorId: sectorBOther,
      }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: expect.stringMatching(/jurisdição/),
    });

    const ensured = await callerContexts(
      scopedUserId,
      "manager",
      institutionB,
    ).ensureDefaultSectorScale({
      hospitalId: hospitalB,
      sectorId: sectorB,
    });
    expect(ensured.sectorId).toBe(sectorB);
    expect(ensured.createdSector).toBe(false);
  });

  it("gestor com manager_scope abre o mês sem professional_access", async () => {
    const [contextB] = await db!
      .select({ id: scheduleContexts.id })
      .from(scheduleContexts)
      .where(
        and(
          eq(scheduleContexts.institutionId, institutionB),
          eq(scheduleContexts.sectorId, sectorB),
        ),
      );
    const yearMonth = yearMonthBrt(new Date());
    const result = await callerShifts(
      scopedUserId,
      "manager",
      institutionB,
    ).openMonthShifts({
      hospitalId: hospitalB,
      sectorId: sectorB,
      scheduleContextId: contextB.id,
      yearMonth,
      mode: "custom",
      templateNames: ["Manhã"],
    });
    expect(result.created).toBeGreaterThan(0);
    const rows = await countMonth(institutionB, sectorB, yearMonth);
    expect(rows.every((row) => row.label === "Manhã")).toBe(true);
  });

  it("instituição A continua com a própria escala, sem vazamento", async () => {
    const opened = await callerShifts(
      gestorAUserId,
      "manager",
      institutionA,
    ).openMonthShifts({
      hospitalId: hospitalA,
      sectorId: sectorA,
      scheduleContextId: contextA,
      yearMonth: "2026-09",
      mode: "weekends-only",
    });
    expect(opened.created).toBeGreaterThan(0);
    const rowsA = await countMonth(institutionA, sectorA, "2026-09");
    const rowsB = await countMonth(institutionB, sectorB, "2026-09");
    expect(rowsA.every((row) => row.label === "Manhã" || row.label === "Tarde")).toBe(
      true,
    );
    expect(rowsB.length).toBeGreaterThan(0);
  });
});

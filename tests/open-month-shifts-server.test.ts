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
import { shiftsRouter } from "../server/shifts-crud";
import { SALA_RECUPERACAO_SHIFT_TEMPLATES } from "../lib/sala-recuperacao-shift-blueprint";
import { planOpenMonthShifts } from "../lib/open-month-shifts";

const OFFSET = "-03:00";
const at = (date: string, time: string) => new Date(`${date}T${time}${OFFSET}`);

describe("shifts.openMonthShifts", () => {
  let db: Awaited<ReturnType<typeof getDb>>;
  let institutionId: number;
  let hospitalId: number;
  let sectorId: number;
  let emptySectorId: number;
  let scheduleContextId: number;
  let emptyScheduleContextId: number;
  let managerUserId: number;
  let managerProfessionalId: number;
  let doctorUserId: number;
  let doctorProfessionalId: number;

  const callerFor = (userId: number, role: string) =>
    shiftsRouter.createCaller({
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

    const [institution] = await db
      .insert(institutions)
      .values({
        name: `Abrir Turnos Tenant ${stamp}`,
        cnpj: `${stamp}`.slice(-14).padStart(14, "0"),
        legalName: `Abrir Turnos Tenant ${stamp}`,
        tradeName: `AT${stamp}`.slice(0, 20),
        isActive: true,
      })
      .$returningId();
    institutionId = institution.id;

    const [hospital] = await db
      .insert(hospitals)
      .values({ institutionId, name: `Abrir Turnos Hospital ${stamp}` })
      .$returningId();
    hospitalId = hospital.id;

    const [sector] = await db
      .insert(sectors)
      .values({
        institutionId,
        hospitalId,
        name: "Sala de Recuperação",
        category: "cirurgico",
        color: "#2563EB",
      })
      .$returningId();
    sectorId = sector.id;
    const [emptySector] = await db
      .insert(sectors)
      .values({
        institutionId,
        hospitalId,
        name: `Setor sem modelos ${stamp}`,
        category: "cirurgico",
        color: "#7C3AED",
      })
      .$returningId();
    emptySectorId = emptySector.id;

    await ensureTestAnesthesiaSpecialty(db);
    scheduleContextId = await openTestScale(db, {
      institutionId,
      hospitalId,
      sectorId,
    });
    emptyScheduleContextId = await openTestScale(db, {
      institutionId,
      hospitalId,
      sectorId: emptySectorId,
    });

    const [managerUser] = await db
      .insert(users)
      .values({
        name: `Abrir Turnos Gestor ${stamp}`,
        email: `abrir-turnos-gestor-${stamp}@test.local`,
        passwordHash: "test",
        role: "manager",
      })
      .$returningId();
    managerUserId = managerUser.id;
    const [managerProfessional] = await db
      .insert(professionals)
      .values({
        userId: managerUserId,
        name: `Abrir Turnos Gestor ${stamp}`,
        role: "Gestor",
        userRole: "GESTOR_PLUS",
      })
      .$returningId();
    managerProfessionalId = managerProfessional.id;

    const [doctorUser] = await db
      .insert(users)
      .values({
        name: `Abrir Turnos Doutor ${stamp}`,
        email: `abrir-turnos-doutor-${stamp}@test.local`,
        passwordHash: "test",
        role: "doctor",
      })
      .$returningId();
    doctorUserId = doctorUser.id;
    const [doctorProfessional] = await db
      .insert(professionals)
      .values({
        userId: doctorUserId,
        name: `Abrir Turnos Doutor ${stamp}`,
        role: "Médico",
        userRole: "USER",
      })
      .$returningId();
    doctorProfessionalId = doctorProfessional.id;

    await db.insert(professionalInstitutions).values([
      {
        professionalId: managerProfessionalId,
        userId: managerUserId,
        institutionId,
        roleInInstitution: "GESTOR_PLUS",
        isPrimary: true,
        active: true,
      },
      {
        professionalId: doctorProfessionalId,
        userId: doctorUserId,
        institutionId,
        roleInInstitution: "USER",
        isPrimary: true,
        active: true,
      },
    ]);
    await db.insert(managerScope).values([
      {
        institutionId,
        managerProfessionalId,
        hospitalId,
        sectorId,
        active: true,
      },
      {
        institutionId,
        managerProfessionalId,
        hospitalId,
        sectorId: emptySectorId,
        active: true,
      },
    ]);

    await db.insert(shiftTemplates).values(
      SALA_RECUPERACAO_SHIFT_TEMPLATES.map((template) => ({
        institutionId,
        hospitalId,
        sectorId,
        name: template.name,
        startTime: template.startTime,
        endTime: template.endTime,
        isActive: true,
        priority: template.priority,
      })),
    );
  });

  afterAll(async () => {
    if (!db) return;
    const allShifts = await db
      .select({ id: shiftInstances.id })
      .from(shiftInstances)
      .where(eq(shiftInstances.institutionId, institutionId));
    const ids = allShifts.map((row) => row.id);
    if (ids.length) {
      await db
        .delete(shiftAssignmentsV2)
        .where(inArray(shiftAssignmentsV2.shiftInstanceId, ids));
      await db.delete(shiftInstances).where(inArray(shiftInstances.id, ids));
    }
    await db.delete(auditTrail).where(eq(auditTrail.institutionId, institutionId));
    await db.delete(monthlyRosters).where(eq(monthlyRosters.institutionId, institutionId));
    await db.delete(managerScope).where(eq(managerScope.institutionId, institutionId));
    await db
      .delete(professionalInstitutions)
      .where(eq(professionalInstitutions.institutionId, institutionId));
    await db
      .delete(professionals)
      .where(
        inArray(professionals.id, [
          managerProfessionalId,
          doctorProfessionalId,
        ]),
      );
    await db.delete(shiftTemplates).where(eq(shiftTemplates.institutionId, institutionId));
    await db
      .delete(scheduleContexts)
      .where(inArray(scheduleContexts.id, [scheduleContextId, emptyScheduleContextId]));
    await db.delete(sectors).where(inArray(sectors.id, [sectorId, emptySectorId]));
    await db.delete(hospitals).where(eq(hospitals.id, hospitalId));
    await db.delete(institutions).where(eq(institutions.id, institutionId));
    await db.delete(users).where(inArray(users.id, [managerUserId, doctorUserId]));
  });

  async function countMonth(yearMonth: string) {
    const [year, month] = yearMonth.split("-").map(Number);
    const next =
      month === 12 ? `${year + 1}-01` : `${year}-${String(month + 1).padStart(2, "0")}`;
    return db!
      .select({
        id: shiftInstances.id,
        label: shiftInstances.label,
        startAt: shiftInstances.startAt,
        endAt: shiftInstances.endAt,
        status: shiftInstances.status,
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

  it("setembro/2026 cria 74 plantões vagos com as regras da Sala", async () => {
    const caller = callerFor(managerUserId, "manager");
    const result = await caller.openMonthShifts({
      hospitalId,
      sectorId,
      scheduleContextId,
      yearMonth: "2026-09",
      mode: "all-applicable",
    });
    expect(result.created).toBe(74);
    expect(result.skipped).toBe(0);

    const rows = await countMonth("2026-09");
    expect(rows).toHaveLength(74);
    expect(rows.every((row) => row.status === "VAGO")).toBe(true);

    const mondayMorning = rows.find(
      (row) =>
        row.label === "Manhã" &&
        row.startAt.getTime() === at("2026-09-07", "07:00:00").getTime(),
    );
    expect(mondayMorning?.endAt.getTime()).toBe(at("2026-09-07", "13:00:00").getTime());

    const mondayNight = rows.find(
      (row) =>
        row.label === "Noite" &&
        row.startAt.getTime() === at("2026-09-07", "19:00:00").getTime(),
    );
    expect(mondayNight?.endAt.getTime()).toBe(at("2026-09-08", "07:00:00").getTime());

    expect(
      rows.some(
        (row) =>
          row.label === "Noite" &&
          row.startAt.getTime() === at("2026-09-05", "19:00:00").getTime(),
      ),
    ).toBe(false);
  });

  it("segunda execução é idempotente: created=0 skipped=74", async () => {
    const result = await callerFor(managerUserId, "manager").openMonthShifts({
      hospitalId,
      sectorId,
      scheduleContextId,
      yearMonth: "2026-09",
      mode: "all-applicable",
    });
    expect(result).toMatchObject({ created: 0, skipped: 74 });
    expect(await countMonth("2026-09")).toHaveLength(74);
  });

  it("só noites e só sábados geram a contagem do recorte", async () => {
    const nightsExpected = planOpenMonthShifts({
      yearMonth: "2026-10",
      mode: "nights-only",
    }).length;
    const weekendsExpected = planOpenMonthShifts({
      yearMonth: "2026-11",
      mode: "weekends-only",
    }).length;

    const nights = await callerFor(managerUserId, "manager").openMonthShifts({
      hospitalId,
      sectorId,
      scheduleContextId,
      yearMonth: "2026-10",
      mode: "nights-only",
    });
    expect(nights.created).toBe(nightsExpected);
    expect(nights.skipped).toBe(0);
    const nightRows = await countMonth("2026-10");
    expect(nightRows.every((row) => row.label === "Noite")).toBe(true);

    const weekends = await callerFor(managerUserId, "manager").openMonthShifts({
      hospitalId,
      sectorId,
      scheduleContextId,
      yearMonth: "2026-11",
      mode: "weekends-only",
    });
    expect(weekends.created).toBe(weekendsExpected);
    expect(weekends.skipped).toBe(0);
    const weekendRows = await countMonth("2026-11");
    expect(weekendRows.every((row) => row.label === "Manhã" || row.label === "Tarde")).toBe(
      true,
    );
  });

  it("mês PUBLISHED vazio não exige motivo de 5 caracteres", async () => {
    await db!.insert(monthlyRosters).values({
      institutionId,
      hospitalId,
      yearMonth: "2026-12",
      status: "PUBLISHED",
    });
    const result = await callerFor(managerUserId, "manager").openMonthShifts({
      hospitalId,
      sectorId,
      scheduleContextId,
      yearMonth: "2026-12",
      mode: "custom",
      templateNames: ["Manhã"],
    });
    expect(result.created).toBeGreaterThan(0);
    expect(result.skipped).toBe(0);
    const rows = await countMonth("2026-12");
    expect(rows.every((row) => row.label === "Manhã")).toBe(true);
  });

  it("sem modelos de horário explica o bloqueio", async () => {
    await expect(
      callerFor(managerUserId, "manager").openMonthShifts({
        hospitalId,
        sectorId: emptySectorId,
        scheduleContextId: emptyScheduleContextId,
        yearMonth: "2027-01",
        mode: "all-applicable",
      }),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: expect.stringMatching(/Não há modelo/),
    });
  });

  it("médico comum não pode abrir os turnos", async () => {
    await expect(
      callerFor(doctorUserId, "doctor").openMonthShifts({
        hospitalId,
        sectorId,
        scheduleContextId,
        yearMonth: "2027-02",
        mode: "all-applicable",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

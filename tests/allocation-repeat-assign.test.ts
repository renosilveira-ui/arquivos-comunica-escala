import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import {
  auditTrail,
  hospitals,
  institutions,
  managerScope,
  monthlyRosters,
  professionalAccess,
  professionalInstitutions,
  professionals,
  scheduleContexts,
  sectors,
  shiftAssignmentsV2,
  shiftAuditLog,
  shiftInstances,
  users,
} from "../drizzle/schema";
import {
  ensureTestAnesthesiaSpecialty,
  openTestScale,
} from "./helpers/open-test-scale";
import { getDb } from "../server/db";
import { editorRouter } from "../server/editor";
import { buildShiftTimestamps } from "../lib/hospital-time";
import { weekdayOfKey, yearMonthBrt } from "../server/local-time";

function weekdayKeysInMonth(yearMonth: string, weekday: number): string[] {
  const keys: string[] = [];
  for (let day = 1; day <= 31; day++) {
    const key = `${yearMonth}-${String(day).padStart(2, "0")}`;
    const probe = new Date(`${key}T12:00:00-03:00`);
    if (yearMonthBrt(probe) !== yearMonth) break;
    if (weekdayOfKey(key) === weekday) keys.push(key);
  }
  return keys;
}

function nextYearMonth(yearMonth: string): string {
  const [year, month] = yearMonth.split("-").map(Number);
  return month === 12
    ? `${year + 1}-01`
    : `${year}-${String(month + 1).padStart(2, "0")}`;
}

describe("editor.assignDirect com regra de repetição", () => {
  let db: Awaited<ReturnType<typeof getDb>>;
  let institutionId: number;
  let hospitalId: number;
  let sectorId: number;
  let otherSectorId: number;
  let scheduleContextId: number;
  let otherContextId: number;
  let managerUserId: number;
  let managerProfessionalId: number;
  let doctorProfessionalId: number;
  let otherDoctorProfessionalId: number;
  let stamp: number;
  const createdShiftIds: number[] = [];
  const tuesdayKeys = weekdayKeysInMonth(yearMonthBrt(new Date()), 2);
  const nextMonthTuesday = weekdayKeysInMonth(
    nextYearMonth(yearMonthBrt(new Date())),
    2,
  )[0];

  const caller = () =>
    editorRouter.createCaller({
      user: {
        id: managerUserId,
        role: "manager",
        name: "Gestor repetição",
        email: "gestor-repeat@test.local",
        sessionVersion: 1,
      },
      institutionId,
      allowedInstitutionIds: [institutionId],
    } as any);

  async function insertShift(input: {
    dayKey: string;
    label?: string;
    start?: string;
    end?: string;
    sectorId?: number;
    scheduleContextId?: number;
    status?: "VAGO" | "OCUPADO";
  }): Promise<number> {
    const [startAt, endAt] = buildShiftTimestamps(
      input.dayKey,
      input.start ?? "07:00:00",
      input.end ?? "13:00:00",
    );
    const [row] = await db!
      .insert(shiftInstances)
      .values({
        institutionId,
        hospitalId,
        sectorId: input.sectorId ?? sectorId,
        scheduleContextId: input.scheduleContextId ?? scheduleContextId,
        label: input.label ?? "Manhã teste",
        startAt,
        endAt,
        status: input.status ?? "VAGO",
      })
      .$returningId();
    createdShiftIds.push(row.id);
    return row.id;
  }

  async function occupy(shiftId: number, professionalId: number) {
    await db!.insert(shiftAssignmentsV2).values({
      shiftInstanceId: shiftId,
      institutionId,
      hospitalId,
      sectorId,
      professionalId,
      assignmentType: "ON_DUTY",
      status: "OCUPADO",
      isActive: true,
      createdBy: managerUserId,
    });
    await db!
      .update(shiftInstances)
      .set({ status: "OCUPADO" })
      .where(eq(shiftInstances.id, shiftId));
  }

  async function assignedProfessionalIds(shiftIds: number[]) {
    if (shiftIds.length === 0) return [];
    const rows = await db!
      .select({
        shiftInstanceId: shiftAssignmentsV2.shiftInstanceId,
        professionalId: shiftAssignmentsV2.professionalId,
        isActive: shiftAssignmentsV2.isActive,
      })
      .from(shiftAssignmentsV2)
      .where(
        and(
          inArray(shiftAssignmentsV2.shiftInstanceId, shiftIds),
          eq(shiftAssignmentsV2.isActive, true),
        ),
      );
    return rows;
  }

  beforeAll(async () => {
    db = await getDb();
    if (!db) throw new Error("Database not available");
    expect(tuesdayKeys.length).toBeGreaterThanOrEqual(4);
    stamp = Date.now();

    const [institution] = await db
      .insert(institutions)
      .values({
        name: `Repeat Tenant ${stamp}`,
        cnpj: `${stamp}`.slice(-14).padStart(14, "0"),
        legalName: `Repeat Tenant ${stamp}`,
        tradeName: `RP${stamp}`.slice(0, 20),
        isActive: true,
      })
      .$returningId();
    institutionId = institution.id;

    const [hospital] = await db
      .insert(hospitals)
      .values({ institutionId, name: `Repeat Hospital ${stamp}` })
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
    const [otherSector] = await db
      .insert(sectors)
      .values({
        institutionId,
        hospitalId,
        name: `Outro setor ${stamp}`,
        category: "servico",
        color: "#7C3AED",
      })
      .$returningId();
    otherSectorId = otherSector.id;

    const specialtyId = await ensureTestAnesthesiaSpecialty(db);
    scheduleContextId = await openTestScale(db, {
      institutionId,
      hospitalId,
      sectorId,
    });
    otherContextId = await openTestScale(db, {
      institutionId,
      hospitalId,
      sectorId: otherSectorId,
    });

    const [managerUser] = await db
      .insert(users)
      .values({
        name: `Repeat Manager ${stamp}`,
        email: `repeat-manager-${stamp}@test.local`,
        passwordHash: "test",
        role: "manager",
      })
      .$returningId();
    managerUserId = managerUser.id;
    const [managerProfessional] = await db
      .insert(professionals)
      .values({
        userId: managerUserId,
        name: `Repeat Manager ${stamp}`,
        role: "Gestor",
        userRole: "GESTOR_MEDICO",
        medicalSpecialtyId: specialtyId,
      })
      .$returningId();
    managerProfessionalId = managerProfessional.id;

    const [doctorUser] = await db
      .insert(users)
      .values({
        name: `Repeat Doctor ${stamp}`,
        email: `repeat-doctor-${stamp}@test.local`,
        passwordHash: "test",
        role: "doctor",
      })
      .$returningId();
    const [doctorProfessional] = await db
      .insert(professionals)
      .values({
        userId: doctorUser.id,
        name: `Repeat Doctor ${stamp}`,
        role: "Médico",
        userRole: "USER",
        medicalSpecialtyId: specialtyId,
        specialty: "Anestesiologia",
      })
      .$returningId();
    doctorProfessionalId = doctorProfessional.id;

    const [otherDoctorUser] = await db
      .insert(users)
      .values({
        name: `Repeat Other ${stamp}`,
        email: `repeat-other-${stamp}@test.local`,
        passwordHash: "test",
        role: "doctor",
      })
      .$returningId();
    const [otherDoctor] = await db
      .insert(professionals)
      .values({
        userId: otherDoctorUser.id,
        name: `Repeat Other ${stamp}`,
        role: "Médico",
        userRole: "USER",
        medicalSpecialtyId: specialtyId,
        specialty: "Anestesiologia",
      })
      .$returningId();
    otherDoctorProfessionalId = otherDoctor.id;

    await db.insert(professionalInstitutions).values([
      {
        professionalId: managerProfessionalId,
        userId: managerUserId,
        institutionId,
        roleInInstitution: "GESTOR_MEDICO",
        isPrimary: true,
        active: true,
      },
      {
        professionalId: doctorProfessionalId,
        userId: doctorUser.id,
        institutionId,
        roleInInstitution: "USER",
        isPrimary: true,
        active: true,
      },
      {
        professionalId: otherDoctorProfessionalId,
        userId: otherDoctorUser.id,
        institutionId,
        roleInInstitution: "USER",
        isPrimary: true,
        active: true,
      },
    ]);
    await db.insert(managerScope).values({
      institutionId,
      managerProfessionalId,
      hospitalId,
      sectorId,
      active: true,
    });
    await db.insert(professionalAccess).values([
      {
        institutionId,
        professionalId: doctorProfessionalId,
        hospitalId,
        sectorId,
        canAccess: true,
      },
      {
        institutionId,
        professionalId: otherDoctorProfessionalId,
        hospitalId,
        sectorId,
        canAccess: true,
      },
    ]);
  });

  afterEach(async () => {
    if (!db || createdShiftIds.length === 0) return;
    await db
      .delete(shiftAssignmentsV2)
      .where(inArray(shiftAssignmentsV2.shiftInstanceId, createdShiftIds));
    await db
      .update(shiftInstances)
      .set({ status: "VAGO" })
      .where(inArray(shiftInstances.id, createdShiftIds));
  });

  afterAll(async () => {
    if (!db) return;
    if (createdShiftIds.length > 0) {
      await db.delete(auditTrail).where(inArray(auditTrail.shiftInstanceId, createdShiftIds));
      await db
        .delete(shiftAuditLog)
        .where(inArray(shiftAuditLog.shiftInstanceId, createdShiftIds));
      await db
        .delete(shiftAssignmentsV2)
        .where(inArray(shiftAssignmentsV2.shiftInstanceId, createdShiftIds));
      await db.delete(shiftInstances).where(inArray(shiftInstances.id, createdShiftIds));
    }
    const professionalIds = [
      managerProfessionalId,
      doctorProfessionalId,
      otherDoctorProfessionalId,
    ].filter((id): id is number => typeof id === "number");
    if (professionalIds.length > 0) {
      await db
        .delete(professionalAccess)
        .where(inArray(professionalAccess.professionalId, professionalIds));
      await db
        .delete(professionalInstitutions)
        .where(inArray(professionalInstitutions.professionalId, professionalIds));
      await db
        .delete(managerScope)
        .where(inArray(managerScope.managerProfessionalId, professionalIds));
      await db.delete(professionals).where(inArray(professionals.id, professionalIds));
    }
    if (otherContextId) {
      await db.delete(scheduleContexts).where(eq(scheduleContexts.id, otherContextId));
    }
    if (scheduleContextId) {
      await db.delete(scheduleContexts).where(eq(scheduleContexts.id, scheduleContextId));
    }
    await db.delete(monthlyRosters).where(eq(monthlyRosters.institutionId, institutionId));
    if (otherSectorId) await db.delete(sectors).where(eq(sectors.id, otherSectorId));
    if (sectorId) await db.delete(sectors).where(eq(sectors.id, sectorId));
    if (hospitalId) await db.delete(hospitals).where(eq(hospitals.id, hospitalId));
    if (institutionId) {
      await db.delete(institutions).where(eq(institutions.id, institutionId));
    }
    await db
      .delete(users)
      .where(
        inArray(users.email, [
          `repeat-manager-${stamp}@test.local`,
          `repeat-doctor-${stamp}@test.local`,
          `repeat-other-${stamp}@test.local`,
        ]),
      );
  });

  it("semanal aloca o mesmo médico nos plantões vagos seguintes do mês", async () => {
    const sourceId = await insertShift({ dayKey: tuesdayKeys[0], label: "Manhã semanal" });
    const week2 = await insertShift({ dayKey: tuesdayKeys[1], label: "Manhã semanal" });
    const week3 = await insertShift({ dayKey: tuesdayKeys[2], label: "Manhã semanal" });
    const week4 = await insertShift({ dayKey: tuesdayKeys[3], label: "Manhã semanal" });
    const tarde = await insertShift({
      dayKey: tuesdayKeys[1],
      label: "Tarde",
      start: "13:00:00",
      end: "19:00:00",
    });
    const otherClock = await insertShift({
      dayKey: tuesdayKeys[1],
      label: "Manhã semanal",
      start: "08:00:00",
      end: "14:00:00",
    });
    const otherSector = await insertShift({
      dayKey: tuesdayKeys[1],
      label: "Manhã semanal",
      sectorId: otherSectorId,
      scheduleContextId: otherContextId,
    });
    const nextMonth = await insertShift({
      dayKey: nextMonthTuesday,
      label: "Manhã semanal",
    });

    const result = await caller().assignDirect({
      shiftInstanceId: sourceId,
      professionalId: doctorProfessionalId,
      assignmentType: "ON_DUTY",
      reason: "Repetir semanalmente",
      repeatRule: "weekly",
    });

    expect(result.ok).toBe(true);
    expect(result.allocatedCount).toBe(4);
    expect(result.skippedOccupiedCount).toBe(0);

    const assigned = await assignedProfessionalIds([
      sourceId,
      week2,
      week3,
      week4,
      tarde,
      otherClock,
      otherSector,
      nextMonth,
    ]);
    const byShift = new Map(assigned.map((row) => [row.shiftInstanceId, row.professionalId]));
    expect(byShift.get(sourceId)).toBe(doctorProfessionalId);
    expect(byShift.get(week2)).toBe(doctorProfessionalId);
    expect(byShift.get(week3)).toBe(doctorProfessionalId);
    expect(byShift.get(week4)).toBe(doctorProfessionalId);
    expect(byShift.has(tarde)).toBe(false);
    expect(byShift.has(otherClock)).toBe(false);
    expect(byShift.has(otherSector)).toBe(false);
    expect(byShift.has(nextMonth)).toBe(false);
  });

  it("quinzenal aloca de 14 em 14 dias e ignora plantão já ocupado", async () => {
    const sourceId = await insertShift({ dayKey: tuesdayKeys[0], label: "Manhã quinzenal" });
    const week2 = await insertShift({ dayKey: tuesdayKeys[1], label: "Manhã quinzenal" });
    const week3 = await insertShift({ dayKey: tuesdayKeys[2], label: "Manhã quinzenal" });
    const week4 = await insertShift({ dayKey: tuesdayKeys[3], label: "Manhã quinzenal" });
    await occupy(week3, otherDoctorProfessionalId);

    const result = await caller().assignDirect({
      shiftInstanceId: sourceId,
      professionalId: doctorProfessionalId,
      assignmentType: "ON_DUTY",
      reason: "Repetir quinzenal",
      repeatRule: "biweekly",
    });

    expect(result.allocatedCount).toBe(1);
    expect(result.skippedOccupiedCount).toBe(1);

    const assigned = await assignedProfessionalIds([sourceId, week2, week3, week4]);
    const byShift = new Map(assigned.map((row) => [row.shiftInstanceId, row.professionalId]));
    expect(byShift.get(sourceId)).toBe(doctorProfessionalId);
    expect(byShift.has(week2)).toBe(false);
    expect(byShift.get(week3)).toBe(otherDoctorProfessionalId);
    expect(byShift.has(week4)).toBe(false);
  });

  it("mensal e não repetir alocam só o plantão origem neste mês", async () => {
    const sourceMonthly = await insertShift({
      dayKey: tuesdayKeys[0],
      label: "Manhã mensal",
    });
    const laterMonthly = await insertShift({
      dayKey: tuesdayKeys[1],
      label: "Manhã mensal",
    });
    const monthly = await caller().assignDirect({
      shiftInstanceId: sourceMonthly,
      professionalId: doctorProfessionalId,
      assignmentType: "ON_DUTY",
      reason: "Uma vez por mês",
      repeatRule: "monthly",
    });
    expect(monthly.allocatedCount).toBe(1);
    expect(monthly.skippedOccupiedCount).toBe(0);

    const sourceNone = await insertShift({
      dayKey: tuesdayKeys[2],
      label: "Manhã única",
    });
    const laterNone = await insertShift({
      dayKey: tuesdayKeys[3],
      label: "Manhã única",
    });
    const none = await caller().assignDirect({
      shiftInstanceId: sourceNone,
      professionalId: doctorProfessionalId,
      assignmentType: "ON_DUTY",
      reason: "Só este",
    });
    expect(none.allocatedCount).toBe(1);

    const assigned = await assignedProfessionalIds([
      sourceMonthly,
      laterMonthly,
      sourceNone,
      laterNone,
    ]);
    const byShift = new Map(assigned.map((row) => [row.shiftInstanceId, row.professionalId]));
    expect(byShift.get(sourceMonthly)).toBe(doctorProfessionalId);
    expect(byShift.has(laterMonthly)).toBe(false);
    expect(byShift.get(sourceNone)).toBe(doctorProfessionalId);
    expect(byShift.has(laterNone)).toBe(false);
  });

  it("pula a semana sem plantão vago e não cria turno novo", async () => {
    const sourceId = await insertShift({ dayKey: tuesdayKeys[0], label: "Manhã furo" });
    const week3 = await insertShift({ dayKey: tuesdayKeys[2], label: "Manhã furo" });
    const before = await db!
      .select({ id: shiftInstances.id })
      .from(shiftInstances)
      .where(eq(shiftInstances.institutionId, institutionId));

    const result = await caller().assignDirect({
      shiftInstanceId: sourceId,
      professionalId: doctorProfessionalId,
      assignmentType: "ON_DUTY",
      reason: "Semanal com furo",
      repeatRule: "weekly",
    });

    expect(result.allocatedCount).toBe(2);
    const assigned = await assignedProfessionalIds([sourceId, week3]);
    expect(assigned).toHaveLength(2);
    const after = await db!
      .select({ id: shiftInstances.id })
      .from(shiftInstances)
      .where(eq(shiftInstances.institutionId, institutionId));
    expect(after).toHaveLength(before.length);
  });
});

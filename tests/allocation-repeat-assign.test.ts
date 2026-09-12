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
  notifications,
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

function addDaysKey(dayKey: string, days: number): string {
  const [y, m, d] = dayKey.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/**
 * Fim do horizonte, derivado aqui de propósito: se concordar com o do
 * servidor, concordam duas implementações independentes.
 */
function horizonEndKey(dayKey: string, months: number): string {
  const [y, m, d] = dayKey.split("-").map(Number);
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const lastDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  return `${target.getUTCFullYear()}-${String(target.getUTCMonth() + 1).padStart(2, "0")}-${String(Math.min(d, lastDay)).padStart(2, "0")}`;
}

/** Os dias que a repetição deve alcançar, de `step` em `step` dias. */
function repeatDaysAhead(
  sourceKey: string,
  months: number,
  step: number,
): string[] {
  const last = horizonEndKey(sourceKey, months);
  const days: string[] = [];
  for (
    let cursor = addDaysKey(sourceKey, step);
    cursor <= last;
    cursor = addDaysKey(cursor, step)
  ) {
    days.push(cursor);
  }
  return days;
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
    requiredCapacity?: number | null;
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
        // Legacy fixtures intentionally share a block under different labels.
        requiredCapacity: input.requiredCapacity ?? null,
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

  /** Tudo que existe na instituição de teste, inclusive o que a repetição abriu. */
  async function institutionShiftIds(): Promise<number[]> {
    const rows = await db!
      .select({ id: shiftInstances.id })
      .from(shiftInstances)
      .where(eq(shiftInstances.institutionId, institutionId));
    return rows.map((row) => row.id);
  }

  afterEach(async () => {
    if (!db || !institutionId) return;
    // A repetição cria plantões que a fixture não registrou. Limpar só o
    // que foi inserido à mão deixaria esses para o teste seguinte.
    const ids = await institutionShiftIds();
    if (ids.length === 0) return;
    await db.delete(auditTrail).where(inArray(auditTrail.shiftInstanceId, ids));
    await db
      .delete(shiftAuditLog)
      .where(inArray(shiftAuditLog.shiftInstanceId, ids));
    await db
      .delete(notifications)
      .where(inArray(notifications.shiftInstanceId, ids));
    await db
      .delete(shiftAssignmentsV2)
      .where(inArray(shiftAssignmentsV2.shiftInstanceId, ids));
    await db.delete(shiftInstances).where(inArray(shiftInstances.id, ids));
    createdShiftIds.length = 0;
  });

  afterAll(async () => {
    if (!db) return;
    if (createdShiftIds.length > 0) {
      await db
        .delete(auditTrail)
        .where(inArray(auditTrail.shiftInstanceId, createdShiftIds));
      await db
        .delete(shiftAuditLog)
        .where(inArray(shiftAuditLog.shiftInstanceId, createdShiftIds));
      await db
        .delete(notifications)
        .where(inArray(notifications.shiftInstanceId, createdShiftIds));
      await db
        .delete(shiftAssignmentsV2)
        .where(inArray(shiftAssignmentsV2.shiftInstanceId, createdShiftIds));
      await db
        .delete(shiftInstances)
        .where(inArray(shiftInstances.id, createdShiftIds));
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
        .where(
          inArray(professionalInstitutions.professionalId, professionalIds),
        );
      await db
        .delete(managerScope)
        .where(inArray(managerScope.managerProfessionalId, professionalIds));
      await db
        .delete(professionals)
        .where(inArray(professionals.id, professionalIds));
    }
    if (otherContextId) {
      await db
        .delete(scheduleContexts)
        .where(eq(scheduleContexts.id, otherContextId));
    }
    if (scheduleContextId) {
      await db
        .delete(scheduleContexts)
        .where(eq(scheduleContexts.id, scheduleContextId));
    }
    await db
      .delete(monthlyRosters)
      .where(eq(monthlyRosters.institutionId, institutionId));
    if (otherSectorId)
      await db.delete(sectors).where(eq(sectors.id, otherSectorId));
    if (sectorId) await db.delete(sectors).where(eq(sectors.id, sectorId));
    if (hospitalId)
      await db.delete(hospitals).where(eq(hospitals.id, hospitalId));
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

  async function shiftsByLabel(label: string) {
    return db!
      .select({
        id: shiftInstances.id,
        label: shiftInstances.label,
        sectorId: shiftInstances.sectorId,
        scheduleContextId: shiftInstances.scheduleContextId,
        startAt: shiftInstances.startAt,
        endAt: shiftInstances.endAt,
        status: shiftInstances.status,
      })
      .from(shiftInstances)
      .where(
        and(
          eq(shiftInstances.institutionId, institutionId),
          eq(shiftInstances.label, label),
        ),
      );
  }

  it("semanal abre as vagas que faltam e aloca em todo o horizonte", async () => {
    const sourceKey = tuesdayKeys[0];
    const expected = repeatDaysAhead(sourceKey, 1, 7);

    const existingKeys = [expected[0], expected[1]];
    const sourceId = await insertShift({
      dayKey: sourceKey,
      label: "Manhã semanal",
    });
    for (const key of existingKeys) {
      await insertShift({ dayKey: key, label: "Manhã semanal" });
    }
    const tarde = await insertShift({
      dayKey: expected[0],
      label: "Tarde",
      start: "13:00:00",
      end: "19:00:00",
    });
    const otherClock = await insertShift({
      dayKey: expected[0],
      label: "Manhã semanal",
      start: "08:00:00",
      end: "14:00:00",
    });
    const otherSector = await insertShift({
      dayKey: expected[0],
      label: "Manhã semanal",
      sectorId: otherSectorId,
      scheduleContextId: otherContextId,
    });

    const result = await caller().assignDirect({
      shiftInstanceId: sourceId,
      professionalId: doctorProfessionalId,
      assignmentType: "ON_DUTY",
      reason: "Repetir semanalmente",
      repeatRule: "weekly",
      repeatMonths: 1,
    });

    expect(result.ok).toBe(true);
    expect(result.allocatedCount).toBe(1 + expected.length);
    expect(result.createdSlotCount).toBe(expected.length - existingKeys.length);
    expect(result.skippedOccupiedCount).toBe(0);

    // Rótulo, relógio, setor e contexto errados continuam de fora.
    const untouched = await assignedProfessionalIds([
      tarde,
      otherClock,
      otherSector,
    ]);
    expect(untouched).toHaveLength(0);

    // Uma vaga por dia alvo, mais a origem — e o médico em todas elas.
    const ownSector = (await shiftsByLabel("Manhã semanal")).filter(
      (row) => row.sectorId === sectorId,
    );
    const assigned = await assignedProfessionalIds(
      ownSector.map((row) => row.id),
    );
    expect(assigned).toHaveLength(1 + expected.length);
    for (const row of assigned) {
      expect(row.professionalId).toBe(doctorProfessionalId);
    }
  });

  it("a vaga aberta é cópia fiel do plantão de origem", async () => {
    const sourceKey = tuesdayKeys[0];
    const expected = repeatDaysAhead(sourceKey, 1, 7);
    const sourceId = await insertShift({
      dayKey: sourceKey,
      label: "Noite cópia",
      start: "19:00:00",
      end: "07:00:00",
    });

    await caller().assignDirect({
      shiftInstanceId: sourceId,
      professionalId: doctorProfessionalId,
      assignmentType: "ON_DUTY",
      reason: "Repetir a noite",
      repeatRule: "weekly",
      repeatMonths: 1,
    });

    const rows = await shiftsByLabel("Noite cópia");
    expect(rows).toHaveLength(1 + expected.length);
    const source = rows.find((row) => row.id === sourceId)!;
    const duration = source.endAt.getTime() - source.startAt.getTime();
    for (const row of rows) {
      expect(row.sectorId).toBe(source.sectorId);
      expect(row.scheduleContextId).toBe(source.scheduleContextId);
      // O offset do hospital é fixo, então a janela não escorrega no caminho.
      expect(row.endAt.getTime() - row.startAt.getTime()).toBe(duration);
      expect(row.startAt.getUTCHours()).toBe(source.startAt.getUTCHours());
      expect(row.startAt.getUTCMinutes()).toBe(source.startAt.getUTCMinutes());
    }
  });

  it("quinzenal vai de 14 em 14 e respeita quem já tem médico", async () => {
    const sourceKey = tuesdayKeys[0];
    const expected = repeatDaysAhead(sourceKey, 1, 14);
    const occupiedId = await insertShift({
      dayKey: expected[0],
      label: "Manhã quinzenal",
    });
    await occupy(occupiedId, otherDoctorProfessionalId);
    const sourceId = await insertShift({
      dayKey: sourceKey,
      label: "Manhã quinzenal",
    });

    const result = await caller().assignDirect({
      shiftInstanceId: sourceId,
      professionalId: doctorProfessionalId,
      assignmentType: "ON_DUTY",
      reason: "Repetir quinzenal",
      repeatRule: "biweekly",
      repeatMonths: 1,
    });

    expect(result.skippedOccupiedCount).toBe(1);
    expect(result.allocatedCount).toBe(expected.length);
    expect(result.createdSlotCount).toBe(expected.length - 1);
    const stillOther = await assignedProfessionalIds([occupiedId]);
    expect(stillOther).toHaveLength(1);
    expect(stillOther[0].professionalId).toBe(otherDoctorProfessionalId);
  });

  it("mensal alcança o mês seguinte; não repetir fica só na origem", async () => {
    const sourceKey = tuesdayKeys[0];
    // Mesmo dia da semana e mesmo ordinal — só conta se couber no horizonte.
    const reachable = nextMonthTuesday <= horizonEndKey(sourceKey, 1);
    const sourceMonthly = await insertShift({
      dayKey: sourceKey,
      label: "Manhã mensal",
    });
    const monthly = await caller().assignDirect({
      shiftInstanceId: sourceMonthly,
      professionalId: doctorProfessionalId,
      assignmentType: "ON_DUTY",
      reason: "Uma vez por mês",
      repeatRule: "monthly",
      repeatMonths: 1,
    });
    expect(monthly.allocatedCount).toBe(reachable ? 2 : 1);
    expect(monthly.createdSlotCount).toBe(reachable ? 1 : 0);

    const sourceNone = await insertShift({
      dayKey: tuesdayKeys[1],
      label: "Manhã única",
    });
    const laterNone = await insertShift({
      dayKey: tuesdayKeys[2],
      label: "Manhã única",
    });
    const none = await caller().assignDirect({
      shiftInstanceId: sourceNone,
      professionalId: doctorProfessionalId,
      assignmentType: "ON_DUTY",
      reason: "Só este",
    });
    expect(none.allocatedCount).toBe(1);
    expect(none.createdSlotCount).toBe(0);
    const assigned = await assignedProfessionalIds([sourceNone, laterNone]);
    const byShift = new Map(
      assigned.map((row) => [row.shiftInstanceId, row.professionalId]),
    );
    expect(byShift.get(sourceNone)).toBe(doctorProfessionalId);
    expect(byShift.has(laterNone)).toBe(false);
  });

  it("abre a vaga da semana que falta em vez de pular", async () => {
    const sourceKey = tuesdayKeys[0];
    const gapKey = addDaysKey(sourceKey, 7);
    const keptKey = addDaysKey(sourceKey, 14);
    await insertShift({ dayKey: keptKey, label: "Manhã furo" });
    const sourceId = await insertShift({
      dayKey: sourceKey,
      label: "Manhã furo",
    });
    const before = (await institutionShiftIds()).length;

    const result = await caller().assignDirect({
      shiftInstanceId: sourceId,
      professionalId: doctorProfessionalId,
      assignmentType: "ON_DUTY",
      reason: "Semanal com furo",
      repeatRule: "weekly",
      repeatMonths: 1,
    });

    // O contrato antigo pulava a semana sem vaga. Agora a escala se abre.
    expect(result.createdSlotCount).toBeGreaterThan(0);
    const after = await institutionShiftIds();
    expect(after.length).toBe(before + result.createdSlotCount);

    const rows = await shiftsByLabel("Manhã furo");
    const gap = rows.find(
      (row) => row.startAt.toISOString().slice(0, 10) === gapKey,
    );
    expect(gap).toBeDefined();
    const gapAssigned = await assignedProfessionalIds([gap!.id]);
    expect(gapAssigned).toHaveLength(1);
    expect(gapAssigned[0].professionalId).toBe(doctorProfessionalId);
  });

  it("repetir além do mês abre a escala do mês seguinte", async () => {
    // Ancorado na última terça: daqui o horizonte de 1 mês cai inteiro no
    // mês seguinte, qualquer que seja o calendário em que o teste rodar.
    const sourceKey = tuesdayKeys[tuesdayKeys.length - 1];
    const expected = repeatDaysAhead(sourceKey, 1, 7);
    expect(expected.length).toBeGreaterThan(0);
    expect(
      expected.every((key) => key.slice(0, 7) !== sourceKey.slice(0, 7)),
    ).toBe(true);
    const targetMonth = expected[0].slice(0, 7);

    const rosterBefore = await db!
      .select({ id: monthlyRosters.id })
      .from(monthlyRosters)
      .where(
        and(
          eq(monthlyRosters.institutionId, institutionId),
          eq(monthlyRosters.yearMonth, targetMonth),
        ),
      );
    expect(rosterBefore).toHaveLength(0);

    const sourceId = await insertShift({
      dayKey: sourceKey,
      label: "Manhã travessia",
    });
    const result = await caller().assignDirect({
      shiftInstanceId: sourceId,
      professionalId: doctorProfessionalId,
      assignmentType: "ON_DUTY",
      reason: "Atravessar o mês",
      repeatRule: "weekly",
      repeatMonths: 1,
    });

    expect(result.createdSlotCount).toBe(expected.length);
    expect(result.allocatedCount).toBe(1 + expected.length);

    // "Abrir a escala" é isto: o roster do mês seguinte passa a existir.
    const rosterAfter = await db!
      .select({ status: monthlyRosters.status })
      .from(monthlyRosters)
      .where(
        and(
          eq(monthlyRosters.institutionId, institutionId),
          eq(monthlyRosters.yearMonth, targetMonth),
        ),
      );
    expect(rosterAfter).toHaveLength(1);
    expect(rosterAfter[0].status).toBe("DRAFT");

    const rows = await shiftsByLabel("Manhã travessia");
    const inTargetMonth = rows.filter(
      (row) => row.startAt.toISOString().slice(0, 7) === targetMonth,
    );
    expect(inTargetMonth).toHaveLength(expected.length);
  });

  it("o horizonte não vence a autoridade do gestor sobre a data", async () => {
    // A fixture é GESTOR_MEDICO: alcança o mês corrente e o seguinte.
    const sourceId = await insertShift({
      dayKey: tuesdayKeys[0],
      label: "Manhã longe",
    });
    await expect(
      caller().assignDirect({
        shiftInstanceId: sourceId,
        professionalId: doctorProfessionalId,
        assignmentType: "ON_DUTY",
        reason: "Repetir longe demais",
        repeatRule: "weekly",
        repeatMonths: 3,
      }),
    ).rejects.toThrow();
    const rows = await shiftsByLabel("Manhã longe");
    // Recusa é recusa: nada foi criado e nada foi alocado.
    expect(rows).toHaveLength(1);
    expect(await assignedProfessionalIds([sourceId])).toHaveLength(0);
  });

  it("bloqueia quando outro plantão com capacidade já ocupa a janela", async () => {
    const sourceKey = tuesdayKeys[0];
    const clashKey = addDaysKey(sourceKey, 7);
    const sourceId = await insertShift({
      dayKey: sourceKey,
      label: "Manhã bloqueio",
      requiredCapacity: 1,
    });
    await insertShift({
      dayKey: clashKey,
      label: "Outro serviço",
      requiredCapacity: 1,
    });

    await expect(
      caller().assignDirect({
        shiftInstanceId: sourceId,
        professionalId: doctorProfessionalId,
        assignmentType: "ON_DUTY",
        reason: "Repetir sobre outro plantão",
        repeatRule: "weekly",
        repeatMonths: 1,
      }),
    ).rejects.toThrow(/Já existe outro plantão neste horário/);
    expect(await shiftsByLabel("Manhã bloqueio")).toHaveLength(1);
    expect(await assignedProfessionalIds([sourceId])).toHaveLength(0);
  });
});

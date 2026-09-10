import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import {
  auditTrail,
  hospitals,
  institutions,
  medicalSpecialties,
  monthlyRosters,
  notifications,
  professionalAccess,
  professionalInstitutions,
  professionals,
  scheduleCapacityRules,
  scheduleContexts,
  sectors,
  shiftAssignmentsV2,
  shiftAuditLog,
  shiftInstances,
  shiftTemplates,
  users,
} from "../drizzle/schema";
import { getDb } from "../server/db";
import { appRouter } from "../server/routers";
import { getOrCreateShiftInstanceId } from "../server/helpers/getOrCreateShiftInstanceId";
import {
  addMonthsYearMonth,
  yearMonthBrt,
  weekdayOfKey,
} from "../server/local-time";

describe("capacity: one real shift with multiple places", () => {
  let db: NonNullable<Awaited<ReturnType<typeof getDb>>>;
  const sites: {
    institutionId: number;
    hospitalId: number;
    sectorId: number;
    scheduleContextId: number;
    templates: number[];
  }[] = [];
  const people: { userId: number; professionalId: number }[] = [];
  const month = addMonthsYearMonth(yearMonthBrt(new Date()), 2);
  const date = (day: number) => `${month}-${String(day).padStart(2, "0")}`;
  const caller = (person = 0, site = 0) =>
    appRouter.createCaller({
      user: {
        id: people[person].userId,
        role: person === 0 ? "manager" : "doctor",
        sessionVersion: 1,
      },
      institutionId: sites[site].institutionId,
      allowedInstitutionIds: sites.map((s) => s.institutionId),
    } as any);
  const create = (day: number, requiredCapacity = 2, template = 0) =>
    caller().shifts.create({
      date: date(day),
      shiftTemplateId: sites[0].templates[template],
      scheduleContextId: sites[0].scheduleContextId,
      requiredCapacity,
    });

  beforeAll(async () => {
    db = (await getDb())!;
    const stamp = Date.now();
    const [specialty] = await db.select().from(medicalSpecialties).limit(1);
    for (let index = 0; index < 2; index++) {
      const [institution] = await db
        .insert(institutions)
        .values({
          name: `Capacity ${stamp}-${index}`,
          cnpj: String(stamp + index).padStart(14, "0"),
          legalName: "Capacity test",
          tradeName: `CAP${index}`,
          isActive: true,
        })
        .$returningId();
      const [hospital] = await db
        .insert(hospitals)
        .values({ institutionId: institution.id, name: "Capacity hospital" })
        .$returningId();
      const [sector] = await db
        .insert(sectors)
        .values({
          institutionId: institution.id,
          hospitalId: hospital.id,
          name: "Capacity sector",
          category: "servico",
          color: "#2563EB",
        })
        .$returningId();
      const [context] = await db
        .insert(scheduleContexts)
        .values({
          institutionId: institution.id,
          hospitalId: hospital.id,
          sectorId: sector.id,
          admissionPolicy: "ALL_CFM_SPECIALTIES",
          active: true,
        })
        .$returningId();
      const templates = await db
        .insert(shiftTemplates)
        .values(
          [
            { name: "Manhã", startTime: "07:00:00", endTime: "13:00:00" },
            { name: "Tarde", startTime: "13:00:00", endTime: "19:00:00" },
            { name: "Noite", startTime: "19:00:00", endTime: "07:00:00" },
          ].map((row) => ({
            ...row,
            institutionId: institution.id,
            hospitalId: hospital.id,
            sectorId: sector.id,
          })),
        )
        .$returningId();
      sites.push({
        institutionId: institution.id,
        hospitalId: hospital.id,
        sectorId: sector.id,
        scheduleContextId: context.id,
        templates: templates.map((t) => t.id),
      });
    }
    for (let index = 0; index < 4; index++) {
      const [user] = await db
        .insert(users)
        .values({
          name: `Capacity person ${index}`,
          email: `capacity-${stamp}-${index}@test.local`,
          passwordHash: "test",
          approvalStatus: "APPROVED",
          role: index === 0 ? "manager" : "doctor",
        })
        .$returningId();
      const [professional] = await db
        .insert(professionals)
        .values({
          userId: user.id,
          name: `Capacity person ${index}`,
          role: index === 0 ? "Gestor" : "Médico",
          userRole: index === 0 ? "GESTOR_PLUS" : "USER",
          medicalSpecialtyId: specialty.id,
        })
        .$returningId();
      people.push({ userId: user.id, professionalId: professional.id });
      for (const site of sites) {
        await db.insert(professionalInstitutions).values({
          userId: user.id,
          professionalId: professional.id,
          institutionId: site.institutionId,
          roleInInstitution: index === 0 ? "GESTOR_PLUS" : "USER",
          active: true,
          isPrimary: site === sites[0],
        });
        await db.insert(professionalAccess).values({
          institutionId: site.institutionId,
          hospitalId: site.hospitalId,
          sectorId: site.sectorId,
          professionalId: professional.id,
          canAccess: true,
        });
      }
    }
    await db.insert(monthlyRosters).values({
      institutionId: sites[0].institutionId,
      hospitalId: sites[0].hospitalId,
      yearMonth: month,
      status: "DRAFT",
    });
  });

  afterAll(async () => {
    if (!db || !sites.length) return;
    const institutionIds = sites.map((s) => s.institutionId);
    const shifts = await db
      .select({ id: shiftInstances.id })
      .from(shiftInstances)
      .where(inArray(shiftInstances.institutionId, institutionIds));
    await db
      .delete(notifications)
      .where(inArray(notifications.institutionId, institutionIds));
    await db
      .delete(auditTrail)
      .where(inArray(auditTrail.institutionId, institutionIds));
    if (shifts.length) {
      const ids = shifts.map((s) => s.id);
      await db
        .delete(shiftAuditLog)
        .where(inArray(shiftAuditLog.shiftInstanceId, ids));
      await db
        .delete(shiftAssignmentsV2)
        .where(inArray(shiftAssignmentsV2.shiftInstanceId, ids));
      await db.delete(shiftInstances).where(inArray(shiftInstances.id, ids));
    }
    await db.delete(scheduleCapacityRules).where(
      inArray(
        scheduleCapacityRules.scheduleContextId,
        sites.map((s) => s.scheduleContextId),
      ),
    );
    await db
      .delete(shiftTemplates)
      .where(inArray(shiftTemplates.institutionId, institutionIds));
    await db
      .delete(scheduleContexts)
      .where(inArray(scheduleContexts.institutionId, institutionIds));
    await db
      .delete(professionalAccess)
      .where(inArray(professionalAccess.institutionId, institutionIds));
    await db
      .delete(professionalInstitutions)
      .where(inArray(professionalInstitutions.institutionId, institutionIds));
    await db
      .delete(monthlyRosters)
      .where(inArray(monthlyRosters.institutionId, institutionIds));
    await db
      .delete(sectors)
      .where(inArray(sectors.institutionId, institutionIds));
    await db
      .delete(hospitals)
      .where(inArray(hospitals.institutionId, institutionIds));
    await db
      .delete(institutions)
      .where(inArray(institutions.id, institutionIds));
    if (people.length) {
      await db.delete(professionals).where(
        inArray(
          professionals.id,
          people.map((p) => p.professionalId),
        ),
      );
      await db.delete(users).where(
        inArray(
          users.id,
          people.map((p) => p.userId),
        ),
      );
    }
  });

  it("persists weekly staffing per schedule and starts a new institution at one", async () => {
    const s = sites[0];
    await caller().scheduleCapacity.saveCapacityRule({
      scheduleContextId: s.scheduleContextId,
      shiftTemplateId: s.templates[0],
      capacities: [1, 3, 2, 2, 2, 2, 2],
    });
    await caller().scheduleCapacity.saveCapacityRule({
      scheduleContextId: s.scheduleContextId,
      shiftTemplateId: s.templates[1],
      capacities: [1, 2, 2, 2, 2, 2, 1],
    });
    await caller().scheduleCapacity.saveCapacityRule({
      scheduleContextId: s.scheduleContextId,
      shiftTemplateId: s.templates[2],
      capacities: [1, 2, 2, 2, 2, 2, 1],
    });
    const openedMonth = addMonthsYearMonth(month, 1);
    const result = await caller().shifts.openMonthShifts({
      ...s,
      yearMonth: openedMonth,
      mode: "all-applicable",
    });
    expect(result.created).toBeGreaterThan(0);
    const rows = await caller().shifts.listByPeriod({
      startDate: `${openedMonth}-01`,
      endDate: `${openedMonth}-28`,
      scheduleContextId: s.scheduleContextId,
    });
    expect(
      new Set(
        rows.map((r) => `${r.startAt.toISOString()}|${r.endAt.toISOString()}`),
      ).size,
    ).toBe(rows.length);
    for (const row of rows) {
      const localDate = new Date(row.startAt.getTime() - 3 * 3600000)
        .toISOString()
        .slice(0, 10);
      const weekday = weekdayOfKey(localDate);
      expect(row.requiredCapacity).toBe(
        row.label === "Manhã"
          ? [1, 3, 2, 2, 2, 2, 2][weekday]
          : [1, 2, 2, 2, 2, 2, 1][weekday],
      );
    }
    expect(
      (
        await caller().shifts.openMonthShifts({
          ...s,
          yearMonth: openedMonth,
          mode: "all-applicable",
        })
      ).created,
    ).toBe(0);
    const other = await caller(0, 1).shifts.create({
      date: date(1),
      shiftTemplateId: sites[1].templates[0],
      scheduleContextId: sites[1].scheduleContextId,
    });
    expect(other.requiredCapacity).toBe(1);
    await expect(
      caller(1).scheduleCapacity.saveCapacityRule({
        scheduleContextId: s.scheduleContextId,
        shiftTemplateId: s.templates[0],
        capacities: [1, 1, 1, 1, 1, 1, 1],
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      caller().scheduleCapacity.saveCapacityRule({
        scheduleContextId: sites[1].scheduleContextId,
        shiftTemplateId: s.templates[0],
        capacities: [1, 1, 1, 1, 1, 1, 1],
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("one occupied place does not hide the remaining vacancy; last-place race accepts one", async () => {
    const shift = await create(2);
    await caller().editor.assignDirect({
      shiftInstanceId: shift.id,
      professionalId: people[1].professionalId,
      assignmentType: "ON_DUTY",
    });
    await db
      .update(monthlyRosters)
      .set({ status: "PUBLISHED" })
      .where(
        and(
          eq(monthlyRosters.institutionId, sites[0].institutionId),
          eq(monthlyRosters.hospitalId, sites[0].hospitalId),
          eq(monthlyRosters.yearMonth, month),
        ),
      );
    const vacancies = await caller(2).shiftInstances.listVacancies({
      date: date(2),
    });
    expect(vacancies.find((v) => v.shiftInstanceId === shift.id)).toMatchObject(
      { requiredCapacity: 2, activeCount: 1, remainingCapacity: 1 },
    );
    const race = await Promise.allSettled([
      caller(2).shiftAssignments.assumeVacancy({ shiftInstanceId: shift.id }),
      caller(3).shiftAssignments.assumeVacancy({ shiftInstanceId: shift.id }),
    ]);
    await db
      .update(monthlyRosters)
      .set({ status: "DRAFT" })
      .where(
        and(
          eq(monthlyRosters.institutionId, sites[0].institutionId),
          eq(monthlyRosters.hospitalId, sites[0].hospitalId),
          eq(monthlyRosters.yearMonth, month),
        ),
      );
    expect(race.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(race.filter((r) => r.status === "rejected")).toHaveLength(1);
    const current = await caller().shifts.get({ id: shift.id });
    expect(current).toMatchObject({
      status: "OCUPADO",
      requiredCapacity: 2,
      activeCount: 2,
      remainingCapacity: 0,
    });
    await expect(
      caller().shifts.update({ id: shift.id, requiredCapacity: 1 }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await caller().shifts.get({ id: shift.id })).requiredCapacity).toBe(
      2,
    );
    const pending = current.assignments.find((a) => a.status === "PENDENTE")!;
    await caller().shiftInstances.rejectAssignment({
      assignmentId: pending.id,
      reason: "Capacity regression",
    });
    expect(
      (await caller().shifts.get({ id: shift.id })).remainingCapacity,
    ).toBe(1);
    const agenda = await caller().shifts.listAgenda({
      startDate: date(2),
      weeks: 1,
      scheduleContextId: sites[0].scheduleContextId,
    });
    const agendaShift = agenda.weeks
      .flatMap((w) => w.days.flatMap((d) => d.groups.flatMap((g) => g.shifts)))
      .find((row) => row.id === shift.id);
    expect(agendaShift).toMatchObject({
      activeCount: 1,
      requiredCapacity: 2,
      remainingCapacity: 1,
    });
  });

  it("direct allocation reserves multiple places and refuses overflow", async () => {
    const shift = await create(3, 3);
    for (const person of people.slice(1))
      await caller().editor.assignDirect({
        shiftInstanceId: shift.id,
        professionalId: person.professionalId,
        assignmentType: "ON_DUTY",
      });
    await expect(
      caller().editor.assignDirect({
        shiftInstanceId: shift.id,
        professionalId: people[0].professionalId,
        assignmentType: "ON_DUTY",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await caller().shifts.get({ id: shift.id })).activeCount).toBe(3);
    await caller().shifts.update({ id: shift.id, requiredCapacity: 4 });
    await caller().editor.assignDirect({
      shiftInstanceId: shift.id,
      professionalId: people[0].professionalId,
      assignmentType: "ON_DUTY",
    });
    expect((await caller().shifts.get({ id: shift.id })).activeCount).toBe(4);
  });

  it("label and modality cannot create a second instance of the same block", async () => {
    const shift = await create(4);
    await expect(
      caller().shifts.create({
        date: date(4),
        shiftTemplateId: sites[0].templates[0],
        scheduleContextId: sites[0].scheduleContextId,
        modality: "SOBREAVISO",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      db.insert(shiftInstances).values({
        ...sites[0],
        label: "Segundo médico",
        startAt: shift.startAt,
        endAt: shift.endAt,
      }),
    ).rejects.toThrow();
    const id = await db.transaction((tx) =>
      getOrCreateShiftInstanceId(tx, {
        ...sites[0],
        label: "Outro rótulo",
        startAt: shift.startAt,
        endAt: shift.endAt,
        createdBy: people[0].userId,
      }),
    );
    expect(id).toBe(shift.id);
    const distinct = await db
      .insert(shiftInstances)
      .values({
        ...sites[0],
        label: "Bloco curto legítimo",
        startAt: shift.startAt,
        endAt: new Date(shift.endAt.getTime() - 3600000),
      })
      .$returningId();
    expect(distinct[0].id).not.toBe(shift.id);
  });

  it("capacity changes do not rewrite older turns and zero is rejected", async () => {
    const shift = await create(5, 3);
    await caller().scheduleCapacity.saveCapacityRule({
      scheduleContextId: sites[0].scheduleContextId,
      shiftTemplateId: sites[0].templates[0],
      capacities: [4, 4, 4, 4, 4, 4, 4],
    });
    expect((await caller().shifts.get({ id: shift.id })).requiredCapacity).toBe(
      3,
    );
    await expect(create(6, 0)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const next = await caller().shifts.create({
      date: date(6),
      shiftTemplateId: sites[0].templates[0],
      scheduleContextId: sites[0].scheduleContextId,
    });
    expect(next.requiredCapacity).toBe(4);
    expect(
      await db
        .select()
        .from(shiftInstances)
        .where(
          and(
            eq(shiftInstances.institutionId, sites[0].institutionId),
            eq(shiftInstances.id, next.id),
          ),
        ),
    ).toHaveLength(1);
  });

  it("repeated allocation uses remaining places and skips doctors already assigned", async () => {
    const source = await create(8);
    const partial = await create(15);
    const sameDoctor = await create(22);
    await caller().editor.assignDirect({
      shiftInstanceId: partial.id,
      professionalId: people[2].professionalId,
      assignmentType: "ON_DUTY",
    });
    await caller().editor.assignDirect({
      shiftInstanceId: sameDoctor.id,
      professionalId: people[1].professionalId,
      assignmentType: "ON_DUTY",
    });
    const repeated = await caller().editor.assignDirect({
      shiftInstanceId: source.id,
      professionalId: people[1].professionalId,
      assignmentType: "ON_DUTY",
      repeatRule: "weekly",
    });
    expect(repeated.allocatedCount).toBe(2);
    expect(repeated.skippedOccupiedCount).toBe(1);
    expect(await caller().shifts.get({ id: partial.id })).toMatchObject({
      requiredCapacity: 2,
      activeCount: 2,
      remainingCapacity: 0,
    });
    expect(await caller().shifts.get({ id: sameDoctor.id })).toMatchObject({
      requiredCapacity: 2,
      activeCount: 1,
      remainingCapacity: 1,
    });
  });

  it("copy preserves explicit capacity, applies destination weekly rules, and rolls back over-capacity copies", async () => {
    const s = sites[0];
    const sourceMonth = addMonthsYearMonth(month, 3);
    const targetMonth = addMonthsYearMonth(month, 4);
    const source = await caller().shifts.create({
      date: `${sourceMonth}-01`,
      scheduleContextId: s.scheduleContextId,
      shiftTemplateId: s.templates[1],
      requiredCapacity: 3,
    });
    for (const person of people.slice(1, 4))
      await caller().editor.assignDirect({
        shiftInstanceId: source.id,
        professionalId: person.professionalId,
        assignmentType: "ON_DUTY",
      });
    const copy = {
      hospitalId: s.hospitalId,
      sectorId: s.sectorId,
      from: { start: `${sourceMonth}-01`, granularity: "month" as const },
      to: { start: `${targetMonth}-01` },
      includeAssignments: true,
    };
    // The destination rule has only two afternoon places, so all writes roll back.
    await expect(caller().shifts.replicateRange(copy)).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(
      await caller().shifts.listByPeriod({
        startDate: `${targetMonth}-01`,
        endDate: `${targetMonth}-28`,
        scheduleContextId: s.scheduleContextId,
      }),
    ).toHaveLength(0);
    await caller().scheduleCapacity.saveCapacityRule({
      scheduleContextId: s.scheduleContextId,
      shiftTemplateId: s.templates[1],
      capacities: [3, 3, 3, 3, 3, 3, 3],
    });
    await caller().shifts.replicateRange(copy);
    const [copied] = await caller().shifts.listByPeriod({
      startDate: `${targetMonth}-01`,
      endDate: `${targetMonth}-28`,
      scheduleContextId: s.scheduleContextId,
    });
    expect(copied).toMatchObject({
      requiredCapacity: 3,
      activeCount: 3,
      remainingCapacity: 0,
    });
    const calendarMonth = addMonthsYearMonth(month, 5);
    await caller().shifts.replicateMonthCalendar({
      ...s,
      sourceMonth,
      targetMonth: calendarMonth,
      rule: "FULL",
    });
    const calendar = await caller().shifts.listByPeriod({
      startDate: `${calendarMonth}-01`,
      endDate: `${calendarMonth}-28`,
      scheduleContextId: s.scheduleContextId,
    });
    expect(calendar.length).toBeGreaterThan(0);
    expect(
      calendar.every(
        (row) => row.requiredCapacity === 3 && row.activeCount === 0,
      ),
    ).toBe(true);
  });

  it("concurrent imports reuse one block and the day reader retains doctors of the same type", async () => {
    const args = {
      ...sites[0],
      label: "Importado",
      startAt: new Date(`${date(7)}T07:00:00-03:00`),
      endAt: new Date(`${date(7)}T13:00:00-03:00`),
      requiredCapacity: 2,
      createdBy: people[0].userId,
    };
    const ids = await Promise.all([
      db.transaction((tx) => getOrCreateShiftInstanceId(tx, args)),
      db.transaction((tx) =>
        getOrCreateShiftInstanceId(tx, {
          ...args,
          label: "Rótulo alternativo",
        }),
      ),
    ]);
    expect(ids[0]).toBe(ids[1]);
    for (const person of people.slice(1, 3))
      await caller().editor.assignDirect({
        shiftInstanceId: ids[0],
        professionalId: person.professionalId,
        assignmentType: "ON_DUTY",
      });
    const day = await caller().calendar.getDay({ ...sites[0], date: date(7) });
    const slot = day.shifts.find((row) => row.shiftInstanceId === ids[0])!;
    expect(slot).toMatchObject({
      activeCount: 2,
      remainingCapacity: 0,
      requiredCapacity: 2,
    });
    expect(slot.slots).toHaveLength(2);
    expect(slot.slots.every((row) => row.assignmentType === "ON_DUTY")).toBe(
      true,
    );
  });
});

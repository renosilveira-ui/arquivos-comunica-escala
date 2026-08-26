// tests/dia-local-servidor.test.ts — auditoria 22/08, achado M6.
//
// O servidor roda em UTC. Um plantão que começa às 22:00 no Brasil
// (= 01:00Z do dia seguinte) pertence ao DIA em que começou no relógio do
// hospital — em toda consulta por dia: vagas, solicitações, contadores,
// calendário e agenda. Antes, janelas `T00:00:00` sem offset e
// `toISOString()` jogavam esse plantão para o dia seguinte (e, no
// calendário, abriam espaço para turnos duplicados).

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import {
  hospitals,
  institutions,
  managerScope,
  professionalAccess,
  professionalInstitutions,
  professionals,
  scheduleContexts,
  sectors,
  shiftAssignmentsV2,
  shiftInstances,
  users,
} from "../drizzle/schema";
import {
  ensureTestAnesthesiaSpecialty,
  openTestScale,
} from "./helpers/open-test-scale";
import { calendarRouter } from "../server/calendar";
import { getDb } from "../server/db";
import { addDaysToKey, dayKeyBrt, dayWindowBrt, mondayOfKey, monthWindowBrt, weekdayOfKey, yearMonthBrt } from "../server/local-time";
import { appRouter } from "../server/routers";
import { shiftsRouter } from "../server/shifts-crud";

describe("local-time: helpers puros", () => {
  it("chave de dia/mês no relógio do hospital", () => {
    // 2026-09-10 22:00 -03:00 = 2026-09-11T01:00Z
    const d = new Date("2026-09-11T01:00:00.000Z");
    expect(dayKeyBrt(d)).toBe("2026-09-10");
    expect(yearMonthBrt(d)).toBe("2026-09");
    // virada de mês: 2026-08-31 23:30 -03:00 = 2026-09-01T02:30Z
    expect(yearMonthBrt(new Date("2026-09-01T02:30:00.000Z"))).toBe("2026-08");
  });
  it("janelas de dia e mês com fim exclusivo", () => {
    const day = dayWindowBrt("2026-09-10");
    expect(day.start.toISOString()).toBe("2026-09-10T03:00:00.000Z");
    expect(day.end.toISOString()).toBe("2026-09-11T03:00:00.000Z");
    const month = monthWindowBrt("2026-12");
    expect(month.start.toISOString()).toBe("2026-12-01T03:00:00.000Z");
    expect(month.end.toISOString()).toBe("2027-01-01T03:00:00.000Z");
  });
  it("aritmética de chaves", () => {
    expect(addDaysToKey("2026-08-31", 1)).toBe("2026-09-01");
    expect(addDaysToKey("2026-03-01", -1)).toBe("2026-02-28");
    expect(weekdayOfKey("2026-08-23")).toBe(0); // domingo
    expect(mondayOfKey("2026-08-23")).toBe("2026-08-17");
    expect(mondayOfKey("2026-08-17")).toBe("2026-08-17");
  });
});

describe("consultas por dia usam o dia do hospital", () => {
  let db: NonNullable<Awaited<ReturnType<typeof getDb>>>;
  let institutionId: number;
  let hospitalId: number;
  let sectorId: number;
  let scheduleContextId: number;
  let anesthesiaId: number;
  let managerUserId: number;
  let managerProId: number;
  let doctorUserId: number;
  let doctorProId: number;
  let lateShiftId: number;
  const stamp = Date.now();

  // Dia D = 20 do mês que vem (evita colisão com outros fixtures); plantão
  // "Cinderela" 22:00–04:00 no relógio do hospital.
  const base = new Date();
  const D = (() => {
    const y = base.getMonth() + 1 === 12 ? base.getFullYear() + 1 : base.getFullYear();
    const m = base.getMonth() + 1 === 12 ? 1 : base.getMonth() + 2;
    return `${y}-${String(m).padStart(2, "0")}-20`;
  })();
  const lateStart = new Date(`${D}T22:00:00-03:00`);
  const lateEnd = new Date(`${D}T22:00:00-03:00`);
  lateEnd.setUTCHours(lateEnd.getUTCHours() + 6);

  const ctx = (userId: number, role: "manager" | "doctor") =>
    ({ user: { id: userId, role, name: "T", email: `${userId}@t.local`, sessionVersion: 1 }, institutionId, allowedInstitutionIds: [institutionId] }) as any;

  beforeAll(async () => {
    const conn = await getDb();
    if (!conn) throw new Error("Database not available");
    db = conn;
    const [inst] = await db
      .insert(institutions)
      .values({ name: `DL Tenant ${stamp}`, cnpj: `${stamp}`.slice(-14).padStart(14, "0"), legalName: `DL ${stamp}`, tradeName: `DL${stamp}`.slice(0, 20), isActive: true })
      .$returningId();
    institutionId = inst.id;
    const [h] = await db.insert(hospitals).values({ institutionId, name: `DL Hospital ${stamp}` }).$returningId();
    hospitalId = h.id;
    const [sec] = await db.insert(sectors).values({ institutionId, hospitalId, name: `DL Setor ${stamp}`, category: "cirurgico", color: "#2563EB" }).$returningId();
    sectorId = sec.id;
    anesthesiaId = await ensureTestAnesthesiaSpecialty(db);
    scheduleContextId = await openTestScale(db, { institutionId, hospitalId, sectorId });
    const person = async (tag: string, role: "manager" | "doctor", link: "GESTOR_PLUS" | "USER") => {
      const [u] = await db.insert(users).values({ name: `DL ${tag} ${stamp}`, email: `dl-${tag}-${stamp}@test.local`, passwordHash: "test", role }).$returningId();
      const [p] = await db.insert(professionals).values({ userId: u.id, name: `DL ${tag} ${stamp}`, role: "Médico", userRole: link, medicalSpecialtyId: anesthesiaId, specialty: "Anestesiologia" }).$returningId();
      await db.insert(professionalInstitutions).values({ professionalId: p.id, userId: u.id, institutionId, roleInInstitution: link, isPrimary: true, active: true });
      await db.insert(professionalAccess).values({ institutionId, professionalId: p.id, hospitalId, sectorId, canAccess: true });
      return { userId: u.id, proId: p.id };
    };
    const m = await person("gestor", "manager", "GESTOR_PLUS");
    managerUserId = m.userId;
    managerProId = m.proId;
    const d = await person("medico", "doctor", "USER");
    doctorUserId = d.userId;
    doctorProId = d.proId;

    const [s] = await db
      .insert(shiftInstances)
      .values({ institutionId, hospitalId, sectorId, scheduleContextId, label: "Cinderela", startAt: lateStart, endAt: lateEnd, status: "VAGO" })
      .$returningId();
    lateShiftId = s.id;
  });

  afterAll(async () => {
    const mine = await db.select({ id: shiftInstances.id }).from(shiftInstances).where(eq(shiftInstances.institutionId, institutionId));
    const ids = mine.map((s) => s.id);
    if (ids.length) {
      await db.delete(shiftAssignmentsV2).where(inArray(shiftAssignmentsV2.shiftInstanceId, ids));
      await db.delete(shiftInstances).where(inArray(shiftInstances.id, ids));
    }
    const pros = [managerProId, doctorProId];
    await db.delete(professionalAccess).where(inArray(professionalAccess.professionalId, pros));
    await db.delete(managerScope).where(inArray(managerScope.managerProfessionalId, pros));
    await db.delete(professionalInstitutions).where(inArray(professionalInstitutions.professionalId, pros));
    await db.delete(professionals).where(inArray(professionals.id, pros));
    await db.delete(scheduleContexts).where(eq(scheduleContexts.id, scheduleContextId));
    await db.delete(sectors).where(eq(sectors.id, sectorId));
    await db.delete(hospitals).where(eq(hospitals.id, hospitalId));
    await db.delete(institutions).where(eq(institutions.id, institutionId));
    await db.delete(users).where(inArray(users.id, [managerUserId, doctorUserId]));
  });

  it("listVacancies e summaryCounts: plantão das 22h é do dia D, não de D+1", async () => {
    const app = appRouter.createCaller(ctx(doctorUserId, "doctor"));
    const onD = await app.shiftInstances.listVacancies({ date: D });
    const onD1 = await app.shiftInstances.listVacancies({ date: addDaysToKey(D, 1) });
    expect(onD.map((v: any) => v.id ?? v.shiftInstanceId)).toContain(lateShiftId);
    expect(onD1.map((v: any) => v.id ?? v.shiftInstanceId)).not.toContain(lateShiftId);

    const cD = await app.filters.summaryCounts({ date: D });
    const cD1 = await app.filters.summaryCounts({ date: addDaysToKey(D, 1) });
    expect(cD.vacanciesByHospital[hospitalId] ?? 0).toBe(1);
    expect(cD1.vacanciesByHospital[hospitalId] ?? 0).toBe(0);
  });

  it("calendar.getDay(D) encontra o plantão e NÃO auto-cria turnos", async () => {
    const cal = calendarRouter.createCaller(ctx(managerUserId, "manager"));
    const day = await cal.getDay({ institutionId, hospitalId, sectorId, date: D });
    expect(day.shifts.map((s) => s.shiftInstanceId)).toEqual([lateShiftId]);
    const all = await db.select({ id: shiftInstances.id }).from(shiftInstances).where(eq(shiftInstances.institutionId, institutionId));
    expect(all).toHaveLength(1);
  });

  it("listAgenda coloca o plantão no dia D, com a semana iniciando na segunda", async () => {
    const shifts = shiftsRouter.createCaller(ctx(doctorUserId, "doctor"));
    const monday = mondayOfKey(D);
    const selectSpy = vi.spyOn(db, "select");
    const res = await (async () => {
      try {
        const result = await shifts.listAgenda({ startDate: monday, weeks: 1, scope: "geral" });
        expect(selectSpy.mock.calls.length).toBeLessThan(10);
        return result;
      } finally {
        selectSpy.mockRestore();
      }
    })();
    expect(res.weeks).toHaveLength(1);
    expect(res.weeks[0].weekStart).toBe(monday);
    const day = res.weeks[0].days.find((d) => d.date === D)!;
    expect(day).toBeTruthy();
    expect(day.dow).toBe(weekdayOfKey(D));
    expect(day.groups.flatMap((g) => g.shifts.map((s) => s.id))).toEqual([lateShiftId]);
    const next = res.weeks[0].days.find((d) => d.date === addDaysToKey(D, 1));
    expect(next?.groups ?? []).toHaveLength(0);
  });
});

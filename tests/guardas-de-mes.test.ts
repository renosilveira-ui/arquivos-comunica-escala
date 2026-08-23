// tests/guardas-de-mes.test.ts — auditoria 22/08, achados M1, M2 (mês) e M10.
//
// Todo ponto de escrita respeita a janela do mês corrente (GESTOR_MEDICO) e
// o estado PUBLISHED/LOCKED do roster — inclusive a auto-criação do
// calendário, o assumir-vaga e a lista de vagas.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, inArray, like } from "drizzle-orm";
import {
  auditTrail,
  hospitals,
  institutions,
  managerScope,
  monthlyRosters,
  professionalAccess,
  professionalInstitutions,
  professionals,
  sectors,
  shiftAssignmentsV2,
  shiftAuditLog,
  shiftInstances,
  shiftTemplates,
  users,
} from "../drizzle/schema";
import { calendarRouter } from "../server/calendar";
import { getDb } from "../server/db";
import { dayKeyBrt, yearMonthBrt } from "../server/local-time";
import { appRouter } from "../server/routers";
import { shiftsRouter } from "../server/shifts-crud";

describe("guardas de mês em todos os pontos de escrita", () => {
  let db: NonNullable<Awaited<ReturnType<typeof getDb>>>;
  let institutionId: number;
  let hospitalId: number;
  let sectorId: number;
  let templateId: number;
  let medicoUserId: number;
  let medicoProId: number;
  let plusUserId: number;
  let plusProId: number;
  let doctorUserId: number;
  let doctorProId: number;
  const stamp = Date.now();

  // Hoje 07:00 e dia 10 do mês que vem 07:00 — no relógio do HOSPITAL
  // (-03:00), não no fuso do processo (CI roda em UTC).
  const todayKey = dayKeyBrt(new Date());
  const currentStart = new Date(`${todayKey}T07:00:00-03:00`);
  const currentYm = todayKey.slice(0, 7);
  const nextYm = (() => {
    const [y, m] = currentYm.split("-").map(Number);
    return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
  })();
  const nextMonthStart = new Date(`${nextYm}-10T07:00:00-03:00`);

  const ctxFor = (userId: number, role: "manager" | "doctor") =>
    ({ user: { id: userId, role, name: "T", email: `${userId}@test.local` }, institutionId, allowedInstitutionIds: [institutionId] }) as any;
  const asMedico = () => shiftsRouter.createCaller(ctxFor(medicoUserId, "manager"));
  const asPlus = () => shiftsRouter.createCaller(ctxFor(plusUserId, "manager"));
  const calendarAs = (userId: number) => calendarRouter.createCaller(ctxFor(userId, "manager"));
  const asDoctor = () => appRouter.createCaller(ctxFor(doctorUserId, "doctor"));

  async function setRoster(ym: string, status: "DRAFT" | "PUBLISHED" | "LOCKED" | null) {
    await db.delete(monthlyRosters).where(and(eq(monthlyRosters.institutionId, institutionId), eq(monthlyRosters.hospitalId, hospitalId), eq(monthlyRosters.yearMonth, ym)));
    if (status) await db.insert(monthlyRosters).values({ institutionId, hospitalId, yearMonth: ym, status });
  }

  async function insertShift(startAt: Date, label: string) {
    const endAt = new Date(startAt.getTime() + 6 * 60 * 60 * 1000);
    const [s] = await db
      .insert(shiftInstances)
      .values({ institutionId, hospitalId, sectorId, label: `gm-${stamp}-${label}`, startAt, endAt, status: "VAGO" })
      .$returningId();
    return s.id;
  }

  async function shiftsOfDay(dayKey: string) {
    const all = await db.select({ id: shiftInstances.id, startAt: shiftInstances.startAt }).from(shiftInstances).where(and(eq(shiftInstances.institutionId, institutionId), eq(shiftInstances.sectorId, sectorId)));
    return all.filter((s) => dayKeyBrt(s.startAt) === dayKey);
  }

  beforeAll(async () => {
    const conn = await getDb();
    if (!conn) throw new Error("Database not available");
    db = conn;

    const [inst] = await db
      .insert(institutions)
      .values({ name: `GM Tenant ${stamp}`, cnpj: `${stamp}`.slice(-14).padStart(14, "0"), legalName: `GM ${stamp}`, tradeName: `GM${stamp}`.slice(0, 20), isActive: true })
      .$returningId();
    institutionId = inst.id;
    const [h] = await db.insert(hospitals).values({ institutionId, name: `GM Hospital ${stamp}` }).$returningId();
    hospitalId = h.id;
    const [sec] = await db.insert(sectors).values({ institutionId, hospitalId, name: `GM Setor ${stamp}`, category: "cirurgico", color: "#2563EB" }).$returningId();
    sectorId = sec.id;
    const [t] = await db.insert(shiftTemplates).values({ institutionId, hospitalId, sectorId, name: "Manhã", startTime: "07:00:00", endTime: "13:00:00" }).$returningId();
    templateId = t.id;

    async function person(tag: string, role: "manager" | "doctor", link: "GESTOR_MEDICO" | "GESTOR_PLUS" | "USER") {
      const [u] = await db.insert(users).values({ name: `GM ${tag} ${stamp}`, email: `gm-${tag}-${stamp}@test.local`, passwordHash: "test", role }).$returningId();
      const [p] = await db.insert(professionals).values({ userId: u.id, name: `GM ${tag} ${stamp}`, role: "Médico", userRole: link }).$returningId();
      await db.insert(professionalInstitutions).values({ professionalId: p.id, userId: u.id, institutionId, roleInInstitution: link, isPrimary: true, active: true });
      await db.insert(professionalAccess).values({ institutionId, professionalId: p.id, hospitalId, sectorId, canAccess: true });
      return { userId: u.id, proId: p.id };
    }
    const medico = await person("medico", "manager", "GESTOR_MEDICO");
    medicoUserId = medico.userId;
    medicoProId = medico.proId;
    await db.insert(managerScope).values({ institutionId, managerProfessionalId: medicoProId, hospitalId, sectorId, active: true });
    const plus = await person("plus", "manager", "GESTOR_PLUS");
    plusUserId = plus.userId;
    plusProId = plus.proId;
    const doc = await person("doctor", "doctor", "USER");
    doctorUserId = doc.userId;
    doctorProId = doc.proId;
  });

  beforeEach(async () => {
    const mine = await db.select({ id: shiftInstances.id }).from(shiftInstances).where(eq(shiftInstances.institutionId, institutionId));
    const ids = mine.map((s) => s.id);
    if (ids.length) {
      await db.delete(auditTrail).where(inArray(auditTrail.shiftInstanceId, ids));
      await db.delete(shiftAuditLog).where(inArray(shiftAuditLog.shiftInstanceId, ids));
      await db.delete(shiftAssignmentsV2).where(inArray(shiftAssignmentsV2.shiftInstanceId, ids));
      await db.delete(shiftInstances).where(inArray(shiftInstances.id, ids));
    }
    await setRoster(currentYm, null);
    await setRoster(nextYm, null);
  });

  afterAll(async () => {
    const mine = await db.select({ id: shiftInstances.id }).from(shiftInstances).where(eq(shiftInstances.institutionId, institutionId));
    const ids = mine.map((s) => s.id);
    if (ids.length) {
      await db.delete(auditTrail).where(inArray(auditTrail.shiftInstanceId, ids));
      await db.delete(shiftAuditLog).where(inArray(shiftAuditLog.shiftInstanceId, ids));
      await db.delete(shiftAssignmentsV2).where(inArray(shiftAssignmentsV2.shiftInstanceId, ids));
      await db.delete(shiftInstances).where(inArray(shiftInstances.id, ids));
    }
    await db.delete(shiftAuditLog).where(like(shiftAuditLog.reason, "[PUBLISHED_MONTH_OVERRIDE]%"));
    await db.delete(auditTrail).where(eq(auditTrail.institutionId, institutionId)); // override auditado
    await db.delete(monthlyRosters).where(eq(monthlyRosters.institutionId, institutionId));
    await db.delete(shiftTemplates).where(eq(shiftTemplates.id, templateId));
    const pros = [medicoProId, plusProId, doctorProId];
    await db.delete(professionalAccess).where(inArray(professionalAccess.professionalId, pros));
    await db.delete(managerScope).where(eq(managerScope.managerProfessionalId, medicoProId));
    await db.delete(professionalInstitutions).where(inArray(professionalInstitutions.professionalId, pros));
    await db.delete(professionals).where(inArray(professionals.id, pros));
    await db.delete(sectors).where(eq(sectors.id, sectorId));
    await db.delete(hospitals).where(eq(hospitals.id, hospitalId));
    await db.delete(institutions).where(eq(institutions.id, institutionId));
    await db.delete(users).where(inArray(users.id, [medicoUserId, plusUserId, doctorUserId]));
  });

  it("M10: mês LOCKED — vaga some da lista e assumir é barrado", async () => {
    const locked = await insertShift(nextMonthStart, "locked");
    const open = await insertShift(currentStart, "open");
    await setRoster(nextYm, "LOCKED");

    const list = await asDoctor().shiftInstances.listVacancies({});
    const ids = list.map((v: any) => v.id ?? v.shiftInstanceId);
    expect(ids).toContain(open);
    expect(ids).not.toContain(locked);

    await expect(asDoctor().shiftAssignments.assumeVacancy({ shiftInstanceId: locked, assignmentType: "ON_DUTY" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const [row] = await db.select({ status: shiftInstances.status }).from(shiftInstances).where(eq(shiftInstances.id, locked));
    expect(row.status).toBe("VAGO");
  });

  it("M2: GESTOR_MEDICO não puxa turno de outro mês para o corrente", async () => {
    const future = await insertShift(nextMonthStart, "future");
    await expect(asMedico().update({ id: future, startAt: currentStart.toISOString() })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const [row] = await db.select({ startAt: shiftInstances.startAt }).from(shiftInstances).where(eq(shiftInstances.id, future));
    expect(yearMonthBrt(row.startAt)).toBe(nextYm);
  });

  it("M2: mês PUBLISHED — GESTOR_MEDICO não cria; Gestor+ só com motivo", async () => {
    await setRoster(currentYm, "PUBLISHED");
    const date = dayKeyBrt(currentStart);
    await expect(asMedico().create({ date, shiftTemplateId: templateId })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(asPlus().create({ date, shiftTemplateId: templateId })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const created = await asPlus().create({ date, shiftTemplateId: templateId, reason: "Cobertura extra aprovada" });
    expect(created).toBeTruthy();
    expect(await shiftsOfDay(date)).toHaveLength(1);
  });

  it("M1: abrir dia vazio de mês futuro (GESTOR_MEDICO) ou trancado não cria turnos; DRAFT no mês corrente cria", async () => {
    const nextDay = dayKeyBrt(nextMonthStart);
    const r1 = await calendarAs(medicoUserId).getDay({ institutionId, hospitalId, sectorId, date: nextDay });
    expect(r1.shifts).toHaveLength(0);
    expect(await shiftsOfDay(nextDay)).toHaveLength(0);

    await setRoster(nextYm, "LOCKED");
    const r2 = await calendarAs(plusUserId).getDay({ institutionId, hospitalId, sectorId, date: nextDay });
    expect(r2.shifts).toHaveLength(0);
    expect(await shiftsOfDay(nextDay)).toHaveLength(0);

    const todayKey = dayKeyBrt(currentStart);
    const r3 = await calendarAs(medicoUserId).getDay({ institutionId, hospitalId, sectorId, date: todayKey });
    expect(r3.shifts).toHaveLength(3);
    expect(await shiftsOfDay(todayKey)).toHaveLength(3);
  });
});

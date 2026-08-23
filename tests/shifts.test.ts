// tests/shifts.test.ts — CRUD básico de turnos via shiftsRouter
// (substitui o placeholder `describe.skip` deixado após truncamento do arquivo).
//
//   create (a partir de template, horário de parede -03:00) → get → update
//   (horários e modalidade) → listByPeriod enxerga o turno → USER comum não
//   cria nem edita.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import {
  auditTrail,
  hospitals,
  institutions,
  professionalAccess,
  professionalInstitutions,
  professionals,
  sectors,
  shiftAuditLog,
  shiftInstances,
  shiftTemplates,
  users,
} from "../drizzle/schema";
import { getDb } from "../server/db";
import { addDaysToKey, dayKeyBrt } from "../server/local-time";
import { shiftsRouter } from "../server/shifts-crud";

describe("shifts: create / get / update / listByPeriod", () => {
  let db: NonNullable<Awaited<ReturnType<typeof getDb>>>;
  const stamp = Date.now();
  let institutionId: number;
  let hospitalId: number;
  let sectorId: number;
  let templateId: number;
  let managerUserId: number;
  let managerProId: number;
  let doctorUserId: number;
  let doctorProId: number;
  const day = dayKeyBrt(new Date()); // hoje (mês corrente)

  const ctx = (userId: number, role: "manager" | "doctor") =>
    ({ user: { id: userId, role, name: "T", email: `${userId}@t.local` }, institutionId, allowedInstitutionIds: [institutionId] }) as any;
  const asManager = () => shiftsRouter.createCaller(ctx(managerUserId, "manager"));
  const asDoctor = () => shiftsRouter.createCaller(ctx(doctorUserId, "doctor"));

  beforeAll(async () => {
    const conn = await getDb();
    if (!conn) throw new Error("Database not available");
    db = conn;
    const [inst] = await db
      .insert(institutions)
      .values({ name: `Shifts Tenant ${stamp}`, cnpj: `${stamp}5`.slice(-14).padStart(14, "0"), legalName: `Shifts ${stamp}`, tradeName: `SH${stamp}`.slice(0, 20), isActive: true })
      .$returningId();
    institutionId = inst.id;
    const [h] = await db.insert(hospitals).values({ institutionId, name: `Shifts Hospital ${stamp}` }).$returningId();
    hospitalId = h.id;
    const [sec] = await db.insert(sectors).values({ institutionId, hospitalId, name: `Shifts Setor ${stamp}`, category: "cirurgico", color: "#2563EB" }).$returningId();
    sectorId = sec.id;
    const [t] = await db.insert(shiftTemplates).values({ institutionId, hospitalId, sectorId, name: "Noite", startTime: "19:00:00", endTime: "07:00:00" }).$returningId();
    templateId = t.id;
    const person = async (tag: string, role: "manager" | "doctor", link: "GESTOR_PLUS" | "USER") => {
      const [u] = await db.insert(users).values({ name: `Shifts ${tag} ${stamp}`, email: `shifts-${tag}-${stamp}@test.local`, passwordHash: "test", role }).$returningId();
      const [p] = await db.insert(professionals).values({ userId: u.id, name: `Shifts ${tag} ${stamp}`, role: "Médico", userRole: link }).$returningId();
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
  });

  afterAll(async () => {
    const mine = await db.select({ id: shiftInstances.id }).from(shiftInstances).where(eq(shiftInstances.institutionId, institutionId));
    const ids = mine.map((s) => s.id);
    if (ids.length) {
      await db.delete(auditTrail).where(inArray(auditTrail.shiftInstanceId, ids));
      await db.delete(shiftAuditLog).where(inArray(shiftAuditLog.shiftInstanceId, ids));
      await db.delete(shiftInstances).where(inArray(shiftInstances.id, ids));
    }
    await db.delete(auditTrail).where(eq(auditTrail.institutionId, institutionId));
    await db.delete(shiftTemplates).where(eq(shiftTemplates.id, templateId));
    await db.delete(professionalAccess).where(inArray(professionalAccess.professionalId, [managerProId, doctorProId]));
    await db.delete(professionalInstitutions).where(inArray(professionalInstitutions.professionalId, [managerProId, doctorProId]));
    await db.delete(professionals).where(inArray(professionals.id, [managerProId, doctorProId]));
    await db.delete(sectors).where(eq(sectors.id, sectorId));
    await db.delete(hospitals).where(eq(hospitals.id, hospitalId));
    await db.delete(institutions).where(eq(institutions.id, institutionId));
    await db.delete(users).where(inArray(users.id, [managerUserId, doctorUserId]));
  });

  it("create a partir do template grava instante UTC do horário de parede (-03:00) e turno noturno vira o dia", async () => {
    const created = await asManager().create({ date: day, shiftTemplateId: templateId });
    expect(created).toBeTruthy();
    expect(created!.label).toBe("Noite");
    expect(created!.status).toBe("VAGO");
    expect(created!.startAt.toISOString()).toBe(new Date(`${day}T19:00:00-03:00`).toISOString());
    expect(created!.endAt.toISOString()).toBe(new Date(`${addDaysToKey(day, 1)}T07:00:00-03:00`).toISOString());
    expect(dayKeyBrt(created!.startAt)).toBe(day);
  });

  it("get devolve o turno com setor/hospital; turno de outro tenant → NOT_FOUND", async () => {
    const [row] = await db.select({ id: shiftInstances.id }).from(shiftInstances).where(eq(shiftInstances.institutionId, institutionId));
    const got = await asManager().get({ id: row.id });
    expect(got).toMatchObject({ id: row.id, label: "Noite" });
    const other = shiftsRouter.createCaller({ ...ctx(managerUserId, "manager"), institutionId: institutionId + 1000, allowedInstitutionIds: [institutionId + 1000] });
    await expect(other.get({ id: row.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("update muda horários/modalidade e listByPeriod enxerga o turno no dia", async () => {
    const [row] = await db.select({ id: shiftInstances.id }).from(shiftInstances).where(eq(shiftInstances.institutionId, institutionId));
    const newStart = new Date(`${day}T20:00:00-03:00`);
    const newEnd = new Date(`${addDaysToKey(day, 1)}T08:00:00-03:00`);
    const updated = await asManager().update({ id: row.id, startAt: newStart.toISOString(), endAt: newEnd.toISOString(), modality: "SOBREAVISO" });
    expect(updated?.startAt.toISOString()).toBe(newStart.toISOString());
    expect(updated?.endAt.toISOString()).toBe(newEnd.toISOString());
    expect(updated?.modality).toBe("SOBREAVISO");
    expect(updated?.coverageType).toBeNull(); // invariante: SOBREAVISO ⇒ coverageType NULL

    const list = await asDoctor().listByPeriod({ startDate: new Date(`${day}T00:00:00-03:00`).toISOString(), endDate: new Date(`${addDaysToKey(day, 1)}T00:00:00-03:00`).toISOString() });
    expect(list.map((s: any) => s.id)).toContain(row.id);
  });

  it("USER comum não cria nem edita turno", async () => {
    await expect(asDoctor().create({ date: day, shiftTemplateId: templateId })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const [row] = await db.select({ id: shiftInstances.id }).from(shiftInstances).where(eq(shiftInstances.institutionId, institutionId));
    await expect(asDoctor().update({ id: row.id, startAt: new Date(`${day}T21:00:00-03:00`).toISOString() })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

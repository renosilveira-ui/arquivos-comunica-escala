// tests/status-derivado.test.ts — auditoria 22/08, achados A3, A4, M4, M2.
//
// Regra única: o status do turno é DERIVADO das alocações ativas
// (shift-status.ts). Aprovar/rejeitar/remover alocação nunca pode deixar
// o turno "VAGO" com alguém ativo, nem reativar alocação já respondida.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import {
  auditTrail,
  hospitals,
  institutions,
  managerScope,
  professionalAccess,
  professionalInstitutions,
  professionals,
  sectors,
  shiftAssignmentsV2,
  shiftAuditLog,
  shiftInstances,
  users,
} from "../drizzle/schema";
import { getDb } from "../server/db";
import { dayKeyBrt } from "../server/local-time";
import { editorRouter } from "../server/editor";
import { appRouter } from "../server/routers";
import { shiftsRouter } from "../server/shifts-crud";

describe("status do turno derivado das alocações", () => {
  let db: NonNullable<Awaited<ReturnType<typeof getDb>>>;
  let institutionId: number;
  let hospitalId: number;
  let sectorId: number;
  let managerUserId: number;
  let managerProfessionalId: number;
  const doctorUserIds: number[] = [];
  const doctorProfessionalIds: number[] = [];
  let shiftInstanceId: number;

  const managerCtx = () =>
    ({
      user: { id: managerUserId, role: "manager", name: "Gestor Status", email: "gestor-status@test.local" },
      institutionId,
      allowedInstitutionIds: [institutionId],
    }) as any;

  const app = () => appRouter.createCaller(managerCtx());
  const editor = () => editorRouter.createCaller(managerCtx());
  const shifts = () => shiftsRouter.createCaller(managerCtx());

  async function shiftStatus(): Promise<string> {
    const [row] = await db.select({ status: shiftInstances.status }).from(shiftInstances).where(eq(shiftInstances.id, shiftInstanceId));
    return row.status;
  }

  async function activeAssignments() {
    return db
      .select({ id: shiftAssignmentsV2.id, professionalId: shiftAssignmentsV2.professionalId, status: shiftAssignmentsV2.status })
      .from(shiftAssignmentsV2)
      .where(and(eq(shiftAssignmentsV2.shiftInstanceId, shiftInstanceId), eq(shiftAssignmentsV2.isActive, true)));
  }

  async function insertAssignment(professionalId: number, status: "PENDENTE" | "OCUPADO" | "REJEITADO", isActive = true) {
    const [row] = await db
      .insert(shiftAssignmentsV2)
      .values({
        shiftInstanceId,
        institutionId,
        hospitalId,
        sectorId,
        professionalId,
        assignmentType: "ON_DUTY",
        status,
        isActive,
        createdBy: managerUserId,
      })
      .$returningId();
    return row.id;
  }

  beforeAll(async () => {
    const conn = await getDb();
    if (!conn) throw new Error("Database not available");
    db = conn;
    const stamp = Date.now();

    const [inst] = await db
      .insert(institutions)
      .values({
        name: `Status Tenant ${stamp}`,
        cnpj: `${stamp}`.slice(-14).padStart(14, "0"),
        legalName: `Status Tenant ${stamp}`,
        tradeName: `ST${stamp}`.slice(0, 20),
        isActive: true,
      })
      .$returningId();
    institutionId = inst.id;
    const [h] = await db.insert(hospitals).values({ institutionId, name: `Status Hospital ${stamp}` }).$returningId();
    hospitalId = h.id;
    const [sec] = await db
      .insert(sectors)
      .values({ institutionId, hospitalId, name: `Status Setor ${stamp}`, category: "cirurgico", color: "#2563EB" })
      .$returningId();
    sectorId = sec.id;

    const [mu] = await db
      .insert(users)
      .values({ name: `Status Manager ${stamp}`, email: `status-manager-${stamp}@test.local`, passwordHash: "test", role: "manager" })
      .$returningId();
    managerUserId = mu.id;
    const [mp] = await db
      .insert(professionals)
      .values({ userId: managerUserId, name: `Status Manager ${stamp}`, role: "Gestor", userRole: "GESTOR_MEDICO" })
      .$returningId();
    managerProfessionalId = mp.id;
    await db.insert(professionalInstitutions).values({
      professionalId: managerProfessionalId,
      userId: managerUserId,
      institutionId,
      roleInInstitution: "GESTOR_MEDICO",
      isPrimary: true,
      active: true,
    });
    await db.insert(managerScope).values({ institutionId, managerProfessionalId, hospitalId, sectorId, active: true });

    for (const tag of ["x", "y", "z"]) {
      const [u] = await db
        .insert(users)
        .values({ name: `Status Dr ${tag} ${stamp}`, email: `status-${tag}-${stamp}@test.local`, passwordHash: "test", role: "doctor" })
        .$returningId();
      const [p] = await db
        .insert(professionals)
        .values({ userId: u.id, name: `Status Dr ${tag} ${stamp}`, role: "Médico", userRole: "USER" })
        .$returningId();
      doctorUserIds.push(u.id);
      doctorProfessionalIds.push(p.id);
      await db.insert(professionalInstitutions).values({
        professionalId: p.id,
        userId: u.id,
        institutionId,
        roleInInstitution: "USER",
        isPrimary: true,
        active: true,
      });
      await db.insert(professionalAccess).values({ institutionId, professionalId: p.id, hospitalId, sectorId, canAccess: true });
    }

    // Turno HOJE 07:00–13:00 no relógio do hospital: "amanhã" cairia no
    // mês seguinte no último dia do mês e a guarda de mês barraria o
    // GESTOR_MEDICO (teste dependente do calendário).
    const todayKey = dayKeyBrt(new Date());
    const startAt = new Date(`${todayKey}T07:00:00-03:00`);
    const endAt = new Date(`${todayKey}T13:00:00-03:00`);
    const [s] = await db
      .insert(shiftInstances)
      .values({ institutionId, hospitalId, sectorId, label: `Status Shift ${stamp}`, startAt, endAt, status: "VAGO" })
      .$returningId();
    shiftInstanceId = s.id;
  });

  beforeEach(async () => {
    await db.delete(auditTrail).where(eq(auditTrail.shiftInstanceId, shiftInstanceId));
    await db.delete(shiftAuditLog).where(eq(shiftAuditLog.shiftInstanceId, shiftInstanceId));
    await db.delete(shiftAssignmentsV2).where(eq(shiftAssignmentsV2.shiftInstanceId, shiftInstanceId));
    await db.update(shiftInstances).set({ status: "VAGO" }).where(eq(shiftInstances.id, shiftInstanceId));
  });

  afterAll(async () => {
    await db.delete(auditTrail).where(eq(auditTrail.shiftInstanceId, shiftInstanceId));
    await db.delete(shiftAuditLog).where(eq(shiftAuditLog.shiftInstanceId, shiftInstanceId));
    await db.delete(shiftAssignmentsV2).where(eq(shiftAssignmentsV2.shiftInstanceId, shiftInstanceId));
    await db.delete(shiftInstances).where(eq(shiftInstances.id, shiftInstanceId));
    const pros = [managerProfessionalId, ...doctorProfessionalIds];
    await db.delete(professionalAccess).where(inArray(professionalAccess.professionalId, pros));
    await db.delete(managerScope).where(eq(managerScope.managerProfessionalId, managerProfessionalId));
    await db.delete(professionalInstitutions).where(inArray(professionalInstitutions.professionalId, pros));
    await db.delete(professionals).where(inArray(professionals.id, pros));
    await db.delete(sectors).where(eq(sectors.id, sectorId));
    await db.delete(hospitals).where(eq(hospitals.id, hospitalId));
    await db.delete(institutions).where(eq(institutions.id, institutionId));
    await db.delete(users).where(inArray(users.id, [managerUserId, ...doctorUserIds]));
  });

  it("A3: aprovar alocação já rejeitada → CONFLICT, sem reativar", async () => {
    const [x, y] = doctorProfessionalIds;
    const rejected = await insertAssignment(x, "REJEITADO", false);
    await insertAssignment(y, "OCUPADO");
    await db.update(shiftInstances).set({ status: "OCUPADO" }).where(eq(shiftInstances.id, shiftInstanceId));

    await expect(app().shiftInstances.approveAssignment({ assignmentId: rejected })).rejects.toMatchObject({ code: "CONFLICT" });

    const active = await activeAssignments();
    expect(active.map((a) => a.professionalId)).toEqual([y]);
    expect(await shiftStatus()).toBe("OCUPADO");
  });

  it("A3: aprovar PENDENTE ativa funciona; segunda aprovação → CONFLICT", async () => {
    const [x] = doctorProfessionalIds;
    const pending = await insertAssignment(x, "PENDENTE");
    await db.update(shiftInstances).set({ status: "PENDENTE" }).where(eq(shiftInstances.id, shiftInstanceId));

    await app().shiftInstances.approveAssignment({ assignmentId: pending });
    expect(await shiftStatus()).toBe("OCUPADO");
    await expect(app().shiftInstances.approveAssignment({ assignmentId: pending })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("A4: rejeitar Y com X ativo mantém o turno OCUPADO; rejeitar de novo → CONFLICT", async () => {
    const [x, y] = doctorProfessionalIds;
    await insertAssignment(x, "OCUPADO");
    const pendingY = await insertAssignment(y, "PENDENTE");
    await db.update(shiftInstances).set({ status: "OCUPADO" }).where(eq(shiftInstances.id, shiftInstanceId));

    await app().shiftInstances.rejectAssignment({ assignmentId: pendingY, reason: "teste" });
    expect(await shiftStatus()).toBe("OCUPADO");
    expect((await activeAssignments()).map((a) => a.professionalId)).toEqual([x]);

    await expect(app().shiftInstances.rejectAssignment({ assignmentId: pendingY })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("A4: rejeitar a única alocação deixa o turno VAGO", async () => {
    const [x] = doctorProfessionalIds;
    const pendingX = await insertAssignment(x, "PENDENTE");
    await db.update(shiftInstances).set({ status: "PENDENTE" }).where(eq(shiftInstances.id, shiftInstanceId));

    await app().shiftInstances.rejectAssignment({ assignmentId: pendingX });
    expect(await shiftStatus()).toBe("VAGO");
  });

  it("M4: remover X com Y PENDENTE ativa deixa o turno PENDENTE, não VAGO", async () => {
    const [x, y] = doctorProfessionalIds;
    const occupiedX = await insertAssignment(x, "OCUPADO");
    await insertAssignment(y, "PENDENTE");
    await db.update(shiftInstances).set({ status: "OCUPADO" }).where(eq(shiftInstances.id, shiftInstanceId));

    const result = await editor().unassignDirect({ assignmentId: occupiedX, reason: "teste" });
    expect(result.ok).toBe(true);
    expect(await shiftStatus()).toBe("PENDENTE");
    expect((await activeAssignments()).map((a) => a.professionalId)).toEqual([y]);
  });

  it("M2: shifts.update não aceita mais sobrescrever o status", async () => {
    const [x] = doctorProfessionalIds;
    await insertAssignment(x, "OCUPADO");
    await db.update(shiftInstances).set({ status: "OCUPADO" }).where(eq(shiftInstances.id, shiftInstanceId));

    // `status` não faz parte do input: zod descarta a chave e nada muda.
    const updated = await shifts().update({ id: shiftInstanceId, status: "VAGO" } as any);
    expect(updated?.status).toBe("OCUPADO");
    expect(await shiftStatus()).toBe("OCUPADO");
  });
});

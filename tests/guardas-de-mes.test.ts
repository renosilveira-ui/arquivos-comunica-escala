// tests/guardas-de-mes.test.ts — auditoria 22/08, achados M1, M2 (mês) e M10.
//
// Todo ponto de escrita respeita a janela do mês corrente e do próximo
// (GESTOR_MEDICO) e o estado PUBLISHED/LOCKED do roster — inclusive a
// auto-criação do calendário, o assumir-vaga e a lista de vagas.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, inArray, like, sql } from "drizzle-orm";
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
  shiftTemplates,
  users,
} from "../drizzle/schema";
import {
  ensureTestAnesthesiaSpecialty,
  openTestScale,
} from "./helpers/open-test-scale";
import { calendarRouter } from "../server/calendar";
import { getDb } from "../server/db";
import { editorRouter } from "../server/editor";
import { dayKeyBrt, yearMonthBrt } from "../server/local-time";
import { lockMonth, publishMonth } from "../server/month-guards";
import { appRouter } from "../server/routers";
import { shiftsRouter } from "../server/shifts-crud";
import {
  assertManagerScopeAccessForUpdate,
  resolveTenantActor,
} from "../server/_core/policy";

describe("guardas de mês em todos os pontos de escrita", () => {
  let db: NonNullable<Awaited<ReturnType<typeof getDb>>>;
  let institutionId: number;
  let hospitalId: number;
  let sectorId: number;
  let scheduleContextId: number;
  let anesthesiaId: number;
  let templateId: number;
  let medicoUserId: number;
  let medicoProId: number;
  let plusUserId: number;
  let plusProId: number;
  let doctorUserId: number;
  let doctorProId: number;
  const stamp = Date.now();
  const auditFailureTrigger = `gm_fail_audit_${stamp}`;

  // Hoje 07:00 e dia 10 do mês que vem 07:00 — no relógio do HOSPITAL
  // (-03:00), não no fuso do processo (CI roda em UTC).
  const todayKey = dayKeyBrt(new Date());
  const currentStart = new Date(`${todayKey}T07:00:00-03:00`);
  const currentYm = todayKey.slice(0, 7);
  const nextYm = (() => {
    const [y, m] = currentYm.split("-").map(Number);
    return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
  })();
  const plus2Ym = (() => {
    const [y, m] = currentYm.split("-").map(Number);
    const nm = m + 2;
    return nm > 12
      ? `${y + 1}-${String(nm - 12).padStart(2, "0")}`
      : `${y}-${String(nm).padStart(2, "0")}`;
  })();
  const nextMonthStart = new Date(`${nextYm}-10T07:00:00-03:00`);
  const plus2Start = new Date(`${plus2Ym}-10T07:00:00-03:00`);

  const ctxFor = (userId: number, role: "manager" | "doctor") =>
    ({ user: { id: userId, role, name: "T", email: `${userId}@test.local`, sessionVersion: 1 }, institutionId, allowedInstitutionIds: [institutionId] }) as any;
  const asMedico = () => shiftsRouter.createCaller(ctxFor(medicoUserId, "manager"));
  const asPlus = () => shiftsRouter.createCaller(ctxFor(plusUserId, "manager"));
  const decisionsAs = (userId: number) => appRouter.createCaller(ctxFor(userId, "manager"));
  const calendarAs = (userId: number) => calendarRouter.createCaller(ctxFor(userId, "manager"));
  const editorAs = (userId: number) => editorRouter.createCaller(ctxFor(userId, "manager"));
  const asDoctor = () => appRouter.createCaller(ctxFor(doctorUserId, "doctor"));

  async function setRoster(ym: string, status: "DRAFT" | "PUBLISHED" | "LOCKED" | null) {
    await db.delete(monthlyRosters).where(and(eq(monthlyRosters.institutionId, institutionId), eq(monthlyRosters.hospitalId, hospitalId), eq(monthlyRosters.yearMonth, ym)));
    if (status) await db.insert(monthlyRosters).values({ institutionId, hospitalId, yearMonth: ym, status });
  }

  async function insertShift(startAt: Date, label: string) {
    const endAt = new Date(startAt.getTime() + 6 * 60 * 60 * 1000);
    const [s] = await db
      .insert(shiftInstances)
      .values({ institutionId, hospitalId, sectorId, scheduleContextId, label: `gm-${stamp}-${label}`, startAt, endAt, status: "VAGO" })
      .$returningId();
    return s.id;
  }

  async function insertPendingAssignment(shiftInstanceId: number) {
    const [row] = await db
      .insert(shiftAssignmentsV2)
      .values({
        shiftInstanceId,
        institutionId,
        hospitalId,
        sectorId,
        professionalId: doctorProId,
        assignmentType: "ON_DUTY",
        status: "PENDENTE",
        isActive: true,
        createdBy: doctorUserId,
      })
      .$returningId();
    await db
      .update(shiftInstances)
      .set({ status: "PENDENTE" })
      .where(eq(shiftInstances.id, shiftInstanceId));
    return row.id;
  }

  async function shiftsOfDay(dayKey: string) {
    const all = await db.select({ id: shiftInstances.id, startAt: shiftInstances.startAt }).from(shiftInstances).where(and(eq(shiftInstances.institutionId, institutionId), eq(shiftInstances.sectorId, sectorId)));
    return all.filter((s) => dayKeyBrt(s.startAt) === dayKey);
  }

  async function mutationSnapshot() {
    const [shifts, assignments, rosters, audits, auditLogs] = await Promise.all([
      db
        .select({
          id: shiftInstances.id,
          status: shiftInstances.status,
          startAt: shiftInstances.startAt,
          endAt: shiftInstances.endAt,
        })
        .from(shiftInstances)
        .where(eq(shiftInstances.institutionId, institutionId))
        .orderBy(shiftInstances.id),
      db
        .select({
          id: shiftAssignmentsV2.id,
          status: shiftAssignmentsV2.status,
          isActive: shiftAssignmentsV2.isActive,
        })
        .from(shiftAssignmentsV2)
        .where(eq(shiftAssignmentsV2.institutionId, institutionId))
        .orderBy(shiftAssignmentsV2.id),
      db
        .select({
          id: monthlyRosters.id,
          status: monthlyRosters.status,
          version: monthlyRosters.version,
          publishedAt: monthlyRosters.publishedAt,
          lockedAt: monthlyRosters.lockedAt,
        })
        .from(monthlyRosters)
        .where(eq(monthlyRosters.institutionId, institutionId))
        .orderBy(monthlyRosters.id),
      db
        .select({ id: auditTrail.id, action: auditTrail.action, entityId: auditTrail.entityId })
        .from(auditTrail)
        .where(eq(auditTrail.institutionId, institutionId))
        .orderBy(auditTrail.id),
      db
        .select({ id: shiftAuditLog.id, event: shiftAuditLog.event })
        .from(shiftAuditLog)
        .where(eq(shiftAuditLog.institutionId, institutionId))
        .orderBy(shiftAuditLog.id),
    ]);
    return { shifts, assignments, rosters, audits, auditLogs };
  }

  async function expectStaleMutationNoWrite(
    userId: number,
    label: string,
    operation: () => Promise<unknown>,
  ): Promise<void> {
    const before = await mutationSnapshot();
    await db
      .update(users)
      .set({ sessionVersion: 2 })
      .where(eq(users.id, userId));
    try {
      await expect(operation(), label).rejects.toMatchObject({
        code: "CONFLICT",
        message: expect.stringMatching(/sessão.*revogada/i),
      });
    } finally {
      await db
        .update(users)
        .set({ sessionVersion: 1 })
        .where(eq(users.id, userId));
    }
    expect(await mutationSnapshot(), label).toEqual(before);
  }

  async function dropAuditFailureTrigger() {
    await db.execute(sql.raw(`DROP TRIGGER IF EXISTS \`${auditFailureTrigger}\``));
  }

  async function installAuditFailureTrigger() {
    await dropAuditFailureTrigger();
    await db.execute(
      sql.raw(
        `CREATE TRIGGER \`${auditFailureTrigger}\` BEFORE INSERT ON audit_trail ` +
        `FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'forced strict audit failure'`,
      ),
    );
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
    anesthesiaId = await ensureTestAnesthesiaSpecialty(db);
    scheduleContextId = await openTestScale(db, { institutionId, hospitalId, sectorId });
    const [t] = await db.insert(shiftTemplates).values({ institutionId, hospitalId, sectorId, name: "Manhã", startTime: "07:00:00", endTime: "13:00:00" }).$returningId();
    templateId = t.id;

    async function person(tag: string, role: "manager" | "doctor", link: "GESTOR_MEDICO" | "GESTOR_PLUS" | "USER") {
      const [u] = await db.insert(users).values({ name: `GM ${tag} ${stamp}`, email: `gm-${tag}-${stamp}@test.local`, passwordHash: "test", role }).$returningId();
      const [p] = await db.insert(professionals).values({ userId: u.id, name: `GM ${tag} ${stamp}`, role: "Médico", userRole: link, medicalSpecialtyId: anesthesiaId, specialty: "Anestesiologia" }).$returningId();
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
    await db
      .update(users)
      .set({ sessionVersion: 1 })
      .where(inArray(users.id, [medicoUserId, plusUserId, doctorUserId]));
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
    await dropAuditFailureTrigger();
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
    await db.delete(scheduleContexts).where(eq(scheduleContexts.id, scheduleContextId));
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

  it("helper gerencial recusa sessionVersion obsoleto sob users X sem escrita", async () => {
    const actor = await resolveTenantActor(plusUserId, institutionId, false);
    await expectStaleMutationNoWrite(plusUserId, "manager-helper", () =>
      db.transaction((tx) =>
        assertManagerScopeAccessForUpdate(
          tx,
          actor,
          1,
          hospitalId,
          sectorId,
          [currentStart],
        ),
      ),
    );
  });

  it("sessão gerencial obsoleta barra calendar/editor/shifts/assignment/month", async () => {
    await setRoster(currentYm, "DRAFT");
    await expectStaleMutationNoWrite(plusUserId, "shifts.create", () =>
      asPlus().create({ date: todayKey, shiftTemplateId: templateId }),
    );

    const directShiftId = await insertShift(currentStart, "stale-editor");
    await expectStaleMutationNoWrite(plusUserId, "editor.assignDirect", () =>
      editorAs(plusUserId).assignDirect({
        shiftInstanceId: directShiftId,
        professionalId: doctorProId,
        assignmentType: "ON_DUTY",
      }),
    );

    const decisionShiftId = await insertShift(currentStart, "stale-decision");
    const assignmentId = await insertPendingAssignment(decisionShiftId);
    await expectStaleMutationNoWrite(plusUserId, "approveAssignment", () =>
      decisionsAs(plusUserId).shiftInstances.approveAssignment({ assignmentId }),
    );

    await expectStaleMutationNoWrite(plusUserId, "publishMonth", () =>
      asPlus().publish({ institutionId, hospitalId, yearMonth: currentYm }),
    );
  });

  it("gestor setorial não publica ou tranca o roster hospitalar e não deixa efeitos", async () => {
    const managerActor = await resolveTenantActor(
      medicoUserId,
      institutionId,
      false,
    );
    const beforePublish = await mutationSnapshot();

    await expect(
      asMedico().publish({ institutionId, hospitalId, yearMonth: currentYm }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      publishMonth(institutionId, hospitalId, currentYm, managerActor, 1),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await mutationSnapshot()).toEqual(beforePublish);

    await setRoster(currentYm, "PUBLISHED");
    const beforeLock = await mutationSnapshot();
    await expect(
      asMedico().lock({ institutionId, hospitalId, yearMonth: currentYm }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      lockMonth(institutionId, hospitalId, currentYm, managerActor, 1),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await mutationSnapshot()).toEqual(beforeLock);
  });

  it("assumeVacancy vincula expectedSessionVersion ao expectedUserId sem escrever", async () => {
    const shiftId = await insertShift(currentStart, "stale-vacancy");
    await setRoster(currentYm, "DRAFT");
    await expectStaleMutationNoWrite(doctorUserId, "assumeVacancy", () =>
      asDoctor().shiftAssignments.assumeVacancy({
        shiftInstanceId: shiftId,
        assignmentType: "ON_DUTY",
      }),
    );
  });

  it("M10: mês LOCKED barra aprovação e rejeição sem qualquer escrita", async () => {
    const shiftId = await insertShift(currentStart, "locked-decision");
    const assignmentId = await insertPendingAssignment(shiftId);
    await setRoster(currentYm, "LOCKED");

    const beforeAudit = await db
      .select({ id: auditTrail.id })
      .from(auditTrail)
      .where(eq(auditTrail.shiftInstanceId, shiftId));

    await expect(
      decisionsAs(plusUserId).shiftInstances.approveAssignment({ assignmentId }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      decisionsAs(plusUserId).shiftInstances.rejectAssignment({ assignmentId, reason: "Mês trancado" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const [assignment] = await db
      .select({ status: shiftAssignmentsV2.status, isActive: shiftAssignmentsV2.isActive })
      .from(shiftAssignmentsV2)
      .where(eq(shiftAssignmentsV2.id, assignmentId));
    const [shift] = await db
      .select({ status: shiftInstances.status })
      .from(shiftInstances)
      .where(eq(shiftInstances.id, shiftId));
    const afterAudit = await db
      .select({ id: auditTrail.id })
      .from(auditTrail)
      .where(eq(auditTrail.shiftInstanceId, shiftId));

    expect(assignment).toEqual({ status: "PENDENTE", isActive: true });
    expect(shift.status).toBe("PENDENTE");
    expect(afterAudit).toEqual(beforeAudit);
  });

  it("reject revalida conta aprovada dentro da transação e falha sem efeitos", async () => {
    const shiftId = await insertShift(currentStart, "reject-account-race");
    const assignmentId = await insertPendingAssignment(shiftId);
    await setRoster(currentYm, "DRAFT");

    let releaseLock!: () => void;
    let rowLocked!: () => void;
    const release = new Promise<void>((resolve) => { releaseLock = resolve; });
    const locked = new Promise<void>((resolve) => { rowLocked = resolve; });
    const locker = db.transaction(async (tx) => {
      await tx
        .update(monthlyRosters)
        .set({ status: "DRAFT" })
        .where(
          and(
            eq(monthlyRosters.institutionId, institutionId),
            eq(monthlyRosters.hospitalId, hospitalId),
            eq(monthlyRosters.yearMonth, currentYm),
          ),
        );
      rowLocked();
      await release;
    });

    await locked;
    let settled = false;
    const request = decisionsAs(plusUserId).shiftInstances
      .rejectAssignment({ assignmentId, reason: "Conta revogada durante decisão" })
      .then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      )
      .finally(() => { settled = true; });
    try {
      await new Promise((resolve) => setTimeout(resolve, 75));
      expect(settled).toBe(false);
      await db
        .update(users)
        .set({ approvalStatus: "PENDING" })
        .where(eq(users.id, plusUserId));
    } finally {
      releaseLock();
    }

    try {
      await locker;
      expect(await request).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
      const [assignment] = await db
        .select({ status: shiftAssignmentsV2.status, isActive: shiftAssignmentsV2.isActive })
        .from(shiftAssignmentsV2)
        .where(eq(shiftAssignmentsV2.id, assignmentId));
      const [shift] = await db
        .select({ status: shiftInstances.status })
        .from(shiftInstances)
        .where(eq(shiftInstances.id, shiftId));
      const audits = await db
        .select({ id: auditTrail.id })
        .from(auditTrail)
        .where(eq(auditTrail.shiftInstanceId, shiftId));
      expect(assignment).toEqual({ status: "PENDENTE", isActive: true });
      expect(shift.status).toBe("PENDENTE");
      expect(audits).toHaveLength(0);
    } finally {
      await db
        .update(users)
        .set({ approvalStatus: "APPROVED" })
        .where(eq(users.id, plusUserId));
    }
  });

  it("M10: decisão espera lock concorrente e observa LOCKED após o commit", async () => {
    const shiftId = await insertShift(currentStart, "lock-race");
    const assignmentId = await insertPendingAssignment(shiftId);
    await setRoster(currentYm, "PUBLISHED");

    let releaseLock!: () => void;
    let rowLocked!: () => void;
    const release = new Promise<void>((resolve) => { releaseLock = resolve; });
    const locked = new Promise<void>((resolve) => { rowLocked = resolve; });
    const locker = db.transaction(async (tx) => {
      await tx
        .update(monthlyRosters)
        .set({ status: "LOCKED" })
        .where(
          and(
            eq(monthlyRosters.institutionId, institutionId),
            eq(monthlyRosters.hospitalId, hospitalId),
            eq(monthlyRosters.yearMonth, currentYm),
          ),
        );
      rowLocked();
      await release;
    });

    await locked;
    let settled = false;
    const decision = decisionsAs(plusUserId).shiftInstances
      .approveAssignment({ assignmentId })
      .then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      )
      .finally(() => { settled = true; });
    try {
      await new Promise((resolve) => setTimeout(resolve, 75));
      expect(settled).toBe(false);
    } finally {
      // Nunca deixar a transação auxiliar aberta se uma asserção falhar.
      releaseLock();
    }
    await locker;
    const outcome = await decision;
    expect(outcome).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });

    const [assignment] = await db
      .select({ status: shiftAssignmentsV2.status })
      .from(shiftAssignmentsV2)
      .where(eq(shiftAssignmentsV2.id, assignmentId));
    expect(assignment.status).toBe("PENDENTE");
  });

  it("M10: assumir vaga espera lock concorrente e não cria candidatura após LOCKED", async () => {
    const shiftId = await insertShift(currentStart, "vacancy-lock-race");
    await setRoster(currentYm, "PUBLISHED");

    let releaseLock!: () => void;
    let rowLocked!: () => void;
    const release = new Promise<void>((resolve) => { releaseLock = resolve; });
    const locked = new Promise<void>((resolve) => { rowLocked = resolve; });
    const locker = db.transaction(async (tx) => {
      await tx
        .update(monthlyRosters)
        .set({ status: "LOCKED" })
        .where(
          and(
            eq(monthlyRosters.institutionId, institutionId),
            eq(monthlyRosters.hospitalId, hospitalId),
            eq(monthlyRosters.yearMonth, currentYm),
          ),
        );
      rowLocked();
      await release;
    });

    await locked;
    let settled = false;
    const request = asDoctor().shiftAssignments
      .assumeVacancy({ shiftInstanceId: shiftId, assignmentType: "ON_DUTY" })
      .then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      )
      .finally(() => { settled = true; });
    try {
      await new Promise((resolve) => setTimeout(resolve, 75));
      expect(settled).toBe(false);
    } finally {
      releaseLock();
    }
    await locker;
    const outcome = await request;
    expect(outcome).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });

    const [shift] = await db
      .select({ status: shiftInstances.status })
      .from(shiftInstances)
      .where(eq(shiftInstances.id, shiftId));
    const assignments = await db
      .select({ id: shiftAssignmentsV2.id })
      .from(shiftAssignmentsV2)
      .where(eq(shiftAssignmentsV2.shiftInstanceId, shiftId));
    expect(shift.status).toBe("VAGO");
    expect(assignments).toHaveLength(0);
  });

  it("editor: alocação direta espera lock concorrente e não escreve após LOCKED", async () => {
    const shiftId = await insertShift(currentStart, "editor-lock-race");
    await setRoster(currentYm, "DRAFT");

    let releaseLock!: () => void;
    let rowLocked!: () => void;
    const release = new Promise<void>((resolve) => { releaseLock = resolve; });
    const locked = new Promise<void>((resolve) => { rowLocked = resolve; });
    const locker = db.transaction(async (tx) => {
      await tx
        .update(monthlyRosters)
        .set({ status: "LOCKED" })
        .where(
          and(
            eq(monthlyRosters.institutionId, institutionId),
            eq(monthlyRosters.hospitalId, hospitalId),
            eq(monthlyRosters.yearMonth, currentYm),
          ),
        );
      rowLocked();
      await release;
    });

    await locked;
    let settled = false;
    const request = editorAs(medicoUserId)
      .assignDirect({
        shiftInstanceId: shiftId,
        professionalId: doctorProId,
        assignmentType: "ON_DUTY",
      })
      .then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      )
      .finally(() => { settled = true; });
    try {
      await new Promise((resolve) => setTimeout(resolve, 75));
      expect(settled).toBe(false);
    } finally {
      releaseLock();
    }
    await locker;
    expect(await request).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });

    const assignments = await db
      .select({ id: shiftAssignmentsV2.id })
      .from(shiftAssignmentsV2)
      .where(eq(shiftAssignmentsV2.shiftInstanceId, shiftId));
    const [shift] = await db
      .select({ status: shiftInstances.status })
      .from(shiftInstances)
      .where(eq(shiftInstances.id, shiftId));
    const audits = await db
      .select({ id: auditTrail.id })
      .from(auditTrail)
      .where(eq(auditTrail.shiftInstanceId, shiftId));
    expect(assignments).toHaveLength(0);
    expect(shift.status).toBe("VAGO");
    expect(audits).toHaveLength(0);
  });

  it("editor: revogação concorrente da paridade usuário-profissional falha sem escrita", async () => {
    const shiftId = await insertShift(currentStart, "editor-membership-race");
    const assignmentId = await insertPendingAssignment(shiftId);
    await setRoster(currentYm, "DRAFT");

    let releaseLock!: () => void;
    let rowLocked!: () => void;
    const release = new Promise<void>((resolve) => { releaseLock = resolve; });
    const locked = new Promise<void>((resolve) => { rowLocked = resolve; });
    const locker = db.transaction(async (tx) => {
      await tx
        .update(monthlyRosters)
        .set({ status: "DRAFT" })
        .where(
          and(
            eq(monthlyRosters.institutionId, institutionId),
            eq(monthlyRosters.hospitalId, hospitalId),
            eq(monthlyRosters.yearMonth, currentYm),
          ),
        );
      rowLocked();
      await release;
    });

    await locked;
    let settled = false;
    const request = editorAs(medicoUserId)
      .markVacant({ shiftInstanceId: shiftId })
      .then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      )
      .finally(() => { settled = true; });
    let parityChanged = false;
    try {
      await new Promise((resolve) => setTimeout(resolve, 75));
      expect(settled).toBe(false);
      await db
        .update(professionals)
        .set({ userId: doctorUserId })
        .where(eq(professionals.id, medicoProId));
      parityChanged = true;
    } finally {
      releaseLock();
    }
    let outcome!: Awaited<typeof request>;
    try {
      await locker;
      outcome = await request;
    } finally {
      if (parityChanged) {
        await db
          .update(professionals)
          .set({ userId: medicoUserId })
          .where(eq(professionals.id, medicoProId));
      }
    }
    expect(outcome).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });

    const [assignment] = await db
      .select({ status: shiftAssignmentsV2.status, isActive: shiftAssignmentsV2.isActive })
      .from(shiftAssignmentsV2)
      .where(eq(shiftAssignmentsV2.id, assignmentId));
    const [shift] = await db
      .select({ status: shiftInstances.status })
      .from(shiftInstances)
      .where(eq(shiftInstances.id, shiftId));
    const audits = await db
      .select({ id: auditTrail.id })
      .from(auditTrail)
      .where(eq(auditTrail.shiftInstanceId, shiftId));
    expect(assignment).toEqual({ status: "PENDENTE", isActive: true });
    expect(shift.status).toBe("PENDENTE");
    expect(audits).toHaveLength(0);
  });

  it("editor: falha da auditoria strict reverte assignments, turno e auditLog", async () => {
    const shiftId = await insertShift(currentStart, "editor-audit-rollback");
    const assignmentId = await insertPendingAssignment(shiftId);
    await setRoster(currentYm, "DRAFT");
    await installAuditFailureTrigger();
    try {
      await expect(
        editorAs(medicoUserId).markVacant({ shiftInstanceId: shiftId }),
      ).rejects.toBeTruthy();
    } finally {
      await dropAuditFailureTrigger();
    }

    const [assignment] = await db
      .select({ status: shiftAssignmentsV2.status, isActive: shiftAssignmentsV2.isActive })
      .from(shiftAssignmentsV2)
      .where(eq(shiftAssignmentsV2.id, assignmentId));
    const [shift] = await db
      .select({ status: shiftInstances.status })
      .from(shiftInstances)
      .where(eq(shiftInstances.id, shiftId));
    const auditTrailRows = await db
      .select({ id: auditTrail.id })
      .from(auditTrail)
      .where(eq(auditTrail.shiftInstanceId, shiftId));
    const auditLogRows = await db
      .select({ id: shiftAuditLog.id })
      .from(shiftAuditLog)
      .where(eq(shiftAuditLog.shiftInstanceId, shiftId));
    expect(assignment).toEqual({ status: "PENDENTE", isActive: true });
    expect(shift.status).toBe("PENDENTE");
    expect(auditTrailRows).toHaveLength(0);
    expect(auditLogRows).toHaveLength(0);
  });

  it("topologia: assignment local apontando para turno estrangeiro é recusado", async () => {
    const foreignStamp = `${stamp}${Date.now()}`.slice(-14).padStart(14, "0");
    const [foreignInstitution] = await db
      .insert(institutions)
      .values({
        name: `GM Foreign ${foreignStamp}`,
        cnpj: foreignStamp,
        legalName: `GM Foreign ${foreignStamp}`,
        tradeName: `GMF${foreignStamp}`.slice(0, 20),
        isActive: true,
      })
      .$returningId();
    const [foreignHospital] = await db
      .insert(hospitals)
      .values({ institutionId: foreignInstitution.id, name: `GM Foreign H ${foreignStamp}` })
      .$returningId();
    const [foreignSector] = await db
      .insert(sectors)
      .values({
        institutionId: foreignInstitution.id,
        hospitalId: foreignHospital.id,
        name: `GM Foreign S ${foreignStamp}`,
        category: "cirurgico",
        color: "#111827",
      })
      .$returningId();
    const [foreignShift] = await db
      .insert(shiftInstances)
      .values({
        institutionId: foreignInstitution.id,
        hospitalId: foreignHospital.id,
        sectorId: foreignSector.id,
        label: `foreign-${foreignStamp}`,
        startAt: currentStart,
        endAt: new Date(currentStart.getTime() + 6 * 60 * 60 * 1000),
        status: "PENDENTE",
      })
      .$returningId();
    const [poisoned] = await db
      .insert(shiftAssignmentsV2)
      .values({
        shiftInstanceId: foreignShift.id,
        institutionId,
        hospitalId,
        sectorId,
        professionalId: doctorProId,
        assignmentType: "ON_DUTY",
        status: "PENDENTE",
        isActive: true,
        createdBy: doctorUserId,
      })
      .$returningId();

    try {
      await expect(
        decisionsAs(plusUserId).shiftInstances.approveAssignment({ assignmentId: poisoned.id }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(
        decisionsAs(plusUserId).shiftInstances.rejectAssignment({ assignmentId: poisoned.id }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });

      const [assignment] = await db
        .select({ status: shiftAssignmentsV2.status, isActive: shiftAssignmentsV2.isActive })
        .from(shiftAssignmentsV2)
        .where(eq(shiftAssignmentsV2.id, poisoned.id));
      const [shift] = await db
        .select({ status: shiftInstances.status })
        .from(shiftInstances)
        .where(eq(shiftInstances.id, foreignShift.id));
      expect(assignment).toEqual({ status: "PENDENTE", isActive: true });
      expect(shift.status).toBe("PENDENTE");
    } finally {
      await db.delete(shiftAssignmentsV2).where(eq(shiftAssignmentsV2.id, poisoned.id));
      await db.delete(shiftInstances).where(eq(shiftInstances.id, foreignShift.id));
      await db.delete(sectors).where(eq(sectors.id, foreignSector.id));
      await db.delete(hospitals).where(eq(hospitals.id, foreignHospital.id));
      await db.delete(institutions).where(eq(institutions.id, foreignInstitution.id));
    }
  });

  it("editor: shift A com hospital/setor B é invisível e não produz escrita nem auditoria", async () => {
    const foreignStamp = `${stamp}${Date.now()}`.slice(-14).padStart(14, "0");
    const [foreignInstitution] = await db
      .insert(institutions)
      .values({
        name: `GM Editor Foreign ${foreignStamp}`,
        cnpj: foreignStamp,
        legalName: `GM Editor Foreign ${foreignStamp}`,
        tradeName: `GMEF${foreignStamp}`.slice(0, 20),
        isActive: true,
      })
      .$returningId();
    const [foreignHospital] = await db
      .insert(hospitals)
      .values({ institutionId: foreignInstitution.id, name: `GM Editor H ${foreignStamp}` })
      .$returningId();
    const [foreignSector] = await db
      .insert(sectors)
      .values({
        institutionId: foreignInstitution.id,
        hospitalId: foreignHospital.id,
        name: `GM Editor S ${foreignStamp}`,
        category: "cirurgico",
        color: "#111827",
      })
      .$returningId();
    const [poisonedShift] = await db
      .insert(shiftInstances)
      .values({
        institutionId,
        hospitalId: foreignHospital.id,
        sectorId: foreignSector.id,
        label: `poisoned-editor-${foreignStamp}`,
        startAt: currentStart,
        endAt: new Date(currentStart.getTime() + 6 * 60 * 60 * 1000),
        status: "VAGO",
      })
      .$returningId();

    try {
      await expect(
        editorAs(plusUserId).assignDirect({
          shiftInstanceId: poisonedShift.id,
          professionalId: doctorProId,
          assignmentType: "ON_DUTY",
          reason: "Teste de topologia adulterada",
        }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });

      const assignments = await db
        .select({ id: shiftAssignmentsV2.id })
        .from(shiftAssignmentsV2)
        .where(eq(shiftAssignmentsV2.shiftInstanceId, poisonedShift.id));
      const auditTrailRows = await db
        .select({ id: auditTrail.id })
        .from(auditTrail)
        .where(eq(auditTrail.shiftInstanceId, poisonedShift.id));
      const auditLogRows = await db
        .select({ id: shiftAuditLog.id })
        .from(shiftAuditLog)
        .where(eq(shiftAuditLog.shiftInstanceId, poisonedShift.id));
      expect(assignments).toHaveLength(0);
      expect(auditTrailRows).toHaveLength(0);
      expect(auditLogRows).toHaveLength(0);
    } finally {
      await db.delete(shiftInstances).where(eq(shiftInstances.id, poisonedShift.id));
      await db.delete(sectors).where(eq(sectors.id, foreignSector.id));
      await db.delete(hospitals).where(eq(hospitals.id, foreignHospital.id));
      await db.delete(institutions).where(eq(institutions.id, foreignInstitution.id));
    }
  });

  it("M2: GESTOR_MEDICO não puxa turno de mês+2 para o corrente", async () => {
    const future = await insertShift(plus2Start, "future");
    await expect(asMedico().update({ id: future, startAt: currentStart.toISOString() })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const [row] = await db.select({ startAt: shiftInstances.startAt }).from(shiftInstances).where(eq(shiftInstances.id, future));
    expect(yearMonthBrt(row.startAt)).toBe(plus2Ym);
  });

  it("M2: PUBLISHED sem turnos não exige motivo — status do roster é independente do calendário", async () => {
    await setRoster(currentYm, "PUBLISHED");
    const date = dayKeyBrt(currentStart);
    const createdByMedico = await asMedico().create({ date, shiftTemplateId: templateId });
    expect(createdByMedico).toBeTruthy();
    expect(await shiftsOfDay(date)).toHaveLength(1);
  });

  it("M2: mês PUBLISHED com turnos — criar plantão vago não exige motivo", async () => {
    await setRoster(currentYm, "PUBLISHED");
    const seedDay = dayKeyBrt(currentStart) === `${currentYm}-02`
      ? `${currentYm}-03`
      : `${currentYm}-02`;
    await insertShift(new Date(`${seedDay}T07:00:00-03:00`), "published-content");
    const date = dayKeyBrt(currentStart);
    const createdByMedico = await asMedico().create({ date, shiftTemplateId: templateId });
    expect(createdByMedico).toBeTruthy();
    expect(await shiftsOfDay(date)).toHaveLength(1);
    const createdByPlus = await asPlus().create({
      date: seedDay,
      shiftTemplateId: templateId,
    });
    expect(createdByPlus).toBeTruthy();
  });

  it("M2: mês LOCKED — criar plantão vago sem Gestor+ falha; Gestor+ só com motivo", async () => {
    await setRoster(currentYm, "LOCKED");
    const date = dayKeyBrt(currentStart);
    await expect(asMedico().create({ date, shiftTemplateId: templateId })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(asPlus().create({ date, shiftTemplateId: templateId })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    const created = await asPlus().create({
      date,
      shiftTemplateId: templateId,
      reason: "Cobertura extra aprovada",
    });
    expect(created).toBeTruthy();
    expect(await shiftsOfDay(date)).toHaveLength(1);
  });

  it("calendar: abrir o dia é somente leitura e não cria turnos", async () => {
    const date = dayKeyBrt(currentStart);
    await setRoster(currentYm, "DRAFT");
    const before = await mutationSnapshot();
    const day = await calendarAs(medicoUserId).getDay({
      institutionId,
      hospitalId,
      sectorId,
      date,
    });
    expect(day.shifts).toHaveLength(0);
    expect(await shiftsOfDay(date)).toHaveLength(0);
    expect(await mutationSnapshot()).toEqual(before);
  });

  it("calendar USER vê PUBLISHED/LOCKED e oculta profissional suspenso ou excluído", async () => {
    const shiftId = await insertShift(currentStart, "calendar-user-visible");
    await db.insert(shiftAssignmentsV2).values({
      shiftInstanceId: shiftId,
      institutionId,
      hospitalId,
      sectorId,
      professionalId: medicoProId,
      assignmentType: "ON_DUTY",
      status: "OCUPADO",
      isActive: true,
      createdBy: plusUserId,
    });
    await db.update(shiftInstances).set({ status: "OCUPADO" }).where(eq(shiftInstances.id, shiftId));
    await setRoster(currentYm, "PUBLISHED");

    const date = dayKeyBrt(currentStart);
    const input = { institutionId, hospitalId, sectorId, date };
    const published = await calendarAs(doctorUserId).getDay(input);
    expect(published.monthStatus).toBe("PUBLISHED");
    expect(published.shifts[0].slots).toEqual(
      expect.arrayContaining([expect.objectContaining({ professionalId: medicoProId })]),
    );

    await setRoster(currentYm, "LOCKED");
    await expect(calendarAs(doctorUserId).getDay(input)).resolves.toMatchObject({
      monthStatus: "LOCKED",
    });
    await expect(
      calendarAs(doctorUserId).getMonthGrid({
        institutionId,
        hospitalId,
        sectorId,
        yearMonth: currentYm,
      }),
    ).resolves.toMatchObject({ monthStatus: "LOCKED" });

    for (const revokedState of [
      { approvalStatus: "PENDING" as const, deletedAt: null },
      { approvalStatus: "APPROVED" as const, deletedAt: new Date() },
    ]) {
      try {
        await db.update(users).set(revokedState).where(eq(users.id, medicoUserId));
        const hidden = await calendarAs(doctorUserId).getDay(input);
        expect(hidden.shifts[0].slots).not.toEqual(
          expect.arrayContaining([expect.objectContaining({ professionalId: medicoProId })]),
        );
      } finally {
        await db
          .update(users)
          .set({ approvalStatus: "APPROVED", deletedAt: null })
          .where(eq(users.id, medicoUserId));
      }
    }

    await setRoster(currentYm, "DRAFT");
    await expect(calendarAs(doctorUserId).getDay(input)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("M1: abrir dia vazio nunca cria turnos, mesmo em DRAFT no mês corrente", async () => {
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
    expect(r3.shifts).toHaveLength(0);
    expect(await shiftsOfDay(todayKey)).toHaveLength(0);
  });
});

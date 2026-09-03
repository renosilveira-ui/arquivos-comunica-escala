// tests/transactions.test.ts — integridade transacional (Onda 1 · A1)
//
// Cobre: assignDirect devolve o id certo (sem LAST_INSERT_ID em outra
// chamada); assumeVacancy concorrente (só um ganha); aceite concorrente
// da mesma oferta (só um ganha, version incrementa); aprovar duas vezes
// → CONFLICT; status do turno derivado das alocações.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import {
  auditTrail,
  hospitals,
  institutions,
  managerScope,
  monthlyRosters,
  notifications,
  professionalAccess,
  professionalInstitutions,
  professionals,
  sectors,
  shiftAssignmentsV2,
  shiftAuditLog,
  scheduleContexts,
  shiftInstances,
  swapRequests,
  users,
} from "../drizzle/schema";
import {
  ensureTestAnesthesiaSpecialty,
  openTestScale,
} from "./helpers/open-test-scale";
import { getDb } from "../server/db";
import { editorRouter } from "../server/editor";
import { appRouter } from "../server/routers";
import { swapRouter } from "../server/swap-router";
import { deriveShiftStatus } from "../server/shift-status";
import { getCorporateReadinessReport } from "../server/corporate-readiness-v1";

vi.mock("../server/integrations/comunica-plus", () => ({
  enqueueComunicaSwapApproved: vi.fn(async () => 1),
}));

const OFFSET = "-03:00";
const at = (date: string, time: string) => new Date(`${date}T${time}${OFFSET}`);

type Person = { userId: number; professionalId: number; name: string };

describe("integridade transacional", () => {
  let db: Awaited<ReturnType<typeof getDb>>;
  let institutionId: number;
  let hospitalId: number;
  let sectorId: number;
  let scheduleContextId: number;
  let anesthesiaId: number;
  let manager: Person;
  let alice: Person;
  let bruno: Person;
  let carla: Person;
  let raceShiftId: number; // VAGO: corrida de assumeVacancy
  let directShiftId: number; // VAGO: assignDirect
  let swapShiftId: number; // OCUPADO por Alice: corrida de accept
  let swapRequestId: number;
  const extraShiftIds: number[] = [];

  const ctxFor = (p: Person, role: string) =>
    ({
      user: { id: p.userId, role, name: p.name, email: `${p.userId}@test.local`, sessionVersion: 1 },
      institutionId,
      allowedInstitutionIds: [institutionId],
    }) as any;

  async function createPerson(stamp: number, tag: string, role: string, userRole: string): Promise<Person> {
    const [u] = await db!
      .insert(users)
      .values({
        name: `Tx ${tag} ${stamp}`,
        email: `tx-${tag}-${stamp}@test.local`,
        passwordHash: "test",
        role,
      })
      .$returningId();
    const [p] = await db!
      .insert(professionals)
      .values({
        userId: u.id,
        name: `Tx ${tag} ${stamp}`,
        role: "Médico",
        userRole: userRole as any,
        medicalSpecialtyId: anesthesiaId,
        specialty: "Anestesiologia",
      })
      .$returningId();
    await db!.insert(professionalInstitutions).values({
      professionalId: p.id,
      userId: u.id,
      institutionId,
      roleInInstitution: userRole as any,
      isPrimary: true,
      active: true,
    });
    return { userId: u.id, professionalId: p.id, name: `Tx ${tag} ${stamp}` };
  }

  async function createShift(date: string, label: string, start: string, end: string, status = "VAGO") {
    const startAt = at(date, start);
    const endAt = at(date, end);
    if (endAt <= startAt) endAt.setUTCDate(endAt.getUTCDate() + 1);
    const [row] = await db!
      .insert(shiftInstances)
        .values({
          institutionId,
          hospitalId,
          sectorId,
          scheduleContextId,
          label,
          startAt,
          endAt,
          status,
          createdBy: manager.userId,
        })
      .$returningId();
    return row.id;
  }

  beforeAll(async () => {
    db = await getDb();
    if (!db) throw new Error("Database not available");
    const stamp = Date.now();

    const [institution] = await db
      .insert(institutions)
      .values({
        name: `Tx Tenant ${stamp}`,
        cnpj: `${stamp}`.slice(-14).padStart(14, "0"),
        legalName: `Tx Tenant ${stamp}`,
        tradeName: `TX${stamp}`.slice(0, 20),
        isActive: true,
      })
      .$returningId();
    institutionId = institution.id;
    const [hospital] = await db
      .insert(hospitals)
      .values({ institutionId, name: `Tx Hospital ${stamp}` })
      .$returningId();
    hospitalId = hospital.id;
    const [sector] = await db
      .insert(sectors)
      .values({ institutionId, hospitalId, name: `Tx Setor ${stamp}`, category: "cirurgico", color: "#2563EB" })
      .$returningId();
    sectorId = sector.id;
    anesthesiaId = await ensureTestAnesthesiaSpecialty(db);
    scheduleContextId = await openTestScale(db, {
      institutionId,
      hospitalId,
      sectorId,
    });

    manager = await createPerson(stamp, "gestor", "manager", "GESTOR_PLUS");
    alice = await createPerson(stamp, "alice", "doctor", "USER");
    bruno = await createPerson(stamp, "bruno", "doctor", "USER");
    carla = await createPerson(stamp, "carla", "doctor", "USER");

    await db.insert(managerScope).values({
      institutionId,
      managerProfessionalId: manager.professionalId,
      hospitalId,
      sectorId,
      active: true,
    });
    await db.insert(professionalAccess).values(
      [alice, bruno, carla].map((p) => ({
        institutionId,
        professionalId: p.professionalId,
        hospitalId,
        sectorId,
        canAccess: true,
      })),
    );

    // Datas bem à frente para não colidir com seed/outras suítes.
    raceShiftId = await createShift("2027-03-01", "Manhã", "07:00:00", "13:00:00");
    directShiftId = await createShift("2027-03-02", "Tarde", "13:00:00", "19:00:00");
    swapShiftId = await createShift("2027-03-03", "Noite", "19:00:00", "07:00:00", "OCUPADO");

    const [aliceAssignment] = await db
      .insert(shiftAssignmentsV2)
      .values({
        shiftInstanceId: swapShiftId,
        institutionId,
        hospitalId,
        sectorId,
        professionalId: alice.professionalId,
        assignmentType: "ON_DUTY",
        status: "OCUPADO",
        isActive: true,
        createdBy: manager.userId,
      })
      .$returningId();

    const [swap] = await db
      .insert(swapRequests)
      .values({
        type: "CESSAO",
        status: "PENDING",
        fromProfessionalId: alice.professionalId,
        fromUserId: alice.userId,
        fromShiftInstanceId: swapShiftId,
        fromAssignmentId: aliceAssignment.id,
        institutionId,
        hospitalId,
        sectorId,
        reason: "corrida de aceite",
        expiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000),
      })
      .$returningId();
    swapRequestId = swap.id;
    await db.insert(monthlyRosters).values({
      institutionId,
      hospitalId,
      yearMonth: "2027-03",
      status: "PUBLISHED",
    });
  });

  afterAll(async () => {
    if (!db) return;
    await db.delete(swapRequests).where(eq(swapRequests.institutionId, institutionId));
    const shiftIds = [raceShiftId, directShiftId, swapShiftId, ...extraShiftIds].filter(Boolean);
    if (shiftIds.length) {
      await db.delete(auditTrail).where(inArray(auditTrail.shiftInstanceId, shiftIds));
      await db.delete(shiftAuditLog).where(inArray(shiftAuditLog.shiftInstanceId, shiftIds));
      await db.delete(notifications).where(inArray(notifications.shiftInstanceId, shiftIds));
      await db.delete(shiftAssignmentsV2).where(inArray(shiftAssignmentsV2.shiftInstanceId, shiftIds));
      await db.delete(shiftInstances).where(inArray(shiftInstances.id, shiftIds));
    }
    await db.delete(auditTrail).where(eq(auditTrail.institutionId, institutionId));
    await db.delete(professionalAccess).where(eq(professionalAccess.institutionId, institutionId));
    await db.delete(managerScope).where(eq(managerScope.institutionId, institutionId));
    await db.delete(professionalInstitutions).where(eq(professionalInstitutions.institutionId, institutionId));
    const people = [manager, alice, bruno, carla].filter(Boolean);
    await db.delete(professionals).where(inArray(professionals.id, people.map((p) => p.professionalId)));
    await db.delete(monthlyRosters).where(eq(monthlyRosters.institutionId, institutionId));
    await db.delete(scheduleContexts).where(eq(scheduleContexts.institutionId, institutionId));
    await db.delete(sectors).where(eq(sectors.id, sectorId));
    await db.delete(hospitals).where(eq(hospitals.id, hospitalId));
    await db.delete(institutions).where(eq(institutions.id, institutionId));
    await db.delete(users).where(inArray(users.id, people.map((p) => p.userId)));
  });

  it("deriveShiftStatus: sem ativa → VAGO; alguma OCUPADO → OCUPADO; senão PENDENTE", () => {
    expect(deriveShiftStatus([])).toBe("VAGO");
    expect(deriveShiftStatus(["PENDENTE"])).toBe("PENDENTE");
    expect(deriveShiftStatus(["PENDENTE", "OCUPADO"])).toBe("OCUPADO");
  });

  it("publica com ciência recalculada e audita a fotografia de todos os setores", async () => {
    const yearMonth = "2034-11";
    const report = await getCorporateReadinessReport(db!, {
      institutionId,
      hospitalId,
      yearMonth,
    });

    await appRouter.createCaller(ctxFor(manager, "manager")).shifts.publish({
      institutionId,
      hospitalId,
      yearMonth,
      readinessAcknowledgement: {
        snapshotHash: report.snapshotHash,
        issueCodes: report.acknowledgement.issueCodes,
      },
    });

    const [roster] = await db!
      .select({ status: monthlyRosters.status })
      .from(monthlyRosters)
      .where(
        and(
          eq(monthlyRosters.institutionId, institutionId),
          eq(monthlyRosters.hospitalId, hospitalId),
          eq(monthlyRosters.yearMonth, yearMonth),
        ),
      )
      .limit(1);
    expect(roster?.status).toBe("PUBLISHED");

    const [audit] = await db!
      .select({
        institutionId: auditTrail.institutionId,
        hospitalId: auditTrail.hospitalId,
        metadata: auditTrail.metadata,
      })
      .from(auditTrail)
      .where(
        and(
          eq(auditTrail.institutionId, institutionId),
          eq(auditTrail.action, "ROSTER_PUBLISHED"),
        ),
      )
      .orderBy(auditTrail.id)
      .limit(1);
    expect(audit).toMatchObject({ institutionId, hospitalId });
    expect(audit?.metadata).toMatchObject({
      yearMonth,
      previousStatus: "DRAFT",
      readiness: {
        reportVersion: "v1",
        snapshotHash: report.snapshotHash,
        issueCodes: report.acknowledgement.issueCodes,
      },
    });
    expect((audit?.metadata as any)?.readiness?.operationalWarnings).toEqual(
      expect.arrayContaining([expect.objectContaining({ sectorId })]),
    );
  });

  it("recusa fotografia de prontidão vencida por mudança real sem criar roster ou auditoria", async () => {
    const yearMonth = "2034-12";
    const report = await getCorporateReadinessReport(db!, {
      institutionId,
      hospitalId,
      yearMonth,
    });
    const changedShiftId = await createShift(
      "2034-12-03",
      "Mudança após revisão",
      "07:00:00",
      "13:00:00",
    );
    extraShiftIds.push(changedShiftId);

    await expect(
      appRouter.createCaller(ctxFor(manager, "manager")).shifts.publish({
        institutionId,
        hospitalId,
        yearMonth,
        readinessAcknowledgement: {
          snapshotHash: report.snapshotHash,
          issueCodes: report.acknowledgement.issueCodes,
        },
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    const rosters = await db!
      .select({ id: monthlyRosters.id })
      .from(monthlyRosters)
      .where(
        and(
          eq(monthlyRosters.institutionId, institutionId),
          eq(monthlyRosters.hospitalId, hospitalId),
          eq(monthlyRosters.yearMonth, yearMonth),
        ),
      );
    expect(rosters).toHaveLength(0);
    const audits = await db!
      .select({ id: auditTrail.id })
      .from(auditTrail)
      .where(
        and(
          eq(auditTrail.institutionId, institutionId),
          eq(auditTrail.action, "ROSTER_PUBLISHED"),
        ),
      );
    expect(audits).toHaveLength(1);
  });

  it("assignDirect devolve o assignmentId real e o turno vira OCUPADO", async () => {
    const caller = editorRouter.createCaller(ctxFor(manager, "manager"));
    const result = await caller.assignDirect({
      shiftInstanceId: directShiftId,
      professionalId: alice.professionalId,
      assignmentType: "ON_DUTY",
      reason: "teste transação",
    });
    const rows = await db!
      .select()
      .from(shiftAssignmentsV2)
      .where(and(eq(shiftAssignmentsV2.shiftInstanceId, directShiftId), eq(shiftAssignmentsV2.isActive, true)));
    expect(rows).toHaveLength(1);
    expect(result.assignmentId).toBe(rows[0].id);
    const [shift] = await db!.select().from(shiftInstances).where(eq(shiftInstances.id, directShiftId));
    expect(shift.status).toBe("OCUPADO");
  });

  it("assumeVacancy concorrente: só um ganha, o outro recebe CONFLICT", async () => {
    const callerB = appRouter.createCaller(ctxFor(bruno, "doctor"));
    const callerC = appRouter.createCaller(ctxFor(carla, "doctor"));
    const results = await Promise.allSettled([
      callerB.shiftAssignments.assumeVacancy({ shiftInstanceId: raceShiftId }),
      callerC.shiftAssignments.assumeVacancy({ shiftInstanceId: raceShiftId }),
    ]);
    const ok = results.filter((r) => r.status === "fulfilled");
    const failed = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(String(failed[0].reason?.message)).toMatch(/assumido por outro|não está disponível/);

    const active = await db!
      .select()
      .from(shiftAssignmentsV2)
      .where(and(eq(shiftAssignmentsV2.shiftInstanceId, raceShiftId), eq(shiftAssignmentsV2.isActive, true)));
    expect(active).toHaveLength(1);
    const [shift] = await db!.select().from(shiftInstances).where(eq(shiftInstances.id, raceShiftId));
    expect(shift.status).toBe("PENDENTE");
  });

  it("assumeVacancy concorrente: o mesmo profissional não ganha dois turnos sobrepostos", async () => {
    // Inícios em meses diferentes são deliberados: cada chamada trava uma
    // monthly_roster distinta. Assim, somente o mutex por profissional pode
    // serializar a disputa e tornar esta regressão load-bearing.
    const firstShiftId = await createShift("2027-06-30", "Overlap A", "22:00:00", "04:00:00");
    const secondShiftId = await createShift("2027-07-01", "Overlap B", "00:00:00", "06:00:00");
    extraShiftIds.push(firstShiftId, secondShiftId);
    const caller = appRouter.createCaller(ctxFor(alice, "doctor"));

    const results = await Promise.allSettled([
      caller.shiftAssignments.assumeVacancy({ shiftInstanceId: firstShiftId }),
      caller.shiftAssignments.assumeVacancy({ shiftInstanceId: secondShiftId }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const failures = results.filter((result) => result.status === "rejected") as PromiseRejectedResult[];
    expect(failures).toHaveLength(1);
    expect(String(failures[0].reason?.message)).toMatch(/Conflito de horário/);

    const active = await db!
      .select({ shiftInstanceId: shiftAssignmentsV2.shiftInstanceId })
      .from(shiftAssignmentsV2)
      .where(
        and(
          inArray(shiftAssignmentsV2.shiftInstanceId, [firstShiftId, secondShiftId]),
          eq(shiftAssignmentsV2.isActive, true),
        ),
      );
    expect(active).toHaveLength(1);
  });

  it("assignDirect concorrente cruza meses sem duplicar a agenda profissional", async () => {
    const firstShiftId = await createShift("2027-08-31", "Editor overlap A", "22:00:00", "04:00:00");
    const secondShiftId = await createShift("2027-09-01", "Editor overlap B", "00:00:00", "06:00:00");
    extraShiftIds.push(firstShiftId, secondShiftId);
    const caller = editorRouter.createCaller(ctxFor(manager, "manager"));

    const results = await Promise.allSettled([
      caller.assignDirect({
        shiftInstanceId: firstShiftId,
        professionalId: carla.professionalId,
        assignmentType: "ON_DUTY",
      }),
      caller.assignDirect({
        shiftInstanceId: secondShiftId,
        professionalId: carla.professionalId,
        assignmentType: "ON_DUTY",
      }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const failures = results.filter((result) => result.status === "rejected") as PromiseRejectedResult[];
    expect(failures).toHaveLength(1);
    expect(String(failures[0].reason?.message)).toMatch(/Conflito de horário/);

    const active = await db!
      .select({ id: shiftAssignmentsV2.id })
      .from(shiftAssignmentsV2)
      .where(
        and(
          inArray(shiftAssignmentsV2.shiftInstanceId, [firstShiftId, secondShiftId]),
          eq(shiftAssignmentsV2.professionalId, carla.professionalId),
          eq(shiftAssignmentsV2.isActive, true),
        ),
      );
    expect(active).toHaveLength(1);
  });

  it("approveAssignment: aprova uma vez, segunda tentativa → CONFLICT; turno OCUPADO", async () => {
    const [pending] = await db!
      .select()
      .from(shiftAssignmentsV2)
      .where(and(eq(shiftAssignmentsV2.shiftInstanceId, raceShiftId), eq(shiftAssignmentsV2.isActive, true)));
    const caller = appRouter.createCaller(ctxFor(manager, "manager"));
    const first = await caller.shiftInstances.approveAssignment({ assignmentId: pending.id });
    expect(first).toBeTruthy();
    await expect(
      caller.shiftInstances.approveAssignment({ assignmentId: pending.id }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    const [shift] = await db!.select().from(shiftInstances).where(eq(shiftInstances.id, raceShiftId));
    expect(shift.status).toBe("OCUPADO");
  });

  it("approveAssignment revalida overlap depois de esperar o lock mensal", async () => {
    const targetShiftId = await createShift("2027-04-05", "Aprovação alvo", "07:00:00", "13:00:00", "PENDENTE");
    const conflictShiftId = await createShift("2027-04-05", "Conflito tardio", "09:00:00", "15:00:00", "OCUPADO");
    extraShiftIds.push(targetShiftId, conflictShiftId);
    const [pending] = await db!
      .insert(shiftAssignmentsV2)
      .values({
        shiftInstanceId: targetShiftId,
        institutionId,
        hospitalId,
        sectorId,
        professionalId: bruno.professionalId,
        assignmentType: "ON_DUTY",
        status: "PENDENTE",
        isActive: true,
        createdBy: bruno.userId,
      })
      .$returningId();
    await db!.insert(monthlyRosters).values({
      institutionId,
      hospitalId,
      yearMonth: "2027-04",
      status: "DRAFT",
    });

    let releaseLock!: () => void;
    let rowLocked!: () => void;
    const release = new Promise<void>((resolve) => { releaseLock = resolve; });
    const locked = new Promise<void>((resolve) => { rowLocked = resolve; });
    const locker = db!.transaction(async (tx) => {
      await tx
        .update(monthlyRosters)
        .set({ status: "DRAFT" })
        .where(
          and(
            eq(monthlyRosters.institutionId, institutionId),
            eq(monthlyRosters.hospitalId, hospitalId),
            eq(monthlyRosters.yearMonth, "2027-04"),
          ),
        );
      rowLocked();
      await release;
    });

    await locked;
    let settled = false;
    const approval = appRouter
      .createCaller(ctxFor(manager, "manager"))
      .shiftInstances.approveAssignment({ assignmentId: pending.id })
      .then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      )
      .finally(() => { settled = true; });
    try {
      await new Promise((resolve) => setTimeout(resolve, 75));
      expect(settled).toBe(false);
      await db!.insert(shiftAssignmentsV2).values({
        shiftInstanceId: conflictShiftId,
        institutionId,
        hospitalId,
        sectorId,
        professionalId: bruno.professionalId,
        assignmentType: "ON_DUTY",
        status: "OCUPADO",
        isActive: true,
        createdBy: manager.userId,
      });
    } finally {
      releaseLock();
    }
    await locker;

    const outcome = await approval;
    expect(outcome).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
    const [after] = await db!
      .select({ status: shiftAssignmentsV2.status })
      .from(shiftAssignmentsV2)
      .where(eq(shiftAssignmentsV2.id, pending.id));
    expect(after.status).toBe("PENDENTE");
  });

  it("shifts.update não move turno ocupado para uma janela conflitante", async () => {
    const existingShiftId = await createShift("2027-05-07", "Janela existente", "07:00:00", "13:00:00", "OCUPADO");
    const movableShiftId = await createShift("2027-05-07", "Janela móvel", "14:00:00", "20:00:00", "OCUPADO");
    extraShiftIds.push(existingShiftId, movableShiftId);
    await db!.insert(shiftAssignmentsV2).values([
      {
        shiftInstanceId: existingShiftId,
        institutionId,
        hospitalId,
        sectorId,
        professionalId: carla.professionalId,
        assignmentType: "ON_DUTY" as const,
        status: "OCUPADO",
        isActive: true,
        createdBy: manager.userId,
      },
      {
        shiftInstanceId: movableShiftId,
        institutionId,
        hospitalId,
        sectorId,
        professionalId: carla.professionalId,
        assignmentType: "ON_DUTY" as const,
        status: "OCUPADO",
        isActive: true,
        createdBy: manager.userId,
      },
    ]);

    const caller = appRouter.createCaller(ctxFor(manager, "manager"));
    await expect(
      caller.shifts.update({
        id: movableShiftId,
        startAt: at("2027-05-07", "12:00:00").toISOString(),
        endAt: at("2027-05-07", "18:00:00").toISOString(),
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    const [after] = await db!
      .select({ startAt: shiftInstances.startAt, endAt: shiftInstances.endAt })
      .from(shiftInstances)
      .where(eq(shiftInstances.id, movableShiftId));
    expect(after.startAt.getTime()).toBe(at("2027-05-07", "14:00:00").getTime());
    expect(after.endAt.getTime()).toBe(at("2027-05-07", "20:00:00").getTime());
  });

  it("accept concorrente da mesma oferta: só um aceita, version incrementa", async () => {
    const callerB = swapRouter.createCaller(ctxFor(bruno, "doctor"));
    const callerC = swapRouter.createCaller(ctxFor(carla, "doctor"));
    const results = await Promise.allSettled([
      callerB.accept({ swapRequestId }),
      callerC.accept({ swapRequestId }),
    ]);
    const ok = results.filter((r) => r.status === "fulfilled");
    const failed = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(String(failed[0].reason?.message)).toMatch(/respondida por outra pessoa|esperava PENDING/);

    const [swap] = await db!.select().from(swapRequests).where(eq(swapRequests.id, swapRequestId));
    expect(swap.status).toBe("APPROVED");
    expect(swap.version).toBe(2);
    expect([bruno.professionalId, carla.professionalId]).toContain(swap.toProfessionalId);

    const active = await db!
      .select()
      .from(shiftAssignmentsV2)
      .where(and(eq(shiftAssignmentsV2.shiftInstanceId, swapShiftId), eq(shiftAssignmentsV2.isActive, true)));
    expect(active).toHaveLength(1);
    expect(active[0].professionalId).toBe(swap.toProfessionalId);

    const callerAlice = swapRouter.createCaller(ctxFor(alice, "doctor"));
    await expect(callerAlice.approveByOwner({ swapRequestId })).rejects.toBeTruthy();
  });

  it("banco rejeita segunda escala ativa e preserva histórico inativo", async () => {
    await expect(
      db!.insert(scheduleContexts).values({
        institutionId,
        hospitalId,
        sectorId,
        admissionPolicy: "ALL_CFM_SPECIALTIES",
        medicalSpecialtyId: null,
        operationalProfileCode: null,
        active: true,
      }),
    ).rejects.toThrow();

    const [historical] = await db!
      .insert(scheduleContexts)
      .values({
        institutionId,
        hospitalId,
        sectorId,
        admissionPolicy: "ALL_CFM_SPECIALTIES",
        medicalSpecialtyId: null,
        operationalProfileCode: null,
        active: false,
      })
      .$returningId();
    expect(historical.id).toBeGreaterThan(0);
  });

  it("não permite que um recibo confirme blocker estrutural", async () => {
    const yearMonth = "2035-01";
    const [unclassifiedShift] = await db!
      .insert(shiftInstances)
      .values({
        institutionId,
        hospitalId,
        sectorId,
        scheduleContextId: null,
        label: "Sem escala operacional",
        startAt: at("2035-01-05", "07:00:00"),
        endAt: at("2035-01-05", "13:00:00"),
        status: "VAGO",
        createdBy: manager.userId,
      })
      .$returningId();
    extraShiftIds.push(unclassifiedShift.id);
    const report = await getCorporateReadinessReport(db!, {
      institutionId,
      hospitalId,
      yearMonth,
    });
    expect(report.summary.SECURITY_BLOCKER).toBeGreaterThan(0);

    await expect(
      appRouter.createCaller(ctxFor(manager, "manager")).shifts.publish({
        institutionId,
        hospitalId,
        yearMonth,
        readinessAcknowledgement: {
          snapshotHash: report.snapshotHash,
          issueCodes: report.acknowledgement.issueCodes,
        },
      }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

    const rosters = await db!
      .select({ id: monthlyRosters.id })
      .from(monthlyRosters)
      .where(
        and(
          eq(monthlyRosters.institutionId, institutionId),
          eq(monthlyRosters.hospitalId, hospitalId),
          eq(monthlyRosters.yearMonth, yearMonth),
        ),
      );
    expect(rosters).toHaveLength(0);
  });
});

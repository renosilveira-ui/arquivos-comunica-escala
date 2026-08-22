// tests/transactions.test.ts — integridade transacional (Onda 1 · A1)
//
// Cobre: assignDirect devolve o id certo (sem LAST_INSERT_ID em outra
// chamada); assumeVacancy concorrente (só um ganha); aceite concorrente
// da mesma oferta (só um ganha, version incrementa); aprovar duas vezes
// → CONFLICT; status do turno derivado das alocações.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
  swapRequests,
  users,
} from "../drizzle/schema";
import { getDb } from "../server/db";
import { editorRouter } from "../server/editor";
import { appRouter } from "../server/routers";
import { swapRouter } from "../server/swap-router";
import { deriveShiftStatus } from "../server/shift-status";

const OFFSET = "-03:00";
const at = (date: string, time: string) => new Date(`${date}T${time}${OFFSET}`);

type Person = { userId: number; professionalId: number; name: string };

describe("integridade transacional", () => {
  let db: Awaited<ReturnType<typeof getDb>>;
  let institutionId: number;
  let hospitalId: number;
  let sectorId: number;
  let manager: Person;
  let alice: Person;
  let bruno: Person;
  let carla: Person;
  let raceShiftId: number; // VAGO: corrida de assumeVacancy
  let directShiftId: number; // VAGO: assignDirect
  let swapShiftId: number; // OCUPADO por Alice: corrida de accept
  let swapRequestId: number;

  const ctxFor = (p: Person, role: string) =>
    ({
      user: { id: p.userId, role, name: p.name, email: `${p.userId}@test.local` },
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
      .values({ userId: u.id, name: `Tx ${tag} ${stamp}`, role: "Médico", userRole: userRole as any })
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
      .values({ institutionId, hospitalId, sectorId, label, startAt, endAt, status, createdBy: manager.userId })
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
  });

  afterAll(async () => {
    if (!db) return;
    await db.delete(swapRequests).where(eq(swapRequests.institutionId, institutionId));
    const shiftIds = [raceShiftId, directShiftId, swapShiftId].filter(Boolean);
    if (shiftIds.length) {
      await db.delete(auditTrail).where(inArray(auditTrail.shiftInstanceId, shiftIds));
      await db.delete(shiftAuditLog).where(inArray(shiftAuditLog.shiftInstanceId, shiftIds));
      await db.delete(shiftAssignmentsV2).where(inArray(shiftAssignmentsV2.shiftInstanceId, shiftIds));
      await db.delete(shiftInstances).where(inArray(shiftInstances.id, shiftIds));
    }
    await db.delete(auditTrail).where(eq(auditTrail.institutionId, institutionId));
    await db.delete(professionalAccess).where(eq(professionalAccess.institutionId, institutionId));
    await db.delete(managerScope).where(eq(managerScope.institutionId, institutionId));
    await db.delete(professionalInstitutions).where(eq(professionalInstitutions.institutionId, institutionId));
    const people = [manager, alice, bruno, carla].filter(Boolean);
    await db.delete(professionals).where(inArray(professionals.id, people.map((p) => p.professionalId)));
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
    expect(swap.status).toBe("ACCEPTED");
    expect(swap.version).toBe(2);
    expect([bruno.professionalId, carla.professionalId]).toContain(swap.toProfessionalId);
  });

  it("approveByOwner efetiva a cessão atomicamente e não efetiva duas vezes", async () => {
    const callerAlice = swapRouter.createCaller(ctxFor(alice, "doctor"));
    await callerAlice.approveByOwner({ swapRequestId });
    const [swap] = await db!.select().from(swapRequests).where(eq(swapRequests.id, swapRequestId));
    expect(swap.status).toBe("APPROVED");
    expect(swap.version).toBe(3);

    const active = await db!
      .select()
      .from(shiftAssignmentsV2)
      .where(and(eq(shiftAssignmentsV2.shiftInstanceId, swapShiftId), eq(shiftAssignmentsV2.isActive, true)));
    expect(active).toHaveLength(1);
    expect(active[0].professionalId).toBe(swap.toProfessionalId);
    const [shift] = await db!.select().from(shiftInstances).where(eq(shiftInstances.id, swapShiftId));
    expect(shift.status).toBe("OCUPADO");

    await expect(callerAlice.approveByOwner({ swapRequestId })).rejects.toBeTruthy();
  });
});

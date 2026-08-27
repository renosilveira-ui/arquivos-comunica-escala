// tests/shifts-replicate.test.ts — shifts.replicateRange (Onda 1 · A2)
//
// Cobre: cópia de TODOS os campos estruturados, idempotência pela chave
// natural, dryRun sem escrita, mês preservando dia da semana, cópia de
// alocações respeitando conflito de horário e permissão.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, gte, inArray, lt } from "drizzle-orm";
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
  shiftInstances,
  users,
} from "../drizzle/schema";
import {
  ensureTestAnesthesiaSpecialty,
  openTestScale,
} from "./helpers/open-test-scale";
import { getDb } from "../server/db";
import { shiftsRouter } from "../server/shifts-crud";

const OFFSET = "-03:00";
const at = (date: string, time: string) => new Date(`${date}T${time}${OFFSET}`);
const localWeekday = (d: Date) => new Date(d.getTime() - 3 * 60 * 60 * 1000).getUTCDay();

describe("shifts.replicateRange", () => {
  let db: Awaited<ReturnType<typeof getDb>>;
  let institutionId: number;
  let hospitalId: number;
  let sectorId: number;
  let reverseSectorId: number;
  let scheduleContextId: number;
  let reverseScheduleContextId: number;
  let anesthesiaId: number;
  let managerUserId: number;
  let managerProfessionalId: number;
  let doctorUserId: number;
  let doctorProfessionalId: number;
  const createdShiftIds: number[] = [];

  // Semana de origem: 07/09/2026 (segunda) → 13/09. Destino: 14/09 (segunda).
  const FROM_WEEK = "2026-09-07";
  const TO_WEEK = "2026-09-14";

  const callerFor = (userId: number, role: string) =>
    shiftsRouter.createCaller({
      user: { id: userId, role, name: "Teste", email: "teste@test.local", sessionVersion: 1 },
      institutionId,
      allowedInstitutionIds: [institutionId],
    } as any);

  beforeAll(async () => {
    db = await getDb();
    if (!db) throw new Error("Database not available");
    const stamp = Date.now();

    const [institution] = await db
      .insert(institutions)
      .values({
        name: `Replicar Tenant ${stamp}`,
        cnpj: `${stamp}`.slice(-14).padStart(14, "0"),
        legalName: `Replicar Tenant ${stamp}`,
        tradeName: `RP${stamp}`.slice(0, 20),
        isActive: true,
      })
      .$returningId();
    institutionId = institution.id;

    const [hospital] = await db
      .insert(hospitals)
      .values({ institutionId, name: `Replicar Hospital ${stamp}` })
      .$returningId();
    hospitalId = hospital.id;

    const [sector] = await db
      .insert(sectors)
      .values({
        institutionId,
        hospitalId,
        name: `Replicar Setor ${stamp}`,
        category: "cirurgico",
        color: "#2563EB",
      })
      .$returningId();
    sectorId = sector.id;
    const [reverseSector] = await db
      .insert(sectors)
      .values({
        institutionId,
        hospitalId,
        name: `Replicar Setor Inverso ${stamp}`,
        category: "cirurgico",
        color: "#7C3AED",
      })
      .$returningId();
      reverseSectorId = reverseSector.id;
    anesthesiaId = await ensureTestAnesthesiaSpecialty(db);
    scheduleContextId = await openTestScale(db, {
      institutionId,
      hospitalId,
      sectorId,
    });
    reverseScheduleContextId = await openTestScale(db, {
      institutionId,
      hospitalId,
      sectorId: reverseSectorId,
    });

    const [managerUser] = await db
      .insert(users)
      .values({
        name: `Replicar Gestor ${stamp}`,
        email: `replicar-gestor-${stamp}@test.local`,
        passwordHash: "test",
        role: "manager",
      })
      .$returningId();
    managerUserId = managerUser.id;
    const [managerProfessional] = await db
      .insert(professionals)
      .values({ userId: managerUserId, name: `Replicar Gestor ${stamp}`, role: "Gestor", userRole: "GESTOR_PLUS" })
      .$returningId();
    managerProfessionalId = managerProfessional.id;

    const [doctorUser] = await db
      .insert(users)
      .values({
        name: `Replicar Médico ${stamp}`,
        email: `replicar-medico-${stamp}@test.local`,
        passwordHash: "test",
        role: "doctor",
      })
      .$returningId();
    doctorUserId = doctorUser.id;
    const [doctorProfessional] = await db
      .insert(professionals)
      .values({ userId: doctorUserId, name: `Replicar Médico ${stamp}`, role: "Médico", userRole: "USER", medicalSpecialtyId: anesthesiaId, specialty: "Anestesiologia" })
      .$returningId();
    doctorProfessionalId = doctorProfessional.id;

    await db.insert(professionalInstitutions).values([
      {
        professionalId: managerProfessionalId,
        userId: managerUserId,
        institutionId,
        roleInInstitution: "GESTOR_PLUS",
        isPrimary: true,
        active: true,
      },
      {
        professionalId: doctorProfessionalId,
        userId: doctorUserId,
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
    await db.insert(professionalAccess).values({
      institutionId,
      professionalId: doctorProfessionalId,
      hospitalId,
      sectorId,
      canAccess: true,
    });

    // Origem: 3 turnos na semana de 07/09 com campos estruturados.
    const sources = [
      { date: "2026-09-07", label: "Manhã", start: "07:00:00", end: "13:00:00", modality: "PLANTAO" as const, coverage: "URGENCIA_EMERGENCIA" as const },
      { date: "2026-09-09", label: "Noite", start: "19:00:00", end: "07:00:00", modality: "SOBREAVISO" as const, coverage: null },
      { date: "2026-09-12", label: "Tarde", start: "13:00:00", end: "19:00:00", modality: "PLANTAO" as const, coverage: "ELETIVAS" as const },
    ];
    for (const s of sources) {
      const startAt = at(s.date, s.start);
      const endAt = at(s.date, s.end);
      if (endAt <= startAt) endAt.setUTCDate(endAt.getUTCDate() + 1);
      const [row] = await db
        .insert(shiftInstances)
        .values({
          institutionId,
          hospitalId,
          sectorId,
          scheduleContextId,
          label: s.label,
          specialty: "Anestesiologia",
          startAt,
          endAt,
          status: "VAGO",
          modality: s.modality,
          coverageType: s.coverage,
          paymentModel: "FIXO_PRODUTIVIDADE_TETO",
          productivityCapBrl: "1500.00",
          createdBy: managerUserId,
        })
        .$returningId();
      createdShiftIds.push(row.id);
    }
    // Alocação ativa no turno da Noite (09/09).
    await db
      .update(shiftInstances)
      .set({ status: "OCUPADO" })
      .where(eq(shiftInstances.id, createdShiftIds[1]));
    await db.insert(shiftAssignmentsV2).values({
      shiftInstanceId: createdShiftIds[1],
      institutionId,
      hospitalId,
      sectorId,
      professionalId: doctorProfessionalId,
      assignmentType: "ON_CALL",
      status: "OCUPADO",
      isActive: true,
      createdBy: managerUserId,
    });
  });

  afterAll(async () => {
    if (!db) return;
    const allShifts = await db
      .select({ id: shiftInstances.id })
      .from(shiftInstances)
      .where(eq(shiftInstances.institutionId, institutionId));
    const ids = allShifts.map((s) => s.id);
    if (ids.length) {
      await db.delete(shiftAssignmentsV2).where(inArray(shiftAssignmentsV2.shiftInstanceId, ids));
      await db.delete(shiftInstances).where(inArray(shiftInstances.id, ids));
    }
    await db.delete(auditTrail).where(eq(auditTrail.institutionId, institutionId));
    await db.delete(monthlyRosters).where(eq(monthlyRosters.institutionId, institutionId));
    await db.delete(professionalAccess).where(eq(professionalAccess.institutionId, institutionId));
    await db.delete(managerScope).where(eq(managerScope.institutionId, institutionId));
    await db.delete(professionalInstitutions).where(eq(professionalInstitutions.institutionId, institutionId));
    await db.delete(professionals).where(inArray(professionals.id, [managerProfessionalId, doctorProfessionalId]));
    await db.delete(scheduleContexts).where(inArray(scheduleContexts.id, [scheduleContextId, reverseScheduleContextId]));
    await db.delete(sectors).where(inArray(sectors.id, [sectorId, reverseSectorId]));
    await db.delete(hospitals).where(eq(hospitals.id, hospitalId));
    await db.delete(institutions).where(eq(institutions.id, institutionId));
    await db.delete(users).where(inArray(users.id, [managerUserId, doctorUserId]));
  });

  const countTargetWeek = async () => {
    const rows = await db!
      .select({ id: shiftInstances.id })
      .from(shiftInstances)
      .where(
        and(
          eq(shiftInstances.institutionId, institutionId),
          gte(shiftInstances.startAt, at(TO_WEEK, "00:00:00")),
        ),
      );
    return rows.length;
  };

  it("dryRun conta sem escrever nada", async () => {
    const caller = callerFor(managerUserId, "manager");
    const r = await caller.replicateRange({
      hospitalId,
      from: { start: FROM_WEEK, granularity: "week" },
      to: { start: TO_WEEK },
      dryRun: true,
    });
    expect(r.created).toBe(3);
    expect(r.skipped).toBe(0);
    expect(r.dryRun).toBe(true);
    expect(await countTargetWeek()).toBe(0);
  });

  it("copia a semana com todos os campos estruturados, deslocando 7 dias", async () => {
    const caller = callerFor(managerUserId, "manager");
    const r = await caller.replicateRange({
      hospitalId,
      from: { start: FROM_WEEK, granularity: "week" },
      to: { start: TO_WEEK },
    });
    expect(r.created).toBe(3);
    expect(r.assignmentsCopied).toBe(0);

    const copies = await db!
      .select()
      .from(shiftInstances)
      .where(
        and(
          eq(shiftInstances.institutionId, institutionId),
          gte(shiftInstances.startAt, at(TO_WEEK, "00:00:00")),
        ),
      );
    expect(copies).toHaveLength(3);
    const noite = copies.find((c) => c.label === "Noite")!;
    expect(noite.startAt.getTime()).toBe(at("2026-09-16", "19:00:00").getTime());
    expect(noite.endAt.getTime()).toBe(at("2026-09-17", "07:00:00").getTime());
    expect(noite.modality).toBe("SOBREAVISO");
    expect(noite.coverageType).toBeNull();
    expect(noite.paymentModel).toBe("FIXO_PRODUTIVIDADE_TETO");
    expect(String(noite.productivityCapBrl)).toBe("1500.00");
    expect(noite.specialty).toBe("Anestesiologia");
    // Sem includeAssignments a cópia nasce VAGA mesmo que a origem esteja ocupada.
    expect(noite.status).toBe("VAGO");
    const manha = copies.find((c) => c.label === "Manhã")!;
    expect(manha.coverageType).toBe("URGENCIA_EMERGENCIA");

    const audits = await db!
      .select()
      .from(auditTrail)
      .where(eq(auditTrail.institutionId, institutionId));
    expect(audits.length).toBeGreaterThanOrEqual(1);
    expect(audits[audits.length - 1].description).toContain("Replicou 3 turnos");
  });

  it("é idempotente: rodar de novo não duplica (tudo skipped)", async () => {
    const caller = callerFor(managerUserId, "manager");
    const r = await caller.replicateRange({
      hospitalId,
      from: { start: FROM_WEEK, granularity: "week" },
      to: { start: TO_WEEK },
    });
    expect(r.created).toBe(0);
    expect(r.skipped).toBe(3);
    expect(await countTargetWeek()).toBe(3);
  });

  it("espera lockMonth concorrente e não replica nem audita após LOCKED", async () => {
    const targetStart = "2027-01-04";
    const targetEnd = at("2027-01-11", "00:00:00");
    const yearMonth = "2027-01";
    await db!.delete(monthlyRosters).where(
      and(
        eq(monthlyRosters.institutionId, institutionId),
        eq(monthlyRosters.hospitalId, hospitalId),
        eq(monthlyRosters.yearMonth, yearMonth),
      ),
    );
    await db!.insert(monthlyRosters).values({
      institutionId,
      hospitalId,
      yearMonth,
      status: "PUBLISHED",
    });
    const auditBefore = await db!
      .select({ id: auditTrail.id })
      .from(auditTrail)
      .where(eq(auditTrail.institutionId, institutionId));

    let releaseLock!: () => void;
    let rowLocked!: () => void;
    const release = new Promise<void>((resolve) => { releaseLock = resolve; });
    const locked = new Promise<void>((resolve) => { rowLocked = resolve; });
    const locker = db!.transaction(async (tx) => {
      await tx
        .update(monthlyRosters)
        .set({ status: "LOCKED" })
        .where(
          and(
            eq(monthlyRosters.institutionId, institutionId),
            eq(monthlyRosters.hospitalId, hospitalId),
            eq(monthlyRosters.yearMonth, yearMonth),
          ),
        );
      rowLocked();
      await release;
    });

    await locked;
    let settled = false;
    const replication = callerFor(managerUserId, "manager").replicateRange({
      hospitalId,
      from: { start: FROM_WEEK, granularity: "week" },
      to: { start: targetStart },
    }).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    ).finally(() => { settled = true; });
    try {
      await new Promise((resolve) => setTimeout(resolve, 75));
      expect(settled).toBe(false);
    } finally {
      releaseLock();
    }
    await locker;
    const outcome = await replication;
    expect(outcome).toMatchObject({ ok: false, error: { code: "BAD_REQUEST" } });

    const copies = await db!
      .select({ id: shiftInstances.id })
      .from(shiftInstances)
      .where(
        and(
          eq(shiftInstances.institutionId, institutionId),
          gte(shiftInstances.startAt, at(targetStart, "00:00:00")),
          lt(shiftInstances.startAt, targetEnd),
        ),
      );
    const auditAfter = await db!
      .select({ id: auditTrail.id })
      .from(auditTrail)
      .where(eq(auditTrail.institutionId, institutionId));
    expect(copies).toHaveLength(0);
    expect(auditAfter).toEqual(auditBefore);
  });

  it("duas replicações concorrentes não duplicam turnos nem alocações", async () => {
    const targetStart = "2027-02-01";
    const targetEnd = at("2027-02-08", "00:00:00");
    await db!.insert(monthlyRosters).values({
      institutionId,
      hospitalId,
      yearMonth: "2027-02",
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
            eq(monthlyRosters.yearMonth, "2027-02"),
          ),
        );
      rowLocked();
      await release;
    });

    await locked;
    let settled = 0;
    const caller = callerFor(managerUserId, "manager");
    const requests = [
      caller.replicateRange({
        hospitalId,
        from: { start: FROM_WEEK, granularity: "week" },
        to: { start: targetStart },
        includeAssignments: true,
      }).finally(() => { settled += 1; }),
      caller.replicateRange({
        hospitalId,
        from: { start: FROM_WEEK, granularity: "week" },
        to: { start: targetStart },
        includeAssignments: true,
      }).finally(() => { settled += 1; }),
    ];
    const outcomesPromise = Promise.allSettled(requests);
    try {
      await new Promise((resolve) => setTimeout(resolve, 75));
      expect(settled).toBe(0);
    } finally {
      releaseLock();
    }
    await locker;

    const outcomes = await outcomesPromise;
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const failures = outcomes.filter((outcome) => outcome.status === "rejected") as PromiseRejectedResult[];
    expect(failures).toHaveLength(1);
    expect(failures[0].reason).toMatchObject({ code: "CONFLICT" });

    const copies = await db!
      .select({ id: shiftInstances.id })
      .from(shiftInstances)
      .where(
        and(
          eq(shiftInstances.institutionId, institutionId),
          gte(shiftInstances.startAt, at(targetStart, "00:00:00")),
          lt(shiftInstances.startAt, targetEnd),
        ),
      );
    expect(copies).toHaveLength(3);
    const copiedAssignments = await db!
      .select({ id: shiftAssignmentsV2.id })
      .from(shiftAssignmentsV2)
      .where(inArray(shiftAssignmentsV2.shiftInstanceId, copies.map((copy) => copy.id)));
    expect(copiedAssignments).toHaveLength(1);
  });

  it("serializa replicações A→B e B→A sem deadlock", async () => {
    const reverseSourceStart = at("2027-03-01", "08:00:00");
    const reverseSourceEnd = at("2027-03-01", "14:00:00");
    await db!.insert(shiftInstances).values({
      institutionId,
      hospitalId,
      sectorId: reverseSectorId,
      scheduleContextId: reverseScheduleContextId,
      label: "Origem inversa",
      specialty: "Anestesiologia",
      startAt: reverseSourceStart,
      endAt: reverseSourceEnd,
      status: "VAGO",
      createdBy: managerUserId,
    });

    await db!.delete(monthlyRosters).where(
      and(
        eq(monthlyRosters.institutionId, institutionId),
        eq(monthlyRosters.hospitalId, hospitalId),
        inArray(monthlyRosters.yearMonth, ["2026-09", "2027-03"]),
      ),
    );
    await db!.insert(monthlyRosters).values([
      { institutionId, hospitalId, yearMonth: "2026-09", status: "DRAFT" },
      { institutionId, hospitalId, yearMonth: "2027-03", status: "DRAFT" },
    ]);

    const holdRoster = (yearMonth: string) => {
      let release!: () => void;
      let markLocked!: () => void;
      const released = new Promise<void>((resolve) => { release = resolve; });
      const locked = new Promise<void>((resolve) => { markLocked = resolve; });
      const transaction = db!.transaction(async (tx) => {
        await tx
          .update(monthlyRosters)
          .set({ status: "DRAFT" })
          .where(
            and(
              eq(monthlyRosters.institutionId, institutionId),
              eq(monthlyRosters.hospitalId, hospitalId),
              eq(monthlyRosters.yearMonth, yearMonth),
            ),
          );
        markLocked();
        await released;
      });
      return { release, locked, transaction };
    };
    const sourceMonthLock = holdRoster("2026-09");
    const reverseMonthLock = holdRoster("2027-03");
    await Promise.all([sourceMonthLock.locked, reverseMonthLock.locked]);

    let settled = 0;
    const caller = callerFor(managerUserId, "manager");
    const requests = [
      caller.replicateRange({
        hospitalId,
        sectorId,
        from: { start: "2026-09-07", granularity: "week" },
        to: { start: "2027-03-01" },
      }).finally(() => { settled += 1; }),
      caller.replicateRange({
        hospitalId,
        sectorId: reverseSectorId,
        from: { start: "2027-03-01", granularity: "week" },
        to: { start: "2026-09-07" },
      }).finally(() => { settled += 1; }),
    ];
    const outcomesPromise = Promise.allSettled(requests);
    try {
      await new Promise((resolve) => setTimeout(resolve, 75));
      expect(settled).toBe(0);
    } finally {
      sourceMonthLock.release();
      reverseMonthLock.release();
    }
    await Promise.all([sourceMonthLock.transaction, reverseMonthLock.transaction]);

    const outcomes = await outcomesPromise;
    expect(outcomes).toHaveLength(2);
    expect(outcomes.every((outcome) => outcome.status === "fulfilled")).toBe(true);
    const created = outcomes.map((outcome) =>
      outcome.status === "fulfilled" ? outcome.value.created : 0,
    );
    expect(created.sort((left, right) => left - right)).toEqual([1, 3]);
    await db!.delete(shiftInstances).where(
      and(
        eq(shiftInstances.institutionId, institutionId),
        eq(shiftInstances.label, "Origem inversa"),
      ),
    );
  });

  it("permite replicar de origem LOCKED e mantém o lock de origem", async () => {
    await db!.insert(shiftInstances).values({
      institutionId,
      hospitalId,
      sectorId: reverseSectorId,
      scheduleContextId: reverseScheduleContextId,
      label: "Origem bloqueada",
      specialty: "Anestesiologia",
      startAt: at("2027-05-03", "08:00:00"),
      endAt: at("2027-05-03", "14:00:00"),
      status: "VAGO",
      createdBy: managerUserId,
    });
    await db!.delete(monthlyRosters).where(
      and(
        eq(monthlyRosters.institutionId, institutionId),
        eq(monthlyRosters.hospitalId, hospitalId),
        inArray(monthlyRosters.yearMonth, ["2027-05", "2027-06"]),
      ),
    );
    await db!.insert(monthlyRosters).values([
      { institutionId, hospitalId, yearMonth: "2027-05", status: "LOCKED" },
      { institutionId, hospitalId, yearMonth: "2027-06", status: "DRAFT" },
    ]);

    const result = await callerFor(managerUserId, "manager").replicateRange({
      hospitalId,
      sectorId: reverseSectorId,
      from: { start: "2027-05-03", granularity: "week" },
      to: { start: "2027-06-07" },
    });
    expect(result.created).toBe(1);

    const [sourceRoster] = await db!
      .select({ status: monthlyRosters.status })
      .from(monthlyRosters)
      .where(
        and(
          eq(monthlyRosters.institutionId, institutionId),
          eq(monthlyRosters.hospitalId, hospitalId),
          eq(monthlyRosters.yearMonth, "2027-05"),
        ),
      );
    expect(sourceRoster.status).toBe("LOCKED");
  });

  it("replicateWeek (compatibilidade) delega e devolve created", async () => {
    const caller = callerFor(managerUserId, "manager");
    const r = await caller.replicateWeek({
      hospitalId,
      fromStartDate: FROM_WEEK,
      toStartDate: "2026-09-21",
    });
    expect(r.created).toBe(3);
  });

  it("mês: preserva o dia da semana e fica dentro do mês de destino", async () => {
    const caller = callerFor(managerUserId, "manager");
    // Origem: setembro/2026 (já tem 9 turnos: 3 originais + 6 cópias).
    const r = await caller.replicateRange({
      hospitalId,
      from: { start: "2026-09-01", granularity: "month" },
      to: { start: "2026-10-01" },
    });
    expect(r.created + r.outOfRange).toBe(9);
    expect(r.created).toBeGreaterThan(0);

    const october = await db!
      .select()
      .from(shiftInstances)
      .where(
        and(
          eq(shiftInstances.institutionId, institutionId),
          gte(shiftInstances.startAt, at("2026-10-01", "00:00:00")),
          lt(shiftInstances.startAt, at("2026-11-01", "00:00:00")),
        ),
      );
    expect(october).toHaveLength(r.created);
    for (const c of october) {
      expect(c.startAt.getTime()).toBeLessThan(at("2026-11-01", "00:00:00").getTime());
      // Noite é sempre quarta (09/09, 16/09, 23/09 na origem).
      if (c.label === "Noite") expect(localWeekday(c.startAt)).toBe(3);
      if (c.label === "Manhã") expect(localWeekday(c.startAt)).toBe(1);
      if (c.label === "Tarde") expect(localWeekday(c.startAt)).toBe(6);
    }
  });

  it("includeAssignments copia alocações sem conflito e deixa VAGO quando há conflito", async () => {
    const caller = callerFor(managerUserId, "manager");
    // Destino: semana de 02/11/2026. Cria um turno já ocupado pelo médico
    // na quarta 04/11 à noite (mesmo horário da cópia da Noite) → conflito.
    const blockerStart = at("2026-11-04", "19:00:00");
    const blockerEnd = at("2026-11-05", "07:00:00");
    const [blocker] = await db!
      .insert(shiftInstances)
      .values({
        institutionId,
        hospitalId,
        sectorId,
        scheduleContextId,
        label: "Outro plantão",
        startAt: blockerStart,
        endAt: blockerEnd,
        status: "OCUPADO",
        createdBy: managerUserId,
      })
      .$returningId();
    await db!.insert(shiftAssignmentsV2).values({
      shiftInstanceId: blocker.id,
      institutionId,
      hospitalId,
      sectorId,
      professionalId: doctorProfessionalId,
      assignmentType: "ON_DUTY",
      status: "OCUPADO",
      isActive: true,
      createdBy: managerUserId,
    });

    const conflictRun = await caller.replicateRange({
      hospitalId,
      from: { start: FROM_WEEK, granularity: "week" },
      to: { start: "2026-11-02" },
      includeAssignments: true,
    });
    expect(conflictRun.created).toBe(3);
    expect(conflictRun.conflicts).toBe(1);
    expect(conflictRun.assignmentsCopied).toBe(0);

    // Semana livre: 09/11 → a alocação da Noite é copiada e o turno nasce OCUPADO.
    const okRun = await caller.replicateRange({
      hospitalId,
      from: { start: FROM_WEEK, granularity: "week" },
      to: { start: "2026-11-09" },
      includeAssignments: true,
    });
    expect(okRun.created).toBe(3);
    expect(okRun.conflicts).toBe(0);
    expect(okRun.assignmentsCopied).toBe(1);

    const copiedNoite = await db!
      .select()
      .from(shiftInstances)
      .where(
        and(
          eq(shiftInstances.institutionId, institutionId),
          eq(shiftInstances.startAt, at("2026-11-11", "19:00:00")),
        ),
      );
    expect(copiedNoite).toHaveLength(1);
    expect(copiedNoite[0].status).toBe("OCUPADO");
    const copiedAssignments = await db!
      .select()
      .from(shiftAssignmentsV2)
      .where(eq(shiftAssignmentsV2.shiftInstanceId, copiedNoite[0].id));
    expect(copiedAssignments).toHaveLength(1);
    expect(copiedAssignments[0].professionalId).toBe(doctorProfessionalId);
    expect(copiedAssignments[0].assignmentType).toBe("ON_CALL");
  });

  it("origem e destino iguais → BAD_REQUEST; sem turnos na origem → NOT_FOUND", async () => {
    const caller = callerFor(managerUserId, "manager");
    await expect(
      caller.replicateRange({
        hospitalId,
        from: { start: FROM_WEEK, granularity: "week" },
        to: { start: FROM_WEEK },
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      caller.replicateRange({
        hospitalId,
        from: { start: "2025-01-05", granularity: "week" },
        to: { start: "2025-01-12" },
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("sessionVersion obsoleto reverte replicação, rosters e auditoria", async () => {
    const sourceStart = at("2032-01-05", "08:00:00");
    const sourceEnd = at("2032-01-05", "14:00:00");
    const [source] = await db!
      .insert(shiftInstances)
      .values({
        institutionId,
        hospitalId,
        sectorId,
        scheduleContextId,
        label: "Replicação com sessão obsoleta",
        specialty: "Anestesiologia",
        startAt: sourceStart,
        endAt: sourceEnd,
        status: "VAGO",
        createdBy: managerUserId,
      })
      .$returningId();
    createdShiftIds.push(source.id);
    const rosterBefore = await db!
      .select({ id: monthlyRosters.id, status: monthlyRosters.status, version: monthlyRosters.version })
      .from(monthlyRosters)
      .where(
        and(
          eq(monthlyRosters.institutionId, institutionId),
          eq(monthlyRosters.hospitalId, hospitalId),
          inArray(monthlyRosters.yearMonth, ["2032-01", "2032-02"]),
        ),
      );
    const auditBefore = await db!
      .select({ id: auditTrail.id })
      .from(auditTrail)
      .where(eq(auditTrail.institutionId, institutionId));

    await db!
      .update(users)
      .set({ sessionVersion: 2 })
      .where(eq(users.id, managerUserId));
    try {
      await expect(
        callerFor(managerUserId, "manager").replicateRange({
          hospitalId,
          sectorId,
          from: { start: "2032-01-05", granularity: "week" },
          to: { start: "2032-02-02" },
        }),
      ).rejects.toMatchObject({
        code: "CONFLICT",
        message: expect.stringMatching(/sessão.*revogada/i),
      });
    } finally {
      await db!
        .update(users)
        .set({ sessionVersion: 1 })
        .where(eq(users.id, managerUserId));
    }

    const target = await db!
      .select({ id: shiftInstances.id })
      .from(shiftInstances)
      .where(
        and(
          eq(shiftInstances.institutionId, institutionId),
          eq(shiftInstances.hospitalId, hospitalId),
          eq(shiftInstances.sectorId, sectorId),
          eq(shiftInstances.label, "Replicação com sessão obsoleta"),
          gte(shiftInstances.startAt, at("2032-02-02", "00:00:00")),
          lt(shiftInstances.startAt, at("2032-02-09", "00:00:00")),
        ),
      );
    expect(target).toHaveLength(0);
    expect(
      await db!
        .select({ id: monthlyRosters.id, status: monthlyRosters.status, version: monthlyRosters.version })
        .from(monthlyRosters)
        .where(
          and(
            eq(monthlyRosters.institutionId, institutionId),
            eq(monthlyRosters.hospitalId, hospitalId),
            inArray(monthlyRosters.yearMonth, ["2032-01", "2032-02"]),
          ),
        ),
    ).toEqual(rosterBefore);
    expect(
      await db!
        .select({ id: auditTrail.id })
        .from(auditTrail)
        .where(eq(auditTrail.institutionId, institutionId)),
    ).toEqual(auditBefore);
  });

  it("rosterStatus: DRAFT sem registro → PUBLISHED após publicar → LOCKED após bloquear", async () => {
    const caller = callerFor(managerUserId, "manager");
    const before = await caller.rosterStatus({ hospitalId, yearMonth: "2026-12" });
    expect(before.status).toBe("DRAFT");
    await caller.publish({ institutionId, hospitalId, yearMonth: "2026-12" });
    const published = await caller.rosterStatus({ hospitalId, yearMonth: "2026-12" });
    expect(published.status).toBe("PUBLISHED");
    expect(published.publishedAt).toBeTruthy();
    await caller.lock({ institutionId, hospitalId, yearMonth: "2026-12" });
    const locked = await caller.rosterStatus({ hospitalId, yearMonth: "2026-12" });
    expect(locked.status).toBe("LOCKED");
  });

  it("cria calendário mensal sem alocações e aplica filtros no relógio BRT", async () => {
    const caller = callerFor(managerUserId, "manager");
    const noWeekends = await caller.replicateMonthCalendar({
      hospitalId, sectorId, sourceMonth: "2026-09", targetMonth: "2033-01",
      rule: "REMOVE_WEEKENDS", dryRun: true,
    });
    expect(noWeekends.candidates.every((candidate) =>
      localWeekday(new Date(candidate.startAt)) !== 0 && localWeekday(new Date(candidate.startAt)) !== 6,
    )).toBe(true);

    const custom = await caller.replicateMonthCalendar({
      hospitalId, sectorId, sourceMonth: "2026-09", targetMonth: "2033-02",
      rule: "CUSTOM", includeShiftIds: [createdShiftIds[1]],
    });
    expect(custom.created).toBe(1);
    const [copy] = await db!.select().from(shiftInstances).where(and(
      eq(shiftInstances.institutionId, institutionId),
      eq(shiftInstances.label, "Noite"),
      gte(shiftInstances.startAt, at("2033-02-01", "00:00:00")),
      lt(shiftInstances.startAt, at("2033-03-01", "00:00:00")),
    ));
    expect(copy.status).toBe("VAGO");
    expect((await db!.select().from(shiftAssignmentsV2).where(eq(shiftAssignmentsV2.shiftInstanceId, copy.id)))).toHaveLength(0);
  });

  it("rejeita mês alvo já preenchido sem sobrescrever", async () => {
    const caller = callerFor(managerUserId, "manager");
    await db!.insert(shiftInstances).values({
      institutionId, hospitalId, sectorId, scheduleContextId, label: "Já existente",
      startAt: at("2033-03-01", "08:00:00"), endAt: at("2033-03-01", "14:00:00"),
      status: "VAGO", createdBy: managerUserId,
    });
    await expect(caller.replicateMonthCalendar({
      hospitalId, sectorId, sourceMonth: "2026-09", targetMonth: "2033-03", rule: "FULL",
    })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("médico comum não pode replicar", async () => {
    const caller = callerFor(doctorUserId, "doctor");
    await expect(
      caller.replicateRange({
        hospitalId,
        from: { start: FROM_WEEK, granularity: "week" },
        to: { start: "2026-12-07" },
        dryRun: true,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

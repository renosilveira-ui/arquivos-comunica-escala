import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { and, eq, inArray, like } from "drizzle-orm";
import { getDb } from "../server/db";
import {
  auditTrail,
  hospitals,
  institutions,
  monthlyRosters,
  notifications,
  professionals,
  sectors,
  shiftAssignmentsV2,
  shiftInstances,
  swapRequests,
} from "../drizzle/schema";
import { swapRouter } from "../server/swap-router";
import { yearMonthFromDate } from "../lib/date-utils";
import { yearMonthBrt } from "../server/local-time";
import { openTestScale } from "./helpers/open-test-scale";

vi.mock("../server/integrations/comunica-plus", () => ({
  enqueueComunicaSwapApproved: vi.fn(async () => 1),
}));

/**
 * Fluxo cessão sem gestor (docs/product/escala-ux.md §6).
 *
 * O endpoint canônico de aprovação é `swaps.approveByOwner`: quem
 * ofertou o plantão (A) aprova a candidatura, sem passar por gestor.
 * `swaps.approve` e `swaps.rejectByManager` existem apenas como contratos
 * legados deny-only: gestor acompanha o histórico, sem decidir ou bloquear.
 *
 * Estes testes blindam:
 *   1. Apenas o dono do plantão pode chamar `approveByOwner`.
 *   2. Estado deve ser ACCEPTED (não PENDING ou já APPROVED).
 *   3. Revalidação H1/H2 acontece na efetivação (anti-overlap).
 *   4. CESSAO funciona identicamente a TRANSFER (alias semântico).
 *   5. Após aprovação, as assignments são reatribuídas e o swap_request
 *      vai para APPROVED com reviewedByUserId = dono.
 */

const FIXTURE_PREFIX = "cessao-test-";

describe("Cessão sem gestor (approveByOwner)", () => {
  let db: Awaited<ReturnType<typeof getDb>>;
  let institutionId: number;
  let hospitalId: number;
  let sectorId: number;
  let scheduleContextId: number;
  let userAId: number;
  let userBId: number;
  let proAId: number;
  let proBId: number;
  const rosterMonths = new Set<string>();

  // Janela base afastada do seed compartilhado e dos fixtures de
  // anti-overlap-h1-h2 (que usa +30 dias). Aqui usamos +45 dias.
  const at = (h: number, dayOffset = 0): Date => {
    const d = new Date();
    d.setDate(d.getDate() + 45 + dayOffset);
    d.setHours(h, 0, 0, 0);
    return d;
  };

  beforeAll(async () => {
    db = await getDb();
    if (!db) throw new Error("Database not available");

    const [institution] = await db.select().from(institutions).limit(1);
    const [hospital] = await db
      .select()
      .from(hospitals)
      .where(eq(hospitals.institutionId, institution!.id))
      .limit(1);
    const [sector] = await db
      .select()
      .from(sectors)
      .where(eq(sectors.name, "Centro Cirúrgico"))
      .limit(1);
    institutionId = institution!.id;
    hospitalId = hospital!.id;
    sectorId = sector!.id;
    scheduleContextId = await openTestScale(db, {
      institutionId,
      hospitalId,
      sectorId,
    });

    const [pedro] = await db
      .select()
      .from(professionals)
      .where(eq(professionals.name, "Dr. Pedro Costa"))
      .limit(1);
    const [ana] = await db
      .select()
      .from(professionals)
      .where(eq(professionals.name, "Dra. Ana Lima"))
      .limit(1);
    if (!pedro || !ana) throw new Error("Profissionais do seed não encontrados");
    proAId = pedro.id;
    proBId = ana.id;
    userAId = pedro.userId!;
    userBId = ana.userId!;

    // Cleanup fixtures anteriores deste arquivo.
    await cleanupFixtures();
  });

  afterAll(async () => {
    if (!db) return;
    await cleanupFixtures();
  });

  afterEach(async () => {
    if (!db) return;
    for (const yearMonth of rosterMonths) {
      await db.delete(monthlyRosters).where(
        and(
          eq(monthlyRosters.institutionId, institutionId),
          eq(monthlyRosters.hospitalId, hospitalId),
          eq(monthlyRosters.yearMonth, yearMonth),
        ),
      );
    }
    rosterMonths.clear();
  });

  async function cleanupFixtures(): Promise<void> {
    if (!db) return;
    const oldShifts = await db
      .select({ id: shiftInstances.id, startAt: shiftInstances.startAt })
      .from(shiftInstances)
      .where(
        and(
          eq(shiftInstances.institutionId, institutionId),
          like(shiftInstances.label, `${FIXTURE_PREFIX}%`),
        ),
    );
    for (const s of oldShifts) {
      await db.delete(auditTrail).where(eq(auditTrail.shiftInstanceId, s.id));
      await db.delete(notifications).where(eq(notifications.shiftInstanceId, s.id));
      await db.delete(swapRequests).where(eq(swapRequests.fromShiftInstanceId, s.id));
      await db.delete(shiftAssignmentsV2).where(eq(shiftAssignmentsV2.shiftInstanceId, s.id));
      await db.delete(shiftInstances).where(eq(shiftInstances.id, s.id));
    }
    for (const yearMonth of new Set(oldShifts.map((shift) => yearMonthFromDate(shift.startAt)))) {
      await db.delete(monthlyRosters).where(
        and(
          eq(monthlyRosters.institutionId, institutionId),
          eq(monthlyRosters.hospitalId, hospitalId),
          eq(monthlyRosters.yearMonth, yearMonth),
        ),
      );
    }
  }

  /**
   * Cria um cenário CESSAO já em estado ACCEPTED:
   * - shiftA (atribuído a Pedro/proA via assignmentA)
   * - shiftB (atribuído a Ana/proB via assignmentB) — usado se SWAP
   * - swap_request com fromUserId=Pedro, toUserId=Ana, status=ACCEPTED
   * Retorna IDs dos artefatos criados.
   */
  async function setupAcceptedSwap(opts: {
    type: "CESSAO" | "TRANSFER" | "SWAP";
    dayOffset?: number;
  }): Promise<{
    shiftAId: number;
    shiftBId: number | null;
    assignmentAId: number;
    assignmentBId: number | null;
    swapId: number;
  }> {
    if (!db) throw new Error("Database not available");
    const offset = opts.dayOffset ?? 0;

    const [resA] = await db.insert(shiftInstances).values({
      institutionId,
      hospitalId,
      sectorId,
      scheduleContextId,
      label: `${FIXTURE_PREFIX}A-${opts.type}-${offset}`,
      startAt: at(8, offset),
      endAt: at(14, offset),
      status: "OCUPADO",
    });
    const shiftAId = (resA as any).insertId as number;

    const [resAssignA] = await db.insert(shiftAssignmentsV2).values({
      shiftInstanceId: shiftAId,
      institutionId,
      hospitalId,
      sectorId,
      professionalId: proAId,
      assignmentType: "ON_DUTY",
      status: "OCUPADO",
      isActive: true,
    });
    const assignmentAId = (resAssignA as any).insertId as number;

    let shiftBId: number | null = null;
    let assignmentBId: number | null = null;
    if (opts.type === "SWAP") {
      const [resB] = await db.insert(shiftInstances).values({
        institutionId,
        hospitalId,
        sectorId,
        scheduleContextId,
        label: `${FIXTURE_PREFIX}B-${opts.type}-${offset}`,
        startAt: at(15, offset),
        endAt: at(21, offset),
        status: "OCUPADO",
      });
      shiftBId = (resB as any).insertId as number;

      const [resAssignB] = await db.insert(shiftAssignmentsV2).values({
        shiftInstanceId: shiftBId,
        institutionId,
        hospitalId,
        sectorId,
        professionalId: proBId,
        assignmentType: "ON_DUTY",
        status: "OCUPADO",
        isActive: true,
      });
      assignmentBId = (resAssignB as any).insertId as number;
    }

    for (const startAt of [at(8, offset), ...(opts.type === "SWAP" ? [at(15, offset)] : [])]) {
      const yearMonth = yearMonthBrt(startAt);
      rosterMonths.add(yearMonth);
      await db
        .insert(monthlyRosters)
        .values({ institutionId, hospitalId, yearMonth, status: "PUBLISHED" })
        .onDuplicateKeyUpdate({ set: { status: "PUBLISHED" } });
    }

    const [resSwap] = await db.insert(swapRequests).values({
      type: opts.type,
      status: "ACCEPTED",
      fromProfessionalId: proAId,
      fromUserId: userAId,
      fromShiftInstanceId: shiftAId,
      fromAssignmentId: assignmentAId,
      toProfessionalId: proBId,
      toUserId: userBId,
      toShiftInstanceId: shiftBId,
      toAssignmentId: assignmentBId,
      institutionId,
      hospitalId,
      sectorId,
    });
    const swapId = (resSwap as any).insertId as number;

    return { shiftAId, shiftBId, assignmentAId, assignmentBId, swapId };
  }

  function callerAs(userId: number, role = "doctor") {
    return swapRouter.createCaller({
      user: { id: userId, role, name: "Tester", email: `${userId}@test.local` },
      institutionId,
      allowedInstitutionIds: [institutionId],
    } as any);
  }

  it("dono (A) pode aprovar a própria cessão; assignments são reatribuídas", async () => {
    const { shiftAId, swapId, assignmentAId } = await setupAcceptedSwap({ type: "CESSAO", dayOffset: 1 });

    const caller = callerAs(userAId);
    const result = await caller.approveByOwner({ swapRequestId: swapId });
    expect(result).toEqual({ ok: true });

    // Assignment original (Pedro) desativado
    const [oldAssign] = await db!
      .select()
      .from(shiftAssignmentsV2)
      .where(eq(shiftAssignmentsV2.id, assignmentAId));
    expect(oldAssign.isActive).toBe(false);

    // Novo assignment (Ana) ativo no shiftA
    const newAssignments = await db!
      .select()
      .from(shiftAssignmentsV2)
      .where(
        and(
          eq(shiftAssignmentsV2.shiftInstanceId, shiftAId),
          eq(shiftAssignmentsV2.professionalId, proBId),
          eq(shiftAssignmentsV2.isActive, true),
        ),
      );
    expect(newAssignments).toHaveLength(1);
    expect(newAssignments[0].status).toBe("OCUPADO");

    // Swap request marcado APPROVED com reviewedBy = userAId (dono)
    const [swap] = await db!.select().from(swapRequests).where(eq(swapRequests.id, swapId));
    expect(swap.status).toBe("APPROVED");
    expect(swap.reviewedByUserId).toBe(userAId);
    expect(swap.reviewedAt).toBeTruthy();
    const [audit] = await db!
      .select({ action: auditTrail.action, metadata: auditTrail.metadata })
      .from(auditTrail)
      .where(
        and(
          eq(auditTrail.institutionId, institutionId),
          eq(auditTrail.entityId, swapId),
          eq(auditTrail.action, "CESSAO_APPROVED_BY_OWNER"),
        ),
      );
    expect(audit.action).toBe("CESSAO_APPROVED_BY_OWNER");
    expect(audit.metadata).toMatchObject({ approvalPath: "OWNER" });
  });

  it("não-dono (B) é bloqueado com FORBIDDEN", async () => {
    const { swapId } = await setupAcceptedSwap({ type: "CESSAO", dayOffset: 2 });

    const caller = callerAs(userBId);
    await expect(caller.approveByOwner({ swapRequestId: swapId })).rejects.toThrow(
      /Apenas o dono do plantão original/,
    );

    // Estado preservado
    const [swap] = await db!.select().from(swapRequests).where(eq(swapRequests.id, swapId));
    expect(swap.status).toBe("ACCEPTED");
  });

  it("rejeita aprovação se status !== ACCEPTED", async () => {
    const { swapId } = await setupAcceptedSwap({ type: "CESSAO", dayOffset: 3 });
    // Forçar PENDING
    await db!.update(swapRequests).set({ status: "PENDING" }).where(eq(swapRequests.id, swapId));

    const caller = callerAs(userAId);
    await expect(caller.approveByOwner({ swapRequestId: swapId })).rejects.toThrow(/esperava ACCEPTED/);
  });

  it("revalida H1/H2 — bloqueia se receptor adquiriu plantão conflitante", async () => {
    const { swapId } = await setupAcceptedSwap({ type: "CESSAO", dayOffset: 4 });

    // Ana ganha um plantão conflitante (mesma janela do shiftA) entre o aceite e a aprovação.
    const [conflictShift] = await db!.insert(shiftInstances).values({
      institutionId,
      hospitalId,
      sectorId,
      scheduleContextId,
      label: `${FIXTURE_PREFIX}conflict-4`,
      startAt: at(10, 4),
      endAt: at(16, 4),
      status: "OCUPADO",
    });
    const conflictShiftId = (conflictShift as any).insertId as number;
    await db!.insert(shiftAssignmentsV2).values({
      shiftInstanceId: conflictShiftId,
      institutionId,
      hospitalId,
      sectorId,
      professionalId: proBId,
      assignmentType: "ON_DUTY",
      status: "OCUPADO",
      isActive: true,
    });

    const caller = callerAs(userAId);
    await expect(caller.approveByOwner({ swapRequestId: swapId })).rejects.toThrow(/Conflito de horário/);

    // Estado intacto: swap continua ACCEPTED
    const [swap] = await db!.select().from(swapRequests).where(eq(swapRequests.id, swapId));
    expect(swap.status).toBe("ACCEPTED");
  });

  it("CESSAO e TRANSFER seguem o mesmo caminho (alias semântico)", async () => {
    const transfer = await setupAcceptedSwap({ type: "TRANSFER", dayOffset: 5 });
    const cessao = await setupAcceptedSwap({ type: "CESSAO", dayOffset: 6 });

    const caller = callerAs(userAId);
    await expect(caller.approveByOwner({ swapRequestId: transfer.swapId })).resolves.toEqual({ ok: true });
    await expect(caller.approveByOwner({ swapRequestId: cessao.swapId })).resolves.toEqual({ ok: true });
  });

  it("rejeita aprovação se a oferta já expirou", async () => {
    const { swapId } = await setupAcceptedSwap({ type: "CESSAO", dayOffset: 8 });
    // Força expiry no passado
    await db!
      .update(swapRequests)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(swapRequests.id, swapId));

    const caller = callerAs(userAId);
    await expect(caller.approveByOwner({ swapRequestId: swapId })).rejects.toThrow(
      /expirada/i,
    );
  });

  it("rejeita aprovação se o roster do mês está LOCKED", async () => {
    const { swapId, shiftAId } = await setupAcceptedSwap({ type: "CESSAO", dayOffset: 9 });

    const [shift] = await db!
      .select({ startAt: shiftInstances.startAt })
      .from(shiftInstances)
      .where(eq(shiftInstances.id, shiftAId));
    const ym = yearMonthFromDate(shift.startAt);
    rosterMonths.add(ym);

    // Insere/atualiza roster como LOCKED
    await db!
      .delete(monthlyRosters)
      .where(
        and(
          eq(monthlyRosters.institutionId, institutionId),
          eq(monthlyRosters.hospitalId, hospitalId),
          eq(monthlyRosters.yearMonth, ym),
        ),
      );
    await db!.insert(monthlyRosters).values({
      institutionId,
      hospitalId,
      yearMonth: ym,
      status: "LOCKED",
    });

    const caller = callerAs(userAId);
    await expect(caller.approveByOwner({ swapRequestId: swapId })).rejects.toThrow(
      /trancada/i,
    );

    // Cleanup do roster pra não vazar para outros testes
    await db!
      .delete(monthlyRosters)
      .where(
        and(
          eq(monthlyRosters.institutionId, institutionId),
          eq(monthlyRosters.hospitalId, hospitalId),
          eq(monthlyRosters.yearMonth, ym),
        ),
      );
  });

  it("serializa a efetivação com lockMonth concorrente e preserva a cessão", async () => {
    const { swapId, shiftAId, assignmentAId } = await setupAcceptedSwap({
      type: "CESSAO",
      dayOffset: 10,
    });
    const [shift] = await db!
      .select({ startAt: shiftInstances.startAt })
      .from(shiftInstances)
      .where(eq(shiftInstances.id, shiftAId));
    const ym = yearMonthFromDate(shift.startAt);
    rosterMonths.add(ym);
    await db!.delete(monthlyRosters).where(
      and(
        eq(monthlyRosters.institutionId, institutionId),
        eq(monthlyRosters.hospitalId, hospitalId),
        eq(monthlyRosters.yearMonth, ym),
      ),
    );
    await db!.insert(monthlyRosters).values({
      institutionId,
      hospitalId,
      yearMonth: ym,
      status: "PUBLISHED",
    });

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
            eq(monthlyRosters.yearMonth, ym),
          ),
        );
      rowLocked();
      await release;
    });

    await locked;
    let settled = false;
    const approval = callerAs(userAId).approveByOwner({ swapRequestId: swapId })
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
    const outcome = await approval;
    expect(outcome).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });

    const [swap] = await db!.select().from(swapRequests).where(eq(swapRequests.id, swapId));
    const [original] = await db!
      .select({ isActive: shiftAssignmentsV2.isActive })
      .from(shiftAssignmentsV2)
      .where(eq(shiftAssignmentsV2.id, assignmentAId));
    const replacements = await db!
      .select({ id: shiftAssignmentsV2.id })
      .from(shiftAssignmentsV2)
      .where(
        and(
          eq(shiftAssignmentsV2.shiftInstanceId, shiftAId),
          eq(shiftAssignmentsV2.professionalId, proBId),
          eq(shiftAssignmentsV2.isActive, true),
        ),
      );
    expect(swap.status).toBe("ACCEPTED");
    expect(original.isActive).toBe(true);
    expect(replacements).toHaveLength(0);
  });

  it("SWAP recusa atomicamente quando o segundo mês está LOCKED", async () => {
    const fixture = await setupAcceptedSwap({ type: "SWAP", dayOffset: 11 });
    const secondStart = at(15, 50);
    const secondEnd = at(21, 50);
    await db!
      .update(shiftInstances)
      .set({ startAt: secondStart, endAt: secondEnd })
      .where(eq(shiftInstances.id, fixture.shiftBId!));
    const secondYm = yearMonthFromDate(secondStart);
    rosterMonths.add(yearMonthFromDate(at(8, 11)));
    rosterMonths.add(secondYm);
    await db!.delete(monthlyRosters).where(
      and(
        eq(monthlyRosters.institutionId, institutionId),
        eq(monthlyRosters.hospitalId, hospitalId),
        eq(monthlyRosters.yearMonth, secondYm),
      ),
    );
    await db!.insert(monthlyRosters).values({
      institutionId,
      hospitalId,
      yearMonth: secondYm,
      status: "LOCKED",
    });

    await expect(
      callerAs(userAId).approveByOwner({ swapRequestId: fixture.swapId }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const originals = await db!
      .select({ id: shiftAssignmentsV2.id, isActive: shiftAssignmentsV2.isActive })
      .from(shiftAssignmentsV2)
      .where(
        inArray(shiftAssignmentsV2.id, [fixture.assignmentAId, fixture.assignmentBId!]),
      );
    const [swap] = await db!
      .select({ status: swapRequests.status })
      .from(swapRequests)
      .where(eq(swapRequests.id, fixture.swapId));
    expect(originals).toHaveLength(2);
    expect(originals.every((assignment) => assignment.isActive)).toBe(true);
    expect(swap.status).toBe("ACCEPTED");
  });

  it("SWAP bidirecional: ambas as assignments são trocadas", async () => {
    const { shiftAId, shiftBId, assignmentAId, assignmentBId, swapId } = await setupAcceptedSwap({
      type: "SWAP",
      dayOffset: 7,
    });
    expect(shiftBId).not.toBeNull();
    expect(assignmentBId).not.toBeNull();

    const caller = callerAs(userAId);
    await expect(caller.approveByOwner({ swapRequestId: swapId })).resolves.toEqual({ ok: true });

    // Originals desativadas
    const [oldA] = await db!.select().from(shiftAssignmentsV2).where(eq(shiftAssignmentsV2.id, assignmentAId));
    const [oldB] = await db!.select().from(shiftAssignmentsV2).where(eq(shiftAssignmentsV2.id, assignmentBId!));
    expect(oldA.isActive).toBe(false);
    expect(oldB.isActive).toBe(false);

    // Novas assignments cruzadas: Ana no shiftA, Pedro no shiftB
    const newOnA = await db!
      .select()
      .from(shiftAssignmentsV2)
      .where(
        and(
          eq(shiftAssignmentsV2.shiftInstanceId, shiftAId),
          eq(shiftAssignmentsV2.professionalId, proBId),
          eq(shiftAssignmentsV2.isActive, true),
        ),
      );
    const newOnB = await db!
      .select()
      .from(shiftAssignmentsV2)
      .where(
        and(
          eq(shiftAssignmentsV2.shiftInstanceId, shiftBId!),
          eq(shiftAssignmentsV2.professionalId, proAId),
          eq(shiftAssignmentsV2.isActive, true),
        ),
      );
    expect(newOnA).toHaveLength(1);
    expect(newOnB).toHaveLength(1);
  });
});

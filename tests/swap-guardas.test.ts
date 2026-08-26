// tests/swap-guardas.test.ts — auditoria 22/08, achados A2 e M5.
//
// - Uma oferta aberta por alocação (offer → CONFLICT se já existe PENDING/ACCEPTED).
// - Efetivar só desativa a alocação de origem se ela ainda estiver ativa;
//   a segunda efetivação sobre a mesma alocação → CONFLICT, sem segundo titular.
// - O tipo da alocação (ON_CALL/BACKUP/ON_DUTY) é preservado na efetivação.
//
// Fixtures no mesmo padrão de cessao-flow.test.ts (seed: Pedro/Ana), janela
// +60 dias para não colidir com os outros arquivos.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, like } from "drizzle-orm";
import { getDb } from "../server/db";
import { hospitals, institutions, monthlyRosters, professionals, sectors, shiftAssignmentsV2, shiftInstances, swapRequests } from "../drizzle/schema";
import { swapRouter } from "../server/swap-router";
import { yearMonthBrt } from "../server/local-time";

vi.mock("../server/integrations/comunica-plus", () => ({
  enqueueComunicaSwapApproved: vi.fn(async () => 1),
}));

const PREFIX = "swap-guardas-";

describe("swaps: guardas de alocação ativa, oferta única e tipo preservado", () => {
  let db: NonNullable<Awaited<ReturnType<typeof getDb>>>;
  let institutionId: number;
  let hospitalId: number;
  let sectorId: number;
  let userAId: number;
  let userBId: number;
  let proAId: number;
  let proBId: number;
  let userCId: number;
  let proCId: number;

  const at = (h: number, dayOffset = 0): Date => {
    const d = new Date();
    d.setDate(d.getDate() + 60 + dayOffset);
    d.setHours(h, 0, 0, 0);
    return d;
  };

  async function cleanup() {
    const old = await db
      .select({ id: shiftInstances.id, startAt: shiftInstances.startAt })
      .from(shiftInstances)
      .where(and(eq(shiftInstances.institutionId, institutionId), like(shiftInstances.label, `${PREFIX}%`)));
    for (const s of old) {
      await db.delete(swapRequests).where(eq(swapRequests.fromShiftInstanceId, s.id));
      await db.delete(shiftAssignmentsV2).where(eq(shiftAssignmentsV2.shiftInstanceId, s.id));
      await db.delete(shiftInstances).where(eq(shiftInstances.id, s.id));
    }
    for (const yearMonth of new Set(old.map(({ startAt }) => yearMonthBrt(startAt)))) {
      await db.delete(monthlyRosters).where(
        and(
          eq(monthlyRosters.institutionId, institutionId),
          eq(monthlyRosters.hospitalId, hospitalId),
          eq(monthlyRosters.yearMonth, yearMonth),
        ),
      );
    }
  }

  beforeAll(async () => {
    const conn = await getDb();
    if (!conn) throw new Error("Database not available");
    db = conn;
    const [institution] = await db.select().from(institutions).limit(1);
    const [hospital] = await db.select().from(hospitals).where(eq(hospitals.institutionId, institution!.id)).limit(1);
    const [sector] = await db.select().from(sectors).where(eq(sectors.name, "Centro Cirúrgico")).limit(1);
    institutionId = institution!.id;
    hospitalId = hospital!.id;
    sectorId = sector!.id;
    const [pedro] = await db.select().from(professionals).where(eq(professionals.name, "Dr. Pedro Costa")).limit(1);
    const [ana] = await db.select().from(professionals).where(eq(professionals.name, "Dra. Ana Lima")).limit(1);
    const [maria] = await db.select().from(professionals).where(eq(professionals.name, "Dra. Maria Santos")).limit(1);
    if (!pedro || !ana || !maria) throw new Error("Profissionais do seed não encontrados");
    proAId = pedro.id;
    proBId = ana.id;
    proCId = maria.id;
    userAId = pedro.userId!;
    userBId = ana.userId!;
    userCId = maria.userId!;
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
  });

  function callerAs(userId: number) {
    return swapRouter.createCaller({
      user: { id: userId, role: "doctor", name: "Tester", email: `${userId}@test.local` },
      institutionId,
      allowedInstitutionIds: [institutionId],
    } as any);
  }

  async function shiftWithA(opts: { dayOffset: number; type?: "ON_DUTY" | "ON_CALL" | "BACKUP"; label: string }) {
    const startAt = at(8, opts.dayOffset);
    await db
      .insert(monthlyRosters)
      .values({ institutionId, hospitalId, yearMonth: yearMonthBrt(startAt), status: "PUBLISHED" })
      .onDuplicateKeyUpdate({ set: { status: "PUBLISHED" } });
    const [s] = await db
      .insert(shiftInstances)
      .values({ institutionId, hospitalId, sectorId, label: `${PREFIX}${opts.label}`, startAt, endAt: at(14, opts.dayOffset), status: "OCUPADO" })
      .$returningId();
    const [a] = await db
      .insert(shiftAssignmentsV2)
      .values({ shiftInstanceId: s.id, institutionId, hospitalId, sectorId, professionalId: proAId, assignmentType: opts.type ?? "ON_DUTY", status: "OCUPADO", isActive: true })
      .$returningId();
    return { shiftId: s.id, assignmentId: a.id };
  }

  async function acceptedCessao(shiftId: number, assignmentId: number, to: { proId: number; userId: number } = { proId: proBId, userId: userBId }) {
    const [r] = await db
      .insert(swapRequests)
      .values({
        type: "CESSAO",
        status: "ACCEPTED",
        fromProfessionalId: proAId,
        fromUserId: userAId,
        fromShiftInstanceId: shiftId,
        fromAssignmentId: assignmentId,
        toProfessionalId: to.proId,
        toUserId: to.userId,
        institutionId,
        hospitalId,
        sectorId,
      })
      .$returningId();
    return r.id;
  }

  async function activeOnShift(shiftId: number) {
    return db
      .select({ professionalId: shiftAssignmentsV2.professionalId, assignmentType: shiftAssignmentsV2.assignmentType })
      .from(shiftAssignmentsV2)
      .where(and(eq(shiftAssignmentsV2.shiftInstanceId, shiftId), eq(shiftAssignmentsV2.isActive, true)));
  }

  it("A2: segunda efetivação sobre a mesma alocação → CONFLICT, sem segundo titular", async () => {
    const { shiftId, assignmentId } = await shiftWithA({ dayOffset: 1, label: "dupla" });
    // Duas ofertas ACCEPTED para a mesma alocação, receptores diferentes
    // (B e C) — o cenário da auditoria. Estado que a guarda de `offer`
    // passa a impedir; aqui simulado direto no banco.
    const swap1 = await acceptedCessao(shiftId, assignmentId);
    const swap2 = await acceptedCessao(shiftId, assignmentId, { proId: proCId, userId: userCId });

    await callerAs(userAId).approveByOwner({ swapRequestId: swap1 });
    await expect(callerAs(userAId).approveByOwner({ swapRequestId: swap2 })).rejects.toMatchObject({ code: "CONFLICT" });

    const active = await activeOnShift(shiftId);
    expect(active).toHaveLength(1);
    expect(active[0].professionalId).toBe(proBId);
    const [s2] = await db.select({ status: swapRequests.status }).from(swapRequests).where(eq(swapRequests.id, swap2));
    expect(s2.status).toBe("ACCEPTED"); // nada efetivado pela metade
  });

  it("A2: offer recusa segunda oferta aberta para a mesma alocação", async () => {
    const { shiftId, assignmentId } = await shiftWithA({ dayOffset: 2, label: "oferta-unica" });
    const first = await callerAs(userAId).offer({ type: "CESSAO", fromShiftInstanceId: shiftId, fromAssignmentId: assignmentId });
    expect(first).toBeTruthy();
    await expect(
      callerAs(userAId).offer({ type: "CESSAO", fromShiftInstanceId: shiftId, fromAssignmentId: assignmentId }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("M5: cessão de sobreaviso (ON_CALL) entrega ON_CALL ao receptor", async () => {
    const { shiftId, assignmentId } = await shiftWithA({ dayOffset: 3, type: "ON_CALL", label: "sobreaviso" });
    const swapId = await acceptedCessao(shiftId, assignmentId);
    await callerAs(userAId).approveByOwner({ swapRequestId: swapId });
    const active = await activeOnShift(shiftId);
    expect(active).toEqual([{ professionalId: proBId, assignmentType: "ON_CALL" }]);
  });
});

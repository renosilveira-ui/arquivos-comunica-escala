import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq, like } from "drizzle-orm";
import { getDb } from "../server/db";
import {
  hospitals,
  institutions,
  professionals,
  sectors,
  shiftAssignmentsV2,
  shiftInstances,
  swapRequests,
} from "../drizzle/schema";
import { swapRouter } from "../server/swap-router";

/**
 * `swaps.list` ganhou:
 *   - filtro `role`: OFFERER / RECEIVER / ANY (default ANY, comportamento legado)
 *   - flag `awaitingMyApproval`: true quando status=ACCEPTED && fromUserId=me.
 *
 * Isso destrava a tela "Minhas ofertas" do USER (consome
 * approveByOwner) sem fazer o client filtrar/comparar IDs.
 */

const FIXTURE_PREFIX = "list-role-test-";

describe("swaps.list — role filter + awaitingMyApproval", () => {
  let db: Awaited<ReturnType<typeof getDb>>;
  let institutionId: number;
  let hospitalId: number;
  let sectorId: number;
  let proAId: number;
  let proBId: number;
  let userAId: number;
  let userBId: number;
  let shiftAId: number;
  let assignmentAId: number;
  let pendingFromAId: number; // A é ofertante; status PENDING (sem candidato)
  let acceptedFromAId: number; // A é ofertante; status ACCEPTED (B aceitou)
  let pendingFromBId: number; // B é ofertante; A irrelevante

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

    await cleanupFixtures();

    // Cria shift de Pedro pra ofertar.
    const future = new Date();
    future.setDate(future.getDate() + 90);
    future.setHours(8, 0, 0, 0);
    const futureEnd = new Date(future);
    futureEnd.setHours(14, 0, 0, 0);

    const [resShift] = await db.insert(shiftInstances).values({
      institutionId,
      hospitalId,
      sectorId,
      label: `${FIXTURE_PREFIX}shift-A`,
      startAt: future,
      endAt: futureEnd,
      status: "OCUPADO",
    });
    shiftAId = (resShift as any).insertId as number;

    const [resAssign] = await db.insert(shiftAssignmentsV2).values({
      shiftInstanceId: shiftAId,
      institutionId,
      hospitalId,
      sectorId,
      professionalId: proAId,
      assignmentType: "ON_DUTY",
      status: "OCUPADO",
      isActive: true,
    });
    assignmentAId = (resAssign as any).insertId as number;

    // Swap 1: A ofertou, ninguém aceitou ainda (PENDING).
    const [resPending] = await db.insert(swapRequests).values({
      type: "CESSAO",
      status: "PENDING",
      fromProfessionalId: proAId,
      fromUserId: userAId,
      fromShiftInstanceId: shiftAId,
      fromAssignmentId: assignmentAId,
      institutionId,
      hospitalId,
      sectorId,
      reason: `${FIXTURE_PREFIX}pending-from-A`,
    });
    pendingFromAId = (resPending as any).insertId as number;

    // Swap 2: A ofertou, B aceitou (ACCEPTED → aguarda approveByOwner).
    const [resAccepted] = await db.insert(swapRequests).values({
      type: "CESSAO",
      status: "ACCEPTED",
      fromProfessionalId: proAId,
      fromUserId: userAId,
      fromShiftInstanceId: shiftAId,
      fromAssignmentId: assignmentAId,
      toProfessionalId: proBId,
      toUserId: userBId,
      institutionId,
      hospitalId,
      sectorId,
      reason: `${FIXTURE_PREFIX}accepted-from-A`,
    });
    acceptedFromAId = (resAccepted as any).insertId as number;

    // Swap 3: B é ofertante (cenário inverso, pra confirmar OFFERER
    // não vaza). Reaproveita o shift A só pra simplificar — irrelevante
    // pro filtro testado.
    const [resOther] = await db.insert(swapRequests).values({
      type: "CESSAO",
      status: "PENDING",
      fromProfessionalId: proBId,
      fromUserId: userBId,
      fromShiftInstanceId: shiftAId,
      fromAssignmentId: assignmentAId,
      institutionId,
      hospitalId,
      sectorId,
      reason: `${FIXTURE_PREFIX}pending-from-B`,
    });
    pendingFromBId = (resOther as any).insertId as number;
  });

  afterAll(async () => {
    if (!db) return;
    await cleanupFixtures();
  });

  async function cleanupFixtures(): Promise<void> {
    if (!db) return;
    // Remove swaps com reason que prefixa fixtures deste arquivo.
    await db.delete(swapRequests).where(like(swapRequests.reason, `${FIXTURE_PREFIX}%`));
    // Remove o shift e o assignment (ordem importa: assignment depois).
    const oldShifts = await db
      .select({ id: shiftInstances.id })
      .from(shiftInstances)
      .where(
        and(
          eq(shiftInstances.institutionId, institutionId),
          like(shiftInstances.label, `${FIXTURE_PREFIX}%`),
        ),
      );
    for (const s of oldShifts) {
      await db.delete(shiftAssignmentsV2).where(eq(shiftAssignmentsV2.shiftInstanceId, s.id));
      await db.delete(shiftInstances).where(eq(shiftInstances.id, s.id));
    }
  }

  function callerAs(userId: number) {
    return swapRouter.createCaller({
      user: { id: userId, role: "doctor", name: "Tester", email: `${userId}@test.local` },
      institutionId,
      allowedInstitutionIds: [institutionId],
    } as any);
  }

  it("role=OFFERER mostra apenas ofertas onde sou ofertante", async () => {
    const caller = callerAs(userAId);
    const rows = await caller.list({ role: "OFFERER", status: "PENDING" });

    const ids = rows.map((r) => r.id);
    expect(ids).toContain(pendingFromAId);
    expect(ids).not.toContain(pendingFromBId); // B é ofertante neste
  });

  it("role=RECEIVER mostra apenas as que eu aceitei", async () => {
    const caller = callerAs(userBId);
    const rows = await caller.list({ role: "RECEIVER", status: "ACCEPTED" });

    const ids = rows.map((r) => r.id);
    expect(ids).toContain(acceptedFromAId); // B aceitou
    expect(ids).not.toContain(pendingFromAId); // A oferta sem aceitante
  });

  it("role=ANY (default) mantém comportamento legado: vê tudo onde estou envolvido", async () => {
    const caller = callerAs(userAId);
    const rows = await caller.list({}); // sem role: ANY

    const ids = rows.map((r) => r.id);
    // A é fromProfessional nas duas ofertas suas
    expect(ids).toContain(pendingFromAId);
    expect(ids).toContain(acceptedFromAId);
    // O swap onde B é ofertante (sem A em nenhum dos lados) NÃO deve
    // aparecer para A: o filtro non-manager exige fromPro=A OR toPro=A.
    expect(ids).not.toContain(pendingFromBId);
  });

  it("awaitingMyApproval=true em ACCEPTED onde sou ofertante, false caso contrário", async () => {
    const callerA = callerAs(userAId);
    const rowsA = await callerA.list({ role: "OFFERER" });
    const acceptedA = rowsA.find((r) => r.id === acceptedFromAId);
    const pendingA = rowsA.find((r) => r.id === pendingFromAId);
    expect(acceptedA?.awaitingMyApproval).toBe(true);
    expect(pendingA?.awaitingMyApproval).toBe(false);

    // Para B (que aceitou mas não ofertou), o mesmo swap não está aguardando aprovação dele.
    const callerB = callerAs(userBId);
    const rowsB = await callerB.list({ role: "RECEIVER" });
    const acceptedB = rowsB.find((r) => r.id === acceptedFromAId);
    expect(acceptedB?.awaitingMyApproval).toBe(false);
  });
});

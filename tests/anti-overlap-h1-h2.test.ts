import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getDb } from "../server/db";
import {
  professionals,
  hospitals,
  sectors,
  institutions,
  shiftInstances,
  shiftAssignmentsV2,
} from "../drizzle/schema";
import { and, eq, inArray, like } from "drizzle-orm";
import {
  assertNoTimeConflictForProfessional,
  checkTimeConflictForProfessional,
} from "../server/shift-validations-v2";

/**
 * Frente H1/H2 (escala-ux §8): Anti-overlap.
 *
 * Regra: um profissional não pode estar em dois plantões com janelas
 * sobrepostas, INCLUINDO sobreaviso (ON_CALL) e INCLUINDO assignments
 * em estado PENDENTE (aguardando aprovação do gestor).
 *
 * Antes desta frente, o validador no `editor.assignDirect` filtrava
 * apenas `status='OCUPADO'` — deixava passar PENDENTE e ignorava
 * sobreaviso. O `approveAssignment` não revalidava no momento da
 * aprovação. Estes testes blindam o invariante.
 */

const SHIFT_LABEL_PREFIX = "h1h2-test-";

describe("Anti-overlap H1/H2", () => {
  let db: Awaited<ReturnType<typeof getDb>>;
  let pedroId: number;
  let anaId: number;
  let institutionId: number;
  let hospitalId: number;
  let sectorId: number;

  // Janela base: amanhã 8h–14h, suficientemente afastada dos turnos
  // do seed compartilhado (Plantão Manhã VAGO 7h-13h, Plantão Tarde
  // OCUPADO 13h-19h) para evitar colisão de fixtures.
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(0, 0, 0, 0);

  const at = (h: number): Date => {
    const d = new Date(tomorrow);
    // Usa um offset de 30 dias para garantir não-overlap com o seed.
    d.setDate(d.getDate() + 30);
    d.setHours(h, 0, 0, 0);
    return d;
  };

  let baseShiftId: number; // 8h–14h, ocupado por Pedro
  let overlapShiftId: number; // 12h–18h, sobrepõe baseShift
  let nonOverlapShiftId: number; // 16h–22h, não sobrepõe

  beforeAll(async () => {
    db = await getDb();
    if (!db) throw new Error("Database not available");

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
    if (!pedro || !ana) {
      throw new Error("Profissionais do seed não encontrados");
    }
    pedroId = pedro.id;
    anaId = ana.id;

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

    // Limpar fixtures anteriores deste arquivo (idempotência) sem
    // tocar nas assignments de seed que outros testes usam (ex.:
    // rbac-approval.test.ts depende da PENDENTE do Pedro).
    const previousFixtures = await db
      .select({ id: shiftInstances.id })
      .from(shiftInstances)
      .where(
        and(
          eq(shiftInstances.institutionId, institutionId),
          like(shiftInstances.label, `${SHIFT_LABEL_PREFIX}%`),
        ),
      );
    const previousIds = previousFixtures.map((row) => row.id);
    if (previousIds.length > 0) {
      await db
        .delete(shiftAssignmentsV2)
        .where(inArray(shiftAssignmentsV2.shiftInstanceId, previousIds));
      await db
        .delete(shiftInstances)
        .where(inArray(shiftInstances.id, previousIds));
    }

    // Criar 3 turnos de teste.
    const insertShift = async (label: string, startHour: number, endHour: number) => {
      const [res] = await db.insert(shiftInstances).values({
        institutionId,
        hospitalId,
        sectorId,
        label,
        startAt: at(startHour),
        endAt: at(endHour),
        status: "VAGO",
      });
      return (res as any).insertId as number;
    };

    baseShiftId = await insertShift(`${SHIFT_LABEL_PREFIX}base-08-14`, 8, 14);
    overlapShiftId = await insertShift(`${SHIFT_LABEL_PREFIX}overlap-12-18`, 12, 18);
    nonOverlapShiftId = await insertShift(`${SHIFT_LABEL_PREFIX}gap-16-22`, 16, 22);
  });

  afterAll(async () => {
    if (!db) return;
    // Cleanup defensivo: assignments dos shifts deste arquivo + os shifts.
    const ids = [baseShiftId, overlapShiftId, nonOverlapShiftId].filter(
      (id): id is number => typeof id === "number",
    );
    for (const id of ids) {
      await db.delete(shiftAssignmentsV2).where(eq(shiftAssignmentsV2.shiftInstanceId, id));
      await db.delete(shiftInstances).where(eq(shiftInstances.id, id));
    }
  });

  // Helper: criar assignment para Pedro no baseShift com tipo/estado dado.
  const seedBaseAssignment = async (opts: {
    assignmentType: "ON_DUTY" | "BACKUP" | "ON_CALL";
    status: string;
    isActive: boolean;
  }): Promise<number> => {
    if (!db) throw new Error("Database not available");
    // Garante limpeza antes (cada it é independente).
    await db
      .delete(shiftAssignmentsV2)
      .where(eq(shiftAssignmentsV2.shiftInstanceId, baseShiftId));

    const [res] = await db.insert(shiftAssignmentsV2).values({
      shiftInstanceId: baseShiftId,
      institutionId,
      hospitalId,
      sectorId,
      professionalId: pedroId,
      assignmentType: opts.assignmentType,
      status: opts.status,
      isActive: opts.isActive,
    });
    return (res as any).insertId as number;
  };

  it("rejects overlap with an active OCUPADO ON_DUTY assignment", async () => {
    await seedBaseAssignment({ assignmentType: "ON_DUTY", status: "OCUPADO", isActive: true });

    await expect(
      assertNoTimeConflictForProfessional(pedroId, at(12), at(18)),
    ).rejects.toThrow(/Conflito de horário/);
  });

  it("rejects overlap with an active PENDENTE assignment (H1/H2 gap fix)", async () => {
    // Antes da frente, `editor.assignDirect` filtrava status='OCUPADO',
    // ignorando PENDENTE. O validador novo passa a bloquear.
    await seedBaseAssignment({ assignmentType: "ON_DUTY", status: "PENDENTE", isActive: true });

    await expect(
      assertNoTimeConflictForProfessional(pedroId, at(12), at(18)),
    ).rejects.toThrow(/Conflito de horário/);
  });

  it("rejects overlap with an active ON_CALL (sobreaviso) assignment (H1/H2 gap fix)", async () => {
    // Sobreaviso conta como ocupação para fins de overlap.
    await seedBaseAssignment({ assignmentType: "ON_CALL", status: "OCUPADO", isActive: true });

    await expect(
      assertNoTimeConflictForProfessional(pedroId, at(12), at(18)),
    ).rejects.toThrow(/Conflito de horário/);
  });

  it("allows non-overlapping window even when professional has an active assignment", async () => {
    await seedBaseAssignment({ assignmentType: "ON_DUTY", status: "OCUPADO", isActive: true });

    await expect(
      assertNoTimeConflictForProfessional(pedroId, at(16), at(22)),
    ).resolves.toBeUndefined();
  });

  it("ignores assignments where is_active = false (rejected/cancelled)", async () => {
    // Assignment desativado (rejeitado, ou cancelado por unassign) não bloqueia.
    await seedBaseAssignment({ assignmentType: "ON_DUTY", status: "REJEITADO", isActive: false });

    await expect(
      assertNoTimeConflictForProfessional(pedroId, at(12), at(18)),
    ).resolves.toBeUndefined();
  });

  it("treats different professionals independently", async () => {
    // Pedro tem assignment ativo. Validar Ana na mesma janela: ok.
    await seedBaseAssignment({ assignmentType: "ON_DUTY", status: "OCUPADO", isActive: true });

    await expect(
      assertNoTimeConflictForProfessional(anaId, at(12), at(18)),
    ).resolves.toBeUndefined();
  });

  it("respects excludeShiftInstanceId (e.g., approval re-check excludes self)", async () => {
    // Ao re-validar a aprovação de um assignment, o próprio shift do
    // assignment não pode contar como conflito consigo mesmo.
    await seedBaseAssignment({ assignmentType: "ON_DUTY", status: "PENDENTE", isActive: true });

    await expect(
      assertNoTimeConflictForProfessional(
        pedroId,
        at(8),
        at(14),
        baseShiftId, // exclui o próprio shift
      ),
    ).resolves.toBeUndefined();
  });

  it("returns structured conflict data via checkTimeConflictForProfessional", async () => {
    await seedBaseAssignment({ assignmentType: "ON_CALL", status: "OCUPADO", isActive: true });

    const result = await checkTimeConflictForProfessional(pedroId, at(12), at(18));
    expect(result.hasConflict).toBe(true);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].shiftInstanceId).toBe(baseShiftId);
    expect(result.conflicts[0].professionalId).toBe(pedroId);
  });
});

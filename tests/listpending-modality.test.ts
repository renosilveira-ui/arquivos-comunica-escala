import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq, like, inArray } from "drizzle-orm";
import { getDb } from "../server/db";
import {
  hospitals,
  institutions,
  professionals,
  sectors,
  shiftAssignmentsV2,
  shiftAuditLog,
  shiftInstances,
} from "../drizzle/schema";
import { appRouter } from "../server/routers";

/**
 * `shiftAssignments.listPending` agora carrega modalidade do shift
 * subjacente e aceita filtros modality / coverageType (espelha PR #66
 * que fez o mesmo em listVacancies).
 *
 * O seed inclui um shift "Plantão Noite (PENDENTE)" mas o assignment
 * dele vem com isActive: false — listPending filtra is_active = true,
 * então a fixture do seed não aparece. Esta suíte cria seus próprios
 * fixtures (scoped a label prefix) pra ficar self-sufficient.
 */

const FIXTURE_PREFIX = "listpending-modality-test-";

describe("shiftAssignments.listPending — modality output + filter", () => {
  let db: Awaited<ReturnType<typeof getDb>>;
  let userId: number; // Maria Santos — GESTOR_MEDICO no seed
  let institutionId: number;
  let hospitalId: number;
  let sectorId: number;
  let proPedroId: number;
  let sobreavisoShiftId: number;
  let plantaoUrgenciaShiftId: number;

  beforeAll(async () => {
    db = await getDb();
    if (!db) throw new Error("Database not available");

    const [maria] = await db
      .select()
      .from(professionals)
      .where(eq(professionals.name, "Dra. Maria Santos"))
      .limit(1);
    if (!maria) throw new Error("Dra. Maria Santos do seed não encontrada");
    userId = maria.userId!;

    const [pedro] = await db
      .select()
      .from(professionals)
      .where(eq(professionals.name, "Dr. Pedro Costa"))
      .limit(1);
    if (!pedro) throw new Error("Dr. Pedro Costa do seed não encontrado");
    proPedroId = pedro.id;

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

    await cleanupFixtures();

    // Janela afastada de outras suites (+75 dias).
    const future = new Date();
    future.setDate(future.getDate() + 75);
    future.setHours(19, 0, 0, 0);
    const futureEnd = new Date(future);
    futureEnd.setDate(futureEnd.getDate() + 1);
    futureEnd.setHours(7, 0, 0, 0);

    // Shift 1: SOBREAVISO + PRODUTIVIDADE_PURA
    const [resSobre] = await db.insert(shiftInstances).values({
      institutionId,
      hospitalId,
      sectorId,
      label: `${FIXTURE_PREFIX}sobreaviso`,
      startAt: future,
      endAt: futureEnd,
      status: "PENDENTE",
      modality: "SOBREAVISO",
      paymentModel: "PRODUTIVIDADE_PURA",
    });
    sobreavisoShiftId = (resSobre as any).insertId as number;

    // Shift 2: PLANTAO + URGENCIA_EMERGENCIA + FIXO (afastado do shift 1)
    const future2 = new Date(future);
    future2.setDate(future2.getDate() + 2);
    future2.setHours(7, 0, 0, 0);
    const future2End = new Date(future2);
    future2End.setHours(13, 0, 0, 0);

    const [resPlantao] = await db.insert(shiftInstances).values({
      institutionId,
      hospitalId,
      sectorId,
      label: `${FIXTURE_PREFIX}plantao-urgencia`,
      startAt: future2,
      endAt: future2End,
      status: "PENDENTE",
      modality: "PLANTAO",
      coverageType: "URGENCIA_EMERGENCIA",
      paymentModel: "FIXO",
    });
    plantaoUrgenciaShiftId = (resPlantao as any).insertId as number;

    // Assignment ativo PENDENTE em cada shift (Pedro candidatado).
    for (const shiftIdLocal of [sobreavisoShiftId, plantaoUrgenciaShiftId]) {
      await db.insert(shiftAssignmentsV2).values({
        shiftInstanceId: shiftIdLocal,
        institutionId,
        hospitalId,
        sectorId,
        professionalId: proPedroId,
        assignmentType: "ON_DUTY",
        status: "PENDENTE",
        isActive: true,
      });
    }
  });

  afterAll(async () => {
    if (!db) return;
    await cleanupFixtures();
  });

  async function cleanupFixtures(): Promise<void> {
    if (!db) return;
    const ids = await db
      .select({ id: shiftInstances.id })
      .from(shiftInstances)
      .where(
        and(
          eq(shiftInstances.institutionId, institutionId ?? 0),
          like(shiftInstances.label, `${FIXTURE_PREFIX}%`),
        ),
      );
    if (ids.length === 0) return;
    const idList = ids.map((r) => r.id);
    // Ordem FK: audit_log → assignments → shift.
    await db.delete(shiftAuditLog).where(inArray(shiftAuditLog.shiftInstanceId, idList));
    await db.delete(shiftAssignmentsV2).where(inArray(shiftAssignmentsV2.shiftInstanceId, idList));
    await db.delete(shiftInstances).where(inArray(shiftInstances.id, idList));
  }

  function caller() {
    return appRouter.createCaller({
      user: { id: userId, role: "doctor", name: "Maria", email: "maria@test.local" },
      institutionId,
      allowedInstitutionIds: [institutionId],
    } as any);
  }

  it("retorna modalidade do shift subjacente em cada row", async () => {
    const rows = await caller().shiftAssignments.listPending({});

    const noite = rows.find((r) => r.shiftLabel === `${FIXTURE_PREFIX}sobreaviso`);
    expect(noite).toBeDefined();
    expect(noite!.modality).toBe("SOBREAVISO");
    expect(noite!.coverageType).toBeNull();
    expect(noite!.paymentModel).toBe("PRODUTIVIDADE_PURA");
  });

  it("filtro modality=SOBREAVISO retorna apenas pendências de sobreaviso", async () => {
    const rows = await caller().shiftAssignments.listPending({ modality: "SOBREAVISO" });
    expect(rows.length).toBeGreaterThanOrEqual(1);
    for (const r of rows) {
      expect(r.modality).toBe("SOBREAVISO");
    }
    const labels = rows.map((r) => r.shiftLabel);
    expect(labels).toContain(`${FIXTURE_PREFIX}sobreaviso`);
    expect(labels).not.toContain(`${FIXTURE_PREFIX}plantao-urgencia`);
  });

  it("filtro modality=PLANTAO exclui sobreavisos", async () => {
    const rows = await caller().shiftAssignments.listPending({ modality: "PLANTAO" });
    for (const r of rows) {
      expect(r.modality).toBe("PLANTAO");
    }
    const labels = rows.map((r) => r.shiftLabel);
    expect(labels).toContain(`${FIXTURE_PREFIX}plantao-urgencia`);
    expect(labels).not.toContain(`${FIXTURE_PREFIX}sobreaviso`);
  });

  it("filtro coverageType=URGENCIA_EMERGENCIA filtra por cobertura", async () => {
    const rows = await caller().shiftAssignments.listPending({ coverageType: "URGENCIA_EMERGENCIA" });
    for (const r of rows) {
      expect(r.coverageType).toBe("URGENCIA_EMERGENCIA");
      expect(r.modality).toBe("PLANTAO");
    }
    const labels = rows.map((r) => r.shiftLabel);
    expect(labels).toContain(`${FIXTURE_PREFIX}plantao-urgencia`);
  });
});

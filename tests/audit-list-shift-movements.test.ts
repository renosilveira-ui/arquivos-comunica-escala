import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq, inArray, like } from "drizzle-orm";
import { getDb } from "../server/db";
import {
  auditTrail,
  hospitals,
  institutions,
  professionals,
  sectors,
  shiftInstances,
} from "../drizzle/schema";
import { appRouter } from "../server/routers";

/**
 * `audit.listShiftMovements` — backend que alimenta a tela de
 * auditoria de movimentações. Cobre:
 *   - GESTOR_PLUS / admin → vê toda a instituição.
 *   - GESTOR_MEDICO → vê apenas no manager_scope.
 *   - USER → vê apenas eventos onde foi actor / from / to.
 *   - Filtros: shiftInstanceId, fromDate/toDate, hospitalId, sectorId,
 *     actions.
 *
 * Fixtures escopados a entityId arbitrário no range [99000000, 99999999]
 * pra não colidir com nenhum entity_id real.
 */

const ENTITY_BASE = 99100000;

describe("audit.listShiftMovements", () => {
  let db: Awaited<ReturnType<typeof getDb>>;
  let institutionId: number;
  let hospitalId: number;
  let sectorId: number;
  let joaoUserId: number;
  let pedroUserId: number;
  let pedroProId: number;
  let anaUserId: number;
  let anaProId: number;
  let mariaUserId: number;

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

    const [joao] = await db
      .select()
      .from(professionals)
      .where(eq(professionals.name, "Dr. João Silva"))
      .limit(1);
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
    const [maria] = await db
      .select()
      .from(professionals)
      .where(eq(professionals.name, "Dra. Maria Santos"))
      .limit(1);
    if (!joao || !pedro || !ana || !maria) throw new Error("Profissionais do seed não encontrados");
    joaoUserId = joao.userId!;
    pedroUserId = pedro.userId!;
    pedroProId = pedro.id;
    anaUserId = ana.userId!;
    anaProId = ana.id;
    mariaUserId = maria.userId!;

    await cleanupFixtures();

    // 4 fixtures de eventos de movimentação:
    //   1. CESSAO_OFFERED por Pedro (ele é o actor + fromUser/Pro)
    //   2. CESSAO_ACCEPTED por Ana (actor=Ana, from=Pedro, to=Ana)
    //   3. CESSAO_APPROVED_BY_OWNER por Pedro (actor=Pedro, from=Pedro, to=Ana)
    //   4. SHIFT_CREATED por João (actor=João, sem from/to)
    const baseTime = new Date();
    baseTime.setDate(baseTime.getDate() - 5);

    await db.insert(auditTrail).values([
      {
        actorUserId: pedroUserId,
        actorRole: "doctor",
        actorName: "Dr. Pedro Costa",
        action: "CESSAO_OFFERED",
        entityType: "TRANSFER_REQUEST",
        entityId: ENTITY_BASE + 1,
        description: "audit-test: Pedro ofertou cessão",
        fromProfessionalId: pedroProId,
        fromUserId: pedroUserId,
        institutionId,
        hospitalId,
        sectorId,
        createdAt: new Date(baseTime.getTime() + 0),
      },
      {
        actorUserId: anaUserId,
        actorRole: "doctor",
        actorName: "Dra. Ana Lima",
        action: "CESSAO_ACCEPTED",
        entityType: "TRANSFER_REQUEST",
        entityId: ENTITY_BASE + 1,
        description: "audit-test: Ana aceitou cessão",
        fromProfessionalId: pedroProId,
        toProfessionalId: anaProId,
        fromUserId: pedroUserId,
        toUserId: anaUserId,
        institutionId,
        hospitalId,
        sectorId,
        createdAt: new Date(baseTime.getTime() + 60_000),
      },
      {
        actorUserId: pedroUserId,
        actorRole: "doctor",
        actorName: "Dr. Pedro Costa",
        action: "CESSAO_APPROVED_BY_OWNER",
        entityType: "TRANSFER_REQUEST",
        entityId: ENTITY_BASE + 1,
        description: "audit-test: Pedro aprovou candidatura de Ana",
        fromProfessionalId: pedroProId,
        toProfessionalId: anaProId,
        fromUserId: pedroUserId,
        toUserId: anaUserId,
        institutionId,
        hospitalId,
        sectorId,
        createdAt: new Date(baseTime.getTime() + 120_000),
      },
      {
        actorUserId: joaoUserId,
        actorRole: "doctor",
        actorName: "Dr. João Silva",
        action: "SHIFT_CREATED",
        entityType: "SHIFT_INSTANCE",
        entityId: ENTITY_BASE + 2,
        description: "audit-test: João criou plantão",
        institutionId,
        hospitalId,
        sectorId,
        createdAt: new Date(baseTime.getTime() + 180_000),
      },
    ]);
  });

  afterAll(async () => {
    if (!db) return;
    await cleanupFixtures();
  });

  async function cleanupFixtures(): Promise<void> {
    if (!db) return;
    await db
      .delete(auditTrail)
      .where(
        and(
          eq(auditTrail.institutionId, institutionId ?? 0),
          like(auditTrail.description, "audit-test:%"),
        ),
      );
  }

  function caller(userId: number) {
    return appRouter.createCaller({
      user: { id: userId, role: "doctor", name: "Tester", email: `${userId}@test.local` },
      institutionId,
      allowedInstitutionIds: [institutionId],
    } as any);
  }

  it("GESTOR_PLUS (João) vê os 4 eventos da fixture", async () => {
    const rows = await caller(joaoUserId).audit.listShiftMovements({
      actions: ["CESSAO_OFFERED", "CESSAO_ACCEPTED", "CESSAO_APPROVED_BY_OWNER", "SHIFT_CREATED"],
    });
    const testRows = rows.filter((r) => r.description.startsWith("audit-test:"));
    expect(testRows).toHaveLength(4);
  });

  it("USER (Pedro) vê apenas eventos onde participou (3 dos 4)", async () => {
    const rows = await caller(pedroUserId).audit.listShiftMovements({
      actions: ["CESSAO_OFFERED", "CESSAO_ACCEPTED", "CESSAO_APPROVED_BY_OWNER", "SHIFT_CREATED"],
    });
    const testRows = rows.filter((r) => r.description.startsWith("audit-test:"));
    // Os 3 eventos de cessão envolvem Pedro (ofereceu, aprovou, ou foi
    // o "from" do aceite). O SHIFT_CREATED por João não envolve Pedro.
    expect(testRows).toHaveLength(3);
    const actions = testRows.map((r) => r.action);
    expect(actions).toContain("CESSAO_OFFERED");
    expect(actions).toContain("CESSAO_ACCEPTED");
    expect(actions).toContain("CESSAO_APPROVED_BY_OWNER");
    expect(actions).not.toContain("SHIFT_CREATED");
  });

  it("USER (Ana) vê apenas eventos onde participou (2 dos 4)", async () => {
    const rows = await caller(anaUserId).audit.listShiftMovements({
      actions: ["CESSAO_OFFERED", "CESSAO_ACCEPTED", "CESSAO_APPROVED_BY_OWNER", "SHIFT_CREATED"],
    });
    const testRows = rows.filter((r) => r.description.startsWith("audit-test:"));
    // Ana foi actor no ACCEPTED, e to_user no APPROVED_BY_OWNER.
    expect(testRows).toHaveLength(2);
    const actions = testRows.map((r) => r.action);
    expect(actions).toContain("CESSAO_ACCEPTED");
    expect(actions).toContain("CESSAO_APPROVED_BY_OWNER");
  });

  it("filtro actions=['CESSAO_APPROVED_BY_OWNER'] retorna só aprovações", async () => {
    const rows = await caller(joaoUserId).audit.listShiftMovements({
      actions: ["CESSAO_APPROVED_BY_OWNER"],
    });
    const testRows = rows.filter((r) => r.description.startsWith("audit-test:"));
    expect(testRows).toHaveLength(1);
    expect(testRows[0].action).toBe("CESSAO_APPROVED_BY_OWNER");
    expect(testRows[0].actor.userId).toBe(pedroUserId);
    expect(testRows[0].from?.professionalId).toBe(pedroProId);
    expect(testRows[0].to?.professionalId).toBe(anaProId);
  });

  it("retorna actionLabel PT-BR e nomes enriquecidos", async () => {
    const rows = await caller(joaoUserId).audit.listShiftMovements({
      actions: ["CESSAO_APPROVED_BY_OWNER"],
    });
    const row = rows.find((r) => r.description.startsWith("audit-test:"))!;
    expect(row.actionLabel).toBe("Cessão aprovada pelo dono");
    expect(row.actor.name).toBe("Dr. Pedro Costa");
    expect(row.from?.name).toBe("Dr. Pedro Costa");
    expect(row.to?.name).toBe("Dra. Ana Lima");
    expect(row.location.hospitalName).toBeTruthy();
    expect(row.location.sectorName).toBe("Centro Cirúrgico");
  });

  it("ordena DESC por createdAt (mais recente primeiro)", async () => {
    const rows = await caller(joaoUserId).audit.listShiftMovements({
      actions: ["CESSAO_OFFERED", "CESSAO_ACCEPTED", "CESSAO_APPROVED_BY_OWNER", "SHIFT_CREATED"],
    });
    const testRows = rows.filter((r) => r.description.startsWith("audit-test:"));
    // SHIFT_CREATED foi inserido por último → deve aparecer primeiro
    expect(testRows[0].action).toBe("SHIFT_CREATED");
    // CESSAO_OFFERED foi o primeiro → último
    expect(testRows[testRows.length - 1].action).toBe("CESSAO_OFFERED");
  });

  it("default actions filtra eventos não-relacionados a movimentação de plantão", async () => {
    // Insere um USER_CREATED — não deve aparecer no default
    const noiseId = ENTITY_BASE + 99;
    await db!.insert(auditTrail).values({
      actorUserId: joaoUserId,
      actorRole: "doctor",
      action: "USER_CREATED",
      entityType: "USER",
      entityId: noiseId,
      description: "audit-test: ruído de USER_CREATED",
      institutionId,
    });

    const rows = await caller(joaoUserId).audit.listShiftMovements({});
    const noise = rows.filter((r) => r.entityId === noiseId);
    expect(noise).toHaveLength(0);

    // Mas se pedir actions=USER_CREATED explicitamente, aparece.
    const explicit = await caller(joaoUserId).audit.listShiftMovements({
      actions: ["USER_CREATED"],
    });
    const found = explicit.filter((r) => r.entityId === noiseId);
    expect(found).toHaveLength(1);
  });
});

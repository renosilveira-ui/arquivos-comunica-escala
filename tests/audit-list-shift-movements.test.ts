import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq, like } from "drizzle-orm";
import { getDb } from "../server/db";
import {
  auditTrail,
  hospitals,
  institutions,
  monthlyRosters,
  professionalInstitutions,
  professionals,
  sectors,
  shiftInstances,
} from "../drizzle/schema";
import { appRouter } from "../server/routers";
import { addDaysToKey, dayKeyBrt, yearMonthBrt } from "../server/local-time";

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
  let joaoProId: number;
  let pedroUserId: number;
  let pedroProId: number;
  let anaUserId: number;
  let anaProId: number;
  let fixtureDay: string;
  let fixtureShiftId = 0;

  beforeAll(async () => {
    db = await getDb();
    if (!db) throw new Error("Database not available");

    const [institution] = await db.select().from(institutions).limit(1);
    institutionId = institution!.id;

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
    if (!joao || !pedro || !ana || !maria)
      throw new Error("Profissionais do seed não encontrados");
    joaoUserId = joao.userId!;
    joaoProId = joao.id;
    pedroUserId = pedro.userId!;
    pedroProId = pedro.id;
    anaUserId = ana.userId!;
    anaProId = ana.id;

    await cleanupFixtures();

    const fixtureStamp = Date.now();
    const [hospital] = await db
      .insert(hospitals)
      .values({ institutionId, name: `Audit movements ${fixtureStamp}` })
      .$returningId();
    hospitalId = hospital.id;
    const [sector] = await db
      .insert(sectors)
      .values({
        institutionId,
        hospitalId,
        name: `Audit movements ${fixtureStamp}`,
        category: "servico",
        color: "#2563EB",
      })
      .$returningId();
    sectorId = sector.id;

    fixtureDay = addDaysToKey(dayKeyBrt(new Date()), -5);
    const baseTime = new Date(`${fixtureDay}T12:00:00-03:00`);
    const [shift] = await db
      .insert(shiftInstances)
      .values({
        institutionId,
        hospitalId,
        sectorId,
        label: "audit movement fixture",
        startAt: new Date(`${fixtureDay}T07:00:00-03:00`),
        endAt: new Date(`${fixtureDay}T13:00:00-03:00`),
        status: "OCUPADO",
      })
      .$returningId();
    fixtureShiftId = shift.id;
    await db.insert(monthlyRosters).values({
      institutionId,
      hospitalId,
      yearMonth: yearMonthBrt(baseTime),
      status: "PUBLISHED",
    });

    // 4 fixtures com plantão canônico em roster publicado:
    //   1. CESSAO_OFFERED por Pedro (ele é o actor + fromUser/Pro)
    //   2. CESSAO_ACCEPTED por Ana (actor=Ana, from=Pedro, to=Ana)
    //   3. CESSAO_APPROVED_BY_OWNER por Pedro (actor=Pedro, from=Pedro, to=Ana)
    //   4. SHIFT_CREATED por João (actor=João, sem from/to)
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
        shiftInstanceId: fixtureShiftId,
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
        shiftInstanceId: fixtureShiftId,
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
        shiftInstanceId: fixtureShiftId,
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
        shiftInstanceId: fixtureShiftId,
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
    if (fixtureShiftId) {
      await db
        .delete(shiftInstances)
        .where(eq(shiftInstances.id, fixtureShiftId));
      fixtureShiftId = 0;
    }
    if (hospitalId) {
      await db
        .delete(monthlyRosters)
        .where(
          and(
            eq(monthlyRosters.institutionId, institutionId),
            eq(monthlyRosters.hospitalId, hospitalId),
          ),
        );
    }
    if (sectorId) {
      await db.delete(sectors).where(eq(sectors.id, sectorId));
      sectorId = 0;
    }
    if (hospitalId) {
      await db.delete(hospitals).where(eq(hospitals.id, hospitalId));
      hospitalId = 0;
    }
  }

  function caller(userId: number) {
    return appRouter.createCaller({
      user: {
        id: userId,
        role: "doctor",
        name: "Tester",
        email: `${userId}@test.local`,
      },
      institutionId,
      allowedInstitutionIds: [institutionId],
    } as any);
  }

  it("GESTOR_PLUS (João) vê os 4 eventos da fixture", async () => {
    const rows = await caller(joaoUserId).audit.listShiftMovements({
      actions: [
        "CESSAO_OFFERED",
        "CESSAO_ACCEPTED",
        "CESSAO_APPROVED_BY_OWNER",
        "SHIFT_CREATED",
      ],
      fromDate: fixtureDay,
      toDate: fixtureDay,
    });
    const testRows = rows.filter((r) =>
      r.description.startsWith("audit-test:"),
    );
    expect(testRows).toHaveLength(4);
  });

  it("USER (Pedro) vê movimentos próprios do roster oficial", async () => {
    const rows = await caller(pedroUserId).audit.listShiftMovements({
      actions: [
        "CESSAO_OFFERED",
        "CESSAO_ACCEPTED",
        "CESSAO_APPROVED_BY_OWNER",
        "SHIFT_CREATED",
      ],
      fromDate: fixtureDay,
      toDate: fixtureDay,
    });
    const testRows = rows.filter((r) =>
      r.description.startsWith("audit-test:"),
    );
    expect(testRows).toHaveLength(3);
  });

  it("USER (Ana) vê movimentos próprios do roster oficial", async () => {
    const rows = await caller(anaUserId).audit.listShiftMovements({
      actions: [
        "CESSAO_OFFERED",
        "CESSAO_ACCEPTED",
        "CESSAO_APPROVED_BY_OWNER",
        "SHIFT_CREATED",
      ],
      fromDate: fixtureDay,
      toDate: fixtureDay,
    });
    const testRows = rows.filter((r) =>
      r.description.startsWith("audit-test:"),
    );
    expect(testRows).toHaveLength(2);
  });

  it("filtro actions=['CESSAO_APPROVED_BY_OWNER'] retorna só aprovações", async () => {
    const rows = await caller(joaoUserId).audit.listShiftMovements({
      actions: ["CESSAO_APPROVED_BY_OWNER"],
      fromDate: fixtureDay,
      toDate: fixtureDay,
    });
    const testRows = rows.filter((r) =>
      r.description.startsWith("audit-test:"),
    );
    expect(testRows).toHaveLength(1);
    expect(testRows[0].action).toBe("CESSAO_APPROVED_BY_OWNER");
    expect(testRows[0].actor.userId).toBe(pedroUserId);
    expect(testRows[0].from?.professionalId).toBe(pedroProId);
    expect(testRows[0].to?.professionalId).toBe(anaProId);
  });

  it("retorna actionLabel PT-BR e nomes enriquecidos", async () => {
    const rows = await caller(joaoUserId).audit.listShiftMovements({
      actions: ["CESSAO_APPROVED_BY_OWNER"],
      fromDate: fixtureDay,
      toDate: fixtureDay,
    });
    const row = rows.find((r) => r.description.startsWith("audit-test:"))!;
    expect(row.actionLabel).toBe("Cessão aprovada pelo dono");
    expect(row.actor.name).toBe("Dr. Pedro Costa");
    expect(row.from?.name).toBe("Dr. Pedro Costa");
    expect(row.to?.name).toBe("Dra. Ana Lima");
    expect(row.location.hospitalName).toBeTruthy();
    expect(row.location.sectorName).toMatch(/^Audit movements /);
  });

  it("nenhum gestor ou USER vê movimento operacional órfão de plantão", async () => {
    const orphanId = ENTITY_BASE + 98;
    await db!.insert(auditTrail).values({
      actorUserId: pedroUserId,
      actorRole: "doctor",
      action: "CESSAO_OFFERED",
      entityType: "TRANSFER_REQUEST",
      entityId: orphanId,
      description: "audit-test: movimento órfão",
      fromProfessionalId: pedroProId,
      fromUserId: pedroUserId,
      institutionId,
      hospitalId,
      sectorId,
    });

    for (const userId of [joaoUserId, pedroUserId]) {
      const rows = await caller(userId).audit.listShiftMovements({
        actions: ["CESSAO_OFFERED"],
      });
      expect(rows.some((row) => row.entityId === orphanId)).toBe(false);
    }
  });

  it("USER preserva apenas ação account-level própria explicitamente permitida", async () => {
    const accountEventId = ENTITY_BASE + 97;
    await db!.insert(auditTrail).values({
      actorUserId: pedroUserId,
      actorRole: "doctor",
      action: "USER_UPDATED",
      entityType: "USER",
      entityId: accountEventId,
      description: "audit-test: atualização pessoal",
      institutionId,
    });

    const rows = await caller(pedroUserId).audit.listShiftMovements({
      actions: ["USER_UPDATED"],
    });
    expect(rows.some((row) => row.entityId === accountEventId)).toBe(true);
  });

  it("ordena DESC por createdAt (mais recente primeiro)", async () => {
    const rows = await caller(joaoUserId).audit.listShiftMovements({
      actions: [
        "CESSAO_OFFERED",
        "CESSAO_ACCEPTED",
        "CESSAO_APPROVED_BY_OWNER",
        "SHIFT_CREATED",
      ],
      fromDate: fixtureDay,
      toDate: fixtureDay,
    });
    const testRows = rows.filter((r) =>
      r.description.startsWith("audit-test:"),
    );
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

  it("revalida publicação e papel atual após downgrade do gestor", async () => {
    const [testHospital] = await db!
      .insert(hospitals)
      .values({ institutionId, name: `Audit fence ${Date.now()}` })
      .$returningId();
    const [testSector] = await db!
      .insert(sectors)
      .values({
        institutionId,
        hospitalId: testHospital.id,
        name: `Audit fence ${Date.now()}`,
        category: "servico",
        color: "#2563EB",
      })
      .$returningId();
    const startAt = new Date(`${fixtureDay}T07:00:00-03:00`);
    const endAt = new Date(`${fixtureDay}T13:00:00-03:00`);
    const [shift] = await db!
      .insert(shiftInstances)
      .values({
        institutionId,
        hospitalId: testHospital.id,
        sectorId: testSector.id,
        label: "audit publication fence",
        startAt,
        endAt,
        status: "OCUPADO",
      })
      .$returningId();
    await db!.insert(auditTrail).values({
      actorUserId: joaoUserId,
      actorRole: "manager",
      action: "SHIFT_UPDATED",
      entityType: "SHIFT_INSTANCE",
      entityId: shift.id,
      description: "audit-test: evento de rascunho",
      institutionId,
      hospitalId: testHospital.id,
      sectorId: testSector.id,
      shiftInstanceId: shift.id,
      createdAt: new Date(`${fixtureDay}T12:10:00-03:00`),
    });
    const rosterWhere = and(
      eq(monthlyRosters.institutionId, institutionId),
      eq(monthlyRosters.hospitalId, testHospital.id),
      eq(monthlyRosters.yearMonth, yearMonthBrt(startAt)),
    );
    const membershipWhere = and(
      eq(professionalInstitutions.professionalId, joaoProId),
      eq(professionalInstitutions.institutionId, institutionId),
    );
    const read = async () =>
      (
        await caller(joaoUserId).audit.listShiftMovements({
          actions: ["SHIFT_UPDATED"],
          fromDate: fixtureDay,
          toDate: fixtureDay,
        })
      ).some((row) => row.shift?.id === shift.id);

    try {
      await db!.delete(monthlyRosters).where(rosterWhere);
      expect(await read()).toBe(true);
      await db!
        .update(professionalInstitutions)
        .set({ roleInInstitution: "USER" })
        .where(membershipWhere);
      expect(await read()).toBe(false);

      await db!.insert(monthlyRosters).values({
        institutionId,
        hospitalId: testHospital.id,
        yearMonth: yearMonthBrt(startAt),
        status: "PUBLISHED",
      });
      expect(await read()).toBe(true);
      await db!
        .update(monthlyRosters)
        .set({ status: "LOCKED" })
        .where(rosterWhere);
      expect(await read()).toBe(true);
    } finally {
      await db!
        .update(professionalInstitutions)
        .set({ roleInInstitution: "GESTOR_PLUS" })
        .where(membershipWhere);
      await db!
        .delete(auditTrail)
        .where(eq(auditTrail.shiftInstanceId, shift.id));
      await db!.delete(shiftInstances).where(eq(shiftInstances.id, shift.id));
      await db!.delete(monthlyRosters).where(rosterWhere);
      await db!.delete(sectors).where(eq(sectors.id, testSector.id));
      await db!.delete(hospitals).where(eq(hospitals.id, testHospital.id));
    }
  });
});

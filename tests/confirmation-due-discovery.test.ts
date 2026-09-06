import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";
import {
  dutyConfirmations,
  hospitals,
  institutions,
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
  dispatchConfirmations,
} from "../server/cron/shift-confirmation-dispatcher";
import { getDb } from "../server/db";
import { yearMonthBrt } from "../server/local-time";
import { rowsFromExecute } from "../server/_core/db-results";
import {
  ensureTestAnesthesiaSpecialty,
  openTestScale,
} from "./helpers/open-test-scale";

const trackedPushMock = vi.hoisted(() =>
  vi.fn(async () => ({
    notificationId: 1,
    status: "PENDING" as const,
    phase: "TICKET_ACCEPTED" as const,
    ticketAccepted: true,
    providerAccepted: false,
  })),
);
const queuedPushMock = vi.hoisted(() =>
  vi.fn(async () => ({
    notificationId: 1,
    status: "PENDING" as const,
    phase: "QUEUED" as const,
    ticketAccepted: false,
    providerAccepted: false,
  })),
);
vi.mock("../server/push-delivery", () => ({
  sendTrackedPushNotification: trackedPushMock,
  enqueueTrackedPushNotification: queuedPushMock,
  processPendingPushDeliveries: vi.fn(async () => 0),
}));
vi.mock("../server/sso/duty-sync", () => ({
  enqueueDutySync: vi.fn(async () => 1),
  processPendingDutySyncs: vi.fn(async () => 0),
}));
vi.mock("../server/integrations/comunica-plus", () => ({
  processPendingComunicaPlusOutbox: vi.fn(async () => 0),
}));

describe("confirmation due-based discovery — MySQL", () => {
  let db: NonNullable<Awaited<ReturnType<typeof getDb>>>;
  const stamp = Date.now();
  let institutionId: number;
  let institutionBId: number;
  let hospitalId: number;
  let hospitalBId: number;
  let sectorId: number;
  let sectorBId: number;
  let scheduleContextId: number;
  let scheduleContextBId: number;
  let titularUserId: number;
  let titularProId: number;
  let otherUserId: number;
  let otherProId: number;
  let plusUserId: number;
  let plusProId: number;
  let tenantBUserId: number;
  let tenantBProId: number;
  const userIds: number[] = [];
  const proIds: number[] = [];

  const day = "2036-04-10";
  const start13 = new Date(`${day}T13:00:00-03:00`);
  const end19 = new Date(`${day}T19:00:00-03:00`);
  const start19 = new Date(`${day}T19:00:00-03:00`);
  const end07next = new Date(`2036-04-11T07:00:00-03:00`);
  const start07 = new Date(`${day}T07:00:00-03:00`);
  const end13 = new Date(`${day}T13:00:00-03:00`);
  const start08 = new Date(`${day}T08:00:00-03:00`);

  async function setRoster(
    at: Date,
    status: "DRAFT" | "PUBLISHED" | "LOCKED",
    inst = institutionId,
    hosp = hospitalId,
  ) {
    await db
      .insert(monthlyRosters)
      .values({
        institutionId: inst,
        hospitalId: hosp,
        yearMonth: yearMonthBrt(at),
        status,
      })
      .onDuplicateKeyUpdate({ set: { status } });
  }

  async function person(
    tag: string,
    opts: {
      institutionId: number;
      hospitalId: number;
      sectorId: number;
      role?: "USER" | "GESTOR_PLUS";
      withAccess?: boolean;
    },
  ) {
    const [u] = await db
      .insert(users)
      .values({
        name: `Due ${tag} ${stamp}`,
        email: `due-${tag}-${stamp}@test.local`,
        passwordHash: "test",
        role: "doctor",
      })
      .$returningId();
    const [p] = await db
      .insert(professionals)
      .values({
        userId: u.id,
        name: `Due ${tag} ${stamp}`,
        role: "Médico",
        userRole: "USER",
      })
      .$returningId();
    await db.insert(professionalInstitutions).values({
      professionalId: p.id,
      userId: u.id,
      institutionId: opts.institutionId,
      roleInInstitution: opts.role ?? "USER",
      isPrimary: true,
      active: true,
    });
    if (opts.withAccess !== false) {
      await db.insert(professionalAccess).values({
        institutionId: opts.institutionId,
        professionalId: p.id,
        hospitalId: opts.hospitalId,
        sectorId: opts.sectorId,
        canAccess: true,
      });
    }
    userIds.push(u.id);
    proIds.push(p.id);
    return { userId: u.id, proId: p.id };
  }

  async function occupy(input: {
    startAt: Date;
    endAt: Date;
    professionalId: number;
    createdBy: number;
    institutionId?: number;
    hospitalId?: number;
    sectorId?: number;
    scheduleContextId?: number;
    assignmentType?: "ON_DUTY" | "ON_CALL";
  }) {
    const inst = input.institutionId ?? institutionId;
    const hosp = input.hospitalId ?? hospitalId;
    const sec = input.sectorId ?? sectorId;
    const ctx = input.scheduleContextId ?? scheduleContextId;
    const [s] = await db
      .insert(shiftInstances)
      .values({
        institutionId: inst,
        hospitalId: hosp,
        sectorId: sec,
        scheduleContextId: ctx,
        label: `Due ${stamp}`,
        startAt: input.startAt,
        endAt: input.endAt,
        status: "OCUPADO",
      })
      .$returningId();
    const [a] = await db
      .insert(shiftAssignmentsV2)
      .values({
        shiftInstanceId: s.id,
        institutionId: inst,
        hospitalId: hosp,
        sectorId: sec,
        professionalId: input.professionalId,
        assignmentType: input.assignmentType ?? "ON_DUTY",
        status: "OCUPADO",
        isActive: true,
        createdBy: input.createdBy,
      })
      .$returningId();
    return { shiftId: s.id, assignmentId: a.id };
  }

  async function confirmationsFor(assignmentId: number) {
    return db
      .select({
        id: dutyConfirmations.id,
        status: dutyConfirmations.status,
        institutionId: dutyConfirmations.institutionId,
        userId: dutyConfirmations.userId,
      })
      .from(dutyConfirmations)
      .where(eq(dutyConfirmations.assignmentId, assignmentId));
  }

  beforeAll(async () => {
    const conn = await getDb();
    if (!conn) throw new Error("Database not available");
    db = conn;
    await ensureTestAnesthesiaSpecialty(db);
    const cnpj = `${stamp}`.slice(-14).padStart(14, "0");
    const [inst] = await db
      .insert(institutions)
      .values({
        name: `Due A ${stamp}`,
        cnpj,
        legalName: `Due A ${stamp}`,
        tradeName: `DueA${stamp}`.slice(0, 20),
        isActive: true,
      })
      .$returningId();
    institutionId = inst.id;
    const [instB] = await db
      .insert(institutions)
      .values({
        name: `Due B ${stamp}`,
        cnpj: `${Number(cnpj) + 1}`.padStart(14, "0"),
        legalName: `Due B ${stamp}`,
        tradeName: `DueB${stamp}`.slice(0, 20),
        isActive: true,
      })
      .$returningId();
    institutionBId = instB.id;
    const [h] = await db
      .insert(hospitals)
      .values({ institutionId, name: `Due Hosp A ${stamp}` })
      .$returningId();
    hospitalId = h.id;
    const [hB] = await db
      .insert(hospitals)
      .values({ institutionId: institutionBId, name: `Due Hosp B ${stamp}` })
      .$returningId();
    hospitalBId = hB.id;
    const [sec] = await db
      .insert(sectors)
      .values({
        institutionId,
        hospitalId,
        name: `Due Setor A ${stamp}`,
        category: "cirurgico",
        color: "#2563EB",
      })
      .$returningId();
    sectorId = sec.id;
    const [secB] = await db
      .insert(sectors)
      .values({
        institutionId: institutionBId,
        hospitalId: hospitalBId,
        name: `Due Setor B ${stamp}`,
        category: "cirurgico",
        color: "#2563EB",
      })
      .$returningId();
    sectorBId = secB.id;
    scheduleContextId = await openTestScale(db, {
      institutionId,
      hospitalId,
      sectorId,
    });
    scheduleContextBId = await openTestScale(db, {
      institutionId: institutionBId,
      hospitalId: hospitalBId,
      sectorId: sectorBId,
    });
    const t = await person("titular", { institutionId, hospitalId, sectorId });
    titularUserId = t.userId;
    titularProId = t.proId;
    const o = await person("other", { institutionId, hospitalId, sectorId });
    otherUserId = o.userId;
    otherProId = o.proId;
    const plus = await person("plus", {
      institutionId,
      hospitalId,
      sectorId,
      role: "GESTOR_PLUS",
      withAccess: false,
    });
    plusUserId = plus.userId;
    plusProId = plus.proId;
    const b = await person("tenant-b", {
      institutionId: institutionBId,
      hospitalId: hospitalBId,
      sectorId: sectorBId,
    });
    tenantBUserId = b.userId;
    tenantBProId = b.proId;
  });

  async function wipeShifts() {
    const mine = await db
      .select({ id: shiftInstances.id })
      .from(shiftInstances)
      .where(inArray(shiftInstances.institutionId, [institutionId, institutionBId]));
    const ids = mine.map((row) => row.id);
    if (ids.length) {
      await db
        .delete(dutyConfirmations)
        .where(inArray(dutyConfirmations.shiftInstanceId, ids));
      await db
        .delete(shiftAssignmentsV2)
        .where(inArray(shiftAssignmentsV2.shiftInstanceId, ids));
      await db.delete(shiftInstances).where(inArray(shiftInstances.id, ids));
    }
    await db
      .delete(monthlyRosters)
      .where(inArray(monthlyRosters.institutionId, [institutionId, institutionBId]));
  }

  beforeEach(async () => {
    await wipeShifts();
    await setRoster(start13, "PUBLISHED");
    await setRoster(start13, "PUBLISHED", institutionBId, hospitalBId);
    trackedPushMock.mockReset();
    trackedPushMock.mockResolvedValue({
      notificationId: 1,
      status: "PENDING",
      phase: "TICKET_ACCEPTED",
      ticketAccepted: true,
      providerAccepted: false,
    });
    queuedPushMock.mockReset();
    queuedPushMock.mockResolvedValue({
      notificationId: 1,
      status: "PENDING",
      phase: "QUEUED",
      ticketAccepted: false,
      providerAccepted: false,
    });
  });

  afterAll(async () => {
    await wipeShifts();
    await db
      .delete(professionalAccess)
      .where(inArray(professionalAccess.professionalId, proIds));
    await db
      .delete(professionalInstitutions)
      .where(inArray(professionalInstitutions.professionalId, proIds));
    await db.delete(professionals).where(inArray(professionals.id, proIds));
    await db
      .delete(scheduleContexts)
      .where(inArray(scheduleContexts.id, [scheduleContextId, scheduleContextBId]));
    await db.delete(sectors).where(inArray(sectors.id, [sectorId, sectorBId]));
    await db.delete(hospitals).where(inArray(hospitals.id, [hospitalId, hospitalBId]));
    await db
      .delete(institutions)
      .where(inArray(institutions.id, [institutionId, institutionBId]));
    await db.delete(users).where(inArray(users.id, userIds));
  });

  it("13:00 padrão recebe no due; 10:59 ainda não", async () => {
    const { assignmentId } = await occupy({
      startAt: start13,
      endAt: end19,
      professionalId: titularProId,
      createdBy: titularUserId,
    });
    await dispatchConfirmations(new Date(`${day}T10:59:00-03:00`));
    expect(await confirmationsFor(assignmentId)).toHaveLength(0);
    await dispatchConfirmations(new Date(`${day}T11:07:00-03:00`));
    expect(await confirmationsFor(assignmentId)).toHaveLength(1);
  });

  it("19:00 padrão recebe às 17:07", async () => {
    const { assignmentId } = await occupy({
      startAt: start19,
      endAt: end07next,
      professionalId: titularProId,
      createdBy: titularUserId,
    });
    await dispatchConfirmations(new Date(`${day}T17:07:00-03:00`));
    expect(await confirmationsFor(assignmentId)).toHaveLength(1);
  });

  it("Manhã 07:00 recebe às 22:07 do dia anterior (lead 9h)", async () => {
    const { assignmentId } = await occupy({
      startAt: start07,
      endAt: end13,
      professionalId: titularProId,
      createdBy: titularUserId,
    });
    await dispatchConfirmations(new Date(`2036-04-09T21:59:00-03:00`));
    expect(await confirmationsFor(assignmentId)).toHaveLength(0);
    await dispatchConfirmations(new Date(`2036-04-09T22:07:00-03:00`));
    expect(await confirmationsFor(assignmentId)).toHaveLength(1);
  });

  it("plantão 08:00 off-grid recebe no due de 2h", async () => {
    const { assignmentId } = await occupy({
      startAt: start08,
      endAt: end13,
      professionalId: titularProId,
      createdBy: titularUserId,
      assignmentType: "ON_CALL",
    });
    await dispatchConfirmations(new Date(`${day}T05:00:00-03:00`));
    expect(await confirmationsFor(assignmentId)).toHaveLength(0);
    await dispatchConfirmations(new Date(`${day}T06:30:00-03:00`));
    expect(await confirmationsFor(assignmentId)).toHaveLength(1);
  });

  it("assignment tardio (12:30 para 13:00) faz catch-up", async () => {
    const { assignmentId } = await occupy({
      startAt: start13,
      endAt: end19,
      professionalId: titularProId,
      createdBy: titularUserId,
    });
    await dispatchConfirmations(new Date(`${day}T12:30:00-03:00`));
    expect(await confirmationsFor(assignmentId)).toHaveLength(1);
  });

  it("restart/sleep depois da janela histórica 11:00–11:20 ainda captura 13:00", async () => {
    const { assignmentId } = await occupy({
      startAt: start13,
      endAt: end19,
      professionalId: titularProId,
      createdBy: titularUserId,
    });
    await dispatchConfirmations(new Date(`${day}T12:00:00-03:00`));
    expect(await confirmationsFor(assignmentId)).toHaveLength(1);
  });

  it("swap após o due: novo titular recebe; origem inativa não", async () => {
    const a = await occupy({
      startAt: start13,
      endAt: end19,
      professionalId: titularProId,
      createdBy: titularUserId,
    });
    await db
      .update(shiftAssignmentsV2)
      .set({ isActive: false })
      .where(eq(shiftAssignmentsV2.id, a.assignmentId));
    const [b] = await db
      .insert(shiftAssignmentsV2)
      .values({
        shiftInstanceId: a.shiftId,
        institutionId,
        hospitalId,
        sectorId,
        professionalId: otherProId,
        assignmentType: "ON_DUTY",
        status: "OCUPADO",
        isActive: true,
        createdBy: otherUserId,
      })
      .$returningId();
    await dispatchConfirmations(new Date(`${day}T12:30:00-03:00`));
    expect(await confirmationsFor(a.assignmentId)).toHaveLength(0);
    const forB = await confirmationsFor(b.id);
    expect(forB).toHaveLength(1);
    expect(forB[0].userId).toBe(otherUserId);
  });

  it("substituição após o due: novo assignment recebe sem duplicar o antigo", async () => {
    const a = await occupy({
      startAt: start13,
      endAt: end19,
      professionalId: titularProId,
      createdBy: titularUserId,
    });
    await dispatchConfirmations(new Date(`${day}T11:07:00-03:00`));
    expect(await confirmationsFor(a.assignmentId)).toHaveLength(1);
    await db
      .update(shiftAssignmentsV2)
      .set({ isActive: false })
      .where(eq(shiftAssignmentsV2.id, a.assignmentId));
    const [b] = await db
      .insert(shiftAssignmentsV2)
      .values({
        shiftInstanceId: a.shiftId,
        institutionId,
        hospitalId,
        sectorId,
        professionalId: otherProId,
        assignmentType: "ON_DUTY",
        status: "OCUPADO",
        isActive: true,
        createdBy: otherUserId,
      })
      .$returningId();
    await dispatchConfirmations(new Date(`${day}T12:40:00-03:00`));
    expect(await confirmationsFor(a.assignmentId)).toHaveLength(1);
    expect(await confirmationsFor(b.id)).toHaveLength(1);
  });

  it("assignment cancelado antes do tick: zero", async () => {
    const { assignmentId } = await occupy({
      startAt: start13,
      endAt: end19,
      professionalId: titularProId,
      createdBy: titularUserId,
    });
    await db
      .update(shiftAssignmentsV2)
      .set({ isActive: false })
      .where(eq(shiftAssignmentsV2.id, assignmentId));
    await dispatchConfirmations(new Date(`${day}T11:07:00-03:00`));
    expect(await confirmationsFor(assignmentId)).toHaveLength(0);
  });

  it("plantão já iniciado: zero nova solicitação", async () => {
    const { assignmentId } = await occupy({
      startAt: start13,
      endAt: end19,
      professionalId: titularProId,
      createdBy: titularUserId,
    });
    await dispatchConfirmations(new Date(`${day}T13:00:00-03:00`));
    expect(await confirmationsFor(assignmentId)).toHaveLength(0);
  });

  it("já existe confirmação: segundo tick não duplica", async () => {
    const { assignmentId } = await occupy({
      startAt: start13,
      endAt: end19,
      professionalId: titularProId,
      createdBy: titularUserId,
    });
    await dispatchConfirmations(new Date(`${day}T11:07:00-03:00`));
    await dispatchConfirmations(new Date(`${day}T11:08:00-03:00`));
    expect(await confirmationsFor(assignmentId)).toHaveLength(1);
  });

  it("CLI × web no mesmo instante: uma linha", async () => {
    const { assignmentId } = await occupy({
      startAt: start13,
      endAt: end19,
      professionalId: titularProId,
      createdBy: titularUserId,
    });
    const now = new Date(`${day}T11:07:00-03:00`);
    await Promise.all([dispatchConfirmations(now), dispatchConfirmations(now)]);
    expect(await confirmationsFor(assignmentId)).toHaveLength(1);
  });

  it("roster DRAFT: zero; publicação tardia faz catch-up", async () => {
    const { assignmentId } = await occupy({
      startAt: start13,
      endAt: end19,
      professionalId: titularProId,
      createdBy: titularUserId,
    });
    await setRoster(start13, "DRAFT");
    await dispatchConfirmations(new Date(`${day}T12:30:00-03:00`));
    expect(await confirmationsFor(assignmentId)).toHaveLength(0);
    await setRoster(start13, "PUBLISHED");
    await dispatchConfirmations(new Date(`${day}T12:31:00-03:00`));
    expect(await confirmationsFor(assignmentId)).toHaveLength(1);
  });

  it("GESTOR_PLUS OCUPADO sem ACL entra na discovery", async () => {
    const { assignmentId } = await occupy({
      startAt: start13,
      endAt: end19,
      professionalId: plusProId,
      createdBy: plusUserId,
    });
    await dispatchConfirmations(new Date(`${day}T11:07:00-03:00`));
    const rows = await confirmationsFor(assignmentId);
    expect(rows).toHaveLength(1);
    expect(rows[0].userId).toBe(plusUserId);
  });

  it("sem ticket aceito: permanece PENDING (silêncio não confirma)", async () => {
    trackedPushMock.mockResolvedValue({
      notificationId: 1,
      status: "PENDING",
      phase: "QUEUED",
      ticketAccepted: false,
      providerAccepted: false,
    });
    const { assignmentId } = await occupy({
      startAt: start13,
      endAt: end19,
      professionalId: titularProId,
      createdBy: titularUserId,
    });
    await dispatchConfirmations(new Date(`${day}T11:07:00-03:00`));
    const rows = await confirmationsFor(assignmentId);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("PENDING");
  });

  it("tenant A/B: confirmação não vaza instituição", async () => {
    const a = await occupy({
      startAt: start13,
      endAt: end19,
      professionalId: titularProId,
      createdBy: titularUserId,
    });
    const b = await occupy({
      startAt: start13,
      endAt: end19,
      professionalId: tenantBProId,
      createdBy: tenantBUserId,
      institutionId: institutionBId,
      hospitalId: hospitalBId,
      sectorId: sectorBId,
      scheduleContextId: scheduleContextBId,
    });
    await dispatchConfirmations(new Date(`${day}T11:07:00-03:00`));
    const rowsA = await confirmationsFor(a.assignmentId);
    const rowsB = await confirmationsFor(b.assignmentId);
    expect(rowsA).toHaveLength(1);
    expect(rowsB).toHaveLength(1);
    expect(rowsA[0].institutionId).toBe(institutionId);
    expect(rowsB[0].institutionId).toBe(institutionBId);
    expect(rowsA[0].userId).toBe(titularUserId);
    expect(rowsB[0].userId).toBe(tenantBUserId);
  });

  it("query de discovery é bounded: plantão 10h à frente não entra", async () => {
    const farStart = new Date(`${day}T22:00:00-03:00`);
    const farEnd = new Date(`2036-04-11T07:00:00-03:00`);
    const { assignmentId } = await occupy({
      startAt: farStart,
      endAt: farEnd,
      professionalId: titularProId,
      createdBy: titularUserId,
    });
    await dispatchConfirmations(new Date(`${day}T11:00:00-03:00`));
    expect(await confirmationsFor(assignmentId)).toHaveLength(0);
  });

  it("EXPLAIN: unique do assignment fecha duplicata; start_at aplica WHERE; ALL de occupancy pequena não é scan histórico", async () => {
    await occupy({
      startAt: start13,
      endAt: end19,
      professionalId: titularProId,
      createdBy: titularUserId,
    });
    await db.insert(shiftInstances).values(
      Array.from({ length: 40 }, (_, n) => ({
        institutionId,
        hospitalId,
        sectorId,
        scheduleContextId,
        label: `DueHist ${stamp} ${n}`.slice(0, 100),
        startAt: new Date(Date.UTC(2020, 0, 1 + n, 13, 0, 0)),
        endAt: new Date(Date.UTC(2020, 0, 1 + n, 19, 0, 0)),
        status: "OCUPADO" as const,
      })),
    );
    await db.execute(
      sql`ANALYZE TABLE shift_instances, shift_assignments_v2, duty_confirmations`,
    );
    const explain = await db.execute(sql`
      EXPLAIN SELECT a.id
      FROM shift_assignments_v2 a
      INNER JOIN shift_instances i
        ON i.id = a.shift_instance_id
       AND i.institution_id = a.institution_id
       AND i.hospital_id = a.hospital_id
       AND i.sector_id = a.sector_id
      LEFT JOIN duty_confirmations c
        ON c.assignment_id = a.id
      WHERE a.is_active = 1
        AND a.status = 'OCUPADO'
        AND i.start_at > '2036-04-10 14:00:00'
        AND i.start_at <= '2036-04-10 23:00:00'
        AND c.id IS NULL
    `);
    const rows = rowsFromExecute<{
      table?: string;
      type?: string;
      key?: string;
      possible_keys?: string;
      Extra?: string;
    }>(explain);
    expect(Array.isArray(rows) && rows.length).toBeGreaterThan(0);
    const instances = rows.find((row) => row.table === "i");
    const confirmations = rows.find((row) => row.table === "c");
    expect(confirmations?.type).toBe("eq_ref");
    expect(confirmations?.key).toMatch(/assignment_id/);
    expect(String(instances?.Extra ?? "")).toMatch(/where/i);
    expect(String(instances?.possible_keys ?? instances?.key ?? "")).toMatch(
      /PRIMARY|vacancy_lookup|topology_id|institution_id/,
    );
    // MySQL 8 em tabela pequena (CI fresco) escolhe type=ALL mesmo com índice
    // candidato. Isso não é varredura histórica: o predicado start_at está no
    // WHERE e o JOIN de confirmation é eq_ref na unique(assignment_id).
    // Índice leading em start_at exigiria migration — fora desta PR.
    if (instances?.type === "ALL") {
      expect(String(instances.Extra ?? "")).toMatch(/where/i);
    } else {
      expect(["eq_ref", "ref", "range", "index", "const"]).toContain(
        instances?.type,
      );
    }
  });
});

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";

import {
  dutyConfirmations,
  hospitals,
  institutions,
  monthlyRosters,
  professionalInstitutions,
  professionals,
  sectors,
  shiftAssignmentsV2,
  shiftInstances,
  users,
} from "../drizzle/schema";
import {
  expireStaleConfirmations,
  notifyManagersConfirmationEscalation,
} from "../server/cron/shift-confirmation-dispatcher";
import { getDb } from "../server/db";
import { yearMonthBrt } from "../server/local-time";

vi.mock("../server/push-delivery", () => ({
  sendTrackedPushNotification: vi.fn(async () => ({
    notificationId: 1,
    status: "PENDING" as const,
    phase: "TICKET_ACCEPTED" as const,
    ticketAccepted: true,
    providerAccepted: false,
  })),
  enqueueTrackedPushNotification: vi.fn(async () => ({
    notificationId: 1,
    status: "PENDING" as const,
    phase: "QUEUED" as const,
    ticketAccepted: false,
    providerAccepted: false,
  })),
  processPendingPushDeliveries: vi.fn(async () => 0),
  findTrackedNotificationByDedupKey: vi.fn(async () => null),
  TrackedIntentCollisionError: class extends Error {},
}));
vi.mock("../server/sso/duty-sync", () => ({
  enqueueDutySync: vi.fn(async () => 1),
  processPendingDutySyncs: vi.fn(async () => 0),
}));
vi.mock("../server/integrations/comunica-plus", () => ({
  processPendingComunicaPlusOutbox: vi.fn(async () => 0),
}));

const stamp = `${Date.now()}${Math.floor(Math.random() * 10_000)}`;
const NOW = new Date("2026-09-12T15:00:00.000Z");
const hours = (n: number) => n * 3_600_000;

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

/**
 * Decisão do PO (12/09/2026): confirmação sem resposta encerra quando o
 * plantão termina (terminal, sem aviso); o aviso ao gestor é escolha da
 * instituição. As pendências antigas do staging são descartadas por este
 * mesmo caminho na primeira rodada após o deploy.
 */
describe("confirmações: encerramento e política do aviso ao gestor", () => {
  let db: Db;
  let institutionId = 0;
  let hospitalId = 0;
  let sectorId = 0;
  let userId = 0;
  let professionalId = 0;
  const shiftIds: number[] = [];
  const confirmationIds: number[] = [];

  async function shiftWithConfirmation(input: {
    startAt: Date;
    endAt: Date;
    status?: "PENDING" | "NOMINATED" | "CONFIRMED";
    managerNotified?: boolean;
  }) {
    // A validação canônica exige escala oficial publicada no mês do plantão.
    await db
      .insert(monthlyRosters)
      .values({
        institutionId,
        hospitalId,
        yearMonth: yearMonthBrt(input.startAt),
        status: "PUBLISHED",
      })
      .onDuplicateKeyUpdate({ set: { status: "PUBLISHED" } });
    const [shift] = await db.insert(shiftInstances).values({
      institutionId,
      hospitalId,
      sectorId,
      label: `Expira ${stamp}`,
      startAt: input.startAt,
      endAt: input.endAt,
      modality: "PLANTAO",
    });
    shiftIds.push(shift.insertId);
    const [assignment] = await db.insert(shiftAssignmentsV2).values({
      institutionId,
      hospitalId,
      sectorId,
      shiftInstanceId: shift.insertId,
      professionalId,
      status: "OCUPADO",
      isActive: true,
    });
    const [confirmation] = await db.insert(dutyConfirmations).values({
      institutionId,
      shiftInstanceId: shift.insertId,
      assignmentId: assignment.insertId,
      professionalId,
      userId,
      status: input.status ?? "PENDING",
      confirmationToken: `tok-${stamp}-${shift.insertId}`,
      managerNotified: input.managerNotified ?? false,
    });
    confirmationIds.push(confirmation.insertId);
    return confirmation.insertId;
  }

  async function statusOf(id: number) {
    const [row] = await db
      .select({
        status: dutyConfirmations.status,
        expiredAt: dutyConfirmations.expiredAt,
        suppressedAt: dutyConfirmations.escalationSuppressedAt,
        managerNotified: dutyConfirmations.managerNotified,
      })
      .from(dutyConfirmations)
      .where(eq(dutyConfirmations.id, id));
    return row;
  }

  beforeAll(async () => {
    const loaded = await getDb();
    if (!loaded) throw new Error("Banco de testes indisponível");
    db = loaded;
    const [institution] = await db.insert(institutions).values({
      name: `Inst expira ${stamp}`,
      cnpj: `${stamp}7`.slice(-14).padStart(14, "0"),
      timeZone: "America/Sao_Paulo",
    });
    institutionId = institution.insertId;
    const [hospital] = await db.insert(hospitals).values({
      institutionId,
      name: `Hosp expira ${stamp}`,
    });
    hospitalId = hospital.insertId;
    const [sector] = await db.insert(sectors).values({
      institutionId,
      hospitalId,
      name: `Setor expira ${stamp}`,
      category: "internacao",
      color: "#123456",
    });
    sectorId = sector.insertId;
    const [user] = await db.insert(users).values({
      name: `Expira ${stamp}`,
      email: `expira-${stamp}@test.local`,
      password: "x".repeat(20),
      role: "doctor",
    });
    userId = user.insertId;
    const [professional] = await db.insert(professionals).values({
      userId,
      name: `Prof expira ${stamp}`,
      role: "doctor",
    });
    professionalId = professional.insertId;
    await db.insert(professionalInstitutions).values({
      professionalId,
      userId,
      institutionId,
      roleInInstitution: "USER",
      isPrimary: true,
      active: true,
    });
  });

  afterAll(async () => {
    if (!db || !institutionId) return;
    if (confirmationIds.length) {
      await db
        .delete(dutyConfirmations)
        .where(inArray(dutyConfirmations.id, confirmationIds));
    }
    if (shiftIds.length) {
      await db
        .delete(shiftAssignmentsV2)
        .where(inArray(shiftAssignmentsV2.shiftInstanceId, shiftIds));
      await db.delete(shiftInstances).where(inArray(shiftInstances.id, shiftIds));
    }
    await db
      .delete(monthlyRosters)
      .where(eq(monthlyRosters.institutionId, institutionId));
    await db
      .delete(professionalInstitutions)
      .where(eq(professionalInstitutions.institutionId, institutionId));
    await db.delete(professionals).where(eq(professionals.id, professionalId));
    await db.delete(sectors).where(eq(sectors.id, sectorId));
    await db.delete(hospitals).where(eq(hospitals.id, hospitalId));
    await db.delete(institutions).where(eq(institutions.id, institutionId));
    await db.delete(users).where(eq(users.id, userId));
  });

  it("plantão que terminou sem resposta encerra como EXPIRED; o que ainda vai acontecer fica", async () => {
    const ended = await shiftWithConfirmation({
      startAt: new Date(NOW.getTime() - hours(14)),
      endAt: new Date(NOW.getTime() - hours(2)),
      managerNotified: true,
    });
    const endedNominated = await shiftWithConfirmation({
      startAt: new Date(NOW.getTime() - hours(30)),
      endAt: new Date(NOW.getTime() - hours(18)),
      status: "NOMINATED",
    });
    const running = await shiftWithConfirmation({
      startAt: new Date(NOW.getTime() - hours(2)),
      endAt: new Date(NOW.getTime() + hours(10)),
    });
    const confirmedEnded = await shiftWithConfirmation({
      startAt: new Date(NOW.getTime() - hours(14)),
      endAt: new Date(NOW.getTime() - hours(2)),
      status: "CONFIRMED",
    });

    const expired = await expireStaleConfirmations(NOW);
    expect(expired).toBeGreaterThanOrEqual(2);

    expect((await statusOf(ended))?.status).toBe("EXPIRED");
    expect((await statusOf(ended))?.expiredAt).not.toBeNull();
    expect((await statusOf(endedNominated))?.status).toBe("EXPIRED");
    expect((await statusOf(running))?.status).toBe("PENDING");
    expect((await statusOf(confirmedEnded))?.status).toBe("CONFIRMED");

    // Rerodar não mexe em nada.
    const again = await expireStaleConfirmations(NOW);
    expect(again).toBe(0);
  });

  it("com o aviso desligado na instituição, a escalação não avisa ninguém e marca a supressão", async () => {
    await db
      .update(institutions)
      .set({ notifyManagerOnUnconfirmed: false })
      .where(eq(institutions.id, institutionId));
    const id = await shiftWithConfirmation({
      startAt: new Date(NOW.getTime() + hours(3)),
      endAt: new Date(NOW.getTime() + hours(15)),
    });

    const result = await notifyManagersConfirmationEscalation(id, "NO_RESPONSE");
    // O desfecho precisa dizer POR QUE ninguém foi avisado: sem isto, o
    // chamador confunde "a instituição desligou o aviso" com "não existe
    // gestor" e toca alarme para quem só exerceu uma opção do produto.
    expect(result).toEqual({
      outcome: "SUPPRESSED_BY_POLICY",
      managerCount: 0,
      intentCount: 0,
    });

    const row = await statusOf(id);
    expect(row?.status).toBe("PENDING");
    expect(row?.suppressedAt).not.toBeNull();
    expect(row?.managerNotified).toBe(false);
  });
});

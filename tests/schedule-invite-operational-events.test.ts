import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  recordScheduleInviteAcceptedInTransaction,
  recordScheduleInviteCreatedInTransaction,
  recordScheduleInviteRevokedInTransaction,
  SCHEDULE_INVITE_SHADOW_EVENT_TYPES,
} from "../server/schedule-invite-operational-events";

const createOperationalEventInTransaction = vi.hoisted(() => vi.fn());

vi.mock("../server/operational-events", () => ({
  createOperationalEventInTransaction: (...args: unknown[]) =>
    createOperationalEventInTransaction(...args),
}));

function lockedRows<T>(rows: T[]) {
  const result = Promise.resolve(rows) as Promise<T[]> & {
    for: (_lock: "update") => Promise<T[]>;
  };
  result.for = () => result;
  return result;
}

function txWithMembershipChecks(checks: boolean[]) {
  const remaining = [...checks];
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () =>
            lockedRows(remaining.shift() === false ? [] : [{ id: 1 }]),
        }),
      }),
    }),
  };
}

const snapshot = {
  id: 41,
  institutionId: 2,
  hospitalId: 7,
  sectorId: 11,
  operationalRevision: 3,
  createdByUserId: 17,
  invitedUserId: 23,
};

const actor = {
  kind: "USER" as const,
  userId: 31,
  professionalId: 47,
  role: "GESTOR_MEDICO" as const,
};

describe("emissão SHADOW do ciclo de convite", () => {
  beforeEach(() => {
    createOperationalEventInTransaction.mockReset();
    createOperationalEventInTransaction.mockResolvedValue({
      eventId: 1,
      created: true,
      eventHash: "event-hash",
    });
  });

  it("fecha a frente nos três fatos que já têm ator e transição canônicos", () => {
    expect(SCHEDULE_INVITE_SHADOW_EVENT_TYPES).toEqual([
      "SCHEDULE_INVITE_CREATED",
      "SCHEDULE_INVITE_ACCEPTED",
      "SCHEDULE_INVITE_REVOKED",
    ]);
  });

  it("registra criação por ID, e-mail no convite e push somente para vínculo ativo", async () => {
    const tx = txWithMembershipChecks([true]);
    await recordScheduleInviteCreatedInTransaction(tx as never, {
      snapshot,
      actor,
      occurredAt: new Date("2026-09-02T10:00:00.000Z"),
    });

    expect(createOperationalEventInTransaction).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        idempotencyKey: "schedule-invite:41:revision:3:SCHEDULE_INVITE_CREATED",
        eventType: "SCHEDULE_INVITE_CREATED",
        deliveryPolicy: "NOTIFY",
        aggregate: { type: "SCHEDULE_INVITE", id: 41, version: 3 },
        transition: { from: null, to: "PENDING" },
        context: {
          institutionId: 2,
          hospitalId: 7,
          scopeKind: "SECTOR",
          sectorId: 11,
        },
        actor,
        recipients: [
          {
            kind: "SCHEDULE_INVITE",
            scheduleInviteId: 41,
            channels: ["EMAIL"],
          },
          { kind: "USER", userId: 23, channels: ["PUSH"] },
        ],
      }),
    );
    const event = createOperationalEventInTransaction.mock.calls[0][1];
    expect(event).not.toHaveProperty("emissionMode");
    expect(JSON.stringify(event)).not.toMatch(/email@|destination|address/i);
  });

  it("não inventa destinatário USER quando o convidado ainda não tem vínculo ativo", async () => {
    await recordScheduleInviteCreatedInTransaction(
      txWithMembershipChecks([false]) as never,
      {
        snapshot,
        actor,
        occurredAt: new Date("2026-09-02T10:00:00.000Z"),
      },
    );

    expect(
      createOperationalEventInTransaction.mock.calls[0][1].recipients,
    ).toEqual([
      {
        kind: "SCHEDULE_INVITE",
        scheduleInviteId: 41,
        channels: ["EMAIL"],
      },
    ]);
  });

  it("notifica o emissor ativo nos dois canais após aceite", async () => {
    await recordScheduleInviteAcceptedInTransaction(
      txWithMembershipChecks([true]) as never,
      {
        snapshot,
        actor: {
          ...actor,
          userId: snapshot.invitedUserId,
          professionalId: 48,
          role: "USER",
        },
        occurredAt: new Date("2026-09-02T10:01:00.000Z"),
      },
    );

    expect(createOperationalEventInTransaction.mock.calls[0][1]).toMatchObject({
      eventType: "SCHEDULE_INVITE_ACCEPTED",
      deliveryPolicy: "NOTIFY",
      aggregate: { type: "SCHEDULE_INVITE", id: 41, version: 3 },
      transition: { from: "PENDING", to: "ACCEPTED" },
      recipients: [{ kind: "USER", userId: 17, channels: ["PUSH", "EMAIL"] }],
    });
  });

  it("mantém o fato de aceite sem entrega quando o criador não é entregável", async () => {
    await recordScheduleInviteAcceptedInTransaction(
      txWithMembershipChecks([false]) as never,
      {
        snapshot,
        actor: {
          ...actor,
          userId: snapshot.invitedUserId,
          professionalId: 48,
          role: "USER",
        },
        occurredAt: new Date("2026-09-02T10:01:00.000Z"),
      },
    );

    expect(createOperationalEventInTransaction.mock.calls[0][1]).toMatchObject({
      recipients: [],
      recipientResolution: "NO_DELIVERABLE_RECIPIENTS",
    });
  });

  it("mantém o aceite autoemitido auditado, sem notificar o próprio ator", async () => {
    const selfIssuedSnapshot = {
      ...snapshot,
      createdByUserId: snapshot.invitedUserId,
    };
    await recordScheduleInviteAcceptedInTransaction(
      txWithMembershipChecks([true]) as never,
      {
        snapshot: selfIssuedSnapshot,
        actor: {
          ...actor,
          userId: snapshot.invitedUserId,
          professionalId: 48,
          role: "USER",
        },
        occurredAt: new Date("2026-09-02T10:01:00.000Z"),
      },
    );

    expect(createOperationalEventInTransaction.mock.calls[0][1]).toMatchObject({
      recipients: [],
      recipientResolution: "NO_ELIGIBLE_RECIPIENTS",
    });
  });

  it("registra revogação somente como fato auditado, sem destinatário", async () => {
    const tx = txWithMembershipChecks([]);
    await recordScheduleInviteRevokedInTransaction(tx as never, {
      snapshot,
      actor,
      occurredAt: new Date("2026-09-02T10:02:00.000Z"),
    });

    expect(createOperationalEventInTransaction).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        eventType: "SCHEDULE_INVITE_REVOKED",
        deliveryPolicy: "SILENT_AUDITED",
        transition: { from: "PENDING", to: "REVOKED" },
        recipients: [],
        recipientResolution: "NOT_APPLICABLE",
      }),
    );
  });

  it("preserva a revogação auditada para convite legado sem médico nominal", async () => {
    const tx = txWithMembershipChecks([]);
    await recordScheduleInviteRevokedInTransaction(tx as never, {
      snapshot: { ...snapshot, invitedUserId: null },
      actor,
      occurredAt: new Date("2026-09-02T10:02:00.000Z"),
    });

    expect(createOperationalEventInTransaction).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        eventType: "SCHEDULE_INVITE_REVOKED",
        deliveryPolicy: "SILENT_AUDITED",
        recipients: [],
      }),
    );
  });

  it("exige médico nominal apenas nos fatos que dependem do destinatário", async () => {
    const legacySnapshot = { ...snapshot, invitedUserId: null };

    await expect(
      recordScheduleInviteCreatedInTransaction(
        txWithMembershipChecks([]) as never,
        {
          snapshot: legacySnapshot,
          actor,
          occurredAt: new Date("2026-09-02T10:00:00.000Z"),
        },
      ),
    ).rejects.toThrow("Criação canônica exige convite nominal");
    await expect(
      recordScheduleInviteAcceptedInTransaction(
        txWithMembershipChecks([]) as never,
        {
          snapshot: legacySnapshot,
          actor: { ...actor, userId: 23, professionalId: 48, role: "USER" },
          occurredAt: new Date("2026-09-02T10:01:00.000Z"),
        },
      ),
    ).rejects.toThrow("Aceite canônico exige convite nominal");
  });

  it("propaga falha do ledger para que a transação externa faça rollback", async () => {
    createOperationalEventInTransaction.mockRejectedValueOnce(
      new Error("falha forçada do ledger"),
    );
    await expect(
      recordScheduleInviteCreatedInTransaction(
        txWithMembershipChecks([true]) as never,
        {
          snapshot,
          actor,
          occurredAt: new Date("2026-09-02T10:00:00.000Z"),
        },
      ),
    ).rejects.toThrow("falha forçada do ledger");

    createOperationalEventInTransaction.mockRejectedValueOnce(
      new Error("falha forçada do ledger"),
    );
    await expect(
      recordScheduleInviteAcceptedInTransaction(
        txWithMembershipChecks([true]) as never,
        {
          snapshot,
          actor: { ...actor, userId: 23, professionalId: 48, role: "USER" },
          occurredAt: new Date("2026-09-02T10:01:00.000Z"),
        },
      ),
    ).rejects.toThrow("falha forçada do ledger");

    createOperationalEventInTransaction.mockRejectedValueOnce(
      new Error("falha forçada do ledger"),
    );
    await expect(
      recordScheduleInviteRevokedInTransaction(
        txWithMembershipChecks([]) as never,
        {
          snapshot,
          actor,
          occurredAt: new Date("2026-09-02T10:02:00.000Z"),
        },
      ),
    ).rejects.toThrow("falha forçada do ledger");
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  recordSwapLifecycleShadowEventInTransaction,
  swapLifecycleShadowIdempotencyKey,
} from "../server/swap-lifecycle-operational-events";

const createOperationalEventInTransaction = vi.hoisted(() => vi.fn());
const eligibleRecipientUserIdsForSwapOffer = vi.hoisted(() => vi.fn());

vi.mock("../server/operational-events", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../server/operational-events")>();
  return {
    ...actual,
    createOperationalEventInTransaction: (...args: unknown[]) =>
      createOperationalEventInTransaction(...args),
  };
});

vi.mock("../server/swap-offer-eligibility", () => ({
  eligibleRecipientUserIdsForSwapOffer: (...args: unknown[]) =>
    eligibleRecipientUserIdsForSwapOffer(...args),
}));

function lockedRows<T>(rows: T[]) {
  const result = Promise.resolve(rows) as Promise<T[]> & {
    for: (_lock: "update") => Promise<T[]>;
  };
  result.for = () => result;
  return result;
}

function queryRows<T>(rows: T[]) {
  const result = lockedRows(rows);
  const chain = {
    from: () => chain,
    innerJoin: () => chain,
    where: () => chain,
    limit: () => result,
  };
  return chain;
}

function txWithSelectRows(selectRows: unknown[][]) {
  const remaining = [...selectRows];
  return {
    select: () => queryRows(remaining.shift() ?? []),
  };
}

const pendingSwap = {
  id: 91,
  version: 1,
  status: "PENDING",
  institutionId: 2,
  hospitalId: 7,
  sectorId: 11,
  fromProfessionalId: 29,
  fromUserId: 23,
  fromShiftInstanceId: 17,
  fromAssignmentId: 19,
  toProfessionalId: null,
  toUserId: null,
};

const source = {
  institutionId: 2,
  hospitalId: 7,
  sectorId: 11,
  scheduleContextId: 13,
  shiftInstanceId: 17,
  assignmentId: 19,
};

const activeActor = { roleInInstitution: "USER" };
const activeMembership = { id: 1 };
const activeIdentity = { id: 41 };

describe("fatos SHADOW do ciclo de troca", () => {
  beforeEach(() => {
    createOperationalEventInTransaction.mockReset();
    createOperationalEventInTransaction.mockResolvedValue({
      eventId: 1,
      created: true,
      eventHash: "hash",
    });
    eligibleRecipientUserIdsForSwapOffer.mockReset();
  });

  it("usa a chave idempotente formada por troca, versão final e tipo", () => {
    expect(
      swapLifecycleShadowIdempotencyKey({
        eventType: "SWAP_ACCEPTED",
        swapId: 91,
        version: 2,
      }),
    ).toBe("swap-lifecycle-shadow:swap:91:version:2:event:SWAP_ACCEPTED");
  });

  it("registra oferta aberta para elegíveis canônicos, sem incluir o ofertante", async () => {
    // O resolvedor de elegibilidade não tem contrato de ORDER BY. A camada
    // do ledger precisa travar e persistir em ordem estável mesmo se o SQL
    // devolver usuários na ordem inversa.
    eligibleRecipientUserIdsForSwapOffer.mockResolvedValue([37, 31, 37, 23]);
    const tx = txWithSelectRows([
      [pendingSwap],
      [source],
      [activeActor],
      [activeMembership],
      [activeMembership],
    ]);

    await recordSwapLifecycleShadowEventInTransaction(tx as never, {
      eventType: "SWAP_OFFERED",
      previousStatus: null,
      swapId: 91,
      institutionId: 2,
      expectedVersion: 1,
      actor: { userId: 23, professionalId: 29 },
    });

    const event = createOperationalEventInTransaction.mock.calls[0]?.[1];
    expect(event).toMatchObject({
      eventType: "SWAP_OFFERED",
      deliveryPolicy: "BROADCAST",
      aggregate: { type: "SWAP_REQUEST", id: 91, version: 1 },
      transition: { from: null, to: "PENDING" },
      context: {
        institutionId: 2,
        hospitalId: 7,
        sectorId: 11,
        scheduleContextId: 13,
        shiftInstanceId: 17,
        assignmentId: 19,
      },
      recipients: [
        { kind: "USER", userId: 31, channels: ["PUSH", "EMAIL"] },
        { kind: "USER", userId: 37, channels: ["PUSH", "EMAIL"] },
      ],
    });
    expect(event).not.toHaveProperty("emissionMode");
    expect(JSON.stringify(event)).not.toMatch(
      /@|recipientEmail|actorName|specialty/i,
    );
  });

  it("mantém oferta dirigida auditada quando o alvo já não é elegível", async () => {
    eligibleRecipientUserIdsForSwapOffer.mockResolvedValue([]);
    const tx = txWithSelectRows([
      [{ ...pendingSwap, toProfessionalId: 41, toUserId: 43 }],
      [source],
      [activeActor],
    ]);

    await recordSwapLifecycleShadowEventInTransaction(tx as never, {
      eventType: "SWAP_OFFERED",
      previousStatus: null,
      swapId: 91,
      institutionId: 2,
      expectedVersion: 1,
      actor: { userId: 23, professionalId: 29 },
    });

    expect(
      createOperationalEventInTransaction.mock.calls[0]?.[1],
    ).toMatchObject({
      eventType: "SWAP_OFFERED",
      deliveryPolicy: "NOTIFY",
      recipients: [],
      recipientResolution: "NO_ELIGIBLE_RECIPIENTS",
    });
  });

  it("registra a conclusão residual ACCEPTED → APPROVED para as duas partes deduplicadas", async () => {
    const tx = txWithSelectRows([
      [
        {
          ...pendingSwap,
          version: 2,
          status: "APPROVED",
          toProfessionalId: 41,
          toUserId: 43,
        },
      ],
      [source],
      [activeActor],
      [activeMembership],
      [activeIdentity],
      [activeMembership],
    ]);

    await recordSwapLifecycleShadowEventInTransaction(tx as never, {
      eventType: "SWAP_ACCEPTED",
      previousStatus: "ACCEPTED",
      swapId: 91,
      institutionId: 2,
      expectedVersion: 2,
      actor: { userId: 43, professionalId: 41 },
    });

    expect(
      createOperationalEventInTransaction.mock.calls[0]?.[1],
    ).toMatchObject({
      eventType: "SWAP_ACCEPTED",
      transition: { from: "ACCEPTED", to: "APPROVED" },
      recipients: [
        { kind: "USER", userId: 23, channels: ["PUSH", "EMAIL"] },
        { kind: "USER", userId: 43, channels: ["PUSH", "EMAIL"] },
      ],
    });
  });

  it("não transforma dismiss individual aberto em rejeição global", async () => {
    const tx = txWithSelectRows([
      [{ ...pendingSwap, version: 2, status: "REJECTED_BY_PEER" }],
      [source],
      [activeActor],
    ]);

    await expect(
      recordSwapLifecycleShadowEventInTransaction(tx as never, {
        eventType: "SWAP_REJECTED",
        previousStatus: "PENDING",
        swapId: 91,
        institutionId: 2,
        expectedVersion: 2,
        actor: { userId: 43, professionalId: 41 },
      }),
    ).rejects.toThrow("exige contraparte canônica");
    expect(createOperationalEventInTransaction).not.toHaveBeenCalled();
  });

  it("preserva cancelamento global auditado quando nenhum participante ainda é entregável", async () => {
    const tx = txWithSelectRows([
      [
        {
          ...pendingSwap,
          version: 2,
          status: "CANCELLED",
          toProfessionalId: 41,
          toUserId: 43,
        },
      ],
      [source],
      [activeActor],
      [],
      [activeIdentity],
      [],
    ]);

    await recordSwapLifecycleShadowEventInTransaction(tx as never, {
      eventType: "SWAP_CANCELLED",
      previousStatus: "PENDING",
      swapId: 91,
      institutionId: 2,
      expectedVersion: 2,
      actor: { userId: 23, professionalId: 29 },
    });

    expect(
      createOperationalEventInTransaction.mock.calls[0]?.[1],
    ).toMatchObject({
      eventType: "SWAP_CANCELLED",
      transition: { from: "PENDING", to: "CANCELLED" },
      recipients: [],
      recipientResolution: "NO_DELIVERABLE_RECIPIENTS",
    });
  });

  it("rejeita versão final divergente antes de chamar o ledger", async () => {
    const tx = txWithSelectRows([[pendingSwap], [source]]);
    await expect(
      recordSwapLifecycleShadowEventInTransaction(tx as never, {
        eventType: "SWAP_OFFERED",
        previousStatus: null,
        swapId: 91,
        institutionId: 2,
        expectedVersion: 2,
        actor: { userId: 23, professionalId: 29 },
      }),
    ).rejects.toThrow("versão canônica da troca diverge");
    expect(createOperationalEventInTransaction).not.toHaveBeenCalled();
  });

  it("não atravessa tenant: swap fora da instituição não produz fato", async () => {
    const tx = txWithSelectRows([[]]);
    await expect(
      recordSwapLifecycleShadowEventInTransaction(tx as never, {
        eventType: "SWAP_OFFERED",
        previousStatus: null,
        swapId: 91,
        institutionId: 999,
        expectedVersion: 1,
        actor: { userId: 23, professionalId: 29 },
      }),
    ).rejects.toThrow("sem escopo setorial canônico");
    expect(createOperationalEventInTransaction).not.toHaveBeenCalled();
  });

  it("não registra fato dirigido quando a contraparte não tem par usuário-profissional canônico", async () => {
    const tx = txWithSelectRows([
      [
        {
          ...pendingSwap,
          version: 2,
          status: "CANCELLED",
          toProfessionalId: 41,
          toUserId: 43,
        },
      ],
      [source],
      [activeActor],
      [activeMembership],
      [],
    ]);

    await expect(
      recordSwapLifecycleShadowEventInTransaction(tx as never, {
        eventType: "SWAP_CANCELLED",
        previousStatus: "PENDING",
        swapId: 91,
        institutionId: 2,
        expectedVersion: 2,
        actor: { userId: 23, professionalId: 29 },
      }),
    ).rejects.toThrow("contraparte da troca não possui identidade canônica");
    expect(createOperationalEventInTransaction).not.toHaveBeenCalled();
  });

  it("propaga falha do ledger para que o writer externo faça rollback", async () => {
    eligibleRecipientUserIdsForSwapOffer.mockResolvedValue([]);
    createOperationalEventInTransaction.mockRejectedValueOnce(
      new Error("ledger indisponível"),
    );
    const tx = txWithSelectRows([[pendingSwap], [source], [activeActor]]);

    await expect(
      recordSwapLifecycleShadowEventInTransaction(tx as never, {
        eventType: "SWAP_OFFERED",
        previousStatus: null,
        swapId: 91,
        institutionId: 2,
        expectedVersion: 1,
        actor: { userId: 23, professionalId: 29 },
      }),
    ).rejects.toThrow("ledger indisponível");
  });
});

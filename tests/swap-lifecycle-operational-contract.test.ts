import { describe, expect, it } from "vitest";
import {
  getOperationalEventEmissionMode,
  OPERATIONAL_EVENT_TRANSITION_CONTRACTS,
  operationalDeliveryChannelsForEmission,
  OperationalEventValidationError,
  operationalEventHash,
  type CreateOperationalEventInput,
} from "../server/operational-events";

function swapEvent(input: {
  eventType:
    "SWAP_OFFERED" | "SWAP_ACCEPTED" | "SWAP_REJECTED" | "SWAP_CANCELLED";
  version: number;
  transition: NonNullable<CreateOperationalEventInput["transition"]>;
  deliveryPolicy?: "NOTIFY" | "BROADCAST";
}): CreateOperationalEventInput {
  return {
    idempotencyKey: `swap:${input.eventType}:${input.version}`,
    eventType: input.eventType,
    deliveryPolicy: input.deliveryPolicy ?? "NOTIFY",
    aggregate: { type: "SWAP_REQUEST", id: 91, version: input.version },
    transition: input.transition,
    context: {
      institutionId: 2,
      hospitalId: 7,
      scopeKind: "SECTOR",
      sectorId: 11,
      scheduleContextId: 13,
      shiftInstanceId: 17,
      assignmentId: 19,
    },
    actor: {
      kind: "USER",
      userId: 23,
      professionalId: 29,
      role: "USER",
    },
    recipients: [{ kind: "USER", userId: 31, channels: ["PUSH", "EMAIL"] }],
  };
}

describe("contrato fechado de fatos operacionais do ciclo de troca", () => {
  it("admite somente as quatro transições globais explicitamente suportadas", () => {
    expect(OPERATIONAL_EVENT_TRANSITION_CONTRACTS).toMatchObject({
      SWAP_OFFERED: {
        from: null,
        to: "PENDING",
        aggregateStatus: "PENDING",
      },
      SWAP_ACCEPTED: {
        from: "PENDING",
        additionalAllowedFrom: ["ACCEPTED"],
        to: "APPROVED",
        aggregateStatus: "APPROVED",
      },
      SWAP_REJECTED: {
        from: "PENDING",
        to: "REJECTED",
        aggregateStatus: "REJECTED_BY_PEER",
      },
      SWAP_CANCELLED: {
        from: "PENDING",
        additionalAllowedFrom: ["ACCEPTED"],
        to: "CANCELLED",
        aggregateStatus: "CANCELLED",
      },
      SWAP_OFFER_DISMISSED: null,
      SWAP_EXPIRED: null,
    });
  });

  it("aceita PENDING ou ACCEPTED somente para a conclusão em APPROVED", () => {
    expect(() =>
      operationalEventHash(
        swapEvent({
          eventType: "SWAP_ACCEPTED",
          version: 2,
          transition: { from: "PENDING", to: "APPROVED" },
        }),
      ),
    ).not.toThrow();
    expect(() =>
      operationalEventHash(
        swapEvent({
          eventType: "SWAP_ACCEPTED",
          version: 3,
          transition: { from: "ACCEPTED", to: "APPROVED" },
        }),
      ),
    ).not.toThrow();

    expect(() =>
      operationalEventHash(
        swapEvent({
          eventType: "SWAP_ACCEPTED",
          version: 4,
          transition: { from: "CANCELLED", to: "APPROVED" },
        }),
      ),
    ).toThrow(OperationalEventValidationError);
  });

  it("mantém a semântica operacional separada do status físico da rejeição", () => {
    expect(() =>
      operationalEventHash(
        swapEvent({
          eventType: "SWAP_REJECTED",
          version: 2,
          transition: { from: "PENDING", to: "REJECTED" },
        }),
      ),
    ).not.toThrow();
  });

  it("não permite usar o fato de cancelamento para qualquer estado anterior", () => {
    expect(() =>
      operationalEventHash(
        swapEvent({
          eventType: "SWAP_CANCELLED",
          version: 2,
          transition: { from: "PENDING", to: "CANCELLED" },
        }),
      ),
    ).not.toThrow();
    expect(() =>
      operationalEventHash(
        swapEvent({
          eventType: "SWAP_CANCELLED",
          version: 3,
          transition: { from: "ACCEPTED", to: "CANCELLED" },
        }),
      ),
    ).not.toThrow();
    expect(() =>
      operationalEventHash(
        swapEvent({
          eventType: "SWAP_CANCELLED",
          version: 4,
          transition: { from: "REJECTED", to: "CANCELLED" },
        }),
      ),
    ).toThrow("transition não corresponde ao contrato canônico do evento");
  });

  it("mantém todos os fatos desta frente em SHADOW, sem delivery latente", () => {
    for (const eventType of [
      "SWAP_OFFERED",
      "SWAP_ACCEPTED",
      "SWAP_REJECTED",
      "SWAP_CANCELLED",
    ] as const) {
      expect(getOperationalEventEmissionMode(eventType)).toBe("SHADOW");
      expect(
        operationalDeliveryChannelsForEmission(
          getOperationalEventEmissionMode(eventType),
          ["PUSH", "EMAIL"],
        ),
      ).toEqual([]);
    }
  });
});

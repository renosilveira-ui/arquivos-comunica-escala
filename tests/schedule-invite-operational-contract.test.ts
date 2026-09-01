import { describe, expect, it } from "vitest";
import {
  operationalEventHash,
  OPERATIONAL_AGGREGATE_VERSION_CAPABILITIES,
  OPERATIONAL_EVENT_TRANSITION_CONTRACTS,
  OperationalEventValidationError,
  type CreateOperationalEventInput,
} from "../server/operational-events";

function inviteEvent(
  eventType: CreateOperationalEventInput["eventType"],
): CreateOperationalEventInput {
  return {
    idempotencyKey: `invite:41:${eventType}`,
    eventType,
    deliveryPolicy:
      eventType === "SCHEDULE_INVITE_REVOKED" ? "SILENT_AUDITED" : "NOTIFY",
    aggregate: { type: "SCHEDULE_INVITE", id: 41, version: 3 },
    transition:
      eventType === "SCHEDULE_INVITE_CREATED"
        ? { from: null, to: "PENDING" }
        : eventType === "SCHEDULE_INVITE_ACCEPTED"
          ? { from: "PENDING", to: "ACCEPTED" }
          : eventType === "SCHEDULE_INVITE_REVOKED"
            ? { from: "PENDING", to: "REVOKED" }
            : undefined,
    context: {
      institutionId: 2,
      hospitalId: 7,
      scopeKind: "SECTOR",
      sectorId: 11,
    },
    actor: { kind: "USER", userId: 31, role: "GESTOR_MEDICO" },
    recipients:
      eventType === "SCHEDULE_INVITE_REVOKED"
        ? []
        : [
            eventType === "SCHEDULE_INVITE_CREATED"
              ? {
                  kind: "SCHEDULE_INVITE" as const,
                  scheduleInviteId: 41,
                  channels: ["EMAIL" as const],
                }
              : {
                  kind: "USER" as const,
                  userId: 17,
                  channels: ["PUSH" as const, "EMAIL" as const],
                },
          ],
    ...(eventType === "SCHEDULE_INVITE_REVOKED"
      ? { recipientResolution: "NOT_APPLICABLE" as const }
      : {}),
  };
}

describe("contrato canônico do convite em SHADOW", () => {
  it("permite somente os três fatos com revisão e transição implementadas", () => {
    expect(OPERATIONAL_AGGREGATE_VERSION_CAPABILITIES.SCHEDULE_INVITE).toBe(
      "ROW_VERSION",
    );
    expect(OPERATIONAL_EVENT_TRANSITION_CONTRACTS).toMatchObject({
      SCHEDULE_INVITE_CREATED: {
        from: null,
        to: "PENDING",
        aggregateStatus: "PENDING",
      },
      SCHEDULE_INVITE_ACCEPTED: {
        from: "PENDING",
        to: "ACCEPTED",
        aggregateStatus: "ACCEPTED",
      },
      SCHEDULE_INVITE_REVOKED: {
        from: "PENDING",
        to: "REVOKED",
        aggregateStatus: "REVOKED",
      },
      SCHEDULE_INVITE_DECLINED: null,
      SCHEDULE_INVITE_EXPIRED: null,
    });

    expect(() =>
      operationalEventHash(inviteEvent("SCHEDULE_INVITE_CREATED")),
    ).not.toThrow();
    expect(() =>
      operationalEventHash(inviteEvent("SCHEDULE_INVITE_ACCEPTED")),
    ).not.toThrow();
    expect(() =>
      operationalEventHash(inviteEvent("SCHEDULE_INVITE_REVOKED")),
    ).not.toThrow();
  });

  it("bloqueia explicitamente recusa e expiração até existir ator e writer canônicos", () => {
    for (const eventType of [
      "SCHEDULE_INVITE_DECLINED",
      "SCHEDULE_INVITE_EXPIRED",
    ] as const) {
      expect(() => operationalEventHash(inviteEvent(eventType))).toThrow(
        OperationalEventValidationError,
      );
      expect(() => operationalEventHash(inviteEvent(eventType))).toThrow(
        "Evento ainda não possui contrato canônico de transição",
      );
    }
  });
});

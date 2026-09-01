import { describe, expect, it } from "vitest";
import {
  notificationDeliveries,
  operationalEventRecipients,
  operationalEvents,
} from "../drizzle/schema";
import {
  createOperationalEventInTransaction,
  OperationalEventValidationError,
  type CreateOperationalEventInput,
  type OperationalEventTx,
} from "../server/operational-events";
import {
  captureCanonicalVacancyRequest,
  captureVacancyRequestForDecisionOrLegacyAudit,
  LEGACY_REQUESTER_IDENTITY_UNPROVEN,
  recordVacancyRequestShadowEventInTransaction,
  VACANCY_REQUEST_SHADOW_OPERATIONS,
  VacancyRequesterIdentityUnprovenError,
  vacancyRequestShadowIdempotencyKey,
  type CapturedVacancyRequest,
} from "../server/vacancy-request-operational-events";

type VacancyRequestRow = {
  id: number;
  assignmentId: number;
  professionalId: number;
  createdByUserId: number;
  requesterUserId: number;
  operationalRevision: number;
  assignmentStatus: string;
  status: string;
  isActive: boolean;
  institutionId: number;
  hospitalId: number;
  sectorId: number;
  shiftInstanceId: number;
  scheduleContextId: number | null;
};

const capturedRequest: CapturedVacancyRequest = {
  context: {
    institutionId: 1,
    hospitalId: 10,
    sectorId: 4,
    scheduleContextId: 8,
    shiftInstanceId: 12,
    assignmentId: 44,
  },
  professionalId: 200,
  requesterUserId: 20,
  operationalRevision: 1,
  assignmentStatus: "PENDENTE",
  isActive: true,
};

function vacancyRequestRow(
  overrides: Partial<VacancyRequestRow> = {},
): VacancyRequestRow {
  const assignmentStatus =
    overrides.assignmentStatus ?? capturedRequest.assignmentStatus;
  return {
    id: capturedRequest.context.assignmentId,
    assignmentId: capturedRequest.context.assignmentId,
    professionalId: capturedRequest.professionalId,
    createdByUserId: capturedRequest.requesterUserId,
    requesterUserId: capturedRequest.requesterUserId,
    operationalRevision: capturedRequest.operationalRevision,
    assignmentStatus,
    status: overrides.status ?? assignmentStatus,
    isActive: capturedRequest.isActive,
    institutionId: capturedRequest.context.institutionId,
    hospitalId: capturedRequest.context.hospitalId,
    sectorId: capturedRequest.context.sectorId,
    shiftInstanceId: capturedRequest.context.shiftInstanceId,
    scheduleContextId: capturedRequest.context.scheduleContextId,
    ...overrides,
  };
}

function vacancyCaptureTransaction(row: VacancyRequestRow): OperationalEventTx {
  const lockedResult = { for: async () => [row] };
  const query = {
    innerJoin() {
      return query;
    },
    where() {
      return query;
    },
    limit() {
      return lockedResult;
    },
  };
  return {
    select() {
      return {
        from() {
          return query;
        },
      };
    },
  } as unknown as OperationalEventTx;
}

type Selection = readonly Record<string, unknown>[];

function vacancyFoundationTransaction(selections: readonly Selection[]) {
  const selectionQueue = [...selections];
  let event: { id: number; eventHash: string } | undefined;
  let recipientId = 0;
  const counters = { recipients: 0, deliveries: 0 };

  function lockable(rows: readonly Record<string, unknown>[]) {
    const result = Promise.resolve(rows) as Promise<
      readonly Record<string, unknown>[]
    > & {
      for: (_lock: "update") => Promise<readonly Record<string, unknown>[]>;
    };
    result.for = () => result;
    return result;
  }

  const tx = {
    select() {
      let source: unknown;
      let resolved: Promise<readonly Record<string, unknown>[]> | undefined;
      const rows = () => {
        if (!resolved) {
          resolved = lockable(
            source === operationalEvents
              ? event
                ? [event]
                : []
              : (selectionQueue.shift() ?? []),
          );
        }
        return resolved;
      };
      const query = {
        from(table: unknown) {
          source = table;
          return query;
        },
        innerJoin() {
          return query;
        },
        leftJoin() {
          return query;
        },
        where() {
          return query;
        },
        limit() {
          return rows();
        },
        for() {
          return rows();
        },
      };
      return query;
    },
    insert(table: unknown) {
      if (table === operationalEvents) {
        return {
          values: async (value: Record<string, unknown>) => {
            event = { id: 1, eventHash: value.eventHash as string };
          },
        };
      }
      if (table === operationalEventRecipients) {
        return {
          values: () => ({
            $returningId: async () => {
              recipientId += 1;
              counters.recipients += 1;
              return [{ id: recipientId }];
            },
          }),
        };
      }
      if (table === notificationDeliveries) {
        return {
          values: async () => {
            counters.deliveries += 1;
          },
        };
      }
      throw new Error("Tabela inesperada na foundation de solicitação");
    },
  } as unknown as OperationalEventTx;

  return { tx, counters, remainingSelections: () => selectionQueue.length };
}

function vacancyRequestedEvent(): CreateOperationalEventInput {
  return {
    idempotencyKey:
      "vacancy-request-shadow:revision:1:operation:REQUESTED:assignment:44:action:REQUEST",
    eventType: "VACANCY_REQUESTED",
    deliveryPolicy: "NOTIFY",
    aggregate: { type: "VACANCY_REQUEST", id: 44, version: 1 },
    transition: { from: "NONE", to: "PENDING" },
    context: {
      institutionId: 1,
      hospitalId: 10,
      scopeKind: "SECTOR",
      sectorId: 4,
      scheduleContextId: 8,
      shiftInstanceId: 12,
      assignmentId: 44,
    },
    actor: {
      kind: "USER",
      userId: 20,
      professionalId: 200,
      role: "USER",
    },
    recipients: [{ kind: "USER", userId: 7, channels: ["PUSH", "EMAIL"] }],
    recipientResolution: "RESOLVED",
  };
}

function vacancyDecisionEvent(
  operation: "APPROVED" | "REJECTED",
): CreateOperationalEventInput {
  const approved = operation === "APPROVED";
  return {
    idempotencyKey: `vacancy-request-shadow:revision:2:operation:${operation}:assignment:44:action:${approved ? "APPROVE" : "REJECT"}`,
    eventType: approved ? "ASSIGNMENT_APPROVED" : "ASSIGNMENT_REJECTED",
    deliveryPolicy: "NOTIFY",
    aggregate: { type: "VACANCY_REQUEST", id: 44, version: 2 },
    transition: {
      from: "PENDING",
      to: approved ? "APPROVED" : "REJECTED",
    },
    context: {
      institutionId: 1,
      hospitalId: 10,
      scopeKind: "SECTOR",
      sectorId: 4,
      scheduleContextId: 8,
      shiftInstanceId: 12,
      assignmentId: 44,
    },
    actor: {
      kind: "USER",
      userId: 7,
      professionalId: 70,
      role: "GESTOR_MEDICO",
    },
    recipients: [{ kind: "USER", userId: 20, channels: ["PUSH", "EMAIL"] }],
    recipientResolution: "RESOLVED",
  };
}

describe("fatos SHADOW de solicitações de vaga", () => {
  it("mantém operações fechadas e chave idempotente por revisão e transição", () => {
    expect(VACANCY_REQUEST_SHADOW_OPERATIONS).toEqual([
      "REQUESTED",
      "APPROVED",
      "REJECTED",
    ]);
    const key = vacancyRequestShadowIdempotencyKey({
      operation: "APPROVED",
      assignmentId: 44,
      operationalRevision: 2,
    });
    expect(key).toBe(
      "vacancy-request-shadow:revision:2:operation:APPROVED:assignment:44:action:APPROVE",
    );
    expect(
      vacancyRequestShadowIdempotencyKey({
        operation: "REJECTED",
        assignmentId: 44,
        operationalRevision: 2,
      }),
    ).not.toBe(key);
    expect(() =>
      vacancyRequestShadowIdempotencyKey({
        operation: "REQUESTED",
        assignmentId: 0,
        operationalRevision: 1,
      }),
    ).toThrow("assignmentId deve ser um ID positivo");
  });

  it("classifica a identidade histórica não comprovada sem relaxar o writer canônico", async () => {
    await expect(
      captureCanonicalVacancyRequest(
        vacancyCaptureTransaction(vacancyRequestRow({ createdByUserId: 99 })),
        capturedRequest.context,
      ),
    ).rejects.toMatchObject({
      reason: LEGACY_REQUESTER_IDENTITY_UNPROVEN,
    });

    await expect(
      recordVacancyRequestShadowEventInTransaction(
        vacancyCaptureTransaction(vacancyRequestRow({ createdByUserId: 99 })),
        {
          operation: "APPROVED",
          capturedRequest,
          actor: { userId: 7, professionalId: 70 },
        },
      ),
    ).rejects.toMatchObject({
      reason: LEGACY_REQUESTER_IDENTITY_UNPROVEN,
    });
  });

  it("tolera somente o erro tipado de identidade histórica nas decisões", async () => {
    await expect(
      captureVacancyRequestForDecisionOrLegacyAudit(async () => {
        throw new VacancyRequesterIdentityUnprovenError();
      }),
    ).resolves.toEqual({ kind: LEGACY_REQUESTER_IDENTITY_UNPROVEN });

    const topologyError = new OperationalEventValidationError(
      "Topologia canônica indisponível",
    );
    await expect(
      captureVacancyRequestForDecisionOrLegacyAudit(async () => {
        throw topologyError;
      }),
    ).rejects.toBe(topologyError);
  });

  it("mantém a foundation fechada para emissão direta sem identidade comprovada", async () => {
    const memory = vacancyFoundationTransaction([
      [{ id: 1, roleInInstitution: "USER" }],
      [{ id: 12, scheduleContextId: 8 }],
      [{ id: 44 }],
      [vacancyRequestRow({ createdByUserId: 99 })],
    ]);

    await expect(
      createOperationalEventInTransaction(memory.tx, vacancyRequestedEvent()),
    ).rejects.toThrow(
      "Solicitação de vaga não pertence à revisão, solicitante ou transição canônica do evento",
    );
    expect(memory.counters).toEqual({ recipients: 0, deliveries: 0 });
    expect(memory.remainingSelections()).toBe(0);
  });

  for (const revision of [0, 2] as const) {
    it(`recusa REQUESTED retroativo na foundation com revisão ${revision}`, async () => {
      const input = vacancyRequestedEvent();
      input.idempotencyKey = `vacancy-request-shadow:revision:${revision}:operation:REQUESTED:assignment:44:action:REQUEST`;
      input.aggregate.version = revision;
      const memory = vacancyFoundationTransaction([
        [{ id: 1, roleInInstitution: "USER" }],
        [{ id: 12, scheduleContextId: 8 }],
        [{ id: 44 }],
        [vacancyRequestRow({ operationalRevision: revision })],
      ]);

      await expect(
        createOperationalEventInTransaction(memory.tx, input),
      ).rejects.toThrow(
        "Solicitação de vaga não pertence à revisão, solicitante ou transição canônica do evento",
      );
      expect(memory.counters).toEqual({ recipients: 0, deliveries: 0 });
      expect(memory.remainingSelections()).toBe(0);
    });

    it(`recusa REQUESTED retroativo no writer com revisão ${revision}`, async () => {
      const requestAtInvalidRevision: CapturedVacancyRequest = {
        ...capturedRequest,
        operationalRevision: revision,
      };
      const memory = vacancyFoundationTransaction([
        [vacancyRequestRow({ operationalRevision: revision })],
      ]);

      await expect(
        recordVacancyRequestShadowEventInTransaction(memory.tx, {
          operation: "REQUESTED",
          capturedRequest: requestAtInvalidRevision,
          actor: { userId: 20, professionalId: 200 },
        }),
      ).rejects.toThrow(
        "Snapshot ou revisão não representa a transição da solicitação de vaga",
      );
      expect(memory.counters).toEqual({ recipients: 0, deliveries: 0 });
      expect(memory.remainingSelections()).toBe(0);
    });
  }

  it("recusa snapshot ou revisão que não provam a rejeição capturada", async () => {
    await expect(
      recordVacancyRequestShadowEventInTransaction(
        vacancyCaptureTransaction(
          vacancyRequestRow({
            operationalRevision: 1,
            assignmentStatus: "REJEITADO",
            isActive: false,
          }),
        ),
        {
          operation: "REJECTED",
          capturedRequest,
          actor: { userId: 7, professionalId: 70 },
        },
      ),
    ).rejects.toThrow(
      "Snapshot ou revisão não representa a transição da solicitação de vaga",
    );
  });

  it("rederiva gestores por ID e persiste a solicitação no ledger SHADOW", async () => {
    const pending = vacancyRequestRow();
    const memory = vacancyFoundationTransaction([
      [{ id: 1, roleInInstitution: "USER" }],
      [{ id: 12, scheduleContextId: 8 }],
      [{ id: 44 }],
      [pending],
      [{ userId: 7, professionalId: 70 }],
      [],
      [],
      [{ id: 3 }],
      [{ id: 2 }],
    ]);

    await expect(
      createOperationalEventInTransaction(memory.tx, vacancyRequestedEvent()),
    ).resolves.toMatchObject({ eventId: 1, created: true });
    expect(memory.counters).toEqual({ recipients: 1, deliveries: 0 });
    expect(memory.remainingSelections()).toBe(0);
  });

  it("aceita somente a resolução vazia explícita quando não há gestor responsável", async () => {
    const pending = vacancyRequestRow();
    const input = vacancyRequestedEvent();
    input.recipients = [];
    input.recipientResolution = "NO_RESPONSIBLE_MANAGERS";
    const memory = vacancyFoundationTransaction([
      [{ id: 1, roleInInstitution: "USER" }],
      [{ id: 12, scheduleContextId: 8 }],
      [{ id: 44 }],
      [pending],
      [],
      [],
      [],
      [{ id: 3 }],
    ]);

    await expect(
      createOperationalEventInTransaction(memory.tx, input),
    ).resolves.toMatchObject({ eventId: 1, created: true });
    expect(memory.counters).toEqual({ recipients: 0, deliveries: 0 });
    expect(memory.remainingSelections()).toBe(0);
  });

  it("não auto-notifica o solicitante que também é o único gestor responsável", async () => {
    const pending = vacancyRequestRow();
    const input = vacancyRequestedEvent();
    input.recipients = [];
    input.recipientResolution = "NO_DELIVERABLE_RECIPIENTS";
    const memory = vacancyFoundationTransaction([
      [{ id: 1, roleInInstitution: "USER" }],
      [{ id: 12, scheduleContextId: 8 }],
      [{ id: 44 }],
      [pending],
      [{ userId: 20, professionalId: 200 }],
      [],
      [],
      [{ id: 3 }],
    ]);

    await expect(
      createOperationalEventInTransaction(memory.tx, input),
    ).resolves.toMatchObject({ eventId: 1, created: true });
    expect(memory.counters).toEqual({ recipients: 0, deliveries: 0 });
    expect(memory.remainingSelections()).toBe(0);
  });

  it("recusa destinatário que diverge do gestor responsável rederivado", async () => {
    const pending = vacancyRequestRow();
    const input = vacancyRequestedEvent();
    input.recipients = [
      { kind: "USER", userId: 8, channels: ["PUSH", "EMAIL"] },
    ];
    const memory = vacancyFoundationTransaction([
      [{ id: 1, roleInInstitution: "USER" }],
      [{ id: 12, scheduleContextId: 8 }],
      [{ id: 44 }],
      [pending],
      [{ userId: 7, professionalId: 70 }],
      [],
      [],
      [{ id: 3 }],
    ]);

    await expect(
      createOperationalEventInTransaction(memory.tx, input),
    ).rejects.toThrow(
      "Destinatários não correspondem aos gestores responsáveis canônicos",
    );
    expect(memory.counters).toEqual({ recipients: 0, deliveries: 0 });
  });

  it("recusa o pedido quando o solicitante já não é entregável", async () => {
    const pending = vacancyRequestRow();
    const memory = vacancyFoundationTransaction([
      [{ id: 1, roleInInstitution: "USER" }],
      [{ id: 12, scheduleContextId: 8 }],
      [{ id: 44 }],
      [pending],
      [{ userId: 7, professionalId: 70 }],
      [],
      [],
      [],
    ]);

    await expect(
      createOperationalEventInTransaction(memory.tx, vacancyRequestedEvent()),
    ).rejects.toThrow(
      "Solicitante da vaga não possui vínculo entregável no momento do pedido",
    );
    expect(memory.counters).toEqual({ recipients: 0, deliveries: 0 });
  });

  for (const decision of [
    {
      operation: "APPROVED" as const,
      assignmentStatus: "OCUPADO",
      isActive: true,
    },
    {
      operation: "REJECTED" as const,
      assignmentStatus: "REJEITADO",
      isActive: false,
    },
  ]) {
    it(`persiste ${decision.operation} sem destinatário quando o solicitante foi revogado`, async () => {
      const input = vacancyDecisionEvent(decision.operation);
      input.recipients = [];
      input.recipientResolution = "NO_DELIVERABLE_RECIPIENTS";
      const memory = vacancyFoundationTransaction([
        [{ id: 1, roleInInstitution: "GESTOR_MEDICO" }],
        [{ id: 12, scheduleContextId: 8 }],
        [{ id: 44 }],
        [
          vacancyRequestRow({
            operationalRevision: 2,
            assignmentStatus: decision.assignmentStatus,
            isActive: decision.isActive,
          }),
        ],
        [{ userId: 7, professionalId: 70 }],
        [],
        [],
        [],
      ]);

      await expect(
        createOperationalEventInTransaction(memory.tx, input),
      ).resolves.toMatchObject({ eventId: 1, created: true });
      expect(memory.counters).toEqual({ recipients: 0, deliveries: 0 });
      expect(memory.remainingSelections()).toBe(0);
    });

    it(`não interrompe ${decision.operation} já autorizada quando o solicitante deixa de ser entregável`, async () => {
      const current = vacancyRequestRow({
        operationalRevision: 2,
        assignmentStatus: decision.assignmentStatus,
        isActive: decision.isActive,
      });
      const memory = vacancyFoundationTransaction([
        [current],
        [{ roleInInstitution: "GESTOR_MEDICO" }],
        [],
        [{ id: 1, roleInInstitution: "GESTOR_MEDICO" }],
        [{ id: 12, scheduleContextId: 8 }],
        [{ id: 44 }],
        [current],
        [{ userId: 7, professionalId: 70 }],
        [],
        [],
        [],
      ]);

      await expect(
        recordVacancyRequestShadowEventInTransaction(memory.tx, {
          operation: decision.operation,
          capturedRequest,
          actor: { userId: 7, professionalId: 70 },
        }),
      ).resolves.toMatchObject({ eventId: 1, created: true });
      expect(memory.counters).toEqual({ recipients: 0, deliveries: 0 });
      expect(memory.remainingSelections()).toBe(0);
    });
  }

  it("persiste decisão legada de revisão zero quando a identidade é provada", async () => {
    const legacyCaptured: CapturedVacancyRequest = {
      ...capturedRequest,
      operationalRevision: 0,
    };
    const current = vacancyRequestRow({
      operationalRevision: 1,
      assignmentStatus: "OCUPADO",
      isActive: true,
    });
    const memory = vacancyFoundationTransaction([
      [current],
      [{ roleInInstitution: "GESTOR_MEDICO" }],
      [{ id: 20 }],
      [{ id: 1, roleInInstitution: "GESTOR_MEDICO" }],
      [{ id: 12, scheduleContextId: 8 }],
      [{ id: 44 }],
      [current],
      [{ userId: 7, professionalId: 70 }],
      [],
      [],
      [{ id: 20 }],
      [{ id: 2 }],
    ]);

    await expect(
      recordVacancyRequestShadowEventInTransaction(memory.tx, {
        operation: "APPROVED",
        capturedRequest: legacyCaptured,
        actor: { userId: 7, professionalId: 70 },
      }),
    ).resolves.toMatchObject({ eventId: 1, created: true });
    expect(memory.counters).toEqual({ recipients: 1, deliveries: 0 });
    expect(memory.remainingSelections()).toBe(0);
  });

  it("recusa gestor cujo usuário coincide, mas o profissional não é o do escopo", async () => {
    const input = vacancyDecisionEvent("APPROVED");
    input.actor = {
      kind: "USER",
      userId: 7,
      professionalId: 71,
      role: "GESTOR_MEDICO",
    };
    const memory = vacancyFoundationTransaction([
      [{ id: 1, roleInInstitution: "GESTOR_MEDICO" }],
      [{ id: 12, scheduleContextId: 8 }],
      [{ id: 44 }],
      [
        vacancyRequestRow({
          operationalRevision: 2,
          assignmentStatus: "OCUPADO",
          isActive: true,
        }),
      ],
      [{ userId: 7, professionalId: 70 }],
      [],
      [],
    ]);

    await expect(
      createOperationalEventInTransaction(memory.tx, input),
    ).rejects.toThrow(
      "Ator não corresponde a gestor responsável canônico da vaga",
    );
    expect(memory.counters).toEqual({ recipients: 0, deliveries: 0 });
  });
});

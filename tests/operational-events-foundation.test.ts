import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  createOperationalEventInTransaction,
  getOperationalEventEmissionMode,
  hashOperationalEmailAddress,
  isOperationalDeliveryRetryExhausted,
  isTerminalOperationalDeliveryStatus,
  OPERATIONAL_DELIVERY_MAX_ATTEMPTS,
  isTrustedOperationalEmail,
  operationalDeliveryChannelsForEmission,
  operationalDeliveryDedupKey,
  operationalDeliveryRetryDelayMs,
  operationalEventHash,
  OperationalEventIdempotencyCollisionError,
  OperationalEventValidationError,
  OPERATIONAL_EVENT_CONTRACTS,
  type CreateOperationalEventInput,
} from "../server/operational-events";
import {
  isOperationalDeliveryWorkerEnabled,
  runOperationalDeliveryWorker,
} from "../server/operational-delivery-worker";
import {
  notificationDeliveries,
  operationalEventRelatedContexts,
  operationalEventRecipients,
  operationalEvents,
  monthlyRosters,
  professionalInstitutions,
  scheduleInvites,
  shiftAssignmentsV2,
  shiftInstances,
  swapRequests,
} from "../drizzle/schema";

function hospitalEvent(): CreateOperationalEventInput {
  return {
    idempotencyKey: "roster-published:hospital:1:2026-09",
    eventType: "ROSTER_PUBLISHED",
    deliveryPolicy: "NOTIFY",
    aggregate: { type: "MONTHLY_ROSTER", id: 50, version: 3 },
    transition: { from: "DRAFT", to: "PUBLISHED" },
    context: {
      institutionId: 1,
      hospitalId: 10,
      scopeKind: "HOSPITAL",
    },
    actor: { kind: "USER", userId: 7, role: "GESTOR_MEDICO" },
    recipients: [{ kind: "USER", userId: 20, channels: ["PUSH", "EMAIL"] }],
  };
}

function assignmentShadowEvent(): CreateOperationalEventInput {
  return {
    idempotencyKey:
      "assignment-shadow:revision:1:operation:DIRECT_ASSIGNMENT:assignment:16:action:ASSIGN",
    eventType: "ASSIGNMENT_DIRECT_ASSIGNED",
    deliveryPolicy: "NOTIFY",
    aggregate: { type: "SHIFT_ASSIGNMENT", id: 16, version: 1 },
    transition: { from: "NONE", to: "ASSIGNED" },
    context: {
      institutionId: 1,
      hospitalId: 10,
      scopeKind: "SECTOR",
      sectorId: 4,
      scheduleContextId: 8,
      shiftInstanceId: 12,
      assignmentId: 16,
    },
    actor: {
      kind: "USER",
      userId: 7,
      professionalId: 70,
      role: "GESTOR_MEDICO",
    },
    recipients: [{ kind: "USER", userId: 20, channels: ["PUSH", "EMAIL"] }],
  };
}

type FoundationTransaction = Parameters<
  typeof createOperationalEventInTransaction
>[0];

function inMemoryOperationalEventTransaction(options?: {
  membershipChecks?: boolean[];
  membershipRoles?: ("USER" | "GESTOR_MEDICO" | "GESTOR_PLUS")[];
  inviteBelongsToInstitution?: boolean;
  resourceChecks?: boolean[];
  aggregateChecks?: boolean[];
  failOnRecipientInsert?: boolean;
  onFirstAsyncRead?: () => void;
  rosterRow?: {
    id?: number;
    version?: number;
    status: "DRAFT" | "PUBLISHED" | "LOCKED";
  };
  swapRow?: {
    id?: number;
    version: number;
    status?: "PENDING";
    fromShiftInstanceId: number;
    fromAssignmentId: number;
    toShiftInstanceId: number | null;
    toAssignmentId: number | null;
  };
  shiftRows?: {
    id?: number;
    institutionId: number;
    hospitalId: number;
    sectorId: number;
    scheduleContextId: number | null;
  }[];
  assignmentRows?: {
    id?: number;
    assignmentId?: number;
    institutionId: number;
    hospitalId: number;
    sectorId: number;
    scheduleContextId?: number | null;
    shiftInstanceId?: number;
    professionalId?: number;
    userId?: number;
    operationalRevision?: number;
    status?: string;
    isActive?: boolean;
  }[];
}) {
  let event: { id: number; eventHash: string } | undefined;
  let persistedEvent: Record<string, unknown> | undefined;
  let didRunFirstAsyncRead = false;
  const relatedContextValues: Record<string, unknown>[] = [];
  const recipientValues: Record<string, unknown>[] = [];
  const counters = { relatedContexts: 0, recipients: 0, deliveries: 0 };
  const membershipChecks = [...(options?.membershipChecks ?? [])];
  const membershipRoles = [...(options?.membershipRoles ?? [])];
  const resourceChecks = [...(options?.resourceChecks ?? [])];
  const aggregateChecks = [...(options?.aggregateChecks ?? [])];
  const shiftRows = [...(options?.shiftRows ?? [])];
  const assignmentRows = [...(options?.assignmentRows ?? [])];

  function lockableRows<T>(rows: T[]) {
    const result = Promise.resolve(rows) as Promise<T[]> & {
      for: (_lock: "update") => Promise<T[]>;
    };
    result.for = () => result;
    return result;
  }

  const tx = {
    insert(table: unknown) {
      if (table === operationalEvents) {
        return {
          values: async (value: Record<string, unknown>) => {
            if (event) {
              const duplicate = Object.assign(new Error("duplicate"), {
                code: "ER_DUP_ENTRY",
              });
              throw duplicate;
            }
            persistedEvent = value;
            event = { id: 1, eventHash: value.eventHash as string };
          },
        };
      }
      if (table === operationalEventRecipients) {
        return {
          values: (value: Record<string, unknown>) => ({
            $returningId: async () => {
              if (options?.failOnRecipientInsert) {
                throw new Error("falha forçada ao persistir destinatário");
              }
              counters.recipients += 1;
              recipientValues.push(value);
              return [{ id: counters.recipients }];
            },
          }),
        };
      }
      if (table === operationalEventRelatedContexts) {
        return {
          values: async (value: Record<string, unknown>) => {
            counters.relatedContexts += 1;
            relatedContextValues.push(value);
          },
        };
      }
      if (table === notificationDeliveries) {
        return {
          values: async () => {
            counters.deliveries += 1;
          },
        };
      }
      throw new Error("Tabela inesperada no teste de transaction");
    },
    select() {
      let selectedTable: unknown;
      const query = {
        from(table: unknown) {
          selectedTable = table;
          return query;
        },
        innerJoin() {
          return query;
        },
        where() {
          return query;
        },
        limit() {
          if (!didRunFirstAsyncRead) {
            didRunFirstAsyncRead = true;
            options?.onFirstAsyncRead?.();
          }
          if (selectedTable === operationalEvents) {
            return lockableRows(
              event ? [{ id: event.id, eventHash: event.eventHash }] : [],
            );
          }
          if (selectedTable === professionalInstitutions) {
            return lockableRows(
              membershipChecks.shift() === false
                ? []
                : [
                    {
                      id: 1,
                      roleInInstitution:
                        membershipRoles.shift() ?? "GESTOR_MEDICO",
                    },
                  ],
            );
          }
          if (selectedTable === scheduleInvites) {
            return lockableRows(
              options?.inviteBelongsToInstitution === false ? [] : [{ id: 1 }],
            );
          }
          if (selectedTable === monthlyRosters) {
            return lockableRows(
              aggregateChecks.shift() === false
                ? []
                : [
                    options?.rosterRow ?? {
                      id: 1,
                      version: 3,
                      status: "PUBLISHED" as const,
                    },
                  ],
            );
          }
          if (selectedTable === swapRequests) {
            return lockableRows(
              aggregateChecks.shift() === false
                ? []
                : [
                    options?.swapRow ?? {
                      id: 1,
                      version: 1,
                      status: "PENDING" as const,
                      fromShiftInstanceId: 12,
                      fromAssignmentId: 16,
                      toShiftInstanceId: null,
                      toAssignmentId: null,
                    },
                  ],
            );
          }
          if (selectedTable === shiftInstances) {
            return lockableRows(
              resourceChecks.shift() === false
                ? []
                : [
                    shiftRows.shift() ?? {
                      id: 1,
                      institutionId: 1,
                      hospitalId: 10,
                      sectorId: 4,
                      scheduleContextId: 8,
                    },
                  ],
            );
          }
          if (selectedTable === shiftAssignmentsV2) {
            return lockableRows(
              resourceChecks.shift() === false
                ? []
                : [
                    assignmentRows.shift() ?? {
                      id: 16,
                      assignmentId: 16,
                      institutionId: 1,
                      hospitalId: 10,
                      sectorId: 4,
                      scheduleContextId: 8,
                      shiftInstanceId: 12,
                      professionalId: 200,
                      userId: 20,
                      operationalRevision: 1,
                      status: "OCUPADO",
                      isActive: true,
                    },
                  ],
            );
          }
          return lockableRows([]);
        },
      };
      return query;
    },
  };

  async function runInTransaction<T>(
    work: (transaction: FoundationTransaction) => Promise<T>,
  ): Promise<T> {
    const snapshot = {
      event,
      persistedEvent,
      relatedContextValues: [...relatedContextValues],
      counters: { ...counters },
    };
    try {
      return await work(tx as unknown as FoundationTransaction);
    } catch (error) {
      event = snapshot.event;
      persistedEvent = snapshot.persistedEvent;
      relatedContextValues.splice(
        0,
        relatedContextValues.length,
        ...snapshot.relatedContextValues,
      );
      Object.assign(counters, snapshot.counters);
      throw error;
    }
  }

  return {
    tx: tx as unknown as FoundationTransaction,
    counters,
    getPersistedEvent: () => persistedEvent,
    getRelatedContexts: () => relatedContextValues,
    getRecipients: () => recipientValues,
    runInTransaction,
  };
}

describe("foundation de eventos operacionais", () => {
  it("fixa o modo SHADOW no catálogo e no fato persistido", async () => {
    expect(getOperationalEventEmissionMode("ROSTER_PUBLISHED")).toBe("SHADOW");

    const memory = inMemoryOperationalEventTransaction();
    await expect(
      createOperationalEventInTransaction(memory.tx, hospitalEvent()),
    ).resolves.toMatchObject({ eventId: 1, created: true });
    expect(memory.getPersistedEvent()).toMatchObject({
      eventType: "ROSTER_PUBLISHED",
      emissionMode: "SHADOW",
    });
  });

  it("libera somente os quatro fatos fechados de assignment com revisão persistida", async () => {
    expect(getOperationalEventEmissionMode("ASSIGNMENT_DIRECT_ASSIGNED")).toBe(
      "SHADOW",
    );
    expect(getOperationalEventEmissionMode("ASSIGNMENT_DIRECT_REMOVED")).toBe(
      "SHADOW",
    );
    expect(
      getOperationalEventEmissionMode("ASSIGNMENT_SUBSTITUTION_ASSIGNED"),
    ).toBe("SHADOW");
    expect(
      getOperationalEventEmissionMode("ASSIGNMENT_SUBSTITUTION_REMOVED"),
    ).toBe("SHADOW");
    expect(
      OPERATIONAL_EVENT_CONTRACTS.ASSIGNMENT_DIRECT_ASSIGNED.aggregateRevision,
    ).toBe("SHIFT_ASSIGNMENT_OPERATIONAL");
    expect(
      OPERATIONAL_EVENT_CONTRACTS.ASSIGNMENT_DIRECT_ASSIGNED
        .recipientMembership,
    ).toBeUndefined();
    expect(
      OPERATIONAL_EVENT_CONTRACTS.ASSIGNMENT_SUBSTITUTION_ASSIGNED
        .canonicalRecipient,
    ).toBe("ASSIGNMENT_USER");
    expect(
      OPERATIONAL_EVENT_CONTRACTS.ASSIGNMENT_DIRECT_REMOVED.canonicalRecipient,
    ).toBe("ASSIGNMENT_USER");
    expect(
      OPERATIONAL_EVENT_CONTRACTS.ASSIGNMENT_DIRECT_REMOVED.recipientMembership,
    ).toBe("CANONICAL_ASSIGNMENT_HISTORICAL");
    expect(
      OPERATIONAL_EVENT_CONTRACTS.ASSIGNMENT_SUBSTITUTION_REMOVED
        .recipientMembership,
    ).toBe("CANONICAL_ASSIGNMENT_HISTORICAL");
    expect(
      OPERATIONAL_EVENT_CONTRACTS.ASSIGNMENT_CREATED.aggregateRevision,
    ).toBeUndefined();

    const scenarios = [
      {
        eventType: "ASSIGNMENT_DIRECT_ASSIGNED",
        operation: "DIRECT_ASSIGNMENT",
        transition: { from: "NONE", to: "ASSIGNED" },
        operationalRevision: 1,
        isActive: true,
      },
      {
        eventType: "ASSIGNMENT_DIRECT_REMOVED",
        operation: "DIRECT_REMOVAL",
        transition: { from: "ASSIGNED", to: "REMOVED" },
        operationalRevision: 2,
        isActive: false,
      },
      {
        eventType: "ASSIGNMENT_SUBSTITUTION_ASSIGNED",
        operation: "SUBSTITUTION_ASSIGNMENT",
        transition: { from: "NONE", to: "ASSIGNED" },
        operationalRevision: 1,
        isActive: true,
      },
      {
        eventType: "ASSIGNMENT_SUBSTITUTION_REMOVED",
        operation: "SUBSTITUTION_REMOVAL",
        transition: { from: "ASSIGNED", to: "REMOVED" },
        operationalRevision: 2,
        isActive: false,
      },
    ] as const;
    const deliveryCounts = new Map<string, number>();

    for (const scenario of scenarios) {
      const event = assignmentShadowEvent();
      event.eventType = scenario.eventType;
      event.idempotencyKey = [
        "assignment-shadow",
        `revision:${scenario.operationalRevision}`,
        `operation:${scenario.operation}`,
        "assignment:16",
      ].join(":");
      event.aggregate = {
        ...event.aggregate,
        version: scenario.operationalRevision,
      };
      event.transition = { ...scenario.transition };
      const canonicalAssignmentRow = {
        id: 16,
        assignmentId: 16,
        institutionId: 1,
        hospitalId: 10,
        sectorId: 4,
        scheduleContextId: 8,
        shiftInstanceId: 12,
        professionalId: 200,
        userId: 20,
        operationalRevision: scenario.operationalRevision,
        status: "OCUPADO",
        isActive: scenario.isActive,
      };
      const memory = inMemoryOperationalEventTransaction({
        // A fundação relê a alocação uma vez para a topologia e outra para o
        // agregado; as duas leituras precisam observar o mesmo estado.
        assignmentRows: [canonicalAssignmentRow, canonicalAssignmentRow],
      });
      await expect(
        createOperationalEventInTransaction(memory.tx, event),
      ).resolves.toMatchObject({ eventId: 1, created: true });
      expect(memory.getPersistedEvent()).toMatchObject({
        eventType: scenario.eventType,
        emissionMode: "SHADOW",
        aggregateType: "SHIFT_ASSIGNMENT",
        aggregateId: 16,
        aggregateVersion: scenario.operationalRevision,
        assignmentId: 16,
      });
      expect(memory.counters).toEqual({
        relatedContexts: 0,
        recipients: 1,
        deliveries: 0,
      });
      deliveryCounts.set(scenario.eventType, memory.counters.deliveries);
    }

    expect(Object.fromEntries(deliveryCounts)).toEqual({
      ASSIGNMENT_DIRECT_ASSIGNED: 0,
      ASSIGNMENT_DIRECT_REMOVED: 0,
      ASSIGNMENT_SUBSTITUTION_ASSIGNED: 0,
      ASSIGNMENT_SUBSTITUTION_REMOVED: 0,
    });

    const genericAssignment = assignmentShadowEvent();
    genericAssignment.eventType = "ASSIGNMENT_CREATED";
    expect(() => operationalEventHash(genericAssignment)).toThrow(
      "Agregado ainda não possui revisão canônica",
    );
  });

  it("rejeita revisão defasada ou destinatário diferente da alocação canônica", async () => {
    const staleRevision = inMemoryOperationalEventTransaction({
      assignmentRows: [
        {
          id: 16,
          assignmentId: 16,
          institutionId: 1,
          hospitalId: 10,
          sectorId: 4,
          scheduleContextId: 8,
          shiftInstanceId: 12,
          professionalId: 200,
          userId: 20,
          operationalRevision: 1,
          status: "OCUPADO",
          isActive: true,
        },
        {
          id: 16,
          assignmentId: 16,
          institutionId: 1,
          hospitalId: 10,
          sectorId: 4,
          scheduleContextId: 8,
          shiftInstanceId: 12,
          professionalId: 200,
          userId: 20,
          operationalRevision: 2,
          status: "OCUPADO",
          isActive: true,
        },
      ],
    });
    await expect(
      createOperationalEventInTransaction(
        staleRevision.tx,
        assignmentShadowEvent(),
      ),
    ).rejects.toThrow("Alocação não pertence à revisão ou transição canônica");

    const wrongRecipient = assignmentShadowEvent();
    wrongRecipient.recipients = [
      { kind: "USER", userId: 21, channels: ["PUSH", "EMAIL"] },
    ];
    const memory = inMemoryOperationalEventTransaction();
    await expect(
      createOperationalEventInTransaction(memory.tx, wrongRecipient),
    ).rejects.toThrow("Destinatário não corresponde ao usuário canônico");
    expect(memory.counters).toEqual({
      relatedContexts: 0,
      recipients: 0,
      deliveries: 0,
    });
  });

  it("reverte fato SHADOW e recipient juntos quando a persistência do recipient falha", async () => {
    const memory = inMemoryOperationalEventTransaction({
      failOnRecipientInsert: true,
    });

    await expect(
      memory.runInTransaction((tx) =>
        createOperationalEventInTransaction(tx, assignmentShadowEvent()),
      ),
    ).rejects.toThrow("falha forçada ao persistir destinatário");
    expect(memory.getPersistedEvent()).toBeUndefined();
    expect(memory.counters).toEqual({
      relatedContexts: 0,
      recipients: 0,
      deliveries: 0,
    });
  });

  it("recusa modo de emissão escolhido pelo caller", () => {
    const selectedByCaller = {
      ...hospitalEvent(),
      emissionMode: "ACTIVE",
    } as unknown as CreateOperationalEventInput;

    expect(() => operationalEventHash(selectedByCaller)).toThrow(
      "Modo de emissão é definido exclusivamente pelo servidor",
    );
  });

  it("gera hash estável sem depender da ordem dos destinatários", () => {
    const first = hospitalEvent();
    const second = hospitalEvent();
    second.recipients = [
      { kind: "USER", userId: 21, channels: ["EMAIL"] },
      { kind: "USER", userId: 20, channels: ["PUSH", "EMAIL"] },
    ];
    first.recipients = [...second.recipients].reverse();

    expect(operationalEventHash(first)).toBe(operationalEventHash(second));
  });

  it("aceita publicação hospitalar sem setor e rejeita recursos setoriais nesse escopo", () => {
    expect(() => operationalEventHash(hospitalEvent())).not.toThrow();

    const invalid = hospitalEvent();
    invalid.context = { ...invalid.context, sectorId: 4 };
    expect(() => operationalEventHash(invalid)).toThrow(
      OperationalEventValidationError,
    );
  });

  it("exige setor para eventos setoriais", () => {
    const missingSector = hospitalEvent();
    missingSector.context = {
      institutionId: 1,
      hospitalId: 10,
      scopeKind: "SECTOR",
    };
    expect(() => operationalEventHash(missingSector)).toThrow(
      OperationalEventValidationError,
    );

    const sectorEvent = hospitalEvent();
    sectorEvent.eventType = "SHIFT_UPDATED";
    sectorEvent.aggregate = { type: "SHIFT_INSTANCE", id: 12, version: 3 };
    sectorEvent.context = {
      institutionId: 1,
      hospitalId: 10,
      scopeKind: "SECTOR",
      sectorId: 4,
      scheduleContextId: 8,
      shiftInstanceId: 12,
      assignmentId: 16,
    };
    expect(() => operationalEventHash(sectorEvent)).toThrow(
      "Agregado ainda não possui revisão canônica",
    );
  });

  it("exige o recurso canônico previsto pelo contrato de cada evento", () => {
    const missingShift = hospitalEvent();
    missingShift.eventType = "SHIFT_UPDATED";
    missingShift.aggregate = { type: "SHIFT_INSTANCE", id: 12, version: 1 };
    missingShift.context = {
      institutionId: 1,
      hospitalId: 10,
      scopeKind: "SECTOR",
      sectorId: 4,
    };
    expect(() => operationalEventHash(missingShift)).toThrow(
      OperationalEventValidationError,
    );

    const mismatchedShift = {
      ...missingShift,
      context: { ...missingShift.context, shiftInstanceId: 13 },
    };
    expect(() => operationalEventHash(mismatchedShift)).toThrow(
      OperationalEventValidationError,
    );

    const missingScheduleContext = hospitalEvent();
    missingScheduleContext.eventType = "SCHEDULE_CONTEXT_CREATED";
    missingScheduleContext.aggregate = {
      type: "SCHEDULE_CONTEXT",
      id: 8,
      version: 1,
    };
    missingScheduleContext.deliveryPolicy = "SILENT_AUDITED";
    missingScheduleContext.recipients = [];
    missingScheduleContext.context = {
      institutionId: 1,
      hospitalId: 10,
      scopeKind: "SECTOR",
      sectorId: 4,
    };
    expect(() => operationalEventHash(missingScheduleContext)).toThrow(
      OperationalEventValidationError,
    );
  });

  it("não aceita e-mail do cliente e limita convite ao canal de e-mail", () => {
    const withAddress = hospitalEvent();
    withAddress.recipients = [
      {
        kind: "USER",
        userId: 20,
        channels: ["EMAIL"],
        email: "not-allowed@example.test",
      } as unknown as (typeof withAddress.recipients)[number],
    ];
    expect(() => operationalEventHash(withAddress)).toThrow(
      OperationalEventValidationError,
    );

    const invitePush = hospitalEvent();
    invitePush.recipients = [
      {
        kind: "SCHEDULE_INVITE",
        scheduleInviteId: 91,
        channels: ["PUSH"],
      } as unknown as (typeof invitePush.recipients)[number],
    ];
    expect(() => operationalEventHash(invitePush)).toThrow(
      OperationalEventValidationError,
    );
  });

  it("não persiste texto livre que poderia transportar dado sensível", () => {
    const withMetadata = {
      ...hospitalEvent(),
      metadata: { email: "medico@example.test" },
    } as unknown as CreateOperationalEventInput;
    expect(() => operationalEventHash(withMetadata)).toThrow(
      OperationalEventValidationError,
    );

    const withReason = {
      ...hospitalEvent(),
      transition: {
        from: "DRAFT",
        to: "PUBLISHED",
        reason: "texto livre",
      },
    } as unknown as CreateOperationalEventInput;
    expect(() => operationalEventHash(withReason)).toThrow(
      OperationalEventValidationError,
    );
  });

  it("ignora campos extras não autorizados no hash canônico", () => {
    const baseline = hospitalEvent();
    const withExtraFields = {
      ...hospitalEvent(),
      aggregate: {
        ...hospitalEvent().aggregate,
        note: "não deve entrar no hash",
      },
      transition: {
        from: "DRAFT",
        to: "PUBLISHED",
        note: "dado livre",
      },
      actor: {
        ...hospitalEvent().actor,
        email: "medico@example.test",
      },
    } as unknown as CreateOperationalEventInput;
    expect(operationalEventHash(withExtraFields)).toBe(
      operationalEventHash(baseline),
    );
  });

  it("preserva silêncio auditado sem recipients", () => {
    const silent = hospitalEvent();
    silent.eventType = "ROSTER_LOCKED";
    silent.deliveryPolicy = "SILENT_AUDITED";
    silent.recipients = [];
    silent.transition = { from: "PUBLISHED", to: "LOCKED" };
    expect(() => operationalEventHash(silent)).not.toThrow();
  });

  it("bloqueia divulgação coletiva até o agregado de turno ter revisão canônica", () => {
    const broadcastWithoutEligibleRecipients = hospitalEvent();
    broadcastWithoutEligibleRecipients.eventType = "VACANCY_BROADCAST";
    broadcastWithoutEligibleRecipients.aggregate = {
      type: "SHIFT_INSTANCE",
      id: 12,
      version: 3,
    };
    broadcastWithoutEligibleRecipients.context = {
      institutionId: 1,
      hospitalId: 10,
      scopeKind: "SECTOR",
      sectorId: 4,
      shiftInstanceId: 12,
    };
    broadcastWithoutEligibleRecipients.deliveryPolicy = "BROADCAST";
    broadcastWithoutEligibleRecipients.recipients = [];
    broadcastWithoutEligibleRecipients.recipientResolution =
      "NO_ELIGIBLE_RECIPIENTS";
    expect(() =>
      operationalEventHash(broadcastWithoutEligibleRecipients),
    ).toThrow("Agregado ainda não possui revisão canônica");

    const notifyWithoutRecipient = hospitalEvent();
    notifyWithoutRecipient.recipients = [];
    expect(() => operationalEventHash(notifyWithoutRecipient)).toThrow(
      OperationalEventValidationError,
    );
  });

  it("bloqueia evento institucional enquanto o vínculo não tiver revisão canônica", () => {
    const accessExpiry = hospitalEvent();
    accessExpiry.eventType = "ACCESS_UPDATED";
    accessExpiry.aggregate = {
      type: "PROFESSIONAL_INSTITUTION_ACCESS",
      id: 44,
      version: 1,
    };
    accessExpiry.deliveryPolicy = "SILENT_AUDITED";
    accessExpiry.context = { institutionId: 1, scopeKind: "INSTITUTION" };
    accessExpiry.actor = { kind: "SYSTEM", role: "SCHEDULE_EXPIRY_WORKER" };
    accessExpiry.recipients = [];

    expect(() => operationalEventHash(accessExpiry)).toThrow(
      "Agregado ainda não possui revisão canônica",
    );
  });

  it("deriva contrapartida de troca do agregado canônico", async () => {
    const memory = inMemoryOperationalEventTransaction({
      swapRow: {
        version: 1,
        status: "PENDING",
        fromShiftInstanceId: 12,
        fromAssignmentId: 16,
        toShiftInstanceId: 13,
        toAssignmentId: 17,
      },
    });
    const swap = hospitalEvent();
    swap.eventType = "SWAP_OFFERED";
    swap.aggregate = { type: "SWAP_REQUEST", id: 90, version: 1 };
    swap.transition = { from: null, to: "PENDING" };
    swap.context = {
      institutionId: 1,
      hospitalId: 10,
      scopeKind: "SECTOR",
      sectorId: 4,
      scheduleContextId: 8,
      shiftInstanceId: 12,
      assignmentId: 16,
    };
    await expect(
      createOperationalEventInTransaction(memory.tx, swap),
    ).resolves.toMatchObject({ eventId: 1, created: true });
    expect(memory.counters.relatedContexts).toBe(1);

    const callerSuppliedCounterpart: CreateOperationalEventInput = {
      ...swap,
      relatedContexts: [
        {
          relationKind: "COUNTERPART",
          context: {
            institutionId: 1,
            hospitalId: 10,
            scopeKind: "SECTOR",
            sectorId: 4,
            shiftInstanceId: 13,
            assignmentId: 17,
          },
        },
      ],
    };
    expect(() => operationalEventHash(callerSuppliedCounterpart)).toThrow(
      OperationalEventValidationError,
    );
  });

  it("preserva a topologia canônica da contrapartida em outro hospital ou setor", async () => {
    const memory = inMemoryOperationalEventTransaction({
      swapRow: {
        version: 1,
        status: "PENDING",
        fromShiftInstanceId: 12,
        fromAssignmentId: 16,
        toShiftInstanceId: 13,
        toAssignmentId: 17,
      },
      shiftRows: [
        {
          id: 12,
          institutionId: 1,
          hospitalId: 10,
          sectorId: 4,
          scheduleContextId: 8,
        },
        {
          id: 13,
          institutionId: 1,
          hospitalId: 11,
          sectorId: 5,
          scheduleContextId: 9,
        },
      ],
    });
    const swap = hospitalEvent();
    swap.eventType = "SWAP_OFFERED";
    swap.aggregate = { type: "SWAP_REQUEST", id: 90, version: 1 };
    swap.transition = { from: null, to: "PENDING" };
    swap.context = {
      institutionId: 1,
      hospitalId: 10,
      scopeKind: "SECTOR",
      sectorId: 4,
      scheduleContextId: 8,
      shiftInstanceId: 12,
      assignmentId: 16,
    };

    await expect(
      createOperationalEventInTransaction(memory.tx, swap),
    ).resolves.toMatchObject({ eventId: 1, created: true });
    expect(memory.getRelatedContexts()).toEqual([
      expect.objectContaining({
        relationKind: "COUNTERPART",
        institutionId: 1,
        hospitalId: 11,
        sectorId: 5,
        scheduleContextId: 9,
        shiftInstanceId: 13,
        assignmentId: 17,
      }),
    ]);
  });

  it("exige o scheduleContextId canônico de todo turno classificado", async () => {
    const withoutContext = hospitalEvent();
    withoutContext.eventType = "SWAP_OFFERED";
    withoutContext.aggregate = { type: "SWAP_REQUEST", id: 90, version: 1 };
    withoutContext.transition = { from: null, to: "PENDING" };
    withoutContext.context = {
      institutionId: 1,
      hospitalId: 10,
      scopeKind: "SECTOR",
      sectorId: 4,
      shiftInstanceId: 12,
      assignmentId: 16,
    };
    await expect(
      createOperationalEventInTransaction(
        inMemoryOperationalEventTransaction().tx,
        withoutContext,
      ),
    ).rejects.toThrow("Contexto de escala do evento diverge");

    const mismatchedContext = {
      ...withoutContext,
      context: { ...withoutContext.context, scheduleContextId: 9 },
    };
    await expect(
      createOperationalEventInTransaction(
        inMemoryOperationalEventTransaction().tx,
        mismatchedContext,
      ),
    ).rejects.toThrow("Contexto de escala do evento diverge");

    const legacyWithoutContext = { ...withoutContext };
    await expect(
      createOperationalEventInTransaction(
        inMemoryOperationalEventTransaction({
          shiftRows: [
            {
              id: 12,
              institutionId: 1,
              hospitalId: 10,
              sectorId: 4,
              scheduleContextId: null,
            },
          ],
        }).tx,
        legacyWithoutContext,
      ),
    ).resolves.toMatchObject({ eventId: 1, created: true });
  });

  it("recusa transição fora do contrato ou estado canônico do agregado", async () => {
    const invalidTransition = hospitalEvent();
    invalidTransition.transition = { from: "DRAFT", to: "LOCKED" };
    expect(() => operationalEventHash(invalidTransition)).toThrow(
      "transition não corresponde ao contrato canônico do evento",
    );

    const staleRoster = inMemoryOperationalEventTransaction({
      rosterRow: { version: 3, status: "DRAFT" },
    });
    await expect(
      createOperationalEventInTransaction(staleRoster.tx, hospitalEvent()),
    ).rejects.toBeInstanceOf(OperationalEventValidationError);

    const lockedRoster = inMemoryOperationalEventTransaction({
      rosterRow: { version: 3, status: "LOCKED" },
    });
    const lock = hospitalEvent();
    lock.eventType = "ROSTER_LOCKED";
    lock.deliveryPolicy = "SILENT_AUDITED";
    lock.recipients = [];
    lock.transition = { from: "PUBLISHED", to: "LOCKED" };
    await expect(
      createOperationalEventInTransaction(lockedRoster.tx, lock),
    ).resolves.toMatchObject({ eventId: 1, created: true });
  });

  it("recusa contrapartida cuja alocação não pertence ao turno relacionado", async () => {
    const memory = inMemoryOperationalEventTransaction({
      // turno e alocação primários, turno e alocação da contrapartida.
      resourceChecks: [true, true, true, false],
      swapRow: {
        version: 1,
        status: "PENDING",
        fromShiftInstanceId: 12,
        fromAssignmentId: 16,
        toShiftInstanceId: 13,
        toAssignmentId: 17,
      },
    });
    const swap = hospitalEvent();
    swap.eventType = "SWAP_OFFERED";
    swap.aggregate = { type: "SWAP_REQUEST", id: 90, version: 1 };
    swap.transition = { from: null, to: "PENDING" };
    swap.context = {
      institutionId: 1,
      hospitalId: 10,
      scopeKind: "SECTOR",
      sectorId: 4,
      scheduleContextId: 8,
      shiftInstanceId: 12,
      assignmentId: 16,
    };
    await expect(
      createOperationalEventInTransaction(memory.tx, swap),
    ).rejects.toBeInstanceOf(OperationalEventValidationError);
    expect(memory.counters).toEqual({
      relatedContexts: 0,
      recipients: 0,
      deliveries: 0,
    });
  });

  it("recusa agregado de troca fora da topologia canônica", async () => {
    const memory = inMemoryOperationalEventTransaction({
      aggregateChecks: [false],
    });
    const swap = hospitalEvent();
    swap.eventType = "SWAP_OFFERED";
    swap.aggregate = { type: "SWAP_REQUEST", id: 90, version: 1 };
    swap.transition = { from: null, to: "PENDING" };
    swap.context = {
      institutionId: 1,
      hospitalId: 10,
      scopeKind: "SECTOR",
      sectorId: 4,
      shiftInstanceId: 12,
      assignmentId: 16,
    };

    await expect(
      createOperationalEventInTransaction(memory.tx, swap),
    ).rejects.toBeInstanceOf(OperationalEventValidationError);
    expect(memory.counters).toEqual({
      relatedContexts: 0,
      recipients: 0,
      deliveries: 0,
    });
  });

  it("em SHADOW grava fato e destinatário canônico, sem delivery, e mantém retry idempotente", async () => {
    const memory = inMemoryOperationalEventTransaction();
    const input = hospitalEvent();

    await expect(
      createOperationalEventInTransaction(memory.tx, input),
    ).resolves.toMatchObject({ eventId: 1, created: true });
    expect(memory.counters).toEqual({
      relatedContexts: 0,
      recipients: 1,
      deliveries: 0,
    });
    expect(memory.getPersistedEvent()).toMatchObject({
      eventType: "ROSTER_PUBLISHED",
      emissionMode: "SHADOW",
      deliveryPolicy: "NOTIFY",
    });
    expect(memory.getRecipients()).toEqual([
      expect.objectContaining({
        recipientKind: "USER",
        institutionId: 1,
        userId: 20,
      }),
    ]);

    await expect(
      createOperationalEventInTransaction(memory.tx, input),
    ).resolves.toMatchObject({ eventId: 1, created: false });
    expect(memory.counters).toEqual({
      relatedContexts: 0,
      recipients: 1,
      deliveries: 0,
    });

    const collision = hospitalEvent();
    collision.recipients = [
      { kind: "USER", userId: 21, channels: ["PUSH", "EMAIL"] },
    ];
    await expect(
      createOperationalEventInTransaction(memory.tx, collision),
    ).rejects.toBeInstanceOf(OperationalEventIdempotencyCollisionError);
  });

  it("preserva PUSH e EMAIL para uma promoção futura explícita a ACTIVE", () => {
    const channels = ["PUSH", "EMAIL"] as const;

    expect(operationalDeliveryChannelsForEmission("SHADOW", channels)).toEqual(
      [],
    );
    expect(operationalDeliveryChannelsForEmission("ACTIVE", channels)).toEqual([
      "PUSH",
      "EMAIL",
    ]);
    expect(
      operationalDeliveryChannelsForEmission(
        "UNRECOGNIZED" as unknown as "SHADOW" | "ACTIVE",
        channels,
      ),
    ).toEqual([]);
  });

  it("usa snapshot imutável e não relê input mutado após o primeiro await", async () => {
    const input = hospitalEvent();
    const expectedHash = operationalEventHash(input);
    const memory = inMemoryOperationalEventTransaction({
      onFirstAsyncRead: () => {
        input.idempotencyKey = "attacker-replaced-key";
        input.eventType = "ROSTER_LOCKED";
        input.deliveryPolicy = "SILENT_AUDITED";
        input.aggregate = { type: "MONTHLY_ROSTER", id: 999, version: 99 };
        input.context = { institutionId: 2, scopeKind: "INSTITUTION" };
        input.actor = { kind: "SYSTEM", role: "SCHEDULE_EXPIRY_WORKER" };
        input.recipients = [];
      },
    });

    await expect(
      createOperationalEventInTransaction(memory.tx, input),
    ).resolves.toMatchObject({
      eventId: 1,
      created: true,
      eventHash: expectedHash,
    });
    expect(memory.getPersistedEvent()).toMatchObject({
      eventType: "ROSTER_PUBLISHED",
      emissionMode: "SHADOW",
      deliveryPolicy: "NOTIFY",
      aggregateId: 50,
      aggregateVersion: 3,
      actorKind: "USER",
      actorUserId: 7,
      institutionId: 1,
      hospitalId: 10,
      scopeKind: "HOSPITAL",
    });
  });

  it("recusa USER e SCHEDULE_INVITE que não pertencem à instituição do evento", async () => {
    const missingUserMembership = inMemoryOperationalEventTransaction({
      membershipChecks: [true, false],
    });
    await expect(
      createOperationalEventInTransaction(
        missingUserMembership.tx,
        hospitalEvent(),
      ),
    ).rejects.toBeInstanceOf(OperationalEventValidationError);
    expect(missingUserMembership.counters).toEqual({
      relatedContexts: 0,
      recipients: 0,
      deliveries: 0,
    });

    const missingInviteTenant = inMemoryOperationalEventTransaction({
      membershipChecks: [true],
      inviteBelongsToInstitution: false,
    });
    const inviteEvent = hospitalEvent();
    inviteEvent.eventType = "SCHEDULE_INVITE_CREATED";
    inviteEvent.aggregate = {
      type: "SCHEDULE_INVITE",
      id: 91,
      version: 1,
    };
    inviteEvent.recipients = [
      { kind: "SCHEDULE_INVITE", scheduleInviteId: 91, channels: ["EMAIL"] },
    ];
    await expect(
      createOperationalEventInTransaction(missingInviteTenant.tx, inviteEvent),
    ).rejects.toBeInstanceOf(OperationalEventValidationError);
    expect(missingInviteTenant.counters).toEqual({
      relatedContexts: 0,
      recipients: 0,
      deliveries: 0,
    });
  });

  it("recusa ator USER fora do vínculo institucional antes de gravar o fato", async () => {
    const missingActorMembership = inMemoryOperationalEventTransaction({
      membershipChecks: [false],
    });
    await expect(
      createOperationalEventInTransaction(
        missingActorMembership.tx,
        hospitalEvent(),
      ),
    ).rejects.toBeInstanceOf(OperationalEventValidationError);
    expect(missingActorMembership.counters).toEqual({
      relatedContexts: 0,
      recipients: 0,
      deliveries: 0,
    });
  });

  it("recusa papel declarado que diverge do vínculo institucional", async () => {
    const mismatchedRole = inMemoryOperationalEventTransaction({
      membershipRoles: ["USER"],
    });
    await expect(
      createOperationalEventInTransaction(mismatchedRole.tx, hospitalEvent()),
    ).rejects.toBeInstanceOf(OperationalEventValidationError);
    expect(mismatchedRole.counters).toEqual({
      relatedContexts: 0,
      recipients: 0,
      deliveries: 0,
    });
  });

  it("reconhece retry de evento silencioso sem usar recipients como sinal", async () => {
    const memory = inMemoryOperationalEventTransaction({
      rosterRow: { version: 3, status: "LOCKED" },
    });
    const silent = hospitalEvent();
    silent.idempotencyKey = "calendar-replicated:hospital:1:2026-09";
    silent.eventType = "ROSTER_LOCKED";
    silent.deliveryPolicy = "SILENT_AUDITED";
    silent.recipients = [];
    silent.transition = { from: "PUBLISHED", to: "LOCKED" };

    await expect(
      createOperationalEventInTransaction(memory.tx, silent),
    ).resolves.toMatchObject({ eventId: 1, created: true });
    await expect(
      createOperationalEventInTransaction(memory.tx, silent),
    ).resolves.toMatchObject({ eventId: 1, created: false });
    expect(memory.counters).toEqual({
      relatedContexts: 0,
      recipients: 0,
      deliveries: 0,
    });
  });

  it("amarra confiança ao hash do e-mail atual", () => {
    const trustedHash = hashOperationalEmailAddress("medico@example.test");
    expect(
      isTrustedOperationalEmail({
        state: "TRUSTED",
        trustedEmailHash: trustedHash,
        currentEmail: " Medico@example.test ",
      }),
    ).toBe(true);
    expect(
      isTrustedOperationalEmail({
        state: "TRUSTED",
        trustedEmailHash: trustedHash,
        currentEmail: "outro@example.test",
      }),
    ).toBe(false);
  });

  it("distingue aceite pelo provedor de entrega final e deduplica por canal", () => {
    expect(isTerminalOperationalDeliveryStatus("PROVIDER_ACCEPTED")).toBe(
      false,
    );
    expect(isTerminalOperationalDeliveryStatus("DELIVERED")).toBe(true);
    expect(
      isOperationalDeliveryRetryExhausted(
        OPERATIONAL_DELIVERY_MAX_ATTEMPTS - 1,
      ),
    ).toBe(false);
    expect(
      isOperationalDeliveryRetryExhausted(OPERATIONAL_DELIVERY_MAX_ATTEMPTS),
    ).toBe(true);
    expect(operationalDeliveryRetryDelayMs(1, () => 0)).toBe(60_000);
    expect(operationalDeliveryRetryDelayMs(1, () => 1)).toBe(71_999);
    expect(operationalDeliveryRetryDelayMs(2, () => 0)).toBeGreaterThan(
      operationalDeliveryRetryDelayMs(1, () => 1),
    );

    const recipient = { kind: "USER" as const, userId: 20, channels: ["PUSH"] };
    expect(
      operationalDeliveryDedupKey({
        institutionId: 1,
        eventIdempotencyKey: "event:1",
        emissionMode: "SHADOW",
        recipient,
        channel: "PUSH",
      }),
    ).not.toBe(
      operationalDeliveryDedupKey({
        institutionId: 1,
        eventIdempotencyKey: "event:1",
        emissionMode: "SHADOW",
        recipient,
        channel: "EMAIL",
      }),
    );
    expect(
      operationalDeliveryDedupKey({
        institutionId: 1,
        eventIdempotencyKey: "event:1",
        emissionMode: "SHADOW",
        recipient,
        channel: "PUSH",
      }),
    ).not.toBe(
      operationalDeliveryDedupKey({
        institutionId: 2,
        eventIdempotencyKey: "event:1",
        emissionMode: "SHADOW",
        recipient,
        channel: "PUSH",
      }),
    );
    expect(
      operationalDeliveryDedupKey({
        institutionId: 1,
        eventIdempotencyKey: "event:1",
        emissionMode: "SHADOW",
        recipient,
        channel: "PUSH",
      }),
    ).not.toBe(
      operationalDeliveryDedupKey({
        institutionId: 1,
        eventIdempotencyKey: "event:1",
        emissionMode: "ACTIVE",
        recipient,
        channel: "PUSH",
      }),
    );
  });

  it("mantém o worker inerte até uma flag literal explícita", async () => {
    expect(isOperationalDeliveryWorkerEnabled({})).toBe(false);
    expect(
      isOperationalDeliveryWorkerEnabled({
        OPERATIONAL_DELIVERY_WORKER_ENABLED: "1",
      }),
    ).toBe(false);
    expect(
      isOperationalDeliveryWorkerEnabled({
        OPERATIONAL_DELIVERY_WORKER_ENABLED: "true",
      }),
    ).toBe(true);
    await expect(runOperationalDeliveryWorker({})).resolves.toMatchObject({
      mode: "DISABLED",
      claimed: 0,
      delivered: 0,
    });
    await expect(
      runOperationalDeliveryWorker({
        OPERATIONAL_DELIVERY_WORKER_ENABLED: "true",
      }),
    ).resolves.toMatchObject({
      mode: "INERT_NO_TRANSPORT",
      claimed: 0,
      delivered: 0,
    });
  });

  it("não carrega adaptador, banco ou logger de entrega nesta frente", () => {
    const source = readFileSync(
      new URL("../server/operational-delivery-worker.ts", import.meta.url),
      "utf8",
    );

    expect(source).not.toMatch(
      /from\s+["'].*(push-delivery|mailer|resend)["']/i,
    );
    expect(source).not.toMatch(/\b(fetch|axios|console\.|getDb)\b/);
  });
});

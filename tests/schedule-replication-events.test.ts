import { describe, expect, it } from "vitest";
import {
  createOperationalEventInTransaction,
  type CreateOperationalEventInput,
} from "../server/operational-events";
import {
  buildScheduleReplicationEventInput,
  recordScheduleReplicationShadowEventInTransaction,
} from "../server/schedule-replication-events";
import {
  monthlyRosters,
  notificationDeliveries,
  operationalEventRelatedContexts,
  operationalEventRecipients,
  operationalEvents,
  professionalInstitutions,
  scheduleContexts,
  scheduleReplicationBatches,
  scheduleReplicationBatchScopes,
  sectors,
  shiftAssignmentsV2,
  shiftInstances,
} from "../drizzle/schema";

type EventTransaction = Parameters<
  typeof createOperationalEventInTransaction
>[0];

function replicationEvent(
  recipientUserIds: readonly number[],
  emptyRecipientResolution?: "NO_DELIVERABLE_RECIPIENTS" | "NOT_APPLICABLE",
): CreateOperationalEventInput {
  return buildScheduleReplicationEventInput({
    institutionId: 1,
    hospitalId: 10,
    batchId: 77,
    batchVersion: 1,
    actor: { userId: 7, role: "GESTOR_MEDICO" },
    recipientUserIds,
    emptyRecipientResolution,
  });
}

function inMemoryReplicationEventTransaction(options?: {
  missingSector?: boolean;
}) {
  let persistedEvent: Record<string, unknown> | undefined;
  let eventId: number | undefined;
  const relatedContexts: Record<string, unknown>[] = [];
  const counters = { events: 0, recipients: 0, deliveries: 0 };

  function rowsFor(table: unknown): Record<string, unknown>[] {
    if (table === professionalInstitutions) {
      return [{ id: 1, roleInInstitution: "GESTOR_MEDICO" }];
    }
    if (table === scheduleReplicationBatches) {
      return [{ id: 77, version: 1, status: "COMPLETED" }];
    }
    if (table === scheduleReplicationBatchScopes) {
      // Dois meses e dois setores, inclusive um turno legado sem contexto.
      return [
        { monthlyRosterId: 51, sectorId: 4, scheduleContextId: null },
        { monthlyRosterId: 52, sectorId: 5, scheduleContextId: 9 },
      ];
    }
    if (table === monthlyRosters || table === scheduleContexts) {
      return [{ id: 1, active: true }];
    }
    if (table === sectors) {
      return options?.missingSector ? [] : [{ id: 1 }];
    }
    if (table === operationalEvents) {
      return eventId === undefined
        ? []
        : [{ id: eventId, eventHash: persistedEvent?.eventHash }];
    }
    return [];
  }

  function lockableRows(rows: Record<string, unknown>[]) {
    const result = Promise.resolve(rows) as Promise<
      Record<string, unknown>[]
    > & {
      for: (_lock: "update") => Promise<Record<string, unknown>[]>;
      limit: (_limit: number) => Promise<Record<string, unknown>[]>;
    };
    result.for = () => result;
    result.limit = () => result;
    return result;
  }

  const tx = {
    select() {
      return {
        from(table: unknown) {
          const query = {
            innerJoin() {
              return query;
            },
            where() {
              return lockableRows(rowsFor(table));
            },
          };
          return query;
        },
      };
    },
    insert(table: unknown) {
      if (table === operationalEvents) {
        return {
          values: async (value: Record<string, unknown>) => {
            persistedEvent = value;
            eventId = 1;
            counters.events += 1;
          },
        };
      }
      if (table === operationalEventRelatedContexts) {
        return {
          values: async (value: Record<string, unknown>) => {
            relatedContexts.push(value);
          },
        };
      }
      if (table === operationalEventRecipients) {
        return {
          values: () => ({
            $returningId: async () => {
              counters.recipients += 1;
              return [{ id: counters.recipients }];
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
      throw new Error("Tabela inesperada no teste de lote de replicação");
    },
  };

  return {
    tx: tx as unknown as EventTransaction,
    counters,
    relatedContexts,
    getPersistedEvent: () => persistedEvent,
  };
}

type ReplicationRecordTransaction = Parameters<
  typeof recordScheduleReplicationShadowEventInTransaction
>[0];

function inMemoryUndeliverableReplicationTransaction() {
  let persistedEvent: Record<string, unknown> | undefined;
  let eventId: number | undefined;
  let shiftAssignmentRead = 0;
  const persistedScopes: Record<string, unknown>[] = [];
  const counters = { events: 0, recipients: 0, deliveries: 0 };

  function rowsFor(table: unknown): Record<string, unknown>[] {
    if (table === shiftInstances) {
      return [
        {
          id: 701,
          sectorId: 4,
          scheduleContextId: null,
          startAt: new Date("2026-10-15T12:00:00.000Z"),
        },
      ];
    }
    if (table === monthlyRosters) return [{ id: 51 }];
    if (table === shiftAssignmentsV2) {
      shiftAssignmentRead += 1;
      // A primeira leitura prova a alocação OCUPADO copiada. A segunda é o
      // join canônico de entrega e fica vazia: vínculo revogado/não aprovado.
      return shiftAssignmentRead === 1
        ? [
            {
              id: 801,
              shiftInstanceId: 701,
              professionalId: 91,
              status: "OCUPADO",
              isActive: true,
            },
          ]
        : [];
    }
    if (table === professionalInstitutions) {
      return [{ id: 1, roleInInstitution: "GESTOR_MEDICO" }];
    }
    if (table === scheduleReplicationBatches) {
      return [{ id: 77, version: 1, status: "COMPLETED" }];
    }
    if (table === scheduleReplicationBatchScopes) {
      return [{ monthlyRosterId: 51, sectorId: 4, scheduleContextId: null }];
    }
    if (table === sectors) return [{ id: 4 }];
    if (table === operationalEvents) {
      return eventId === undefined
        ? []
        : [{ id: eventId, eventHash: persistedEvent?.eventHash }];
    }
    return [];
  }

  function lockableRows(rows: Record<string, unknown>[]) {
    const result = Promise.resolve(rows) as Promise<
      Record<string, unknown>[]
    > & {
      for: (_lock: "update") => Promise<Record<string, unknown>[]>;
      limit: (_limit: number) => Promise<Record<string, unknown>[]>;
    };
    result.for = () => result;
    result.limit = () => result;
    return result;
  }

  const tx = {
    select() {
      return {
        from(table: unknown) {
          const query = {
            innerJoin() {
              return query;
            },
            where() {
              return lockableRows(rowsFor(table));
            },
          };
          return query;
        },
      };
    },
    insert(table: unknown) {
      if (table === scheduleReplicationBatches) {
        return {
          values: () => ({ $returningId: async () => [{ id: 77 }] }),
        };
      }
      if (table === scheduleReplicationBatchScopes) {
        return {
          values: async (values: Record<string, unknown>[]) => {
            persistedScopes.push(...values);
          },
        };
      }
      if (table === operationalEvents) {
        return {
          values: async (value: Record<string, unknown>) => {
            persistedEvent = value;
            eventId = 1;
            counters.events += 1;
          },
        };
      }
      if (table === operationalEventRelatedContexts) {
        return { values: async () => undefined };
      }
      if (table === operationalEventRecipients) {
        return {
          values: () => ({
            $returningId: async () => {
              counters.recipients += 1;
              return [{ id: counters.recipients }];
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
      throw new Error("Tabela inesperada no teste de recipient indisponível");
    },
  };

  return {
    tx: tx as unknown as ReplicationRecordTransaction,
    counters,
    persistedScopes,
    getPersistedEvent: () => persistedEvent,
  };
}

describe("fato canônico de replicação", () => {
  it("consolida destinatários repetidos em um único fato multicanal", () => {
    const event = replicationEvent([71, 42, 71]);

    expect(event).toMatchObject({
      eventType: "SCHEDULE_REPLICATED",
      deliveryPolicy: "NOTIFY",
      aggregate: {
        type: "SCHEDULE_REPLICATION_BATCH",
        id: 77,
        version: 1,
      },
      transition: { from: "NONE", to: "COMPLETED" },
      context: { institutionId: 1, hospitalId: 10, scopeKind: "HOSPITAL" },
      recipients: [
        { kind: "USER", userId: 42, channels: ["PUSH", "EMAIL"] },
        { kind: "USER", userId: 71, channels: ["PUSH", "EMAIL"] },
      ],
    });
    expect(JSON.stringify(event)).not.toContain("@");
  });

  it("torna uma cópia somente de calendário um fato silencioso e auditado", () => {
    const event = replicationEvent([]);

    expect(event.deliveryPolicy).toBe("SILENT_AUDITED");
    expect(event.recipients).toEqual([]);
    expect(event.recipientResolution).toBe("NOT_APPLICABLE");
  });

  it("registra ausência de destinatário entregável sem transformar a cópia ocupada em silêncio", () => {
    const event = replicationEvent([], "NO_DELIVERABLE_RECIPIENTS");

    expect(event.deliveryPolicy).toBe("NOTIFY");
    expect(event.recipients).toEqual([]);
    expect(event.recipientResolution).toBe("NO_DELIVERABLE_RECIPIENTS");
  });

  it("mantém dois meses e dois setores no mesmo agregado, com um só recipient por médico", async () => {
    const memory = inMemoryReplicationEventTransaction();

    await expect(
      createOperationalEventInTransaction(
        memory.tx,
        replicationEvent([71, 71]),
      ),
    ).resolves.toMatchObject({ eventId: 1, created: true });

    expect(memory.counters).toEqual({
      events: 1,
      recipients: 1,
      deliveries: 0,
    });
    expect(memory.getPersistedEvent()).toMatchObject({
      eventType: "SCHEDULE_REPLICATED",
      aggregateType: "SCHEDULE_REPLICATION_BATCH",
      aggregateId: 77,
      aggregateVersion: 1,
      institutionId: 1,
      hospitalId: 10,
      scopeKind: "HOSPITAL",
      emissionMode: "SHADOW",
    });
    expect(memory.relatedContexts).toEqual([
      expect.objectContaining({
        relationKind: "AFFECTED_SCOPE",
        institutionId: 1,
        hospitalId: 10,
        scopeKind: "SECTOR",
        sectorId: 4,
        scheduleContextId: null,
      }),
      expect.objectContaining({
        relationKind: "AFFECTED_SCOPE",
        institutionId: 1,
        hospitalId: 10,
        scopeKind: "SECTOR",
        sectorId: 5,
        scheduleContextId: 9,
      }),
    ]);
  });

  it("falha antes de persistir o fato se o setor legado não pertence à topologia", async () => {
    const memory = inMemoryReplicationEventTransaction({ missingSector: true });

    await expect(
      createOperationalEventInTransaction(memory.tx, replicationEvent([])),
    ).rejects.toThrow("Setor do lote de replicação não pertence à topologia");
    expect(memory.counters).toEqual({
      events: 0,
      recipients: 0,
      deliveries: 0,
    });
  });

  it("preserva cópia ocupada com vínculo revogado, sem recipient ou delivery", async () => {
    const memory = inMemoryUndeliverableReplicationTransaction();

    await expect(
      recordScheduleReplicationShadowEventInTransaction(memory.tx, {
        institutionId: 1,
        hospitalId: 10,
        actor: { userId: 7, role: "GESTOR_MEDICO" },
        sourceKind: "RANGE",
        createdShiftIds: [701],
        createdAssignmentIds: [801],
      }),
    ).resolves.toMatchObject({ batchId: 77, event: { created: true } });

    expect(memory.persistedScopes).toEqual([
      expect.objectContaining({
        scheduleReplicationBatchId: 77,
        monthlyRosterId: 51,
        sectorId: 4,
        scheduleContextId: null,
      }),
    ]);
    expect(memory.getPersistedEvent()).toMatchObject({
      eventType: "SCHEDULE_REPLICATED",
      deliveryPolicy: "NOTIFY",
      recipientResolution: "NO_DELIVERABLE_RECIPIENTS",
    });
    expect(memory.counters).toEqual({
      events: 1,
      recipients: 0,
      deliveries: 0,
    });
  });
});

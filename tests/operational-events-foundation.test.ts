import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  createOperationalEventInTransaction,
  getOperationalEventEmissionMode,
  hashOperationalEmailAddress,
  isOperationalDeliveryRetryExhausted,
  isTerminalOperationalDeliveryStatus,
  OPERATIONAL_DELIVERY_MAX_ATTEMPTS,
  OPERATIONAL_EVENT_EMISSION_POLICIES,
  isTrustedOperationalEmail,
  operationalDeliveryDedupKey,
  operationalDeliveryRetryDelayMs,
  operationalEventHash,
  OperationalEventIdempotencyCollisionError,
  OperationalEventValidationError,
  type CreateOperationalEventInput,
} from "../server/operational-events";
import {
  canClaimOperationalDeliveryForEmissionMode,
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
  users,
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

type FoundationTransaction = Parameters<
  typeof createOperationalEventInTransaction
>[0];

function inMemoryOperationalEventTransaction(options?: {
  membershipChecks?: boolean[];
  membershipRoles?: ("USER" | "GESTOR_MEDICO" | "GESTOR_PLUS")[];
  globalAdmin?: boolean;
  inviteBelongsToInstitution?: boolean;
  resourceChecks?: boolean[];
  aggregateChecks?: boolean[];
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
    institutionId: number;
    hospitalId: number;
    sectorId: number;
    scheduleContextId?: number | null;
  }[];
}) {
  let event: { id: number; eventHash: string } | undefined;
  let persistedEvent: Record<string, unknown> | undefined;
  let didRunFirstAsyncRead = false;
  const relatedContextValues: Record<string, unknown>[] = [];
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
          values: () => ({
            $returningId: async () => {
              counters.recipients += 1;
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
      return {
        from(table: unknown) {
          return {
            where() {
              return {
                limit() {
                  if (!didRunFirstAsyncRead) {
                    didRunFirstAsyncRead = true;
                    options?.onFirstAsyncRead?.();
                  }
                  if (table === operationalEvents) {
                    return lockableRows(
                      event
                        ? [{ id: event.id, eventHash: event.eventHash }]
                        : [],
                    );
                  }
                  if (table === professionalInstitutions) {
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
                  if (table === users) {
                    return lockableRows(
                      options?.globalAdmin ? [{ id: 7 }] : [],
                    );
                  }
                  if (table === scheduleInvites) {
                    return lockableRows(
                      options?.inviteBelongsToInstitution === false
                        ? []
                        : [{ id: 1 }],
                    );
                  }
                  if (table === monthlyRosters) {
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
                  if (table === swapRequests) {
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
                  if (table === shiftInstances) {
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
                  if (table === shiftAssignmentsV2) {
                    return lockableRows(
                      resourceChecks.shift() === false
                        ? []
                        : [
                            assignmentRows.shift() ?? {
                              id: 1,
                              institutionId: 1,
                              hospitalId: 10,
                              sectorId: 4,
                              scheduleContextId: 8,
                            },
                          ],
                    );
                  }
                  return lockableRows([]);
                },
              };
            },
          };
        },
      };
    },
  };

  return {
    tx: tx as unknown as FoundationTransaction,
    counters,
    getPersistedEvent: () => persistedEvent,
    getRelatedContexts: () => relatedContextValues,
  };
}

describe("foundation de eventos operacionais", () => {
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

  it("fixa ROSTER_PUBLISHED em sombra no catálogo do servidor e no fato", async () => {
    expect(getOperationalEventEmissionMode("ROSTER_PUBLISHED")).toBe("SHADOW");
    expect(Object.isFrozen(OPERATIONAL_EVENT_EMISSION_POLICIES)).toBe(true);

    const memory = inMemoryOperationalEventTransaction();
    await expect(
      createOperationalEventInTransaction(memory.tx, hospitalEvent()),
    ).resolves.toMatchObject({ eventId: 1, created: true });
    expect(memory.getPersistedEvent()).toMatchObject({
      eventType: "ROSTER_PUBLISHED",
      emissionMode: "SHADOW",
    });
  });

  it("não aceita ativação escolhida pelo caller", () => {
    const clientSelectedActive = {
      ...hospitalEvent(),
      emissionMode: "ACTIVE",
    } as unknown as CreateOperationalEventInput;

    expect(() => operationalEventHash(clientSelectedActive)).toThrow(
      "Modo de emissão é definido exclusivamente pelo servidor",
    );
  });

  it("inclui a versão e o modo na projeção de deduplicação", () => {
    const currentVersion = hospitalEvent();
    const nextVersion = {
      ...hospitalEvent(),
      aggregate: { ...hospitalEvent().aggregate, version: 4 },
    };
    expect(operationalEventHash(currentVersion)).not.toBe(
      operationalEventHash(nextVersion),
    );
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
    // Se a mutação externa fizer rollback ou não alcançar PUBLISHED, a
    // validação ocorre antes de inserir fato, recipients ou deliveries.
    expect(staleRoster.counters).toEqual({
      relatedContexts: 0,
      recipients: 0,
      deliveries: 0,
    });

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

  it("cria fato, recipients e deliveries no mesmo transaction e torna retry idempotente", async () => {
    const memory = inMemoryOperationalEventTransaction();
    const input = hospitalEvent();

    await expect(
      createOperationalEventInTransaction(memory.tx, input),
    ).resolves.toMatchObject({ eventId: 1, created: true });
    expect(memory.counters).toEqual({
      relatedContexts: 0,
      recipients: 1,
      deliveries: 2,
    });

    await expect(
      createOperationalEventInTransaction(memory.tx, input),
    ).resolves.toMatchObject({ eventId: 1, created: false });
    expect(memory.counters).toEqual({
      relatedContexts: 0,
      recipients: 1,
      deliveries: 2,
    });

    const collision = hospitalEvent();
    collision.recipients = [
      { kind: "USER", userId: 21, channels: ["PUSH", "EMAIL"] },
    ];
    await expect(
      createOperationalEventInTransaction(memory.tx, collision),
    ).rejects.toBeInstanceOf(OperationalEventIdempotencyCollisionError);
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

  it("reconhece o Gestor+ global revalidado sem relaxar outros papéis", async () => {
    const globalAdmin = inMemoryOperationalEventTransaction({
      membershipRoles: ["USER"],
      globalAdmin: true,
    });
    const input = hospitalEvent();
    input.actor = { kind: "USER", userId: 7, role: "GESTOR_PLUS" };

    await expect(
      createOperationalEventInTransaction(globalAdmin.tx, input),
    ).resolves.toMatchObject({ eventId: 1, created: true });
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
    expect(canClaimOperationalDeliveryForEmissionMode("SHADOW")).toBe(false);
    expect(canClaimOperationalDeliveryForEmissionMode("ACTIVE")).toBe(true);
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

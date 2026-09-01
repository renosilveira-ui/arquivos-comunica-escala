import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildShiftUpdatedShadowEventInput,
  canonicalizeShiftUpdatedRecipientUserIds,
  hasMaterialShiftUpdatedChange,
  planShiftOperationalRevision,
  recordShiftUpdatedShadowEventInTransaction,
  shiftUpdatedShadowIdempotencyKey,
  type CanonicalShiftUpdatedRecipientRow,
  type ShiftUpdatedShadowSnapshot,
} from "../server/shift-operational-events";
import {
  notificationDeliveries,
  operationalEventRecipients,
  operationalEvents,
  professionalInstitutions,
  shiftAssignmentsV2,
  shiftInstances,
} from "../drizzle/schema";

type ShiftUpdatedTransaction = Parameters<
  typeof recordShiftUpdatedShadowEventInTransaction
>[0];

type MemoryShift = {
  id: number;
  institutionId: number;
  hospitalId: number;
  sectorId: number;
  scheduleContextId: number | null;
  operationalRevision: number;
  startAt: Date;
  endAt: Date;
  modality: "PLANTAO" | "SOBREAVISO";
};

type MemoryAssignment = {
  id: number;
  isActive: boolean;
  status: string;
};

function currentShift(overrides: Partial<MemoryShift> = {}): MemoryShift {
  return {
    id: 80,
    institutionId: 1,
    hospitalId: 10,
    sectorId: 4,
    scheduleContextId: 8,
    operationalRevision: 4,
    startAt: new Date("2026-09-10T13:00:00.000Z"),
    endAt: new Date("2026-09-10T19:00:00.000Z"),
    modality: "PLANTAO",
    ...overrides,
  };
}

function previousSnapshot(overrides: Partial<ShiftUpdatedShadowSnapshot> = {}) {
  return {
    startAt: new Date("2026-09-10T07:00:00.000Z"),
    endAt: new Date("2026-09-10T13:00:00.000Z"),
    modality: "PLANTAO" as const,
    operationalRevision: 3,
    ...overrides,
  };
}

function canonicalRecipientRow(
  userId: number,
  assignmentId: number,
  overrides: Partial<CanonicalShiftUpdatedRecipientRow> = {},
): CanonicalShiftUpdatedRecipientRow {
  const professionalId = assignmentId + 1_000;
  return {
    assignmentId,
    assignmentShiftInstanceId: 80,
    assignmentInstitutionId: 1,
    assignmentHospitalId: 10,
    assignmentSectorId: 4,
    assignmentProfessionalId: professionalId,
    assignmentIsActive: true,
    assignmentStatus: "OCUPADO",
    professionalId,
    professionalUserId: userId,
    membershipProfessionalId: professionalId,
    membershipUserId: userId,
    membershipInstitutionId: 1,
    membershipActive: true,
    userId,
    userApprovalStatus: "APPROVED",
    userDeletedAt: null,
    ...overrides,
  };
}

function inMemoryShiftUpdatedTransaction(options?: {
  shift?: MemoryShift;
  assignments?: readonly MemoryAssignment[];
  recipientRows?: readonly CanonicalShiftUpdatedRecipientRow[];
}) {
  const shift = options?.shift ?? currentShift();
  const assignments = options?.assignments ?? [
    { id: 301, isActive: true, status: "OCUPADO" },
    { id: 302, isActive: true, status: "OCUPADO" },
  ];
  const recipientRows = options?.recipientRows ?? [
    canonicalRecipientRow(21, 301),
    canonicalRecipientRow(20, 302),
    canonicalRecipientRow(21, 302),
  ];
  let event: { id: number; eventHash: string } | undefined;
  let persistedEvent: Record<string, unknown> | undefined;
  const persistedRecipients: Record<string, unknown>[] = [];
  const counters = { events: 0, recipients: 0, deliveries: 0 };

  function lockableRows<T>(rows: readonly T[]) {
    const result = Promise.resolve([...rows]) as Promise<T[]> & {
      for: (_lock: "update") => Promise<T[]>;
    };
    result.for = () => result;
    return result;
  }

  function queryFor(table: unknown) {
    let joined = false;
    const rows = (): readonly Record<string, unknown>[] => {
      if (table === shiftInstances) return [shift];
      if (table === shiftAssignmentsV2) {
        return joined ? recipientRows : assignments;
      }
      if (table === professionalInstitutions) {
        return [{ id: 1, roleInInstitution: "GESTOR_MEDICO" }];
      }
      if (table === operationalEvents) {
        return event ? [{ id: event.id, eventHash: event.eventHash }] : [];
      }
      return [];
    };
    const query = {
      innerJoin() {
        joined = true;
        return query;
      },
      where() {
        return query;
      },
      orderBy() {
        return query;
      },
      limit() {
        return lockableRows(rows());
      },
      for() {
        return lockableRows(rows());
      },
    };
    return query;
  }

  const tx = {
    select() {
      return {
        from(table: unknown) {
          return queryFor(table);
        },
      };
    },
    insert(table: unknown) {
      if (table === operationalEvents) {
        return {
          values: async (value: Record<string, unknown>) => {
            if (event) {
              throw Object.assign(new Error("duplicate"), {
                code: "ER_DUP_ENTRY",
              });
            }
            persistedEvent = value;
            event = { id: 1, eventHash: value.eventHash as string };
            counters.events += 1;
          },
        };
      }
      if (table === operationalEventRecipients) {
        return {
          values: (value: Record<string, unknown>) => ({
            $returningId: async () => {
              persistedRecipients.push(value);
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
      throw new Error("Tabela inesperada no teste de SHIFT_UPDATED");
    },
  };

  return {
    tx: tx as unknown as ShiftUpdatedTransaction,
    counters,
    getPersistedEvent: () => persistedEvent,
    getPersistedRecipients: () => persistedRecipients,
  };
}

function eventInput(overrides?: {
  previous?: ReturnType<typeof previousSnapshot>;
  nextOperationalRevision?: number;
}) {
  return {
    context: {
      institutionId: 1,
      hospitalId: 10,
      sectorId: 4,
      scheduleContextId: 8,
      shiftInstanceId: 80,
    },
    previous: overrides?.previous ?? previousSnapshot(),
    nextOperationalRevision: overrides?.nextOperationalRevision ?? 4,
    actor: {
      userId: 7,
      professionalId: 70,
      role: "GESTOR_MEDICO" as const,
    },
  };
}

describe("SHIFT_UPDATED em modo SHADOW", () => {
  it("considera material somente horário ou modalidade, não campos administrativos", () => {
    const base: ShiftUpdatedShadowSnapshot = {
      startAt: new Date("2026-09-10T07:00:00.000Z"),
      endAt: new Date("2026-09-10T13:00:00.000Z"),
      modality: "PLANTAO",
    };

    expect(hasMaterialShiftUpdatedChange(base, { ...base })).toBe(false);
    expect(
      hasMaterialShiftUpdatedChange(base, {
        ...base,
        endAt: new Date("2026-09-10T14:00:00.000Z"),
      }),
    ).toBe(true);
    expect(
      hasMaterialShiftUpdatedChange(base, {
        ...base,
        modality: "SOBREAVISO",
      }),
    ).toBe(true);
  });

  it("não prepara CAS nem fato quando a edição repete o estado atual", () => {
    const prior = {
      startAt: new Date("2026-09-10T07:00:00.000Z"),
      endAt: new Date("2026-09-10T13:00:00.000Z"),
      modality: "PLANTAO" as const,
      coverageType: "URGENCIA_EMERGENCIA" as const,
      paymentModel: "FIXO" as const,
      productivityCapBrl: null,
    };
    const unchanged = planShiftOperationalRevision(prior, {
      startAt: new Date("2026-09-10T07:00:00.000Z"),
      endAt: new Date("2026-09-10T13:00:00.000Z"),
      modality: "PLANTAO",
    });
    expect(unchanged).toEqual({});

    const administrativeOnly = planShiftOperationalRevision(prior, {
      paymentModel: "PRODUTIVIDADE_PURA",
    });
    expect(administrativeOnly).toEqual({
      paymentModel: "PRODUTIVIDADE_PURA",
    });
  });

  it("mantém CAS e fato no mesmo callback transacional de shifts.update", () => {
    const source = readFileSync(
      new URL("../server/shifts-crud.ts", import.meta.url),
      "utf8",
    );
    const updateStart = source.indexOf("update: protectedProcedure");
    const transactionStart = source.indexOf(
      "await db.transaction(async (tx) => {",
      updateStart,
    );
    const cas = source.indexOf("advanceShiftInstanceRevision(", transactionStart);
    const ledger = source.indexOf(
      "recordShiftUpdatedShadowEventInTransaction(tx,",
      transactionStart,
    );
    const transactionEnd = source.indexOf(
      "}, ASSIGNMENT_WRITE_TRANSACTION_CONFIG);",
      ledger,
    );

    expect(updateStart).toBeGreaterThan(-1);
    expect(transactionStart).toBeGreaterThan(updateStart);
    expect(cas).toBeGreaterThan(transactionStart);
    expect(ledger).toBeGreaterThan(cas);
    expect(transactionEnd).toBeGreaterThan(ledger);
  });

  it("usa instância, próxima revisão e tipo do fato na chave idempotente", () => {
    expect(
      shiftUpdatedShadowIdempotencyKey({
        shiftInstanceId: 80,
        operationalRevision: 4,
      }),
    ).toBe("shift-updated:shift:80:revision:4:event:SHIFT_UPDATED");
    expect(
      shiftUpdatedShadowIdempotencyKey({
        shiftInstanceId: 80,
        operationalRevision: 5,
      }),
    ).not.toBe(
      shiftUpdatedShadowIdempotencyKey({
        shiftInstanceId: 81,
        operationalRevision: 4,
      }),
    );
  });

  it("declara PUSH e EMAIL uma única vez por médico no fato canônico", () => {
    const event = buildShiftUpdatedShadowEventInput({
      context: eventInput().context,
      operationalRevision: 4,
      actor: eventInput().actor,
      recipientUserIds: [21, 20, 21],
      recipientResolution: "RESOLVED",
    });

    expect(event).toMatchObject({
      eventType: "SHIFT_UPDATED",
      transition: { from: null, to: null },
      aggregate: { type: "SHIFT_INSTANCE", id: 80, version: 4 },
      context: {
        institutionId: 1,
        hospitalId: 10,
        sectorId: 4,
        scheduleContextId: 8,
        shiftInstanceId: 80,
      },
      recipients: [
        { kind: "USER", userId: 20, channels: ["PUSH", "EMAIL"] },
        { kind: "USER", userId: 21, channels: ["PUSH", "EMAIL"] },
      ],
    });
  });

  it("aceita somente a cadeia canônica assignment→professional→PI→user", () => {
    const recipientUserIds = canonicalizeShiftUpdatedRecipientUserIds({
      context: eventInput().context,
      confirmedAssignmentIds: [301, 302],
      rows: [
        canonicalRecipientRow(20, 301),
        canonicalRecipientRow(20, 302),
        canonicalRecipientRow(21, 302, { membershipActive: false }),
        canonicalRecipientRow(22, 302, { userApprovalStatus: "PENDING" }),
        canonicalRecipientRow(23, 302, { userDeletedAt: new Date() }),
        canonicalRecipientRow(24, 302, { membershipInstitutionId: 2 }),
        canonicalRecipientRow(25, 302, { assignmentHospitalId: 11 }),
        canonicalRecipientRow(26, 302, { assignmentStatus: "PENDENTE" }),
        canonicalRecipientRow(27, 302, { professionalUserId: 999 }),
      ],
    });

    expect(recipientUserIds).toEqual([20]);
  });

  it("persiste fato, deduplica médicos OCUPADO e não cria delivery em SHADOW", async () => {
    const memory = inMemoryShiftUpdatedTransaction();

    await expect(
      recordShiftUpdatedShadowEventInTransaction(memory.tx, eventInput()),
    ).resolves.toMatchObject({ eventId: 1, created: true });

    expect(memory.getPersistedEvent()).toMatchObject({
      eventType: "SHIFT_UPDATED",
      emissionMode: "SHADOW",
      deliveryPolicy: "NOTIFY",
      aggregateType: "SHIFT_INSTANCE",
      aggregateId: 80,
      aggregateVersion: 4,
      transitionFrom: null,
      transitionTo: null,
      institutionId: 1,
      hospitalId: 10,
      sectorId: 4,
      scheduleContextId: 8,
      shiftInstanceId: 80,
      recipientResolution: "RESOLVED",
    });
    expect(memory.getPersistedRecipients()).toEqual([
      expect.objectContaining({ userId: 20, institutionId: 1 }),
      expect.objectContaining({ userId: 21, institutionId: 1 }),
    ]);
    expect(memory.counters).toEqual({
      events: 1,
      recipients: 2,
      deliveries: 0,
    });

    await expect(
      recordShiftUpdatedShadowEventInTransaction(memory.tx, eventInput()),
    ).resolves.toMatchObject({ eventId: 1, created: false });
    expect(memory.counters).toEqual({
      events: 1,
      recipients: 2,
      deliveries: 0,
    });
  });

  it("exclui PENDENTE e mantém o fato com resolução explícita", async () => {
    const memory = inMemoryShiftUpdatedTransaction({
      assignments: [{ id: 303, isActive: true, status: "PENDENTE" }],
      recipientRows: [canonicalRecipientRow(22, 303)],
    });

    await expect(
      recordShiftUpdatedShadowEventInTransaction(memory.tx, eventInput()),
    ).resolves.toMatchObject({ eventId: 1, created: true });
    expect(memory.getPersistedEvent()).toMatchObject({
      recipientResolution: "NO_ELIGIBLE_RECIPIENTS",
    });
    expect(memory.counters).toEqual({
      events: 1,
      recipients: 0,
      deliveries: 0,
    });
  });

  it("registra indisponibilidade de vínculo entregável sem apagar o fato", async () => {
    const memory = inMemoryShiftUpdatedTransaction({ recipientRows: [] });

    await expect(
      recordShiftUpdatedShadowEventInTransaction(memory.tx, eventInput()),
    ).resolves.toMatchObject({ eventId: 1, created: true });
    expect(memory.getPersistedEvent()).toMatchObject({
      recipientResolution: "NO_DELIVERABLE_RECIPIENTS",
    });
    expect(memory.counters).toEqual({
      events: 1,
      recipients: 0,
      deliveries: 0,
    });
  });

  it("não registra fato sem mudança material, antes de qualquer persistência", async () => {
    const memory = inMemoryShiftUpdatedTransaction({
      shift: currentShift({
        startAt: new Date("2026-09-10T07:00:00.000Z"),
        endAt: new Date("2026-09-10T13:00:00.000Z"),
      }),
    });

    await expect(
      recordShiftUpdatedShadowEventInTransaction(memory.tx, eventInput()),
    ).rejects.toThrow("SHIFT_UPDATED exige mudança material");
    expect(memory.counters).toEqual({
      events: 0,
      recipients: 0,
      deliveries: 0,
    });
  });

  it("falha fechado em revisão CAS ou topologia canônica divergentes", async () => {
    const staleRevision = inMemoryShiftUpdatedTransaction({
      shift: currentShift({ operationalRevision: 3 }),
    });
    await expect(
      recordShiftUpdatedShadowEventInTransaction(
        staleRevision.tx,
        eventInput(),
      ),
    ).rejects.toThrow("Turno ou revisão canônica diverge");
    expect(staleRevision.counters).toEqual({
      events: 0,
      recipients: 0,
      deliveries: 0,
    });

    const wrongTenant = inMemoryShiftUpdatedTransaction({
      shift: currentShift({ institutionId: 2 }),
    });
    await expect(
      recordShiftUpdatedShadowEventInTransaction(wrongTenant.tx, eventInput()),
    ).rejects.toThrow("Turno ou revisão canônica diverge");
    expect(wrongTenant.counters).toEqual({
      events: 0,
      recipients: 0,
      deliveries: 0,
    });
  });
});

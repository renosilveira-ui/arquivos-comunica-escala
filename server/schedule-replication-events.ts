import { createHash, randomUUID } from "node:crypto";
import { and, eq, inArray, isNull } from "drizzle-orm";
import {
  monthlyRosters,
  professionalInstitutions,
  professionals,
  scheduleContexts,
  scheduleReplicationBatches,
  scheduleReplicationBatchScopes,
  shiftAssignmentsV2,
  shiftInstances,
  users,
} from "../drizzle/schema";
import { yearMonthBrt } from "./local-time";
import {
  createOperationalEventInTransaction,
  OperationalEventValidationError,
  type CreateOperationalEventInput,
  type OperationalEventCreateResult,
  type OperationalEventTx,
} from "./operational-events";

export const SCHEDULE_REPLICATION_BATCH_SOURCE_KINDS = [
  "RANGE",
  "MONTH_CALENDAR",
] as const;

export type ScheduleReplicationBatchSourceKind =
  (typeof SCHEDULE_REPLICATION_BATCH_SOURCE_KINDS)[number];

export type ScheduleReplicationEventActor = {
  userId: number;
  professionalId?: number | null;
  role: "USER" | "GESTOR_MEDICO" | "GESTOR_PLUS";
};

type RecordScheduleReplicationShadowEventInput = {
  institutionId: number;
  hospitalId: number;
  actor: ScheduleReplicationEventActor;
  sourceKind: ScheduleReplicationBatchSourceKind;
  createdShiftIds: readonly number[];
  createdAssignmentIds: readonly number[];
};

type ReplicationShiftSnapshot = {
  id: number;
  sectorId: number;
  scheduleContextId: number | null;
  startAt: Date;
};

function assertPositiveId(
  value: unknown,
  label: string,
): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new OperationalEventValidationError(`${label} deve ser positivo`);
  }
}

function canonicalIds(values: readonly number[], label: string): number[] {
  const unique = new Set<number>();
  for (const value of values) {
    assertPositiveId(value, label);
    if (unique.has(value)) {
      throw new OperationalEventValidationError(
        `${label} não pode repetir IDs`,
      );
    }
    unique.add(value);
  }
  return [...unique].sort((left, right) => left - right);
}

function canonicalRecipientUserIds(values: readonly number[]): number[] {
  const unique = new Set<number>();
  for (const value of values) {
    assertPositiveId(value, "recipientUserIds");
    unique.add(value);
  }
  return [...unique].sort((left, right) => left - right);
}

function commandKeyHash(): string {
  // O UUID em claro nunca sai deste processo; só o hash persiste no lote.
  return createHash("sha256").update(randomUUID()).digest("hex");
}

/**
 * Projeção pura da entrega: um único fato agrega todos os destinatários
 * ocupados do comando, independentemente de ele atravessar mês ou setor.
 */
export function buildScheduleReplicationEventInput(input: {
  institutionId: number;
  hospitalId: number;
  batchId: number;
  batchVersion: number;
  actor: ScheduleReplicationEventActor;
  recipientUserIds: readonly number[];
  /**
   * Ausência de destinatário por vínculo revogado, conta não aprovada ou
   * indisponibilidade equivalente continua sendo um fato NOTIFY auditável.
   * A ausência de alocação ocupada (calendário vazio) permanece silenciosa.
   */
  emptyRecipientResolution?: "NO_DELIVERABLE_RECIPIENTS" | "NOT_APPLICABLE";
}): CreateOperationalEventInput {
  assertPositiveId(input.institutionId, "institutionId");
  assertPositiveId(input.hospitalId, "hospitalId");
  assertPositiveId(input.batchId, "batchId");
  assertPositiveId(input.batchVersion, "batchVersion");
  assertPositiveId(input.actor.userId, "actor.userId");
  if (
    input.actor.professionalId !== null &&
    input.actor.professionalId !== undefined
  ) {
    assertPositiveId(input.actor.professionalId, "actor.professionalId");
  }

  const recipientUserIds = canonicalRecipientUserIds(input.recipientUserIds);
  const hasRecipients = recipientUserIds.length > 0;
  const emptyRecipientResolution =
    input.emptyRecipientResolution ?? "NOT_APPLICABLE";
  const deliveryPolicy =
    hasRecipients || emptyRecipientResolution === "NO_DELIVERABLE_RECIPIENTS"
      ? "NOTIFY"
      : "SILENT_AUDITED";

  return {
    idempotencyKey: `schedule-replicated:${input.institutionId}:${input.hospitalId}:batch:${input.batchId}:v${input.batchVersion}`,
    eventType: "SCHEDULE_REPLICATED",
    deliveryPolicy,
    aggregate: {
      type: "SCHEDULE_REPLICATION_BATCH",
      id: input.batchId,
      version: input.batchVersion,
    },
    transition: { from: "NONE", to: "COMPLETED" },
    context: {
      institutionId: input.institutionId,
      hospitalId: input.hospitalId,
      scopeKind: "HOSPITAL",
    },
    actor: {
      kind: "USER",
      userId: input.actor.userId,
      professionalId: input.actor.professionalId ?? null,
      role: input.actor.role,
    },
    recipients: recipientUserIds.map((userId) => ({
      kind: "USER" as const,
      userId,
      channels: ["PUSH", "EMAIL"] as const,
    })),
    recipientResolution: hasRecipients ? "RESOLVED" : emptyRecipientResolution,
  };
}

async function lockCreatedShifts(
  tx: OperationalEventTx,
  input: {
    institutionId: number;
    hospitalId: number;
    shiftIds: readonly number[];
  },
): Promise<ReplicationShiftSnapshot[]> {
  const rows = await tx
    .select({
      id: shiftInstances.id,
      sectorId: shiftInstances.sectorId,
      scheduleContextId: shiftInstances.scheduleContextId,
      startAt: shiftInstances.startAt,
    })
    .from(shiftInstances)
    .where(
      and(
        eq(shiftInstances.institutionId, input.institutionId),
        eq(shiftInstances.hospitalId, input.hospitalId),
        inArray(shiftInstances.id, [...input.shiftIds]),
      ),
    )
    .for("update");
  if (rows.length !== input.shiftIds.length) {
    throw new OperationalEventValidationError(
      "Turnos criados não pertencem à topologia da replicação",
    );
  }
  return rows;
}

async function lockTargetRosters(
  tx: OperationalEventTx,
  input: {
    institutionId: number;
    hospitalId: number;
    shifts: readonly ReplicationShiftSnapshot[];
  },
): Promise<Map<string, number>> {
  const months = [
    ...new Set(input.shifts.map((shift) => yearMonthBrt(shift.startAt))),
  ].sort();
  const rosters = new Map<string, number>();
  for (const yearMonth of months) {
    const [roster] = await tx
      .select({ id: monthlyRosters.id })
      .from(monthlyRosters)
      .where(
        and(
          eq(monthlyRosters.institutionId, input.institutionId),
          eq(monthlyRosters.hospitalId, input.hospitalId),
          eq(monthlyRosters.yearMonth, yearMonth),
        ),
      )
      .limit(1)
      .for("update");
    if (!roster) {
      throw new OperationalEventValidationError(
        "Competência alvo não foi travada pela replicação",
      );
    }
    rosters.set(yearMonth, roster.id);
  }
  return rosters;
}

async function assertCreatedShiftContextsActive(
  tx: OperationalEventTx,
  input: {
    institutionId: number;
    hospitalId: number;
    shifts: readonly ReplicationShiftSnapshot[];
  },
): Promise<void> {
  const contexts = [
    ...new Set(
      input.shifts
        .map((shift) => shift.scheduleContextId)
        .filter((contextId): contextId is number => contextId !== null),
    ),
  ].sort((left, right) => left - right);
  if (contexts.length === 0) return;
  const rows = await tx
    .select({
      id: scheduleContexts.id,
      sectorId: scheduleContexts.sectorId,
      active: scheduleContexts.active,
    })
    .from(scheduleContexts)
    .where(
      and(
        eq(scheduleContexts.institutionId, input.institutionId),
        eq(scheduleContexts.hospitalId, input.hospitalId),
        inArray(scheduleContexts.id, contexts),
      ),
    )
    .for("update");
  const contextsById = new Map(rows.map((row) => [row.id, row]));
  if (
    rows.length !== contexts.length ||
    input.shifts.some((shift) => {
      if (shift.scheduleContextId === null) return false;
      const context = contextsById.get(shift.scheduleContextId);
      return !context || !context.active || context.sectorId !== shift.sectorId;
    })
  ) {
    throw new OperationalEventValidationError(
      "Contexto de escala da replicação não está ativo na topologia alvo",
    );
  }
}

type ReplicationRecipientResolution = {
  recipientUserIds: number[];
  hasOccupiedAssignments: boolean;
};

async function resolveConfirmedRecipientUserIds(
  tx: OperationalEventTx,
  input: {
    institutionId: number;
    hospitalId: number;
    shiftIds: readonly number[];
    assignmentIds: readonly number[];
  },
): Promise<ReplicationRecipientResolution> {
  if (input.assignmentIds.length === 0) {
    return { recipientUserIds: [], hasOccupiedAssignments: false };
  }

  const assignments = await tx
    .select({
      id: shiftAssignmentsV2.id,
      shiftInstanceId: shiftAssignmentsV2.shiftInstanceId,
      professionalId: shiftAssignmentsV2.professionalId,
      status: shiftAssignmentsV2.status,
      isActive: shiftAssignmentsV2.isActive,
    })
    .from(shiftAssignmentsV2)
    .where(
      and(
        eq(shiftAssignmentsV2.institutionId, input.institutionId),
        eq(shiftAssignmentsV2.hospitalId, input.hospitalId),
        inArray(shiftAssignmentsV2.id, [...input.assignmentIds]),
      ),
    )
    .for("update");
  if (assignments.length !== input.assignmentIds.length) {
    throw new OperationalEventValidationError(
      "Alocações criadas não pertencem à topologia da replicação",
    );
  }
  const createdShiftIds = new Set(input.shiftIds);
  if (
    assignments.some(
      (assignment) => !createdShiftIds.has(assignment.shiftInstanceId),
    )
  ) {
    throw new OperationalEventValidationError(
      "Alocação da replicação não pertence a um turno criado no lote",
    );
  }

  const occupiedAssignmentIds = assignments
    .filter(
      (assignment) => assignment.isActive && assignment.status === "OCUPADO",
    )
    .map((assignment) => assignment.id)
    .sort((left, right) => left - right);
  if (occupiedAssignmentIds.length === 0) {
    return { recipientUserIds: [], hasOccupiedAssignments: false };
  }

  const recipientRows = await tx
    .select({
      userId: professionals.userId,
    })
    .from(shiftAssignmentsV2)
    .innerJoin(
      shiftInstances,
      and(
        eq(shiftInstances.id, shiftAssignmentsV2.shiftInstanceId),
        eq(shiftInstances.institutionId, shiftAssignmentsV2.institutionId),
        eq(shiftInstances.hospitalId, shiftAssignmentsV2.hospitalId),
        eq(shiftInstances.sectorId, shiftAssignmentsV2.sectorId),
      ),
    )
    .innerJoin(
      professionals,
      eq(professionals.id, shiftAssignmentsV2.professionalId),
    )
    .innerJoin(
      professionalInstitutions,
      and(
        eq(professionalInstitutions.professionalId, professionals.id),
        eq(professionalInstitutions.userId, professionals.userId),
        eq(
          professionalInstitutions.institutionId,
          shiftAssignmentsV2.institutionId,
        ),
        eq(professionalInstitutions.active, true),
      ),
    )
    .innerJoin(
      users,
      and(
        eq(users.id, professionals.userId),
        eq(users.approvalStatus, "APPROVED"),
        isNull(users.deletedAt),
      ),
    )
    .where(
      and(
        eq(shiftAssignmentsV2.institutionId, input.institutionId),
        eq(shiftAssignmentsV2.hospitalId, input.hospitalId),
        eq(shiftAssignmentsV2.isActive, true),
        eq(shiftAssignmentsV2.status, "OCUPADO"),
        inArray(shiftAssignmentsV2.id, occupiedAssignmentIds),
        inArray(shiftInstances.id, [...input.shiftIds]),
      ),
    )
    .for("update");

  // O vínculo de entrega pode ser revogado sem invalidar o plantão copiado.
  // Filtramos apenas contas canônicas entregáveis; se a lista ficar vazia,
  // o fato permanece NOTIFY com causa explícita, sem recipient nem rollback.
  return {
    recipientUserIds: [...new Set(recipientRows.map((row) => row.userId))].sort(
      (left, right) => left - right,
    ),
    hasOccupiedAssignments: true,
  };
}

/**
 * Persiste lote, escopos e fato canônico na mesma transação que materializa
 * a cópia. Falha de topologia ou do ledger reverte os turnos/alocações junto
 * com o lote; indisponibilidade de entrega só altera a resolução do fato e
 * nunca invalida a escala já copiada.
 */
export async function recordScheduleReplicationShadowEventInTransaction(
  tx: OperationalEventTx,
  input: RecordScheduleReplicationShadowEventInput,
): Promise<{ batchId: number; event: OperationalEventCreateResult }> {
  assertPositiveId(input.institutionId, "institutionId");
  assertPositiveId(input.hospitalId, "hospitalId");
  assertPositiveId(input.actor.userId, "actor.userId");
  if (
    input.actor.professionalId !== null &&
    input.actor.professionalId !== undefined
  ) {
    assertPositiveId(input.actor.professionalId, "actor.professionalId");
  }
  if (!SCHEDULE_REPLICATION_BATCH_SOURCE_KINDS.includes(input.sourceKind)) {
    throw new OperationalEventValidationError(
      "sourceKind de replicação inválido",
    );
  }
  const shiftIds = canonicalIds(input.createdShiftIds, "createdShiftIds");
  if (shiftIds.length === 0) {
    throw new OperationalEventValidationError(
      "Lote de replicação exige ao menos um turno criado",
    );
  }
  const assignmentIds = canonicalIds(
    input.createdAssignmentIds,
    "createdAssignmentIds",
  );

  const shifts = await lockCreatedShifts(tx, {
    institutionId: input.institutionId,
    hospitalId: input.hospitalId,
    shiftIds,
  });
  await assertCreatedShiftContextsActive(tx, {
    institutionId: input.institutionId,
    hospitalId: input.hospitalId,
    shifts,
  });
  const targetRosters = await lockTargetRosters(tx, {
    institutionId: input.institutionId,
    hospitalId: input.hospitalId,
    shifts,
  });

  const [batch] = await tx
    .insert(scheduleReplicationBatches)
    .values({
      institutionId: input.institutionId,
      hospitalId: input.hospitalId,
      commandKeyHash: commandKeyHash(),
      sourceKind: input.sourceKind,
      status: "COMPLETED",
      version: 1,
      createdByUserId: input.actor.userId,
    })
    .$returningId();
  if (!batch?.id) {
    throw new OperationalEventValidationError(
      "Lote de replicação não foi persistido",
    );
  }

  const scopeByKey = new Map<
    string,
    {
      monthlyRosterId: number;
      sectorId: number;
      scheduleContextId: number | null;
    }
  >();
  for (const shift of shifts) {
    const monthlyRosterId = targetRosters.get(yearMonthBrt(shift.startAt));
    if (!monthlyRosterId) {
      throw new OperationalEventValidationError(
        "Escopo canônico da replicação não pôde ser resolvido",
      );
    }
    const scope = {
      monthlyRosterId,
      sectorId: shift.sectorId,
      scheduleContextId: shift.scheduleContextId,
    };
    scopeByKey.set(
      `${scope.monthlyRosterId}:${scope.sectorId}:${scope.scheduleContextId ?? "NONE"}`,
      scope,
    );
  }
  await tx.insert(scheduleReplicationBatchScopes).values(
    [...scopeByKey.values()]
      .sort(
        (left, right) =>
          left.monthlyRosterId - right.monthlyRosterId ||
          left.sectorId - right.sectorId ||
          (left.scheduleContextId ?? -1) - (right.scheduleContextId ?? -1),
      )
      .map((scope) => ({
        scheduleReplicationBatchId: batch.id,
        institutionId: input.institutionId,
        hospitalId: input.hospitalId,
        ...scope,
      })),
  );

  const recipientResolution = await resolveConfirmedRecipientUserIds(tx, {
    institutionId: input.institutionId,
    hospitalId: input.hospitalId,
    shiftIds,
    assignmentIds,
  });
  const event = await createOperationalEventInTransaction(
    tx,
    buildScheduleReplicationEventInput({
      institutionId: input.institutionId,
      hospitalId: input.hospitalId,
      batchId: batch.id,
      batchVersion: 1,
      actor: input.actor,
      recipientUserIds: recipientResolution.recipientUserIds,
      emptyRecipientResolution: recipientResolution.hasOccupiedAssignments
        ? "NO_DELIVERABLE_RECIPIENTS"
        : "NOT_APPLICABLE",
    }),
  );
  return { batchId: batch.id, event };
}

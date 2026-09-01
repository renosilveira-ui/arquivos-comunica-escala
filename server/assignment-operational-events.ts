import { and, eq, isNull } from "drizzle-orm";
import {
  professionalInstitutions,
  professionals,
  shiftAssignmentsV2,
  shiftInstances,
} from "../drizzle/schema";
import {
  createOperationalEventInTransaction,
  OperationalEventValidationError,
  type OperationalEventActor,
  type OperationalEventTx,
  type OperationalEventType,
} from "./operational-events";

/**
 * Esta frente cobre somente os writers de alocação direta e de substituição
 * confirmada. Trocas possuem semântica de duas pontas e pertencem à frente
 * própria de swap-router; markVacant pode desativar múltiplas alocações sem
 * um único destinatário canônico e também fica fora deste módulo.
 */
export const ASSIGNMENT_SHADOW_OPERATIONS = [
  "DIRECT_ASSIGNMENT",
  "DIRECT_REMOVAL",
  "SUBSTITUTION_ASSIGNMENT",
  "SUBSTITUTION_REMOVAL",
] as const;

export type AssignmentShadowOperation =
  (typeof ASSIGNMENT_SHADOW_OPERATIONS)[number];

type AssignmentShadowAction = "ASSIGN" | "REMOVE";

/**
 * O contrato fechado dos fatos de assignment representa somente a transição
 * operacional de um titular OCUPADO. Linhas PENDENTE ou estados legados
 * continuam removíveis pelos fluxos existentes, porém não podem ser
 * reinterpretadas como uma retirada de plantão confirmado.
 */
export function isAssignmentStatusEligibleForShadow(status: string): boolean {
  return status === "OCUPADO";
}

type AssignmentShadowOperationContract = {
  eventType: OperationalEventType;
  action: AssignmentShadowAction;
  expectedIsActive: boolean;
  transition: { from: "NONE" | "ASSIGNED"; to: "ASSIGNED" | "REMOVED" };
};

const ASSIGNMENT_SHADOW_OPERATION_CONTRACTS = {
  DIRECT_ASSIGNMENT: {
    eventType: "ASSIGNMENT_DIRECT_ASSIGNED",
    action: "ASSIGN",
    expectedIsActive: true,
    transition: { from: "NONE", to: "ASSIGNED" },
  },
  DIRECT_REMOVAL: {
    eventType: "ASSIGNMENT_DIRECT_REMOVED",
    action: "REMOVE",
    expectedIsActive: false,
    transition: { from: "ASSIGNED", to: "REMOVED" },
  },
  SUBSTITUTION_ASSIGNMENT: {
    eventType: "ASSIGNMENT_SUBSTITUTION_ASSIGNED",
    action: "ASSIGN",
    expectedIsActive: true,
    transition: { from: "NONE", to: "ASSIGNED" },
  },
  SUBSTITUTION_REMOVAL: {
    eventType: "ASSIGNMENT_SUBSTITUTION_REMOVED",
    action: "REMOVE",
    expectedIsActive: false,
    transition: { from: "ASSIGNED", to: "REMOVED" },
  },
} as const satisfies Record<
  AssignmentShadowOperation,
  AssignmentShadowOperationContract
>;

export type AssignmentShadowContext = Readonly<{
  institutionId: number;
  hospitalId: number;
  sectorId: number;
  scheduleContextId: number | null;
  shiftInstanceId: number;
  assignmentId: number;
}>;

export type CapturedAssignmentShadowRecipient = Readonly<{
  context: AssignmentShadowContext;
  professionalId: number;
  userId: number;
  operationalRevision: number;
  assignmentStatus: string;
  isActive: boolean;
}>;

export type AssignmentShadowActor = Readonly<{
  userId: number;
  professionalId: number;
}>;

type OperationalUserActor = Extract<OperationalEventActor, { kind: "USER" }>;

function assertPositiveId(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new OperationalEventValidationError(
      `${label} deve ser um ID positivo`,
    );
  }
}

function assertAssignmentShadowContext(context: AssignmentShadowContext): void {
  assertPositiveId(context.institutionId, "institutionId");
  assertPositiveId(context.hospitalId, "hospitalId");
  assertPositiveId(context.sectorId, "sectorId");
  assertPositiveId(context.shiftInstanceId, "shiftInstanceId");
  assertPositiveId(context.assignmentId, "assignmentId");
  if (context.scheduleContextId !== null) {
    assertPositiveId(context.scheduleContextId, "scheduleContextId");
  }
}

function sameAssignmentShadowContext(
  left: AssignmentShadowContext,
  right: AssignmentShadowContext,
): boolean {
  return (
    left.institutionId === right.institutionId &&
    left.hospitalId === right.hospitalId &&
    left.sectorId === right.sectorId &&
    left.scheduleContextId === right.scheduleContextId &&
    left.shiftInstanceId === right.shiftInstanceId &&
    left.assignmentId === right.assignmentId
  );
}

export function assignmentShadowIdempotencyKey(input: {
  operation: AssignmentShadowOperation;
  assignmentId: number;
  operationalRevision: number;
}): string {
  const contract = ASSIGNMENT_SHADOW_OPERATION_CONTRACTS[input.operation];
  if (!contract) {
    throw new OperationalEventValidationError(
      "Operação SHADOW de assignment inválida",
    );
  }
  assertPositiveId(input.assignmentId, "assignmentId");
  if (
    !Number.isSafeInteger(input.operationalRevision) ||
    input.operationalRevision <= 0
  ) {
    throw new OperationalEventValidationError(
      "operationalRevision deve ser uma revisão positiva",
    );
  }
  return [
    "assignment-shadow",
    `revision:${input.operationalRevision}`,
    `operation:${input.operation}`,
    `assignment:${input.assignmentId}`,
    `action:${contract.action}`,
  ].join(":");
}

/**
 * Lê sob lock o usuário canônico do profissional atualmente associado à
 * alocação. Em remoções, o writer deve chamar esta função antes do UPDATE que
 * desativa a linha e passar o snapshot à gravação do fato posterior.
 */
export async function captureCanonicalAssignmentShadowRecipient(
  tx: OperationalEventTx,
  context: AssignmentShadowContext,
): Promise<CapturedAssignmentShadowRecipient> {
  assertAssignmentShadowContext(context);
  const scheduleContextPredicate =
    context.scheduleContextId === null
      ? isNull(shiftInstances.scheduleContextId)
      : eq(shiftInstances.scheduleContextId, context.scheduleContextId);
  const [assignment] = await tx
    .select({
      assignmentId: shiftAssignmentsV2.id,
      professionalId: shiftAssignmentsV2.professionalId,
      userId: professionals.userId,
      operationalRevision: shiftAssignmentsV2.operationalRevision,
      assignmentStatus: shiftAssignmentsV2.status,
      isActive: shiftAssignmentsV2.isActive,
      institutionId: shiftAssignmentsV2.institutionId,
      hospitalId: shiftAssignmentsV2.hospitalId,
      sectorId: shiftAssignmentsV2.sectorId,
      shiftInstanceId: shiftAssignmentsV2.shiftInstanceId,
      scheduleContextId: shiftInstances.scheduleContextId,
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
    .where(
      and(
        eq(shiftAssignmentsV2.id, context.assignmentId),
        eq(shiftAssignmentsV2.institutionId, context.institutionId),
        eq(shiftAssignmentsV2.hospitalId, context.hospitalId),
        eq(shiftAssignmentsV2.sectorId, context.sectorId),
        eq(shiftAssignmentsV2.shiftInstanceId, context.shiftInstanceId),
        eq(shiftInstances.id, context.shiftInstanceId),
        eq(shiftInstances.institutionId, context.institutionId),
        eq(shiftInstances.hospitalId, context.hospitalId),
        eq(shiftInstances.sectorId, context.sectorId),
        scheduleContextPredicate,
      ),
    )
    .limit(1)
    .for("update");
  if (!assignment) {
    throw new OperationalEventValidationError(
      "Alocação não pertence ao contexto canônico do evento SHADOW",
    );
  }
  if (
    !Number.isSafeInteger(assignment.operationalRevision) ||
    assignment.operationalRevision < 0
  ) {
    throw new OperationalEventValidationError(
      "Revisão operacional da alocação é inválida",
    );
  }
  return Object.freeze({
    context: Object.freeze({
      institutionId: assignment.institutionId,
      hospitalId: assignment.hospitalId,
      sectorId: assignment.sectorId,
      scheduleContextId: assignment.scheduleContextId,
      shiftInstanceId: assignment.shiftInstanceId,
      assignmentId: assignment.assignmentId,
    }),
    professionalId: assignment.professionalId,
    userId: assignment.userId,
    operationalRevision: assignment.operationalRevision,
    assignmentStatus: assignment.assignmentStatus,
    isActive: assignment.isActive,
  });
}

async function resolveCanonicalAssignmentShadowActor(
  tx: OperationalEventTx,
  input: AssignmentShadowActor & { institutionId: number },
): Promise<OperationalUserActor> {
  assertPositiveId(input.userId, "actor.userId");
  assertPositiveId(input.professionalId, "actor.professionalId");
  assertPositiveId(input.institutionId, "actor.institutionId");
  const [membership] = await tx
    .select({ roleInInstitution: professionalInstitutions.roleInInstitution })
    .from(professionalInstitutions)
    .where(
      and(
        eq(professionalInstitutions.userId, input.userId),
        eq(professionalInstitutions.professionalId, input.professionalId),
        eq(professionalInstitutions.institutionId, input.institutionId),
        eq(professionalInstitutions.active, true),
      ),
    )
    .limit(1)
    .for("update");
  if (!membership) {
    throw new OperationalEventValidationError(
      "Ator do evento SHADOW não possui vínculo institucional ativo",
    );
  }
  return {
    kind: "USER",
    userId: input.userId,
    professionalId: input.professionalId,
    role: membership.roleInInstitution,
  };
}

/**
 * Persiste somente fato e recipient canônicos. O modo é decidido pela
 * fundação e permanece SHADOW; este módulo não chama outbox, provider ou
 * transportador de e-mail/push.
 */
export async function recordAssignmentShadowEventInTransaction(
  tx: OperationalEventTx,
  input: {
    operation: AssignmentShadowOperation;
    capturedRecipient: CapturedAssignmentShadowRecipient;
    actor: AssignmentShadowActor;
  },
) {
  const contract = ASSIGNMENT_SHADOW_OPERATION_CONTRACTS[input.operation];
  if (!contract) {
    throw new OperationalEventValidationError(
      "Operação SHADOW de assignment inválida",
    );
  }
  const current = await captureCanonicalAssignmentShadowRecipient(
    tx,
    input.capturedRecipient.context,
  );
  if (
    !sameAssignmentShadowContext(
      current.context,
      input.capturedRecipient.context,
    ) ||
    current.professionalId !== input.capturedRecipient.professionalId ||
    current.userId !== input.capturedRecipient.userId
  ) {
    throw new OperationalEventValidationError(
      "Destinatário canônico da alocação mudou durante a emissão SHADOW",
    );
  }
  const expectedCurrentRevision =
    contract.action === "REMOVE"
      ? input.capturedRecipient.operationalRevision + 1
      : input.capturedRecipient.operationalRevision;
  if (
    !isAssignmentStatusEligibleForShadow(
      input.capturedRecipient.assignmentStatus,
    ) ||
    !input.capturedRecipient.isActive ||
    !isAssignmentStatusEligibleForShadow(current.assignmentStatus) ||
    current.isActive !== contract.expectedIsActive ||
    current.operationalRevision !== expectedCurrentRevision
  ) {
    throw new OperationalEventValidationError(
      "Snapshot ou revisão da alocação não representa a transição SHADOW",
    );
  }
  if (
    current.operationalRevision <= 0
  ) {
    throw new OperationalEventValidationError(
      "Estado ou revisão canônica da alocação não permite o evento SHADOW",
    );
  }
  const actor = await resolveCanonicalAssignmentShadowActor(tx, {
    ...input.actor,
    institutionId: current.context.institutionId,
  });
  return createOperationalEventInTransaction(tx, {
    idempotencyKey: assignmentShadowIdempotencyKey({
      operation: input.operation,
      assignmentId: current.context.assignmentId,
      operationalRevision: current.operationalRevision,
    }),
    eventType: contract.eventType,
    deliveryPolicy: "NOTIFY",
    aggregate: {
      type: "SHIFT_ASSIGNMENT",
      id: current.context.assignmentId,
      version: current.operationalRevision,
    },
    transition: contract.transition,
    context: {
      institutionId: current.context.institutionId,
      hospitalId: current.context.hospitalId,
      scopeKind: "SECTOR",
      sectorId: current.context.sectorId,
      scheduleContextId: current.context.scheduleContextId,
      shiftInstanceId: current.context.shiftInstanceId,
      assignmentId: current.context.assignmentId,
    },
    actor,
    recipients: [
      {
        kind: "USER",
        userId: current.userId,
        channels: ["PUSH", "EMAIL"],
      },
    ],
  });
}

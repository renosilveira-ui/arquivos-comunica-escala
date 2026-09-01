import { and, eq, isNull } from "drizzle-orm";
import {
  professionalInstitutions,
  professionals,
  shiftAssignmentsV2,
  shiftInstances,
  users,
} from "../drizzle/schema";
import {
  createOperationalEventInTransaction,
  OperationalEventValidationError,
  type OperationalEventActor,
  type OperationalEventTx,
  type OperationalEventType,
} from "./operational-events";
import {
  canonicalVacancyRequestManagerUserIds,
  isCanonicalVacancyRequestRequesterDeliverable,
  resolveCanonicalVacancyRequestManagers,
} from "./vacancy-request-recipients";

/**
 * Fatos fechados do fluxo `assumeVacancy` / decisão gerencial. A solicitação
 * é representada pela própria linha PENDENTE de `shift_assignments_v2`; não
 * existe uma segunda entidade textual ou um destinatário fornecido pelo app.
 */
export const VACANCY_REQUEST_SHADOW_OPERATIONS = [
  "REQUESTED",
  "APPROVED",
  "REJECTED",
] as const;

export type VacancyRequestShadowOperation =
  (typeof VACANCY_REQUEST_SHADOW_OPERATIONS)[number];

type VacancyRequestShadowAction = "REQUEST" | "APPROVE" | "REJECT";

/**
 * A decisão de uma solicitação pendente legada não deve ser desfeita apenas
 * porque a identidade histórica do solicitante não é demonstrável. O writer
 * de decisão trata este motivo de modo auditado e sem fato operacional; o
 * writer direto continua fail-closed.
 */
export const LEGACY_REQUESTER_IDENTITY_UNPROVEN =
  "LEGACY_REQUESTER_IDENTITY_UNPROVEN" as const;

export class VacancyRequesterIdentityUnprovenError extends OperationalEventValidationError {
  readonly reason = LEGACY_REQUESTER_IDENTITY_UNPROVEN;

  constructor() {
    super("Solicitação de vaga sem solicitante canônico");
    this.name = "VacancyRequesterIdentityUnprovenError";
  }
}

export function isVacancyRequesterIdentityUnproven(
  error: unknown,
): error is VacancyRequesterIdentityUnprovenError {
  return error instanceof VacancyRequesterIdentityUnprovenError;
}

type VacancyRequestShadowOperationContract = {
  eventType: OperationalEventType;
  action: VacancyRequestShadowAction;
  expectedCurrent: { assignmentStatus: string; isActive: boolean };
  transition: {
    from: "NONE" | "PENDING";
    to: "PENDING" | "APPROVED" | "REJECTED";
  };
  recipientKind: "RESPONSIBLE_MANAGERS" | "REQUESTER";
};

const VACANCY_REQUEST_SHADOW_OPERATION_CONTRACTS = {
  REQUESTED: {
    eventType: "VACANCY_REQUESTED",
    action: "REQUEST",
    expectedCurrent: { assignmentStatus: "PENDENTE", isActive: true },
    transition: { from: "NONE", to: "PENDING" },
    recipientKind: "RESPONSIBLE_MANAGERS",
  },
  APPROVED: {
    eventType: "ASSIGNMENT_APPROVED",
    action: "APPROVE",
    expectedCurrent: { assignmentStatus: "OCUPADO", isActive: true },
    transition: { from: "PENDING", to: "APPROVED" },
    recipientKind: "REQUESTER",
  },
  REJECTED: {
    eventType: "ASSIGNMENT_REJECTED",
    action: "REJECT",
    expectedCurrent: { assignmentStatus: "REJEITADO", isActive: false },
    transition: { from: "PENDING", to: "REJECTED" },
    recipientKind: "REQUESTER",
  },
} as const satisfies Record<
  VacancyRequestShadowOperation,
  VacancyRequestShadowOperationContract
>;

export type VacancyRequestShadowContext = Readonly<{
  institutionId: number;
  hospitalId: number;
  sectorId: number;
  scheduleContextId: number | null;
  shiftInstanceId: number;
  assignmentId: number;
}>;

export type CapturedVacancyRequest = Readonly<{
  context: VacancyRequestShadowContext;
  professionalId: number;
  requesterUserId: number;
  operationalRevision: number;
  assignmentStatus: string;
  isActive: boolean;
}>;

export type VacancyDecisionRequestCapture =
  | Readonly<{
      kind: "CANONICAL";
      capturedRequest: CapturedVacancyRequest;
    }>
  | Readonly<{
      kind: typeof LEGACY_REQUESTER_IDENTITY_UNPROVEN;
    }>;

/**
 * A única tolerância de decisão para dado histórico sem prova de identidade.
 * O callback mantém a captura canônica no mesmo `tx`; qualquer falha que não
 * seja a identidade tipada é propagada e aborta a transação.
 */
export async function captureVacancyRequestForDecisionOrLegacyAudit(
  capture: () => Promise<CapturedVacancyRequest>,
): Promise<VacancyDecisionRequestCapture> {
  try {
    return { kind: "CANONICAL", capturedRequest: await capture() };
  } catch (error) {
    if (isVacancyRequesterIdentityUnproven(error)) {
      return { kind: LEGACY_REQUESTER_IDENTITY_UNPROVEN };
    }
    throw error;
  }
}

export type VacancyRequestShadowActor = Readonly<{
  userId: number;
  professionalId: number;
}>;

type OperationalUserActor = Extract<OperationalEventActor, { kind: "USER" }>;

function assertPositiveId(value: unknown, label: string): void {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new OperationalEventValidationError(
      `${label} deve ser um ID positivo`,
    );
  }
}

function canonicalRequesterUserId(
  createdByUserId: unknown,
  requesterUserId: unknown,
): number {
  if (
    typeof createdByUserId !== "number" ||
    !Number.isSafeInteger(createdByUserId) ||
    createdByUserId <= 0 ||
    typeof requesterUserId !== "number" ||
    !Number.isSafeInteger(requesterUserId) ||
    requesterUserId <= 0 ||
    createdByUserId !== requesterUserId
  ) {
    throw new VacancyRequesterIdentityUnprovenError();
  }
  return requesterUserId;
}

function assertVacancyRequestShadowContext(
  context: VacancyRequestShadowContext,
): void {
  assertPositiveId(context.institutionId, "institutionId");
  assertPositiveId(context.hospitalId, "hospitalId");
  assertPositiveId(context.sectorId, "sectorId");
  assertPositiveId(context.shiftInstanceId, "shiftInstanceId");
  assertPositiveId(context.assignmentId, "assignmentId");
  if (context.scheduleContextId !== null) {
    assertPositiveId(context.scheduleContextId, "scheduleContextId");
  }
}

function sameVacancyRequestShadowContext(
  left: VacancyRequestShadowContext,
  right: VacancyRequestShadowContext,
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

export function vacancyRequestShadowIdempotencyKey(input: {
  operation: VacancyRequestShadowOperation;
  assignmentId: number;
  operationalRevision: number;
}): string {
  const contract = VACANCY_REQUEST_SHADOW_OPERATION_CONTRACTS[input.operation];
  if (!contract) {
    throw new OperationalEventValidationError(
      "Operação SHADOW de solicitação de vaga inválida",
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
    "vacancy-request-shadow",
    `revision:${input.operationalRevision}`,
    `operation:${input.operation}`,
    `assignment:${input.assignmentId}`,
    `action:${contract.action}`,
  ].join(":");
}

/**
 * Captura sob lock a identidade do solicitante. `created_by` precisa apontar
 * para o mesmo usuário do profissional da alocação. Identidade e
 * entregabilidade são deliberadamente distintas: a revogação posterior do
 * solicitante não invalida uma decisão gerencial já autorizada.
 */
export async function captureCanonicalVacancyRequest(
  tx: OperationalEventTx,
  context: VacancyRequestShadowContext,
): Promise<CapturedVacancyRequest> {
  assertVacancyRequestShadowContext(context);
  const scheduleContextPredicate =
    context.scheduleContextId === null
      ? isNull(shiftInstances.scheduleContextId)
      : eq(shiftInstances.scheduleContextId, context.scheduleContextId);
  const [assignment] = await tx
    .select({
      assignmentId: shiftAssignmentsV2.id,
      professionalId: shiftAssignmentsV2.professionalId,
      createdByUserId: shiftAssignmentsV2.createdBy,
      requesterUserId: professionals.userId,
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
      "Solicitação de vaga sem identidade canônica no contexto informado",
    );
  }
  const requesterUserId = canonicalRequesterUserId(
    assignment.createdByUserId,
    assignment.requesterUserId,
  );
  if (
    !Number.isSafeInteger(assignment.operationalRevision) ||
    assignment.operationalRevision < 0
  ) {
    throw new OperationalEventValidationError(
      "Revisão operacional da solicitação de vaga é inválida",
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
    requesterUserId,
    operationalRevision: assignment.operationalRevision,
    assignmentStatus: assignment.assignmentStatus,
    isActive: assignment.isActive,
  });
}

async function resolveCanonicalVacancyRequestActor(
  tx: OperationalEventTx,
  input: VacancyRequestShadowActor & { institutionId: number },
): Promise<OperationalUserActor> {
  assertPositiveId(input.userId, "actor.userId");
  assertPositiveId(input.professionalId, "actor.professionalId");
  assertPositiveId(input.institutionId, "actor.institutionId");
  const [membership] = await tx
    .select({ roleInInstitution: professionalInstitutions.roleInInstitution })
    .from(professionalInstitutions)
    .innerJoin(
      professionals,
      and(
        eq(professionals.id, professionalInstitutions.professionalId),
        eq(professionals.userId, professionalInstitutions.userId),
      ),
    )
    .innerJoin(
      users,
      and(
        eq(users.id, professionalInstitutions.userId),
        eq(users.approvalStatus, "APPROVED"),
        isNull(users.deletedAt),
      ),
    )
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
      "Ator da solicitação de vaga não possui vínculo institucional ativo",
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
 * O snapshot anterior só é aceito quando prova exatamente a transição. Para
 * aprovar/rejeitar, a revisão atual deve ser a anterior + 1, obtida pelo CAS
 * no writer. Para criar, a nova linha já nasce em revisão 1.
 */
function assertCapturedVacancyRequestTransition(
  operation: VacancyRequestShadowOperation,
  captured: CapturedVacancyRequest,
  current: CapturedVacancyRequest,
): void {
  const contract = VACANCY_REQUEST_SHADOW_OPERATION_CONTRACTS[operation];
  if (
    !sameVacancyRequestShadowContext(current.context, captured.context) ||
    current.professionalId !== captured.professionalId ||
    current.requesterUserId !== captured.requesterUserId
  ) {
    throw new OperationalEventValidationError(
      "Solicitante canônico mudou durante a emissão SHADOW",
    );
  }

  const isNewRequest = operation === "REQUESTED";
  const expectedCurrentRevision = isNewRequest
    ? 1
    : captured.operationalRevision + 1;
  if (
    captured.assignmentStatus !== "PENDENTE" ||
    !captured.isActive ||
    (isNewRequest && captured.operationalRevision !== 1) ||
    current.assignmentStatus !== contract.expectedCurrent.assignmentStatus ||
    current.isActive !== contract.expectedCurrent.isActive ||
    current.operationalRevision !== expectedCurrentRevision ||
    current.operationalRevision <= 0
  ) {
    throw new OperationalEventValidationError(
      "Snapshot ou revisão não representa a transição da solicitação de vaga",
    );
  }
}

/**
 * Persiste somente o fato canônico e seus destinatários por ID. O catálogo
 * decide SHADOW; este módulo não chama outbox legado, push, e-mail,
 * agendador ou provedor externo.
 */
export async function recordVacancyRequestShadowEventInTransaction(
  tx: OperationalEventTx,
  input: {
    operation: VacancyRequestShadowOperation;
    capturedRequest: CapturedVacancyRequest;
    actor: VacancyRequestShadowActor;
  },
) {
  const contract = VACANCY_REQUEST_SHADOW_OPERATION_CONTRACTS[input.operation];
  if (!contract) {
    throw new OperationalEventValidationError(
      "Operação SHADOW de solicitação de vaga inválida",
    );
  }
  const current = await captureCanonicalVacancyRequest(
    tx,
    input.capturedRequest.context,
  );
  assertCapturedVacancyRequestTransition(
    input.operation,
    input.capturedRequest,
    current,
  );
  const actor = await resolveCanonicalVacancyRequestActor(tx, {
    ...input.actor,
    institutionId: current.context.institutionId,
  });

  const responsibleManagerUserIds =
    contract.recipientKind === "RESPONSIBLE_MANAGERS"
      ? canonicalVacancyRequestManagerUserIds(
          await resolveCanonicalVacancyRequestManagers(tx, current.context),
        )
      : [];
  const managerUserIds = responsibleManagerUserIds.filter(
    (userId) => userId !== actor.userId,
  );
  const requesterDeliverable =
    contract.recipientKind === "REQUESTER"
      ? await isCanonicalVacancyRequestRequesterDeliverable(tx, {
          institutionId: current.context.institutionId,
          professionalId: current.professionalId,
          userId: current.requesterUserId,
        })
      : false;
  const recipients =
    contract.recipientKind === "RESPONSIBLE_MANAGERS"
      ? managerUserIds.map((userId) => ({
          kind: "USER" as const,
          userId,
          channels: ["PUSH", "EMAIL"] as const,
        }))
      : requesterDeliverable
        ? [
            {
              kind: "USER" as const,
              userId: current.requesterUserId,
              channels: ["PUSH", "EMAIL"] as const,
            },
          ]
        : [];

  return createOperationalEventInTransaction(tx, {
    idempotencyKey: vacancyRequestShadowIdempotencyKey({
      operation: input.operation,
      assignmentId: current.context.assignmentId,
      operationalRevision: current.operationalRevision,
    }),
    eventType: contract.eventType,
    deliveryPolicy: "NOTIFY",
    aggregate: {
      type: "VACANCY_REQUEST",
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
    recipients,
    recipientResolution:
      contract.recipientKind === "RESPONSIBLE_MANAGERS"
        ? managerUserIds.length === 0
          ? responsibleManagerUserIds.length === 0
            ? "NO_RESPONSIBLE_MANAGERS"
            : "NO_DELIVERABLE_RECIPIENTS"
          : "RESOLVED"
        : requesterDeliverable
          ? "RESOLVED"
          : "NO_DELIVERABLE_RECIPIENTS",
  });
}

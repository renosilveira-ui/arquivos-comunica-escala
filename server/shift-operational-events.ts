import { and, asc, eq, inArray, isNull } from "drizzle-orm";
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
  type CreateOperationalEventInput,
  type OperationalEventTx,
} from "./operational-events";
import type { ShiftInstanceRevisionPatch } from "./shift-instance-revision";

export type ShiftUpdatedShadowContext = Readonly<{
  institutionId: number;
  hospitalId: number;
  sectorId: number;
  scheduleContextId: number | null;
  shiftInstanceId: number;
}>;

export type ShiftUpdatedShadowSnapshot = Readonly<{
  startAt: Date;
  endAt: Date;
  modality: "PLANTAO" | "SOBREAVISO";
}>;

type ShiftOperationalRevisionSource = Pick<
  typeof shiftInstances.$inferSelect,
  | "startAt"
  | "endAt"
  | "modality"
  | "coverageType"
  | "paymentModel"
  | "productivityCapBrl"
>;

export type ShiftUpdatedShadowActor = Readonly<{
  userId: number;
  professionalId: number | null;
  role: "USER" | "GESTOR_MEDICO" | "GESTOR_PLUS";
}>;

type ShiftUpdatedRecipientResolution = Readonly<{
  recipientUserIds: readonly number[];
  recipientResolution:
    "RESOLVED" | "NO_ELIGIBLE_RECIPIENTS" | "NO_DELIVERABLE_RECIPIENTS";
}>;

export type CanonicalShiftUpdatedRecipientRow = Readonly<{
  assignmentId: number;
  assignmentShiftInstanceId: number;
  assignmentInstitutionId: number;
  assignmentHospitalId: number;
  assignmentSectorId: number;
  assignmentProfessionalId: number;
  assignmentIsActive: boolean;
  assignmentStatus: string;
  professionalId: number;
  professionalUserId: number;
  membershipProfessionalId: number;
  membershipUserId: number;
  membershipInstitutionId: number;
  membershipActive: boolean;
  userId: number;
  userApprovalStatus: string;
  userDeletedAt: Date | null;
}>;

function assertPositiveId(
  value: unknown,
  label: string,
): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new OperationalEventValidationError(
      `${label} deve ser um ID positivo`,
    );
  }
}

function isPositiveId(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function assertNonNegativeRevision(
  value: unknown,
  label: string,
): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new OperationalEventValidationError(
      `${label} deve ser uma revisão operacional válida`,
    );
  }
}

function assertValidSnapshot(
  snapshot: ShiftUpdatedShadowSnapshot,
  label: string,
): void {
  if (
    !(snapshot.startAt instanceof Date) ||
    !Number.isFinite(snapshot.startAt.getTime()) ||
    !(snapshot.endAt instanceof Date) ||
    !Number.isFinite(snapshot.endAt.getTime()) ||
    (snapshot.modality !== "PLANTAO" && snapshot.modality !== "SOBREAVISO")
  ) {
    throw new OperationalEventValidationError(`${label} do turno é inválido`);
  }
}

function assertContext(context: ShiftUpdatedShadowContext): void {
  assertPositiveId(context.institutionId, "institutionId");
  assertPositiveId(context.hospitalId, "hospitalId");
  assertPositiveId(context.sectorId, "sectorId");
  assertPositiveId(context.shiftInstanceId, "shiftInstanceId");
  if (context.scheduleContextId !== null) {
    assertPositiveId(context.scheduleContextId, "scheduleContextId");
  }
}

/**
 * O fato não representa qualquer edição administrativa: somente mudanças que
 * alteram o compromisso operacional do médico (horário ou modalidade).
 */
export function hasMaterialShiftUpdatedChange(
  previous: ShiftUpdatedShadowSnapshot,
  next: ShiftUpdatedShadowSnapshot,
): boolean {
  assertValidSnapshot(previous, "Snapshot anterior");
  assertValidSnapshot(next, "Snapshot atual");
  return (
    previous.startAt.getTime() !== next.startAt.getTime() ||
    previous.endAt.getTime() !== next.endAt.getTime() ||
    previous.modality !== next.modality
  );
}

/**
 * Mantém a regra de CAS separada do fato: campos administrativos ainda podem
 * avançar a revisão do agregado, mas só horário/modalidade habilitam
 * SHIFT_UPDATED. Quando nada mudou, o writer recebe um patch vazio e não
 * chama o CAS.
 */
export function planShiftOperationalRevision(
  previous: ShiftOperationalRevisionSource,
  patch: ShiftInstanceRevisionPatch,
): ShiftInstanceRevisionPatch {
  const revisionPatch: ShiftInstanceRevisionPatch = {};
  if (
    patch.startAt !== undefined &&
    patch.startAt.getTime() !== previous.startAt.getTime()
  ) {
    revisionPatch.startAt = patch.startAt;
  }
  if (
    patch.endAt !== undefined &&
    patch.endAt.getTime() !== previous.endAt.getTime()
  ) {
    revisionPatch.endAt = patch.endAt;
  }
  if (patch.modality !== undefined && patch.modality !== previous.modality) {
    revisionPatch.modality = patch.modality;
  }
  if (
    patch.coverageType !== undefined &&
    patch.coverageType !== previous.coverageType
  ) {
    revisionPatch.coverageType = patch.coverageType;
  }
  if (
    patch.paymentModel !== undefined &&
    patch.paymentModel !== previous.paymentModel
  ) {
    revisionPatch.paymentModel = patch.paymentModel;
  }
  if (
    patch.productivityCapBrl !== undefined &&
    patch.productivityCapBrl !== previous.productivityCapBrl
  ) {
    revisionPatch.productivityCapBrl = patch.productivityCapBrl;
  }

  return revisionPatch;
}

/** A mesma revisão operacional de um turno só pode originar um fato. */
export function shiftUpdatedShadowIdempotencyKey(input: {
  shiftInstanceId: number;
  operationalRevision: number;
}): string {
  assertPositiveId(input.shiftInstanceId, "shiftInstanceId");
  if (
    !Number.isSafeInteger(input.operationalRevision) ||
    input.operationalRevision <= 0
  ) {
    throw new OperationalEventValidationError(
      "operationalRevision deve ser uma revisão positiva",
    );
  }
  return `shift-updated:shift:${input.shiftInstanceId}:revision:${input.operationalRevision}:event:SHIFT_UPDATED`;
}

export function buildShiftUpdatedShadowEventInput(input: {
  context: ShiftUpdatedShadowContext;
  operationalRevision: number;
  actor: ShiftUpdatedShadowActor;
  recipientUserIds: readonly number[];
  recipientResolution: ShiftUpdatedRecipientResolution["recipientResolution"];
}): CreateOperationalEventInput {
  assertContext(input.context);
  if (
    !Number.isSafeInteger(input.operationalRevision) ||
    input.operationalRevision <= 0
  ) {
    throw new OperationalEventValidationError(
      "operationalRevision deve ser uma revisão positiva",
    );
  }
  assertPositiveId(input.actor.userId, "actor.userId");
  if (input.actor.professionalId !== null) {
    assertPositiveId(input.actor.professionalId, "actor.professionalId");
  }
  const recipientUserIds = [...new Set(input.recipientUserIds)];
  for (const userId of recipientUserIds) {
    assertPositiveId(userId, "recipientUserId");
  }
  recipientUserIds.sort((left, right) => left - right);

  return {
    idempotencyKey: shiftUpdatedShadowIdempotencyKey({
      shiftInstanceId: input.context.shiftInstanceId,
      operationalRevision: input.operationalRevision,
    }),
    eventType: "SHIFT_UPDATED",
    deliveryPolicy: "NOTIFY",
    aggregate: {
      type: "SHIFT_INSTANCE",
      id: input.context.shiftInstanceId,
      version: input.operationalRevision,
    },
    transition: { from: null, to: null },
    context: {
      institutionId: input.context.institutionId,
      hospitalId: input.context.hospitalId,
      scopeKind: "SECTOR",
      sectorId: input.context.sectorId,
      scheduleContextId: input.context.scheduleContextId,
      shiftInstanceId: input.context.shiftInstanceId,
    },
    actor: {
      kind: "USER",
      userId: input.actor.userId,
      professionalId: input.actor.professionalId,
      role: input.actor.role,
    },
    recipients: recipientUserIds.map((userId) => ({
      kind: "USER" as const,
      userId,
      channels: ["PUSH", "EMAIL"] as const,
    })),
    recipientResolution: input.recipientResolution,
  };
}

async function lockCanonicalUpdatedShift(
  tx: OperationalEventTx,
  input: {
    context: ShiftUpdatedShadowContext;
    previousOperationalRevision: number;
    nextOperationalRevision: number;
  },
): Promise<ShiftUpdatedShadowSnapshot> {
  const [shift] = await tx
    .select({
      id: shiftInstances.id,
      institutionId: shiftInstances.institutionId,
      hospitalId: shiftInstances.hospitalId,
      sectorId: shiftInstances.sectorId,
      scheduleContextId: shiftInstances.scheduleContextId,
      operationalRevision: shiftInstances.operationalRevision,
      startAt: shiftInstances.startAt,
      endAt: shiftInstances.endAt,
      modality: shiftInstances.modality,
    })
    .from(shiftInstances)
    .where(
      and(
        eq(shiftInstances.id, input.context.shiftInstanceId),
        eq(shiftInstances.institutionId, input.context.institutionId),
        eq(shiftInstances.hospitalId, input.context.hospitalId),
        eq(shiftInstances.sectorId, input.context.sectorId),
      ),
    )
    .limit(1)
    .for("update");

  if (
    !shift ||
    shift.id !== input.context.shiftInstanceId ||
    shift.institutionId !== input.context.institutionId ||
    shift.hospitalId !== input.context.hospitalId ||
    shift.sectorId !== input.context.sectorId ||
    shift.scheduleContextId !== input.context.scheduleContextId ||
    shift.operationalRevision !== input.nextOperationalRevision ||
    input.nextOperationalRevision !== input.previousOperationalRevision + 1
  ) {
    throw new OperationalEventValidationError(
      "Turno ou revisão canônica diverge da atualização operacional",
    );
  }

  const snapshot = {
    startAt: shift.startAt,
    endAt: shift.endAt,
    modality: shift.modality,
  } satisfies ShiftUpdatedShadowSnapshot;
  assertValidSnapshot(snapshot, "Snapshot canônico");
  return snapshot;
}

async function resolveShiftUpdatedRecipients(
  tx: OperationalEventTx,
  context: ShiftUpdatedShadowContext,
): Promise<ShiftUpdatedRecipientResolution> {
  // Primeiro travamos exatamente as alocações afetadas. PENDENTE e linhas
  // inativas não entram na relação de médicos que já têm compromisso firmado.
  const occupiedAssignments = await tx
    .select({
      id: shiftAssignmentsV2.id,
      isActive: shiftAssignmentsV2.isActive,
      status: shiftAssignmentsV2.status,
    })
    .from(shiftAssignmentsV2)
    .where(
      and(
        eq(shiftAssignmentsV2.shiftInstanceId, context.shiftInstanceId),
        eq(shiftAssignmentsV2.institutionId, context.institutionId),
        eq(shiftAssignmentsV2.hospitalId, context.hospitalId),
        eq(shiftAssignmentsV2.sectorId, context.sectorId),
        eq(shiftAssignmentsV2.isActive, true),
        eq(shiftAssignmentsV2.status, "OCUPADO"),
      ),
    )
    .orderBy(asc(shiftAssignmentsV2.id))
    .for("update");

  // O predicado SQL já restringe ao conjunto correto; a filtragem repetida
  // torna o contrato explícito e evita reinterpretar uma linha inesperada
  // como destinatário se a consulta for alterada no futuro.
  const confirmedAssignments = occupiedAssignments.filter(
    (assignment) => assignment.isActive && assignment.status === "OCUPADO",
  );
  if (confirmedAssignments.length === 0) {
    return {
      recipientUserIds: [],
      recipientResolution: "NO_ELIGIBLE_RECIPIENTS",
    };
  }

  const occupiedAssignmentIds = confirmedAssignments.map(
    (assignment) => assignment.id,
  );
  const recipientRows = await tx
    .select({
      assignmentId: shiftAssignmentsV2.id,
      assignmentShiftInstanceId: shiftAssignmentsV2.shiftInstanceId,
      assignmentInstitutionId: shiftAssignmentsV2.institutionId,
      assignmentHospitalId: shiftAssignmentsV2.hospitalId,
      assignmentSectorId: shiftAssignmentsV2.sectorId,
      assignmentProfessionalId: shiftAssignmentsV2.professionalId,
      assignmentIsActive: shiftAssignmentsV2.isActive,
      assignmentStatus: shiftAssignmentsV2.status,
      professionalId: professionals.id,
      professionalUserId: professionals.userId,
      membershipProfessionalId: professionalInstitutions.professionalId,
      membershipUserId: professionalInstitutions.userId,
      membershipInstitutionId: professionalInstitutions.institutionId,
      membershipActive: professionalInstitutions.active,
      userId: users.id,
      userApprovalStatus: users.approvalStatus,
      userDeletedAt: users.deletedAt,
    })
    .from(shiftAssignmentsV2)
    .innerJoin(
      professionals,
      eq(professionals.id, shiftAssignmentsV2.professionalId),
    )
    .innerJoin(
      professionalInstitutions,
      and(
        eq(professionalInstitutions.professionalId, professionals.id),
        eq(professionalInstitutions.userId, professionals.userId),
        eq(professionalInstitutions.institutionId, context.institutionId),
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
        eq(shiftAssignmentsV2.shiftInstanceId, context.shiftInstanceId),
        eq(shiftAssignmentsV2.institutionId, context.institutionId),
        eq(shiftAssignmentsV2.hospitalId, context.hospitalId),
        eq(shiftAssignmentsV2.sectorId, context.sectorId),
        eq(shiftAssignmentsV2.isActive, true),
        eq(shiftAssignmentsV2.status, "OCUPADO"),
        inArray(shiftAssignmentsV2.id, occupiedAssignmentIds),
      ),
    )
    .orderBy(asc(users.id))
    .for("update");

  const recipientUserIds = canonicalizeShiftUpdatedRecipientUserIds({
    context,
    confirmedAssignmentIds: occupiedAssignmentIds,
    rows: recipientRows,
  });

  return {
    recipientUserIds,
    recipientResolution:
      recipientUserIds.length > 0 ? "RESOLVED" : "NO_DELIVERABLE_RECIPIENTS",
  };
}

/**
 * Revalida a cadeia assignment → professional → PI → user após o JOIN. Isso
 * não substitui os predicados SQL: impede que uma futura alteração na consulta
 * transforme uma linha parcialmente ligada em destinatário válido.
 */
export function canonicalizeShiftUpdatedRecipientUserIds(input: {
  context: ShiftUpdatedShadowContext;
  confirmedAssignmentIds: readonly number[];
  rows: readonly CanonicalShiftUpdatedRecipientRow[];
}): readonly number[] {
  assertContext(input.context);
  const confirmedAssignmentIds = new Set(input.confirmedAssignmentIds);
  for (const assignmentId of confirmedAssignmentIds) {
    assertPositiveId(assignmentId, "confirmedAssignmentId");
  }

  return [
    ...new Set(
      input.rows
        .filter(
          (row) =>
            confirmedAssignmentIds.has(row.assignmentId) &&
            row.assignmentShiftInstanceId === input.context.shiftInstanceId &&
            row.assignmentInstitutionId === input.context.institutionId &&
            row.assignmentHospitalId === input.context.hospitalId &&
            row.assignmentSectorId === input.context.sectorId &&
            row.assignmentIsActive === true &&
            row.assignmentStatus === "OCUPADO" &&
            row.professionalId === row.assignmentProfessionalId &&
            row.professionalUserId === row.membershipUserId &&
            row.membershipProfessionalId === row.professionalId &&
            row.membershipInstitutionId === input.context.institutionId &&
            row.membershipActive === true &&
            row.userId === row.professionalUserId &&
            row.userApprovalStatus === "APPROVED" &&
            row.userDeletedAt === null &&
            isPositiveId(row.userId),
        )
        .map((row) => row.userId),
    ),
  ].sort((left, right) => left - right);
}

/**
 * Grava fato + recipients no mesmo commit do CAS. O catálogo mantém este
 * evento em SHADOW; portanto esta função nunca cria notification_deliveries,
 * não chama worker, push, e-mail ou fornecedor externo.
 */
export async function recordShiftUpdatedShadowEventInTransaction(
  tx: OperationalEventTx,
  input: {
    context: ShiftUpdatedShadowContext;
    previous: ShiftUpdatedShadowSnapshot & {
      operationalRevision: number;
    };
    nextOperationalRevision: number;
    actor: ShiftUpdatedShadowActor;
  },
) {
  assertContext(input.context);
  assertValidSnapshot(input.previous, "Snapshot anterior");
  assertNonNegativeRevision(
    input.previous.operationalRevision,
    "previous.operationalRevision",
  );
  assertPositiveId(input.actor.userId, "actor.userId");
  if (input.actor.professionalId !== null) {
    assertPositiveId(input.actor.professionalId, "actor.professionalId");
  }

  const current = await lockCanonicalUpdatedShift(tx, {
    context: input.context,
    previousOperationalRevision: input.previous.operationalRevision,
    nextOperationalRevision: input.nextOperationalRevision,
  });
  if (!hasMaterialShiftUpdatedChange(input.previous, current)) {
    throw new OperationalEventValidationError(
      "SHIFT_UPDATED exige mudança material de horário ou modalidade",
    );
  }

  const recipients = await resolveShiftUpdatedRecipients(tx, input.context);
  return createOperationalEventInTransaction(
    tx,
    buildShiftUpdatedShadowEventInput({
      context: input.context,
      operationalRevision: input.nextOperationalRevision,
      actor: input.actor,
      recipientUserIds: recipients.recipientUserIds,
      recipientResolution: recipients.recipientResolution,
    }),
  );
}

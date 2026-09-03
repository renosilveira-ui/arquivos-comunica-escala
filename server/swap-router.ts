import { z } from "zod";
import { router, protectedProcedure } from "./_core/trpc";
import { TRPCError } from "@trpc/server";
import { getDb } from "./db";
import { eq, and, sql, inArray } from "drizzle-orm";
import {
  swapRequests,
  swapRequestDismissals,
  shiftAssignmentsV2,
} from "../drizzle/schema";
import { recordAudit } from "./audit-trail";
import { recomputeShiftStatus } from "./shift-status";
import { enqueueComunicaSwapApproved } from "./integrations/comunica-plus";
import { enqueueDutySyncWithdrawsForRemovedProfessionals } from "./sso/duty-sync-lifecycle";
import {
  assertManagerScopeAccess,
  getTenantActorFromContext,
  type TenantActor,
} from "./_core/policy";
import {
  ASSIGNMENT_WRITE_TRANSACTION_CONFIG,
  assertAssignmentWritesAllowedForUpdate,
  lockAssignmentProfessionalsForUpdate,
  type AssignmentWriteCandidate,
} from "./shift-validations-v2";
import { dateFromExecute, rowsFromExecute } from "./_core/db-results";
import { listedOfferCanRespond } from "../lib/swap-offer-actions";
import {
  listAssumableScheduleContextIds,
  listAuthorizedScheduleContexts,
} from "./schedule-contexts";
import { plantonistaAccessCoversShiftSql } from "./plantonista-shift-eligibility";
import { enqueueSwapTakenSignals } from "./swap-offer-signal";
import type { TrpcContext } from "./_core/context";
import {
  assertPublishedSwapMonthsForUpdate,
  assertSameSwapSchedulingSnapshot,
  assertSwapShiftsNotStarted,
  auditNames,
  isOneWay,
  lockSwapAssignmentsForUpdate,
  lockSwapShiftsForUpdate,
  requireCanonicalAssignmentTuple,
  requireCanonicalProfessional,
  requireCanonicalShift,
  requireCanonicalShiftOccupant,
  requireCurrentListAvailableActor,
  requireProfessionalCanReceiveShift,
  StaleCanonicalAssignmentError,
  topologyDenied,
  type CanonicalAssignmentTuple,
  type CanonicalProfessional,
  type MonthLockTarget,
  type SwapRow,
  type SwapType,
} from "./swap-domain";
import { createSwapOffer } from "./swap-offer-create";

// ─── helpers ────────────────────────────────────────────────────────────────

type AvailableSwapRow = {
  id: number;
  type: SwapType;
  reason: string | null;
  expiresAt: Date | string | number | null;
  createdAt: Date | string | number;
  fromProfessionalName: string;
  fromProfessionalRole: string;
  fromShiftInstanceId: number;
  fromScheduleContextId: number;
  fromShiftLabel: string;
  fromShiftStartAt: Date | string | number;
  fromShiftEndAt: Date | string | number;
  fromHospitalName: string;
  fromSectorName: string;
  toShiftInstanceId: number | null;
  toShiftLabel: string | null;
  toShiftStartAt: Date | string | number | null;
  toShiftEndAt: Date | string | number | null;
  toHospitalName: string | null;
  toSectorName: string | null;
  toProfessionalId: number | string | null;
  toUserId: number | string | null;
};

function isOpenSwapOffer(
  swap: Pick<SwapRow, "toProfessionalId" | "toUserId">,
): boolean {
  return swap.toProfessionalId === null && swap.toUserId === null;
}

function isMysqlDuplicateKey(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  if (
    "code" in error &&
    (error as { code?: unknown }).code === "ER_DUP_ENTRY"
  ) {
    return true;
  }
  return (
    "cause" in error &&
    isMysqlDuplicateKey((error as { cause?: unknown }).cause)
  );
}

export function isExpectedSwapVisibilityDenial(error: unknown): boolean {
  return (
    error instanceof TRPCError &&
    (error.code === "FORBIDDEN" ||
      error.code === "NOT_FOUND" ||
      // Oferta histórica cuja alocação de origem já não está ativa: é sinal
      // de visibilidade (leitura), nunca deve derrubar a lista inteira. A
      // escrita não usa este classificador e segue com CONFLICT fail-closed.
      error.cause instanceof StaleCanonicalAssignmentError)
  );
}

function assertSwapShape(swap: SwapRow): void {
  const hasToProfessional = swap.toProfessionalId !== null;
  const hasToUser = swap.toUserId !== null;
  if (hasToProfessional !== hasToUser) {
    throw topologyDenied("Solicitação com identidade destinatária incompleta");
  }
  if (isOneWay(swap.type)) {
    if (swap.toShiftInstanceId !== null || swap.toAssignmentId !== null) {
      throw topologyDenied(
        "Cessão/repasse não pode carregar turno ou alocação de contrapartida",
      );
    }
    return;
  }
  if (
    !swap.toShiftInstanceId ||
    swap.toShiftInstanceId === swap.fromShiftInstanceId
  ) {
    throw topologyDenied("Troca sem turno de contrapartida válido");
  }
  if (swap.status === "ACCEPTED" || swap.status === "APPROVED") {
    if (!swap.toProfessionalId || !swap.toUserId || !swap.toAssignmentId) {
      throw topologyDenied("Troca aceita sem tupla completa do receptor");
    }
  } else if (swap.status === "PENDING" && swap.toAssignmentId !== null) {
    throw topologyDenied(
      "Troca pendente não pode antecipar uma alocação receptora",
    );
  }
}

async function requireCanonicalSourceTuple(
  db: any,
  swap: SwapRow,
  options: { requireActive?: boolean; lockForUpdate?: boolean } = {},
): Promise<CanonicalAssignmentTuple> {
  assertSwapShape(swap);
  return requireCanonicalAssignmentTuple(db, {
    institutionId: swap.institutionId,
    hospitalId: swap.hospitalId,
    sectorId: swap.sectorId,
    shiftInstanceId: swap.fromShiftInstanceId,
    assignmentId: swap.fromAssignmentId,
    professionalId: swap.fromProfessionalId,
    userId: swap.fromUserId,
    requireActive: options.requireActive,
    lockForUpdate: options.lockForUpdate,
  });
}

async function requireCanonicalSwapRecipient(
  db: any,
  swap: SwapRow,
  source: CanonicalAssignmentTuple,
  input: {
    professionalId: number;
    userId: number;
    requireActiveAssignment?: boolean;
    lockForUpdate?: boolean;
    expectedSessionVersion?: number;
  },
): Promise<{
  professional: CanonicalProfessional;
  toTuple: CanonicalAssignmentTuple | null;
}> {
  const professional = await requireProfessionalCanReceiveShift(db, {
    institutionId: swap.institutionId,
    professionalId: input.professionalId,
    userId: input.userId,
    shift: source.shift,
    lockForUpdate: input.lockForUpdate,
    expectedSessionVersion: input.expectedSessionVersion,
  });
  if (isOneWay(swap.type)) return { professional, toTuple: null };
  if (!swap.toShiftInstanceId)
    throw topologyDenied("Troca sem turno de contrapartida");
  const toTuple = await requireCanonicalAssignmentTuple(db, {
    institutionId: swap.institutionId,
    shiftInstanceId: swap.toShiftInstanceId,
    assignmentId: swap.toAssignmentId ?? undefined,
    professionalId: input.professionalId,
    userId: input.userId,
    requireActive: input.requireActiveAssignment,
    lockForUpdate: input.lockForUpdate,
    expectedSessionVersion: input.expectedSessionVersion,
  });
  await requireProfessionalCanReceiveShift(db, {
    institutionId: swap.institutionId,
    professionalId: swap.fromProfessionalId,
    userId: swap.fromUserId,
    shift: toTuple.shift,
    lockForUpdate: input.lockForUpdate,
  });
  return { professional, toTuple };
}

/**
 * One-way handoff types (A → B without B giving anything back).
 * CESSAO is the spec-canonical name; TRANSFER is the legacy alias.
 * SWAP is the bidirectional case (A↔B).
 */

async function requireCurrentSwapOwner(
  tx: any,
  actor: TenantActor,
  swap: SwapRow,
  expectedSessionVersion?: number,
): Promise<{ professional: CanonicalProfessional; auditRole: string }> {
  if (!actor.professionalId) {
    throw topologyDenied("Ator sem identidade profissional canônica");
  }
  const currentActor = await requireCanonicalProfessional(tx, {
    institutionId: swap.institutionId,
    professionalId: actor.professionalId,
    userId: actor.userId,
    lockForUpdate: true,
    expectedSessionVersion,
  });

  if (
    swap.fromUserId !== actor.userId ||
    swap.fromProfessionalId !== currentActor.professionalId
  ) {
    throw topologyDenied(
      "A ação não pertence ao dono canônico da alocação de origem",
    );
  }
  return {
    professional: currentActor,
    auditRole: currentActor.roleInInstitution,
  };
}

async function requireSwapCancelActor(
  tx: any,
  actor: TenantActor,
  swap: SwapRow,
  expectedSessionVersion?: number,
): Promise<{ professional: CanonicalProfessional; auditRole: string }> {
  if (!actor.professionalId) {
    throw topologyDenied("Ator sem identidade profissional canônica");
  }
  const currentActor = await requireCanonicalProfessional(tx, {
    institutionId: swap.institutionId,
    professionalId: actor.professionalId,
    userId: actor.userId,
    lockForUpdate: true,
    expectedSessionVersion,
  });
  const isOwner =
    swap.fromUserId === actor.userId &&
    swap.fromProfessionalId === currentActor.professionalId;
  const isCandidate =
    swap.toUserId === actor.userId &&
    swap.toProfessionalId === currentActor.professionalId;
  if (swap.status === "PENDING") {
    if (!isOwner) {
      throw topologyDenied(
        "A ação não pertence ao dono canônico da alocação de origem",
      );
    }
  } else if (swap.status === "ACCEPTED") {
    if (!isOwner && !isCandidate) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message:
          "Só o ofertante ou quem assumiu pode desfazer esta candidatura antiga.",
      });
    }
  }
  return {
    professional: currentActor,
    auditRole: currentActor.roleInInstitution,
  };
}

async function requireAcceptedSwapTopology(
  db: any,
  swap: SwapRow,
  lockForUpdate = false,
): Promise<{
  source: CanonicalAssignmentTuple;
  recipient: CanonicalProfessional;
  toTuple: CanonicalAssignmentTuple | null;
}> {
  if (swap.status !== "ACCEPTED" || !swap.toProfessionalId || !swap.toUserId) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "Solicitação não está aceita com receptor completo",
    });
  }
  const source = await requireCanonicalSourceTuple(db, swap, {
    requireActive: true,
    lockForUpdate,
  });
  const { professional: recipient, toTuple } =
    await requireCanonicalSwapRecipient(db, swap, source, {
      professionalId: swap.toProfessionalId,
      userId: swap.toUserId,
      requireActiveAssignment: true,
      lockForUpdate,
    });
  assertSwapShiftsNotStarted(source.shift, toTuple?.shift ?? null);
  return { source, recipient, toTuple };
}

// Estados "vivos" de uma oferta: só nesses a alocação de origem precisa
// continuar ativa. APPROVED já migrou a titularidade; CANCELLED / EXPIRED /
// REJECTED_BY_PEER / REJECTED_BY_MANAGER são históricos e naturalmente têm a
// alocação de origem inativa — exigir atividade aqui derrubava a leitura de
// toda a lista de ofertas do usuário (bug de classe, todas as instituições).
const LIVE_SWAP_STATUSES: readonly SwapRow["status"][] = ["PENDING", "ACCEPTED"];

function isLiveSwapStatus(status: SwapRow["status"]): boolean {
  return LIVE_SWAP_STATUSES.includes(status);
}

async function requireSwapTopologyForRead(
  db: any,
  swap: SwapRow,
  lockForUpdate = false,
): Promise<void> {
  const requireActive = isLiveSwapStatus(swap.status);
  const source = await requireCanonicalSourceTuple(db, swap, {
    requireActive,
    lockForUpdate,
  });
  if (swap.toProfessionalId && swap.toUserId) {
    await requireCanonicalSwapRecipient(db, swap, source, {
      professionalId: swap.toProfessionalId,
      userId: swap.toUserId,
      requireActiveAssignment: requireActive,
      lockForUpdate,
    });
    return;
  }
  if (!isOneWay(swap.type)) {
    if (!swap.toShiftInstanceId)
      throw topologyDenied("Troca sem turno de contrapartida");
    const toShift = await requireCanonicalShift(db, {
      institutionId: swap.institutionId,
      shiftInstanceId: swap.toShiftInstanceId,
      lockForUpdate,
    });
    await requireProfessionalCanReceiveShift(db, {
      institutionId: swap.institutionId,
      professionalId: source.professional.professionalId,
      userId: source.professional.userId,
      shift: toShift,
    });
    await requireCanonicalShiftOccupant(db, { shift: toShift, lockForUpdate });
  }
}

async function requirePendingSwapForRecipient(
  db: any,
  swap: SwapRow,
  actor: TenantActor,
  lockForUpdate = false,
  expectedSessionVersion?: number,
): Promise<{
  source: CanonicalAssignmentTuple;
  professional: CanonicalProfessional;
  toTuple: CanonicalAssignmentTuple | null;
}> {
  if (!actor.professionalId)
    throw topologyDenied("Ator sem identidade profissional canônica");
  if (swap.status !== "PENDING") {
    throw new TRPCError({
      code: "CONFLICT",
      message: "Esta oferta já foi respondida por outra pessoa.",
    });
  }
  if (swap.expiresAt && swap.expiresAt.getTime() < Date.now()) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Solicitação expirada",
    });
  }
  if (swap.fromUserId === actor.userId) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Você não pode aceitar sua própria oferta",
    });
  }
  if (
    (swap.toProfessionalId !== null || swap.toUserId !== null) &&
    (swap.toProfessionalId !== actor.professionalId ||
      swap.toUserId !== actor.userId)
  ) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Esta oferta foi direcionada a outro profissional",
    });
  }
  const source = await requireCanonicalSourceTuple(db, swap, {
    requireActive: true,
    lockForUpdate,
  });
  const recipient = await requireCanonicalSwapRecipient(db, swap, source, {
    professionalId: actor.professionalId,
    userId: actor.userId,
    requireActiveAssignment: true,
    lockForUpdate,
    expectedSessionVersion,
  });
  return { source, ...recipient };
}

function isInstitutionManager(actor: TenantActor): boolean {
  return (
    actor.isGlobalAdmin ||
    actor.roleInInstitution === "GESTOR_MEDICO" ||
    actor.roleInInstitution === "GESTOR_PLUS"
  );
}

async function assertActorCanReadSwap(
  actor: TenantActor,
  swap: SwapRow,
): Promise<void> {
  if (!actor.professionalId)
    throw topologyDenied("Ator sem identidade profissional canônica");
  const isOfferer =
    swap.fromUserId === actor.userId &&
    swap.fromProfessionalId === actor.professionalId;
  const isReceiver =
    swap.toUserId === actor.userId &&
    swap.toProfessionalId === actor.professionalId;
  // A própria oferta/aceite continua legível mesmo após perda de
  // manager_scope; isso não abre solicitações de terceiros.
  if (isOfferer || isReceiver) return;
  if (isInstitutionManager(actor)) {
    await assertManagerScopeAccess(
      actor,
      swap.hospitalId,
      swap.sectorId ?? undefined,
    );
    return;
  }
  throw topologyDenied("Solicitação não pertence ao profissional autenticado");
}

function isRecordedSwapParticipant(
  actor: TenantActor,
  swap: SwapRow,
): boolean {
  if (!actor.professionalId) return false;
  return (
    (swap.fromUserId === actor.userId &&
      swap.fromProfessionalId === actor.professionalId) ||
    (swap.toUserId === actor.userId &&
      swap.toProfessionalId === actor.professionalId)
  );
}

/**
 * Uma candidatura ACCEPTED legada pode sobreviver a uma revogação de acesso
 * ou a uma alocação que deixou de ser válida. O participante registrado ainda
 * precisa enxergar uma representação mínima para cancelá-la; o gestor que
 * não participa continua submetido à topologia atual. A representação mínima
 * nunca usa os joins de turno/profissional potencialmente corrompidos nem
 * devolve conteúdo livre ou datas históricas.
 */
type SwapReadView = "FULL" | "STALE_ACCEPTED_PARTICIPANT";

async function resolveSwapReadView(
  db: any,
  actor: TenantActor,
  swap: SwapRow,
): Promise<SwapReadView> {
  await assertActorCanReadSwap(actor, swap);
  try {
    await requireSwapTopologyForRead(db, swap);
    return "FULL";
  } catch (error) {
    if (
      swap.status === "ACCEPTED" &&
      isRecordedSwapParticipant(actor, swap) &&
      isExpectedSwapVisibilityDenial(error)
    ) {
      return "STALE_ACCEPTED_PARTICIPANT";
    }
    throw error;
  }
}

async function filterReadableSwaps(
  db: any,
  actor: TenantActor,
  swaps: SwapRow[],
): Promise<readonly { swap: SwapRow; view: SwapReadView }[]> {
  const readable: { swap: SwapRow; view: SwapReadView }[] = [];
  for (const swap of swaps) {
    try {
      const view = await resolveSwapReadView(db, actor, swap);
      readable.push({ swap, view });
    } catch (error) {
      if (!isExpectedSwapVisibilityDenial(error)) throw error;
      // Omissões de rotina (FORBIDDEN/NOT_FOUND de terceiros) são esperadas e
      // silenciosas. Já a omissão por alocação de origem inativa é a classe
      // que mascarava "não vejo minha oferta": registra-se (sem PII) para
      // diagnóstico, mantendo a leitura resiliente.
      if (
        error instanceof TRPCError &&
        error.cause instanceof StaleCanonicalAssignmentError
      ) {
        console.warn(
          "[swaps.read] oferta omitida por alocação de origem inativa",
          JSON.stringify({
            swapId: swap.id,
            status: swap.status,
            institutionId: swap.institutionId,
          }),
        );
      }
    }
  }
  return readable;
}

function staleAcceptedResidualListItem(swap: SwapRow) {
  return {
    id: swap.id,
    type: swap.type,
    status: swap.status,
    reason: null,
    reviewNote: null,
    expiresAt: null,
    createdAt: null,
    reviewedAt: null,
    fromProfessional: null,
    toProfessional: null,
    fromShift: null,
    toShift: null,
    reviewerName: null,
    awaitingMyApproval: false,
    canCancel: true,
    cancellationOnly: true,
  };
}

function staleAcceptedResidualDetails(swap: SwapRow) {
  return {
    id: swap.id,
    type: swap.type,
    status: swap.status,
    reason: null,
    reviewNote: null,
    expiresAt: null,
    createdAt: null,
    updatedAt: null,
    reviewedAt: null,
    version: null,
    fromProfessional: null,
    toProfessional: null,
    fromShift: null,
    toShift: null,
    fromAssignmentId: null,
    toAssignmentId: null,
    reviewerName: null,
    institutionId: swap.institutionId,
    hospitalId: null,
    sectorId: null,
    cancellationOnly: true,
  };
}

async function lockSwapRequestForUpdate(
  tx: any,
  swapRequestId: number,
  institutionId: number,
): Promise<SwapRow> {
  const [swap] = await tx
    .select()
    .from(swapRequests)
    .where(
      and(
        eq(swapRequests.id, swapRequestId),
        eq(swapRequests.institutionId, institutionId),
      ),
    )
    .limit(1)
    .for("update");
  if (!swap) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "Solicitação não encontrada",
    });
  }
  return swap;
}

async function lockSwapMutationTopology(
  tx: any,
  swap: SwapRow,
  additionalProfessionalIds: readonly (number | null | undefined)[] = [],
): Promise<void> {
  await lockSwapShiftsForUpdate(tx, swap.institutionId, [
    swap.fromShiftInstanceId,
    swap.toShiftInstanceId,
  ]);
  const assignmentProfessionalIds = await lockSwapAssignmentsForUpdate(
    tx,
    swap.institutionId,
    [swap.fromShiftInstanceId, swap.toShiftInstanceId],
  );
  await lockAssignmentProfessionalsForUpdate(
    tx,
    [
      ...assignmentProfessionalIds,
      swap.fromProfessionalId,
      swap.toProfessionalId,
      ...additionalProfessionalIds,
    ].filter((id): id is number => typeof id === "number"),
  );
  await requireSwapTopologyForRead(tx, swap, true);
}

type SwapTransitionFields = Pick<typeof swapRequests.$inferInsert, "status"> &
  Partial<
    Pick<
      typeof swapRequests.$inferInsert,
      "reviewedByUserId" | "reviewedAt" | "reviewNote"
    >
  >;

function assertExpectedSwapStatus(
  swap: SwapRow,
  expectedStatuses: readonly SwapRow["status"][],
): void {
  if (expectedStatuses.includes(swap.status)) return;
  throw new TRPCError({
    code: "CONFLICT",
    message: `Status atual é ${swap.status}; a solicitação já foi respondida ou alterada.`,
  });
}

async function transitionSwapStatusForUpdate(
  tx: any,
  swap: SwapRow,
  expectedStatuses: readonly SwapRow["status"][],
  fields: SwapTransitionFields,
): Promise<void> {
  assertExpectedSwapStatus(swap, expectedStatuses);
  const [updated] = await tx
    .update(swapRequests)
    .set({ ...fields, version: swap.version + 1 })
    .where(
      and(
        eq(swapRequests.id, swap.id),
        eq(swapRequests.institutionId, swap.institutionId),
        inArray(swapRequests.status, [...expectedStatuses]),
        eq(swapRequests.version, swap.version),
      ),
    );
  if (!updated.affectedRows) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "A solicitação foi respondida ou alterada por outra ação.",
    });
  }
}

async function assertNoProfessionalTimeConflict(
  db: any,
  input: {
    professionalId: number;
    startAt: Date;
    endAt: Date;
    excludeAssignmentId?: number;
  },
): Promise<void> {
  const startIso = input.startAt.toISOString().slice(0, 19).replace("T", " ");
  const endIso = input.endAt.toISOString().slice(0, 19).replace("T", " ");
  const result = await db.execute(sql`
    SELECT
      si.id AS shiftInstanceId,
      si.label,
      si.start_at AS startAt,
      si.end_at AS endAt,
      si.hospital_id AS hospitalId
    FROM shift_assignments_v2 sa
    JOIN shift_instances si ON si.id = sa.shift_instance_id
    WHERE sa.professional_id = ${input.professionalId}
      AND sa.is_active = 1
      AND si.start_at < ${endIso}
      AND si.end_at > ${startIso}
      ${
        input.excludeAssignmentId !== undefined
          ? sql`AND sa.id != ${input.excludeAssignmentId}`
          : sql``
      }
  `);
  const [conflict] = rowsFromExecute<{
    shiftInstanceId: number;
    label: string;
    startAt: Date;
    endAt: Date;
    hospitalId: number;
  }>(result);
  if (conflict) {
    throw new TRPCError({
      code: "CONFLICT",
      message: `Conflito de horário: profissional já alocado em "${conflict.label}"`,
    });
  }
}

function assignmentWriteCandidatesForSwap(
  swap: SwapRow,
  source: CanonicalAssignmentTuple,
  recipient: CanonicalProfessional,
  toTuple: CanonicalAssignmentTuple | null,
): AssignmentWriteCandidate[] {
  const recipientCandidate: AssignmentWriteCandidate = {
    professionalId: recipient.professionalId,
    expectedUserId: recipient.userId,
    institutionId: source.shift.institutionId,
    hospitalId: source.shift.hospitalId,
    sectorId: source.shift.sectorId,
    scheduleContextId: source.shift.scheduleContextId,
    startAt: source.shift.startAt,
    endAt: source.shift.endAt,
    excludeAssignmentIds: toTuple ? [toTuple.assignmentId] : undefined,
  };
  if (isOneWay(swap.type)) return [recipientCandidate];
  if (!toTuple) throw topologyDenied("Troca sem tupla de contrapartida");
  return [
    recipientCandidate,
    {
      professionalId: source.professional.professionalId,
      expectedUserId: source.professional.userId,
      institutionId: toTuple.shift.institutionId,
      hospitalId: toTuple.shift.hospitalId,
      sectorId: toTuple.shift.sectorId,
      scheduleContextId: toTuple.shift.scheduleContextId,
      startAt: toTuple.shift.startAt,
      endAt: toTuple.shift.endAt,
      excludeAssignmentIds: [source.assignmentId],
    },
  ];
}

async function assertNoSwapTimeConflicts(
  db: any,
  swap: SwapRow,
  source: CanonicalAssignmentTuple,
  recipient: CanonicalProfessional,
  toTuple: CanonicalAssignmentTuple | null,
): Promise<void> {
  if (isOneWay(swap.type)) {
    await assertNoProfessionalTimeConflict(db, {
      professionalId: recipient.professionalId,
      startAt: source.shift.startAt,
      endAt: source.shift.endAt,
    });
    return;
  }
  if (!toTuple) throw topologyDenied("Troca sem tupla de contrapartida");
  await assertNoProfessionalTimeConflict(db, {
    professionalId: recipient.professionalId,
    startAt: source.shift.startAt,
    endAt: source.shift.endAt,
    excludeAssignmentId: toTuple.assignmentId,
  });
  await assertNoProfessionalTimeConflict(db, {
    professionalId: source.professional.professionalId,
    startAt: toTuple.shift.startAt,
    endAt: toTuple.shift.endAt,
    excludeAssignmentId: source.assignmentId,
  });
}

type SwapTransferTopology = {
  source: CanonicalAssignmentTuple;
  recipient: CanonicalProfessional;
  toTuple: CanonicalAssignmentTuple | null;
};

type SwapTransferReviewer = {
  professional: CanonicalProfessional;
  auditRole: string;
};

async function deactivateActiveAssignment(
  tx: any,
  tuple: CanonicalAssignmentTuple,
  label: string,
): Promise<void> {
  const [done] = await tx
    .update(shiftAssignmentsV2)
    .set({ isActive: false })
    .where(
      and(
        eq(shiftAssignmentsV2.id, tuple.assignmentId),
        eq(shiftAssignmentsV2.shiftInstanceId, tuple.shift.id),
        eq(shiftAssignmentsV2.institutionId, tuple.shift.institutionId),
        eq(shiftAssignmentsV2.hospitalId, tuple.shift.hospitalId),
        eq(shiftAssignmentsV2.sectorId, tuple.shift.sectorId),
        eq(
          shiftAssignmentsV2.professionalId,
          tuple.professional.professionalId,
        ),
        eq(shiftAssignmentsV2.isActive, true),
      ),
    );
  if (!done.affectedRows) {
    throw new TRPCError({
      code: "CONFLICT",
      message: `A alocação ${label} já foi alterada por outra ação — esta oferta não pode mais ser efetivada.`,
    });
  }
}

async function writeTransferredAssignments(
  tx: any,
  currentSwap: SwapRow,
  topology: SwapTransferTopology,
  actor: TenantActor,
): Promise<void> {
  if (isOneWay(currentSwap.type)) {
    await deactivateActiveAssignment(tx, topology.source, "de origem");
    await tx.insert(shiftAssignmentsV2).values({
      shiftInstanceId: topology.source.shift.id,
      institutionId: topology.source.shift.institutionId,
      hospitalId: topology.source.shift.hospitalId,
      sectorId: topology.source.shift.sectorId,
      professionalId: topology.recipient.professionalId,
      assignmentType: topology.source.assignmentType,
      status: "OCUPADO",
      isActive: true,
      createdBy: actor.userId,
    });
    await enqueueDutySyncWithdrawsForRemovedProfessionals(tx, {
      institutionId: topology.source.shift.institutionId,
      shiftInstanceId: topology.source.shift.id,
      professionalIds: [topology.source.professional.professionalId],
    });
    return;
  }
  if (!topology.toTuple)
    throw topologyDenied("Troca sem alocação de contrapartida canônica");
  await deactivateActiveAssignment(tx, topology.source, "de origem");
  await deactivateActiveAssignment(tx, topology.toTuple, "do colega");
  await tx.insert(shiftAssignmentsV2).values({
    shiftInstanceId: topology.toTuple.shift.id,
    institutionId: topology.toTuple.shift.institutionId,
    hospitalId: topology.toTuple.shift.hospitalId,
    sectorId: topology.toTuple.shift.sectorId,
    professionalId: topology.source.professional.professionalId,
    assignmentType: topology.toTuple.assignmentType,
    status: "OCUPADO",
    isActive: true,
    createdBy: actor.userId,
  });
  await tx.insert(shiftAssignmentsV2).values({
    shiftInstanceId: topology.source.shift.id,
    institutionId: topology.source.shift.institutionId,
    hospitalId: topology.source.shift.hospitalId,
    sectorId: topology.source.shift.sectorId,
    professionalId: topology.recipient.professionalId,
    assignmentType: topology.source.assignmentType,
    status: "OCUPADO",
    isActive: true,
    createdBy: actor.userId,
  });
  await enqueueDutySyncWithdrawsForRemovedProfessionals(tx, {
    institutionId: topology.source.shift.institutionId,
    shiftInstanceId: topology.source.shift.id,
    professionalIds: [topology.source.professional.professionalId],
  });
  await enqueueDutySyncWithdrawsForRemovedProfessionals(tx, {
    institutionId: topology.toTuple.shift.institutionId,
    shiftInstanceId: topology.toTuple.shift.id,
    professionalIds: [topology.recipient.professionalId],
  });
}

async function enqueueSwapCompletionNotifications(
  tx: any,
  currentSwap: SwapRow,
  topology: SwapTransferTopology,
  approvedVersion: number,
  takerName: string,
): Promise<void> {
  await enqueueComunicaSwapApproved({
    swapId: currentSwap.id,
    swapVersion: approvedVersion,
    institutionId: currentSwap.institutionId,
    shiftInstanceId: currentSwap.fromShiftInstanceId,
    recipientRole: "FROM",
    targetUserId: topology.source.professional.userId,
    targetEmail: topology.source.professional.email,
    db: tx,
  });
  await enqueueComunicaSwapApproved({
    swapId: currentSwap.id,
    swapVersion: approvedVersion,
    institutionId: currentSwap.institutionId,
    shiftInstanceId: currentSwap.fromShiftInstanceId,
    recipientRole: "TO",
    targetUserId: topology.recipient.userId,
    targetEmail: topology.recipient.email,
    db: tx,
  });
  await enqueueSwapTakenSignals({
    db: tx,
    swap: {
      ...currentSwap,
      toProfessionalId: topology.recipient.professionalId,
      toUserId: topology.recipient.userId,
    },
    takerName,
    shiftLabel: topology.source.shift.label,
  });
}

/**
 * Reatribui as alocações e marca a solicitação como APPROVED.
 * Usado pelo aceite (PENDING → APPROVED no mesmo take) e pelo
 * `approveByOwner` legado (ACCEPTED residual).
 */
async function applySwapAssignmentTransfer(
  tx: any,
  input: {
    currentSwap: SwapRow;
    expectedStatus: "PENDING" | "ACCEPTED";
    topology: SwapTransferTopology;
    actor: TenantActor;
    reviewer: SwapTransferReviewer;
    note?: string;
    description: string;
    approvalPath: "TAKE" | "OWNER";
    extraUpdate?: {
      toProfessionalId: number;
      toUserId: number;
      toAssignmentId: number | null;
    };
  },
): Promise<number> {
  const { currentSwap, topology, actor, reviewer } = input;
  await writeTransferredAssignments(tx, currentSwap, topology, actor);

  const conflictMessage =
    input.expectedStatus === "PENDING"
      ? "Esta oferta já foi respondida por outra pessoa."
      : "Esta solicitação já foi efetivada ou cancelada.";
  const [done] = await tx
    .update(swapRequests)
    .set({
      status: "APPROVED",
      reviewedByUserId: actor.userId,
      reviewedAt: new Date(),
      reviewNote: input.note ?? null,
      version: currentSwap.version + 1,
      ...(input.extraUpdate ?? {}),
    })
    .where(
      and(
        eq(swapRequests.id, currentSwap.id),
        eq(swapRequests.institutionId, currentSwap.institutionId),
        eq(swapRequests.status, input.expectedStatus),
        eq(swapRequests.version, currentSwap.version),
      ),
    );
  if (!done.affectedRows) {
    throw new TRPCError({
      code: "CONFLICT",
      message: conflictMessage,
    });
  }
  await recomputeShiftStatus(tx, topology.source.shift.id);
  if (topology.toTuple) {
    await recomputeShiftStatus(tx, topology.toTuple.shift.id);
  }
  const auditPhase =
    input.approvalPath === "TAKE" ? "ACCEPTED" : "APPROVED_BY_OWNER";
  const names = auditNames(currentSwap.type, auditPhase);
  await recordAudit(
    {
      action: names.action,
      entityType: names.entityType,
      entityId: currentSwap.id,
      actorUserId: actor.userId,
      actorRole: reviewer.auditRole,
      actorName: reviewer.professional.name,
      description: input.description,
      fromProfessionalId: currentSwap.fromProfessionalId,
      toProfessionalId:
        input.extraUpdate?.toProfessionalId ??
        currentSwap.toProfessionalId ??
        undefined,
      fromUserId: currentSwap.fromUserId,
      toUserId:
        input.extraUpdate?.toUserId ?? currentSwap.toUserId ?? undefined,
      shiftInstanceId: currentSwap.fromShiftInstanceId,
      hospitalId: currentSwap.hospitalId,
      sectorId: currentSwap.sectorId ?? undefined,
      institutionId: currentSwap.institutionId,
      metadata: { note: input.note, approvalPath: input.approvalPath },
    },
    { db: tx, strict: true },
  );
  const approvedVersion = currentSwap.version + 1;
  await enqueueSwapCompletionNotifications(
    tx,
    currentSwap,
    topology,
    approvedVersion,
    topology.recipient.name,
  );
  return approvedVersion;
}

/**
 * Efetua um swap/cessão/transfer residual em ACCEPTED.
 * O fluxo canônico novo completa no `accept` (PENDING → APPROVED).
 * Este caminho existe só para candidaturas antigas que ficaram aguardando o
 * dono. Ele só é alcançado pela mutation explícita `approveByOwner`; consultas
 * e novos aceites nunca reparam, cancelam ou efetivam esse estado legado.
 */
async function effectuateApprovedSwap(
  db: any,
  swap: SwapRow,
  actor: TenantActor,
  expectedSessionVersion: number | undefined,
  note: string | undefined,
  description: string,
): Promise<void> {
  if (swap.expiresAt && swap.expiresAt.getTime() < Date.now()) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Solicitação expirada — peça uma nova oferta",
    });
  }
  const preflight = await requireAcceptedSwapTopology(db, swap);
  await assertNoSwapTimeConflicts(
    db,
    swap,
    preflight.source,
    preflight.recipient,
    preflight.toTuple,
  );
  const monthTargets: MonthLockTarget[] = [
    {
      institutionId: preflight.source.shift.institutionId,
      hospitalId: preflight.source.shift.hospitalId,
      date: preflight.source.shift.startAt,
    },
  ];
  if (preflight.toTuple) {
    monthTargets.push({
      institutionId: preflight.toTuple.shift.institutionId,
      hospitalId: preflight.toTuple.shift.hospitalId,
      date: preflight.toTuple.shift.startAt,
    });
  }

  return db.transaction(async (tx: any) => {
    const [currentSwap] = await tx
      .select()
      .from(swapRequests)
      .where(
        and(
          eq(swapRequests.id, swap.id),
          eq(swapRequests.institutionId, swap.institutionId),
        ),
      )
      .limit(1)
      .for("update");
    if (
      !currentSwap ||
      currentSwap.status !== "ACCEPTED" ||
      currentSwap.version !== swap.version
    ) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "Esta solicitação já foi efetivada, cancelada ou alterada.",
      });
    }
    if (currentSwap.expiresAt && currentSwap.expiresAt.getTime() < Date.now()) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Solicitação expirada — peça uma nova oferta",
      });
    }

    await assertPublishedSwapMonthsForUpdate(tx, monthTargets);
    if (!currentSwap.toProfessionalId)
      throw topologyDenied("Solicitação sem receptor canônico");
    await lockSwapShiftsForUpdate(tx, currentSwap.institutionId, [
      currentSwap.fromShiftInstanceId,
      currentSwap.toShiftInstanceId,
    ]);
    const assignmentProfessionalIds = await lockSwapAssignmentsForUpdate(
      tx,
      currentSwap.institutionId,
      [currentSwap.fromShiftInstanceId, currentSwap.toShiftInstanceId],
    );
    await lockAssignmentProfessionalsForUpdate(
      tx,
      [
        ...assignmentProfessionalIds,
        currentSwap.fromProfessionalId,
        currentSwap.toProfessionalId,
        actor.professionalId,
      ].filter((id): id is number => typeof id === "number"),
    );
    const topology = await requireAcceptedSwapTopology(tx, currentSwap, true);
    assertSameSwapSchedulingSnapshot(
      preflight.source.shift,
      topology.source.shift,
      preflight.toTuple?.shift ?? null,
      topology.toTuple?.shift ?? null,
      "Topologia do plantão mudou durante a efetivação",
    );
    const reviewer = await requireCurrentSwapOwner(
      tx,
      actor,
      currentSwap,
      expectedSessionVersion,
    );
    await assertAssignmentWritesAllowedForUpdate(
      tx,
      assignmentWriteCandidatesForSwap(
        currentSwap,
        topology.source,
        topology.recipient,
        topology.toTuple,
      ),
      {
        additionalProfessionalIds: [
          topology.source.professional.professionalId,
        ],
      },
    );
    await applySwapAssignmentTransfer(tx, {
      currentSwap,
      expectedStatus: "ACCEPTED",
      topology,
      actor,
      reviewer,
      note,
      description,
      approvalPath: "OWNER",
    });
  }, ASSIGNMENT_WRITE_TRANSACTION_CONFIG);
}

// ─── router ─────────────────────────────────────────────────────────────────

const listAvailableInputSchema = z.object({
  type: z.enum(["SWAP", "TRANSFER", "CESSAO"]).optional(),
  scheduleContextId: z.number().int().positive().optional(),
});

type ListAvailableInput = z.infer<typeof listAvailableInputSchema>;

type ListAvailableRow = {
  id: number;
  type: SwapType;
  reason: string | null;
  expiresAt: Date | null;
  createdAt: Date;
  fromProfessional: { name: string; role: string };
  fromShift: {
    id: number;
    scheduleContextId: number;
    label: string;
    startAt: Date;
    endAt: Date;
    hospitalName: string;
    sectorName: string;
  };
  toShift: {
    id: number;
    label: string;
    startAt: Date;
    endAt: Date;
    hospitalName: string;
    sectorName: string;
  } | null;
  toProfessionalId: number | null;
  toUserId: number | null;
  canRespond: boolean;
};

async function queryListAvailableRows(
  ctx: TrpcContext,
  input: ListAvailableInput,
): Promise<ListAvailableRow[]> {
  const db = await getDb();
  if (!db)
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "DB unavailable",
    });

  if (!ctx.user || ctx.institutionId == null) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Não autenticado" });
  }

  const userId = ctx.user.id;
  const institutionId = ctx.institutionId;
  const actor = await getTenantActorFromContext(ctx);
  if (!actor.professionalId)
    throw topologyDenied("Ator sem identidade profissional canônica");
  await requireCurrentListAvailableActor(db, {
    institutionId,
    professionalId: actor.professionalId,
    userId,
    expectedSessionVersion: ctx.user.sessionVersion,
  });
  const assumableContextIds = await listAssumableScheduleContextIds(
    institutionId,
    actor.professionalId,
    db,
  );
  const managedContextIds = isInstitutionManager(actor)
    ? (await listAuthorizedScheduleContexts(actor, db))
        .filter((context) => context.canManage)
        .map((context) => context.id)
    : [];
  const visibleContextIds = [
    ...new Set([...assumableContextIds, ...managedContextIds]),
  ];
  if (
    input.scheduleContextId !== undefined &&
    !visibleContextIds.includes(input.scheduleContextId)
  ) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Escala fora do acesso operacional do profissional.",
    });
  }
  if (visibleContextIds.length === 0) return [];

  const result = await db.execute(sql`
        SELECT
          sr.id,
          sr.type,
          sr.reason,
          sr.expires_at       AS expiresAt,
          sr.created_at       AS createdAt,
          fp.name             AS fromProfessionalName,
          fp.role             AS fromProfessionalRole,
          fsi.id              AS fromShiftInstanceId,
          fsi.schedule_context_id AS fromScheduleContextId,
          fsi.label           AS fromShiftLabel,
          fsi.start_at        AS fromShiftStartAt,
          fsi.end_at          AS fromShiftEndAt,
          fh.name             AS fromHospitalName,
          fs.name             AS fromSectorName,
          tsi.id              AS toShiftInstanceId,
          tsi.label           AS toShiftLabel,
          tsi.start_at        AS toShiftStartAt,
          tsi.end_at          AS toShiftEndAt,
          th.name             AS toHospitalName,
          ts.name             AS toSectorName,
          sr.to_professional_id AS toProfessionalId,
          sr.to_user_id       AS toUserId
        FROM swap_requests sr
        JOIN institutions inst
          ON inst.id = sr.institution_id
         AND inst.is_active = 1
        JOIN shift_instances fsi
          ON fsi.id = sr.from_shift_instance_id
         AND fsi.institution_id = sr.institution_id
         AND fsi.hospital_id = sr.hospital_id
         AND fsi.sector_id = sr.sector_id
        JOIN schedule_contexts fsc
          ON fsc.id = fsi.schedule_context_id
         AND fsc.institution_id = fsi.institution_id
         AND fsc.hospital_id = fsi.hospital_id
         AND fsc.sector_id = fsi.sector_id
         AND fsc.active = 1
        JOIN hospitals fh
          ON fh.id = fsi.hospital_id
         AND fh.institution_id = fsi.institution_id
        JOIN sectors fs
          ON fs.id = fsi.sector_id
         AND fs.institution_id = fsi.institution_id
         AND fs.hospital_id = fsi.hospital_id
        JOIN monthly_rosters fmr
          ON fmr.institution_id = fsi.institution_id
         AND fmr.hospital_id = fsi.hospital_id
         AND fmr.year_month = DATE_FORMAT(DATE_SUB(fsi.start_at, INTERVAL 3 HOUR), '%Y-%m')
         AND fmr.status = 'PUBLISHED'
        JOIN shift_assignments_v2 fsa
          ON fsa.id = sr.from_assignment_id
         AND fsa.shift_instance_id = fsi.id
         AND fsa.institution_id = fsi.institution_id
         AND fsa.hospital_id = fsi.hospital_id
         AND fsa.sector_id = fsi.sector_id
         AND fsa.professional_id = sr.from_professional_id
         AND fsa.is_active = 1
         AND fsa.status = 'OCUPADO'
        JOIN professionals fp
          ON fp.id = sr.from_professional_id
         AND fp.user_id = sr.from_user_id
        JOIN users fu
          ON fu.id = fp.user_id
         AND fu.approval_status = 'APPROVED'
         AND fu.deleted_at IS NULL
        JOIN professional_institutions fpi
          ON fpi.professional_id = fp.id
         AND fpi.user_id = fp.user_id
         AND fpi.institution_id = sr.institution_id
         AND fpi.active = 1
        JOIN professionals ap
          ON ap.id = ${actor.professionalId}
         AND ap.user_id = ${userId}
        JOIN users au
          ON au.id = ap.user_id
         AND au.approval_status = 'APPROVED'
         AND au.deleted_at IS NULL
         AND au.session_version = ${ctx.user.sessionVersion}
        JOIN professional_institutions api
          ON api.professional_id = ap.id
         AND api.user_id = au.id
         AND api.institution_id = sr.institution_id
         AND api.active = 1
        LEFT JOIN shift_instances tsi
          ON sr.type = 'SWAP'
         AND tsi.id = sr.to_shift_instance_id
         AND tsi.institution_id = sr.institution_id
        LEFT JOIN hospitals th
          ON th.id = tsi.hospital_id
         AND th.institution_id = tsi.institution_id
        LEFT JOIN sectors ts
          ON ts.id = tsi.sector_id
         AND ts.institution_id = tsi.institution_id
         AND ts.hospital_id = tsi.hospital_id
        LEFT JOIN schedule_contexts tsc
          ON tsc.id = tsi.schedule_context_id
         AND tsc.institution_id = tsi.institution_id
         AND tsc.hospital_id = tsi.hospital_id
         AND tsc.sector_id = tsi.sector_id
         AND tsc.active = 1
        LEFT JOIN shift_assignments_v2 tsa
          ON sr.type = 'SWAP'
         AND tsa.shift_instance_id = tsi.id
         AND tsa.institution_id = tsi.institution_id
         AND tsa.hospital_id = tsi.hospital_id
         AND tsa.sector_id = tsi.sector_id
         AND tsa.professional_id = ap.id
         AND tsa.is_active = 1
         AND tsa.status = 'OCUPADO'
        WHERE sr.status = 'PENDING'
          AND sr.institution_id = ${institutionId}
          AND sr.from_user_id != ${userId}
          ${
            input.scheduleContextId !== undefined
              ? sql`AND fsi.schedule_context_id = ${input.scheduleContextId}`
              : sql``
          }
          AND (
            (sr.to_professional_id IS NULL AND sr.to_user_id IS NULL)
            OR (sr.to_professional_id = ${actor.professionalId} AND sr.to_user_id = ${userId})
            OR (
              (sr.to_professional_id IS NOT NULL OR sr.to_user_id IS NOT NULL)
              AND (
                sr.to_professional_id != ${actor.professionalId}
                OR sr.to_user_id != ${userId}
              )
              AND (
                api.role_in_institution = 'GESTOR_PLUS'
                OR EXISTS (
                  SELECT 1
                  FROM manager_scope actor_directed_scope
                  WHERE actor_directed_scope.manager_professional_id = ap.id
                    AND actor_directed_scope.institution_id = fsi.institution_id
                    AND actor_directed_scope.hospital_id = fsi.hospital_id
                    AND (actor_directed_scope.sector_id IS NULL OR actor_directed_scope.sector_id = fsi.sector_id)
                    AND actor_directed_scope.active = 1
                )
              )
            )
          )
          AND fsi.start_at > NOW()
          AND (sr.expires_at IS NULL OR sr.expires_at > NOW())
          AND NOT EXISTS (
            SELECT 1
            FROM shift_assignments_v2 source_duplicate
            WHERE source_duplicate.shift_instance_id = fsi.id
              AND source_duplicate.institution_id = fsi.institution_id
              AND source_duplicate.hospital_id = fsi.hospital_id
              AND source_duplicate.sector_id = fsi.sector_id
              AND source_duplicate.professional_id = fp.id
              AND source_duplicate.is_active = 1
              AND source_duplicate.id != fsa.id
          )
          AND NOT EXISTS (
            SELECT 1
            FROM swap_request_dismissals actor_dismissal
            WHERE actor_dismissal.swap_request_id = sr.id
              AND actor_dismissal.institution_id = sr.institution_id
              AND actor_dismissal.user_id = ${userId}
          )
          AND (
            EXISTS (
              SELECT 1
              FROM professional_access source_access
              WHERE source_access.institution_id = fsi.institution_id
                AND source_access.professional_id = fp.id
                AND source_access.hospital_id = fsi.hospital_id
                AND source_access.can_access = 1
                AND (
                  (
                    fsc.admission_policy = 'QUALIFICATION_ALLOWLIST'
                    AND source_access.sector_id = fsi.sector_id
                  )
                  OR
                  (
                    fsc.admission_policy <> 'QUALIFICATION_ALLOWLIST'
                    AND (source_access.sector_id IS NULL OR source_access.sector_id = fsi.sector_id)
                  )
                )
            )
            OR fpi.role_in_institution = 'GESTOR_PLUS'
            OR EXISTS (
              SELECT 1
              FROM manager_scope source_scope
              WHERE source_scope.manager_professional_id = fp.id
                AND source_scope.institution_id = fsi.institution_id
                AND source_scope.hospital_id = fsi.hospital_id
                AND (source_scope.sector_id IS NULL OR source_scope.sector_id = fsi.sector_id)
                AND source_scope.active = 1
            )
          )
          AND fsi.schedule_context_id IN (${sql.join(
            visibleContextIds.map((id) => sql`${id}`),
            sql`, `,
          )})
          AND (
            api.role_in_institution = 'GESTOR_PLUS'
            OR EXISTS (
              SELECT 1
              FROM manager_scope actor_mgr
              WHERE actor_mgr.manager_professional_id = ap.id
                AND actor_mgr.institution_id = fsi.institution_id
                AND actor_mgr.hospital_id = fsi.hospital_id
                AND (actor_mgr.sector_id IS NULL OR actor_mgr.sector_id = fsi.sector_id)
                AND actor_mgr.active = 1
            )
            OR ${plantonistaAccessCoversShiftSql("ap", "fsi", "fsc")}
          )
          AND (
            api.role_in_institution = 'GESTOR_PLUS'
            OR EXISTS (
              SELECT 1
              FROM manager_scope actor_source_scope
              WHERE actor_source_scope.manager_professional_id = ap.id
                AND actor_source_scope.institution_id = fsi.institution_id
                AND actor_source_scope.hospital_id = fsi.hospital_id
                AND (actor_source_scope.sector_id IS NULL OR actor_source_scope.sector_id = fsi.sector_id)
                AND actor_source_scope.active = 1
            )
            OR EXISTS (
              SELECT 1
              FROM professional_access actor_source_access
              WHERE actor_source_access.institution_id = fsi.institution_id
                AND actor_source_access.professional_id = ap.id
                AND actor_source_access.hospital_id = fsi.hospital_id
                AND actor_source_access.can_access = 1
                AND (
                  (
                    fsc.admission_policy = 'QUALIFICATION_ALLOWLIST'
                    AND actor_source_access.sector_id = fsi.sector_id
                  )
                  OR
                  (
                    fsc.admission_policy <> 'QUALIFICATION_ALLOWLIST'
                    AND (actor_source_access.sector_id IS NULL OR actor_source_access.sector_id = fsi.sector_id)
                  )
                )
            )
          )
          AND (
            api.role_in_institution = 'GESTOR_PLUS'
            OR EXISTS (
              SELECT 1
              FROM manager_scope actor_specialty_scope
              WHERE actor_specialty_scope.manager_professional_id = ap.id
                AND actor_specialty_scope.institution_id = fsi.institution_id
                AND actor_specialty_scope.hospital_id = fsi.hospital_id
                AND (actor_specialty_scope.sector_id IS NULL OR actor_specialty_scope.sector_id = fsi.sector_id)
                AND actor_specialty_scope.active = 1
            )
            OR ${plantonistaAccessCoversShiftSql("ap", "fsi", "fsc")}
          )
          AND (
            api.role_in_institution = 'GESTOR_PLUS'
            OR EXISTS (
              SELECT 1
              FROM manager_scope actor_peer_specialty_scope
              WHERE actor_peer_specialty_scope.manager_professional_id = ap.id
                AND actor_peer_specialty_scope.institution_id = fsi.institution_id
                AND actor_peer_specialty_scope.hospital_id = fsi.hospital_id
                AND (actor_peer_specialty_scope.sector_id IS NULL OR actor_peer_specialty_scope.sector_id = fsi.sector_id)
                AND actor_peer_specialty_scope.active = 1
            )
            OR ${plantonistaAccessCoversShiftSql("ap", "fsi", "fsc")}
          )
          AND (
            NOT EXISTS (
              SELECT 1
              FROM shift_assignments_v2 actor_conflict
              JOIN shift_instances actor_conflict_shift
                ON actor_conflict_shift.id = actor_conflict.shift_instance_id
              WHERE actor_conflict.professional_id = ap.id
                AND actor_conflict.is_active = 1
                AND actor_conflict_shift.start_at < fsi.end_at
                AND actor_conflict_shift.end_at > fsi.start_at
                AND (sr.type != 'SWAP' OR actor_conflict.id != tsa.id)
            )
            OR (
              (sr.to_professional_id IS NOT NULL OR sr.to_user_id IS NOT NULL)
              AND (
                sr.to_professional_id != ${actor.professionalId}
                OR sr.to_user_id != ${userId}
              )
              AND (
                api.role_in_institution = 'GESTOR_PLUS'
                OR EXISTS (
                  SELECT 1
                  FROM manager_scope actor_conflict_bypass
                  WHERE actor_conflict_bypass.manager_professional_id = ap.id
                    AND actor_conflict_bypass.institution_id = fsi.institution_id
                    AND actor_conflict_bypass.hospital_id = fsi.hospital_id
                    AND (actor_conflict_bypass.sector_id IS NULL OR actor_conflict_bypass.sector_id = fsi.sector_id)
                    AND actor_conflict_bypass.active = 1
                )
              )
            )
          )
          AND (
            (
              sr.type IN ('TRANSFER', 'CESSAO')
              AND sr.to_shift_instance_id IS NULL
              AND sr.to_assignment_id IS NULL
            )
            OR
            (
              sr.type = 'SWAP'
              AND sr.to_shift_instance_id IS NOT NULL
              AND sr.to_shift_instance_id != sr.from_shift_instance_id
              AND sr.to_assignment_id IS NULL
              AND tsi.id IS NOT NULL
              AND tsi.start_at > NOW()
              AND th.id IS NOT NULL
              AND ts.id IS NOT NULL
              AND tsa.id IS NOT NULL
              AND EXISTS (
                SELECT 1
                FROM monthly_rosters target_roster
                WHERE target_roster.institution_id = tsi.institution_id
                  AND target_roster.hospital_id = tsi.hospital_id
                  AND target_roster.year_month = DATE_FORMAT(DATE_SUB(tsi.start_at, INTERVAL 3 HOUR), '%Y-%m')
                  AND target_roster.status = 'PUBLISHED'
              )
              AND NOT EXISTS (
                SELECT 1
                FROM shift_assignments_v2 target_duplicate
                WHERE target_duplicate.shift_instance_id = tsi.id
                  AND target_duplicate.institution_id = tsi.institution_id
                  AND target_duplicate.hospital_id = tsi.hospital_id
                  AND target_duplicate.sector_id = tsi.sector_id
                  AND target_duplicate.professional_id = ap.id
                  AND target_duplicate.is_active = 1
                  AND target_duplicate.id != tsa.id
              )
              AND (
                api.role_in_institution = 'GESTOR_PLUS'
                OR EXISTS (
                  SELECT 1
                  FROM manager_scope actor_target_scope
                  WHERE actor_target_scope.manager_professional_id = ap.id
                    AND actor_target_scope.institution_id = tsi.institution_id
                    AND actor_target_scope.hospital_id = tsi.hospital_id
                    AND (actor_target_scope.sector_id IS NULL OR actor_target_scope.sector_id = tsi.sector_id)
                    AND actor_target_scope.active = 1
                )
                OR EXISTS (
                  SELECT 1
                  FROM professional_access actor_target_access
                  WHERE actor_target_access.institution_id = tsi.institution_id
                    AND actor_target_access.professional_id = ap.id
                    AND actor_target_access.hospital_id = tsi.hospital_id
                    AND actor_target_access.can_access = 1
                    AND (
                      (
                        tsc.admission_policy = 'QUALIFICATION_ALLOWLIST'
                        AND actor_target_access.sector_id = tsi.sector_id
                      )
                      OR
                      (
                        tsc.admission_policy <> 'QUALIFICATION_ALLOWLIST'
                        AND (actor_target_access.sector_id IS NULL OR actor_target_access.sector_id = tsi.sector_id)
                      )
                    )
                )
              )
              AND EXISTS (
                SELECT 1
                FROM professional_access source_target_access
                WHERE source_target_access.institution_id = tsi.institution_id
                  AND source_target_access.professional_id = fp.id
                  AND source_target_access.hospital_id = tsi.hospital_id
                  AND source_target_access.can_access = 1
                  AND (
                    (
                      tsc.admission_policy = 'QUALIFICATION_ALLOWLIST'
                      AND source_target_access.sector_id = tsi.sector_id
                    )
                    OR
                    (
                      tsc.admission_policy <> 'QUALIFICATION_ALLOWLIST'
                      AND (source_target_access.sector_id IS NULL OR source_target_access.sector_id = tsi.sector_id)
                    )
                  )
              )
              AND NOT EXISTS (
                SELECT 1
                FROM shift_assignments_v2 source_target_conflict
                JOIN shift_instances source_target_conflict_shift
                  ON source_target_conflict_shift.id = source_target_conflict.shift_instance_id
                WHERE source_target_conflict.professional_id = fp.id
                  AND source_target_conflict.is_active = 1
                  AND source_target_conflict_shift.start_at < tsi.end_at
                  AND source_target_conflict_shift.end_at > tsi.start_at
                  AND source_target_conflict.id != fsa.id
              )
            )
            OR
            (
              (sr.to_professional_id IS NOT NULL OR sr.to_user_id IS NOT NULL)
              AND (
                sr.to_professional_id != ${actor.professionalId}
                OR sr.to_user_id != ${userId}
              )
              AND (
                api.role_in_institution = 'GESTOR_PLUS'
                OR EXISTS (
                  SELECT 1
                  FROM manager_scope actor_directed_type
                  WHERE actor_directed_type.manager_professional_id = ap.id
                    AND actor_directed_type.institution_id = fsi.institution_id
                    AND actor_directed_type.hospital_id = fsi.hospital_id
                    AND (actor_directed_type.sector_id IS NULL OR actor_directed_type.sector_id = fsi.sector_id)
                    AND actor_directed_type.active = 1
                )
              )
              AND (
                (
                  sr.type IN ('TRANSFER', 'CESSAO')
                  AND sr.to_shift_instance_id IS NULL
                  AND sr.to_assignment_id IS NULL
                )
                OR
                (
                  sr.type = 'SWAP'
                  AND sr.to_shift_instance_id IS NOT NULL
                  AND sr.to_shift_instance_id != sr.from_shift_instance_id
                  AND tsi.id IS NOT NULL
                  AND tsi.start_at > NOW()
                  AND th.id IS NOT NULL
                  AND ts.id IS NOT NULL
                )
              )
            )
          )
          ${input.type ? sql`AND sr.type = ${input.type}` : sql``}
        ORDER BY fsi.start_at ASC, sr.id ASC
      `);

  return rowsFromExecute<AvailableSwapRow>(result).map((r) => ({
    id: r.id,
    type: r.type,
    reason: r.reason,
    expiresAt: r.expiresAt === null ? null : dateFromExecute(r.expiresAt),
    createdAt: dateFromExecute(r.createdAt),
    fromProfessional: {
      name: r.fromProfessionalName,
      role: r.fromProfessionalRole,
    },
    fromShift: {
      id: r.fromShiftInstanceId,
      scheduleContextId: r.fromScheduleContextId,
      label: r.fromShiftLabel,
      startAt: dateFromExecute(r.fromShiftStartAt),
      endAt: dateFromExecute(r.fromShiftEndAt),
      hospitalName: r.fromHospitalName,
      sectorName: r.fromSectorName,
    },
    toShift: r.toShiftInstanceId
      ? {
          id: r.toShiftInstanceId,
          label: r.toShiftLabel!,
          startAt: dateFromExecute(r.toShiftStartAt!),
          endAt: dateFromExecute(r.toShiftEndAt!),
          hospitalName: r.toHospitalName!,
          sectorName: r.toSectorName!,
        }
      : null,
    toProfessionalId:
      r.toProfessionalId == null ? null : Number(r.toProfessionalId),
    toUserId: r.toUserId == null ? null : Number(r.toUserId),
    canRespond: listedOfferCanRespond(
      r.toProfessionalId,
      r.toUserId,
      actor.professionalId,
      userId,
    ),
  }));
}

async function countActionableSwapOffers(ctx: TrpcContext): Promise<number> {
  const rows = await queryListAvailableRows(ctx, {});
  return rows.filter((row) => row.canRespond).length;
}

export const swapRouter = router({
  // ── offer ─────────────────────────────────────────────────────────────────
  // CESSAO and TRANSFER are functionally equivalent (one-way handoff
  // A → B). CESSAO is the canonical name per product spec
  // (docs/product/escala-ux.md §6); TRANSFER stays accepted while older
  // mobile clients migrate.
  offer: protectedProcedure
    .input(
      z.object({
        type: z.enum(["SWAP", "TRANSFER", "CESSAO"]),
        fromShiftInstanceId: z.number(),
        fromAssignmentId: z.number(),
        toShiftInstanceId: z.number().optional(),
        /** Oferta DIRECIONADA: só este profissional vê e pode aceitar
            (usada pelo comando de voz "trocar com Fulano"). */
        toProfessionalId: z.number().optional(),
        reason: z.string().max(500).optional(),
        expiresInHours: z.number().min(1).max(720).default(48),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const actor = await getTenantActorFromContext(ctx);
      if (!actor.professionalId)
        throw topologyDenied("Ator sem identidade profissional canônica");
      return createSwapOffer(
        {
          type: input.type,
          fromShiftInstanceId: input.fromShiftInstanceId,
          fromAssignmentId: input.fromAssignmentId,
          toShiftInstanceId: input.toShiftInstanceId,
          toProfessionalId: input.toProfessionalId,
          reason: input.reason,
          expiresInHours: input.expiresInHours,
        },
        {
          userId: ctx.user!.id,
          professionalId: actor.professionalId,
          expectedSessionVersion: ctx.user!.sessionVersion,
          institutionId: ctx.institutionId,
        },
      );
    }),

  // ── accept ────────────────────────────────────────────────────────────────
  // Um passo: quem assume transfere a alocação na mesma transação
  // (PENDING → APPROVED). Não deixa o dono com "Aprovar candidatura".
  accept: protectedProcedure
    .input(z.object({ swapRequestId: z.number() }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db)
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "DB unavailable",
        });

      const expectedSessionVersion = ctx.user!.sessionVersion;
      const institutionId = ctx.institutionId;
      const actor = await getTenantActorFromContext(ctx);
      if (!actor.professionalId)
        throw topologyDenied("Ator sem identidade profissional canônica");

      const [swap] = await db
        .select()
        .from(swapRequests)
        .where(
          and(
            eq(swapRequests.id, input.swapRequestId),
            eq(swapRequests.institutionId, institutionId),
          ),
        );
      if (!swap)
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Solicitação não encontrada",
        });

      if (swap.status === "APPROVED") {
        throw new TRPCError({
          code: "CONFLICT",
          message: "Esta solicitação já foi efetivada ou cancelada.",
        });
      }
      if (swap.status === "ACCEPTED") {
        await assertActorCanReadSwap(actor, swap);
        throw new TRPCError({
          code: "CONFLICT",
          message:
            "Esta candidatura antiga aguarda a conclusão pelo dono do plantão original.",
        });
      }

      const preflight = await requirePendingSwapForRecipient(
        db,
        swap,
        actor,
        false,
        expectedSessionVersion,
      );
      assertSwapShiftsNotStarted(
        preflight.source.shift,
        preflight.toTuple?.shift ?? null,
      );
      await assertNoSwapTimeConflicts(
        db,
        swap,
        preflight.source,
        preflight.professional,
        preflight.toTuple,
      );
      await db.transaction(async (tx) => {
        const monthTargets: MonthLockTarget[] = [
          {
            institutionId: preflight.source.shift.institutionId,
            hospitalId: preflight.source.shift.hospitalId,
            date: preflight.source.shift.startAt,
          },
        ];
        if (preflight.toTuple) {
          monthTargets.push({
            institutionId: preflight.toTuple.shift.institutionId,
            hospitalId: preflight.toTuple.shift.hospitalId,
            date: preflight.toTuple.shift.startAt,
          });
        }
        await assertPublishedSwapMonthsForUpdate(tx, monthTargets);
        const [current] = await tx
          .select()
          .from(swapRequests)
          .where(
            and(
              eq(swapRequests.id, swap.id),
              eq(swapRequests.institutionId, institutionId),
            ),
          )
          .limit(1)
          .for("update");
        if (!current || current.version !== swap.version) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "Esta oferta já foi respondida por outra pessoa.",
          });
        }
        await lockSwapShiftsForUpdate(tx, current.institutionId, [
          current.fromShiftInstanceId,
          current.toShiftInstanceId,
        ]);
        const assignmentProfessionalIds = await lockSwapAssignmentsForUpdate(
          tx,
          current.institutionId,
          [current.fromShiftInstanceId, current.toShiftInstanceId],
        );
        await lockAssignmentProfessionalsForUpdate(
          tx,
          [
            ...assignmentProfessionalIds,
            current.fromProfessionalId,
            current.toProfessionalId,
            actor.professionalId,
          ].filter((id): id is number => typeof id === "number"),
        );
        const locked = await requirePendingSwapForRecipient(
          tx,
          current,
          actor,
          true,
          expectedSessionVersion,
        );
        assertSwapShiftsNotStarted(
          locked.source.shift,
          locked.toTuple?.shift ?? null,
        );
        assertSameSwapSchedulingSnapshot(
          preflight.source.shift,
          locked.source.shift,
          preflight.toTuple?.shift ?? null,
          locked.toTuple?.shift ?? null,
          "A topologia do plantão mudou enquanto a oferta era aceita.",
        );
        await assertAssignmentWritesAllowedForUpdate(
          tx,
          assignmentWriteCandidatesForSwap(
            current,
            locked.source,
            locked.professional,
            locked.toTuple,
          ),
          {
            additionalProfessionalIds: [
              locked.source.professional.professionalId,
            ],
          },
        );
        const acceptAudit = auditNames(current.type, "ACCEPTED");
        await applySwapAssignmentTransfer(tx, {
          currentSwap: current,
          expectedStatus: "PENDING",
          topology: {
            source: locked.source,
            recipient: locked.professional,
            toTuple: locked.toTuple,
          },
          actor,
          reviewer: {
            professional: locked.professional,
            auditRole: locked.professional.roleInInstitution,
          },
          description: `${acceptAudit.label} assumida pelo profissional #${locked.professional.professionalId}`,
          approvalPath: "TAKE",
          extraUpdate: {
            toProfessionalId: locked.professional.professionalId,
            toUserId: locked.professional.userId,
            toAssignmentId: locked.toTuple?.assignmentId ?? null,
          },
        });
      }, ASSIGNMENT_WRITE_TRANSACTION_CONFIG);

      return { ok: true };
    }),

  // ── reject (by peer) ─────────────────────────────────────────────────────
  reject: protectedProcedure
    .input(z.object({ swapRequestId: z.number() }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db)
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "DB unavailable",
        });

      const userId = ctx.user!.id;
      const expectedSessionVersion = ctx.user!.sessionVersion;
      const institutionId = ctx.institutionId;
      const actor = await getTenantActorFromContext(ctx);
      if (!actor.professionalId) {
        throw topologyDenied("Ator sem identidade profissional canônica");
      }

      await db.transaction(async (tx) => {
        const current = await lockSwapRequestForUpdate(
          tx,
          input.swapRequestId,
          institutionId,
        );
        assertExpectedSwapStatus(current, ["PENDING"]);
        if (current.fromUserId === userId) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Use 'cancelar' para cancelar sua oferta",
          });
        }

        await lockSwapMutationTopology(tx, current, [actor.professionalId]);
        const recipient = await requirePendingSwapForRecipient(
          tx,
          current,
          actor,
          true,
          expectedSessionVersion,
        );

        if (isOpenSwapOffer(current)) {
          const [alreadyDismissed] = await tx
            .select({ id: swapRequestDismissals.id })
            .from(swapRequestDismissals)
            .where(
              and(
                eq(swapRequestDismissals.swapRequestId, current.id),
                eq(swapRequestDismissals.institutionId, current.institutionId),
                eq(swapRequestDismissals.userId, userId),
              ),
            )
            .limit(1);
          if (alreadyDismissed) {
            throw new TRPCError({
              code: "CONFLICT",
              message: "Você já recusou esta oferta.",
            });
          }
          try {
            const [inserted] = await tx
              .insert(swapRequestDismissals)
              .values({
                swapRequestId: current.id,
                institutionId: current.institutionId,
                userId,
                professionalId: recipient.professional.professionalId,
              })
              .$returningId();
            if (!inserted?.id) {
              throw new TRPCError({
                code: "CONFLICT",
                message: "Você já recusou esta oferta.",
              });
            }
          } catch (error) {
            if (error instanceof TRPCError) throw error;
            if (isMysqlDuplicateKey(error)) {
              throw new TRPCError({
                code: "CONFLICT",
                message: "Você já recusou esta oferta.",
              });
            }
            throw error;
          }
        } else {
          await transitionSwapStatusForUpdate(tx, current, ["PENDING"], {
            status: "REJECTED_BY_PEER",
          });
        }

        const rejectAudit = auditNames(current.type, "REJECTED");
        await recordAudit(
          {
            action: rejectAudit.action,
            entityType: rejectAudit.entityType,
            entityId: current.id,
            actorUserId: userId,
            actorRole: recipient.professional.roleInInstitution,
            actorName: recipient.professional.name,
            description: isOpenSwapOffer(current)
              ? `Solicitação #${current.id} recusada só para o profissional; a oferta aberta permanece`
              : `Solicitação #${current.id} rejeitada pelo profissional`,
            fromProfessionalId: current.fromProfessionalId,
            toProfessionalId: recipient.professional.professionalId,
            fromUserId: current.fromUserId,
            toUserId: recipient.professional.userId,
            shiftInstanceId: current.fromShiftInstanceId,
            hospitalId: current.hospitalId,
            sectorId: current.sectorId ?? undefined,
            institutionId: current.institutionId,
          },
          { db: tx, strict: true },
        );
      }, ASSIGNMENT_WRITE_TRANSACTION_CONFIG);

      return { ok: true };
    }),

  // ── approveByOwner ───────────────────────────────────────────────────────
  // Caminho residual para candidaturas antigas em ACCEPTED.
  // O fluxo novo completa no `accept`. Pré-condições:
  //   - swap.status === "ACCEPTED"
  //   - swap.fromUserId === ctx.user.id
  approveByOwner: protectedProcedure
    .input(
      z.object({
        swapRequestId: z.number(),
        note: z.string().max(500).optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db)
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "DB unavailable",
        });

      const userId = ctx.user!.id;
      const expectedSessionVersion = ctx.user!.sessionVersion;
      const institutionId = ctx.institutionId;
      const actor = await getTenantActorFromContext(ctx);

      const [swap] = await db
        .select()
        .from(swapRequests)
        .where(
          and(
            eq(swapRequests.id, input.swapRequestId),
            eq(swapRequests.institutionId, institutionId),
          ),
        );
      if (!swap)
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Solicitação não encontrada",
        });

      if (swap.fromUserId !== userId) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message:
            "Apenas o dono do plantão original pode aprovar a candidatura",
        });
      }

      if (swap.status !== "ACCEPTED") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Status atual é ${swap.status}, esperava ACCEPTED`,
        });
      }

      const ownerAudit = auditNames(swap.type, "APPROVED_BY_OWNER");
      await effectuateApprovedSwap(
        db,
        swap,
        actor,
        expectedSessionVersion,
        input.note,
        `${ownerAudit.label} #${swap.id} aprovada pelo dono do plantão`,
      );

      return { ok: true };
    }),

  // ── legacy manager decisions (deny-only) ─────────────────────────────────
  // Mantidos apenas para clientes antigos receberem uma negação explícita.
  // O contrato canônico é integralmente A↔B; gestor consulta o histórico,
  // mas não aprova nem bloqueia SWAP, TRANSFER ou CESSAO.
  approve: protectedProcedure
    .input(
      z.object({
        swapRequestId: z.number(),
        note: z.string().max(500).optional(),
      }),
    )
    .mutation(() => {
      throw new TRPCError({
        code: "FORBIDDEN",
        message:
          "Gestores têm acesso somente ao histórico; a decisão pertence ao ofertante e ao candidato",
      });
    }),

  rejectByManager: protectedProcedure
    .input(
      z.object({
        swapRequestId: z.number(),
        note: z.string().max(500).optional(),
      }),
    )
    .mutation(() => {
      throw new TRPCError({
        code: "FORBIDDEN",
        message:
          "Gestores têm acesso somente ao histórico; a decisão pertence ao ofertante e ao candidato",
      });
    }),

  // ── cancel ────────────────────────────────────────────────────────────────
  cancel: protectedProcedure
    .input(z.object({ swapRequestId: z.number() }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db)
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "DB unavailable",
        });

      const userId = ctx.user!.id;
      const expectedSessionVersion = ctx.user!.sessionVersion;
      const institutionId = ctx.institutionId;
      const actor = await getTenantActorFromContext(ctx);
      if (!actor.professionalId) {
        throw topologyDenied("Ator sem identidade profissional canônica");
      }

      await db.transaction(async (tx) => {
        const current = await lockSwapRequestForUpdate(
          tx,
          input.swapRequestId,
          institutionId,
        );
        assertExpectedSwapStatus(current, ["PENDING", "ACCEPTED"]);
        // A candidatura ACCEPTED é um resíduo legado que pode precisar ser
        // descartado justamente porque uma das tuplas já não é válida. Para
        // PENDING, a oferta ainda é operacional e exige topologia completa;
        // para ACCEPTED, somente as duas identidades registradas podem
        // cancelar, sem alterar alocações.
        if (current.status === "PENDING") {
          await lockSwapMutationTopology(tx, current, [actor.professionalId]);
        }
        const reviewer = await requireSwapCancelActor(
          tx,
          actor,
          current,
          expectedSessionVersion,
        );
        await transitionSwapStatusForUpdate(
          tx,
          current,
          ["PENDING", "ACCEPTED"],
          { status: "CANCELLED" },
        );

        const cancelAudit = auditNames(current.type, "CANCELLED");
        const isOwner =
          current.fromUserId === actor.userId &&
          current.fromProfessionalId === reviewer.professional.professionalId;
        await recordAudit(
          {
            action: cancelAudit.action,
            entityType: cancelAudit.entityType,
            entityId: current.id,
            actorUserId: userId,
            actorRole: reviewer.auditRole,
            actorName: reviewer.professional.name,
            description: isOwner
              ? `Solicitação #${current.id} cancelada pelo ofertante`
              : `Candidatura antiga #${current.id} desfeita pelo profissional que havia assumido`,
            fromProfessionalId: current.fromProfessionalId,
            fromUserId: current.fromUserId,
            shiftInstanceId: current.fromShiftInstanceId,
            hospitalId: current.hospitalId,
            sectorId: current.sectorId ?? undefined,
            institutionId: current.institutionId,
          },
          { db: tx, strict: true },
        );
      }, ASSIGNMENT_WRITE_TRANSACTION_CONFIG);

      return { ok: true };
    }),

  // ── list ──────────────────────────────────────────────────────────────────
  // role:
  //   "OFFERER"  — apenas as solicitações onde sou o ofertante (A).
  //   "RECEIVER" — onde sou o aceitante (B).
  //   "ANY"      — comportamento legado: qualquer envolvimento (default).
  // Consulta estritamente de leitura. Um residual ACCEPTED permanece visível
  // até que o ofertante use `approveByOwner` ou uma das partes o cancele.
  list: protectedProcedure
    .input(
      z.object({
        status: z.string().optional(),
        type: z.enum(["SWAP", "TRANSFER", "CESSAO"]).optional(),
        role: z.enum(["OFFERER", "RECEIVER", "ANY"]).default("ANY"),
        limit: z.number().min(1).max(200).default(50),
        offset: z.number().min(0).default(0),
      }),
    )
    .query(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db)
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "DB unavailable",
        });

      const userId = ctx.user!.id;
      const institutionId = ctx.institutionId;
      const actor = await getTenantActorFromContext(ctx);
      if (!actor.professionalId)
        throw topologyDenied("Ator sem identidade profissional canônica");

      // Filtros (status/type/role e "só os meus" para não-gestor) são
      // aplicados inline no SQL abaixo.

      const rows = await db.execute(sql`
        SELECT
          sr.id,
          sr.type,
          sr.status,
          sr.reason,
          sr.review_note        AS reviewNote,
          sr.expires_at         AS expiresAt,
          sr.created_at         AS createdAt,
          sr.reviewed_at        AS reviewedAt,
          sr.from_professional_id AS fromProfessionalId,
          sr.to_professional_id   AS toProfessionalId,
          sr.from_user_id         AS fromUserId,
          sr.to_user_id           AS toUserId,
          sr.from_shift_instance_id AS fromShiftInstanceId,
          sr.to_shift_instance_id   AS toShiftInstanceId,
          -- from professional
          fp.name               AS fromProfessionalName,
          fp.role               AS fromProfessionalRole,
          -- to professional
          tp.name               AS toProfessionalName,
          tp.role               AS toProfessionalRole,
          -- from shift
          fsi.label             AS fromShiftLabel,
          fsi.start_at          AS fromShiftStartAt,
          fsi.end_at            AS fromShiftEndAt,
          fh.name               AS fromHospitalName,
          fs.name               AS fromSectorName,
          -- to shift (SWAP only)
          tsi.label             AS toShiftLabel,
          tsi.start_at          AS toShiftStartAt,
          tsi.end_at            AS toShiftEndAt,
          th.name               AS toHospitalName,
          ts.name               AS toSectorName,
          -- reviewer
          ru.name               AS reviewerName
        FROM swap_requests sr
        JOIN professionals fp       ON fp.id  = sr.from_professional_id
        LEFT JOIN professionals tp  ON tp.id  = sr.to_professional_id
        JOIN shift_instances fsi    ON fsi.id = sr.from_shift_instance_id
        JOIN hospitals fh           ON fh.id  = fsi.hospital_id
        JOIN sectors fs             ON fs.id  = fsi.sector_id
        LEFT JOIN shift_instances tsi ON tsi.id = sr.to_shift_instance_id
        LEFT JOIN hospitals th      ON th.id  = tsi.hospital_id
        LEFT JOIN sectors ts        ON ts.id  = tsi.sector_id
        LEFT JOIN users ru          ON ru.id  = sr.reviewed_by_user_id
        WHERE 1=1
          AND sr.institution_id = ${institutionId}
          ${input.status ? sql`AND sr.status = ${input.status}` : sql``}
          ${input.type ? sql`AND sr.type = ${input.type}` : sql``}
          ${input.role === "OFFERER" ? sql`AND sr.from_user_id = ${userId}` : sql``}
          ${input.role === "RECEIVER" ? sql`AND sr.to_user_id = ${userId}` : sql``}
          ${
            !isInstitutionManager(actor)
              ? sql`AND (sr.from_professional_id = ${actor.professionalId} OR sr.to_professional_id = ${actor.professionalId})`
              : sql``
          }
        ORDER BY sr.created_at DESC
        LIMIT ${input.limit}
        OFFSET ${input.offset}
      `);

      const data = (rows as any)[0] as any[];
      const candidateIds = data
        .map((row) => Number(row.id))
        .filter(Number.isInteger);
      const candidateSwaps = candidateIds.length
        ? await db
            .select()
            .from(swapRequests)
            .where(
              and(
                eq(swapRequests.institutionId, institutionId),
                inArray(swapRequests.id, candidateIds),
              ),
            )
        : [];
      const readableSwaps = await filterReadableSwaps(
        db,
        actor,
        candidateSwaps,
      );
      const readableById = new Map(
        readableSwaps.map((entry) => [entry.swap.id, entry]),
      );

      return data
        .filter((r: any) => readableById.has(Number(r.id)))
        .map((r: any) => {
          const readable = readableById.get(Number(r.id));
          if (!readable) {
            throw new Error("SWAP_READABILITY_INTEGRITY_FAILURE");
          }
          if (readable.view === "STALE_ACCEPTED_PARTICIPANT") {
            return staleAcceptedResidualListItem(readable.swap);
          }
          const status = r.status;
          const isOwner =
            Number(r.fromUserId) === actor.userId &&
            Number(r.fromProfessionalId) === actor.professionalId;
          const isRecipient =
            Number(r.toUserId) === actor.userId &&
            Number(r.toProfessionalId) === actor.professionalId;
          const canCancel =
            (status === "PENDING" && isOwner) ||
            (status === "ACCEPTED" && (isOwner || isRecipient));
          return {
            id: r.id,
            type: r.type,
            status,
            reason: r.reason,
            reviewNote: r.reviewNote,
            expiresAt: r.expiresAt ? new Date(r.expiresAt) : null,
            createdAt: new Date(r.createdAt),
            reviewedAt: r.reviewedAt ? new Date(r.reviewedAt) : null,
            fromProfessional: {
              id: r.fromProfessionalId,
              name: r.fromProfessionalName,
              role: r.fromProfessionalRole,
            },
            toProfessional: r.toProfessionalId
              ? {
                  id: r.toProfessionalId,
                  name: r.toProfessionalName,
                  role: r.toProfessionalRole,
                }
              : null,
            fromShift: {
              id: r.fromShiftInstanceId,
              label: r.fromShiftLabel,
              startAt: new Date(r.fromShiftStartAt),
              endAt: new Date(r.fromShiftEndAt),
              hospitalName: r.fromHospitalName,
              sectorName: r.fromSectorName,
            },
            toShift: r.toShiftInstanceId
              ? {
                  id: r.toShiftInstanceId,
                  label: r.toShiftLabel,
                  startAt: new Date(r.toShiftStartAt),
                  endAt: new Date(r.toShiftEndAt),
                  hospitalName: r.toHospitalName,
                  sectorName: r.toSectorName,
                }
              : null,
            reviewerName: r.reviewerName ?? null,
            // Sinal de interface, nunca autorização: approveByOwner revalida
            // dono, vínculo e topologia dentro da transação de escrita.
            awaitingMyApproval: status === "ACCEPTED" && isOwner,
            canCancel,
            cancellationOnly: false,
          };
        });
    }),

  // ── getById ───────────────────────────────────────────────────────────────
  getById: protectedProcedure
    .input(z.object({ id: z.number() }))
    .query(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db)
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "DB unavailable",
        });
      const institutionId = ctx.institutionId;
      const actor = await getTenantActorFromContext(ctx);
      const [swap] = await db
        .select()
        .from(swapRequests)
        .where(
          and(
            eq(swapRequests.id, input.id),
            eq(swapRequests.institutionId, institutionId),
          ),
        )
        .limit(1);
      if (!swap)
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Solicitação não encontrada",
        });
      const readView = await resolveSwapReadView(db, actor, swap);
      if (readView === "STALE_ACCEPTED_PARTICIPANT") {
        return staleAcceptedResidualDetails(swap);
      }

      const rows = await db.execute(sql`
        SELECT
          sr.*,
          fp.name  AS from_professional_name,
          fp.role  AS from_professional_role,
          tp.name  AS to_professional_name,
          tp.role  AS to_professional_role,
          fsi.label AS from_shift_label,
          fsi.start_at AS from_shift_start_at,
          fsi.end_at   AS from_shift_end_at,
          fh.name  AS from_hospital_name,
          fs.name  AS from_sector_name,
          tsi.label AS to_shift_label,
          tsi.start_at AS to_shift_start_at,
          tsi.end_at   AS to_shift_end_at,
          th.name  AS to_hospital_name,
          ts2.name AS to_sector_name,
          ru.name  AS reviewer_name
        FROM swap_requests sr
        JOIN professionals fp       ON fp.id  = sr.from_professional_id
        LEFT JOIN professionals tp  ON tp.id  = sr.to_professional_id
        JOIN shift_instances fsi    ON fsi.id = sr.from_shift_instance_id
        JOIN hospitals fh           ON fh.id  = fsi.hospital_id
        JOIN sectors fs             ON fs.id  = fsi.sector_id
        LEFT JOIN shift_instances tsi ON tsi.id = sr.to_shift_instance_id
        LEFT JOIN hospitals th      ON th.id  = tsi.hospital_id
        LEFT JOIN sectors ts2       ON ts2.id = tsi.sector_id
        LEFT JOIN users ru          ON ru.id  = sr.reviewed_by_user_id
        WHERE sr.id = ${input.id}
          AND sr.institution_id = ${institutionId}
        LIMIT 1
      `);

      const data = (rows as any)[0] as any[];
      if (!data[0])
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Solicitação não encontrada",
        });

      const r = data[0];
      return {
        id: r.id,
        type: r.type,
        status: r.status,
        reason: r.reason,
        reviewNote: r.review_note,
        expiresAt: r.expires_at ? new Date(r.expires_at) : null,
        createdAt: new Date(r.created_at),
        updatedAt: new Date(r.updated_at),
        reviewedAt: r.reviewed_at ? new Date(r.reviewed_at) : null,
        version: r.version,
        fromProfessional: {
          id: r.from_professional_id,
          name: r.from_professional_name,
          role: r.from_professional_role,
        },
        toProfessional: r.to_professional_id
          ? {
              id: r.to_professional_id,
              name: r.to_professional_name,
              role: r.to_professional_role,
            }
          : null,
        fromShift: {
          id: r.from_shift_instance_id,
          label: r.from_shift_label,
          startAt: new Date(r.from_shift_start_at),
          endAt: new Date(r.from_shift_end_at),
          hospitalName: r.from_hospital_name,
          sectorName: r.from_sector_name,
        },
        toShift: r.to_shift_instance_id
          ? {
              id: r.to_shift_instance_id,
              label: r.to_shift_label,
              startAt: new Date(r.to_shift_start_at),
              endAt: new Date(r.to_shift_end_at),
              hospitalName: r.to_hospital_name,
              sectorName: r.to_sector_name,
            }
          : null,
        fromAssignmentId: r.from_assignment_id,
        toAssignmentId: r.to_assignment_id,
        reviewerName: r.reviewer_name ?? null,
        institutionId: r.institution_id,
        hospitalId: r.hospital_id,
        sectorId: r.sector_id,
        cancellationOnly: false,
      };
    }),

  // ── listAvailable ─────────────────────────────────────────────────────────
  listAvailable: protectedProcedure
    .input(listAvailableInputSchema)
    .query(async ({ input, ctx }) => queryListAvailableRows(ctx, input)),

  // ── countActionable ───────────────────────────────────────────────────────
  // Contagem server-side de ofertas que exigem ação do usuário atual.
  // Mesma regra de listAvailable + canRespond; não usa notifications.read.
  countActionable: protectedProcedure.query(async ({ ctx }) => ({
    swapOffers: await countActionableSwapOffers(ctx),
  })),
});

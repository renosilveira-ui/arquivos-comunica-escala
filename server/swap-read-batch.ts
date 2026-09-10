import { and, desc, eq, gt, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import {
  hospitals,
  institutions,
  managerScope,
  professionalAccess,
  professionalInstitutions,
  professionals,
  sectors,
  scheduleInvites,
  shiftAssignmentsV2,
  shiftInstances,
  swapRequests,
  users,
} from "../drizzle/schema";
import type { TenantActor } from "./_core/policy";
import {
  qualificationMatches,
  selectActiveScheduleContexts,
  type ActiveScheduleContext,
} from "./schedule-contexts";
import { isOneWay, type SwapRow } from "./swap-domain";

export type SwapReadView = "FULL" | "STALE_ACCEPTED_PARTICIPANT";

type BatchProfessional = {
  professionalId: number;
  userId: number;
  medicalSpecialtyId: number | null;
  operationalProfileCode:
    "MEDICO_GENERALISTA" | "RESIDENTE_ANESTESIOLOGIA" | null;
  roleInInstitution: "USER" | "GESTOR_MEDICO" | "GESTOR_PLUS";
};

type BatchAccess = {
  professionalId: number;
  hospitalId: number;
  sectorId: number | null;
};

type BatchScope = {
  professionalId: number;
  hospitalId: number;
  sectorId: number | null;
};

type BatchInvite = {
  userId: number;
  hospitalId: number;
  sectorId: number;
};

type BatchAssignment = typeof shiftAssignmentsV2.$inferSelect;
type BatchShift = typeof shiftInstances.$inferSelect;
type BatchTopology = Pick<BatchShift, "hospitalId" | "sectorId">;

export type SwapReadBatchSnapshot = {
  contexts: Map<number, ActiveScheduleContext>;
  contextCountsByTopology: Map<string, number>;
  shifts: Map<number, BatchShift>;
  professionals: Map<number, BatchProfessional>;
  accesses: BatchAccess[];
  scopes: BatchScope[];
  invites: BatchInvite[];
  assignments: BatchAssignment[];
};

function contextTopologyKey(
  context: Pick<
    ActiveScheduleContext,
    "institutionId" | "hospitalId" | "sectorId"
  >,
): string {
  return `${context.institutionId}:${context.hospitalId}:${context.sectorId}`;
}

export function isRecordedSwapParticipant(
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

function batchAccessCovers(
  batch: SwapReadBatchSnapshot,
  professionalId: number,
  shift: BatchShift,
  context: ActiveScheduleContext,
): boolean {
  return batch.accesses.some(
    (access) =>
      access.professionalId === professionalId &&
      access.hospitalId === shift.hospitalId &&
      (context.admissionPolicy === "QUALIFICATION_ALLOWLIST"
        ? access.sectorId === shift.sectorId
        : access.sectorId === null || access.sectorId === shift.sectorId),
  );
}

function batchHasProfessionalAccess(
  batch: SwapReadBatchSnapshot,
  professionalId: number,
  shift: BatchShift,
): boolean {
  return batch.accesses.some(
    (access) =>
      access.professionalId === professionalId &&
      access.hospitalId === shift.hospitalId &&
      (access.sectorId === null || access.sectorId === shift.sectorId),
  );
}

function batchScopeCovers(
  batch: SwapReadBatchSnapshot,
  professionalId: number,
  topology: BatchTopology,
): boolean {
  return batch.scopes.some(
    (scope) =>
      scope.professionalId === professionalId &&
      scope.hospitalId === topology.hospitalId &&
      (scope.sectorId === null || scope.sectorId === topology.sectorId),
  );
}

function canonicalBatchShift(
  batch: SwapReadBatchSnapshot,
  input: {
    id: number | null;
    institutionId: number;
    hospitalId?: number | null;
    sectorId?: number | null;
  },
): { shift: BatchShift; context: ActiveScheduleContext } | null {
  if (!input.id) return null;
  const shift = batch.shifts.get(input.id);
  if (
    !shift ||
    shift.institutionId !== input.institutionId ||
    (input.hospitalId !== undefined && shift.hospitalId !== input.hospitalId) ||
    (input.sectorId !== undefined && shift.sectorId !== input.sectorId) ||
    shift.scheduleContextId === null
  ) {
    return null;
  }
  const context = batch.contexts.get(shift.scheduleContextId);
  if (
    !context ||
    context.institutionId !== shift.institutionId ||
    context.hospitalId !== shift.hospitalId ||
    context.sectorId !== shift.sectorId
  ) {
    return null;
  }
  if (
    (batch.contextCountsByTopology.get(contextTopologyKey(context)) ?? 0) !== 1
  ) {
    throw new TRPCError({
      code: "CONFLICT",
      message:
        "Setor com mais de uma escala operacional ativa; regularize a topologia antes de continuar.",
    });
  }
  return { shift, context };
}

function batchInviteCovers(
  batch: SwapReadBatchSnapshot,
  userId: number,
  target: { shift: BatchShift },
): boolean {
  return batch.invites.some(
    (invite) =>
      invite.userId === userId &&
      invite.hospitalId === target.shift.hospitalId &&
      invite.sectorId === target.shift.sectorId,
  );
}

function batchProfessionalCanReceive(
  batch: SwapReadBatchSnapshot,
  professionalId: number,
  userId: number,
  target: { shift: BatchShift; context: ActiveScheduleContext },
): boolean {
  const professional = batch.professionals.get(professionalId);
  const admitted = Boolean(
    professional &&
    (professional.roleInInstitution === "GESTOR_PLUS" ||
      batchScopeCovers(batch, professionalId, target.shift) ||
      batchAccessCovers(batch, professionalId, target.shift, target.context) ||
      batchInviteCovers(batch, userId, target)),
  );
  return Boolean(
    professional &&
    professional.userId === userId &&
    batchHasProfessionalAccess(batch, professionalId, target.shift) &&
    admitted &&
    qualificationMatches(
      {
        medicalSpecialtyId: professional.medicalSpecialtyId,
        operationalProfileCode: professional.operationalProfileCode,
      },
      target.context,
    ),
  );
}

function batchProfessionalCanOwn(
  batch: SwapReadBatchSnapshot,
  professionalId: number,
  userId: number,
  target: { shift: BatchShift; context: ActiveScheduleContext },
): boolean {
  const professional = batch.professionals.get(professionalId);
  if (!professional || professional.userId !== userId) return false;
  if (professional.roleInInstitution === "GESTOR_PLUS") return true;
  if (batchScopeCovers(batch, professionalId, target.shift)) return true;
  return batchProfessionalCanReceive(batch, professionalId, userId, target);
}

function matchingAssignments(
  batch: SwapReadBatchSnapshot,
  input: {
    shift: BatchShift;
    professionalId: number;
    assignmentId?: number | null;
  },
): BatchAssignment[] {
  return batch.assignments.filter(
    (assignment) =>
      assignment.shiftInstanceId === input.shift.id &&
      assignment.institutionId === input.shift.institutionId &&
      assignment.hospitalId === input.shift.hospitalId &&
      assignment.sectorId === input.shift.sectorId &&
      assignment.professionalId === input.professionalId &&
      (input.assignmentId == null || assignment.id === input.assignmentId),
  );
}

function batchAssignmentMatches(
  batch: SwapReadBatchSnapshot,
  input: {
    shift: BatchShift;
    professionalId: number;
    assignmentId?: number | null;
    requireActive: boolean;
    suppressIntegrityConflict?: boolean;
  },
): boolean {
  if (!input.requireActive) {
    const historical = matchingAssignments(batch, input);
    if (historical.length > 1 && !input.suppressIntegrityConflict) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "A tupla possui mais de uma alocação canônica possível",
      });
    }
    return historical.length === 1;
  }
  const active = matchingAssignments(batch, {
    shift: input.shift,
    professionalId: input.professionalId,
  }).filter((assignment) => assignment.isActive);
  if (active.length > 1) {
    if (input.suppressIntegrityConflict) return false;
    throw new TRPCError({
      code: "CONFLICT",
      message:
        "Há alocações ativas duplicadas para a mesma tupla profissional/turno",
    });
  }
  if (active[0] && active[0].status !== "OCUPADO") {
    if (input.suppressIntegrityConflict) return false;
    throw new TRPCError({
      code: "CONFLICT",
      message:
        "A alocação ainda não está confirmada como OCUPADO para troca ou cessão",
    });
  }
  return Boolean(
    active[0] &&
    (input.assignmentId == null || active[0].id === input.assignmentId),
  );
}

function validBatchSwapShape(swap: SwapRow): boolean {
  const hasToProfessional = swap.toProfessionalId !== null;
  const hasToUser = swap.toUserId !== null;
  if (hasToProfessional !== hasToUser) return false;
  if (isOneWay(swap.type)) {
    return swap.toShiftInstanceId === null && swap.toAssignmentId === null;
  }
  if (
    !swap.toShiftInstanceId ||
    swap.toShiftInstanceId === swap.fromShiftInstanceId
  ) {
    return false;
  }
  if (swap.status === "ACCEPTED" || swap.status === "APPROVED") {
    return Boolean(
      swap.toProfessionalId && swap.toUserId && swap.toAssignmentId,
    );
  }
  return swap.status !== "PENDING" || swap.toAssignmentId === null;
}

function isLiveSwapStatus(status: SwapRow["status"]): boolean {
  return status === "PENDING" || status === "ACCEPTED";
}

function hasCanonicalBatchOccupant(
  batch: SwapReadBatchSnapshot,
  target: { shift: BatchShift; context: ActiveScheduleContext },
): boolean {
  return batch.assignments.some((assignment) => {
    if (
      assignment.shiftInstanceId !== target.shift.id ||
      assignment.institutionId !== target.shift.institutionId ||
      assignment.hospitalId !== target.shift.hospitalId ||
      assignment.sectorId !== target.shift.sectorId ||
      !assignment.isActive ||
      assignment.status !== "OCUPADO"
    ) {
      return false;
    }
    const professional = batch.professionals.get(assignment.professionalId);
    return Boolean(
      professional &&
      batchProfessionalCanOwn(
        batch,
        assignment.professionalId,
        professional.userId,
        target,
      ) &&
      batchAssignmentMatches(batch, {
        shift: target.shift,
        professionalId: assignment.professionalId,
        assignmentId: assignment.id,
        requireActive: true,
        suppressIntegrityConflict: true,
      }),
    );
  });
}

function isCanonicalBatchSwap(
  batch: SwapReadBatchSnapshot,
  swap: SwapRow,
): boolean {
  if (!validBatchSwapShape(swap)) return false;
  const requireActive = isLiveSwapStatus(swap.status);
  const source = canonicalBatchShift(batch, {
    id: swap.fromShiftInstanceId,
    institutionId: swap.institutionId,
    hospitalId: swap.hospitalId,
    sectorId: swap.sectorId,
  });
  if (
    !source ||
    !batchProfessionalCanOwn(
      batch,
      swap.fromProfessionalId,
      swap.fromUserId,
      source,
    ) ||
    !batchAssignmentMatches(batch, {
      shift: source.shift,
      professionalId: swap.fromProfessionalId,
      assignmentId: swap.fromAssignmentId,
      requireActive,
    })
  ) {
    return false;
  }

  if (isOneWay(swap.type)) {
    return swap.toProfessionalId && swap.toUserId
      ? batchProfessionalCanReceive(
          batch,
          swap.toProfessionalId,
          swap.toUserId,
          source,
        )
      : true;
  }

  const target = canonicalBatchShift(batch, {
    id: swap.toShiftInstanceId,
    institutionId: swap.institutionId,
  });
  if (
    !target ||
    !batchProfessionalCanReceive(
      batch,
      swap.fromProfessionalId,
      swap.fromUserId,
      target,
    )
  ) {
    return false;
  }
  if (swap.toProfessionalId && swap.toUserId) {
    return (
      batchProfessionalCanReceive(
        batch,
        swap.toProfessionalId,
        swap.toUserId,
        source,
      ) &&
      batchProfessionalCanOwn(
        batch,
        swap.toProfessionalId,
        swap.toUserId,
        target,
      ) &&
      batchAssignmentMatches(batch, {
        shift: target.shift,
        professionalId: swap.toProfessionalId,
        assignmentId: swap.toAssignmentId,
        requireActive,
      })
    );
  }

  return hasCanonicalBatchOccupant(batch, target);
}

function actorCanReadBatchSwap(
  batch: SwapReadBatchSnapshot,
  actor: TenantActor,
  swap: SwapRow,
): boolean {
  if (isRecordedSwapParticipant(actor, swap)) return true;
  if (actor.isGlobalAdmin || actor.roleInInstitution === "GESTOR_PLUS") {
    return true;
  }
  return actor.roleInInstitution === "GESTOR_MEDICO" &&
    actor.professionalId !== null &&
    swap.sectorId !== null
    ? batchScopeCovers(batch, actor.professionalId, {
        hospitalId: swap.hospitalId,
        sectorId: swap.sectorId,
      })
    : false;
}

async function loadSwapReadBatch(
  db: any,
  actor: TenantActor,
  swaps: readonly SwapRow[],
): Promise<SwapReadBatchSnapshot> {
  if (swaps.length === 0) {
    return {
      contexts: new Map(),
      contextCountsByTopology: new Map(),
      shifts: new Map(),
      professionals: new Map(),
      accesses: [],
      scopes: [],
      invites: [],
      assignments: [],
    };
  }
  const institutionId = actor.institutionId;
  const shiftIds = [
    ...new Set(
      swaps.flatMap((swap) =>
        [swap.fromShiftInstanceId, swap.toShiftInstanceId].filter(
          (id): id is number => typeof id === "number",
        ),
      ),
    ),
  ];
  const assignmentIds = [
    ...new Set(
      swaps.flatMap((swap) =>
        [swap.fromAssignmentId, swap.toAssignmentId].filter(
          (id): id is number => typeof id === "number",
        ),
      ),
    ),
  ];
  const swapProfessionalIds = [
    ...new Set(
      swaps.flatMap((swap) =>
        [swap.fromProfessionalId, swap.toProfessionalId].filter(
          (id): id is number => typeof id === "number",
        ),
      ),
    ),
  ];

  // O ocupante de uma contrapartida aberta não está gravado no swap. Por isso
  // alocações e turnos vêm primeiro; a segunda fase inclui esses ocupantes no
  // mesmo lote de identidade/ACL, sem consulta individual por solicitação.
  const [contexts, canonicalShifts, assignments] = await Promise.all([
    selectActiveScheduleContexts(db, institutionId),
    db
      .select({ shift: shiftInstances })
      .from(shiftInstances)
      .innerJoin(
        institutions,
        and(
          eq(institutions.id, shiftInstances.institutionId),
          eq(institutions.isActive, true),
        ),
      )
      .innerJoin(
        hospitals,
        and(
          eq(hospitals.id, shiftInstances.hospitalId),
          eq(hospitals.institutionId, shiftInstances.institutionId),
        ),
      )
      .innerJoin(
        sectors,
        and(
          eq(sectors.id, shiftInstances.sectorId),
          eq(sectors.institutionId, shiftInstances.institutionId),
          eq(sectors.hospitalId, shiftInstances.hospitalId),
        ),
      )
      .where(
        and(
          eq(shiftInstances.institutionId, institutionId),
          inArray(shiftInstances.id, shiftIds),
        ),
      ),
    db
      .select()
      .from(shiftAssignmentsV2)
      .where(
        and(
          eq(shiftAssignmentsV2.institutionId, institutionId),
          inArray(shiftAssignmentsV2.shiftInstanceId, shiftIds),
          or(
            eq(shiftAssignmentsV2.isActive, true),
            inArray(shiftAssignmentsV2.id, assignmentIds),
          ),
        ),
      ),
  ]);
  const typedAssignments = assignments as BatchAssignment[];
  const professionalIds = [
    ...new Set([
      ...swapProfessionalIds,
      ...typedAssignments.map((assignment) => assignment.professionalId),
    ]),
  ];
  const scopeProfessionalIds = [
    ...new Set([
      ...professionalIds,
      ...(actor.professionalId ? [actor.professionalId] : []),
    ]),
  ];

  const [professionalRows, accesses, scopes] = await Promise.all([
    db
      .select({
        professionalId: professionals.id,
        userId: professionals.userId,
        medicalSpecialtyId: professionals.medicalSpecialtyId,
        operationalProfileCode: professionals.operationalProfileCode,
        roleInInstitution: professionalInstitutions.roleInInstitution,
      })
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
          eq(professionalInstitutions.institutionId, institutionId),
          eq(professionalInstitutions.active, true),
          inArray(professionalInstitutions.professionalId, professionalIds),
        ),
      ),
    db
      .select({
        professionalId: professionalAccess.professionalId,
        hospitalId: professionalAccess.hospitalId,
        sectorId: professionalAccess.sectorId,
      })
      .from(professionalAccess)
      .where(
        and(
          eq(professionalAccess.institutionId, institutionId),
          eq(professionalAccess.canAccess, true),
          inArray(professionalAccess.professionalId, professionalIds),
        ),
      ),
    db
      .select({
        professionalId: managerScope.managerProfessionalId,
        hospitalId: managerScope.hospitalId,
        sectorId: managerScope.sectorId,
      })
      .from(managerScope)
      .where(
        and(
          eq(managerScope.institutionId, institutionId),
          eq(managerScope.active, true),
          inArray(managerScope.managerProfessionalId, scopeProfessionalIds),
        ),
      ),
  ]);

  const professionalsById = new Map<number, BatchProfessional>();
  for (const row of professionalRows as BatchProfessional[]) {
    if (!professionalsById.has(row.professionalId)) {
      professionalsById.set(row.professionalId, row);
    }
  }

  const invitedUserIds = [
    ...new Set(
      (professionalRows as BatchProfessional[]).map((row) => row.userId),
    ),
  ];
  const now = new Date();
  const invites =
    invitedUserIds.length === 0
      ? []
      : await db
          .select({
            userId: scheduleInvites.invitedUserId,
            hospitalId: scheduleInvites.hospitalId,
            sectorId: scheduleInvites.sectorId,
          })
          .from(scheduleInvites)
          .where(
            and(
              eq(scheduleInvites.institutionId, institutionId),
              inArray(scheduleInvites.invitedUserId, invitedUserIds),
              isNull(scheduleInvites.revokedAt),
              isNull(scheduleInvites.declinedAt),
              gt(scheduleInvites.expiresAt, now),
              sql`${scheduleInvites.redeemedCount} < ${scheduleInvites.maxRedemptions}`,
            ),
          );
  const contextCountsByTopology = new Map<string, number>();
  for (const context of contexts as ActiveScheduleContext[]) {
    const key = contextTopologyKey(context);
    contextCountsByTopology.set(
      key,
      (contextCountsByTopology.get(key) ?? 0) + 1,
    );
  }

  return {
    contexts: new Map(
      contexts.map((context: ActiveScheduleContext) => [context.id, context]),
    ),
    contextCountsByTopology,
    shifts: new Map(
      canonicalShifts.map(({ shift }: { shift: BatchShift }) => [
        shift.id,
        shift,
      ]),
    ),
    professionals: professionalsById,
    accesses: accesses as BatchAccess[],
    scopes: scopes as BatchScope[],
    invites: (
      invites as {
        userId: number | null;
        hospitalId: number;
        sectorId: number;
      }[]
    ).flatMap((invite) =>
      invite.userId === null ? [] : [{ ...invite, userId: invite.userId }],
    ),
    assignments: typedAssignments,
  };
}

/**
 * Resolve a mesma topologia fail-closed de `requireSwapTopologyForRead`, mas
 * carrega cada coleção necessária uma vez por lote. A decisão final continua
 * por solicitação; o número de consultas não cresce por linha.
 */
export async function resolveSwapReadViewsBatch(
  db: any,
  actor: TenantActor,
  swaps: readonly SwapRow[],
): Promise<readonly { swap: SwapRow; view: SwapReadView }[]> {
  if (swaps.length === 0) return [];
  const batch = await loadSwapReadBatch(db, actor, swaps);
  return resolveSwapReadViewsFromSnapshot(batch, actor, swaps);
}

export function resolveSwapReadViewsFromSnapshot(
  batch: SwapReadBatchSnapshot,
  actor: TenantActor,
  swaps: readonly SwapRow[],
): readonly { swap: SwapRow; view: SwapReadView }[] {
  const readable: { swap: SwapRow; view: SwapReadView }[] = [];
  for (const swap of swaps) {
    if (!actorCanReadBatchSwap(batch, actor, swap)) continue;
    if (isCanonicalBatchSwap(batch, swap)) {
      readable.push({ swap, view: "FULL" });
    } else if (
      swap.status === "ACCEPTED" &&
      isRecordedSwapParticipant(actor, swap)
    ) {
      readable.push({ swap, view: "STALE_ACCEPTED_PARTICIPANT" });
    }
  }
  return readable;
}

const SWAP_LIST_CANDIDATE_BATCH_SIZE = 200;
const SWAP_LIST_MAX_CANDIDATES_SCANNED = 20_000;

export type SwapListInput = {
  status?: SwapRow["status"];
  type?: SwapRow["type"];
  role: "OFFERER" | "RECEIVER" | "ANY";
  limit: number;
  offset: number;
};

/**
 * Busca por cursor físico e só aplica offset/limit depois da validação
 * canônica. Assim um registro corrompido ou revogado não cria uma página
 * artificialmente curta e a consulta nunca volta ao validador N+1.
 */
export async function listReadableSwapPage(
  db: any,
  actor: TenantActor,
  input: SwapListInput,
): Promise<readonly { swap: SwapRow; view: SwapReadView }[]> {
  const actorProfessionalId = actor.professionalId;
  if (actorProfessionalId === null) return [];
  const selected: { swap: SwapRow; view: SwapReadView }[] = [];
  let readableToSkip = input.offset;
  let cursor: { createdAt: Date; id: number } | null = null;
  let scannedCandidates = 0;

  while (selected.length < input.limit) {
    if (scannedCandidates >= SWAP_LIST_MAX_CANDIDATES_SCANNED) {
      throw new TRPCError({
        code: "TOO_MANY_REQUESTS",
        message:
          "A consulta excedeu o limite seguro de histórico; restrinja os filtros.",
      });
    }
    const conditions = [eq(swapRequests.institutionId, actor.institutionId)];
    if (input.status) {
      conditions.push(eq(swapRequests.status, input.status));
    }
    if (input.type) {
      conditions.push(eq(swapRequests.type, input.type));
    }
    if (input.role === "OFFERER") {
      conditions.push(eq(swapRequests.fromUserId, actor.userId));
    } else if (input.role === "RECEIVER") {
      conditions.push(eq(swapRequests.toUserId, actor.userId));
    } else if (
      !actor.isGlobalAdmin &&
      actor.roleInInstitution !== "GESTOR_PLUS"
    ) {
      const participant = or(
        eq(swapRequests.fromProfessionalId, actorProfessionalId),
        eq(swapRequests.toProfessionalId, actorProfessionalId),
      );
      conditions.push(
        actor.roleInInstitution === "GESTOR_MEDICO"
          ? or(
              participant,
              sql`EXISTS (
                SELECT 1
                FROM manager_scope list_scope
                WHERE list_scope.institution_id = ${actor.institutionId}
                  AND list_scope.manager_professional_id = ${actorProfessionalId}
                  AND list_scope.hospital_id = ${swapRequests.hospitalId}
                  AND list_scope.active = 1
                  AND (
                    list_scope.sector_id IS NULL
                    OR list_scope.sector_id = ${swapRequests.sectorId}
                  )
              )`,
            )!
          : participant!,
      );
    }
    if (cursor) {
      conditions.push(
        or(
          lt(swapRequests.createdAt, cursor.createdAt),
          and(
            eq(swapRequests.createdAt, cursor.createdAt),
            lt(swapRequests.id, cursor.id),
          ),
        )!,
      );
    }

    const candidates = (await db
      .select()
      .from(swapRequests)
      .where(and(...conditions))
      .orderBy(desc(swapRequests.createdAt), desc(swapRequests.id))
      .limit(SWAP_LIST_CANDIDATE_BATCH_SIZE)) as SwapRow[];
    if (candidates.length === 0) break;
    scannedCandidates += candidates.length;

    const readable = await resolveSwapReadViewsBatch(db, actor, candidates);
    for (const entry of readable) {
      if (readableToSkip > 0) {
        readableToSkip -= 1;
        continue;
      }
      selected.push(entry);
      if (selected.length === input.limit) break;
    }

    const last = candidates[candidates.length - 1]!;
    cursor = { createdAt: last.createdAt, id: last.id };
    if (candidates.length < SWAP_LIST_CANDIDATE_BATCH_SIZE) break;
  }

  return selected;
}

export async function loadSwapListDisplayRows(
  db: any,
  institutionId: number,
  ids: readonly number[],
): Promise<any[]> {
  if (ids.length === 0) return [];
  const idList = sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  );
  const rows = await db.execute(sql`
    SELECT
      sr.id,
      sr.type,
      sr.status,
      sr.reason,
      sr.review_note          AS reviewNote,
      sr.expires_at           AS expiresAt,
      sr.created_at           AS createdAt,
      sr.reviewed_at          AS reviewedAt,
      sr.from_professional_id AS fromProfessionalId,
      sr.to_professional_id   AS toProfessionalId,
      sr.from_user_id         AS fromUserId,
      sr.to_user_id           AS toUserId,
      sr.from_shift_instance_id AS fromShiftInstanceId,
      sr.to_shift_instance_id   AS toShiftInstanceId,
      fp.name                 AS fromProfessionalName,
      fp.role                 AS fromProfessionalRole,
      tp.name                 AS toProfessionalName,
      tp.role                 AS toProfessionalRole,
      fsi.label               AS fromShiftLabel,
      fsi.start_at            AS fromShiftStartAt,
      fsi.end_at              AS fromShiftEndAt,
      fh.name                 AS fromHospitalName,
      fs.name                 AS fromSectorName,
      tsi.label               AS toShiftLabel,
      tsi.start_at            AS toShiftStartAt,
      tsi.end_at              AS toShiftEndAt,
      th.name                 AS toHospitalName,
      ts.name                 AS toSectorName,
      ru.name                 AS reviewerName
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
    WHERE sr.institution_id = ${institutionId}
      AND sr.id IN (${idList})
  `);
  return (rows as any)[0] as any[];
}

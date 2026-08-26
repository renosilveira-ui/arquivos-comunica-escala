import { z } from "zod";
import { router, protectedProcedure } from "./_core/trpc";
import { TRPCError } from "@trpc/server";
import { getDb } from "./db";
import {
  assertMonthsNotLockedForUpdate,
  type MonthLockTarget,
} from "./month-guards";
import { eq, and, or, isNull, sql, inArray } from "drizzle-orm";
import {
  swapRequests,
  shiftInstances,
  shiftAssignmentsV2,
  professionals,
  professionalInstitutions,
  professionalAccess,
  users,
  institutions,
  monthlyRosters,
} from "../drizzle/schema";
import { assertSpecialtyCompatible } from "./specialty";
import { recordAudit } from "./audit-trail";
import { recomputeShiftStatus } from "./shift-status";
import { enqueueComunicaSwapApproved } from "./integrations/comunica-plus";
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
import { assertInstitutionHierarchy } from "./_core/tenant";
import { dateFromExecute, rowsFromExecute } from "./_core/db-results";
import { yearMonthBrt } from "./local-time";
import {
  assertActiveScheduleContextTopology,
  assertProfessionalEligibleForScheduleContext,
  listAssumableScheduleContextIds,
} from "./schedule-contexts";

// ─── helpers ────────────────────────────────────────────────────────────────

type SwapType = (typeof swapRequests.$inferSelect)["type"];
type SwapRow = typeof swapRequests.$inferSelect;
type ShiftRow = typeof shiftInstances.$inferSelect;

type CanonicalProfessional = {
  professionalId: number;
  userId: number;
  email: string | null;
  name: string;
  specialty: string | null;
  role: string;
  roleInInstitution: "USER" | "GESTOR_MEDICO" | "GESTOR_PLUS";
};

type CanonicalAssignmentTuple = {
  assignmentId: number;
  assignmentType: (typeof shiftAssignmentsV2.$inferSelect)["assignmentType"];
  shift: ShiftRow;
  professional: CanonicalProfessional;
};

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
};

function topologyDenied(message: string): TRPCError {
  return new TRPCError({ code: "FORBIDDEN", message });
}

function assertSwapShiftsNotStarted(
  source: ShiftRow,
  counterpart: ShiftRow | null,
): void {
  const now = Date.now();
  const started =
    source.startAt.getTime() <= now
      ? "origem"
      : counterpart && counterpart.startAt.getTime() <= now
        ? "contrapartida"
        : null;
  if (started) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `O turno de ${started} já iniciou ou passou`,
    });
  }
}

function sameShiftSchedulingSnapshot(
  before: ShiftRow,
  current: ShiftRow,
): boolean {
  return (
    current.id === before.id &&
    current.institutionId === before.institutionId &&
    current.hospitalId === before.hospitalId &&
    current.sectorId === before.sectorId &&
    current.scheduleContextId === before.scheduleContextId &&
    current.startAt.getTime() === before.startAt.getTime() &&
    current.endAt.getTime() === before.endAt.getTime()
  );
}

function assertSameSwapSchedulingSnapshot(
  beforeSource: ShiftRow,
  currentSource: ShiftRow,
  beforeCounterpart: ShiftRow | null,
  currentCounterpart: ShiftRow | null,
  message: string,
): void {
  const sameCounterpart =
    (beforeCounterpart === null && currentCounterpart === null) ||
    (beforeCounterpart !== null &&
      currentCounterpart !== null &&
      sameShiftSchedulingSnapshot(beforeCounterpart, currentCounterpart));
  if (
    !sameShiftSchedulingSnapshot(beforeSource, currentSource) ||
    !sameCounterpart
  ) {
    throw new TRPCError({ code: "CONFLICT", message });
  }
}

async function requireCanonicalProfessional(
  db: any,
  input: {
    institutionId: number;
    professionalId: number;
    userId?: number;
    lockForUpdate?: boolean;
    expectedSessionVersion?: number;
  },
): Promise<CanonicalProfessional> {
  const conditions = [
    eq(professionalInstitutions.institutionId, input.institutionId),
    eq(professionalInstitutions.professionalId, input.professionalId),
    eq(professionalInstitutions.active, true),
    isNull(users.deletedAt),
    eq(users.approvalStatus, "APPROVED"),
  ];
  if (typeof input.userId === "number") {
    conditions.push(eq(professionalInstitutions.userId, input.userId));
  }

  const query = db
    .select({
      membershipId: professionalInstitutions.id,
      professionalId: professionals.id,
      userId: professionals.userId,
      email: users.email,
      name: professionals.name,
      specialty: professionals.specialty,
      role: professionals.role,
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
    .innerJoin(users, eq(users.id, professionalInstitutions.userId))
    .where(and(...conditions))
    .limit(1);
  const [snapshot] = await query;
  if (!snapshot) {
    throw topologyDenied(
      "Identidade profissional sem vínculo canônico ativo neste tenant",
    );
  }
  if (!input.lockForUpdate) {
    const { membershipId: _membershipId, ...professional } = snapshot;
    return professional as CanonicalProfessional;
  }

  const [currentUser] = await db
    .select({
      id: users.id,
      email: users.email,
      sessionVersion: users.sessionVersion,
    })
    .from(users)
    .where(
      and(
        eq(users.id, snapshot.userId),
        eq(users.approvalStatus, "APPROVED"),
        isNull(users.deletedAt),
      ),
    )
    .limit(1)
    .for("update");
  if (
    currentUser &&
    input.expectedSessionVersion !== undefined &&
    currentUser.sessionVersion !== input.expectedSessionVersion
  ) {
    throw new TRPCError({
      code: "CONFLICT",
      message:
        "A sessão foi revogada durante a operação. Entre novamente e repita.",
    });
  }
  const [currentProfessional] = await db
    .select({
      professionalId: professionals.id,
      userId: professionals.userId,
      name: professionals.name,
      specialty: professionals.specialty,
      role: professionals.role,
    })
    .from(professionals)
    .where(
      and(
        eq(professionals.id, snapshot.professionalId),
        eq(professionals.userId, snapshot.userId),
      ),
    )
    .limit(1)
    .for("update");
  const [currentMembership] = await db
    .select({ roleInInstitution: professionalInstitutions.roleInInstitution })
    .from(professionalInstitutions)
    .where(
      and(
        eq(professionalInstitutions.id, snapshot.membershipId),
        eq(professionalInstitutions.institutionId, input.institutionId),
        eq(professionalInstitutions.professionalId, snapshot.professionalId),
        eq(professionalInstitutions.userId, snapshot.userId),
        eq(professionalInstitutions.active, true),
      ),
    )
    .limit(1)
    .for("update");
  const professional =
    currentUser && currentProfessional && currentMembership
      ? {
          ...currentProfessional,
          email: currentUser.email,
          roleInInstitution: currentMembership.roleInInstitution,
        }
      : undefined;
  if (!professional) {
    throw topologyDenied(
      "Identidade profissional sem vínculo canônico ativo neste tenant",
    );
  }
  return professional;
}

async function requireCurrentListAvailableActor(
  db: any,
  input: {
    institutionId: number;
    professionalId: number;
    userId: number;
    expectedSessionVersion: number;
  },
): Promise<void> {
  const [current] = await db
    .select({ id: professionalInstitutions.id })
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
        eq(users.sessionVersion, input.expectedSessionVersion),
      ),
    )
    .innerJoin(
      institutions,
      and(
        eq(institutions.id, professionalInstitutions.institutionId),
        eq(institutions.isActive, true),
      ),
    )
    .where(
      and(
        eq(professionalInstitutions.institutionId, input.institutionId),
        eq(professionalInstitutions.professionalId, input.professionalId),
        eq(professionalInstitutions.userId, input.userId),
        eq(professionalInstitutions.active, true),
      ),
    )
    .limit(1);
  if (!current) {
    throw new TRPCError({
      code: "CONFLICT",
      message:
        "A sessão ou o vínculo institucional mudou. Entre novamente e repita.",
    });
  }
}

async function assertPublishedSwapMonthsForUpdate(
  tx: any,
  targets: readonly MonthLockTarget[],
): Promise<void> {
  await assertMonthsNotLockedForUpdate(tx, targets);
  const ordered = [
    ...new Map(
      targets.map((target) => {
        const yearMonth = yearMonthBrt(target.date);
        return [
          `${target.institutionId}:${target.hospitalId}:${yearMonth}`,
          { ...target, yearMonth },
        ] as const;
      }),
    ).values(),
  ].sort(
    (left, right) =>
      left.institutionId - right.institutionId ||
      left.hospitalId - right.hospitalId ||
      left.yearMonth.localeCompare(right.yearMonth),
  );
  for (const target of ordered) {
    const [roster] = await tx
      .select({ status: monthlyRosters.status })
      .from(monthlyRosters)
      .where(
        and(
          eq(monthlyRosters.institutionId, target.institutionId),
          eq(monthlyRosters.hospitalId, target.hospitalId),
          eq(monthlyRosters.yearMonth, target.yearMonth),
        ),
      )
      .limit(1);
    if (roster?.status !== "PUBLISHED") {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: `A escala de ${target.yearMonth} precisa estar publicada para trocar ou ceder plantões.`,
      });
    }
  }
}

async function requireProfessionalAccess(
  db: any,
  input: {
    institutionId: number;
    professionalId: number;
    hospitalId: number;
    sectorId: number;
    lockForUpdate?: boolean;
  },
): Promise<number> {
  const query = db
    .select({ id: professionalAccess.id })
    .from(professionalAccess)
    .where(
      and(
        eq(professionalAccess.institutionId, input.institutionId),
        eq(professionalAccess.professionalId, input.professionalId),
        eq(professionalAccess.hospitalId, input.hospitalId),
        eq(professionalAccess.canAccess, true),
        or(
          isNull(professionalAccess.sectorId),
          eq(professionalAccess.sectorId, input.sectorId),
        ),
      ),
    )
    .orderBy(professionalAccess.id)
    .limit(1);
  const rows = input.lockForUpdate ? await query.for("update") : await query;
  if (!rows[0]) {
    throw topologyDenied(
      "Profissional sem acesso ativo ao hospital/setor do plantão",
    );
  }
  return rows[0].id;
}

async function requireCanonicalShift(
  db: any,
  input: {
    institutionId: number;
    shiftInstanceId: number;
    hospitalId?: number;
    sectorId?: number | null;
    lockForUpdate?: boolean;
  },
): Promise<ShiftRow> {
  const conditions = [
    eq(shiftInstances.id, input.shiftInstanceId),
    eq(shiftInstances.institutionId, input.institutionId),
  ];
  if (typeof input.hospitalId === "number") {
    conditions.push(eq(shiftInstances.hospitalId, input.hospitalId));
  }
  if (input.sectorId === null) {
    throw topologyDenied("Solicitação sem setor canônico de origem");
  }
  if (typeof input.sectorId === "number") {
    conditions.push(eq(shiftInstances.sectorId, input.sectorId));
  }

  // Trave apenas a linha operacional. O guard mensal pode já manter um lock
  // compartilhado no hospital pela FK do roster; promover esse mesmo hospital
  // a X por meio de JOIN ... FOR UPDATE cria um ciclo com outro swap que espera
  // o mutex do profissional. A hierarquia continua estável sob locks SHARE.
  const query = db
    .select({ shift: shiftInstances })
    .from(shiftInstances)
    .where(and(...conditions))
    .limit(1);
  const rows = input.lockForUpdate ? await query.for("update") : await query;
  const shift = rows[0]?.shift as ShiftRow | undefined;
  if (!shift) {
    throw topologyDenied("Turno fora da topologia canônica do tenant");
  }
  await assertInstitutionHierarchy(
    {
      institutionId: shift.institutionId,
      hospitalId: shift.hospitalId,
      sectorId: shift.sectorId,
    },
    { db, lockForShare: input.lockForUpdate === true },
  );
  return shift;
}

async function assertProfessionalQualifiedForShift(
  db: any,
  shift: ShiftRow,
  professional: CanonicalProfessional,
  lockForShare: boolean,
): Promise<void> {
  if (shift.scheduleContextId === null) {
    assertSpecialtyCompatible(shift.specialty, professional.specialty);
    return;
  }
  await assertProfessionalEligibleForScheduleContext({
    institutionId: shift.institutionId,
    professionalId: professional.professionalId,
    scheduleContextId: shift.scheduleContextId,
    db,
    lockForShare,
  });
  await assertActiveScheduleContextTopology({
    institutionId: shift.institutionId,
    hospitalId: shift.hospitalId,
    sectorId: shift.sectorId,
    scheduleContextId: shift.scheduleContextId,
    db,
  });
}

async function requireCanonicalAssignmentTuple(
  db: any,
  input: {
    institutionId: number;
    shiftInstanceId: number;
    professionalId: number;
    userId: number;
    assignmentId?: number;
    hospitalId?: number;
    sectorId?: number | null;
    requireActive?: boolean;
    lockForUpdate?: boolean;
    expectedSessionVersion?: number;
  },
): Promise<CanonicalAssignmentTuple> {
  const shift = await requireCanonicalShift(db, input);
  const professional = await requireCanonicalProfessional(db, input);
  await requireProfessionalAccess(db, {
    institutionId: shift.institutionId,
    professionalId: professional.professionalId,
    hospitalId: shift.hospitalId,
    sectorId: shift.sectorId,
    lockForUpdate: input.lockForUpdate,
  });
  await assertProfessionalQualifiedForShift(
    db,
    shift,
    professional,
    input.lockForUpdate === true,
  );

  const canonicalTupleConditions = [
    eq(shiftAssignmentsV2.shiftInstanceId, shift.id),
    eq(shiftAssignmentsV2.institutionId, shift.institutionId),
    eq(shiftAssignmentsV2.hospitalId, shift.hospitalId),
    eq(shiftAssignmentsV2.sectorId, shift.sectorId),
    eq(shiftAssignmentsV2.professionalId, professional.professionalId),
  ];
  const requestedTupleConditions = [...canonicalTupleConditions];
  if (typeof input.assignmentId === "number") {
    requestedTupleConditions.push(
      eq(shiftAssignmentsV2.id, input.assignmentId),
    );
  }
  const selectAssignments = async (
    conditions: ReturnType<typeof eq>[],
    limit: number,
  ) => {
    const query = db
      .select({
        id: shiftAssignmentsV2.id,
        assignmentType: shiftAssignmentsV2.assignmentType,
        status: shiftAssignmentsV2.status,
        isActive: shiftAssignmentsV2.isActive,
      })
      .from(shiftAssignmentsV2)
      .where(and(...conditions))
      .limit(limit);
    return input.lockForUpdate ? await query.for("update") : await query;
  };

  let assignment:
    | {
        id: number;
        assignmentType: CanonicalAssignmentTuple["assignmentType"];
        status: string;
        isActive: boolean;
      }
    | undefined;
  if (input.requireActive === false) {
    const rows = await selectAssignments(requestedTupleConditions, 2);
    if (rows.length > 1) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "A tupla possui mais de uma alocação canônica possível",
      });
    }
    assignment = rows[0];
  } else {
    const activeRows = await selectAssignments(
      [...canonicalTupleConditions, eq(shiftAssignmentsV2.isActive, true)],
      2,
    );
    if (activeRows.length > 1) {
      throw new TRPCError({
        code: "CONFLICT",
        message:
          "Há alocações ativas duplicadas para a mesma tupla profissional/turno",
      });
    }
    const active = activeRows[0];
    if (active && active.status !== "OCUPADO") {
      throw new TRPCError({
        code: "CONFLICT",
        message:
          "A alocação ainda não está confirmada como OCUPADO para troca ou cessão",
      });
    }
    if (
      active &&
      (input.assignmentId === undefined || active.id === input.assignmentId)
    ) {
      assignment = active;
    }
  }
  if (!assignment) {
    if (input.requireActive !== false) {
      const [stale] = await selectAssignments(requestedTupleConditions, 1);
      if (stale && !stale.isActive) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "A alocação canônica já não está ativa",
        });
      }
    }
    throw topologyDenied(
      "Alocação não corresponde à tupla turno/tenant/profissional informada",
    );
  }
  return {
    assignmentId: assignment.id,
    assignmentType: assignment.assignmentType,
    shift,
    professional,
  };
}

async function requireProfessionalCanReceiveShift(
  db: any,
  input: {
    institutionId: number;
    professionalId: number;
    userId?: number;
    shift: ShiftRow;
    lockForUpdate?: boolean;
    expectedSessionVersion?: number;
  },
): Promise<CanonicalProfessional> {
  const professional = await requireCanonicalProfessional(db, input);
  await requireProfessionalAccess(db, {
    institutionId: input.institutionId,
    professionalId: input.professionalId,
    hospitalId: input.shift.hospitalId,
    sectorId: input.shift.sectorId,
    lockForUpdate: input.lockForUpdate,
  });
  await assertProfessionalQualifiedForShift(
    db,
    input.shift,
    professional,
    input.lockForUpdate === true,
  );
  return professional;
}

async function requireCanonicalShiftOccupant(
  db: any,
  input: { shift: ShiftRow; lockForUpdate?: boolean },
): Promise<CanonicalAssignmentTuple> {
  const conditions = and(
    eq(shiftAssignmentsV2.shiftInstanceId, input.shift.id),
    eq(shiftAssignmentsV2.institutionId, input.shift.institutionId),
    eq(shiftAssignmentsV2.hospitalId, input.shift.hospitalId),
    eq(shiftAssignmentsV2.sectorId, input.shift.sectorId),
    eq(shiftAssignmentsV2.isActive, true),
  );
  let candidates: {
    assignmentId: number;
    professionalId: number;
    userId: number;
  }[];
  if (input.lockForUpdate) {
    const assignments = await db
      .select({
        assignmentId: shiftAssignmentsV2.id,
        professionalId: shiftAssignmentsV2.professionalId,
      })
      .from(shiftAssignmentsV2)
      .where(conditions)
      .for("update");
    candidates = [];
    for (const assignment of assignments) {
      const [professional] = await db
        .select({ userId: professionals.userId })
        .from(professionals)
        .where(eq(professionals.id, assignment.professionalId))
        .limit(1);
      if (!professional) {
        throw topologyDenied("Ocupante sem identidade profissional canônica");
      }
      candidates.push({ ...assignment, userId: professional.userId });
    }
  } else {
    candidates = await db
      .select({
        assignmentId: shiftAssignmentsV2.id,
        professionalId: shiftAssignmentsV2.professionalId,
        userId: professionals.userId,
      })
      .from(shiftAssignmentsV2)
      .innerJoin(
        professionals,
        eq(professionals.id, shiftAssignmentsV2.professionalId),
      )
      .where(conditions);
  }
  for (const candidate of candidates) {
    try {
      return await requireCanonicalAssignmentTuple(db, {
        institutionId: input.shift.institutionId,
        shiftInstanceId: input.shift.id,
        assignmentId: candidate.assignmentId,
        professionalId: candidate.professionalId,
        userId: candidate.userId,
        requireActive: true,
        lockForUpdate: input.lockForUpdate,
      });
    } catch (error) {
      if (!(error instanceof TRPCError)) throw error;
    }
  }
  throw topologyDenied("Turno de contrapartida sem ocupante canônico ativo");
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
function isOneWay(type: SwapType): boolean {
  return type === "TRANSFER" || type === "CESSAO";
}

/**
 * Audit action / entityType / label dispatcher per swap type. Centralizes
 * the SWAP / TRANSFER / CESSAO audit naming so a CESSAO request emits a
 * consistent CESSAO_* timeline (was emitting TRANSFER_* before).
 */
type AuditPhase =
  "OFFERED" | "ACCEPTED" | "REJECTED" | "APPROVED_BY_OWNER" | "CANCELLED";
function auditNames(
  type: SwapType,
  phase: AuditPhase,
): {
  action:
    | "SWAP_REQUESTED"
    | "SWAP_ACCEPTED"
    | "SWAP_REJECTED"
    | "SWAP_APPROVED_BY_OWNER"
    | "SWAP_CANCELLED"
    | "TRANSFER_OFFERED"
    | "TRANSFER_ACCEPTED"
    | "TRANSFER_REJECTED"
    | "TRANSFER_APPROVED_BY_OWNER"
    | "TRANSFER_CANCELLED"
    | "CESSAO_OFFERED"
    | "CESSAO_ACCEPTED"
    | "CESSAO_REJECTED"
    | "CESSAO_APPROVED_BY_OWNER"
    | "CESSAO_CANCELLED";
  entityType: "SWAP_REQUEST" | "TRANSFER_REQUEST";
  label: "Troca" | "Repasse" | "Cessão";
} {
  if (type === "SWAP") {
    const m = {
      OFFERED: "SWAP_REQUESTED",
      ACCEPTED: "SWAP_ACCEPTED",
      REJECTED: "SWAP_REJECTED",
      APPROVED_BY_OWNER: "SWAP_APPROVED_BY_OWNER",
      CANCELLED: "SWAP_CANCELLED",
    } as const;
    return { action: m[phase], entityType: "SWAP_REQUEST", label: "Troca" };
  }
  if (type === "CESSAO") {
    const m = {
      OFFERED: "CESSAO_OFFERED",
      ACCEPTED: "CESSAO_ACCEPTED",
      REJECTED: "CESSAO_REJECTED",
      APPROVED_BY_OWNER: "CESSAO_APPROVED_BY_OWNER",
      CANCELLED: "CESSAO_CANCELLED",
    } as const;
    return {
      action: m[phase],
      entityType: "TRANSFER_REQUEST",
      label: "Cessão",
    };
  }
  // TRANSFER (legacy)
  const m = {
    OFFERED: "TRANSFER_OFFERED",
    ACCEPTED: "TRANSFER_ACCEPTED",
    REJECTED: "TRANSFER_REJECTED",
    APPROVED_BY_OWNER: "TRANSFER_APPROVED_BY_OWNER",
    CANCELLED: "TRANSFER_CANCELLED",
  } as const;
  return { action: m[phase], entityType: "TRANSFER_REQUEST", label: "Repasse" };
}

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

async function requireSwapTopologyForRead(
  db: any,
  swap: SwapRow,
  lockForUpdate = false,
): Promise<void> {
  const requireActive = swap.status !== "APPROVED";
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
      message: `Status atual é ${swap.status}, esperava PENDING`,
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

async function filterReadableSwaps(
  db: any,
  actor: TenantActor,
  swaps: SwapRow[],
): Promise<SwapRow[]> {
  const readable: SwapRow[] = [];
  for (const swap of swaps) {
    try {
      await requireSwapTopologyForRead(db, swap);
      await assertActorCanReadSwap(actor, swap);
      readable.push(swap);
    } catch (error) {
      if (!(error instanceof TRPCError)) throw error;
    }
  }
  return readable;
}

async function lockSwapShiftsForUpdate(
  tx: any,
  institutionId: number,
  shiftInstanceIds: (number | null | undefined)[],
): Promise<void> {
  const ordered = [
    ...new Set(
      shiftInstanceIds.filter((id): id is number => typeof id === "number"),
    ),
  ].sort((left, right) => left - right);
  if (ordered.length === 0)
    throw topologyDenied("Solicitação sem turno de origem");

  for (const shiftInstanceId of ordered) {
    const [locked] = await tx
      .select({ id: shiftInstances.id })
      .from(shiftInstances)
      .where(
        and(
          eq(shiftInstances.id, shiftInstanceId),
          eq(shiftInstances.institutionId, institutionId),
        ),
      )
      .limit(1)
      .for("update");
    if (!locked) throw topologyDenied("Turno fora do tenant ativo");
  }
}

async function lockSwapAssignmentsForUpdate(
  tx: any,
  institutionId: number,
  shiftInstanceIds: (number | null | undefined)[],
): Promise<number[]> {
  const shiftIds = [
    ...new Set(
      shiftInstanceIds.filter((id): id is number => typeof id === "number"),
    ),
  ];
  const snapshots =
    shiftIds.length === 0
      ? []
      : await tx
          .select({
            id: shiftAssignmentsV2.id,
            professionalId: shiftAssignmentsV2.professionalId,
          })
          .from(shiftAssignmentsV2)
          .where(
            and(
              eq(shiftAssignmentsV2.institutionId, institutionId),
              inArray(shiftAssignmentsV2.shiftInstanceId, shiftIds),
            ),
          );
  for (const assignmentId of snapshots
    .map((row: { id: number }) => row.id)
    .sort((left: number, right: number) => left - right)) {
    const [locked] = await tx
      .select({ id: shiftAssignmentsV2.id })
      .from(shiftAssignmentsV2)
      .where(
        and(
          eq(shiftAssignmentsV2.id, assignmentId),
          eq(shiftAssignmentsV2.institutionId, institutionId),
        ),
      )
      .limit(1)
      .for("update");
    if (!locked) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "As alocações do plantão mudaram durante a operação",
      });
    }
  }
  const professionalIds = snapshots.map(
    (row: { professionalId: number }) => row.professionalId,
  );
  return [...new Set<number>(professionalIds)].sort(
    (left, right) => left - right,
  );
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
    requiredSpecialty: source.shift.specialty,
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
      requiredSpecialty: toTuple.shift.specialty,
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

/**
 * Efetua um swap/cessão/transfer já em estado ACCEPTED. Roda
 * revalidação H1/H2 (anti-overlap), reatribui as assignments e marca a
 * solicitação como APPROVED.
 *
 * Chamado exclusivamente pelo fluxo canônico do dono-do-plantão
 * (`approveByOwner`), conforme docs/product/escala-ux.md §6.
 *
 * Pré-condições: swap.status === "ACCEPTED" e
 * swap.toProfessionalId/toUserId já preenchidos. O caller deve
 * validar antes.
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

  const deactivateActive = async (
    tx: any,
    tuple: CanonicalAssignmentTuple,
    label: string,
  ) => {
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
  };

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
    if (isOneWay(currentSwap.type)) {
      await deactivateActive(tx, topology.source, "de origem");

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
    } else {
      if (!topology.toTuple)
        throw topologyDenied("Troca sem alocação de contrapartida canônica");
      await deactivateActive(tx, topology.source, "de origem");
      await deactivateActive(tx, topology.toTuple, "do colega");
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
    }

    const [done] = await tx
      .update(swapRequests)
      .set({
        status: "APPROVED",
        reviewedByUserId: actor.userId,
        reviewedAt: new Date(),
        reviewNote: note ?? null,
        version: currentSwap.version + 1,
      })
      .where(
        and(
          eq(swapRequests.id, currentSwap.id),
          eq(swapRequests.institutionId, currentSwap.institutionId),
          eq(swapRequests.status, "ACCEPTED"),
          eq(swapRequests.version, currentSwap.version),
        ),
      );
    if (!done.affectedRows) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "Esta solicitação já foi efetivada ou cancelada.",
      });
    }
    await recomputeShiftStatus(tx, topology.source.shift.id);
    if (topology.toTuple) {
      await recomputeShiftStatus(tx, topology.toTuple.shift.id);
    }
    const names = auditNames(currentSwap.type, "APPROVED_BY_OWNER");
    await recordAudit(
      {
        action: names.action,
        entityType: names.entityType,
        entityId: currentSwap.id,
        actorUserId: actor.userId,
        actorRole: reviewer.auditRole,
        actorName: reviewer.professional.name,
        description,
        fromProfessionalId: currentSwap.fromProfessionalId,
        toProfessionalId: currentSwap.toProfessionalId ?? undefined,
        fromUserId: currentSwap.fromUserId,
        toUserId: currentSwap.toUserId ?? undefined,
        shiftInstanceId: currentSwap.fromShiftInstanceId,
        hospitalId: currentSwap.hospitalId,
        sectorId: currentSwap.sectorId ?? undefined,
        institutionId: currentSwap.institutionId,
        metadata: { note, approvalPath: "OWNER" },
      },
      { db: tx, strict: true },
    );
    const approvedVersion = currentSwap.version + 1;
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
  }, ASSIGNMENT_WRITE_TRANSACTION_CONFIG);
}

// ─── router ─────────────────────────────────────────────────────────────────

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
      if (!actor.professionalId)
        throw topologyDenied("Ator sem identidade profissional canônica");
      if (isOneWay(input.type) && input.toShiftInstanceId !== undefined) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Cessão/repasse não aceita turno de contrapartida",
        });
      }
      if (
        input.type === "SWAP" &&
        (!input.toShiftInstanceId ||
          input.toShiftInstanceId === input.fromShiftInstanceId)
      ) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "SWAP requer outro turno de contrapartida",
        });
      }

      const validateOfferTopology = async (
        conn: any,
        lockForUpdate: boolean,
      ) => {
        const source = await requireCanonicalAssignmentTuple(conn, {
          institutionId,
          shiftInstanceId: input.fromShiftInstanceId,
          assignmentId: input.fromAssignmentId,
          professionalId: actor.professionalId!,
          userId,
          requireActive: true,
          lockForUpdate,
          expectedSessionVersion,
        });
        let toShift: ShiftRow | null = null;
        if (input.type === "SWAP" && input.toShiftInstanceId) {
          toShift = await requireCanonicalShift(conn, {
            institutionId,
            shiftInstanceId: input.toShiftInstanceId,
            lockForUpdate,
          });
          if (toShift.status !== "OCUPADO") {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: "Turno de troca não está ocupado",
            });
          }
          await requireProfessionalCanReceiveShift(conn, {
            institutionId,
            professionalId: source.professional.professionalId,
            userId: source.professional.userId,
            shift: toShift,
            lockForUpdate,
            expectedSessionVersion,
          });
        }
        assertSwapShiftsNotStarted(source.shift, toShift);

        let target: CanonicalProfessional | null = null;
        let counterpart: CanonicalProfessional | null = null;
        if (input.toProfessionalId) {
          target = await requireProfessionalCanReceiveShift(conn, {
            institutionId,
            professionalId: input.toProfessionalId,
            shift: source.shift,
            lockForUpdate,
          });
          if (target.userId === userId) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: "Não é possível direcionar a oferta a você mesmo",
            });
          }
          if (toShift) {
            await requireCanonicalAssignmentTuple(conn, {
              institutionId,
              shiftInstanceId: toShift.id,
              professionalId: target.professionalId,
              userId: target.userId,
              requireActive: true,
              lockForUpdate,
            });
          }
          counterpart = target;
        } else if (toShift) {
          counterpart = (
            await requireCanonicalShiftOccupant(conn, {
              shift: toShift,
              lockForUpdate,
            })
          ).professional;
        }
        return { source, toShift, target, counterpart };
      };

      const preflight = await validateOfferTopology(db, false);
      const expiresAt = new Date(
        Date.now() + input.expiresInHours * 60 * 60 * 1000,
      );

      const offerAudit = auditNames(input.type, "OFFERED");
      const offerDescription =
        input.type === "SWAP"
          ? `Troca oferecida: turno #${input.fromShiftInstanceId} ↔ turno #${input.toShiftInstanceId}`
          : `${offerAudit.label} oferecida: turno #${input.fromShiftInstanceId}`;
      return db.transaction(async (tx) => {
        const monthTargets: MonthLockTarget[] = [
          {
            institutionId: preflight.source.shift.institutionId,
            hospitalId: preflight.source.shift.hospitalId,
            date: preflight.source.shift.startAt,
          },
        ];
        if (preflight.toShift) {
          monthTargets.push({
            institutionId: preflight.toShift.institutionId,
            hospitalId: preflight.toShift.hospitalId,
            date: preflight.toShift.startAt,
          });
        }
        await assertPublishedSwapMonthsForUpdate(tx, monthTargets);
        await lockSwapShiftsForUpdate(tx, institutionId, [
          input.fromShiftInstanceId,
          input.toShiftInstanceId,
        ]);
        const assignmentProfessionalIds = await lockSwapAssignmentsForUpdate(
          tx,
          institutionId,
          [input.fromShiftInstanceId, input.toShiftInstanceId],
        );
        await lockAssignmentProfessionalsForUpdate(
          tx,
          [
            ...assignmentProfessionalIds,
            preflight.source.professional.professionalId,
            preflight.counterpart?.professionalId,
          ].filter((id): id is number => typeof id === "number"),
        );
        const locked = await validateOfferTopology(tx, true);
        assertSameSwapSchedulingSnapshot(
          preflight.source.shift,
          locked.source.shift,
          preflight.toShift,
          locked.toShift,
          "A topologia do plantão mudou enquanto a oferta era criada.",
        );

        const [openOffer] = await tx
          .select({ id: swapRequests.id })
          .from(swapRequests)
          .where(
            and(
              eq(swapRequests.fromAssignmentId, input.fromAssignmentId),
              eq(swapRequests.institutionId, institutionId),
              inArray(swapRequests.status, ["PENDING", "ACCEPTED"]),
            ),
          )
          .limit(1);
        if (openOffer) {
          throw new TRPCError({
            code: "CONFLICT",
            message:
              "Já existe uma oferta aberta para este plantão. Cancele-a antes de criar outra.",
          });
        }

        const [result] = await tx.insert(swapRequests).values({
          type: input.type,
          status: "PENDING",
          fromProfessionalId: locked.source.professional.professionalId,
          fromUserId: userId,
          fromShiftInstanceId: locked.source.shift.id,
          fromAssignmentId: locked.source.assignmentId,
          toShiftInstanceId: locked.toShift?.id ?? null,
          toProfessionalId: locked.target?.professionalId ?? null,
          toUserId: locked.target?.userId ?? null,
          institutionId: locked.source.shift.institutionId,
          hospitalId: locked.source.shift.hospitalId,
          sectorId: locked.source.shift.sectorId,
          reason: input.reason ?? null,
          expiresAt,
        });
        const createdId = Number(result.insertId);
        await recordAudit(
          {
            action: offerAudit.action,
            entityType: offerAudit.entityType,
            entityId: createdId,
            actorUserId: userId,
            actorRole: locked.source.professional.roleInInstitution,
            actorName: locked.source.professional.name,
            description: offerDescription,
            fromProfessionalId: locked.source.professional.professionalId,
            fromUserId: userId,
            shiftInstanceId: locked.source.shift.id,
            hospitalId: locked.source.shift.hospitalId,
            sectorId: locked.source.shift.sectorId,
            institutionId: locked.source.shift.institutionId,
            metadata: { type: input.type, reason: input.reason },
          },
          { db: tx, strict: true },
        );
        const [created] = await tx
          .select()
          .from(swapRequests)
          .where(eq(swapRequests.id, createdId))
          .limit(1);
        if (!created) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "Oferta criada sem snapshot transacional de retorno",
          });
        }
        return created;
      });
    }),

  // ── accept ────────────────────────────────────────────────────────────────
  accept: protectedProcedure
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
        const [accepted] = await tx
          .update(swapRequests)
          .set({
            status: "ACCEPTED",
            toProfessionalId: locked.professional.professionalId,
            toUserId: locked.professional.userId,
            toAssignmentId: locked.toTuple?.assignmentId ?? null,
            version: current.version + 1,
          })
          .where(
            and(
              eq(swapRequests.id, current.id),
              eq(swapRequests.institutionId, current.institutionId),
              eq(swapRequests.status, "PENDING"),
              eq(swapRequests.version, current.version),
            ),
          );
        if (!accepted.affectedRows) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "Esta oferta já foi respondida por outra pessoa.",
          });
        }

        const acceptAudit = auditNames(current.type, "ACCEPTED");
        await recordAudit(
          {
            action: acceptAudit.action,
            entityType: acceptAudit.entityType,
            entityId: current.id,
            actorUserId: userId,
            actorRole: locked.professional.roleInInstitution,
            actorName: locked.professional.name,
            description: `${acceptAudit.label} aceita pelo profissional #${locked.professional.professionalId}`,
            fromProfessionalId: current.fromProfessionalId,
            toProfessionalId: locked.professional.professionalId,
            fromUserId: current.fromUserId,
            toUserId: userId,
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
        await transitionSwapStatusForUpdate(tx, current, ["PENDING"], {
          status: "REJECTED_BY_PEER",
        });

        const rejectAudit = auditNames(current.type, "REJECTED");
        await recordAudit(
          {
            action: rejectAudit.action,
            entityType: rejectAudit.entityType,
            entityId: current.id,
            actorUserId: userId,
            actorRole: recipient.professional.roleInInstitution,
            actorName: recipient.professional.name,
            description: `Solicitação #${current.id} rejeitada pelo profissional`,
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
  // Fluxo canônico per docs/product/escala-ux.md §6: a aprovação de
  // cessão/troca é responsabilidade do dono do plantão original (A),
  // não do gestor. Gestor só vê o histórico (transparência).
  //
  // Pré-condições:
  //   - swap.status === "ACCEPTED" (alguém já se candidatou)
  //   - swap.fromUserId === ctx.user.id (caller é o dono que ofertou)
  //
  // Revalida H1/H2, reatribui as assignments e audita a decisão do dono.
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
        await lockSwapMutationTopology(tx, current, [actor.professionalId]);
        const reviewer = await requireCurrentSwapOwner(
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
        await recordAudit(
          {
            action: cancelAudit.action,
            entityType: cancelAudit.entityType,
            entityId: current.id,
            actorUserId: userId,
            actorRole: reviewer.auditRole,
            actorName: reviewer.professional.name,
            description: `Solicitação #${current.id} cancelada pelo ofertante`,
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
  //                Útil para a tela "Minhas ofertas" do USER consumir
  //                approveByOwner sobre candidaturas em ACCEPTED.
  //   "RECEIVER" — onde sou o aceitante (B). Útil para acompanhar o
  //                que ofereci aceitar e tá no fluxo.
  //   "ANY"      — comportamento legado: qualquer envolvimento (default).
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
      const readableIds = new Set(
        (await filterReadableSwaps(db, actor, candidateSwaps)).map(
          (swap) => swap.id,
        ),
      );

      return data
        .filter((r: any) => readableIds.has(Number(r.id)))
        .map((r: any) => ({
          id: r.id,
          type: r.type,
          status: r.status,
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
          // True quando o usuário logado é o ofertante e a candidatura
          // está aguardando aprovação dele (approveByOwner). A tela
          // "Minhas ofertas" usa esse flag pra filtrar/destacar o que
          // exige ação imediata sem precisar comparar fromUserId no client.
          awaitingMyApproval:
            r.status === "ACCEPTED" && r.fromUserId === userId,
        }));
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
      await requireSwapTopologyForRead(db, swap);
      await assertActorCanReadSwap(actor, swap);

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
      };
    }),

  // ── listAvailable ─────────────────────────────────────────────────────────
  listAvailable: protectedProcedure
    .input(
      z.object({
        type: z.enum(["SWAP", "TRANSFER", "CESSAO"]).optional(),
        scheduleContextId: z.number().int().positive().optional(),
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
      if (
        input.scheduleContextId !== undefined &&
        !assumableContextIds.includes(input.scheduleContextId)
      ) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Escala fora do acesso ou qualificação do profissional.",
        });
      }
      if (assumableContextIds.length === 0) return [];

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
          ts.name             AS toSectorName
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
        LEFT JOIN medical_specialties fms
          ON fms.id = fsc.medical_specialty_id
         AND fms.active = 1
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
          AND EXISTS (
            SELECT 1
            FROM professional_access source_access
            WHERE source_access.institution_id = fsi.institution_id
              AND source_access.professional_id = fp.id
              AND source_access.hospital_id = fsi.hospital_id
              AND source_access.can_access = 1
              AND (source_access.sector_id IS NULL OR source_access.sector_id = fsi.sector_id)
          )
          AND (
            (
              fsc.medical_specialty_id IS NOT NULL
              AND fms.id IS NOT NULL
              AND ap.medical_specialty_id = fsc.medical_specialty_id
              AND fp.medical_specialty_id = fsc.medical_specialty_id
            )
            OR
            (
              fsc.operational_profile_code IS NOT NULL
              AND ap.operational_profile_code = fsc.operational_profile_code
              AND fp.operational_profile_code = fsc.operational_profile_code
            )
          )
          AND EXISTS (
            SELECT 1
            FROM professional_access actor_source_access
            WHERE actor_source_access.institution_id = fsi.institution_id
              AND actor_source_access.professional_id = ap.id
              AND actor_source_access.hospital_id = fsi.hospital_id
              AND actor_source_access.can_access = 1
              AND (actor_source_access.sector_id IS NULL OR actor_source_access.sector_id = fsi.sector_id)
          )
          AND (
            NULLIF(TRIM(fsi.specialty), '') IS NULL
            OR NULLIF(TRIM(fp.specialty), '') IS NULL
            OR LOWER(TRIM(fsi.specialty)) = LOWER(TRIM(fp.specialty))
          )
          AND (
            NULLIF(TRIM(fsi.specialty), '') IS NULL
            OR NULLIF(TRIM(ap.specialty), '') IS NULL
            OR LOWER(TRIM(fsi.specialty)) = LOWER(TRIM(ap.specialty))
          )
          AND NOT EXISTS (
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
              AND EXISTS (
                SELECT 1
                FROM professional_access actor_target_access
                WHERE actor_target_access.institution_id = tsi.institution_id
                  AND actor_target_access.professional_id = ap.id
                  AND actor_target_access.hospital_id = tsi.hospital_id
                  AND actor_target_access.can_access = 1
                  AND (actor_target_access.sector_id IS NULL OR actor_target_access.sector_id = tsi.sector_id)
              )
              AND EXISTS (
                SELECT 1
                FROM professional_access source_target_access
                WHERE source_target_access.institution_id = tsi.institution_id
                  AND source_target_access.professional_id = fp.id
                  AND source_target_access.hospital_id = tsi.hospital_id
                  AND source_target_access.can_access = 1
                  AND (source_target_access.sector_id IS NULL OR source_target_access.sector_id = tsi.sector_id)
              )
              AND (
                NULLIF(TRIM(tsi.specialty), '') IS NULL
                OR NULLIF(TRIM(ap.specialty), '') IS NULL
                OR LOWER(TRIM(tsi.specialty)) = LOWER(TRIM(ap.specialty))
              )
              AND (
                NULLIF(TRIM(tsi.specialty), '') IS NULL
                OR NULLIF(TRIM(fp.specialty), '') IS NULL
                OR LOWER(TRIM(tsi.specialty)) = LOWER(TRIM(fp.specialty))
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
      }));
    }),
});

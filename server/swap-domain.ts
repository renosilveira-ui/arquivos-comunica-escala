/**
 * Domínio compartilhado de swaps: topologia, locks, auditoria de nomes.
 * Usado por `swaps.offer` (via createSwapOffer) e demais mutations do router.
 * Não contém transporte tRPC — só regras canônicas reutilizáveis.
 */
import { TRPCError } from "@trpc/server";
import { eq, and, or, isNull, inArray } from "drizzle-orm";
import {
  swapRequests,
  shiftInstances,
  shiftAssignmentsV2,
  professionals,
  professionalInstitutions,
  professionalAccess,
  managerScope,
  users,
  institutions,
  monthlyRosters,
} from "../drizzle/schema";
import { assertSpecialtyCompatible } from "./specialty";
import {
  assertMonthsNotLockedForUpdate,
  type MonthLockTarget,
} from "./month-guards";
import { assertInstitutionHierarchy } from "./_core/tenant";
import { yearMonthBrt } from "./local-time";
import {
  assertActiveScheduleContextTopology,
  assertProfessionalEligibleForScheduleContext,
} from "./schedule-contexts";

export type SwapType = (typeof swapRequests.$inferSelect)["type"];
export type SwapRow = typeof swapRequests.$inferSelect;
export type ShiftRow = typeof shiftInstances.$inferSelect;

export type CanonicalProfessional = {
  professionalId: number;
  userId: number;
  email: string | null;
  name: string;
  specialty: string | null;
  role: string;
  roleInInstitution: "USER" | "GESTOR_MEDICO" | "GESTOR_PLUS";
};

export type CanonicalAssignmentTuple = {
  assignmentId: number;
  assignmentType: (typeof shiftAssignmentsV2.$inferSelect)["assignmentType"];
  shift: ShiftRow;
  professional: CanonicalProfessional;
};
export function topologyDenied(message: string): TRPCError {
  return new TRPCError({ code: "FORBIDDEN", message });
}

export function assertSwapShiftsNotStarted(
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

export function sameShiftSchedulingSnapshot(
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

export function assertSameSwapSchedulingSnapshot(
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

export async function requireCanonicalProfessional(
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

export async function requireCurrentListAvailableActor(
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

export async function assertPublishedSwapMonthsForUpdate(
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

export async function findProfessionalAccessId(
  db: any,
  input: {
    institutionId: number;
    professionalId: number;
    hospitalId: number;
    sectorId: number;
    lockForUpdate?: boolean;
  },
): Promise<number | null> {
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
  return rows[0]?.id ?? null;
}

export async function findManagerScopeId(
  db: any,
  input: {
    institutionId: number;
    professionalId: number;
    hospitalId: number;
    sectorId: number;
    lockForUpdate?: boolean;
  },
): Promise<number | null> {
  const query = db
    .select({ id: managerScope.id })
    .from(managerScope)
    .where(
      and(
        eq(managerScope.institutionId, input.institutionId),
        eq(managerScope.managerProfessionalId, input.professionalId),
        eq(managerScope.hospitalId, input.hospitalId),
        or(
          isNull(managerScope.sectorId),
          eq(managerScope.sectorId, input.sectorId),
        ),
        eq(managerScope.active, true),
      ),
    )
    .orderBy(managerScope.id)
    .limit(1);
  const rows = input.lockForUpdate ? await query.for("update") : await query;
  return rows[0]?.id ?? null;
}

export async function requireCanonicalShift(
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

export async function assertProfessionalQualifiedForShift(
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

export async function requireCanonicalAssignmentTuple(
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
  // Mesma porta de receive: ACL, manager_scope ou GESTOR_PLUS.
  // Sem isso o gestor alocado na escala (Maurilio) não oferta o
  // próprio plantão — a tupla já exige que ele seja o ocupante.
  const accessInput = {
    institutionId: shift.institutionId,
    professionalId: professional.professionalId,
    hospitalId: shift.hospitalId,
    sectorId: shift.sectorId,
    lockForUpdate: input.lockForUpdate,
  };
  const accessId = await findProfessionalAccessId(db, accessInput);
  const canManageAsGestorPlus = professional.roleInInstitution === "GESTOR_PLUS";
  const scopeId = canManageAsGestorPlus
    ? null
    : await findManagerScopeId(db, accessInput);
  if (accessId === null && scopeId === null && !canManageAsGestorPlus) {
    throw topologyDenied(
      professional.roleInInstitution === "GESTOR_MEDICO"
        ? "Gestor sem jurisdição para o hospital/setor do plantão"
        : "Profissional sem acesso ativo ao hospital/setor do plantão",
    );
  }
  if (scopeId !== null || canManageAsGestorPlus) {
    if (shift.scheduleContextId !== null) {
      await assertActiveScheduleContextTopology({
        institutionId: shift.institutionId,
        hospitalId: shift.hospitalId,
        sectorId: shift.sectorId,
        scheduleContextId: shift.scheduleContextId,
        db,
      });
    }
  } else {
    await assertProfessionalQualifiedForShift(
      db,
      shift,
      professional,
      input.lockForUpdate === true,
    );
  }

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

export async function requireProfessionalCanReceiveShift(
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
  const accessInput = {
    institutionId: input.institutionId,
    professionalId: input.professionalId,
    hospitalId: input.shift.hospitalId,
    sectorId: input.shift.sectorId,
    lockForUpdate: input.lockForUpdate,
  };
  const accessId = await findProfessionalAccessId(db, accessInput);
  const canManageAsGestorPlus = professional.roleInInstitution === "GESTOR_PLUS";
  const scopeId = canManageAsGestorPlus
    ? null
    : await findManagerScopeId(db, accessInput);
  if (accessId === null && scopeId === null && !canManageAsGestorPlus) {
    throw topologyDenied(
      professional.roleInInstitution === "GESTOR_MEDICO"
        ? "Gestor sem jurisdição para o hospital/setor do plantão"
        : "Profissional sem acesso ativo ao hospital/setor do plantão",
    );
  }
  // listAvailable já mostra a oferta a GESTOR_PLUS e a GESTOR_MEDICO com
  // manager_scope, sem professional_access. Aceitar/recusar usa a mesma
  // regra; especialidade não filtra gestão.
  if (scopeId !== null || canManageAsGestorPlus) {
    if (input.shift.scheduleContextId !== null) {
      await assertActiveScheduleContextTopology({
        institutionId: input.shift.institutionId,
        hospitalId: input.shift.hospitalId,
        sectorId: input.shift.sectorId,
        scheduleContextId: input.shift.scheduleContextId,
        db,
      });
    }
    return professional;
  }
  await assertProfessionalQualifiedForShift(
    db,
    input.shift,
    professional,
    input.lockForUpdate === true,
  );
  return professional;
}

export async function requireCanonicalShiftOccupant(
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
export function isOneWay(type: SwapType): boolean {
  return type === "TRANSFER" || type === "CESSAO";
}

/**
 * Audit action / entityType / label dispatcher per swap type. Centralizes
 * the SWAP / TRANSFER / CESSAO audit naming so a CESSAO request emits a
 * consistent CESSAO_* timeline (was emitting TRANSFER_* before).
 */
export type AuditPhase =
  "OFFERED" | "ACCEPTED" | "REJECTED" | "APPROVED_BY_OWNER" | "CANCELLED";
export function auditNames(
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
export async function lockSwapShiftsForUpdate(
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

export async function lockSwapAssignmentsForUpdate(
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

export type { MonthLockTarget };

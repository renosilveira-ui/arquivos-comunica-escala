import { TRPCError } from "@trpc/server";
import { and, eq, isNull, or, sql, type SQL } from "drizzle-orm";
import {
  hospitals,
  managerScope,
  professionalAccess,
  professionalInstitutions,
  professionals,
  scheduleContexts,
  sectors,
  shiftAssignmentsV2,
  shiftInstances,
  users,
} from "../drizzle/schema";
import { getDb } from "./db";
import { assertInstitutionHierarchy } from "./_core/tenant";
import {
  assertActiveScheduleContextTopology,
  assertProfessionalEligibleForScheduleContext,
  pendingNamedInviteCoversScale,
} from "./schedule-contexts";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;
export type AssignmentWriteTx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * O mutex por profissional precisa ser acompanhado de READ COMMITTED: em
 * REPEATABLE READ, uma leitura anterior ao mutex pode fixar um snapshot que
 * não enxerga a alocação confirmada pelo concorrente enquanto aguardávamos.
 */
export const ASSIGNMENT_WRITE_TRANSACTION_CONFIG = {
  isolationLevel: "read committed",
} as const;

export type AssignmentWriteCandidate = {
  professionalId: number;
  expectedUserId?: number;
  expectedSessionVersion?: number;
  institutionId: number;
  hospitalId: number;
  sectorId: number;
  scheduleContextId: number | null;
  startAt: Date;
  endAt: Date;
  excludeAssignmentIds?: readonly number[];
};

export type LockedAssignmentProfessional = {
  id: number;
  userId: number;
  specialty: string | null;
};

type ShiftCapacityInput = {
  shiftInstanceId: number;
  institutionId: number;
  hospitalId: number;
  sectorId: number;
  activeDelta?: number;
  expectedCurrentActiveCount?: number;
  maxActiveAssignments?: number;
};

function assignmentConflict(message: string): TRPCError {
  return new TRPCError({ code: "CONFLICT", message });
}

function assignmentForbidden(message: string): TRPCError {
  return new TRPCError({ code: "FORBIDDEN", message });
}

async function managerScopeCoversAssignment(
  tx: AssignmentWriteTx,
  input: {
    professionalId: number;
    institutionId: number;
    hospitalId: number;
    sectorId: number;
  },
): Promise<boolean> {
  const [scope] = await tx
    .select({ id: managerScope.id })
    .from(managerScope)
    .where(
      and(
        eq(managerScope.managerProfessionalId, input.professionalId),
        eq(managerScope.institutionId, input.institutionId),
        eq(managerScope.hospitalId, input.hospitalId),
        or(
          isNull(managerScope.sectorId),
          eq(managerScope.sectorId, input.sectorId),
        ),
        eq(managerScope.active, true),
      ),
    )
    .limit(1);
  return Boolean(scope);
}

/** Quem cobre escrita sem ACL de setor. Convite pendente libera o
 *  acesso (assign-direct); só gestor/PLUS/scope pulam especialidade. */
type AssignmentAccessCoverage = "manager" | "invite";

async function assignmentCoverageWithoutSectorAccess(
  tx: AssignmentWriteTx,
  input: {
    professionalId: number;
    userId: number;
    institutionId: number;
    hospitalId: number;
    sectorId: number;
  },
): Promise<AssignmentAccessCoverage | null> {
  if (
    await managerScopeCoversAssignment(tx, {
      professionalId: input.professionalId,
      institutionId: input.institutionId,
      hospitalId: input.hospitalId,
      sectorId: input.sectorId,
    })
  ) {
    return "manager";
  }
  const [membership] = await tx
    .select({ roleInInstitution: professionalInstitutions.roleInInstitution })
    .from(professionalInstitutions)
    .where(
      and(
        eq(professionalInstitutions.professionalId, input.professionalId),
        eq(professionalInstitutions.userId, input.userId),
        eq(professionalInstitutions.institutionId, input.institutionId),
        eq(professionalInstitutions.active, true),
      ),
    )
    .limit(1);
  if (membership?.roleInInstitution === "GESTOR_PLUS") {
    return "manager";
  }
  const invited = await pendingNamedInviteCoversScale(tx, {
    institutionId: input.institutionId,
    hospitalId: input.hospitalId,
    sectorId: input.sectorId,
    userId: input.userId,
  });
  return invited ? "invite" : null;
}

function windowsOverlap(
  left: Pick<AssignmentWriteCandidate, "startAt" | "endAt">,
  right: Pick<AssignmentWriteCandidate, "startAt" | "endAt">,
): boolean {
  return left.startAt < right.endAt && left.endAt > right.startAt;
}

/**
 * Mutex comum para qualquer escrita que possa tornar uma alocação ativa ou
 * mudar sua janela. A ordem total por professional_id evita ciclos em lotes,
 * trocas e ações simultâneas de gestores distintos.
 */
export async function lockAssignmentProfessionalsForUpdate(
  tx: AssignmentWriteTx,
  professionalIds: readonly number[],
  expectedSessionsByProfessionalId: ReadonlyMap<
    number,
    Readonly<{ expectedUserId: number; expectedSessionVersion: number }>
  > = new Map(),
): Promise<Map<number, LockedAssignmentProfessional>> {
  const locked = new Map<number, LockedAssignmentProfessional>();
  const ordered = [...new Set(professionalIds)].sort(
    (left, right) => left - right,
  );
  const snapshots = new Map<number, LockedAssignmentProfessional>();
  for (const professionalId of ordered) {
    const [snapshot] = await tx
      .select({
        id: professionals.id,
        userId: professionals.userId,
        specialty: professionals.specialty,
      })
      .from(professionals)
      .where(eq(professionals.id, professionalId))
      .limit(1);
    if (!snapshot) {
      throw assignmentForbidden(
        "Profissional inexistente, inativo ou sem usuário aprovado.",
      );
    }
    snapshots.set(professionalId, snapshot);
  }

  // Identidade segue uma única ordem em toda a aplicação: users por id,
  // depois professionals por id. Joins FOR UPDATE podem ser reordenados pelo
  // optimizer e por isso não servem como protocolo de deadlock.
  const orderedUserIds = [
    ...new Set([...snapshots.values()].map((snapshot) => snapshot.userId)),
  ].sort((left, right) => left - right);
  const expectedSessionsByUserId = new Map<number, number>();
  for (const [professionalId, expected] of expectedSessionsByProfessionalId) {
    const snapshot = snapshots.get(professionalId);
    if (!snapshot || snapshot.userId !== expected.expectedUserId) {
      throw assignmentForbidden(
        "Identidade profissional não corresponde ao usuário autenticado.",
      );
    }
    const previous = expectedSessionsByUserId.get(expected.expectedUserId);
    if (
      previous !== undefined &&
      previous !== expected.expectedSessionVersion
    ) {
      throw assignmentConflict(
        "Expectativas de sessão divergentes para o mesmo usuário.",
      );
    }
    expectedSessionsByUserId.set(
      expected.expectedUserId,
      expected.expectedSessionVersion,
    );
  }
  for (const userId of orderedUserIds) {
    const [user] = await tx
      .select({ id: users.id, sessionVersion: users.sessionVersion })
      .from(users)
      .where(
        and(
          eq(users.id, userId),
          eq(users.approvalStatus, "APPROVED"),
          isNull(users.deletedAt),
        ),
      )
      .limit(1)
      .for("update");
    if (!user) {
      throw assignmentForbidden(
        "Profissional inexistente, inativo ou sem usuário aprovado.",
      );
    }
    const expectedSessionVersion = expectedSessionsByUserId.get(userId);
    if (
      expectedSessionVersion !== undefined &&
      user.sessionVersion !== expectedSessionVersion
    ) {
      throw assignmentConflict(
        "A sessão foi revogada durante a candidatura. Entre novamente e repita.",
      );
    }
  }
  for (const professionalId of ordered) {
    const snapshot = snapshots.get(professionalId)!;
    const [professional] = await tx
      .select({
        id: professionals.id,
        userId: professionals.userId,
        specialty: professionals.specialty,
      })
      .from(professionals)
      .where(
        and(
          eq(professionals.id, professionalId),
          eq(professionals.userId, snapshot.userId),
        ),
      )
      .limit(1)
      .for("update");
    if (!professional) {
      throw assignmentForbidden(
        "Identidade profissional mudou durante a operação.",
      );
    }
    locked.set(professionalId, professional);
  }

  return locked;
}

/**
 * Revalida, na própria transação da escrita, identidade canônica, vínculo,
 * acesso, contexto operacional e anti-overlap. O caller deve manter o turno/mês alvo
 * sob lock; este helper acrescenta o mutex global por profissional.
 */
export async function assertAssignmentWritesAllowedForUpdate(
  tx: AssignmentWriteTx,
  candidates: readonly AssignmentWriteCandidate[],
  options: { additionalProfessionalIds?: readonly number[] } = {},
): Promise<Map<number, LockedAssignmentProfessional>> {
  const expectedSessionsByProfessionalId = new Map<
    number,
    Readonly<{ expectedUserId: number; expectedSessionVersion: number }>
  >();
  const orderedCandidates = [...candidates].sort(
    (left, right) =>
      (left.scheduleContextId ?? -1) - (right.scheduleContextId ?? -1) ||
      left.professionalId - right.professionalId ||
      left.startAt.getTime() - right.startAt.getTime(),
  );
  for (const candidate of orderedCandidates) {
    if (
      !Number.isFinite(candidate.startAt.getTime()) ||
      !Number.isFinite(candidate.endAt.getTime()) ||
      candidate.endAt <= candidate.startAt
    ) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Janela de plantão inválida para alocação.",
      });
    }
    if (
      candidate.expectedSessionVersion !== undefined &&
      candidate.expectedUserId === undefined
    ) {
      throw new TypeError(
        "AssignmentWriteCandidate.expectedSessionVersion exige expectedUserId",
      );
    }
    if (
      candidate.expectedSessionVersion !== undefined &&
      candidate.expectedUserId !== undefined
    ) {
      const previous = expectedSessionsByProfessionalId.get(
        candidate.professionalId,
      );
      if (
        previous &&
        (previous.expectedUserId !== candidate.expectedUserId ||
          previous.expectedSessionVersion !== candidate.expectedSessionVersion)
      ) {
        throw assignmentConflict(
          "Expectativas de identidade/sessão divergentes para o mesmo profissional.",
        );
      }
      expectedSessionsByProfessionalId.set(candidate.professionalId, {
        expectedUserId: candidate.expectedUserId,
        expectedSessionVersion: candidate.expectedSessionVersion,
      });
    }
    if (candidate.scheduleContextId === null) {
      throw assignmentForbidden("Plantão sem escala operacional classificada.");
    }
  }

  const lockedProfessionals = await lockAssignmentProfessionalsForUpdate(
    tx,
    [
      ...candidates.map((candidate) => candidate.professionalId),
      ...(options.additionalProfessionalIds ?? []),
    ],
    expectedSessionsByProfessionalId,
  );

  const topologyKeys = new Map<
    string,
    Pick<AssignmentWriteCandidate, "institutionId" | "hospitalId" | "sectorId">
  >();
  for (const candidate of orderedCandidates) {
    topologyKeys.set(
      `${candidate.institutionId}|${candidate.hospitalId}|${candidate.sectorId}`,
      candidate,
    );
  }
  for (const [, topology] of [...topologyKeys.entries()].sort(
    ([left], [right]) => left.localeCompare(right),
  )) {
    await assertInstitutionHierarchy(topology, { db: tx, lockForShare: true });
  }

  const requiresExactSectorAccessByContext = new Map<number, boolean>();
  for (const candidate of orderedCandidates) {
    if (
      candidate.scheduleContextId === null ||
      requiresExactSectorAccessByContext.has(candidate.scheduleContextId)
    ) {
      continue;
    }
    const [context] = await tx
      .select({ admissionPolicy: scheduleContexts.admissionPolicy })
      .from(scheduleContexts)
      .where(
        and(
          eq(scheduleContexts.id, candidate.scheduleContextId),
          eq(scheduleContexts.institutionId, candidate.institutionId),
          eq(scheduleContexts.hospitalId, candidate.hospitalId),
          eq(scheduleContexts.sectorId, candidate.sectorId),
        ),
      )
      .limit(1)
      .for("share");
    requiresExactSectorAccessByContext.set(
      candidate.scheduleContextId,
      context?.admissionPolicy === "QUALIFICATION_ALLOWLIST",
    );
  }

  const membershipCache = new Set<string>();
  const membershipLocks: {
    id: number;
    key: string;
    professionalId: number;
    userId: number;
    institutionId: number;
  }[] = [];
  for (const candidate of candidates) {
    const professional = lockedProfessionals.get(candidate.professionalId)!;
    const key = `${professional.id}|${professional.userId}|${candidate.institutionId}`;
    if (membershipCache.has(key)) continue;
    const [snapshot] = await tx
      .select({
        id: professionalInstitutions.id,
        active: professionalInstitutions.active,
      })
      .from(professionalInstitutions)
      .where(
        and(
          eq(professionalInstitutions.professionalId, professional.id),
          eq(professionalInstitutions.userId, professional.userId),
          eq(professionalInstitutions.institutionId, candidate.institutionId),
        ),
      )
      .orderBy(professionalInstitutions.id)
      .limit(1);
    let membershipId = snapshot?.id;
    if (!snapshot || !snapshot.active) {
      const invited = await pendingNamedInviteCoversScale(tx, {
        institutionId: candidate.institutionId,
        hospitalId: candidate.hospitalId,
        sectorId: candidate.sectorId,
        userId: professional.userId,
      });
      if (!invited) {
        throw assignmentForbidden(
          "Profissional sem vínculo canônico ativo nesta instituição.",
        );
      }
      if (snapshot) {
        await tx
          .update(professionalInstitutions)
          .set({ active: true })
          .where(eq(professionalInstitutions.id, snapshot.id));
        membershipId = snapshot.id;
      } else {
        const [created] = await tx
          .insert(professionalInstitutions)
          .values({
            professionalId: professional.id,
            userId: professional.userId,
            institutionId: candidate.institutionId,
            roleInInstitution: "USER",
            isPrimary: true,
            active: true,
          })
          .$returningId();
        membershipId = created.id;
      }
    }
    if (membershipId === undefined) {
      throw assignmentForbidden(
        "Profissional sem vínculo canônico ativo nesta instituição.",
      );
    }
    membershipCache.add(key);
    membershipLocks.push({
      id: membershipId,
      key,
      professionalId: professional.id,
      userId: professional.userId,
      institutionId: candidate.institutionId,
    });
  }
  for (const lock of membershipLocks.sort(
    (left, right) => left.id - right.id,
  )) {
    const [membership] = await tx
      .select({ id: professionalInstitutions.id })
      .from(professionalInstitutions)
      .where(
        and(
          eq(professionalInstitutions.id, lock.id),
          eq(professionalInstitutions.professionalId, lock.professionalId),
          eq(professionalInstitutions.userId, lock.userId),
          eq(professionalInstitutions.institutionId, lock.institutionId),
          eq(professionalInstitutions.active, true),
        ),
      )
      .limit(1)
      .for("update");
    if (!membership) {
      throw assignmentForbidden(
        "Profissional sem vínculo canônico ativo nesta instituição.",
      );
    }
  }

  const accessCache = new Set<string>();
  const managerCoveredProfessionalIds = new Set<number>();
  const accessLocks: {
    id: number;
    professionalId: number;
    institutionId: number;
    hospitalId: number;
    sectorId: number;
    requiresExactSectorAccess: boolean;
  }[] = [];
  const requiresExactSectorAccessByAccessKey = new Map<string, boolean>();
  for (const candidate of candidates) {
    const key = `${candidate.professionalId}|${candidate.institutionId}|${candidate.hospitalId}|${candidate.sectorId}`;
    const requiresExactSectorAccess =
      candidate.scheduleContextId !== null &&
      requiresExactSectorAccessByContext.get(candidate.scheduleContextId) ===
        true;
    requiresExactSectorAccessByAccessKey.set(
      key,
      requiresExactSectorAccessByAccessKey.get(key) === true ||
        requiresExactSectorAccess,
    );
  }
  for (const candidate of candidates) {
    const professional = lockedProfessionals.get(candidate.professionalId)!;
    const key = `${professional.id}|${candidate.institutionId}|${candidate.hospitalId}|${candidate.sectorId}`;
    if (accessCache.has(key)) continue;
    const requiresExactSectorAccess =
      requiresExactSectorAccessByAccessKey.get(key) === true;
    const [snapshot] = await tx
      .select({ id: professionalAccess.id })
      .from(professionalAccess)
      .where(
        and(
          eq(professionalAccess.professionalId, professional.id),
          eq(professionalAccess.institutionId, candidate.institutionId),
          eq(professionalAccess.hospitalId, candidate.hospitalId),
          eq(professionalAccess.canAccess, true),
          requiresExactSectorAccess
            ? eq(professionalAccess.sectorId, candidate.sectorId)
            : or(
                isNull(professionalAccess.sectorId),
                eq(professionalAccess.sectorId, candidate.sectorId),
              ),
        ),
      )
      .orderBy(professionalAccess.id)
      .limit(1);
    if (!snapshot) {
      const coverage = await assignmentCoverageWithoutSectorAccess(tx, {
        professionalId: professional.id,
        userId: professional.userId,
        institutionId: candidate.institutionId,
        hospitalId: candidate.hospitalId,
        sectorId: candidate.sectorId,
      });
      if (!coverage) {
        throw assignmentForbidden(
          "Profissional sem acesso ativo ao hospital/setor do plantão.",
        );
      }
      // Mesma porta de receive/oferta: GESTOR_PLUS e manager_scope
      // escrevem a alocação sem especialidade/allowlist. Sem isso o
      // aceite de um coordenador (Reno/Maurilio) 500 no effectuate.
      // Convite pendente não é receive — não alarga o skip.
      if (coverage === "manager") {
        managerCoveredProfessionalIds.add(professional.id);
      }
      accessCache.add(key);
      continue;
    }
    accessCache.add(key);
    accessLocks.push({
      id: snapshot.id,
      professionalId: professional.id,
      institutionId: candidate.institutionId,
      hospitalId: candidate.hospitalId,
      sectorId: candidate.sectorId,
      requiresExactSectorAccess,
    });
  }
  for (const lock of accessLocks.sort((left, right) => left.id - right.id)) {
    const [access] = await tx
      .select({ id: professionalAccess.id })
      .from(professionalAccess)
      .where(
        and(
          eq(professionalAccess.id, lock.id),
          eq(professionalAccess.professionalId, lock.professionalId),
          eq(professionalAccess.institutionId, lock.institutionId),
          eq(professionalAccess.hospitalId, lock.hospitalId),
          eq(professionalAccess.canAccess, true),
          lock.requiresExactSectorAccess
            ? eq(professionalAccess.sectorId, lock.sectorId)
            : or(
                isNull(professionalAccess.sectorId),
                eq(professionalAccess.sectorId, lock.sectorId),
              ),
        ),
      )
      .limit(1)
      .for("update");
    if (!access) {
      throw assignmentForbidden(
        "Profissional sem acesso ativo ao hospital/setor do plantão.",
      );
    }
  }

  const scheduleCache = new Map<
    number,
    {
      assignmentId: number;
      assignmentInstitutionId: number;
      assignmentHospitalId: number;
      assignmentSectorId: number;
      shiftInstanceId: number;
      shiftInstitutionId: number;
      shiftHospitalId: number;
      shiftSectorId: number;
      shiftLabel: string;
      shiftStartAt: Date;
      shiftEndAt: Date;
      hospitalInstitutionId: number;
      sectorInstitutionId: number;
      sectorHospitalId: number;
    }[]
  >();

  for (const candidate of orderedCandidates) {
    const professional = lockedProfessionals.get(candidate.professionalId)!;
    if (
      candidate.expectedUserId !== undefined &&
      professional.userId !== candidate.expectedUserId
    ) {
      throw assignmentForbidden(
        "Identidade profissional não corresponde ao usuário autenticado.",
      );
    }

    // A autorização é exclusivamente estruturada e revalidada contra o
    // schedule_context_id. O texto clínico é descritivo e nunca concede nem
    // nega uma alocação.
    if (managerCoveredProfessionalIds.has(professional.id)) {
      await assertActiveScheduleContextTopology({
        institutionId: candidate.institutionId,
        hospitalId: candidate.hospitalId,
        sectorId: candidate.sectorId,
        scheduleContextId: candidate.scheduleContextId,
        db: tx,
      });
    } else {
      await assertProfessionalEligibleForScheduleContext({
        institutionId: candidate.institutionId,
        professionalId: candidate.professionalId,
        scheduleContextId: candidate.scheduleContextId,
        db: tx,
        lockForShare: true,
      });
      await assertActiveScheduleContextTopology({
        institutionId: candidate.institutionId,
        hospitalId: candidate.hospitalId,
        sectorId: candidate.sectorId,
        scheduleContextId: candidate.scheduleContextId,
        db: tx,
      });
    }

    let activeSchedule = scheduleCache.get(professional.id);
    if (!activeSchedule) {
      activeSchedule = await tx
        .select({
          assignmentId: shiftAssignmentsV2.id,
          assignmentInstitutionId: shiftAssignmentsV2.institutionId,
          assignmentHospitalId: shiftAssignmentsV2.hospitalId,
          assignmentSectorId: shiftAssignmentsV2.sectorId,
          shiftInstanceId: shiftInstances.id,
          shiftInstitutionId: shiftInstances.institutionId,
          shiftHospitalId: shiftInstances.hospitalId,
          shiftSectorId: shiftInstances.sectorId,
          shiftLabel: shiftInstances.label,
          shiftStartAt: shiftInstances.startAt,
          shiftEndAt: shiftInstances.endAt,
          hospitalInstitutionId: hospitals.institutionId,
          sectorInstitutionId: sectors.institutionId,
          sectorHospitalId: sectors.hospitalId,
        })
        .from(shiftAssignmentsV2)
        .innerJoin(
          shiftInstances,
          eq(shiftInstances.id, shiftAssignmentsV2.shiftInstanceId),
        )
        .innerJoin(hospitals, eq(hospitals.id, shiftInstances.hospitalId))
        .innerJoin(sectors, eq(sectors.id, shiftInstances.sectorId))
        .where(
          and(
            eq(shiftAssignmentsV2.professionalId, professional.id),
            eq(shiftAssignmentsV2.isActive, true),
          ),
        );
      for (const assignment of activeSchedule) {
        if (
          assignment.assignmentInstitutionId !==
            assignment.shiftInstitutionId ||
          assignment.assignmentHospitalId !== assignment.shiftHospitalId ||
          assignment.assignmentSectorId !== assignment.shiftSectorId ||
          assignment.hospitalInstitutionId !== assignment.shiftInstitutionId ||
          assignment.sectorInstitutionId !== assignment.shiftInstitutionId ||
          assignment.sectorHospitalId !== assignment.shiftHospitalId
        ) {
          throw assignmentConflict(
            "Profissional possui alocação ativa com topologia inconsistente; regularize antes de editar a escala.",
          );
        }
      }
      scheduleCache.set(professional.id, activeSchedule);
    }

    const excluded = new Set(candidate.excludeAssignmentIds ?? []);
    const overlap = activeSchedule.find(
      (assignment) =>
        !excluded.has(assignment.assignmentId) &&
        assignment.shiftStartAt < candidate.endAt &&
        assignment.shiftEndAt > candidate.startAt,
    );
    if (overlap) {
      throw assignmentConflict(
        `Conflito de horário: profissional já alocado em "${overlap.shiftLabel}" no hospital ${overlap.shiftHospitalId}.`,
      );
    }
  }

  for (let left = 0; left < candidates.length; left++) {
    for (let right = left + 1; right < candidates.length; right++) {
      if (
        candidates[left].professionalId === candidates[right].professionalId &&
        windowsOverlap(candidates[left], candidates[right])
      ) {
        throw assignmentConflict(
          "O mesmo profissional aparece em duas novas alocações com horários sobrepostos.",
        );
      }
    }
  }

  return lockedProfessionals;
}

/**
 * Capacidade canônica por shift_instance. O turno alvo já deve estar sob lock;
 * por isso o contador não pode ficar obsoleto entre a leitura e a escrita.
 */
export async function assertShiftAssignmentCapacityForUpdate(
  tx: AssignmentWriteTx,
  input: ShiftCapacityInput,
): Promise<number> {
  const active = await tx
    .select({
      id: shiftAssignmentsV2.id,
      institutionId: shiftAssignmentsV2.institutionId,
      hospitalId: shiftAssignmentsV2.hospitalId,
      sectorId: shiftAssignmentsV2.sectorId,
    })
    .from(shiftAssignmentsV2)
    .where(
      and(
        eq(shiftAssignmentsV2.shiftInstanceId, input.shiftInstanceId),
        eq(shiftAssignmentsV2.isActive, true),
      ),
    );

  if (
    active.some(
      (assignment) =>
        assignment.institutionId !== input.institutionId ||
        assignment.hospitalId !== input.hospitalId ||
        assignment.sectorId !== input.sectorId,
    )
  ) {
    throw assignmentConflict(
      "O turno contém alocação ativa com topologia inconsistente.",
    );
  }
  if (
    input.expectedCurrentActiveCount !== undefined &&
    active.length !== input.expectedCurrentActiveCount
  ) {
    throw assignmentConflict(
      "O conjunto de alocações do turno mudou durante a operação.",
    );
  }

  const projected = active.length + (input.activeDelta ?? 0);
  const max = input.maxActiveAssignments ?? 20;
  if (projected < 0 || projected > max) {
    throw assignmentConflict(
      `Limite de ${max} profissionais por turno excedido (${projected}/${max}).`,
    );
  }
  return active.length;
}

export interface ConflictResult {
  hasConflict: boolean;
  conflicts: {
    shiftInstanceId: number;
    label: string;
    startAt: Date;
    endAt: Date;
    hospitalId: number;
    professionalId: number;
  }[];
}

/**
 * Frente H1/H2: anti-overlap (escala-ux §8).
 *
 * The query intentionally filters only on `is_active = 1` — no filter on
 * `assignment_type` or `status`. This means:
 *   - PENDENTE assignments block (a request awaiting manager approval still
 *     reserves the professional's time)
 *   - ON_DUTY, BACKUP and ON_CALL (sobreaviso) all count as occupation. A
 *     professional on sobreaviso cannot be scheduled for a plantão in the
 *     same window, and vice-versa.
 *
 * Overlap predicate: existing.start < target.end AND existing.end > target.start.
 *
 * Internal helper — public API is the two `check*`/`assert*` pairs below.
 */
async function runConflictQuery(
  selector: SQL,
  startAt: Date,
  endAt: Date,
  excludeShiftInstanceId?: number,
): Promise<ConflictResult> {
  const db = await getDb();
  if (!db) return { hasConflict: false, conflicts: [] };

  const startIso = startAt.toISOString().slice(0, 19).replace("T", " ");
  const endIso = endAt.toISOString().slice(0, 19).replace("T", " ");

  const results = await db.execute(sql`
    SELECT
      si.id            AS shift_instance_id,
      si.label,
      si.start_at,
      si.end_at,
      si.hospital_id,
      sa.professional_id
    FROM shift_assignments_v2 sa
    JOIN professionals p  ON p.id  = sa.professional_id
    JOIN shift_instances si ON si.id = sa.shift_instance_id
    WHERE ${selector}
      AND sa.is_active = 1
      AND si.start_at  < ${endIso}
      AND si.end_at    > ${startIso}
      ${
        excludeShiftInstanceId != null
          ? sql`AND si.id != ${excludeShiftInstanceId}`
          : sql``
      }
  `);

  const rows = (results as any)[0] as any[];

  return {
    hasConflict: rows.length > 0,
    conflicts: rows.map((r) => ({
      shiftInstanceId: r.shift_instance_id as number,
      label: r.label as string,
      startAt: new Date(r.start_at),
      endAt: new Date(r.end_at),
      hospitalId: r.hospital_id as number,
      professionalId: r.professional_id as number,
    })),
  };
}

function buildConflictMessage(c: ConflictResult["conflicts"][0]): string {
  const startStr = c.startAt.toLocaleString("pt-BR");
  const endStr = c.endAt.toLocaleString("pt-BR");
  return (
    `Conflito de horário: profissional já alocado em "${c.label}" ` +
    `(${startStr} – ${endStr}) no hospital ${c.hospitalId}`
  );
}

/**
 * Verifica se um userId tem conflito de horário com um intervalo.
 * Resolve userId → professional via JOIN. Use a variante
 * `*ForProfessional` quando o caller já tem o `professional_id` em mãos.
 *
 * excludeShiftInstanceId: exclui um shift específico (útil para
 * confirmação de edição ou aceite de troca).
 */
export async function checkTimeConflict(
  userId: number,
  startAt: Date,
  endAt: Date,
  excludeShiftInstanceId?: number,
): Promise<ConflictResult> {
  return runConflictQuery(
    sql`p.user_id = ${userId}`,
    startAt,
    endAt,
    excludeShiftInstanceId,
  );
}

/**
 * Variante por professional_id. Use em fluxos de gestor (assignDirect,
 * approveAssignment) onde o input já carrega o ID do profissional alvo,
 * evitando um JOIN/lookup extra para descobrir o user_id.
 */
export async function checkTimeConflictForProfessional(
  professionalId: number,
  startAt: Date,
  endAt: Date,
  excludeShiftInstanceId?: number,
): Promise<ConflictResult> {
  return runConflictQuery(
    sql`sa.professional_id = ${professionalId}`,
    startAt,
    endAt,
    excludeShiftInstanceId,
  );
}

/**
 * Verifica conflito e lança erro se existir.
 * Usar antes de qualquer assignment creation/approval.
 */
export async function assertNoTimeConflict(
  userId: number,
  startAt: Date,
  endAt: Date,
  excludeShiftInstanceId?: number,
): Promise<void> {
  const result = await checkTimeConflict(
    userId,
    startAt,
    endAt,
    excludeShiftInstanceId,
  );
  if (result.hasConflict) {
    throw new Error(buildConflictMessage(result.conflicts[0]));
  }
}

/**
 * Variante por professional_id. Mesma semântica de
 * `assertNoTimeConflict`, mas resolve por `sa.professional_id`.
 */
export async function assertNoTimeConflictForProfessional(
  professionalId: number,
  startAt: Date,
  endAt: Date,
  excludeShiftInstanceId?: number,
): Promise<void> {
  const result = await checkTimeConflictForProfessional(
    professionalId,
    startAt,
    endAt,
    excludeShiftInstanceId,
  );
  if (result.hasConflict) {
    throw new Error(buildConflictMessage(result.conflicts[0]));
  }
}

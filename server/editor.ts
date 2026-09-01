import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, protectedProcedure } from "./_core/trpc";
import { getDb } from "./db";
import { ForbiddenError } from "../shared/_core/errors";
import { assertMonthEditableForUpdate } from "./month-guards";
import { auditLog } from "./audit-log";
import { recordAudit } from "./audit-trail";
import { and, eq } from "drizzle-orm";
import { shiftAssignmentsV2, shiftInstances } from "../drizzle/schema";
import { recomputeShiftStatus } from "./shift-status";
import { advanceShiftInstanceRevision } from "./shift-instance-revision";
import {
  assertCanEditScheduleDate,
  assertCanManageInstitutionSchedule,
  assertManagerScopeAccess,
  assertManagerScopeAccessForUpdate,
  getTenantActorFromContext,
} from "./_core/policy";
import { assertInstitutionHierarchy } from "./_core/tenant";
import {
  ASSIGNMENT_WRITE_TRANSACTION_CONFIG,
  assertAssignmentWritesAllowedForUpdate,
  assertShiftAssignmentCapacityForUpdate,
  type AssignmentWriteTx,
} from "./shift-validations-v2";
import {
  ALLOCATION_REPEAT_RULES,
  listActiveAssignmentShiftIds,
  listRepeatAssignmentCandidates,
  selectRepeatTargets,
  type AllocationRepeatRule,
} from "./allocation-repeat";
import {
  enqueueShiftAssignedPush,
  enqueueShiftUnassignedPush,
} from "./assignment-push-signal";
import { enqueueDutySyncWithdrawsForRemovedProfessionals } from "./sso/duty-sync-lifecycle";

type EditorDb = Pick<NonNullable<Awaited<ReturnType<typeof getDb>>>, "select">;

type ShiftTarget = {
  id: number;
  institutionId: number;
  hospitalId: number;
  sectorId: number;
  scheduleContextId: number | null;
  specialty: string | null;
  label: string;
  startAt: Date;
  endAt: Date;
  status: string;
  operationalRevision: number;
};

type AssignmentTarget = ShiftTarget & {
  assignmentId: number;
  professionalId: number;
  assignmentStatus: string;
  isActive: boolean;
};

async function getShiftTarget(
  db: EditorDb,
  shiftInstanceId: number,
  institutionId: number,
  lockForUpdate = false,
): Promise<ShiftTarget | null> {
  const query = db
    .select({
      id: shiftInstances.id,
      institutionId: shiftInstances.institutionId,
      hospitalId: shiftInstances.hospitalId,
      sectorId: shiftInstances.sectorId,
      scheduleContextId: shiftInstances.scheduleContextId,
      specialty: shiftInstances.specialty,
      label: shiftInstances.label,
      startAt: shiftInstances.startAt,
      endAt: shiftInstances.endAt,
      status: shiftInstances.status,
      operationalRevision: shiftInstances.operationalRevision,
    })
    .from(shiftInstances)
    .where(
      and(
        eq(shiftInstances.id, shiftInstanceId),
        eq(shiftInstances.institutionId, institutionId),
      ),
    )
    .limit(1);
  const rows = lockForUpdate ? await query.for("update") : await query;
  const shift = rows[0];
  if (!shift) return null;
  try {
    await assertInstitutionHierarchy(
      {
        institutionId: shift.institutionId,
        hospitalId: shift.hospitalId,
        sectorId: shift.sectorId,
      },
      { db, lockForShare: lockForUpdate },
    );
  } catch (error) {
    // A leitura de autorização não deve revelar a existência de um turno
    // legado/envenenado fora da hierarquia. Dentro da transação, a mesma
    // incoerência continua falhando explicitamente e sem escrita.
    if (
      !lockForUpdate &&
      error instanceof TRPCError &&
      error.code === "FORBIDDEN"
    ) {
      return null;
    }
    throw error;
  }
  return shift;
}

async function getAssignmentTarget(
  db: EditorDb,
  assignmentId: number,
  institutionId: number,
  lockForUpdate = false,
  expectedShiftInstanceId?: number,
): Promise<AssignmentTarget | null> {
  if (lockForUpdate) {
    if (expectedShiftInstanceId === undefined) {
      throw new Error(
        "expectedShiftInstanceId is required for an assignment lock",
      );
    }
    const [shift] = await db
      .select({
        id: shiftInstances.id,
        institutionId: shiftInstances.institutionId,
        hospitalId: shiftInstances.hospitalId,
        sectorId: shiftInstances.sectorId,
        scheduleContextId: shiftInstances.scheduleContextId,
        specialty: shiftInstances.specialty,
        label: shiftInstances.label,
        startAt: shiftInstances.startAt,
        endAt: shiftInstances.endAt,
        status: shiftInstances.status,
        operationalRevision: shiftInstances.operationalRevision,
      })
      .from(shiftInstances)
      .where(
        and(
          eq(shiftInstances.id, expectedShiftInstanceId),
          eq(shiftInstances.institutionId, institutionId),
        ),
      )
      .limit(1)
      .for("update");
    if (!shift) return null;
    const [assignment] = await db
      .select({
        assignmentId: shiftAssignmentsV2.id,
        professionalId: shiftAssignmentsV2.professionalId,
        assignmentStatus: shiftAssignmentsV2.status,
        isActive: shiftAssignmentsV2.isActive,
        shiftInstanceId: shiftAssignmentsV2.shiftInstanceId,
        institutionId: shiftAssignmentsV2.institutionId,
        hospitalId: shiftAssignmentsV2.hospitalId,
        sectorId: shiftAssignmentsV2.sectorId,
      })
      .from(shiftAssignmentsV2)
      .where(
        and(
          eq(shiftAssignmentsV2.id, assignmentId),
          eq(shiftAssignmentsV2.institutionId, institutionId),
          eq(shiftAssignmentsV2.shiftInstanceId, expectedShiftInstanceId),
        ),
      )
      .limit(1)
      .for("update");
    if (
      !assignment ||
      assignment.institutionId !== shift.institutionId ||
      assignment.hospitalId !== shift.hospitalId ||
      assignment.sectorId !== shift.sectorId
    ) {
      return null;
    }
    await assertInstitutionHierarchy(
      {
        institutionId: shift.institutionId,
        hospitalId: shift.hospitalId,
        sectorId: shift.sectorId,
      },
      { db, lockForShare: true },
    );
    return {
      assignmentId: assignment.assignmentId,
      professionalId: assignment.professionalId,
      assignmentStatus: assignment.assignmentStatus,
      isActive: assignment.isActive,
      ...shift,
    };
  }

  const query = db
    .select({
      assignmentId: shiftAssignmentsV2.id,
      professionalId: shiftAssignmentsV2.professionalId,
      assignmentStatus: shiftAssignmentsV2.status,
      isActive: shiftAssignmentsV2.isActive,
      id: shiftInstances.id,
      institutionId: shiftInstances.institutionId,
      hospitalId: shiftInstances.hospitalId,
      sectorId: shiftInstances.sectorId,
      scheduleContextId: shiftInstances.scheduleContextId,
      specialty: shiftInstances.specialty,
      label: shiftInstances.label,
      startAt: shiftInstances.startAt,
      endAt: shiftInstances.endAt,
      status: shiftInstances.status,
      operationalRevision: shiftInstances.operationalRevision,
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
    .where(
      and(
        eq(shiftAssignmentsV2.id, assignmentId),
        eq(shiftAssignmentsV2.institutionId, institutionId),
      ),
    )
    .limit(1);
  const [assignment] = await query;
  if (!assignment) return null;
  await assertInstitutionHierarchy(
    {
      institutionId: assignment.institutionId,
      hospitalId: assignment.hospitalId,
      sectorId: assignment.sectorId,
    },
    { db },
  );
  return assignment;
}

function sameInstant(left: Date, right: Date): boolean {
  return left.getTime() === right.getTime();
}

function assertSameShiftTarget(
  authorized: ShiftTarget,
  locked: ShiftTarget,
): void {
  if (
    authorized.id !== locked.id ||
    authorized.institutionId !== locked.institutionId ||
    authorized.hospitalId !== locked.hospitalId ||
    authorized.sectorId !== locked.sectorId ||
    authorized.scheduleContextId !== locked.scheduleContextId ||
    authorized.specialty !== locked.specialty ||
    authorized.label !== locked.label ||
    authorized.status !== locked.status ||
    authorized.operationalRevision !== locked.operationalRevision ||
    !sameInstant(authorized.startAt, locked.startAt) ||
    !sameInstant(authorized.endAt, locked.endAt)
  ) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "O turno mudou enquanto a edição era processada.",
    });
  }
}

function selectLockedRepeatTargets(
  source: ShiftTarget,
  lockedById: Map<number, ShiftTarget>,
  rule: AllocationRepeatRule,
): ShiftTarget[] {
  return selectRepeatTargets(source, [...lockedById.values()], rule);
}

async function insertDirectAssignment(
  tx: AssignmentWriteTx,
  input: {
    shift: ShiftTarget;
    professionalId: number;
    assignmentType: "ON_DUTY" | "BACKUP" | "ON_CALL";
    reason?: string;
    userId: number;
    managerId: number;
    actorRole: "GESTOR_MEDICO" | "GESTOR_PLUS";
    actorName?: string;
    repeatRule: AllocationRepeatRule;
    isRepeat: boolean;
  },
): Promise<number> {
  const [inserted] = await tx.insert(shiftAssignmentsV2).values({
    shiftInstanceId: input.shift.id,
    institutionId: input.shift.institutionId,
    hospitalId: input.shift.hospitalId,
    sectorId: input.shift.sectorId,
    professionalId: input.professionalId,
    assignmentType: input.assignmentType,
    status: "OCUPADO",
    isActive: true,
    createdBy: input.userId,
  });
  await recomputeShiftStatus(tx, input.shift.id);
  const createdAssignmentId = Number(inserted.insertId);
  const reason =
    input.reason ||
    (input.isRepeat
      ? `Alocação repetida (${input.repeatRule}): ${input.assignmentType}`
      : `Alocação direta: ${input.assignmentType}`);

  await auditLog(
    {
      event: "SHIFT_ASSIGNED",
      shiftInstanceId: input.shift.id,
      institutionId: input.shift.institutionId,
      professionalId: input.managerId,
      reason,
      metadata: {
        assignmentId: createdAssignmentId,
        allocatedProfessionalId: input.professionalId,
        assignmentType: input.assignmentType,
        repeatRule: input.repeatRule,
        isRepeat: input.isRepeat,
      },
    },
    { db: tx },
  );
  await recordAudit(
    {
      action: "ASSIGNMENT_CREATED",
      entityType: "SHIFT_ASSIGNMENT",
      entityId: createdAssignmentId,
      actorUserId: input.userId,
      actorRole: input.actorRole,
      actorName: input.actorName,
      description: input.isRepeat
        ? `Alocação repetida do profissional #${input.professionalId} no turno #${input.shift.id}`
        : `Alocação direta do profissional #${input.professionalId} no turno #${input.shift.id}`,
      institutionId: input.shift.institutionId,
      shiftInstanceId: input.shift.id,
      hospitalId: input.shift.hospitalId,
      sectorId: input.shift.sectorId,
      toProfessionalId: input.professionalId,
      metadata: {
        assignmentType: input.assignmentType,
        repeatRule: input.repeatRule,
        isRepeat: input.isRepeat,
      },
    },
    { db: tx, strict: true },
  );
  await enqueueShiftAssignedPush({
    db: tx,
    assignmentId: createdAssignmentId,
    professionalId: input.professionalId,
    shift: {
      id: input.shift.id,
      institutionId: input.shift.institutionId,
      hospitalId: input.shift.hospitalId,
      sectorId: input.shift.sectorId,
      startAt: input.shift.startAt,
      endAt: input.shift.endAt,
    },
  });
  return createdAssignmentId;
}

function assertSameAssignmentTarget(
  authorized: AssignmentTarget,
  locked: AssignmentTarget,
): void {
  assertSameShiftTarget(authorized, locked);
  if (
    authorized.assignmentId !== locked.assignmentId ||
    authorized.professionalId !== locked.professionalId ||
    authorized.assignmentStatus !== locked.assignmentStatus ||
    authorized.isActive !== locked.isActive
  ) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "A alocação mudou enquanto a remoção era processada.",
    });
  }
}

/**
 * Editor Router
 *
 * Endpoints para edição direta de turnos por gestores:
 * - assignDirect: gestor aloca profissional diretamente (OCUPADO)
 * - markVacant: marca turno como VAGO
 * - unassignDirect: remove alocação
 */

export const editorRouter = router({
  /**
   * assignDirect
   * Gestor aloca profissional diretamente no turno (sem candidatura)
   */
  assignDirect: protectedProcedure
    .input(
      z.object({
        shiftInstanceId: z.number(),
        professionalId: z.number(),
        assignmentType: z.enum(["ON_DUTY", "BACKUP", "ON_CALL"]),
        reason: z.string().optional(),
        repeatRule: z.enum(ALLOCATION_REPEAT_RULES).default("none"),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { shiftInstanceId, professionalId, assignmentType, reason } = input;
      const repeatRule: AllocationRepeatRule = input.repeatRule;
      const userId = ctx.user?.id;
      if (!userId) {
        throw new ForbiddenError("Autenticação necessária");
      }
      const actor = await getTenantActorFromContext(ctx);
      assertCanManageInstitutionSchedule(actor);

      const db = await getDb();
      if (!db) throw new Error("Database not available");
      const managerId = actor.professionalId;
      if (!managerId) throw new ForbiddenError("Profissional não encontrado");

      // A leitura inicial serve apenas para autorização e UX. A transação
      // abaixo relê e trava o mesmo alvo antes de qualquer escrita.
      const shift = await getShiftTarget(
        db,
        shiftInstanceId,
        ctx.institutionId,
      );
      if (!shift) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Turno não encontrado",
        });
      }

      await assertManagerScopeAccess(actor, shift.hospitalId, shift.sectorId);
      assertCanEditScheduleDate(actor, shift.startAt);

      // Guarda mensal, revalidação/CAS do alvo, alocação, status e ambas as
      // trilhas de auditoria formam um único commit.
      const result = await db.transaction(async (tx) => {
        await assertMonthEditableForUpdate(
          tx,
          { user: { id: userId } },
          shift.institutionId,
          shift.hospitalId,
          shift.startAt,
          reason,
        );

        const previewTargets =
          repeatRule === "none"
            ? []
            : await listRepeatAssignmentCandidates(tx, shift, repeatRule);
        const lockIds = Array.from(
          new Set([shiftInstanceId, ...previewTargets.map((row) => row.id)]),
        ).sort((left, right) => left - right);

        const lockedById = new Map<number, ShiftTarget>();
        for (const id of lockIds) {
          const locked = await getShiftTarget(tx, id, ctx.institutionId, true);
          if (!locked) {
            if (id === shiftInstanceId) {
              throw new TRPCError({
                code: "CONFLICT",
                message: "O turno não está mais disponível.",
              });
            }
            continue;
          }
          lockedById.set(id, locked);
        }

        const lockedShift = lockedById.get(shiftInstanceId);
        if (!lockedShift) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "O turno não está mais disponível.",
          });
        }
        assertSameShiftTarget(shift, lockedShift);

        const matchingTargets = selectLockedRepeatTargets(
          lockedShift,
          lockedById,
          repeatRule,
        );
        const occupiedIds = await listActiveAssignmentShiftIds(tx, lockedShift.institutionId, [
          ...matchingTargets.map((row) => row.id),
        ]);
        const vacantTargets = matchingTargets.filter(
          (target) => target.status === "VAGO" && !occupiedIds.has(target.id),
        );
        const skippedOccupiedCount = matchingTargets.length - vacantTargets.length;
        const toAssign = [lockedShift, ...vacantTargets];

        await assertAssignmentWritesAllowedForUpdate(
          tx,
          toAssign.map((target) => ({
            professionalId,
            institutionId: target.institutionId,
            hospitalId: target.hospitalId,
            sectorId: target.sectorId,
            scheduleContextId: target.scheduleContextId,
            startAt: target.startAt,
            endAt: target.endAt,
            requiredSpecialty: target.specialty,
          })),
          { additionalProfessionalIds: [managerId] },
        );
        const actorRole = await assertManagerScopeAccessForUpdate(
          tx,
          actor,
          ctx.user.sessionVersion,
          lockedShift.hospitalId,
          lockedShift.sectorId,
          toAssign.map((target) => target.startAt),
        );
        for (const target of toAssign) {
          await assertShiftAssignmentCapacityForUpdate(tx, {
            shiftInstanceId: target.id,
            institutionId: target.institutionId,
            hospitalId: target.hospitalId,
            sectorId: target.sectorId,
            activeDelta: 1,
          });
        }

        let sourceAssignmentId = 0;
        for (const target of toAssign) {
          const createdAssignmentId = await insertDirectAssignment(tx, {
            shift: target,
            professionalId,
            assignmentType,
            reason,
            userId,
            managerId,
            actorRole,
            actorName: ctx.user.name ?? undefined,
            repeatRule,
            isRepeat: target.id !== shiftInstanceId,
          });
          if (target.id === shiftInstanceId) {
            sourceAssignmentId = createdAssignmentId;
          }
        }

        return {
          assignmentId: sourceAssignmentId,
          allocatedCount: toAssign.length,
          skippedOccupiedCount,
        };
      }, ASSIGNMENT_WRITE_TRANSACTION_CONFIG);

      return { ok: true, ...result };
    }),

  /**
   * markVacant
   * Marca turno como VAGO (remove assignments ativos se houver)
   */
  markVacant: protectedProcedure
    .input(
      z.object({
        shiftInstanceId: z.number(),
        reason: z.string().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { shiftInstanceId, reason } = input;
      const userId = ctx.user?.id;
      if (!userId) {
        throw new ForbiddenError("Autenticação necessária");
      }
      const actor = await getTenantActorFromContext(ctx);
      assertCanManageInstitutionSchedule(actor);

      const db = await getDb();
      if (!db) throw new Error("Database not available");
      const managerId = actor.professionalId;
      if (!managerId) throw new ForbiddenError("Profissional não encontrado");

      const shift = await getShiftTarget(
        db,
        shiftInstanceId,
        ctx.institutionId,
      );
      if (!shift) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Turno não encontrado",
        });
      }

      await assertManagerScopeAccess(actor, shift.hospitalId, shift.sectorId);
      assertCanEditScheduleDate(actor, shift.startAt);

      await db.transaction(async (tx) => {
        await assertMonthEditableForUpdate(
          tx,
          { user: { id: userId } },
          shift.institutionId,
          shift.hospitalId,
          shift.startAt,
          reason,
        );
        const lockedShift = await getShiftTarget(
          tx,
          shiftInstanceId,
          ctx.institutionId,
          true,
        );
        if (!lockedShift) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "O turno não está mais disponível.",
          });
        }
        assertSameShiftTarget(shift, lockedShift);
        const actorRole = await assertManagerScopeAccessForUpdate(
          tx,
          actor,
          ctx.user.sessionVersion,
          lockedShift.hospitalId,
          lockedShift.sectorId,
          [lockedShift.startAt],
        );

        // Uma linha envenenada com topologia divergente não pode ser apagada
        // por este tenant nem ignorada ao derivar o status: falha fechada.
        const activeAssignments = await tx
          .select({
            institutionId: shiftAssignmentsV2.institutionId,
            hospitalId: shiftAssignmentsV2.hospitalId,
            sectorId: shiftAssignmentsV2.sectorId,
          })
          .from(shiftAssignmentsV2)
          .where(
            and(
              eq(shiftAssignmentsV2.shiftInstanceId, shiftInstanceId),
              eq(shiftAssignmentsV2.isActive, true),
            ),
          );
        if (
          activeAssignments.some(
            (assignment) =>
              assignment.institutionId !== lockedShift.institutionId ||
              assignment.hospitalId !== lockedShift.hospitalId ||
              assignment.sectorId !== lockedShift.sectorId,
          )
        ) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "O turno contém alocação com topologia inconsistente.",
          });
        }
        if (lockedShift.status === "VAGO" && activeAssignments.length === 0) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "O turno já está vago.",
          });
        }

        await tx
          .update(shiftAssignmentsV2)
          .set({ isActive: false })
          .where(
            and(
              eq(shiftAssignmentsV2.shiftInstanceId, shiftInstanceId),
              eq(shiftAssignmentsV2.institutionId, lockedShift.institutionId),
              eq(shiftAssignmentsV2.hospitalId, lockedShift.hospitalId),
              eq(shiftAssignmentsV2.sectorId, lockedShift.sectorId),
              eq(shiftAssignmentsV2.isActive, true),
            ),
          );

        if (lockedShift.status !== "VAGO") {
          try {
            await advanceShiftInstanceRevision(tx, lockedShift, {
              status: "VAGO",
            });
          } catch (error) {
            if (error instanceof TRPCError && error.code === "CONFLICT") {
              throw new TRPCError({
                code: "CONFLICT",
                message: "O turno mudou antes de ser marcado como vago.",
              });
            }
            throw error;
          }
        }

        await auditLog(
          {
            event: "SHIFT_MARKED_VACANT",
            shiftInstanceId,
            institutionId: lockedShift.institutionId,
            professionalId: managerId,
            reason: reason || "Turno marcado como vago",
            metadata: { removedAssignments: activeAssignments.length },
          },
          { db: tx },
        );
        await recordAudit(
          {
            actorUserId: userId,
            actorRole,
            actorName: ctx.user.name ?? undefined,
            action: "ASSIGNMENT_REMOVED",
            entityType: "SHIFT_INSTANCE",
            entityId: shiftInstanceId,
            description: "Turno marcado como vago",
            institutionId: lockedShift.institutionId,
            shiftInstanceId,
            hospitalId: lockedShift.hospitalId,
            sectorId: lockedShift.sectorId,
            metadata: { removedAssignments: activeAssignments.length },
          },
          { db: tx, strict: true },
        );
        await enqueueDutySyncWithdrawsForRemovedProfessionals(tx, {
          institutionId: lockedShift.institutionId,
          shiftInstanceId,
        });
      });

      return { ok: true };
    }),

  /**
   * unassignDirect
   * Remove alocação específica (soft delete)
   */
  unassignDirect: protectedProcedure
    .input(
      z.object({
        assignmentId: z.number(),
        reason: z.string(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { assignmentId, reason } = input;
      const userId = ctx.user?.id;
      if (!userId) {
        throw new ForbiddenError("Autenticação necessária");
      }
      const actor = await getTenantActorFromContext(ctx);
      assertCanManageInstitutionSchedule(actor);

      const db = await getDb();
      if (!db) throw new Error("Database not available");
      const managerId = actor.professionalId;
      if (!managerId) throw new ForbiddenError("Profissional não encontrado");

      const assignment = await getAssignmentTarget(
        db,
        assignmentId,
        ctx.institutionId,
      );
      if (!assignment) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Alocação não encontrada",
        });
      }

      await assertManagerScopeAccess(
        actor,
        assignment.hospitalId,
        assignment.sectorId,
      );
      assertCanEditScheduleDate(actor, assignment.startAt);

      await db.transaction(async (tx) => {
        await assertMonthEditableForUpdate(
          tx,
          { user: { id: userId } },
          assignment.institutionId,
          assignment.hospitalId,
          assignment.startAt,
          reason,
        );

        const lockedAssignment = await getAssignmentTarget(
          tx,
          assignmentId,
          ctx.institutionId,
          true,
          assignment.id,
        );
        if (!lockedAssignment) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "A alocação não está mais disponível.",
          });
        }
        assertSameAssignmentTarget(assignment, lockedAssignment);
        if (!lockedAssignment.isActive) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "A alocação já foi removida.",
          });
        }
        const actorRole = await assertManagerScopeAccessForUpdate(
          tx,
          actor,
          ctx.user.sessionVersion,
          lockedAssignment.hospitalId,
          lockedAssignment.sectorId,
          [lockedAssignment.startAt],
        );
        const removedProfessionalId = lockedAssignment.professionalId;
        const removedShift = {
          id: lockedAssignment.id,
          institutionId: lockedAssignment.institutionId,
          hospitalId: lockedAssignment.hospitalId,
          sectorId: lockedAssignment.sectorId,
          startAt: lockedAssignment.startAt,
          endAt: lockedAssignment.endAt,
        };

        const [deactivated] = await tx
          .update(shiftAssignmentsV2)
          .set({ isActive: false })
          .where(
            and(
              eq(shiftAssignmentsV2.id, assignmentId),
              eq(shiftAssignmentsV2.shiftInstanceId, lockedAssignment.id),
              eq(
                shiftAssignmentsV2.institutionId,
                lockedAssignment.institutionId,
              ),
              eq(shiftAssignmentsV2.hospitalId, lockedAssignment.hospitalId),
              eq(shiftAssignmentsV2.sectorId, lockedAssignment.sectorId),
              eq(
                shiftAssignmentsV2.professionalId,
                lockedAssignment.professionalId,
              ),
              eq(shiftAssignmentsV2.status, lockedAssignment.assignmentStatus),
              eq(shiftAssignmentsV2.isActive, true),
            ),
          );
        if (deactivated.affectedRows !== 1) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "A alocação mudou antes de ser removida.",
          });
        }

        // 6–7. Status do turno DERIVADO das alocações ativas restantes
        // (regra única de shift-status.ts). A contagem antiga só olhava
        // OCUPADO e marcava VAGO com uma PENDENTE ainda ativa — o turno
        // voltava para "Plantões em aberto" com candidato na fila
        // (auditoria 22/08, achado M4).
        await recomputeShiftStatus(tx, lockedAssignment.id);

        // 8. Auditorias da remoção no mesmo commit da alteração operacional.
        await auditLog(
          {
            event: "SHIFT_UNASSIGNED",
            shiftInstanceId: lockedAssignment.id,
            institutionId: lockedAssignment.institutionId,
            professionalId: managerId,
            reason,
            metadata: {
              assignmentId,
              unassignedProfessionalId: lockedAssignment.professionalId,
            },
          },
          { db: tx },
        );

        await recordAudit(
          {
            actorUserId: userId,
            actorRole,
            actorName: ctx.user.name ?? undefined,
            action: "ASSIGNMENT_REMOVED",
            entityType: "SHIFT_ASSIGNMENT",
            entityId: assignmentId,
            description: `Remoção direta do profissional #${lockedAssignment.professionalId} no turno #${lockedAssignment.id}`,
            institutionId: lockedAssignment.institutionId,
            shiftInstanceId: lockedAssignment.id,
            hospitalId: lockedAssignment.hospitalId,
            sectorId: lockedAssignment.sectorId,
            fromProfessionalId: lockedAssignment.professionalId,
          },
          { db: tx, strict: true },
        );

        await enqueueShiftUnassignedPush({
          db: tx,
          assignmentId,
          professionalId: removedProfessionalId,
          shift: removedShift,
        });
        await enqueueDutySyncWithdrawsForRemovedProfessionals(tx, {
          institutionId: lockedAssignment.institutionId,
          shiftInstanceId: lockedAssignment.id,
          professionalIds: [removedProfessionalId],
        });
      });

      return { ok: true };
    }),
});

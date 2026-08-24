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
} from "./shift-validations-v2";

type EditorDb = Pick<NonNullable<Awaited<ReturnType<typeof getDb>>>, "select">;

type ShiftTarget = {
  id: number;
  institutionId: number;
  hospitalId: number;
  sectorId: number;
  specialty: string | null;
  startAt: Date;
  endAt: Date;
  status: string;
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
      specialty: shiftInstances.specialty,
      startAt: shiftInstances.startAt,
      endAt: shiftInstances.endAt,
      status: shiftInstances.status,
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
    if (!lockForUpdate && error instanceof TRPCError && error.code === "FORBIDDEN") {
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
      throw new Error("expectedShiftInstanceId is required for an assignment lock");
    }
    const [shift] = await db
      .select({
        id: shiftInstances.id,
        institutionId: shiftInstances.institutionId,
        hospitalId: shiftInstances.hospitalId,
        sectorId: shiftInstances.sectorId,
        specialty: shiftInstances.specialty,
        startAt: shiftInstances.startAt,
        endAt: shiftInstances.endAt,
        status: shiftInstances.status,
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
      specialty: shiftInstances.specialty,
      startAt: shiftInstances.startAt,
      endAt: shiftInstances.endAt,
      status: shiftInstances.status,
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

function assertSameShiftTarget(authorized: ShiftTarget, locked: ShiftTarget): void {
  if (
    authorized.id !== locked.id ||
    authorized.institutionId !== locked.institutionId ||
    authorized.hospitalId !== locked.hospitalId ||
    authorized.sectorId !== locked.sectorId ||
    authorized.specialty !== locked.specialty ||
    authorized.status !== locked.status ||
    !sameInstant(authorized.startAt, locked.startAt) ||
    !sameInstant(authorized.endAt, locked.endAt)
  ) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "O turno mudou enquanto a edição era processada.",
    });
  }
}

function assertSameAssignmentTarget(authorized: AssignmentTarget, locked: AssignmentTarget): void {
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
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { shiftInstanceId, professionalId, assignmentType, reason } = input;
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
      const shift = await getShiftTarget(db, shiftInstanceId, ctx.institutionId);
      if (!shift) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Turno não encontrado" });
      }

      await assertManagerScopeAccess(actor, shift.hospitalId, shift.sectorId);
      assertCanEditScheduleDate(actor, shift.startAt);

      // Guarda mensal, revalidação/CAS do alvo, alocação, status e ambas as
      // trilhas de auditoria formam um único commit.
      const assignmentId = await db.transaction(async (tx) => {
        await assertMonthEditableForUpdate(
          tx,
          { user: { id: userId } },
          shift.institutionId,
          shift.hospitalId,
          shift.startAt,
          reason,
        );

        const lockedShift = await getShiftTarget(tx, shiftInstanceId, ctx.institutionId, true);
        if (!lockedShift) {
          throw new TRPCError({ code: "CONFLICT", message: "O turno não está mais disponível." });
        }
        assertSameShiftTarget(shift, lockedShift);
        await assertAssignmentWritesAllowedForUpdate(
          tx,
          [
            {
              professionalId,
              institutionId: lockedShift.institutionId,
              hospitalId: lockedShift.hospitalId,
              sectorId: lockedShift.sectorId,
              startAt: lockedShift.startAt,
              endAt: lockedShift.endAt,
              requiredSpecialty: lockedShift.specialty,
            },
          ],
          { additionalProfessionalIds: [managerId] },
        );
        const actorRole = await assertManagerScopeAccessForUpdate(
          tx,
          actor,
          ctx.user.sessionVersion,
          lockedShift.hospitalId,
          lockedShift.sectorId,
          [lockedShift.startAt],
        );
        await assertShiftAssignmentCapacityForUpdate(tx, {
          shiftInstanceId: lockedShift.id,
          institutionId: lockedShift.institutionId,
          hospitalId: lockedShift.hospitalId,
          sectorId: lockedShift.sectorId,
          activeDelta: 1,
        });

        const [inserted] = await tx.insert(shiftAssignmentsV2).values({
          shiftInstanceId,
          institutionId: lockedShift.institutionId,
          hospitalId: lockedShift.hospitalId,
          sectorId: lockedShift.sectorId,
          professionalId,
          assignmentType,
          status: "OCUPADO",
          isActive: true,
          createdBy: userId,
        });
        await recomputeShiftStatus(tx, shiftInstanceId);
        const createdAssignmentId = Number(inserted.insertId);

        await auditLog(
          {
            event: "SHIFT_ASSIGNED",
            shiftInstanceId,
            institutionId: lockedShift.institutionId,
            professionalId: managerId,
            reason: reason || `Alocação direta: ${assignmentType}`,
            metadata: {
              assignmentId: createdAssignmentId,
              allocatedProfessionalId: professionalId,
              assignmentType,
            },
          },
          { db: tx },
        );
        await recordAudit(
          {
            action: "ASSIGNMENT_CREATED",
            entityType: "SHIFT_ASSIGNMENT",
            entityId: createdAssignmentId,
            actorUserId: userId,
            actorRole,
            actorName: ctx.user.name ?? undefined,
            description: `Alocação direta do profissional #${professionalId} no turno #${shiftInstanceId}`,
            institutionId: lockedShift.institutionId,
            shiftInstanceId,
            hospitalId: lockedShift.hospitalId,
            sectorId: lockedShift.sectorId,
            toProfessionalId: professionalId,
            metadata: { assignmentType },
          },
          { db: tx, strict: true },
        );
        return createdAssignmentId;
      }, ASSIGNMENT_WRITE_TRANSACTION_CONFIG);

      return { ok: true, assignmentId };
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
      })
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

      const shift = await getShiftTarget(db, shiftInstanceId, ctx.institutionId);
      if (!shift) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Turno não encontrado" });
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
        const lockedShift = await getShiftTarget(tx, shiftInstanceId, ctx.institutionId, true);
        if (!lockedShift) {
          throw new TRPCError({ code: "CONFLICT", message: "O turno não está mais disponível." });
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
          throw new TRPCError({ code: "CONFLICT", message: "O turno já está vago." });
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
          const [updatedShift] = await tx
            .update(shiftInstances)
            .set({ status: "VAGO" })
            .where(
              and(
                eq(shiftInstances.id, shiftInstanceId),
                eq(shiftInstances.institutionId, lockedShift.institutionId),
                eq(shiftInstances.hospitalId, lockedShift.hospitalId),
                eq(shiftInstances.sectorId, lockedShift.sectorId),
                eq(shiftInstances.status, lockedShift.status),
              ),
            );
          if (updatedShift.affectedRows !== 1) {
            throw new TRPCError({
              code: "CONFLICT",
              message: "O turno mudou antes de ser marcado como vago.",
            });
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
      })
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

      const assignment = await getAssignmentTarget(db, assignmentId, ctx.institutionId);
      if (!assignment) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Alocação não encontrada" });
      }

      await assertManagerScopeAccess(actor, assignment.hospitalId, assignment.sectorId);
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
          throw new TRPCError({ code: "CONFLICT", message: "A alocação não está mais disponível." });
        }
        assertSameAssignmentTarget(assignment, lockedAssignment);
        if (!lockedAssignment.isActive) {
          throw new TRPCError({ code: "CONFLICT", message: "A alocação já foi removida." });
        }
        const actorRole = await assertManagerScopeAccessForUpdate(
          tx,
          actor,
          ctx.user.sessionVersion,
          lockedAssignment.hospitalId,
          lockedAssignment.sectorId,
          [lockedAssignment.startAt],
        );

        const [deactivated] = await tx
          .update(shiftAssignmentsV2)
          .set({ isActive: false })
          .where(
            and(
              eq(shiftAssignmentsV2.id, assignmentId),
              eq(shiftAssignmentsV2.shiftInstanceId, lockedAssignment.id),
              eq(shiftAssignmentsV2.institutionId, lockedAssignment.institutionId),
              eq(shiftAssignmentsV2.hospitalId, lockedAssignment.hospitalId),
              eq(shiftAssignmentsV2.sectorId, lockedAssignment.sectorId),
              eq(shiftAssignmentsV2.professionalId, lockedAssignment.professionalId),
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
            metadata: { assignmentId, unassignedProfessionalId: lockedAssignment.professionalId },
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
      });

      return { ok: true };
    }),
});

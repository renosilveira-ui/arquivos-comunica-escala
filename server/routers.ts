import { z } from "zod";
import { router, protectedProcedure } from "./_core/trpc";
import { getDb } from "./db";
import { eq } from "drizzle-orm";
import { professionals, shiftInstances, shiftAssignmentsV2 } from "../drizzle/schema";
import { validateAssignment } from "./shift-validations";
import { auditLog } from "./audit-log";
import { canApproveAssignment } from "./rbac-validations";
import { editorRouter } from "./editor";
import { calendarRouter } from "./calendar";

const shiftAssignmentsRouter = router({
  // Assumir vaga (USER solicita alocação PENDENTE)
  assumeVacancy: protectedProcedure
    .input(z.object({
      shiftInstanceId: z.number(),
      assignmentType: z.enum(["ON_DUTY", "BACKUP", "ON_CALL"]).default("ON_DUTY"),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const userId = ctx.user?.id;
      if (!userId) throw new Error("Autenticação necessária");

      const [professional] = await db
        .select()
        .from(professionals)
        .where(eq(professionals.userId, userId));

      if (!professional) throw new Error("Profissional não encontrado");

      const [shift] = await db
        .select()
        .from(shiftInstances)
        .where(eq(shiftInstances.id, input.shiftInstanceId));

      if (!shift) throw new Error("Turno não encontrado");

      if (shift.status !== "VAGO") {
        throw new Error(`Turno não está disponível (status: ${shift.status})`);
      }

      const validation = await validateAssignment(
        professional.id,
        input.shiftInstanceId,
        shift.hospitalId,
        shift.sectorId
      );

      if (!validation.valid) {
        throw new Error(validation.error || "Validation failed");
      }

      const [result] = await db.insert(shiftAssignmentsV2).values({
        shiftInstanceId: input.shiftInstanceId,
        institutionId: shift.institutionId,
        hospitalId: shift.hospitalId,
        sectorId: shift.sectorId,
        professionalId: professional.id,
        assignmentType: input.assignmentType,
        isActive: true,
        createdBy: userId,
      });

      await db
        .update(shiftInstances)
        .set({ status: "PENDENTE" })
        .where(eq(shiftInstances.id, input.shiftInstanceId));

      await auditLog({
        event: "VACANCY_REQUESTED",
        shiftInstanceId: input.shiftInstanceId,
        professionalId: professional.id,
        metadata: { assignmentType: input.assignmentType, userId },
      });

      return { ok: true, assignmentId: result.insertId, status: "PENDENTE" as const };
    }),

  // Listar alocações pendentes
  listPending: protectedProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new Error("Database not available");

    const userId = ctx.user?.id;
    if (!userId) throw new Error("Autenticação necessária");

    const pending = await db
      .select()
      .from(shiftAssignmentsV2)
      .where(eq(shiftAssignmentsV2.isActive, true));

    return pending;
  }),
});

const shiftInstancesRouter = router({
  // Aprovar alocação pendente
  approveAssignment: protectedProcedure
    .input(z.object({
      assignmentId: z.number(),
      professionalId: z.number(),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const userId = ctx.user?.id;
      if (!userId) throw new Error("Autenticação necessária");

      const [assignment] = await db
        .select()
        .from(shiftAssignmentsV2)
        .where(eq(shiftAssignmentsV2.id, input.assignmentId));

      if (!assignment) throw new Error("Alocação não encontrada");

      const permission = await canApproveAssignment(
        input.professionalId,
        assignment.hospitalId,
        assignment.sectorId
      );

      if (!permission.allowed) {
        throw new Error(permission.reason || "Sem permissão");
      }

      await db
        .update(shiftInstances)
        .set({ status: "OCUPADO" })
        .where(eq(shiftInstances.id, assignment.shiftInstanceId));

      await auditLog({
        event: "ASSIGNMENT_APPROVED",
        shiftInstanceId: assignment.shiftInstanceId,
        professionalId: input.professionalId,
        metadata: { assignmentId: input.assignmentId, approvedBy: userId },
      });

      return { ok: true };
    }),

  // Rejeitar alocação pendente
  rejectAssignment: protectedProcedure
    .input(z.object({
      assignmentId: z.number(),
      professionalId: z.number(),
      reason: z.string().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const userId = ctx.user?.id;
      if (!userId) throw new Error("Autenticação necessária");

      const [assignment] = await db
        .select()
        .from(shiftAssignmentsV2)
        .where(eq(shiftAssignmentsV2.id, input.assignmentId));

      if (!assignment) throw new Error("Alocação não encontrada");

      const permission = await canApproveAssignment(
        input.professionalId,
        assignment.hospitalId,
        assignment.sectorId
      );

      if (!permission.allowed) {
        throw new Error(permission.reason || "Sem permissão");
      }

      await db
        .update(shiftAssignmentsV2)
        .set({ isActive: false })
        .where(eq(shiftAssignmentsV2.id, input.assignmentId));

      await db
        .update(shiftInstances)
        .set({ status: "VAGO" })
        .where(eq(shiftInstances.id, assignment.shiftInstanceId));

      await auditLog({
        event: "ASSIGNMENT_REJECTED",
        shiftInstanceId: assignment.shiftInstanceId,
        professionalId: input.professionalId,
        reason: input.reason ?? null,
        metadata: { assignmentId: input.assignmentId, rejectedBy: userId },
      });

      return { ok: true };
    }),
});

export const appRouter = router({
  shiftAssignments: shiftAssignmentsRouter,
  shiftInstances: shiftInstancesRouter,
  editor: editorRouter,
  calendar: calendarRouter,
});

export type AppRouter = typeof appRouter;
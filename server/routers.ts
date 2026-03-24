import { z } from "zod";
import { router, protectedProcedure } from "./_core/trpc";
import { getDb } from "./db";
import { eq, and, gte, lte, sql } from "drizzle-orm";
import { professionals, shiftInstances, shiftAssignmentsV2, sectors, hospitals } from "../drizzle/schema";
import { validateAssignment } from "./shift-validations";
import { auditLog } from "./audit-log";
import { canApproveAssignment } from "./rbac-validations";
import { assertNoTimeConflict } from "./shift-validations-v2";
import { recordAudit } from "./audit-trail";
import { editorRouter } from "./editor";
import { swapRouter } from "./swap-router";
import { calendarRouter } from "./calendar";
import { shiftsRouter } from "./shifts-crud";
import { professionalsRouter, hospitalsRouter, sectorsRouter, filtersRouter } from "./aux-routers";

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
      if (shift.institutionId !== ctx.institutionId) {
        throw new Error("Turno fora do tenant ativo");
      }

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

  // Listar alocações pendentes com dados enriquecidos
  listPending: protectedProcedure
    .input(
      z.object({
        hospitalId: z.number().optional(),
        sectorId: z.number().optional(),
        date: z.string().optional(),
        shiftLabel: z.string().nullish(),
      }).optional(),
    )
    .query(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      let startOfDay: Date | undefined;
      let endOfDay: Date | undefined;
      if (input?.date) {
        startOfDay = new Date(`${input.date}T00:00:00`);
        endOfDay = new Date(`${input.date}T23:59:59`);
      }

      const rows = await db.execute<any>(
        sql`SELECT
              sa.id            AS assignmentId,
              sa.professional_id AS professionalId,
              sa.assignment_type AS assignmentType,
              sa.status,
              p.name           AS professionalName,
              p.role           AS professionalRole,
              s.id             AS sectorId,
              s.name           AS sectorName,
              si.id            AS shiftInstanceId,
              si.label         AS shiftLabel,
              si.start_at      AS shiftStartAt,
              si.end_at        AS shiftEndAt,
              si.hospital_id   AS hospitalId
            FROM shift_assignments_v2 sa
            JOIN professionals p   ON sa.professional_id = p.id
            JOIN shift_instances si ON sa.shift_instance_id = si.id
            JOIN sectors s         ON si.sector_id = s.id
            WHERE sa.is_active = true
              AND sa.institution_id = ${ctx.institutionId}
              AND sa.status = 'PENDENTE'
              ${input?.hospitalId ? sql`AND si.hospital_id = ${input.hospitalId}` : sql``}
              ${input?.sectorId   ? sql`AND si.sector_id   = ${input.sectorId}`   : sql``}
              ${input?.shiftLabel ? sql`AND si.label       = ${input.shiftLabel}` : sql``}
              ${startOfDay && endOfDay ? sql`AND si.start_at BETWEEN ${startOfDay} AND ${endOfDay}` : sql``}
            ORDER BY si.start_at ASC`
      );

      const data = (rows as any)[0];
      return (data as any[]).map((r) => ({
        assignmentId:     r.assignmentId     as number,
        professionalId:   r.professionalId   as number,
        professionalName: r.professionalName as string,
        professionalRole: r.professionalRole as string,
        sectorId:         r.sectorId         as number,
        sectorName:       r.sectorName       as string,
        shiftInstanceId:  r.shiftInstanceId  as number,
        shiftLabel:       r.shiftLabel       as string,
        shiftStartAt:     new Date(r.shiftStartAt),
        shiftEndAt:       new Date(r.shiftEndAt),
        assignmentType:   r.assignmentType   as string,
        status:           r.status           as string,
        hospitalId:       r.hospitalId       as number,
      }));
    }),
});

const shiftInstancesRouter = router({
  // Aprovar alocação pendente
  approveAssignment: protectedProcedure
    .input(z.object({
      assignmentId: z.number(),
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
      if (assignment.institutionId !== ctx.institutionId) {
        throw new Error("Alocação fora do tenant ativo");
      }

      const [managerProfessional] = await db
        .select({ id: professionals.id })
        .from(professionals)
        .where(eq(professionals.userId, userId));

      if (!managerProfessional) {
        throw new Error("Profissional do aprovador não encontrado");
      }

      const permission = await canApproveAssignment(
        managerProfessional.id,
        assignment.hospitalId,
        assignment.sectorId
      );

      if (!permission.allowed) {
        throw new Error(permission.reason || "Sem permissão");
      }

      await db
        .update(shiftAssignmentsV2)
        .set({ status: "OCUPADO", isActive: true })
        .where(eq(shiftAssignmentsV2.id, input.assignmentId));

      await db
        .update(shiftInstances)
        .set({ status: "OCUPADO" })
        .where(eq(shiftInstances.id, assignment.shiftInstanceId));

      await auditLog({
        event: "ASSIGNMENT_APPROVED",
        shiftInstanceId: assignment.shiftInstanceId,
        professionalId: managerProfessional.id,
        metadata: { assignmentId: input.assignmentId, approvedBy: userId },
      });

      await recordAudit({
        actorUserId: userId,
        actorRole: ctx.user.role ?? "unknown",
        actorName: ctx.user.name ?? undefined,
        action: "ASSIGNMENT_APPROVED",
        entityType: "SHIFT_ASSIGNMENT",
        entityId: input.assignmentId,
        description: "Alocacao aprovada",
        shiftInstanceId: assignment.shiftInstanceId,
        hospitalId: assignment.hospitalId,
        sectorId: assignment.sectorId,
      });

      return { ok: true };
    }),

  // Rejeitar alocação pendente
  rejectAssignment: protectedProcedure
    .input(z.object({
      assignmentId: z.number(),
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
      if (assignment.institutionId !== ctx.institutionId) {
        throw new Error("Alocação fora do tenant ativo");
      }

      const [managerProfessional] = await db
        .select({ id: professionals.id })
        .from(professionals)
        .where(eq(professionals.userId, userId));

      if (!managerProfessional) {
        throw new Error("Profissional do aprovador não encontrado");
      }

      const permission = await canApproveAssignment(
        managerProfessional.id,
        assignment.hospitalId,
        assignment.sectorId
      );

      if (!permission.allowed) {
        throw new Error(permission.reason || "Sem permissão");
      }

      await db
        .update(shiftAssignmentsV2)
        .set({ isActive: false, status: "REJEITADO" })
        .where(eq(shiftAssignmentsV2.id, input.assignmentId));

      await db
        .update(shiftInstances)
        .set({ status: "VAGO" })
        .where(eq(shiftInstances.id, assignment.shiftInstanceId));

      await auditLog({
        event: "ASSIGNMENT_REJECTED",
        shiftInstanceId: assignment.shiftInstanceId,
        professionalId: managerProfessional.id,
        reason: input.reason ?? null,
        metadata: { assignmentId: input.assignmentId, rejectedBy: userId },
      });

      await recordAudit({
        actorUserId: userId,
        actorRole: ctx.user.role ?? "unknown",
        actorName: ctx.user.name ?? undefined,
        action: "ASSIGNMENT_REJECTED",
        entityType: "SHIFT_ASSIGNMENT",
        entityId: input.assignmentId,
        description: "Alocacao rejeitada" + (input.reason ? ": " + input.reason : ""),
        shiftInstanceId: assignment.shiftInstanceId,
        hospitalId: assignment.hospitalId,
        sectorId: assignment.sectorId,
      });

      return { ok: true };
    }),

  // List vacancies with enriched data (sector name, hospital name)
  listVacancies: protectedProcedure
    .input(
      z.object({
        hospitalId: z.number().optional(),
        sectorId:   z.number().optional(),
        date:       z.string().optional(),
        shiftLabel: z.string().nullish(),
      }).optional(),
    )
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      let startOfDay: Date | undefined;
      let endOfDay: Date | undefined;
      if (input?.date) {
        startOfDay = new Date(`${input.date}T00:00:00`);
        endOfDay   = new Date(`${input.date}T23:59:59`);
      }

      const rows = await db.execute<any>(
        sql`SELECT
              si.id          AS shiftInstanceId,
              si.start_at    AS startAt,
              si.end_at      AS endAt,
              si.label,
              si.status,
              s.name         AS sectorName,
              h.name         AS hospitalName,
              si.hospital_id AS hospitalId,
              si.sector_id   AS sectorId
            FROM shift_instances si
            JOIN sectors  s ON si.sector_id  = s.id
            JOIN hospitals h ON si.hospital_id = h.id
            WHERE si.status IN ('VAGO', 'PENDENTE')
              AND si.institution_id = ${ctx.institutionId}
              ${input?.hospitalId ? sql`AND si.hospital_id = ${input.hospitalId}` : sql``}
              ${input?.sectorId   ? sql`AND si.sector_id   = ${input.sectorId}`   : sql``}
              ${input?.shiftLabel ? sql`AND si.label       = ${input.shiftLabel}` : sql``}
              ${startOfDay && endOfDay ? sql`AND si.start_at BETWEEN ${startOfDay} AND ${endOfDay}` : sql``}
            ORDER BY si.start_at ASC`
      );

      const data = (rows as any)[0];

      const [pro] = await db
        .select({ id: professionals.id })
        .from(professionals)
        .where(eq(professionals.userId, ctx.user.id));

      const alreadyRequestedIds = new Set<number>();
      if (pro) {
        const existing = await db
          .select({ shiftInstanceId: shiftAssignmentsV2.shiftInstanceId })
          .from(shiftAssignmentsV2)
          .where(
            and(
              eq(shiftAssignmentsV2.institutionId, ctx.institutionId),
              eq(shiftAssignmentsV2.professionalId, pro.id),
              eq(shiftAssignmentsV2.isActive, true),
            ),
          );
        for (const e of existing) alreadyRequestedIds.add(e.shiftInstanceId);
      }

      return (data as any[]).map((r) => ({
        shiftInstanceId: r.shiftInstanceId as number,
        startAt:         new Date(r.startAt),
        endAt:           new Date(r.endAt),
        label:           r.label           as string,
        status:          r.status          as string,
        sectorName:      r.sectorName      as string,
        hospitalName:    r.hospitalName    as string,
        canAssume:       r.status === "VAGO" && !alreadyRequestedIds.has(r.shiftInstanceId as number),
      }));
    }),
});

export const appRouter = router({
  shiftAssignments: shiftAssignmentsRouter,
  shiftInstances:   shiftInstancesRouter,
  editor:           editorRouter,
  calendar:         calendarRouter,
  shifts:           shiftsRouter,
  professionals:    professionalsRouter,
  hospitals:        hospitalsRouter,
  sectors:          sectorsRouter,
  filters:          filtersRouter,
  swaps:            swapRouter,
});

export type AppRouter = typeof appRouter;
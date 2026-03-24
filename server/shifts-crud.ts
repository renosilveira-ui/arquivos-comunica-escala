import { z } from "zod";
import { router, protectedProcedure } from "./_core/trpc";
import { getDb } from "./db";
import { eq, and, gte, lte, lt, inArray } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import {
  shiftInstances,
  shiftTemplates,
  shiftAssignmentsV2,
  professionals,
} from "../drizzle/schema";
import { auditLog } from "./audit-log";
import { recordAudit } from "./audit-trail";
import { notifyVacancyOpened } from "./integrations/comunica-plus";
import { publishMonth, lockMonth } from "./month-guards";

/**
 * Combine a "YYYY-MM-DD" date string with a "HH:MM:SS" time string into a Date.
 * For overnight shifts (endTime < startTime), the end date is advanced by 1 day.
 */
function buildShiftTimestamps(
  date: string,
  startTime: string,
  endTime: string,
): [Date, Date] {
  const startAt = new Date(`${date}T${startTime}`);
  const endAt = new Date(`${date}T${endTime}`);
  if (endAt <= startAt) {
    endAt.setDate(endAt.getDate() + 1);
  }
  return [startAt, endAt];
}

function requireManagerOrAdmin(role: string) {
  if (role !== "admin" && role !== "manager") {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Apenas admin ou manager podem realizar esta operação",
    });
  }
}

export const shiftsRouter = router({
  // ------------------------------------------------------------------
  // shifts.create — admin/manager only
  // Creates a shiftInstance from a template + date.
  // ------------------------------------------------------------------
  create: protectedProcedure
    .input(
      z.object({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date deve ser YYYY-MM-DD"),
        shiftTemplateId: z.number().int(),
        sectorId: z.number().int().optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      requireManagerOrAdmin(ctx.user.role);

      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const [template] = await db
        .select()
        .from(shiftTemplates)
        .where(eq(shiftTemplates.id, input.shiftTemplateId));

      if (!template) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Template de turno não encontrado" });
      }
      if (template.institutionId !== ctx.institutionId) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Template fora do tenant ativo" });
      }

      const sectorId = input.sectorId ?? template.sectorId;
      if (!sectorId) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "sectorId obrigatório (template não possui setor padrão)" });
      }

      const [startAt, endAt] = buildShiftTimestamps(
        input.date,
        template.startTime,
        template.endTime,
      );

      const [result] = await db.insert(shiftInstances).values({
        institutionId: template.institutionId,
        hospitalId: template.hospitalId,
        sectorId,
        label: template.name,
        startAt,
        endAt,
        status: "VAGO",
        createdBy: ctx.user.id,
      });

      const insertId = (result as any).insertId as number;

      await auditLog({
        event: "SHIFT_CREATED",
        shiftInstanceId: insertId,
        professionalId: null,
        metadata: { createdBy: ctx.user.id, templateId: input.shiftTemplateId, date: input.date },
      });

      await recordAudit({
        actorUserId: ctx.user.id,
        actorRole: ctx.user.role,
        actorName: ctx.user.name ?? undefined,
        action: "SHIFT_CREATED",
        entityType: "SHIFT_INSTANCE",
        entityId: insertId,
        description: "Turno criado (" + template.name + " em " + input.date + ")",
        hospitalId: template.hospitalId,
        sectorId: sectorId,
        shiftInstanceId: insertId,
      });

      const [created] = await db
        .select()
        .from(shiftInstances)
        .where(eq(shiftInstances.id, insertId));

      return created;
    }),

  // ------------------------------------------------------------------
  // shifts.get — any authenticated user
  // Returns the shiftInstance with template details and assignments.
  // ------------------------------------------------------------------
  get: protectedProcedure
    .input(z.object({ id: z.number().int() }))
    .query(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const [instance] = await db
        .select()
        .from(shiftInstances)
        .where(
          and(
            eq(shiftInstances.id, input.id),
            eq(shiftInstances.institutionId, ctx.institutionId),
          ),
        );

      if (!instance) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Turno não encontrado" });
      }

      // Load the template that matches this instance's hospital + sector + label
      const [template] = await db
        .select()
        .from(shiftTemplates)
        .where(
          and(
            eq(shiftTemplates.institutionId, ctx.institutionId),
            eq(shiftTemplates.hospitalId, instance.hospitalId),
            eq(shiftTemplates.name, instance.label),
          ),
        )
        .limit(1);

      const assignments = await db
        .select()
        .from(shiftAssignmentsV2)
        .where(
          and(
            eq(shiftAssignmentsV2.institutionId, ctx.institutionId),
            eq(shiftAssignmentsV2.shiftInstanceId, input.id),
            eq(shiftAssignmentsV2.isActive, true),
          ),
        );

      return { ...instance, template: template ?? null, assignments };
    }),

  // ------------------------------------------------------------------
  // shifts.update — admin/manager only
  // Updates status and/or timestamps; records audit entry.
  // ------------------------------------------------------------------
  update: protectedProcedure
    .input(
      z.object({
        id: z.number().int(),
        status: z.enum(["VAGO", "PENDENTE", "OCUPADO"]).optional(),
        startAt: z.string().optional(),
        endAt: z.string().optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      requireManagerOrAdmin(ctx.user.role);

      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const [existing] = await db
        .select()
        .from(shiftInstances)
        .where(
          and(
            eq(shiftInstances.id, input.id),
            eq(shiftInstances.institutionId, ctx.institutionId),
          ),
        );

      if (!existing) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Turno não encontrado" });
      }

      const patch: Partial<typeof shiftInstances.$inferInsert> = {};
      if (input.status !== undefined) patch.status = input.status;
      if (input.startAt !== undefined) patch.startAt = new Date(input.startAt);
      if (input.endAt !== undefined) patch.endAt = new Date(input.endAt);

      if (Object.keys(patch).length === 0) {
        return existing;
      }

      await db
        .update(shiftInstances)
        .set(patch)
        .where(eq(shiftInstances.id, input.id));

      await auditLog({
        event: "SHIFT_UPDATED",
        shiftInstanceId: input.id,
        professionalId: null,
        metadata: { updatedBy: ctx.user.id, changes: patch },
      });

      await recordAudit({
        actorUserId: ctx.user.id,
        actorRole: ctx.user.role,
        actorName: ctx.user.name ?? undefined,
        action: "SHIFT_UPDATED",
        entityType: "SHIFT_INSTANCE",
        entityId: input.id,
        description: "Turno atualizado",
        shiftInstanceId: input.id,
        hospitalId: existing.hospitalId,
        sectorId: existing.sectorId,
        metadata: { changes: patch },
      });

      // Fire-and-forget: notify Comunica+ if shift became vacant
      if (input.status === "VAGO" && existing.status !== "VAGO") {
        notifyVacancyOpened({
          shiftInstanceId: input.id,
          startAt: existing.startAt.toISOString(),
          endAt: existing.endAt.toISOString(),
          templateName: existing.label,
          sectorName: null, // TODO: resolve sector name from sectorId
        }).catch((err) =>
          console.error("[Comunica+] notifyVacancyOpened error:", err),
        );
      }

      const [updated] = await db
        .select()
        .from(shiftInstances)
        .where(
          and(
            eq(shiftInstances.id, input.id),
            eq(shiftInstances.institutionId, ctx.institutionId),
          ),
        );

      return updated;
    }),

  // ------------------------------------------------------------------
  // shifts.listByPeriod — any authenticated user
  // Returns all shiftInstances whose startAt falls within [startDate, endDate].
  // ------------------------------------------------------------------
  listByPeriod: protectedProcedure
    .input(
      z.object({
        startDate: z.string(),
        endDate: z.string(),
      }),
    )
    .query(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const start = new Date(input.startDate);
      const end = new Date(input.endDate);

      const instances = await db
        .select()
        .from(shiftInstances)
        .where(
          and(
            eq(shiftInstances.institutionId, ctx.institutionId),
            gte(shiftInstances.startAt, start),
            lte(shiftInstances.startAt, end),
          ),
        );

      if (instances.length === 0) return [];

      // Attach active assignments (with professional name) to each instance
      const instanceIds = instances.map((i) => i.id);
      const allAssignments = await db
        .select({
          id: shiftAssignmentsV2.id,
          shiftInstanceId: shiftAssignmentsV2.shiftInstanceId,
          professionalId: shiftAssignmentsV2.professionalId,
          assignmentType: shiftAssignmentsV2.assignmentType,
          status: shiftAssignmentsV2.status,
          isActive: shiftAssignmentsV2.isActive,
          professionalName: professionals.name,
        })
        .from(shiftAssignmentsV2)
        .leftJoin(professionals, eq(shiftAssignmentsV2.professionalId, professionals.id))
        .where(
          and(
            eq(shiftAssignmentsV2.isActive, true),
            eq(shiftAssignmentsV2.institutionId, ctx.institutionId),
            inArray(shiftAssignmentsV2.shiftInstanceId, instanceIds),
          ),
        );

      const assignmentsByShift = new Map<number, typeof allAssignments>();
      for (const a of allAssignments) {
        const list = assignmentsByShift.get(a.shiftInstanceId) ?? [];
        list.push(a);
        assignmentsByShift.set(a.shiftInstanceId, list);
      }

      return instances.map((instance) => ({
        ...instance,
        assignments: assignmentsByShift.get(instance.id) ?? [],
      }));
    }),

  // ------------------------------------------------------------------
  // shifts.listTemplates — any authenticated user
  // Returns all active shift templates (used by create-shift form).
  // ------------------------------------------------------------------
  listTemplates: protectedProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new Error("Database not available");
    return db
      .select()
      .from(shiftTemplates)
      .where(
        and(
          eq(shiftTemplates.institutionId, ctx.institutionId),
          eq(shiftTemplates.isActive, true),
        ),
      );
  }),

  // ------------------------------------------------------------------
  // shifts.getActiveShift — any authenticated user
  // Returns the shift that is currently in progress for the logged-in user.
  // Resolves: user.id → professionals.id → shiftAssignmentsV2 → shiftInstances
  // ------------------------------------------------------------------
  getActiveShift: protectedProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new Error("Database not available");

    const [professional] = await db
      .select()
      .from(professionals)
      .where(eq(professionals.userId, ctx.user.id));

    if (!professional) return null;

    const now = new Date();

    const rows = await db
      .select({ instance: shiftInstances })
      .from(shiftAssignmentsV2)
      .innerJoin(
        shiftInstances,
        eq(shiftAssignmentsV2.shiftInstanceId, shiftInstances.id),
      )
      .where(
        and(
          eq(shiftAssignmentsV2.professionalId, professional.id),
          eq(shiftAssignmentsV2.isActive, true),
          eq(shiftInstances.institutionId, ctx.institutionId),
          lte(shiftInstances.startAt, now),
          gte(shiftInstances.endAt, now),
        ),
      )
      .limit(1);

    return rows.length > 0 ? rows[0].instance : null;
  }),

  // ------------------------------------------------------------------
  // shifts.publish — DRAFT → PUBLISHED
  // ------------------------------------------------------------------
  publish: protectedProcedure
    .input(
      z.object({
        institutionId: z.number().int(),
        hospitalId: z.number().int(),
        yearMonth: z.string().regex(/^\d{4}-\d{2}$/),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      requireManagerOrAdmin(ctx.user.role);
      if (input.institutionId !== ctx.institutionId) {
        throw new TRPCError({ code: "FORBIDDEN", message: "institutionId inválido para tenant ativo" });
      }
      await publishMonth(
        input.institutionId,
        input.hospitalId,
        input.yearMonth,
        ctx.user.id,
      );

      await recordAudit({
        actorUserId: ctx.user.id,
        actorRole: ctx.user.role,
        actorName: ctx.user.name ?? undefined,
        action: "ROSTER_PUBLISHED",
        entityType: "MONTHLY_ROSTER",
        entityId: 0,
        description: "Escala publicada (" + input.yearMonth + ")",
        institutionId: input.institutionId,
        hospitalId: input.hospitalId,
      });

      return { ok: true };
    }),

  // ------------------------------------------------------------------
  // shifts.lock — PUBLISHED → LOCKED
  // ------------------------------------------------------------------
  lock: protectedProcedure
    .input(
      z.object({
        institutionId: z.number().int(),
        hospitalId: z.number().int(),
        yearMonth: z.string().regex(/^\d{4}-\d{2}$/),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      requireManagerOrAdmin(ctx.user.role);
      if (input.institutionId !== ctx.institutionId) {
        throw new TRPCError({ code: "FORBIDDEN", message: "institutionId inválido para tenant ativo" });
      }
      await lockMonth(
        input.institutionId,
        input.hospitalId,
        input.yearMonth,
        ctx.user.id,
      );

      await recordAudit({
        actorUserId: ctx.user.id,
        actorRole: ctx.user.role,
        actorName: ctx.user.name ?? undefined,
        action: "ROSTER_LOCKED",
        entityType: "MONTHLY_ROSTER",
        entityId: 0,
        description: "Escala trancada (" + input.yearMonth + ")",
        institutionId: input.institutionId,
        hospitalId: input.hospitalId,
      });

      return { ok: true };
    }),

  // ------------------------------------------------------------------
  // shifts.replicateWeek — admin/manager only
  // Copies shiftInstances (without assignments) from one week to another.
  // ------------------------------------------------------------------
  replicateWeek: protectedProcedure
    .input(
      z.object({
        fromStartDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD"),
        toStartDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD"),
        hospitalId: z.number().int(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      requireManagerOrAdmin(ctx.user.role);

      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const fromStart = new Date(`${input.fromStartDate}T00:00:00`);
      const fromEnd = new Date(fromStart);
      fromEnd.setDate(fromEnd.getDate() + 7);

      const sourceShifts = await db
        .select()
        .from(shiftInstances)
        .where(
          and(
            eq(shiftInstances.institutionId, ctx.institutionId),
            eq(shiftInstances.hospitalId, input.hospitalId),
            gte(shiftInstances.startAt, fromStart),
            lt(shiftInstances.startAt, fromEnd),
          ),
        );

      if (sourceShifts.length === 0) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Nenhum turno encontrado na semana de origem" });
      }

      const dayOffsetMs =
        new Date(`${input.toStartDate}T00:00:00`).getTime() -
        new Date(`${input.fromStartDate}T00:00:00`).getTime();

      let created = 0;
      for (const shift of sourceShifts) {
        const newStart = new Date(shift.startAt.getTime() + dayOffsetMs);
        const newEnd = new Date(shift.endAt.getTime() + dayOffsetMs);

        await db.insert(shiftInstances).values({
          institutionId: shift.institutionId,
          hospitalId: shift.hospitalId,
          sectorId: shift.sectorId,
          label: shift.label,
          startAt: newStart,
          endAt: newEnd,
          status: "VAGO",
          createdBy: ctx.user.id,
        });
        created++;
      }

      await recordAudit({
        actorUserId: ctx.user.id,
        actorRole: ctx.user.role,
        actorName: ctx.user.name ?? undefined,
        action: "SHIFT_CREATED",
        entityType: "SHIFT_INSTANCE",
        entityId: 0,
        description: `Replicou ${created} turnos de ${input.fromStartDate} para ${input.toStartDate}`,
        hospitalId: input.hospitalId,
      });

      return { created };
    }),
});

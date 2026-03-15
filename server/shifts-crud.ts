import { z } from "zod";
import { router, protectedProcedure } from "./_core/trpc";
import { getDb } from "./db";
import { eq, and, gte, lte } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import {
  shiftInstances,
  shiftTemplates,
  shiftAssignmentsV2,
  professionals,
} from "../drizzle/schema";
import { auditLog } from "./audit-log";
import { notifyVacancyOpened } from "./integrations/comunica-plus";

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
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const [instance] = await db
        .select()
        .from(shiftInstances)
        .where(eq(shiftInstances.id, input.id));

      if (!instance) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Turno não encontrado" });
      }

      // Load the template that matches this instance's hospital + sector + label
      const [template] = await db
        .select()
        .from(shiftTemplates)
        .where(
          and(
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
        .where(eq(shiftInstances.id, input.id));

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
        .where(eq(shiftInstances.id, input.id));

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
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const start = new Date(input.startDate);
      const end = new Date(input.endDate);

      const instances = await db
        .select()
        .from(shiftInstances)
        .where(and(gte(shiftInstances.startAt, start), lte(shiftInstances.startAt, end)));

      if (instances.length === 0) return [];

      // Attach active assignments to each instance
      const instanceIds = instances.map((i) => i.id);
      const allAssignments = await db
        .select()
        .from(shiftAssignmentsV2)
        .where(eq(shiftAssignmentsV2.isActive, true));

      const assignmentsByShift = new Map<number, typeof allAssignments>();
      for (const a of allAssignments) {
        if (!instanceIds.includes(a.shiftInstanceId)) continue;
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
  listTemplates: protectedProcedure.query(async () => {
    const db = await getDb();
    if (!db) throw new Error("Database not available");
    return db
      .select()
      .from(shiftTemplates)
      .where(eq(shiftTemplates.isActive, true));
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
          lte(shiftInstances.startAt, now),
          gte(shiftInstances.endAt, now),
        ),
      )
      .limit(1);

    return rows.length > 0 ? rows[0].instance : null;
  }),
});

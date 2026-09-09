import { and, eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
  scheduleCapacityRules,
  scheduleContexts,
  shiftTemplates,
} from "../drizzle/schema";
import { MAX_SHIFT_CAPACITY } from "../lib/shift-capacity";
import { pickShiftTemplatesForSector } from "../lib/shift-template-options";
import { protectedProcedure, router } from "./_core/trpc";
import {
  assertCanManageInstitutionSchedule,
  assertManagerScopeAccess,
  assertManagerScopeAccessForUpdate,
  getTenantActorFromContext,
} from "./_core/policy";
import { getDb } from "./db";
import { recordAudit } from "./audit-trail";

export const requiredCapacityInput = z
  .number()
  .int()
  .min(1)
  .max(MAX_SHIFT_CAPACITY);
const contextInput = z.object({
  scheduleContextId: z.number().int().positive(),
  expectedInstitutionId: z.number().int().positive().optional(),
});

export const scheduleCapacityRouter = router({
  capacityRules: protectedProcedure
    .input(contextInput)
    .query(async ({ ctx, input }) => {
      if (
        input.expectedInstitutionId !== undefined &&
        input.expectedInstitutionId !== ctx.institutionId
      )
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "A instituição ativa mudou. Reabra a configuração.",
        });
      const actor = await getTenantActorFromContext(ctx);
      assertCanManageInstitutionSchedule(actor);
      const db = await getDb();
      if (!db) throw new Error("Database not available");
      const [context] = await db
        .select()
        .from(scheduleContexts)
        .where(
          and(
            eq(scheduleContexts.id, input.scheduleContextId),
            eq(scheduleContexts.institutionId, ctx.institutionId),
            eq(scheduleContexts.active, true),
          ),
        )
        .limit(1);
      if (!context)
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Escala não encontrada.",
        });
      await assertManagerScopeAccess(
        actor,
        context.hospitalId,
        context.sectorId,
      );
      const templates = await db
        .select()
        .from(shiftTemplates)
        .where(
          and(
            eq(shiftTemplates.institutionId, ctx.institutionId),
            eq(shiftTemplates.hospitalId, context.hospitalId),
            eq(shiftTemplates.isActive, true),
          ),
        );
      const rules = await db
        .select()
        .from(scheduleCapacityRules)
        .where(eq(scheduleCapacityRules.scheduleContextId, context.id));
      return pickShiftTemplatesForSector(
        templates,
        context.hospitalId,
        context.sectorId,
      ).map((template) => ({
        ...template,
        capacities: Array.from(
          { length: 7 },
          (_, weekday) =>
            rules.find(
              (rule) =>
                rule.startTime === template.startTime &&
                rule.endTime === template.endTime &&
                rule.weekday === weekday,
            )?.requiredCapacity ?? 1,
        ),
      }));
    }),
  saveCapacityRule: protectedProcedure
    .input(
      contextInput.extend({
        shiftTemplateId: z.number().int().positive(),
        capacities: z.array(requiredCapacityInput).length(7),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (
        input.expectedInstitutionId !== undefined &&
        input.expectedInstitutionId !== ctx.institutionId
      )
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "A instituição ativa mudou. Reabra a configuração.",
        });
      const actor = await getTenantActorFromContext(ctx);
      assertCanManageInstitutionSchedule(actor);
      const db = await getDb();
      if (!db) throw new Error("Database not available");
      return db.transaction(
        async (tx) => {
          const [context] = await tx
            .select()
            .from(scheduleContexts)
            .where(
              and(
                eq(scheduleContexts.id, input.scheduleContextId),
                eq(scheduleContexts.institutionId, ctx.institutionId),
                eq(scheduleContexts.active, true),
              ),
            )
            .limit(1);
          if (!context)
            throw new TRPCError({
              code: "NOT_FOUND",
              message: "Escala não encontrada.",
            });
          await assertManagerScopeAccessForUpdate(
            tx,
            actor,
            ctx.user.sessionVersion,
            context.hospitalId,
            context.sectorId,
            [],
          );
          const [locked] = await tx
            .select()
            .from(scheduleContexts)
            .where(
              and(
                eq(scheduleContexts.id, context.id),
                eq(scheduleContexts.institutionId, ctx.institutionId),
                eq(scheduleContexts.active, true),
              ),
            )
            .limit(1)
            .for("update");
          if (
            !locked ||
            locked.hospitalId !== context.hospitalId ||
            locked.sectorId !== context.sectorId
          )
            throw new TRPCError({
              code: "CONFLICT",
              message: "A escala mudou durante a configuração.",
            });
          const templates = await tx
            .select()
            .from(shiftTemplates)
            .where(
              and(
                eq(shiftTemplates.institutionId, ctx.institutionId),
                eq(shiftTemplates.hospitalId, context.hospitalId),
                eq(shiftTemplates.isActive, true),
              ),
            )
            .for("share");
          const template = pickShiftTemplatesForSector(
            templates,
            context.hospitalId,
            context.sectorId,
          ).find((row) => row.id === input.shiftTemplateId);
          if (!template)
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: "Modelo de turno fora desta escala.",
            });
          const previous = await tx
            .select()
            .from(scheduleCapacityRules)
            .where(
              and(
                eq(scheduleCapacityRules.scheduleContextId, context.id),
                eq(scheduleCapacityRules.startTime, template.startTime),
                eq(scheduleCapacityRules.endTime, template.endTime),
              ),
            );
          for (let weekday = 0; weekday < 7; weekday++) {
            await tx
              .insert(scheduleCapacityRules)
              .values({
                scheduleContextId: context.id,
                startTime: template.startTime,
                endTime: template.endTime,
                weekday,
                requiredCapacity: input.capacities[weekday],
              })
              .onDuplicateKeyUpdate({
                set: { requiredCapacity: input.capacities[weekday] },
              });
          }
          await recordAudit(
            {
              actorUserId: ctx.user.id,
              actorRole: actor.roleInInstitution,
              action: "SHIFT_UPDATED",
              entityType: "SECTOR",
              entityId: context.sectorId,
              description: "Capacidade semanal configurada para novos turnos",
              institutionId: ctx.institutionId,
              hospitalId: context.hospitalId,
              sectorId: context.sectorId,
              metadata: {
                capacityRule: true,
                scheduleContextId: context.id,
                templateId: template.id,
                previous,
                capacities: input.capacities,
              },
            },
            { db: tx, strict: true },
          );
          return { ok: true as const };
        },
        { isolationLevel: "read committed" },
      );
    }),
});

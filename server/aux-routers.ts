/**
 * Auxiliary tRPC routers: professionals, hospitals, sectors, filters.
 * Registered in appRouter to supply client screens that query these endpoints.
 */
import { z } from "zod";
import { router, protectedProcedure } from "./_core/trpc";
import { getDb } from "./db";
import { eq, and, gte, lte, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import {
  professionals,
  hospitals,
  sectors,
  institutions,
  professionalInstitutions,
  managerScope as managerScopeTable,
  shiftInstances,
  shiftAssignmentsV2,
} from "../drizzle/schema";
import {
  actorCapabilities,
  assertCanManageInstitutionSchedule,
  assertManagerScopeAccess,
  getTenantActorFromContext,
} from "./_core/policy";

// ─── professionals ────────────────────────────────────────────────────────────

export const professionalsRouter = router({
  getByUserId: protectedProcedure
    .input(z.object({ userId: z.number().int() }))
    .query(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const isSelf = input.userId === ctx.user.id;
      const actor = await getTenantActorFromContext(ctx);
      const capabilities = actorCapabilities(actor);
      const canReadOthers = capabilities.canCreateShift || capabilities.canApproveAssignments;
      if (!isSelf && !canReadOthers) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Sem permissão para consultar outro usuário" });
      }

      const [pro] = await db
        .select()
        .from(professionals)
        .where(eq(professionals.userId, input.userId));
      return pro ?? null;
    }),

  listMyInstitutions: protectedProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new Error("Database not available");

    const rows = await db
      .select({
        institutionId: institutions.id,
        institutionName: institutions.name,
        roleInInstitution: professionalInstitutions.roleInInstitution,
        isPrimary: professionalInstitutions.isPrimary,
        active: professionalInstitutions.active,
      })
      .from(professionalInstitutions)
      .innerJoin(institutions, eq(institutions.id, professionalInstitutions.institutionId))
      .where(
        and(
          eq(professionalInstitutions.userId, ctx.user.id),
          eq(professionalInstitutions.active, true),
        ),
      );

    return rows
      .sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary))
      .map((r) => ({
        id: r.institutionId,
        name: r.institutionName,
        roleInInstitution: r.roleInInstitution,
        isPrimary: r.isPrimary,
      }));
  }),

  getMyCapabilities: protectedProcedure.query(async ({ ctx }) => {
    const actor = await getTenantActorFromContext(ctx);
    return {
      institutionId: actor.institutionId,
      roleInInstitution: actor.roleInInstitution,
      isGlobalAdmin: actor.isGlobalAdmin,
      ...actorCapabilities(actor),
    };
  }),

  listAssignableForShift: protectedProcedure
    .input(z.object({ shiftInstanceId: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const actor = await getTenantActorFromContext(ctx);
      assertCanManageInstitutionSchedule(actor);

      const [shift] = await db
        .select({
          id: shiftInstances.id,
          hospitalId: shiftInstances.hospitalId,
          sectorId: shiftInstances.sectorId,
        })
        .from(shiftInstances)
        .where(
          and(
            eq(shiftInstances.id, input.shiftInstanceId),
            eq(shiftInstances.institutionId, ctx.institutionId),
          ),
        )
        .limit(1);

      if (!shift) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Plantão não encontrado" });
      }

      await assertManagerScopeAccess(actor, shift.hospitalId, shift.sectorId);

      const result = await db.execute<{
        id: number;
        name: string;
        role: string;
        roleInInstitution: "USER" | "GESTOR_MEDICO" | "GESTOR_PLUS";
      }>(
        sql`
          SELECT DISTINCT
            p.id,
            p.name,
            p.role,
            pi.user_role AS roleInInstitution
          FROM professionals p
          INNER JOIN professional_institutions pi
            ON pi.professional_id = p.id
            AND pi.institution_id = ${ctx.institutionId}
            AND pi.active = true
          INNER JOIN professional_access pa
            ON pa.professional_id = p.id
            AND pa.institution_id = ${ctx.institutionId}
            AND pa.hospital_id = ${shift.hospitalId}
            AND (pa.sector_id IS NULL OR pa.sector_id = ${shift.sectorId})
            AND pa.can_access = true
          LEFT JOIN shift_assignments_v2 sa
            ON sa.professional_id = p.id
            AND sa.shift_instance_id = ${input.shiftInstanceId}
            AND sa.is_active = true
          WHERE sa.id IS NULL
          ORDER BY p.name ASC
        `,
      );
      const rows =
        (result as any).rows ||
        (Array.isArray(result) && Array.isArray(result[0]) ? result[0] : result);
      return rows.map((row: any) => ({
        id: Number(row.id),
        name: String(row.name),
        role: String(row.role),
        roleInInstitution: row.roleInInstitution as "USER" | "GESTOR_MEDICO" | "GESTOR_PLUS",
      }));
    }),

  /**
   * Returns the management scope for the logged-in professional.
   * Used by useFilterDefaults hook to auto-select hospital/sector filters.
   */
  getManagerScope: protectedProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new Error("Database not available");

    const actor = await getTenantActorFromContext(ctx);

    if (actor.isGlobalAdmin || actor.roleInInstitution === "GESTOR_PLUS") {
      return { role: "GESTOR_PLUS" as const, canManageAll: true, hospitals: [] as number[], sectors: [] as Array<{ hospitalId: number; sectorId: number }> };
    }

    if (actor.roleInInstitution === "GESTOR_MEDICO" && actor.professionalId) {
      const scopes = await db
        .select()
        .from(managerScopeTable)
        .where(
          and(
            eq(managerScopeTable.institutionId, actor.institutionId),
            eq(managerScopeTable.managerProfessionalId, actor.professionalId),
            eq(managerScopeTable.active, true),
          ),
        );

      const hospitalIds = [...new Set(scopes.map((s) => s.hospitalId))];
      const sectorEntries = scopes
        .filter((s) => s.sectorId !== null)
        .map((s) => ({ hospitalId: s.hospitalId, sectorId: s.sectorId! }));

      return {
        role: "GESTOR_MEDICO" as const,
        canManageAll: false,
        hospitals: hospitalIds,
        sectors: sectorEntries,
      };
    }

    return { role: "USER" as const, canManageAll: false, hospitals: [] as number[], sectors: [] as Array<{ hospitalId: number; sectorId: number }> };
  }),
});

// ─── hospitals ────────────────────────────────────────────────────────────────

export const hospitalsRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new Error("Database not available");
    return db
      .select({ id: hospitals.id, name: hospitals.name, institutionId: hospitals.institutionId })
      .from(hospitals)
      .where(eq(hospitals.institutionId, ctx.institutionId));
  }),
});

// ─── sectors ─────────────────────────────────────────────────────────────────

export const sectorsRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new Error("Database not available");
    return db
      .select({ id: sectors.id, name: sectors.name, hospitalId: sectors.hospitalId, category: sectors.category })
      .from(sectors)
      .where(eq(sectors.institutionId, ctx.institutionId));
  }),
});

// ─── filters ─────────────────────────────────────────────────────────────────

export const filtersRouter = router({
  /**
   * Returns aggregate counts for vacancies and pending assignments
   * for a given date, grouped by hospital and sector — used by ShiftFilters UI.
   */
  summaryCounts: protectedProcedure
    .input(z.object({ date: z.string() }))
    .query(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const startOfDay = new Date(`${input.date}T00:00:00`);
      const endOfDay = new Date(`${input.date}T23:59:59`);

      const instances = await db
        .select()
        .from(shiftInstances)
        .where(
          and(
            eq(shiftInstances.institutionId, ctx.institutionId),
            gte(shiftInstances.startAt, startOfDay),
            lte(shiftInstances.startAt, endOfDay),
          ),
        );

      const vacanciesByHospital: Record<number, number> = {};
      const pendingByHospital: Record<number, number> = {};
      const vacanciesBySector: Record<number, number> = {};
      const pendingBySector: Record<number, number> = {};

      for (const inst of instances) {
        if (inst.status === "VAGO") {
          vacanciesByHospital[inst.hospitalId] = (vacanciesByHospital[inst.hospitalId] ?? 0) + 1;
          vacanciesBySector[inst.sectorId] = (vacanciesBySector[inst.sectorId] ?? 0) + 1;
        } else if (inst.status === "PENDENTE") {
          pendingByHospital[inst.hospitalId] = (pendingByHospital[inst.hospitalId] ?? 0) + 1;
          pendingBySector[inst.sectorId] = (pendingBySector[inst.sectorId] ?? 0) + 1;
        }
      }

      return { vacanciesByHospital, pendingByHospital, vacanciesBySector, pendingBySector };
    }),
});

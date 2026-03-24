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
  managerScope as managerScopeTable,
  shiftInstances,
  shiftAssignmentsV2,
} from "../drizzle/schema";

// ─── professionals ────────────────────────────────────────────────────────────

export const professionalsRouter = router({
  getByUserId: protectedProcedure
    .input(z.object({ userId: z.number().int() }))
    .query(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const isSelf = input.userId === ctx.user.id;
      const canReadOthers = ctx.user.role === "admin" || ctx.user.role === "manager";
      if (!isSelf && !canReadOthers) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Sem permissão para consultar outro usuário" });
      }

      const [pro] = await db
        .select()
        .from(professionals)
        .where(eq(professionals.userId, input.userId));
      return pro ?? null;
    }),

  /**
   * Returns the management scope for the logged-in professional.
   * Used by useFilterDefaults hook to auto-select hospital/sector filters.
   */
  getManagerScope: protectedProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new Error("Database not available");

    const [pro] = await db
      .select()
      .from(professionals)
      .where(eq(professionals.userId, ctx.user.id));

    if (!pro) {
      return { role: "USER" as const, canManageAll: false, hospitals: [] as number[], sectors: [] as Array<{ hospitalId: number; sectorId: number }> };
    }

    if (pro.userRole === "GESTOR_PLUS") {
      return { role: "GESTOR_PLUS" as const, canManageAll: true, hospitals: [] as number[], sectors: [] as Array<{ hospitalId: number; sectorId: number }> };
    }

    if (pro.userRole === "GESTOR_MEDICO") {
      const scopes = await db
        .select()
        .from(managerScopeTable)
        .where(
          and(
            eq(managerScopeTable.institutionId, ctx.institutionId),
            eq(managerScopeTable.managerProfessionalId, pro.id),
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

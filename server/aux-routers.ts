/**
 * Auxiliary tRPC routers: professionals, hospitals, sectors, filters.
 * Registered in appRouter to supply client screens that query these endpoints.
 */
import { z } from "zod";
import { protectedProcedure, router, tenantProcedure } from "./_core/trpc";
import { getDb } from "./db";
import { eq, and, gte, lte, sql } from "drizzle-orm";
import {
  professionals,
  institutions,
  hospitals,
  sectors,
  shiftInstances,
  shiftAssignmentsV2,
  professionalInstitutions,
} from "../drizzle/schema";
import { getManagerScope as resolveManagerScope } from "./manager-scope-helper";

// ─── professionals ────────────────────────────────────────────────────────────

export const professionalsRouter = router({
  me: tenantProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new Error("Database not available");
    const [pro] = await db
      .select()
      .from(professionals)
      .where(eq(professionals.userId, ctx.user.id));
    return pro ?? null;
  }),

  getByUserId: tenantProcedure
    .input(z.object({ userId: z.number().int() }))
    .query(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");
      const [pro] = await db
        .select()
        .from(professionals)
        .innerJoin(
          professionalInstitutions,
          and(
            eq(professionalInstitutions.professionalId, professionals.id),
            eq(professionalInstitutions.userId, professionals.userId),
          ),
        )
        .where(
          and(
            eq(professionals.userId, input.userId),
            eq(professionalInstitutions.institutionId, ctx.institutionId),
            eq(professionalInstitutions.active, true),
          ),
        );
      return pro?.professionals ?? null;
    }),

  /**
   * Returns the management scope for the logged-in professional.
   * Used by useFilterDefaults hook to auto-select hospital/sector filters.
   */
  getManagerScope: tenantProcedure.query(async ({ ctx }) => {
    try {
      return await resolveManagerScope(ctx.user.id, ctx.institutionId);
    } catch {
      return { role: "USER" as const, canManageAll: false, hospitals: [] as number[], sectors: [] as Array<{ hospitalId: number; sectorId: number }> };
    }
  }),

  listInstitutions: protectedProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new Error("Database not available");

    return db
      .select({
        institutionId: professionalInstitutions.institutionId,
        name: institutions.name,
        isPrimary: professionalInstitutions.isPrimary,
        roleInInstitution: professionalInstitutions.roleInInstitution,
      })
      .from(professionalInstitutions)
      .innerJoin(
        institutions,
        eq(institutions.id, professionalInstitutions.institutionId),
      )
      .where(
        and(
          eq(professionalInstitutions.userId, ctx.user.id),
          eq(professionalInstitutions.active, true),
        ),
      );
  }),

  getAutoRoutingHint: protectedProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new Error("Database not available");

    const rows = await db.execute<any>(
      sql`SELECT
            si.institution_id AS institutionId,
            si.id AS shiftInstanceId,
            si.start_at AS startAt,
            si.end_at AS endAt,
            CASE
              WHEN NOW() BETWEEN si.start_at AND si.end_at THEN 0
              ELSE 1
            END AS rankState,
            ABS(TIMESTAMPDIFF(SECOND, si.start_at, NOW())) AS rankDistance
          FROM shift_assignments_v2 sa
          INNER JOIN professionals p
            ON p.id = sa.professional_id
          INNER JOIN shift_instances si
            ON si.id = sa.shift_instance_id
          INNER JOIN professional_institutions pi
            ON pi.professional_id = p.id
            AND pi.institution_id = si.institution_id
            AND pi.active = true
          WHERE p.user_id = ${ctx.user.id}
            AND sa.is_active = true
            AND sa.status IN ('OCUPADO', 'CONFIRMADO')
            AND si.end_at >= NOW()
            AND si.start_at <= DATE_ADD(NOW(), INTERVAL 4 HOUR)
          ORDER BY rankState ASC, rankDistance ASC
          LIMIT 1`,
    );

    const data = (rows as any)[0] as
      | Array<{
          institutionId: number;
          shiftInstanceId: number;
          startAt: Date | string;
          endAt: Date | string;
        }>
      | undefined;
    const first = data?.[0];
    if (!first) return null;

    return {
      institutionId: Number(first.institutionId),
      shiftInstanceId: Number(first.shiftInstanceId),
      startAt: new Date(first.startAt),
      endAt: new Date(first.endAt),
    };
  }),
});

// ─── hospitals ────────────────────────────────────────────────────────────────

export const hospitalsRouter = router({
  list: tenantProcedure.query(async ({ ctx }) => {
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
  list: tenantProcedure.query(async ({ ctx }) => {
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
  summaryCounts: tenantProcedure
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

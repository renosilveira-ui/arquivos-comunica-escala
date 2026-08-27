/**
 * Auxiliary tRPC routers: professionals, hospitals, sectors, filters.
 * Registered in appRouter to supply client screens that query these endpoints.
 */
import { z } from "zod";
import { router, protectedProcedure, sessionProcedure } from "./_core/trpc";
import { getDb } from "./db";
import { dayWindowBrt } from "./local-time";
import { eq, and, gte, isNull, sql, lt } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import {
  professionals,
  hospitals,
  sectors,
  institutions,
  professionalInstitutions,
  users,
  managerScope as managerScopeTable,
  shiftInstances,
  scheduleContexts,
} from "../drizzle/schema";
import {
  actorCapabilities,
  assertCanManageInstitutionSchedule,
  assertManagerScopeAccess,
  getTenantActorFromContext,
} from "./_core/policy";
import { listAuthorizedScheduleContexts } from "./schedule-contexts";

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
      const canReadOthers =
        capabilities.canCreateShift || capabilities.canApproveAssignments;
      if (!isSelf && !canReadOthers) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Sem permissão para consultar outro usuário",
        });
      }

      if (isSelf) {
        const [pro] = await db
          .select()
          .from(professionals)
          .where(eq(professionals.userId, input.userId));
        return pro ?? null;
      }

      // Gestor só enxerga profissionais com vínculo ativo na instituição do
      // contexto — sem isto ids sequenciais enumeravam o cadastro de todo o
      // banco, de qualquer tenant (auditoria 22/08, M3).
      const [pro] = await db
        .select({ professional: professionals })
        .from(professionals)
        .innerJoin(
          professionalInstitutions,
          and(
            eq(professionalInstitutions.professionalId, professionals.id),
            eq(professionalInstitutions.institutionId, ctx.institutionId),
            eq(professionalInstitutions.active, true),
          ),
        )
        .where(eq(professionals.userId, input.userId))
        .limit(1);
      return pro?.professional ?? null;
    }),

  // Única leitura deliberadamente independente do tenant: o Listener usa a
  // allowlist canônica para sair de um tenant revogado e só então navegar.
  // A sessão continua obrigatória; nenhum recurso tenant-bound é exposto.
  listMyInstitutions: sessionProcedure.query(async ({ ctx }) => {
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
      .innerJoin(
        professionals,
        and(
          eq(professionals.id, professionalInstitutions.professionalId),
          eq(professionals.userId, professionalInstitutions.userId),
        ),
      )
      .innerJoin(
        users,
        and(
          eq(users.id, professionalInstitutions.userId),
          // A allowlist vira prova de autorização no boot. Ela só pode ser
          // emitida pela mesma versão de sessão autenticada no contexto:
          // reset/logout concorrente invalida o snapshot inteiro.
          eq(users.sessionVersion, ctx.user.sessionVersion),
          eq(users.approvalStatus, "APPROVED"),
          isNull(users.deletedAt),
        ),
      )
      .innerJoin(
        institutions,
        and(
          eq(institutions.id, professionalInstitutions.institutionId),
          eq(institutions.isActive, true),
        ),
      )
      .where(
        and(
          eq(professionalInstitutions.userId, ctx.user.id),
          eq(professionalInstitutions.active, true),
        ),
      );

    return rows
      .sort(
        (a, b) =>
          Number(b.isPrimary) - Number(a.isPrimary) ||
          a.institutionId - b.institutionId,
      )
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
          scheduleContextId: shiftInstances.scheduleContextId,
        })
        .from(shiftInstances)
        .innerJoin(
          scheduleContexts,
          and(
            eq(scheduleContexts.id, shiftInstances.scheduleContextId),
            eq(scheduleContexts.institutionId, shiftInstances.institutionId),
            eq(scheduleContexts.hospitalId, shiftInstances.hospitalId),
            eq(scheduleContexts.sectorId, shiftInstances.sectorId),
            eq(scheduleContexts.active, true),
          ),
        )
        .where(
          and(
            eq(shiftInstances.id, input.shiftInstanceId),
            eq(shiftInstances.institutionId, ctx.institutionId),
          ),
        )
        .limit(1);

      if (!shift) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Plantão não encontrado",
        });
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
            pi.role_in_institution AS roleInInstitution
          FROM professionals p
          INNER JOIN professional_institutions pi
            ON pi.professional_id = p.id
            AND pi.user_id = p.user_id
            AND pi.institution_id = ${ctx.institutionId}
            AND pi.active = true
          INNER JOIN users u
            ON u.id = p.user_id
            AND u.approval_status = 'APPROVED'
            AND u.deleted_at IS NULL
          INNER JOIN professional_access pa
            ON pa.professional_id = p.id
            AND pa.institution_id = ${ctx.institutionId}
            AND pa.hospital_id = ${shift.hospitalId}
            AND (pa.sector_id IS NULL OR pa.sector_id = ${shift.sectorId})
            AND pa.can_access = true
          INNER JOIN shift_instances target_shift
            ON target_shift.id = ${input.shiftInstanceId}
            AND target_shift.institution_id = ${ctx.institutionId}
            AND target_shift.hospital_id = ${shift.hospitalId}
            AND target_shift.sector_id = ${shift.sectorId}
          INNER JOIN schedule_contexts sc
            ON sc.id = ${shift.scheduleContextId}
            AND sc.institution_id = ${ctx.institutionId}
            AND sc.hospital_id = ${shift.hospitalId}
            AND sc.sector_id = ${shift.sectorId}
            AND sc.active = true
          LEFT JOIN medical_specialties ms
            ON ms.id = sc.medical_specialty_id
            AND ms.active = true
          LEFT JOIN shift_assignments_v2 sa
            ON sa.professional_id = p.id
            AND sa.shift_instance_id = ${input.shiftInstanceId}
            AND sa.is_active = true
          WHERE sa.id IS NULL
            AND (
              (
                sc.admission_policy = 'ALL_CFM_SPECIALTIES'
                AND p.medical_specialty_id IS NOT NULL
              )
              OR
              (
                sc.admission_policy = 'ALL_CFM_EXCEPT_GENERALIST'
                AND p.medical_specialty_id IS NOT NULL
                AND p.operational_profile_code IS NULL
              )
              OR
              (
                sc.medical_specialty_id IS NOT NULL
                AND ms.id IS NOT NULL
                AND p.medical_specialty_id = sc.medical_specialty_id
              )
              OR
              (
                sc.operational_profile_code IS NOT NULL
                AND p.operational_profile_code = sc.operational_profile_code
              )
              OR
              (
                sc.admission_policy = 'QUALIFICATION_ALLOWLIST'
                AND EXISTS (
                  SELECT 1
                    FROM schedule_context_allowed_qualifications aq
                   WHERE aq.schedule_context_id = sc.id
                     AND (
                       (
                         aq.medical_specialty_id IS NOT NULL
                         AND p.medical_specialty_id = aq.medical_specialty_id
                       )
                       OR
                       (
                         aq.operational_profile_code IS NOT NULL
                         AND p.operational_profile_code = aq.operational_profile_code
                       )
                     )
                )
              )
            )
            AND NOT EXISTS (
              SELECT 1
              FROM shift_assignments_v2 conflict_assignment
              INNER JOIN shift_instances conflict_shift
                ON conflict_shift.id = conflict_assignment.shift_instance_id
                AND conflict_shift.institution_id = conflict_assignment.institution_id
                AND conflict_shift.hospital_id = conflict_assignment.hospital_id
                AND conflict_shift.sector_id = conflict_assignment.sector_id
              WHERE conflict_assignment.professional_id = p.id
                AND conflict_assignment.is_active = true
                AND conflict_shift.start_at < target_shift.end_at
                AND conflict_shift.end_at > target_shift.start_at
            )
          ORDER BY p.name ASC
        `,
      );
      const rows =
        (result as any).rows ||
        (Array.isArray(result) && Array.isArray(result[0])
          ? result[0]
          : result);
      return rows.map((row: any) => ({
        id: Number(row.id),
        name: String(row.name),
        role: String(row.role),
        roleInInstitution: row.roleInInstitution as
          "USER" | "GESTOR_MEDICO" | "GESTOR_PLUS",
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
      return {
        role: "GESTOR_PLUS" as const,
        canManageAll: true,
        hospitals: [] as number[],
        sectors: [] as { hospitalId: number; sectorId: number }[],
      };
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

    return {
      role: "USER" as const,
      canManageAll: false,
      hospitals: [] as number[],
      sectors: [] as { hospitalId: number; sectorId: number }[],
    };
  }),
});

// ─── hospitals ────────────────────────────────────────────────────────────────

export const hospitalsRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new Error("Database not available");
    const actor = await getTenantActorFromContext(ctx);
    const contexts = await listAuthorizedScheduleContexts(actor, db);
    const authorizedHospitalIds = new Set(
      contexts.map((context) => context.hospitalId),
    );
    const rows = await db
      .select({
        id: hospitals.id,
        name: hospitals.name,
        institutionId: hospitals.institutionId,
      })
      .from(hospitals)
      .where(eq(hospitals.institutionId, ctx.institutionId));
    return rows.filter((hospital) => authorizedHospitalIds.has(hospital.id));
  }),
});

// ─── sectors ─────────────────────────────────────────────────────────────────

export const sectorsRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new Error("Database not available");
    const actor = await getTenantActorFromContext(ctx);
    const contexts = await listAuthorizedScheduleContexts(actor, db);
    const authorizedSectorIds = new Set(
      contexts.map((context) => context.sectorId),
    );
    const rows = await db
      .select({
        id: sectors.id,
        name: sectors.name,
        hospitalId: sectors.hospitalId,
        category: sectors.category,
      })
      .from(sectors)
      .where(eq(sectors.institutionId, ctx.institutionId));
    return rows.filter((sector) => authorizedSectorIds.has(sector.id));
  }),
});

// ─── filters ─────────────────────────────────────────────────────────────────

export const filtersRouter = router({
  /**
   * Returns aggregate counts for vacancies and pending assignments
   * for a given date, grouped by hospital and sector — used by ShiftFilters UI.
   */
  summaryCounts: protectedProcedure
    .input(
      z.object({
        date: z.string(),
        scheduleContextId: z.number().int().positive().optional(),
      }),
    )
    .query(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");
      const actor = await getTenantActorFromContext(ctx);
      const contexts = await listAuthorizedScheduleContexts(actor, db);
      const authorizedContextIds = new Set(
        contexts.map((context) => context.id),
      );
      if (
        input.scheduleContextId !== undefined &&
        !authorizedContextIds.has(input.scheduleContextId)
      ) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Escala fora do acesso do usuário neste tenant.",
        });
      }

      // Janela do dia no relógio do hospital (-03:00), fim exclusivo.
      const { start: startOfDay, end: endOfDay } = dayWindowBrt(input.date);

      const instances = await db
        .select({
          instance: shiftInstances,
          scheduleContextId: scheduleContexts.id,
        })
        .from(shiftInstances)
        .innerJoin(
          scheduleContexts,
          and(
            eq(scheduleContexts.id, shiftInstances.scheduleContextId),
            eq(scheduleContexts.institutionId, shiftInstances.institutionId),
            eq(scheduleContexts.hospitalId, shiftInstances.hospitalId),
            eq(scheduleContexts.sectorId, shiftInstances.sectorId),
            eq(scheduleContexts.active, true),
          ),
        )
        .innerJoin(
          hospitals,
          and(
            eq(hospitals.id, shiftInstances.hospitalId),
            eq(hospitals.institutionId, shiftInstances.institutionId),
          ),
        )
        .innerJoin(
          sectors,
          and(
            eq(sectors.id, shiftInstances.sectorId),
            eq(sectors.institutionId, shiftInstances.institutionId),
            eq(sectors.hospitalId, shiftInstances.hospitalId),
          ),
        )
        .where(
          and(
            eq(shiftInstances.institutionId, ctx.institutionId),
            gte(shiftInstances.startAt, startOfDay),
            lt(shiftInstances.startAt, endOfDay),
            ...(input.scheduleContextId !== undefined
              ? [eq(shiftInstances.scheduleContextId, input.scheduleContextId)]
              : []),
          ),
        );

      const vacanciesByHospital: Record<number, number> = {};
      const pendingByHospital: Record<number, number> = {};
      const vacanciesBySector: Record<number, number> = {};
      const pendingBySector: Record<number, number> = {};

      for (const { instance: inst, scheduleContextId } of instances) {
        if (!authorizedContextIds.has(scheduleContextId)) continue;
        if (inst.status === "VAGO") {
          vacanciesByHospital[inst.hospitalId] =
            (vacanciesByHospital[inst.hospitalId] ?? 0) + 1;
          vacanciesBySector[inst.sectorId] =
            (vacanciesBySector[inst.sectorId] ?? 0) + 1;
        } else if (inst.status === "PENDENTE") {
          pendingByHospital[inst.hospitalId] =
            (pendingByHospital[inst.hospitalId] ?? 0) + 1;
          pendingBySector[inst.sectorId] =
            (pendingBySector[inst.sectorId] ?? 0) + 1;
        }
      }

      return {
        vacanciesByHospital,
        pendingByHospital,
        vacanciesBySector,
        pendingBySector,
      };
    }),
});

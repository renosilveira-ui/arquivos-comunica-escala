/**
 * Auxiliary tRPC routers: professionals, hospitals, sectors, filters.
 * Registered in appRouter to supply client screens that query these endpoints.
 */
import { z } from "zod";
import { router, protectedProcedure, sessionProcedure } from "./_core/trpc";
import { getDb } from "./db";
import { rowsFromExecute } from "./_core/db-results";
import { dayWindowBrt, monthWindowBrt } from "./local-time";
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
  assertCanCreateHospital,
  assertCanManageInstitutionSchedule,
  assertManagerScopeAccess,
  getTenantActorFromContext,
} from "./_core/policy";
import { listAuthorizedScheduleContexts } from "./schedule-contexts";
import { listManageableTopology } from "./sector-scale";

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
          admissionPolicy: scheduleContexts.admissionPolicy,
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

      // Plantonista visível = conta aprovada + profissional + (
      //   acesso setorial OU manager_scope OU convite nominal pendente
      // ). E-mail enviado ≠ resgate: o convite ainda não grava
      // professional_access. Sala de espera (sem vínculo ativo) entra se
      // o convite foi emitido para ela. Especialidade / allowlist NÃO
      // filtra alocação — quem tem acesso, scope ou convite aparece,
      // inclusive GESTOR_MEDICO sem especialidade.
      const now = new Date();
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
            COALESCE(pi.role_in_institution, 'USER') AS roleInInstitution
          FROM professionals p
          INNER JOIN users u
            ON u.id = p.user_id
            AND u.approval_status = 'APPROVED'
            AND u.deleted_at IS NULL
          LEFT JOIN professional_institutions pi
            ON pi.professional_id = p.id
            AND pi.user_id = p.user_id
            AND pi.institution_id = ${ctx.institutionId}
            AND pi.active = true
          LEFT JOIN professional_access pa
            ON pa.professional_id = p.id
            AND pa.institution_id = ${ctx.institutionId}
            AND pa.hospital_id = ${shift.hospitalId}
            AND (
              (
                ${shift.admissionPolicy} = 'QUALIFICATION_ALLOWLIST'
                AND pa.sector_id = ${shift.sectorId}
              )
              OR
              (
                ${shift.admissionPolicy} <> 'QUALIFICATION_ALLOWLIST'
                AND (pa.sector_id IS NULL OR pa.sector_id = ${shift.sectorId})
              )
            )
            AND pa.can_access = true
          LEFT JOIN manager_scope mgr
            ON mgr.manager_professional_id = p.id
            AND mgr.institution_id = ${ctx.institutionId}
            AND mgr.hospital_id = ${shift.hospitalId}
            AND (mgr.sector_id IS NULL OR mgr.sector_id = ${shift.sectorId})
            AND mgr.active = true
          LEFT JOIN schedule_invites pending_invite
            ON pending_invite.institution_id = ${ctx.institutionId}
            AND pending_invite.hospital_id = ${shift.hospitalId}
            AND pending_invite.sector_id = ${shift.sectorId}
            AND pending_invite.invited_user_id = p.user_id
            AND pending_invite.revoked_at IS NULL
            AND pending_invite.expires_at > ${now}
            AND pending_invite.redeemed_count < pending_invite.max_redemptions
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
          LEFT JOIN shift_assignments_v2 sa
            ON sa.professional_id = p.id
            AND sa.shift_instance_id = ${input.shiftInstanceId}
            AND sa.is_active = true
          WHERE sa.id IS NULL
            AND (
              pa.id IS NOT NULL
              OR mgr.id IS NOT NULL
              OR pending_invite.id IS NOT NULL
            )
            AND (
              pi.id IS NOT NULL
              OR pending_invite.id IS NOT NULL
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
      return rowsFromExecute<{
        id: number;
        name: string;
        role: string;
        roleInInstitution: "USER" | "GESTOR_MEDICO" | "GESTOR_PLUS";
      }>(result).map((row) => ({
        id: Number(row.id),
        name: String(row.name),
        role: String(row.role),
        roleInInstitution: row.roleInInstitution,
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
    const rows = await db
      .select({
        id: hospitals.id,
        name: hospitals.name,
        institutionId: hospitals.institutionId,
      })
      .from(hospitals)
      .where(eq(hospitals.institutionId, ctx.institutionId));
    if (
      actor.isGlobalAdmin ||
      actor.roleInInstitution === "GESTOR_PLUS" ||
      actor.roleInInstitution === "GESTOR_MEDICO"
    ) {
      const topology = await listManageableTopology(db, actor);
      const authorizedHospitalIds = new Set(
        topology.hospitals.map((hospital) => hospital.id),
      );
      return rows.filter((hospital) => authorizedHospitalIds.has(hospital.id));
    }
    const contexts = await listAuthorizedScheduleContexts(actor, db);
    const authorizedHospitalIds = new Set(
      contexts.map((context) => context.hospitalId),
    );
    return rows.filter((hospital) => authorizedHospitalIds.has(hospital.id));
  }),

  /**
   * Cadastra um hospital no tenant ativo. Sem isto a terceira instituição
   * não abre calendário — o seed da Unimed não é produto.
   */
  create: protectedProcedure
    .input(
      z.object({
        name: z
          .string()
          .trim()
          .min(2, "Informe o nome do hospital (pelo menos 2 caracteres).")
          .max(255, "Nome do hospital é longo demais."),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const actor = await getTenantActorFromContext(ctx);
      assertCanCreateHospital(actor);
      const db = await getDb();
      if (!db) throw new Error("Database not available");
      const name = input.name.trim().replace(/\s+/g, " ");
      const [inserted] = await db
        .insert(hospitals)
        .values({
          institutionId: ctx.institutionId,
          name,
        })
        .$returningId();
      return {
        id: inserted.id,
        name,
        institutionId: ctx.institutionId,
      };
    }),
});

// ─── sectors ─────────────────────────────────────────────────────────────────

export const sectorsRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new Error("Database not available");
    const actor = await getTenantActorFromContext(ctx);
    const rows = await db
      .select({
        id: sectors.id,
        name: sectors.name,
        hospitalId: sectors.hospitalId,
        category: sectors.category,
      })
      .from(sectors)
      .where(eq(sectors.institutionId, ctx.institutionId));
    if (
      actor.isGlobalAdmin ||
      actor.roleInInstitution === "GESTOR_PLUS" ||
      actor.roleInInstitution === "GESTOR_MEDICO"
    ) {
      const topology = await listManageableTopology(db, actor);
      const authorizedSectorIds = new Set(
        topology.hospitals.flatMap((hospital) =>
          hospital.sectors.map((sector) => sector.id),
        ),
      );
      return rows.filter((sector) => authorizedSectorIds.has(sector.id));
    }
    const contexts = await listAuthorizedScheduleContexts(actor, db);
    const authorizedSectorIds = new Set(
      contexts.map((context) => context.sectorId),
    );
    return rows.filter((sector) => authorizedSectorIds.has(sector.id));
  }),
});

// ─── filters ─────────────────────────────────────────────────────────────────

export const filtersRouter = router({
  /**
   * Há plantão neste hospital+mês? PUBLISHED em monthly_rosters não
   * responde isso — o formulário de criar turno só pede motivo quando
   * o mês já tem conteúdo.
   */
  hasMonthShifts: protectedProcedure
    .input(
      z.object({
        hospitalId: z.number().int().positive(),
        yearMonth: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "YYYY-MM"),
      }),
    )
    .query(async ({ ctx, input }) => {
      const actor = await getTenantActorFromContext(ctx);
      assertCanManageInstitutionSchedule(actor);
      await assertManagerScopeAccess(actor, input.hospitalId, undefined, {
        mode: "any-hospital",
      });
      const db = await getDb();
      if (!db) throw new Error("Database not available");
      const window = monthWindowBrt(input.yearMonth);
      const [row] = await db
        .select({ id: shiftInstances.id })
        .from(shiftInstances)
        .where(
          and(
            eq(shiftInstances.institutionId, ctx.institutionId),
            eq(shiftInstances.hospitalId, input.hospitalId),
            gte(shiftInstances.startAt, window.start),
            lt(shiftInstances.startAt, window.end),
          ),
        )
        .limit(1);
      return { hasShifts: !!row };
    }),

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

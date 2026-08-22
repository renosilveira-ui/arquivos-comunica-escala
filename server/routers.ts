import { z } from "zod";
import { router, protectedProcedure } from "./_core/trpc";
import { getDb } from "./db";
import { rowsFromExecute } from "./_core/db-results";
import { dayWindowBrt } from "./local-time";
import { assertMonthNotLocked } from "./month-guards";
import { eq, and, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { professionals, shiftInstances, shiftAssignmentsV2 } from "../drizzle/schema";
import { validateAssignment } from "./shift-validations";
import { auditLog } from "./audit-log";
import { assertNoTimeConflictForProfessional } from "./shift-validations-v2";
import { assertSpecialtyCompatible } from "./specialty";
import { recordAudit } from "./audit-trail";
import { recomputeShiftStatus } from "./shift-status";
import {
  actorCapabilities,
  assertCanEditScheduleDate,
  assertCanManageInstitutionSchedule,
  assertManagerScopeAccess,
  getTenantActorFromContext,
} from "./_core/policy";
import { editorRouter } from "./editor";
import { swapRouter } from "./swap-router";
import { auditRouter } from "./audit-router";
import { calendarRouter } from "./calendar";
import { shiftsRouter } from "./shifts-crud";
import { professionalsRouter, hospitalsRouter, sectorsRouter, filtersRouter } from "./aux-routers";
import { confirmationRouter } from "./confirmation-router";
import { voiceRouter } from "./voice-router";

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

      // Separação por serviço: anestesista não assume vaga de cirurgia etc.
      assertSpecialtyCompatible(shift.specialty, professional.specialty);

      // Escala trancada não aceita candidatura (auditoria 22/08, M10): o
      // turno mudaria de status num mês que o gestor de hospital não pode
      // mais tocar para desfazer.
      await assertMonthNotLocked(shift.institutionId, shift.hospitalId, shift.startAt);

      const validation = await validateAssignment(
        professional.id,
        input.shiftInstanceId,
        shift.hospitalId,
        shift.sectorId
      );

      if (!validation.valid) {
        throw new Error(validation.error || "Validation failed");
      }

      // Transação + guarda otimista: dois médicos assumindo a mesma vaga
      // ao mesmo tempo → o UPDATE condicional (status ainda VAGO) é a
      // trava; quem perde recebe CONFLICT e nada fica pela metade.
      const assignmentId = await db.transaction(async (tx) => {
        const [claimed] = await tx
          .update(shiftInstances)
          .set({ status: "PENDENTE" })
          .where(
            and(
              eq(shiftInstances.id, input.shiftInstanceId),
              eq(shiftInstances.status, "VAGO"),
            ),
          );
        if (!claimed.affectedRows) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "Este plantão acabou de ser assumido por outro profissional.",
          });
        }
        const [result] = await tx.insert(shiftAssignmentsV2).values({
          shiftInstanceId: input.shiftInstanceId,
          institutionId: shift.institutionId,
          hospitalId: shift.hospitalId,
          sectorId: shift.sectorId,
          professionalId: professional.id,
          assignmentType: input.assignmentType,
          isActive: true,
          createdBy: userId,
        });
        return Number(result.insertId);
      });

      await auditLog({
        event: "VACANCY_REQUESTED",
        shiftInstanceId: input.shiftInstanceId,
        professionalId: professional.id,
        metadata: { assignmentType: input.assignmentType, userId },
      });

      return { ok: true, assignmentId, status: "PENDENTE" as const };
    }),

  // Listar solicitações de vaga feitas pelo usuário logado.
  // Diferente de "minhas escalas": esta lista acompanha o pedido enviado
  // pelo botão "Assumir Plantão", incluindo pendente, aprovado e recusado.
  listMyVacancyRequests: protectedProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new Error("Database not available");

    const userId = ctx.user?.id;
    if (!userId) throw new Error("Autenticação necessária");

    const [professional] = await db
      .select({ id: professionals.id })
      .from(professionals)
      .where(eq(professionals.userId, userId));

    if (!professional) return [];

    const rows = await db.execute<any>(
      sql`SELECT
            sa.id              AS assignmentId,
            sa.shift_instance_id AS shiftInstanceId,
            sa.assignment_type AS assignmentType,
            sa.status          AS status,
            sa.is_active       AS isActive,
            sa.created_at      AS createdAt,
            sa.updated_at      AS updatedAt,
            si.label           AS shiftLabel,
            si.status          AS shiftStatus,
            si.start_at        AS startAt,
            si.end_at          AS endAt,
            si.modality        AS modality,
            si.coverage_type   AS coverageType,
            si.payment_model   AS paymentModel,
            si.productivity_cap_brl AS productivityCapBrl,
            h.name             AS hospitalName,
            s.name             AS sectorName
          FROM shift_assignments_v2 sa
          JOIN shift_instances si ON sa.shift_instance_id = si.id
          JOIN hospitals h        ON si.hospital_id = h.id
          JOIN sectors s          ON si.sector_id = s.id
          WHERE sa.institution_id = ${ctx.institutionId}
            AND sa.professional_id = ${professional.id}
            AND sa.created_by = ${userId}
            AND sa.status IN ('PENDENTE', 'OCUPADO', 'REJEITADO')
          ORDER BY sa.created_at DESC, si.start_at ASC`
    );

    const data = (rows as any)[0];
    return (data as any[]).map((r) => ({
      assignmentId: r.assignmentId as number,
      shiftInstanceId: r.shiftInstanceId as number,
      assignmentType: r.assignmentType as "ON_DUTY" | "BACKUP" | "ON_CALL",
      status: r.status as "PENDENTE" | "OCUPADO" | "REJEITADO",
      isActive: r.isActive === true || r.isActive === 1,
      createdAt: new Date(r.createdAt),
      updatedAt: new Date(r.updatedAt),
      shiftLabel: r.shiftLabel as string,
      shiftStatus: r.shiftStatus as string,
      startAt: new Date(r.startAt),
      endAt: new Date(r.endAt),
      hospitalName: r.hospitalName as string,
      sectorName: r.sectorName as string,
      modality: r.modality as "PLANTAO" | "SOBREAVISO",
      coverageType: (r.coverageType ?? null) as "URGENCIA_EMERGENCIA" | "ELETIVAS" | null,
      paymentModel: r.paymentModel as
        | "FIXO"
        | "FIXO_PRODUTIVIDADE_TETO"
        | "FIXO_PRODUTIVIDADE_SEM_TETO"
        | "PRODUTIVIDADE_PURA",
      productivityCapBrl: (r.productivityCapBrl ?? null) as string | null,
    }));
  }),

  // Listar alocações pendentes com dados enriquecidos.
  // Modalidade do shift subjacente (PR #61) também flui pra cá pra
  // que o gestor consiga filtrar/visualizar por tipo na tela de
  // Solicitações sem fazer outra query.
  listPending: protectedProcedure
    .input(
      z.object({
        hospitalId: z.number().optional(),
        sectorId: z.number().optional(),
        date: z.string().optional(),
        shiftLabel: z.string().nullish(),
        modality: z.enum(["PLANTAO", "SOBREAVISO"]).optional(),
        coverageType: z.enum(["URGENCIA_EMERGENCIA", "ELETIVAS"]).optional(),
      }).optional(),
    )
    .query(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      // Janela do dia no relógio do hospital (-03:00): o servidor roda em
      // UTC e `T00:00:00` sem offset cobria 21h do dia anterior a 20h59
      // (auditoria 22/08, M6).
      let startOfDay: Date | undefined;
      let endOfDay: Date | undefined;
      if (input?.date) {
        ({ start: startOfDay, end: endOfDay } = dayWindowBrt(input.date));
      }

      // Solicitações pendentes são assunto de quem aprova: USER comum não
      // lista pedidos de terceiros; gestor de hospital só vê a própria
      // jurisdição (manager_scope), como em audit.listShiftMovements
      // (auditoria 22/08, B1).
      const actor = await getTenantActorFromContext(ctx);
      const caps = actorCapabilities(actor);
      if (!caps.canApproveAssignments) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Apenas gestores podem listar solicitações pendentes." });
      }
      let scopeWhere = sql``;
      const isLocalManager = !actor.isGlobalAdmin && actor.roleInInstitution === "GESTOR_MEDICO";
      if (isLocalManager) {
        if (!actor.professionalId) return [];
        const scopeRows = rowsFromExecute<{ hospital_id: number; sector_id: number | null }>(
          await db.execute(
            sql`SELECT hospital_id, sector_id FROM manager_scope
                WHERE manager_professional_id = ${actor.professionalId}
                  AND institution_id = ${ctx.institutionId}
                  AND active = 1`,
          ),
        );
        if (scopeRows.length === 0) return [];
        const parts = scopeRows.map((r) =>
          r.sector_id == null
            ? sql`si.hospital_id = ${r.hospital_id}`
            : sql`(si.hospital_id = ${r.hospital_id} AND si.sector_id = ${r.sector_id})`,
        );
        scopeWhere = sql`AND (${sql.join(parts, sql` OR `)})`;
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
              si.hospital_id   AS hospitalId,
              si.modality            AS modality,
              si.coverage_type       AS coverageType,
              si.payment_model       AS paymentModel,
              si.productivity_cap_brl AS productivityCapBrl
            FROM shift_assignments_v2 sa
            JOIN professionals p   ON sa.professional_id = p.id
            JOIN shift_instances si ON sa.shift_instance_id = si.id
            JOIN sectors s         ON si.sector_id = s.id
            WHERE sa.is_active = true
              AND sa.institution_id = ${ctx.institutionId}
              AND sa.status = 'PENDENTE'
              ${scopeWhere}
              ${input?.hospitalId ? sql`AND si.hospital_id = ${input.hospitalId}` : sql``}
              ${input?.sectorId   ? sql`AND si.sector_id   = ${input.sectorId}`   : sql``}
              ${input?.shiftLabel ? sql`AND si.label       = ${input.shiftLabel}` : sql``}
              ${input?.modality   ? sql`AND si.modality    = ${input.modality}`   : sql``}
              ${input?.coverageType ? sql`AND si.coverage_type = ${input.coverageType}` : sql``}
              ${startOfDay && endOfDay ? sql`AND si.start_at >= ${startOfDay} AND si.start_at < ${endOfDay}` : sql``}
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
        // Modalidade do shift subjacente (PR #61). Mesmas colunas que
        // shiftInstances.listVacancies expõe, pra a UI de Solicitações
        // poder filtrar e renderizar consistentemente.
        modality:           r.modality           as "PLANTAO" | "SOBREAVISO",
        coverageType:       (r.coverageType ?? null) as "URGENCIA_EMERGENCIA" | "ELETIVAS" | null,
        paymentModel:       r.paymentModel       as
          | "FIXO"
          | "FIXO_PRODUTIVIDADE_TETO"
          | "FIXO_PRODUTIVIDADE_SEM_TETO"
          | "PRODUTIVIDADE_PURA",
        productivityCapBrl: (r.productivityCapBrl ?? null) as string | null,
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

      const actor = await getTenantActorFromContext(ctx);
      assertCanManageInstitutionSchedule(actor);
      await assertManagerScopeAccess(actor, assignment.hospitalId, assignment.sectorId);

      const managerProfessionalId = actor.professionalId;
      if (!managerProfessionalId) {
        throw new Error("Profissional do aprovador não encontrado");
      }

      // Frente H1/H2: re-verifica overlap no momento da aprovação.
      // Entre o pedido (PENDENTE) e a aprovação, o profissional pode ter
      // assumido outra alocação que sobreponha esta janela. A janela alvo
      // é a do shift_instance referenciado no assignment.
      const [targetShift] = await db
        .select({ startAt: shiftInstances.startAt, endAt: shiftInstances.endAt })
        .from(shiftInstances)
        .where(eq(shiftInstances.id, assignment.shiftInstanceId));
      if (!targetShift) {
        throw new Error("Turno do assignment não encontrado");
      }
      assertCanEditScheduleDate(actor, targetShift.startAt);
      await assertNoTimeConflictForProfessional(
        assignment.professionalId,
        targetShift.startAt,
        targetShift.endAt,
        assignment.shiftInstanceId,
      );

      // Transação + guarda: aprovar duas vezes (dois gestores, duplo clique)
      // não pode gerar efeito duplo; o status do turno é derivado das
      // alocações ativas em vez de setado à mão.
      // Só uma alocação ATIVA e PENDENTE pode ser aprovada. Sem `isActive`
      // no WHERE, um clique em tela desatualizada reativava uma alocação já
      // rejeitada/removida e o turno ficava com dois titulares (auditoria
      // 22/08, achado A3).
      await db.transaction(async (tx) => {
        const [approved] = await tx
          .update(shiftAssignmentsV2)
          .set({ status: "OCUPADO" })
          .where(
            and(
              eq(shiftAssignmentsV2.id, input.assignmentId),
              eq(shiftAssignmentsV2.isActive, true),
              eq(shiftAssignmentsV2.status, "PENDENTE"),
            ),
          );
        if (!approved.affectedRows) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "Esta alocação já foi aprovada, rejeitada ou removida.",
          });
        }
        await recomputeShiftStatus(tx, assignment.shiftInstanceId);
      });

      await auditLog({
        event: "ASSIGNMENT_APPROVED",
        shiftInstanceId: assignment.shiftInstanceId,
        professionalId: managerProfessionalId,
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
        // audit_trail.institution_id é NOT NULL: sem isto o INSERT falhava
        // em silêncio ("[AuditTrail] Failed to record") e aprovação/rejeição
        // não entravam na trilha de auditoria.
        institutionId: ctx.institutionId,
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

      const actor = await getTenantActorFromContext(ctx);
      assertCanManageInstitutionSchedule(actor);
      await assertManagerScopeAccess(actor, assignment.hospitalId, assignment.sectorId);

      const managerProfessionalId = actor.professionalId;
      if (!managerProfessionalId) {
        throw new Error("Profissional do aprovador não encontrado");
      }

      const [targetShift] = await db
        .select({ startAt: shiftInstances.startAt })
        .from(shiftInstances)
        .where(eq(shiftInstances.id, assignment.shiftInstanceId));
      if (!targetShift) {
        throw new Error("Turno do assignment não encontrado");
      }
      assertCanEditScheduleDate(actor, targetShift.startAt);

      // Transação + guarda (só alocação ativa) + status do turno DERIVADO
      // das alocações restantes: rejeitar Y não pode esvaziar um turno em
      // que X continua ativo (auditoria 22/08, achado A4).
      await db.transaction(async (tx) => {
        const [rejected] = await tx
          .update(shiftAssignmentsV2)
          .set({ isActive: false, status: "REJEITADO" })
          .where(
            and(
              eq(shiftAssignmentsV2.id, input.assignmentId),
              eq(shiftAssignmentsV2.isActive, true),
            ),
          );
        if (!rejected.affectedRows) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "Esta alocação já foi respondida ou removida.",
          });
        }
        await recomputeShiftStatus(tx, assignment.shiftInstanceId);
      });

      await auditLog({
        event: "ASSIGNMENT_REJECTED",
        shiftInstanceId: assignment.shiftInstanceId,
        professionalId: managerProfessionalId,
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
        // audit_trail.institution_id é NOT NULL: sem isto o INSERT falhava
        // em silêncio ("[AuditTrail] Failed to record") e aprovação/rejeição
        // não entravam na trilha de auditoria.
        institutionId: ctx.institutionId,
        shiftInstanceId: assignment.shiftInstanceId,
        hospitalId: assignment.hospitalId,
        sectorId: assignment.sectorId,
      });

      return { ok: true };
    }),

  // List vacancies with enriched data (sector + hospital + modality).
  // PR #61 added modality / coverageType / paymentModel / productivityCapBrl
  // on shift_instances; this endpoint surfaces them for the Plantões em
  // aberto screen (and any radar filtering by modality).
  listVacancies: protectedProcedure
    .input(
      z.object({
        hospitalId: z.number().optional(),
        sectorId:   z.number().optional(),
        date:       z.string().optional(),
        shiftLabel: z.string().nullish(),
        modality:   z.enum(["PLANTAO", "SOBREAVISO"]).optional(),
        coverageType: z.enum(["URGENCIA_EMERGENCIA", "ELETIVAS"]).optional(),
      }).optional(),
    )
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      // Janela do dia no relógio do hospital (-03:00) — ver listPending.
      let startOfDay: Date | undefined;
      let endOfDay: Date | undefined;
      if (input?.date) {
        ({ start: startOfDay, end: endOfDay } = dayWindowBrt(input.date));
      }

      // Especialidade do profissional logado: vaga de outro serviço
      // não aparece (NULL de qualquer lado = sem restrição).
      const [me] = ctx.user
        ? await db.select({ specialty: professionals.specialty }).from(professionals).where(eq(professionals.userId, ctx.user.id)).limit(1)
        : [undefined];
      const mySpecialty = me?.specialty ?? null;

      const rows = await db.execute<any>(
        sql`SELECT
              si.id          AS shiftInstanceId,
              si.start_at    AS startAt,
              si.end_at      AS endAt,
              si.label,
              si.status,
              si.modality            AS modality,
              si.coverage_type       AS coverageType,
              si.payment_model       AS paymentModel,
              si.productivity_cap_brl AS productivityCapBrl,
              s.name         AS sectorName,
              h.name         AS hospitalName,
              si.hospital_id AS hospitalId,
              si.sector_id   AS sectorId
            FROM shift_instances si
            JOIN sectors  s ON si.sector_id  = s.id
            JOIN hospitals h ON si.hospital_id = h.id
            WHERE si.status = 'VAGO'
              AND si.institution_id = ${ctx.institutionId}
              -- Mês trancado não oferece vagas (start_at em UTC → mês do hospital, -03:00)
              AND NOT EXISTS (
                SELECT 1 FROM monthly_rosters mr
                WHERE mr.institution_id = si.institution_id
                  AND mr.hospital_id = si.hospital_id
                  AND mr.year_month = DATE_FORMAT(DATE_SUB(si.start_at, INTERVAL 3 HOUR), '%Y-%m')
                  AND mr.status = 'LOCKED'
              )
              ${input?.hospitalId ? sql`AND si.hospital_id = ${input.hospitalId}` : sql``}
              ${input?.sectorId   ? sql`AND si.sector_id   = ${input.sectorId}`   : sql``}
              ${input?.shiftLabel ? sql`AND si.label       = ${input.shiftLabel}` : sql``}
              ${input?.modality   ? sql`AND si.modality    = ${input.modality}`   : sql``}
              ${input?.coverageType ? sql`AND si.coverage_type = ${input.coverageType}` : sql``}
              ${startOfDay && endOfDay ? sql`AND si.start_at >= ${startOfDay} AND si.start_at < ${endOfDay}` : sql``}
              ${mySpecialty ? sql`AND (si.specialty IS NULL OR si.specialty = ${mySpecialty})` : sql``}
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
        // Modalidade (PR #61). Tipos vêm como string do mysql2; expõe
        // direto pra o cliente formatar com os labels PT-BR.
        modality:           r.modality           as "PLANTAO" | "SOBREAVISO",
        coverageType:       (r.coverageType ?? null) as "URGENCIA_EMERGENCIA" | "ELETIVAS" | null,
        paymentModel:       r.paymentModel       as
          | "FIXO"
          | "FIXO_PRODUTIVIDADE_TETO"
          | "FIXO_PRODUTIVIDADE_SEM_TETO"
          | "PRODUTIVIDADE_PURA",
        productivityCapBrl: (r.productivityCapBrl ?? null) as string | null,
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
  audit:            auditRouter,
  confirmations:    confirmationRouter,
  voice:            voiceRouter,
});

export type AppRouter = typeof appRouter;

import { z } from "zod";
import { router, protectedProcedure } from "./_core/trpc";
import { getDb } from "./db";
import { rowsFromExecute } from "./_core/db-results";
import { dayWindowBrt } from "./local-time";
import { assertMonthNotLockedForUpdate } from "./month-guards";
import { eq, and, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { shiftInstances, shiftAssignmentsV2 } from "../drizzle/schema";
import { auditLog } from "./audit-log";
import {
  ASSIGNMENT_WRITE_TRANSACTION_CONFIG,
  assertAssignmentWritesAllowedForUpdate,
  assertShiftAssignmentCapacityForUpdate,
} from "./shift-validations-v2";
import { recordAudit } from "./audit-trail";
import { recomputeShiftStatus } from "./shift-status";
import {
  actorCapabilities,
  assertCanEditScheduleDate,
  assertCanManageInstitutionSchedule,
  assertManagerScopeAccess,
  assertManagerScopeAccessForUpdate,
  getTenantActorFromContext,
} from "./_core/policy";
import { editorRouter } from "./editor";
import { swapRouter } from "./swap-router";
import { auditRouter } from "./audit-router";
import { calendarRouter } from "./calendar";
import { shiftsRouter } from "./shifts-crud";
import {
  professionalsRouter,
  hospitalsRouter,
  sectorsRouter,
  filtersRouter,
} from "./aux-routers";
import { confirmationRouter } from "./confirmation-router";
import { voiceRouter } from "./voice-router";
import { assertInstitutionHierarchy } from "./_core/tenant";
import {
  assertActiveScheduleContextTopology,
  listAssumableScheduleContextIds,
  scheduleContextsRouter,
} from "./schedule-contexts";
import { scheduleInvitesRouter } from "./schedule-invites";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;
type AssignmentDecisionDb = Pick<Db, "select">;

type VacancyShiftTarget = {
  id: number;
  institutionId: number;
  hospitalId: number;
  sectorId: number;
  scheduleContextId: number | null;
  specialty: string | null;
  status: string;
  startAt: Date;
  endAt: Date;
};

type AssignmentDecisionTarget = {
  assignmentId: number;
  shiftInstanceId: number;
  institutionId: number;
  hospitalId: number;
  sectorId: number;
  scheduleContextId: number | null;
  professionalId: number;
  status: string;
  isActive: boolean;
  specialty: string | null;
  startAt: Date;
  endAt: Date;
};

async function requireCanonicalVacancyShiftTarget(
  db: AssignmentDecisionDb,
  shiftInstanceId: number,
  institutionId: number,
  lockForUpdate = false,
): Promise<VacancyShiftTarget> {
  const query = db
    .select({
      id: shiftInstances.id,
      institutionId: shiftInstances.institutionId,
      hospitalId: shiftInstances.hospitalId,
      sectorId: shiftInstances.sectorId,
      scheduleContextId: shiftInstances.scheduleContextId,
      specialty: shiftInstances.specialty,
      status: shiftInstances.status,
      startAt: shiftInstances.startAt,
      endAt: shiftInstances.endAt,
    })
    .from(shiftInstances)
    .where(
      and(
        eq(shiftInstances.id, shiftInstanceId),
        eq(shiftInstances.institutionId, institutionId),
      ),
    )
    .limit(1);
  const rows = lockForUpdate ? await query.for("update") : await query;
  const shift = rows[0];
  if (!shift) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Turno inexistente ou fora da topologia do tenant ativo.",
    });
  }
  await assertInstitutionHierarchy(
    {
      institutionId: shift.institutionId,
      hospitalId: shift.hospitalId,
      sectorId: shift.sectorId,
    },
    { db, lockForShare: lockForUpdate },
  );
  await assertActiveScheduleContextTopology({
    institutionId: shift.institutionId,
    hospitalId: shift.hospitalId,
    sectorId: shift.sectorId,
    scheduleContextId: shift.scheduleContextId,
    db,
  });
  return shift;
}

function assertSameVacancyShiftTarget(
  authorized: VacancyShiftTarget,
  locked: VacancyShiftTarget,
): void {
  if (authorized.status !== locked.status) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "Este plantão acabou de ser assumido por outro profissional.",
    });
  }
  if (
    authorized.id !== locked.id ||
    authorized.institutionId !== locked.institutionId ||
    authorized.hospitalId !== locked.hospitalId ||
    authorized.sectorId !== locked.sectorId ||
    authorized.scheduleContextId !== locked.scheduleContextId ||
    authorized.specialty !== locked.specialty ||
    authorized.startAt.getTime() !== locked.startAt.getTime() ||
    authorized.endAt.getTime() !== locked.endAt.getTime()
  ) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "O turno mudou enquanto a candidatura era processada.",
    });
  }
}

/**
 * Resolve a alocação pela topologia canônica, não pelas FKs isoladas e
 * duplicadas do assignment. Uma linha contaminada A→turno B deixa de ser
 * alvo válido antes de RBAC, recompute ou auditoria.
 */
async function requireCanonicalAssignmentDecisionTarget(
  db: AssignmentDecisionDb,
  assignmentId: number,
  institutionId: number,
  lockForUpdate = false,
  expectedShiftInstanceId?: number,
): Promise<AssignmentDecisionTarget> {
  if (lockForUpdate) {
    if (expectedShiftInstanceId === undefined) {
      throw new Error(
        "expectedShiftInstanceId is required for an assignment lock",
      );
    }
    const [shift] = await db
      .select({
        id: shiftInstances.id,
        institutionId: shiftInstances.institutionId,
        hospitalId: shiftInstances.hospitalId,
        sectorId: shiftInstances.sectorId,
        scheduleContextId: shiftInstances.scheduleContextId,
        specialty: shiftInstances.specialty,
        startAt: shiftInstances.startAt,
        endAt: shiftInstances.endAt,
      })
      .from(shiftInstances)
      .where(
        and(
          eq(shiftInstances.id, expectedShiftInstanceId),
          eq(shiftInstances.institutionId, institutionId),
        ),
      )
      .limit(1)
      .for("update");
    if (!shift) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "O turno da alocação mudou enquanto a decisão era processada.",
      });
    }
    const [assignment] = await db
      .select({
        assignmentId: shiftAssignmentsV2.id,
        shiftInstanceId: shiftAssignmentsV2.shiftInstanceId,
        institutionId: shiftAssignmentsV2.institutionId,
        hospitalId: shiftAssignmentsV2.hospitalId,
        sectorId: shiftAssignmentsV2.sectorId,
        professionalId: shiftAssignmentsV2.professionalId,
        status: shiftAssignmentsV2.status,
        isActive: shiftAssignmentsV2.isActive,
      })
      .from(shiftAssignmentsV2)
      .where(
        and(
          eq(shiftAssignmentsV2.id, assignmentId),
          eq(shiftAssignmentsV2.institutionId, institutionId),
          eq(shiftAssignmentsV2.shiftInstanceId, expectedShiftInstanceId),
        ),
      )
      .limit(1)
      .for("update");
    if (
      !assignment ||
      assignment.institutionId !== shift.institutionId ||
      assignment.hospitalId !== shift.hospitalId ||
      assignment.sectorId !== shift.sectorId
    ) {
      throw new TRPCError({
        code: "CONFLICT",
        message:
          "A alocação mudou ou saiu da topologia do turno durante a decisão.",
      });
    }
    await assertInstitutionHierarchy(
      {
        institutionId: shift.institutionId,
        hospitalId: shift.hospitalId,
        sectorId: shift.sectorId,
      },
      { db, lockForShare: true },
    );
    return {
      ...assignment,
      scheduleContextId: shift.scheduleContextId,
      specialty: shift.specialty,
      startAt: shift.startAt,
      endAt: shift.endAt,
    };
  }

  const query = db
    .select({
      assignmentId: shiftAssignmentsV2.id,
      shiftInstanceId: shiftAssignmentsV2.shiftInstanceId,
      institutionId: shiftAssignmentsV2.institutionId,
      hospitalId: shiftAssignmentsV2.hospitalId,
      sectorId: shiftAssignmentsV2.sectorId,
      scheduleContextId: shiftInstances.scheduleContextId,
      professionalId: shiftAssignmentsV2.professionalId,
      status: shiftAssignmentsV2.status,
      isActive: shiftAssignmentsV2.isActive,
      specialty: shiftInstances.specialty,
      startAt: shiftInstances.startAt,
      endAt: shiftInstances.endAt,
    })
    .from(shiftAssignmentsV2)
    .innerJoin(
      shiftInstances,
      and(
        eq(shiftInstances.id, shiftAssignmentsV2.shiftInstanceId),
        eq(shiftInstances.institutionId, shiftAssignmentsV2.institutionId),
        eq(shiftInstances.hospitalId, shiftAssignmentsV2.hospitalId),
        eq(shiftInstances.sectorId, shiftAssignmentsV2.sectorId),
      ),
    )
    .where(
      and(
        eq(shiftAssignmentsV2.id, assignmentId),
        eq(shiftAssignmentsV2.institutionId, institutionId),
      ),
    )
    .limit(1);

  const [target] = await query;
  if (!target) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Alocação inexistente ou fora da topologia do tenant ativo.",
    });
  }
  await assertInstitutionHierarchy(
    {
      institutionId: target.institutionId,
      hospitalId: target.hospitalId,
      sectorId: target.sectorId,
    },
    { db },
  );
  return target;
}

function assertSameDecisionTarget(
  authorized: AssignmentDecisionTarget,
  locked: AssignmentDecisionTarget,
): void {
  if (
    authorized.shiftInstanceId !== locked.shiftInstanceId ||
    authorized.institutionId !== locked.institutionId ||
    authorized.hospitalId !== locked.hospitalId ||
    authorized.sectorId !== locked.sectorId ||
    authorized.scheduleContextId !== locked.scheduleContextId ||
    authorized.professionalId !== locked.professionalId ||
    authorized.specialty !== locked.specialty ||
    authorized.startAt.getTime() !== locked.startAt.getTime() ||
    authorized.endAt.getTime() !== locked.endAt.getTime()
  ) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "A alocação mudou enquanto a decisão era processada.",
    });
  }
}

const shiftAssignmentsRouter = router({
  // Assumir vaga (USER solicita alocação PENDENTE)
  assumeVacancy: protectedProcedure
    .input(
      z.object({
        shiftInstanceId: z.number(),
        assignmentType: z
          .enum(["ON_DUTY", "BACKUP", "ON_CALL"])
          .default("ON_DUTY"),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const userId = ctx.user?.id;
      if (!userId) throw new Error("Autenticação necessária");
      const actor = await getTenantActorFromContext(ctx);
      const professionalId = actor.professionalId;
      if (!professionalId) throw new Error("Profissional não encontrado");

      const shift = await requireCanonicalVacancyShiftTarget(
        db,
        input.shiftInstanceId,
        ctx.institutionId,
      );

      if (shift.status !== "VAGO") {
        throw new Error(`Turno não está disponível (status: ${shift.status})`);
      }

      // Transação + guarda otimista: dois médicos assumindo a mesma vaga
      // ao mesmo tempo → o UPDATE condicional (status ainda VAGO) é a
      // trava; quem perde recebe CONFLICT e nada fica pela metade.
      const assignmentId = await db.transaction(async (tx) => {
        // A leitura com FOR UPDATE e as escritas compartilham a mesma
        // transação. Um lockMonth concorrente conclui antes e bloqueia esta
        // candidatura, ou espera toda a candidatura (inclusive auditoria).
        await assertMonthNotLockedForUpdate(
          tx,
          shift.institutionId,
          shift.hospitalId,
          shift.startAt,
        );
        const lockedShift = await requireCanonicalVacancyShiftTarget(
          tx,
          input.shiftInstanceId,
          ctx.institutionId,
          true,
        );
        assertSameVacancyShiftTarget(shift, lockedShift);

        await assertAssignmentWritesAllowedForUpdate(tx, [
          {
            professionalId,
            expectedUserId: userId,
            expectedSessionVersion: ctx.user.sessionVersion,
            institutionId: lockedShift.institutionId,
            hospitalId: lockedShift.hospitalId,
            sectorId: lockedShift.sectorId,
            scheduleContextId: lockedShift.scheduleContextId,
            startAt: lockedShift.startAt,
            endAt: lockedShift.endAt,
            requiredSpecialty: lockedShift.specialty,
          },
        ]);
        await assertShiftAssignmentCapacityForUpdate(tx, {
          shiftInstanceId: lockedShift.id,
          institutionId: lockedShift.institutionId,
          hospitalId: lockedShift.hospitalId,
          sectorId: lockedShift.sectorId,
          activeDelta: 1,
          expectedCurrentActiveCount: 0,
        });

        const [claimed] = await tx
          .update(shiftInstances)
          .set({ status: "PENDENTE" })
          .where(
            and(
              eq(shiftInstances.id, input.shiftInstanceId),
              eq(shiftInstances.institutionId, lockedShift.institutionId),
              eq(shiftInstances.hospitalId, lockedShift.hospitalId),
              eq(shiftInstances.sectorId, lockedShift.sectorId),
              eq(shiftInstances.status, "VAGO"),
            ),
          );
        if (!claimed.affectedRows) {
          throw new TRPCError({
            code: "CONFLICT",
            message:
              "Este plantão acabou de ser assumido por outro profissional.",
          });
        }
        const [result] = await tx.insert(shiftAssignmentsV2).values({
          shiftInstanceId: input.shiftInstanceId,
          institutionId: lockedShift.institutionId,
          hospitalId: lockedShift.hospitalId,
          sectorId: lockedShift.sectorId,
          professionalId,
          assignmentType: input.assignmentType,
          status: "PENDENTE",
          isActive: true,
          createdBy: userId,
        });
        const createdAssignmentId = Number(result.insertId);
        await auditLog(
          {
            event: "VACANCY_REQUESTED",
            shiftInstanceId: input.shiftInstanceId,
            institutionId: lockedShift.institutionId,
            professionalId,
            metadata: {
              assignmentId: createdAssignmentId,
              assignmentType: input.assignmentType,
              userId,
            },
          },
          { db: tx },
        );
        return createdAssignmentId;
      }, ASSIGNMENT_WRITE_TRANSACTION_CONFIG);

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
    const actor = await getTenantActorFromContext(ctx);
    if (!actor.professionalId) return [];

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
          JOIN shift_instances si ON si.id = sa.shift_instance_id
            AND si.institution_id = sa.institution_id
            AND si.hospital_id = sa.hospital_id
            AND si.sector_id = sa.sector_id
          JOIN hospitals h ON h.id = si.hospital_id
            AND h.institution_id = si.institution_id
          JOIN sectors s ON s.id = si.sector_id
            AND s.institution_id = si.institution_id
            AND s.hospital_id = si.hospital_id
          JOIN professionals p ON p.id = sa.professional_id
          JOIN professional_institutions pi ON pi.professional_id = p.id
            AND pi.user_id = p.user_id
            AND pi.institution_id = sa.institution_id
            AND pi.active = true
          JOIN users u ON u.id = p.user_id
            AND u.approval_status = 'APPROVED'
            AND u.deleted_at IS NULL
          WHERE sa.institution_id = ${ctx.institutionId}
            AND si.institution_id = ${ctx.institutionId}
            AND sa.professional_id = ${actor.professionalId}
            AND p.user_id = ${userId}
            AND sa.created_by = ${userId}
            AND sa.status IN ('PENDENTE', 'OCUPADO', 'REJEITADO')
          ORDER BY sa.created_at DESC, si.start_at ASC`,
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
      coverageType: (r.coverageType ?? null) as
        "URGENCIA_EMERGENCIA" | "ELETIVAS" | null,
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
      z
        .object({
          hospitalId: z.number().optional(),
          sectorId: z.number().optional(),
          date: z.string().optional(),
          shiftLabel: z.string().nullish(),
          modality: z.enum(["PLANTAO", "SOBREAVISO"]).optional(),
          coverageType: z.enum(["URGENCIA_EMERGENCIA", "ELETIVAS"]).optional(),
        })
        .optional(),
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
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Apenas gestores podem listar solicitações pendentes.",
        });
      }
      let scopeWhere = sql``;
      const isLocalManager =
        !actor.isGlobalAdmin && actor.roleInInstitution === "GESTOR_MEDICO";
      if (isLocalManager) {
        if (!actor.professionalId) return [];
        const scopeRows = rowsFromExecute<{
          hospital_id: number;
          sector_id: number | null;
        }>(
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
            JOIN shift_instances si ON si.id = sa.shift_instance_id
              AND si.institution_id = sa.institution_id
              AND si.hospital_id = sa.hospital_id
              AND si.sector_id = sa.sector_id
            JOIN hospitals h ON h.id = si.hospital_id
              AND h.institution_id = si.institution_id
            JOIN sectors s ON s.id = si.sector_id
              AND s.institution_id = si.institution_id
              AND s.hospital_id = si.hospital_id
            JOIN professionals p ON p.id = sa.professional_id
            JOIN professional_institutions pi ON pi.professional_id = p.id
              AND pi.user_id = p.user_id
              AND pi.institution_id = si.institution_id
              AND pi.active = true
            JOIN users u ON u.id = p.user_id
              AND u.approval_status = 'APPROVED'
              AND u.deleted_at IS NULL
            WHERE sa.is_active = true
              AND sa.institution_id = ${ctx.institutionId}
              AND si.institution_id = ${ctx.institutionId}
              AND sa.status = 'PENDENTE'
              ${scopeWhere}
              ${input?.hospitalId ? sql`AND si.hospital_id = ${input.hospitalId}` : sql``}
              ${input?.sectorId ? sql`AND si.sector_id   = ${input.sectorId}` : sql``}
              ${input?.shiftLabel ? sql`AND si.label       = ${input.shiftLabel}` : sql``}
              ${input?.modality ? sql`AND si.modality    = ${input.modality}` : sql``}
              ${input?.coverageType ? sql`AND si.coverage_type = ${input.coverageType}` : sql``}
              ${startOfDay && endOfDay ? sql`AND si.start_at >= ${startOfDay} AND si.start_at < ${endOfDay}` : sql``}
            ORDER BY si.start_at ASC`,
      );

      const data = (rows as any)[0];
      return (data as any[]).map((r) => ({
        assignmentId: r.assignmentId as number,
        professionalId: r.professionalId as number,
        professionalName: r.professionalName as string,
        professionalRole: r.professionalRole as string,
        sectorId: r.sectorId as number,
        sectorName: r.sectorName as string,
        shiftInstanceId: r.shiftInstanceId as number,
        shiftLabel: r.shiftLabel as string,
        shiftStartAt: new Date(r.shiftStartAt),
        shiftEndAt: new Date(r.shiftEndAt),
        assignmentType: r.assignmentType as string,
        status: r.status as string,
        hospitalId: r.hospitalId as number,
        // Modalidade do shift subjacente (PR #61). Mesmas colunas que
        // shiftInstances.listVacancies expõe, pra a UI de Solicitações
        // poder filtrar e renderizar consistentemente.
        modality: r.modality as "PLANTAO" | "SOBREAVISO",
        coverageType: (r.coverageType ?? null) as
          "URGENCIA_EMERGENCIA" | "ELETIVAS" | null,
        paymentModel: r.paymentModel as
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
    .input(
      z.object({
        assignmentId: z.number(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const userId = ctx.user?.id;
      if (!userId) throw new Error("Autenticação necessária");

      const assignment = await requireCanonicalAssignmentDecisionTarget(
        db,
        input.assignmentId,
        ctx.institutionId,
      );

      const actor = await getTenantActorFromContext(ctx);
      assertCanManageInstitutionSchedule(actor);
      await assertManagerScopeAccess(
        actor,
        assignment.hospitalId,
        assignment.sectorId,
      );

      const managerProfessionalId = actor.professionalId;
      if (!managerProfessionalId) {
        throw new Error("Profissional do aprovador não encontrado");
      }

      assertCanEditScheduleDate(actor, assignment.startAt);

      // Transação + guarda: aprovar duas vezes (dois gestores, duplo clique)
      // não pode gerar efeito duplo; o status do turno é derivado das
      // alocações ativas em vez de setado à mão.
      // Só uma alocação ATIVA e PENDENTE pode ser aprovada. Sem `isActive`
      // no WHERE, um clique em tela desatualizada reativava uma alocação já
      // rejeitada/removida e o turno ficava com dois titulares (auditoria
      // 22/08, achado A3).
      await db.transaction(async (tx) => {
        await assertMonthNotLockedForUpdate(
          tx,
          assignment.institutionId,
          assignment.hospitalId,
          assignment.startAt,
        );
        const lockedAssignment = await requireCanonicalAssignmentDecisionTarget(
          tx,
          input.assignmentId,
          ctx.institutionId,
          true,
          assignment.shiftInstanceId,
        );
        assertSameDecisionTarget(assignment, lockedAssignment);
        await assertAssignmentWritesAllowedForUpdate(
          tx,
          [
            {
              professionalId: lockedAssignment.professionalId,
              institutionId: lockedAssignment.institutionId,
              hospitalId: lockedAssignment.hospitalId,
              sectorId: lockedAssignment.sectorId,
              scheduleContextId: lockedAssignment.scheduleContextId,
              startAt: lockedAssignment.startAt,
              endAt: lockedAssignment.endAt,
              requiredSpecialty: lockedAssignment.specialty,
              excludeAssignmentIds: [lockedAssignment.assignmentId],
            },
          ],
          { additionalProfessionalIds: [managerProfessionalId] },
        );
        await assertManagerScopeAccessForUpdate(
          tx,
          actor,
          ctx.user.sessionVersion,
          lockedAssignment.hospitalId,
          lockedAssignment.sectorId,
          [lockedAssignment.startAt],
        );
        await assertShiftAssignmentCapacityForUpdate(tx, {
          shiftInstanceId: lockedAssignment.shiftInstanceId,
          institutionId: lockedAssignment.institutionId,
          hospitalId: lockedAssignment.hospitalId,
          sectorId: lockedAssignment.sectorId,
          activeDelta: 0,
        });

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
        await auditLog(
          {
            event: "ASSIGNMENT_APPROVED",
            shiftInstanceId: assignment.shiftInstanceId,
            institutionId: assignment.institutionId,
            professionalId: managerProfessionalId,
            metadata: { assignmentId: input.assignmentId, approvedBy: userId },
          },
          { db: tx },
        );
        await recordAudit(
          {
            actorUserId: userId,
            actorRole: actor.roleInInstitution,
            actorName: ctx.user.name ?? undefined,
            action: "ASSIGNMENT_APPROVED",
            entityType: "SHIFT_ASSIGNMENT",
            entityId: input.assignmentId,
            description: "Alocação aprovada",
            institutionId: assignment.institutionId,
            shiftInstanceId: assignment.shiftInstanceId,
            hospitalId: assignment.hospitalId,
            sectorId: assignment.sectorId,
          },
          { db: tx, strict: true },
        );
      }, ASSIGNMENT_WRITE_TRANSACTION_CONFIG);

      return { ok: true };
    }),

  // Rejeitar alocação pendente
  rejectAssignment: protectedProcedure
    .input(
      z.object({
        assignmentId: z.number(),
        reason: z.string().optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const userId = ctx.user?.id;
      if (!userId) throw new Error("Autenticação necessária");

      const assignment = await requireCanonicalAssignmentDecisionTarget(
        db,
        input.assignmentId,
        ctx.institutionId,
      );

      const actor = await getTenantActorFromContext(ctx);
      assertCanManageInstitutionSchedule(actor);
      await assertManagerScopeAccess(
        actor,
        assignment.hospitalId,
        assignment.sectorId,
      );

      const managerProfessionalId = actor.professionalId;
      if (!managerProfessionalId) {
        throw new Error("Profissional do aprovador não encontrado");
      }

      assertCanEditScheduleDate(actor, assignment.startAt);

      // Transação + guarda (só alocação ativa) + status do turno DERIVADO
      // das alocações restantes: rejeitar Y não pode esvaziar um turno em
      // que X continua ativo (auditoria 22/08, achado A4).
      await db.transaction(async (tx) => {
        await assertMonthNotLockedForUpdate(
          tx,
          assignment.institutionId,
          assignment.hospitalId,
          assignment.startAt,
        );
        const lockedAssignment = await requireCanonicalAssignmentDecisionTarget(
          tx,
          input.assignmentId,
          ctx.institutionId,
          true,
          assignment.shiftInstanceId,
        );
        assertSameDecisionTarget(assignment, lockedAssignment);
        await assertManagerScopeAccessForUpdate(
          tx,
          actor,
          ctx.user.sessionVersion,
          lockedAssignment.hospitalId,
          lockedAssignment.sectorId,
          [lockedAssignment.startAt],
        );

        const [rejected] = await tx
          .update(shiftAssignmentsV2)
          .set({ isActive: false, status: "REJEITADO" })
          .where(
            and(
              eq(shiftAssignmentsV2.id, input.assignmentId),
              eq(shiftAssignmentsV2.isActive, true),
              eq(shiftAssignmentsV2.status, "PENDENTE"),
            ),
          );
        if (!rejected.affectedRows) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "Esta alocação já foi respondida ou removida.",
          });
        }
        await recomputeShiftStatus(tx, assignment.shiftInstanceId);
        await auditLog(
          {
            event: "ASSIGNMENT_REJECTED",
            shiftInstanceId: assignment.shiftInstanceId,
            institutionId: assignment.institutionId,
            professionalId: managerProfessionalId,
            reason: input.reason ?? null,
            metadata: { assignmentId: input.assignmentId, rejectedBy: userId },
          },
          { db: tx },
        );
        await recordAudit(
          {
            actorUserId: userId,
            actorRole: actor.roleInInstitution,
            actorName: ctx.user.name ?? undefined,
            action: "ASSIGNMENT_REJECTED",
            entityType: "SHIFT_ASSIGNMENT",
            entityId: input.assignmentId,
            description:
              "Alocação rejeitada" + (input.reason ? ": " + input.reason : ""),
            institutionId: assignment.institutionId,
            shiftInstanceId: assignment.shiftInstanceId,
            hospitalId: assignment.hospitalId,
            sectorId: assignment.sectorId,
          },
          { db: tx, strict: true },
        );
      });

      return { ok: true };
    }),

  // List vacancies with enriched data (sector + hospital + modality).
  // PR #61 added modality / coverageType / paymentModel / productivityCapBrl
  // on shift_instances; this endpoint surfaces them for the Plantões em
  // aberto screen (and any radar filtering by modality).
  listVacancies: protectedProcedure
    .input(
      z
        .object({
          hospitalId: z.number().optional(),
          sectorId: z.number().optional(),
          date: z.string().optional(),
          shiftLabel: z.string().nullish(),
          modality: z.enum(["PLANTAO", "SOBREAVISO"]).optional(),
          coverageType: z.enum(["URGENCIA_EMERGENCIA", "ELETIVAS"]).optional(),
        })
        .optional(),
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

      // Radar é uma lista de ações possíveis: exige professional_access e
      // qualificação canônica exata do contexto (ID CFM ou perfil).
      const actor = await getTenantActorFromContext(ctx);
      if (!actor.professionalId) return [];
      const assumableContextIds = new Set(
        await listAssumableScheduleContextIds(
          ctx.institutionId,
          actor.professionalId,
          db,
        ),
      );
      if (assumableContextIds.size === 0) return [];

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
              si.sector_id   AS sectorId,
              si.schedule_context_id AS scheduleContextId
            FROM shift_instances si
            JOIN hospitals h ON h.id = si.hospital_id
              AND h.institution_id = si.institution_id
            JOIN sectors s ON s.id = si.sector_id
              AND s.institution_id = si.institution_id
              AND s.hospital_id = si.hospital_id
            JOIN schedule_contexts sc ON sc.id = si.schedule_context_id
              AND sc.institution_id = si.institution_id
              AND sc.hospital_id = si.hospital_id
              AND sc.sector_id = si.sector_id
              AND sc.active = true
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
              ${input?.sectorId ? sql`AND si.sector_id   = ${input.sectorId}` : sql``}
              ${input?.shiftLabel ? sql`AND si.label       = ${input.shiftLabel}` : sql``}
              ${input?.modality ? sql`AND si.modality    = ${input.modality}` : sql``}
              ${input?.coverageType ? sql`AND si.coverage_type = ${input.coverageType}` : sql``}
              ${startOfDay && endOfDay ? sql`AND si.start_at >= ${startOfDay} AND si.start_at < ${endOfDay}` : sql``}
            ORDER BY si.start_at ASC`,
      );

      const data = rowsFromExecute<any>(rows).filter((row) =>
        assumableContextIds.has(Number(row.scheduleContextId)),
      );

      const alreadyRequestedIds = new Set<number>();
      if (actor.professionalId) {
        const existing = await db
          .select({ shiftInstanceId: shiftAssignmentsV2.shiftInstanceId })
          .from(shiftAssignmentsV2)
          .innerJoin(
            shiftInstances,
            and(
              eq(shiftInstances.id, shiftAssignmentsV2.shiftInstanceId),
              eq(
                shiftInstances.institutionId,
                shiftAssignmentsV2.institutionId,
              ),
              eq(shiftInstances.hospitalId, shiftAssignmentsV2.hospitalId),
              eq(shiftInstances.sectorId, shiftAssignmentsV2.sectorId),
            ),
          )
          .where(
            and(
              eq(shiftAssignmentsV2.institutionId, ctx.institutionId),
              eq(shiftInstances.institutionId, ctx.institutionId),
              eq(shiftAssignmentsV2.professionalId, actor.professionalId),
              eq(shiftAssignmentsV2.isActive, true),
            ),
          );
        for (const e of existing) alreadyRequestedIds.add(e.shiftInstanceId);
      }

      return data
        .filter((r) => !alreadyRequestedIds.has(Number(r.shiftInstanceId)))
        .map((r) => ({
          shiftInstanceId: r.shiftInstanceId as number,
          startAt: new Date(r.startAt),
          endAt: new Date(r.endAt),
          label: r.label as string,
          status: r.status as string,
          sectorName: r.sectorName as string,
          hospitalName: r.hospitalName as string,
          scheduleContextId: Number(r.scheduleContextId),
          canAssume: true as const,
          // Modalidade (PR #61). Tipos vêm como string do mysql2; expõe
          // direto pra o cliente formatar com os labels PT-BR.
          modality: r.modality as "PLANTAO" | "SOBREAVISO",
          coverageType: (r.coverageType ?? null) as
            "URGENCIA_EMERGENCIA" | "ELETIVAS" | null,
          paymentModel: r.paymentModel as
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
  shiftInstances: shiftInstancesRouter,
  editor: editorRouter,
  calendar: calendarRouter,
  shifts: shiftsRouter,
  professionals: professionalsRouter,
  hospitals: hospitalsRouter,
  sectors: sectorsRouter,
  filters: filtersRouter,
  swaps: swapRouter,
  audit: auditRouter,
  confirmations: confirmationRouter,
  voice: voiceRouter,
  scheduleContexts: scheduleContextsRouter,
  scheduleInvites: scheduleInvitesRouter,
});

export type AppRouter = typeof appRouter;

import { z } from "zod";
import { router, protectedProcedure } from "./_core/trpc";
import { TRPCError } from "@trpc/server";
import { getDb } from "./db";
import { sql } from "drizzle-orm";
import { getTenantActorFromContext } from "./_core/policy";

/**
 * Audit Router — leitura da trilha de auditoria de movimentações de
 * plantão. O lado de escrita é `recordAudit()` em server/audit-trail.ts,
 * já wirado em todas as mutações relevantes.
 *
 * Demanda: gestor precisa ver "quem alterou o plantão / quem foram
 * os alterados / quando foi feita a alteração".
 *
 * Modelo de acesso:
 *   - GESTOR_PLUS / admin → vê toda a instituição.
 *   - GESTOR_MEDICO → vê apenas eventos no seu manager_scope (hospital
 *     ou setor jurisdicionado). Aplicado via WHERE em hospitalId/sectorId.
 *   - USER → vê apenas eventos onde foi actor, fromProfessional ou
 *     toProfessional (movimentações sobre o próprio plantão dele).
 *
 * Filtros disponíveis:
 *   - shiftInstanceId: zoom em um plantão específico
 *   - fromDate / toDate: período (default: últimos 30 dias)
 *   - hospitalId, sectorId: para gestor que quer scope mais estreito
 *     do que o default
 *   - actions: subset de eventos (ex.: só CESSAO_*)
 *
 * Output: rows enriquecidas com nomes de profissionais (from/to) e
 * label PT-BR do evento, prontas para renderizar timeline.
 */

const ACTION_LABEL: Record<string, string> = {
  SHIFT_CREATED: "Plantão criado",
  SHIFT_UPDATED: "Plantão editado",
  SHIFT_DELETED: "Plantão removido",
  ASSIGNMENT_CREATED: "Profissional alocado diretamente",
  ASSIGNMENT_REMOVED: "Alocação removida",
  ASSIGNMENT_ASSUMED_VACANCY: "Profissional assumiu vaga",
  ASSIGNMENT_APPROVED: "Alocação aprovada",
  ASSIGNMENT_REJECTED: "Alocação rejeitada",
  SWAP_REQUESTED: "Troca solicitada",
  SWAP_ACCEPTED: "Troca aceita",
  SWAP_REJECTED: "Troca recusada",
  SWAP_APPROVED_BY_MANAGER: "Troca aprovada (gestor)",
  SWAP_APPROVED_BY_OWNER: "Troca aprovada (dono)",
  SWAP_CANCELLED: "Troca cancelada",
  TRANSFER_OFFERED: "Repasse oferecido",
  TRANSFER_ACCEPTED: "Repasse aceito",
  TRANSFER_REJECTED: "Repasse recusado",
  TRANSFER_APPROVED_BY_MANAGER: "Repasse aprovado (gestor)",
  TRANSFER_APPROVED_BY_OWNER: "Repasse aprovado (dono)",
  TRANSFER_CANCELLED: "Repasse cancelado",
  CESSAO_OFFERED: "Cessão oferecida",
  CESSAO_ACCEPTED: "Cessão aceita pelo candidato",
  CESSAO_REJECTED: "Cessão recusada",
  CESSAO_APPROVED_BY_OWNER: "Cessão aprovada pelo dono",
  CESSAO_CANCELLED: "Cessão cancelada",
};

// Subset focado em movimentação de plantão. Eventos de roster, user
// management e segurança ficam fora do default — quem precisar dele
// pede via `actions: [...]` explicitamente.
const SHIFT_MOVEMENT_ACTIONS = [
  "SHIFT_CREATED",
  "SHIFT_UPDATED",
  "SHIFT_DELETED",
  "ASSIGNMENT_CREATED",
  "ASSIGNMENT_REMOVED",
  "ASSIGNMENT_ASSUMED_VACANCY",
  "ASSIGNMENT_APPROVED",
  "ASSIGNMENT_REJECTED",
  "SWAP_REQUESTED",
  "SWAP_ACCEPTED",
  "SWAP_REJECTED",
  "SWAP_APPROVED_BY_MANAGER",
  "SWAP_APPROVED_BY_OWNER",
  "SWAP_CANCELLED",
  "TRANSFER_OFFERED",
  "TRANSFER_ACCEPTED",
  "TRANSFER_REJECTED",
  "TRANSFER_APPROVED_BY_MANAGER",
  "TRANSFER_APPROVED_BY_OWNER",
  "TRANSFER_CANCELLED",
  "CESSAO_OFFERED",
  "CESSAO_ACCEPTED",
  "CESSAO_REJECTED",
  "CESSAO_APPROVED_BY_OWNER",
  "CESSAO_CANCELLED",
] as const;

export const auditRouter = router({
  listShiftMovements: protectedProcedure
    .input(
      z.object({
        shiftInstanceId: z.number().int().optional(),
        hospitalId: z.number().int().optional(),
        sectorId: z.number().int().optional(),
        fromDate: z.string().optional(), // ISO date YYYY-MM-DD
        toDate: z.string().optional(),
        actions: z.array(z.string()).optional(),
        limit: z.number().min(1).max(500).default(100),
        offset: z.number().min(0).default(0),
      }).optional(),
    )
    .query(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      }

      const userId = ctx.user!.id;
      const institutionId = ctx.institutionId;
      const actor = await getTenantActorFromContext(ctx);

      const isInstitutionWide =
        actor.isGlobalAdmin || actor.roleInInstitution === "GESTOR_PLUS";
      const isLocalManager = actor.roleInInstitution === "GESTOR_MEDICO";
      // USER só vê o que envolve a si próprio.

      // Default: últimos 30 dias.
      const now = new Date();
      const defaultFrom = new Date(now);
      defaultFrom.setDate(defaultFrom.getDate() - 30);
      const fromDate = input?.fromDate
        ? new Date(`${input.fromDate}T00:00:00`)
        : defaultFrom;
      const toDate = input?.toDate
        ? new Date(`${input.toDate}T23:59:59`)
        : now;

      const actionsFilter =
        input?.actions && input.actions.length > 0
          ? input.actions
          : SHIFT_MOVEMENT_ACTIONS;

      // Manager scope rows — collect upfront se necessário pra GESTOR_MEDICO.
      let managerScopeWhere = sql``;
      if (isLocalManager && actor.professionalId) {
        const scopes = await db.execute<any>(
          sql`SELECT hospital_id, sector_id FROM manager_scope
              WHERE manager_professional_id = ${actor.professionalId}
                AND institution_id = ${institutionId}
                AND active = 1`,
        );
        const scopeRows = (scopes as any)[0] as Array<{ hospital_id: number; sector_id: number | null }>;
        if (scopeRows.length === 0) {
          // Gestor sem scope ativo: trata como USER.
          return [];
        }
        // Constrói OR de (hospitalId, sectorId) — null sectorId = hospital inteiro.
        const conditions = scopeRows.map((s) =>
          s.sector_id == null
            ? sql`(at.hospital_id = ${s.hospital_id})`
            : sql`(at.hospital_id = ${s.hospital_id} AND at.sector_id = ${s.sector_id})`,
        );
        const orList = sql.join(conditions, sql` OR `);
        managerScopeWhere = sql`AND (${orList})`;
      }

      let userOnlyWhere = sql``;
      if (!isInstitutionWide && !isLocalManager) {
        // USER. Vê apenas eventos onde é actor / from / to.
        userOnlyWhere = sql`AND (
          at.actor_user_id = ${userId}
          OR at.from_user_id = ${userId}
          OR at.to_user_id = ${userId}
        )`;
      }

      const fromIso = fromDate.toISOString().slice(0, 19).replace("T", " ");
      const toIso = toDate.toISOString().slice(0, 19).replace("T", " ");

      const rows = await db.execute<any>(
        sql`SELECT
              at.id,
              at.action,
              at.entity_type        AS entityType,
              at.entity_id          AS entityId,
              at.description,
              at.metadata,
              at.actor_user_id      AS actorUserId,
              at.actor_role         AS actorRole,
              at.actor_name         AS actorName,
              at.from_professional_id AS fromProfessionalId,
              at.to_professional_id   AS toProfessionalId,
              at.from_user_id       AS fromUserId,
              at.to_user_id         AS toUserId,
              at.shift_instance_id  AS shiftInstanceId,
              at.hospital_id        AS hospitalId,
              at.sector_id          AS sectorId,
              at.created_at         AS createdAt,
              fp.name               AS fromProfessionalName,
              tp.name               AS toProfessionalName,
              au.name               AS actorUserName,
              au.email              AS actorUserEmail,
              h.name                AS hospitalName,
              s.name                AS sectorName,
              si.label              AS shiftLabel,
              si.start_at           AS shiftStartAt
            FROM audit_trail at
            LEFT JOIN professionals fp ON fp.id = at.from_professional_id
            LEFT JOIN professionals tp ON tp.id = at.to_professional_id
            LEFT JOIN users au         ON au.id = at.actor_user_id
            LEFT JOIN hospitals h      ON h.id  = at.hospital_id
            LEFT JOIN sectors s        ON s.id  = at.sector_id
            LEFT JOIN shift_instances si ON si.id = at.shift_instance_id
            WHERE at.institution_id = ${institutionId}
              AND at.created_at BETWEEN ${fromIso} AND ${toIso}
              AND at.action IN (${sql.join(actionsFilter.map((a) => sql`${a}`), sql`, `)})
              ${input?.shiftInstanceId ? sql`AND at.shift_instance_id = ${input.shiftInstanceId}` : sql``}
              ${input?.hospitalId ? sql`AND at.hospital_id = ${input.hospitalId}` : sql``}
              ${input?.sectorId ? sql`AND at.sector_id = ${input.sectorId}` : sql``}
              ${managerScopeWhere}
              ${userOnlyWhere}
            ORDER BY at.created_at DESC
            LIMIT ${input?.limit ?? 100}
            OFFSET ${input?.offset ?? 0}`,
      );

      const data = (rows as any)[0] as any[];

      return data.map((r) => ({
        id: r.id as number,
        action: r.action as string,
        actionLabel: ACTION_LABEL[r.action as string] ?? (r.action as string),
        entityType: r.entityType as string,
        entityId: r.entityId as number,
        description: r.description as string,
        metadata: (r.metadata ?? null) as Record<string, unknown> | null,
        actor: {
          userId: r.actorUserId as number,
          role: r.actorRole as string,
          name: (r.actorName ?? r.actorUserName ?? null) as string | null,
          email: (r.actorUserEmail ?? null) as string | null,
        },
        from:
          r.fromProfessionalId != null
            ? {
                professionalId: r.fromProfessionalId as number,
                name: (r.fromProfessionalName ?? null) as string | null,
                userId: (r.fromUserId ?? null) as number | null,
              }
            : null,
        to:
          r.toProfessionalId != null
            ? {
                professionalId: r.toProfessionalId as number,
                name: (r.toProfessionalName ?? null) as string | null,
                userId: (r.toUserId ?? null) as number | null,
              }
            : null,
        shift:
          r.shiftInstanceId != null
            ? {
                id: r.shiftInstanceId as number,
                label: (r.shiftLabel ?? null) as string | null,
                startAt: r.shiftStartAt ? new Date(r.shiftStartAt) : null,
              }
            : null,
        location: {
          hospitalId: (r.hospitalId ?? null) as number | null,
          hospitalName: (r.hospitalName ?? null) as string | null,
          sectorId: (r.sectorId ?? null) as number | null,
          sectorName: (r.sectorName ?? null) as string | null,
        },
        createdAt: new Date(r.createdAt as string | Date),
      }));
    }),
});

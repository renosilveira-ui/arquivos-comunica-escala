import { z } from "zod";
import { router, protectedProcedure } from "./_core/trpc";
import { getDb } from "./db";
import { ForbiddenError } from "../shared/_core/errors";
import { assertMonthEditable } from "./month-guards";
import { auditLog } from "./audit-log";
import { recordAudit } from "./audit-trail";
import { assertNoTimeConflictForProfessional } from "./shift-validations-v2";
import { sql } from "drizzle-orm";
import {
  assertCanEditScheduleDate,
  assertCanManageInstitutionSchedule,
  assertManagerScopeAccess,
  getTenantActorFromContext,
} from "./_core/policy";

/**
 * Editor Router
 * 
 * Endpoints para edição direta de turnos por gestores:
 * - assignDirect: gestor aloca profissional diretamente (OCUPADO)
 * - markVacant: marca turno como VAGO
 * - unassignDirect: remove alocação
 */

export const editorRouter = router({
  /**
   * assignDirect
   * Gestor aloca profissional diretamente no turno (sem candidatura)
   */
  assignDirect: protectedProcedure
    .input(
      z.object({
        shiftInstanceId: z.number(),
        professionalId: z.number(),
        assignmentType: z.enum(["ON_DUTY", "BACKUP", "ON_CALL"]),
        reason: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { shiftInstanceId, professionalId, assignmentType, reason } = input;
      const userId = ctx.user?.id;
      if (!userId) {
        throw new ForbiddenError("Autenticação necessária");
      }
      const actor = await getTenantActorFromContext(ctx);
      assertCanManageInstitutionSchedule(actor);

      const db = await getDb();
      if (!db) throw new Error("Database not available");
      const managerId = actor.professionalId;
      if (!managerId) throw new ForbiddenError("Profissional não encontrado");

      // 2. Buscar shift_instance
      const shiftResult = await db.execute<any>(
        sql`SELECT institution_id, hospital_id, sector_id, start_at, end_at, status
            FROM shift_instances
            WHERE id = ${shiftInstanceId}
            AND institution_id = ${ctx.institutionId}
            LIMIT 1`
      );
      const shiftRows = (shiftResult as any).rows || (shiftResult as any[]);
      if (!shiftRows[0]) {
        throw new Error("Turno não encontrado");
      }

      const shift = shiftRows[0];
      await assertManagerScopeAccess(actor, shift.hospital_id, shift.sector_id);
      assertCanEditScheduleDate(actor, new Date(shift.start_at));

      // 4. Verificar assertMonthEditable
      await assertMonthEditable(
        { user: { id: userId } },
        shift.institution_id,
        shift.hospital_id,
        new Date(shift.start_at),
        reason || undefined
      );

      // 5. Frente H1/H2: anti-overlap (escala-ux §8).
      // A versão antiga filtrava por `status = 'OCUPADO'`, deixando passar
      // PENDENTE e ignorando sobreaviso (ON_CALL) — exatamente o gap que a
      // frente H1/H2 fecha. `assertNoTimeConflictForProfessional` considera
      // qualquer assignment ativo independente de status/tipo.
      await assertNoTimeConflictForProfessional(
        professionalId,
        new Date(shift.start_at),
        new Date(shift.end_at),
        shiftInstanceId,
      );

      // 6. Validar limite de 20 profissionais por setor/turno
      const limitResult = await db.execute<any>(
        sql`SELECT COUNT(DISTINCT sa.professional_id) as count
            FROM shift_assignments_v2 sa
            INNER JOIN shift_instances si ON sa.shift_instance_id = si.id
            WHERE si.sector_id = ${shift.sector_id}
            AND si.start_at = ${shift.start_at}
            AND sa.is_active = true
            AND sa.status = 'OCUPADO'`
      );
      const limitRows = (limitResult as any).rows || (limitResult as any[]);
      if (limitRows[0]?.count >= 20) {
        throw new Error("Limite de 20 profissionais por turno atingido");
      }

      // 7. Verificar professional_access (TI)
      const accessResult = await db.execute<any>(
        sql`SELECT COUNT(*) as count FROM professional_access
            WHERE professional_id = ${professionalId}
            AND institution_id = ${ctx.institutionId}
            AND hospital_id = ${shift.hospital_id}
            AND (sector_id IS NULL OR sector_id = ${shift.sector_id})
            AND can_access = true`
      );
      const accessRows = (accessResult as any).rows || (accessResult as any[]);
      if (accessRows[0]?.count === 0) {
        throw new Error("Profissional não tem acesso a este hospital/setor");
      }

      // 8. Transação: INSERT assignment + UPDATE shift_instance
      await db.execute(
        sql`INSERT INTO shift_assignments_v2 
            (shift_instance_id, institution_id, hospital_id, sector_id, professional_id, assignment_type, status, is_active, created_by, created_at, updated_at)
            VALUES (${shiftInstanceId}, ${ctx.institutionId}, ${shift.hospital_id}, ${shift.sector_id}, ${professionalId}, ${assignmentType}, 'OCUPADO', true, ${userId}, NOW(), NOW())`
      );

      const assignmentIdResult = await db.execute<any>(sql`SELECT LAST_INSERT_ID() as id`);
      const assignmentIdRows = (assignmentIdResult as any).rows || (assignmentIdResult as any[]);
      const assignmentId = assignmentIdRows[0].id;

      await db.execute(
        sql`UPDATE shift_instances SET status = 'OCUPADO' WHERE id = ${shiftInstanceId} AND institution_id = ${ctx.institutionId}`
      );

      // 9. Audit log
      await auditLog({
        event: "SHIFT_ASSIGNED",
        shiftInstanceId,
        professionalId: managerId,
        reason: reason || `Alocação direta: ${assignmentType}`,
        metadata: { assignmentId, allocatedProfessionalId: professionalId, assignmentType },
      });

      recordAudit({
        action: "ASSIGNMENT_CREATED",
        entityType: "SHIFT_ASSIGNMENT",
        entityId: assignmentId,
        actorUserId: userId,
        actorRole: actor.roleInInstitution,
        description: `Alocação direta do profissional #${professionalId} no turno #${shiftInstanceId}`,
        shiftInstanceId,
        hospitalId: shift.hospital_id as number,
        sectorId: shift.sector_id as number,
        toProfessionalId: professionalId,
        metadata: { assignmentType },
      });

      return { ok: true, assignmentId };
    }),

  /**
   * markVacant
   * Marca turno como VAGO (remove assignments ativos se houver)
   */
  markVacant: protectedProcedure
    .input(
      z.object({
        shiftInstanceId: z.number(),
        reason: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { shiftInstanceId, reason } = input;
      const userId = ctx.user?.id;
      if (!userId) {
        throw new ForbiddenError("Autenticação necessária");
      }
      const actor = await getTenantActorFromContext(ctx);
      assertCanManageInstitutionSchedule(actor);

      const db = await getDb();
      if (!db) throw new Error("Database not available");
      const managerId = actor.professionalId;
      if (!managerId) throw new ForbiddenError("Profissional não encontrado");

      // 2. Buscar shift_instance
      const shiftResult = await db.execute<any>(
        sql`SELECT institution_id, hospital_id, sector_id, start_at FROM shift_instances
            WHERE id = ${shiftInstanceId}
            AND institution_id = ${ctx.institutionId}
            LIMIT 1`
      );
      const shiftRows = (shiftResult as any).rows || (shiftResult as any[]);
      if (!shiftRows[0]) {
        throw new Error("Turno não encontrado");
      }

      const shift = shiftRows[0];
      await assertManagerScopeAccess(actor, shift.hospital_id, shift.sector_id);
      assertCanEditScheduleDate(actor, new Date(shift.start_at));

      // 4. Verificar assertMonthEditable
      await assertMonthEditable(
        { user: { id: userId } },
        shift.institution_id,
        shift.hospital_id,
        new Date(shift.start_at),
        reason || undefined
      );

      // 5. Soft delete assignments ativos
      await db.execute(
        sql`UPDATE shift_assignments_v2 
            SET is_active = false, updated_at = NOW()
            WHERE shift_instance_id = ${shiftInstanceId}
            AND institution_id = ${ctx.institutionId}
            AND is_active = true`
      );

      // 6. UPDATE shift_instance para VAGO
      await db.execute(
        sql`UPDATE shift_instances SET status = 'VAGO' WHERE id = ${shiftInstanceId} AND institution_id = ${ctx.institutionId}`
      );

      // 7. Audit log
      await auditLog({
        event: "SHIFT_MARKED_VACANT",
        shiftInstanceId,
        professionalId: managerId,
        reason: reason || "Turno marcado como vago",
        metadata: {},
      });

      await recordAudit({
        actorUserId: userId,
        actorRole: actor.roleInInstitution,
        action: "ASSIGNMENT_REMOVED",
        entityType: "SHIFT_INSTANCE",
        entityId: shiftInstanceId,
        description: "Turno marcado como vago",
        shiftInstanceId,
        hospitalId: shift.hospital_id as number,
        sectorId: shift.sector_id as number,
      });

      return { ok: true };
    }),

  /**
   * unassignDirect
   * Remove alocação específica (soft delete)
   */
  unassignDirect: protectedProcedure
    .input(
      z.object({
        assignmentId: z.number(),
        reason: z.string(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { assignmentId, reason } = input;
      const userId = ctx.user?.id;
      if (!userId) {
        throw new ForbiddenError("Autenticação necessária");
      }
      const actor = await getTenantActorFromContext(ctx);
      assertCanManageInstitutionSchedule(actor);

      const db = await getDb();
      if (!db) throw new Error("Database not available");
      const managerId = actor.professionalId;
      if (!managerId) throw new ForbiddenError("Profissional não encontrado");

      // 2. Buscar assignment + shift_instance
      const assignmentResult = await db.execute<any>(
        sql`SELECT sa.shift_instance_id, sa.professional_id,
                   si.institution_id, si.hospital_id, si.sector_id, si.start_at
            FROM shift_assignments_v2 sa
            INNER JOIN shift_instances si ON sa.shift_instance_id = si.id
            WHERE sa.id = ${assignmentId}
            AND sa.institution_id = ${ctx.institutionId}
            LIMIT 1`
      );
      const assignmentRows = (assignmentResult as any).rows || (assignmentResult as any[]);
      if (!assignmentRows[0]) {
        throw new Error("Alocação não encontrada");
      }

      const assignment = assignmentRows[0];
      await assertManagerScopeAccess(actor, assignment.hospital_id, assignment.sector_id);
      assertCanEditScheduleDate(actor, new Date(assignment.start_at));

      // 4. Verificar assertMonthEditable
      await assertMonthEditable(
        { user: { id: userId } },
        assignment.institution_id,
        assignment.hospital_id,
        new Date(assignment.start_at),
        reason || undefined
      );

      // 5. Soft delete assignment
      await db.execute(
        sql`UPDATE shift_assignments_v2 
            SET is_active = false, updated_at = NOW()
            WHERE id = ${assignmentId}
            AND institution_id = ${ctx.institutionId}`
      );

      // 6. Verificar se ainda há assignments ativos no turno
      const remainingResult = await db.execute<any>(
        sql`SELECT COUNT(*) as count FROM shift_assignments_v2
            WHERE shift_instance_id = ${assignment.shift_instance_id}
            AND institution_id = ${ctx.institutionId}
            AND is_active = true
            AND status = 'OCUPADO'`
      );
      const remainingRows = (remainingResult as any).rows || (remainingResult as any[]);
      const hasRemaining = remainingRows[0]?.count > 0;

      // 7. Se não houver mais assignments, marcar turno como VAGO
      if (!hasRemaining) {
        await db.execute(
          sql`UPDATE shift_instances SET status = 'VAGO' WHERE id = ${assignment.shift_instance_id} AND institution_id = ${ctx.institutionId}`
        );
      }

      // 8. Audit log
      await auditLog({
        event: "SHIFT_UNASSIGNED",
        shiftInstanceId: assignment.shift_instance_id,
        professionalId: managerId,
        reason,
        metadata: { assignmentId, unassignedProfessionalId: assignment.professional_id },
      });

      return { ok: true };
    }),
});

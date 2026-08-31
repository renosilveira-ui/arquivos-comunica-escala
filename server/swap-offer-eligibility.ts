import { sql, type SQLWrapper } from "drizzle-orm";
import type { swapRequests } from "../drizzle/schema";
import { rowsFromExecute } from "./_core/db-results";
import {
  plantonistaAccessCoversShiftSql,
  plantonistaQualificationMatchesSql,
  plantonistaXorQualificationSql,
} from "./plantonista-shift-eligibility";

type SwapRow = typeof swapRequests.$inferSelect;

type EligibilityDb = {
  execute: (query: string | SQLWrapper) => Promise<unknown>;
};

/**
 * Destinatários de sinal de oferta = plantonistas que listAvailable
 * marcaria `canRespond: true` **sem** o atalho GESTOR_PLUS / manager_scope.
 *
 * Gestores continuam vendo e podendo aceitar na lista (SQL de
 * queryListAvailableRows). Push não os inclui só pelo papel gerencial.
 * GESTOR_MEDICO que também passa na qualificação + professional_access
 * entra aqui como médico.
 *
 * Os predicados de qualificação, acesso setorial, conflito e SWAP
 * espelham o ramo plantonista de queryListAvailableRows. XOR de
 * especialidade/perfil replica qualificationMatches (listAssumable),
 * para ninguém receber push sem aparecer com canRespond em Trocas.
 * Não reintroduzir atalho gerencial no destinatário (aliases api/ap).
 */
export async function eligibleRecipientUserIdsForSwapOffer(
  db: EligibilityDb,
  swap: Pick<
    SwapRow,
    "id" | "fromUserId" | "toUserId" | "toProfessionalId" | "institutionId"
  >,
): Promise<number[]> {
  const result = await db.execute(sql`
    SELECT DISTINCT au.id AS userId
    FROM swap_requests sr
    JOIN institutions inst
      ON inst.id = sr.institution_id
     AND inst.is_active = 1
    JOIN shift_instances fsi
      ON fsi.id = sr.from_shift_instance_id
     AND fsi.institution_id = sr.institution_id
     AND fsi.hospital_id = sr.hospital_id
     AND fsi.sector_id = sr.sector_id
    JOIN schedule_contexts fsc
      ON fsc.id = fsi.schedule_context_id
     AND fsc.institution_id = fsi.institution_id
     AND fsc.hospital_id = fsi.hospital_id
     AND fsc.sector_id = fsi.sector_id
     AND fsc.active = 1
    LEFT JOIN medical_specialties fms
      ON fms.id = fsc.medical_specialty_id
     AND fms.active = 1
    JOIN hospitals fh
      ON fh.id = fsi.hospital_id
     AND fh.institution_id = fsi.institution_id
    JOIN sectors fs
      ON fs.id = fsi.sector_id
     AND fs.institution_id = fsi.institution_id
     AND fs.hospital_id = fsi.hospital_id
    JOIN monthly_rosters fmr
      ON fmr.institution_id = fsi.institution_id
     AND fmr.hospital_id = fsi.hospital_id
     AND fmr.year_month = DATE_FORMAT(DATE_SUB(fsi.start_at, INTERVAL 3 HOUR), '%Y-%m')
     AND fmr.status = 'PUBLISHED'
    JOIN shift_assignments_v2 fsa
      ON fsa.id = sr.from_assignment_id
     AND fsa.shift_instance_id = fsi.id
     AND fsa.institution_id = fsi.institution_id
     AND fsa.hospital_id = fsi.hospital_id
     AND fsa.sector_id = fsi.sector_id
     AND fsa.professional_id = sr.from_professional_id
     AND fsa.is_active = 1
     AND fsa.status = 'OCUPADO'
    JOIN professionals fp
      ON fp.id = sr.from_professional_id
     AND fp.user_id = sr.from_user_id
    JOIN users fu
      ON fu.id = fp.user_id
     AND fu.approval_status = 'APPROVED'
     AND fu.deleted_at IS NULL
    JOIN professional_institutions fpi
      ON fpi.professional_id = fp.id
     AND fpi.user_id = fp.user_id
     AND fpi.institution_id = sr.institution_id
     AND fpi.active = 1
    JOIN professional_institutions api
      ON api.institution_id = sr.institution_id
     AND api.active = 1
     AND api.user_id != sr.from_user_id
    JOIN professionals ap
      ON ap.id = api.professional_id
     AND ap.user_id = api.user_id
    JOIN users au
      ON au.id = ap.user_id
     AND au.approval_status = 'APPROVED'
     AND au.deleted_at IS NULL
    LEFT JOIN shift_instances tsi
      ON sr.type = 'SWAP'
     AND tsi.id = sr.to_shift_instance_id
     AND tsi.institution_id = sr.institution_id
    LEFT JOIN hospitals th
      ON th.id = tsi.hospital_id
     AND th.institution_id = tsi.institution_id
    LEFT JOIN sectors ts
      ON ts.id = tsi.sector_id
     AND ts.institution_id = tsi.institution_id
     AND ts.hospital_id = tsi.hospital_id
    LEFT JOIN schedule_contexts tsc
      ON tsc.id = tsi.schedule_context_id
     AND tsc.institution_id = tsi.institution_id
     AND tsc.hospital_id = tsi.hospital_id
     AND tsc.sector_id = tsi.sector_id
     AND tsc.active = 1
    LEFT JOIN shift_assignments_v2 tsa
      ON sr.type = 'SWAP'
     AND tsa.shift_instance_id = tsi.id
     AND tsa.institution_id = tsi.institution_id
     AND tsa.hospital_id = tsi.hospital_id
     AND tsa.sector_id = tsi.sector_id
     AND tsa.professional_id = ap.id
     AND tsa.is_active = 1
     AND tsa.status = 'OCUPADO'
    WHERE sr.id = ${swap.id}
      AND sr.institution_id = ${swap.institutionId}
      AND sr.status = 'PENDING'
      AND sr.from_user_id != au.id
      AND ${plantonistaXorQualificationSql("ap")}
      AND (
        (sr.to_professional_id IS NULL AND sr.to_user_id IS NULL)
        OR (sr.to_professional_id = ap.id AND sr.to_user_id = au.id)
      )
      AND fsi.start_at > NOW()
      AND (sr.expires_at IS NULL OR sr.expires_at > NOW())
      AND NOT EXISTS (
        SELECT 1
        FROM shift_assignments_v2 source_duplicate
        WHERE source_duplicate.shift_instance_id = fsi.id
          AND source_duplicate.institution_id = fsi.institution_id
          AND source_duplicate.hospital_id = fsi.hospital_id
          AND source_duplicate.sector_id = fsi.sector_id
          AND source_duplicate.professional_id = fp.id
          AND source_duplicate.is_active = 1
          AND source_duplicate.id != fsa.id
      )
      AND (
        EXISTS (
          SELECT 1
          FROM professional_access source_access
          WHERE source_access.institution_id = fsi.institution_id
            AND source_access.professional_id = fp.id
            AND source_access.hospital_id = fsi.hospital_id
            AND source_access.can_access = 1
            AND (
              (
                fsc.admission_policy = 'QUALIFICATION_ALLOWLIST'
                AND source_access.sector_id = fsi.sector_id
              )
              OR
              (
                fsc.admission_policy <> 'QUALIFICATION_ALLOWLIST'
                AND (source_access.sector_id IS NULL OR source_access.sector_id = fsi.sector_id)
              )
            )
        )
        OR fpi.role_in_institution = 'GESTOR_PLUS'
        OR EXISTS (
          SELECT 1
          FROM manager_scope source_scope
          WHERE source_scope.manager_professional_id = fp.id
            AND source_scope.institution_id = fsi.institution_id
            AND source_scope.hospital_id = fsi.hospital_id
            AND (source_scope.sector_id IS NULL OR source_scope.sector_id = fsi.sector_id)
            AND source_scope.active = 1
        )
      )
      AND ${plantonistaQualificationMatchesSql("ap", "fsc", "fms")}
      AND ${plantonistaAccessCoversShiftSql("ap", "fsi", "fsc")}
      AND (
        fsc.admission_policy = 'QUALIFICATION_ALLOWLIST'
        OR NULLIF(TRIM(fsi.specialty), '') IS NULL
        OR NULLIF(TRIM(fp.specialty), '') IS NULL
        OR LOWER(TRIM(fsi.specialty)) = LOWER(TRIM(fp.specialty))
      )
      AND (
        fsc.admission_policy = 'QUALIFICATION_ALLOWLIST'
        OR NULLIF(TRIM(fsi.specialty), '') IS NULL
        OR NULLIF(TRIM(ap.specialty), '') IS NULL
        OR LOWER(TRIM(fsi.specialty)) = LOWER(TRIM(ap.specialty))
      )
      AND NOT EXISTS (
        SELECT 1
        FROM shift_assignments_v2 actor_conflict
        JOIN shift_instances actor_conflict_shift
          ON actor_conflict_shift.id = actor_conflict.shift_instance_id
        WHERE actor_conflict.professional_id = ap.id
          AND actor_conflict.is_active = 1
          AND actor_conflict_shift.start_at < fsi.end_at
          AND actor_conflict_shift.end_at > fsi.start_at
          AND (sr.type != 'SWAP' OR actor_conflict.id != tsa.id)
      )
      AND (
        (
          sr.type IN ('TRANSFER', 'CESSAO')
          AND sr.to_shift_instance_id IS NULL
          AND sr.to_assignment_id IS NULL
        )
        OR
        (
          sr.type = 'SWAP'
          AND sr.to_shift_instance_id IS NOT NULL
          AND sr.to_shift_instance_id != sr.from_shift_instance_id
          AND sr.to_assignment_id IS NULL
          AND tsi.id IS NOT NULL
          AND tsi.start_at > NOW()
          AND th.id IS NOT NULL
          AND ts.id IS NOT NULL
          AND tsa.id IS NOT NULL
          AND EXISTS (
            SELECT 1
            FROM monthly_rosters target_roster
            WHERE target_roster.institution_id = tsi.institution_id
              AND target_roster.hospital_id = tsi.hospital_id
              AND target_roster.year_month = DATE_FORMAT(DATE_SUB(tsi.start_at, INTERVAL 3 HOUR), '%Y-%m')
              AND target_roster.status = 'PUBLISHED'
          )
          AND NOT EXISTS (
            SELECT 1
            FROM shift_assignments_v2 target_duplicate
            WHERE target_duplicate.shift_instance_id = tsi.id
              AND target_duplicate.institution_id = tsi.institution_id
              AND target_duplicate.hospital_id = tsi.hospital_id
              AND target_duplicate.sector_id = tsi.sector_id
              AND target_duplicate.professional_id = ap.id
              AND target_duplicate.is_active = 1
              AND target_duplicate.id != tsa.id
          )
          AND EXISTS (
            SELECT 1
            FROM professional_access actor_target_access
            WHERE actor_target_access.institution_id = tsi.institution_id
              AND actor_target_access.professional_id = ap.id
              AND actor_target_access.hospital_id = tsi.hospital_id
              AND actor_target_access.can_access = 1
              AND (
                (
                  tsc.admission_policy = 'QUALIFICATION_ALLOWLIST'
                  AND actor_target_access.sector_id = tsi.sector_id
                )
                OR
                (
                  tsc.admission_policy <> 'QUALIFICATION_ALLOWLIST'
                  AND (actor_target_access.sector_id IS NULL OR actor_target_access.sector_id = tsi.sector_id)
                )
              )
          )
          AND EXISTS (
            SELECT 1
            FROM professional_access source_target_access
            WHERE source_target_access.institution_id = tsi.institution_id
              AND source_target_access.professional_id = fp.id
              AND source_target_access.hospital_id = tsi.hospital_id
              AND source_target_access.can_access = 1
              AND (
                (
                  tsc.admission_policy = 'QUALIFICATION_ALLOWLIST'
                  AND source_target_access.sector_id = tsi.sector_id
                )
                OR
                (
                  tsc.admission_policy <> 'QUALIFICATION_ALLOWLIST'
                  AND (source_target_access.sector_id IS NULL OR source_target_access.sector_id = tsi.sector_id)
                )
              )
          )
          AND (
            NULLIF(TRIM(tsi.specialty), '') IS NULL
            OR NULLIF(TRIM(ap.specialty), '') IS NULL
            OR LOWER(TRIM(tsi.specialty)) = LOWER(TRIM(ap.specialty))
          )
          AND (
            NULLIF(TRIM(tsi.specialty), '') IS NULL
            OR NULLIF(TRIM(fp.specialty), '') IS NULL
            OR LOWER(TRIM(tsi.specialty)) = LOWER(TRIM(fp.specialty))
          )
          AND NOT EXISTS (
            SELECT 1
            FROM shift_assignments_v2 source_target_conflict
            JOIN shift_instances source_target_conflict_shift
              ON source_target_conflict_shift.id = source_target_conflict.shift_instance_id
            WHERE source_target_conflict.professional_id = fp.id
              AND source_target_conflict.is_active = 1
              AND source_target_conflict_shift.start_at < tsi.end_at
              AND source_target_conflict_shift.end_at > tsi.start_at
              AND source_target_conflict.id != fsa.id
          )
        )
      )
  `);

  const unique = new Set<number>();
  for (const row of rowsFromExecute<{ userId: number | string }>(result)) {
    const userId = Number(row.userId);
    if (!Number.isSafeInteger(userId) || userId <= 0) continue;
    if (userId === swap.fromUserId) continue;
    unique.add(userId);
  }
  return [...unique];
}

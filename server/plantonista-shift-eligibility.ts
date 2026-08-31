import { sql, type SQL, type SQLWrapper } from "drizzle-orm";
import { rowsFromExecute } from "./_core/db-results";

type EligibilityDb = {
  execute: (query: string | SQLWrapper) => Promise<unknown>;
};

function col(alias: string, column: string): SQL {
  if (
    !/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias) ||
    !/^[A-Za-z_][A-Za-z0-9_]*$/.test(column)
  ) {
    throw new Error("identificador SQL inválido");
  }
  return sql.raw(`${alias}.${column}`);
}

/**
 * XOR de qualificationMatches: exatamente uma de especialidade CFM / perfil.
 * Alias do profissional plantonista = `ap` (mesmo da oferta #323).
 */
export function plantonistaXorQualificationSql(ap = "ap"): SQL {
  return sql`(${col(ap, "medical_specialty_id")} IS NULL) != (${col(ap, "operational_profile_code")} IS NULL)`;
}

/**
 * qualificationMatches em SQL. Sem atalho GESTOR_PLUS / manager_scope.
 * `sc` = schedule_contexts, `ms` = medical_specialties do contexto.
 */
export function plantonistaQualificationMatchesSql(
  ap = "ap",
  sc = "sc",
  ms = "ms",
): SQL {
  return sql`(
        (
          ${col(sc, "admission_policy")} = 'ALL_CFM_SPECIALTIES'
          AND ${col(ap, "medical_specialty_id")} IS NOT NULL
        )
        OR
        (
          ${col(sc, "admission_policy")} = 'ALL_CFM_EXCEPT_GENERALIST'
          AND ${col(ap, "medical_specialty_id")} IS NOT NULL
          AND ${col(ap, "operational_profile_code")} IS NULL
        )
        OR
        (
          ${col(sc, "medical_specialty_id")} IS NOT NULL
          AND ${col(ms, "id")} IS NOT NULL
          AND ${col(ap, "medical_specialty_id")} = ${col(sc, "medical_specialty_id")}
        )
        OR
        (
          ${col(sc, "operational_profile_code")} IS NOT NULL
          AND ${col(ap, "operational_profile_code")} = ${col(sc, "operational_profile_code")}
        )
        OR
        (
          ${col(sc, "admission_policy")} = 'QUALIFICATION_ALLOWLIST'
          AND EXISTS (
            SELECT 1
              FROM schedule_context_allowed_qualifications aq
             WHERE aq.schedule_context_id = ${col(sc, "id")}
               AND (
                 (
                   aq.medical_specialty_id IS NOT NULL
                   AND ${col(ap, "medical_specialty_id")} = aq.medical_specialty_id
                 )
                 OR
                 (
                   aq.operational_profile_code IS NOT NULL
                   AND ${col(ap, "operational_profile_code")} = aq.operational_profile_code
                 )
               )
          )
        )
      )`;
}

/**
 * professional_access do plantonista: #317 exige setor exato;
 * hospital-wide (sector_id NULL) só no contexto legado.
 */
export function plantonistaAccessCoversShiftSql(
  ap = "ap",
  si = "si",
  sc = "sc",
): SQL {
  return sql`EXISTS (
        SELECT 1
        FROM professional_access actor_source_access
        WHERE actor_source_access.institution_id = ${col(si, "institution_id")}
          AND actor_source_access.professional_id = ${col(ap, "id")}
          AND actor_source_access.hospital_id = ${col(si, "hospital_id")}
          AND actor_source_access.can_access = 1
          AND (
            (
              ${col(sc, "admission_policy")} = 'QUALIFICATION_ALLOWLIST'
              AND actor_source_access.sector_id = ${col(si, "sector_id")}
            )
            OR
            (
              ${col(sc, "admission_policy")} <> 'QUALIFICATION_ALLOWLIST'
              AND (actor_source_access.sector_id IS NULL OR actor_source_access.sector_id = ${col(si, "sector_id")})
            )
          )
      )`;
}

export type VacantShiftEligibilityTarget = {
  id: number;
  institutionId: number;
};

/**
 * Plantonistas que poderiam assumir este plantão vago: mesma regra de
 * qualificação + professional_access da #323, **sem** atalho gerencial.
 * GESTOR_MEDICO / GESTOR_PLUS só entram se passarem como médico.
 */
export async function eligibleProfessionalUserIdsForShift(
  db: EligibilityDb,
  shift: VacantShiftEligibilityTarget,
): Promise<number[]> {
  const result = await db.execute(sql`
    SELECT DISTINCT au.id AS userId
    FROM shift_instances si
    JOIN institutions inst
      ON inst.id = si.institution_id
     AND inst.is_active = 1
    JOIN schedule_contexts sc
      ON sc.id = si.schedule_context_id
     AND sc.institution_id = si.institution_id
     AND sc.hospital_id = si.hospital_id
     AND sc.sector_id = si.sector_id
     AND sc.active = 1
    LEFT JOIN medical_specialties ms
      ON ms.id = sc.medical_specialty_id
     AND ms.active = 1
    JOIN professional_institutions api
      ON api.institution_id = si.institution_id
     AND api.active = 1
    JOIN professionals ap
      ON ap.id = api.professional_id
     AND ap.user_id = api.user_id
    JOIN users au
      ON au.id = ap.user_id
     AND au.approval_status = 'APPROVED'
     AND au.deleted_at IS NULL
    WHERE si.id = ${shift.id}
      AND si.institution_id = ${shift.institutionId}
      AND si.status = 'VAGO'
      AND si.start_at > NOW()
      AND ${plantonistaXorQualificationSql("ap")}
      AND ${plantonistaQualificationMatchesSql("ap", "sc", "ms")}
      AND ${plantonistaAccessCoversShiftSql("ap", "si", "sc")}
      AND NOT EXISTS (
        SELECT 1 FROM monthly_rosters mr
        WHERE mr.institution_id = si.institution_id
          AND mr.hospital_id = si.hospital_id
          AND mr.year_month = DATE_FORMAT(DATE_SUB(si.start_at, INTERVAL 3 HOUR), '%Y-%m')
          AND mr.status = 'LOCKED'
      )
      AND NOT EXISTS (
        SELECT 1
        FROM shift_assignments_v2 actor_conflict
        JOIN shift_instances actor_conflict_shift
          ON actor_conflict_shift.id = actor_conflict.shift_instance_id
        WHERE actor_conflict.professional_id = ap.id
          AND actor_conflict.is_active = 1
          AND actor_conflict_shift.start_at < si.end_at
          AND actor_conflict_shift.end_at > si.start_at
      )
  `);

  const unique = new Set<number>();
  for (const row of rowsFromExecute<{ userId: number | string }>(result)) {
    const userId = Number(row.userId);
    if (!Number.isSafeInteger(userId) || userId <= 0) continue;
    unique.add(userId);
  }
  return [...unique];
}

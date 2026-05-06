import { sql, type SQL } from "drizzle-orm";
import { getDb } from "./db";

export interface ConflictResult {
  hasConflict: boolean;
  conflicts: Array<{
    shiftInstanceId: number;
    label: string;
    startAt: Date;
    endAt: Date;
    hospitalId: number;
    professionalId: number;
  }>;
}

/**
 * Frente H1/H2: anti-overlap (escala-ux §8).
 *
 * The query intentionally filters only on `is_active = 1` — no filter on
 * `assignment_type` or `status`. This means:
 *   - PENDENTE assignments block (a request awaiting manager approval still
 *     reserves the professional's time)
 *   - ON_DUTY, BACKUP and ON_CALL (sobreaviso) all count as occupation. A
 *     professional on sobreaviso cannot be scheduled for a plantão in the
 *     same window, and vice-versa.
 *
 * Overlap predicate: existing.start < target.end AND existing.end > target.start.
 *
 * Internal helper — public API is the two `check*`/`assert*` pairs below.
 */
async function runConflictQuery(
  selector: SQL,
  startAt: Date,
  endAt: Date,
  excludeShiftInstanceId?: number,
): Promise<ConflictResult> {
  const db = await getDb();
  if (!db) return { hasConflict: false, conflicts: [] };

  const startIso = startAt.toISOString().slice(0, 19).replace("T", " ");
  const endIso = endAt.toISOString().slice(0, 19).replace("T", " ");

  const results = await db.execute(sql`
    SELECT
      si.id            AS shift_instance_id,
      si.label,
      si.start_at,
      si.end_at,
      si.hospital_id,
      sa.professional_id
    FROM shift_assignments_v2 sa
    JOIN professionals p  ON p.id  = sa.professional_id
    JOIN shift_instances si ON si.id = sa.shift_instance_id
    WHERE ${selector}
      AND sa.is_active = 1
      AND si.start_at  < ${endIso}
      AND si.end_at    > ${startIso}
      ${excludeShiftInstanceId != null
        ? sql`AND si.id != ${excludeShiftInstanceId}`
        : sql``}
  `);

  const rows = (results as any)[0] as any[];

  return {
    hasConflict: rows.length > 0,
    conflicts: rows.map((r) => ({
      shiftInstanceId: r.shift_instance_id as number,
      label: r.label as string,
      startAt: new Date(r.start_at),
      endAt: new Date(r.end_at),
      hospitalId: r.hospital_id as number,
      professionalId: r.professional_id as number,
    })),
  };
}

function buildConflictMessage(c: ConflictResult["conflicts"][0]): string {
  const startStr = c.startAt.toLocaleString("pt-BR");
  const endStr = c.endAt.toLocaleString("pt-BR");
  return (
    `Conflito de horário: profissional já alocado em "${c.label}" ` +
    `(${startStr} – ${endStr}) no hospital ${c.hospitalId}`
  );
}

/**
 * Verifica se um userId tem conflito de horário com um intervalo.
 * Resolve userId → professional via JOIN. Use a variante
 * `*ForProfessional` quando o caller já tem o `professional_id` em mãos.
 *
 * excludeShiftInstanceId: exclui um shift específico (útil para
 * confirmação de edição ou aceite de troca).
 */
export async function checkTimeConflict(
  userId: number,
  startAt: Date,
  endAt: Date,
  excludeShiftInstanceId?: number,
): Promise<ConflictResult> {
  return runConflictQuery(
    sql`p.user_id = ${userId}`,
    startAt,
    endAt,
    excludeShiftInstanceId,
  );
}

/**
 * Variante por professional_id. Use em fluxos de gestor (assignDirect,
 * approveAssignment) onde o input já carrega o ID do profissional alvo,
 * evitando um JOIN/lookup extra para descobrir o user_id.
 */
export async function checkTimeConflictForProfessional(
  professionalId: number,
  startAt: Date,
  endAt: Date,
  excludeShiftInstanceId?: number,
): Promise<ConflictResult> {
  return runConflictQuery(
    sql`sa.professional_id = ${professionalId}`,
    startAt,
    endAt,
    excludeShiftInstanceId,
  );
}

/**
 * Verifica conflito e lança erro se existir.
 * Usar antes de qualquer assignment creation/approval.
 */
export async function assertNoTimeConflict(
  userId: number,
  startAt: Date,
  endAt: Date,
  excludeShiftInstanceId?: number,
): Promise<void> {
  const result = await checkTimeConflict(userId, startAt, endAt, excludeShiftInstanceId);
  if (result.hasConflict) {
    throw new Error(buildConflictMessage(result.conflicts[0]));
  }
}

/**
 * Variante por professional_id. Mesma semântica de
 * `assertNoTimeConflict`, mas resolve por `sa.professional_id`.
 */
export async function assertNoTimeConflictForProfessional(
  professionalId: number,
  startAt: Date,
  endAt: Date,
  excludeShiftInstanceId?: number,
): Promise<void> {
  const result = await checkTimeConflictForProfessional(
    professionalId,
    startAt,
    endAt,
    excludeShiftInstanceId,
  );
  if (result.hasConflict) {
    throw new Error(buildConflictMessage(result.conflicts[0]));
  }
}

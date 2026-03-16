import { sql } from "drizzle-orm";
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
 * Verifica se um userId tem conflito de horário com um intervalo.
 * Busca TODOS os shifts ativos do userId (em qualquer institution/hospital)
 * que se sobreponham com [startAt, endAt].
 *
 * Sobreposição: A.start < B.end AND A.end > B.start
 *
 * excludeShiftInstanceId: opcional, exclui um shift específico (útil pra edição)
 */
export async function checkTimeConflict(
  userId: number,
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
    WHERE p.user_id    = ${userId}
      AND sa.is_active = 1
      AND si.start_at  < ${endIso}
      AND si.end_at    > ${startIso}
      ${excludeShiftInstanceId != null
        ? sql`AND si.id != ${excludeShiftInstanceId}`
        : sql``}
  `);

  const rows = ((results as any).rows ?? (results as any[])) as any[];

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

/**
 * Verifica conflito e lança erro se existir.
 * Usar antes de qualquer assignment creation.
 */
export async function assertNoTimeConflict(
  userId: number,
  startAt: Date,
  endAt: Date,
  excludeShiftInstanceId?: number,
): Promise<void> {
  const result = await checkTimeConflict(userId, startAt, endAt, excludeShiftInstanceId);
  if (result.hasConflict) {
    const c = result.conflicts[0];
    const startStr = c.startAt.toLocaleString("pt-BR");
    const endStr = c.endAt.toLocaleString("pt-BR");
    throw new Error(
      `Conflito de horário: profissional já alocado em "${c.label}" ` +
        `(${startStr} – ${endStr}) no hospital ${c.hospitalId}`,
    );
  }
}

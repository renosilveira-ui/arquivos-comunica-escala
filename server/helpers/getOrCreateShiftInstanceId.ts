import { and, eq } from "drizzle-orm";
import { shiftInstances } from "../../drizzle/schema.js";

export const GET_OR_CREATE_SHIFT_VERSION =
  "2026-08-25T08:30-03:00-schedule-context";

type GetOrCreateShiftParams = {
  institutionId: number;
  hospitalId: number;
  sectorId: number;
  scheduleContextId: number;
  startAt: Date;
  endAt: Date;
  label: string; // "Manhã", "Tarde", "Noite", "Cinderela"
  createdBy: number; // user.id do gestor ou do sistema
};

/**
 * Busca ou cria um shift_instance de forma determinística.
 *
 * Chave natural: (institutionId, hospitalId, sectorId, scheduleContextId, startAt, endAt, label)
 *
 * Se já existir, reutiliza. Se não existir, cria e busca.
 * Funciona em qualquer ambiente, repetível, sem colisão.
 *
 * ✅ Sem .returning()
 * ✅ Sem insertId
 * ✅ Repetível
 * ✅ Sem IDs mágicos
 */
export async function getOrCreateShiftInstanceId(
  tx: any, // Drizzle transaction
  p: GetOrCreateShiftParams,
): Promise<number> {
  // VERSION: 2026-08-25T08:30-03:00-schedule-context (rastreabilidade)
  if (!Number.isInteger(p.scheduleContextId) || p.scheduleContextId <= 0) {
    throw new Error("scheduleContextId canônico é obrigatório");
  }
  // 1) Tenta achar existente
  const existingRaw = await tx
    .select({ id: shiftInstances.id })
    .from(shiftInstances)
    .where(
      and(
        eq(shiftInstances.institutionId, p.institutionId),
        eq(shiftInstances.hospitalId, p.hospitalId),
        eq(shiftInstances.sectorId, p.sectorId),
        eq(shiftInstances.scheduleContextId, p.scheduleContextId),
        eq(shiftInstances.startAt, p.startAt),
        eq(shiftInstances.endAt, p.endAt),
        eq(shiftInstances.label, p.label),
      ),
    )
    .limit(1);

  // ✅ Normaliza: pode vir rows OU [rows, fields]
  const rows = Array.isArray(existingRaw[0])
    ? (existingRaw[0] as any[])
    : (existingRaw as any[]);

  if (rows.length > 0) {
    const id = Number(rows[0]?.id);
    if (!Number.isFinite(id)) {
      throw new Error(
        `ID inválido retornado pelo select: ${JSON.stringify(rows[0])}`,
      );
    }
    return id;
  }

  // 2) Cria (sem depender de .returning())
  await tx.insert(shiftInstances).values({
    institutionId: p.institutionId,
    hospitalId: p.hospitalId,
    sectorId: p.sectorId,
    scheduleContextId: p.scheduleContextId,
    startAt: p.startAt,
    endAt: p.endAt,
    label: p.label,
    status: "VAGO",
    source: "MANUAL",
    createdBy: p.createdBy,
  });

  // 3) Busca de novo (determinístico)
  const createdRaw = await tx
    .select({ id: shiftInstances.id })
    .from(shiftInstances)
    .where(
      and(
        eq(shiftInstances.institutionId, p.institutionId),
        eq(shiftInstances.hospitalId, p.hospitalId),
        eq(shiftInstances.sectorId, p.sectorId),
        eq(shiftInstances.scheduleContextId, p.scheduleContextId),
        eq(shiftInstances.startAt, p.startAt),
        eq(shiftInstances.endAt, p.endAt),
        eq(shiftInstances.label, p.label),
      ),
    )
    .limit(1);

  // ✅ Normaliza: pode vir rows OU [rows, fields]
  const createdRows = Array.isArray(createdRaw[0])
    ? (createdRaw[0] as any[])
    : (createdRaw as any[]);

  if (createdRows.length === 0) {
    throw new Error(
      "Falha ao criar shiftInstance (não encontrado após insert).",
    );
  }
  const id = Number(createdRows[0]?.id);
  if (!Number.isFinite(id)) {
    throw new Error(
      `ID inválido retornado pelo select: ${JSON.stringify(createdRows[0])}`,
    );
  }
  return id;
}

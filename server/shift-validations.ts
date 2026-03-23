/**
 * Validações de conflito e regras de negócio para alocações de plantões
 * 
 * Regras implementadas:
 * A) Overlap global: mesmo profissional não pode ter 2 alocações simultâneas
 * B) Limite de 20 profissionais por setor/turno
 * C) Permissão TI: profissional deve ter acesso ao hospital/setor
 */

import { getDb } from "./db";
import { shiftAssignmentsV2, shiftInstances, professionalAccess } from "../drizzle/schema";
import { and, eq, count } from "drizzle-orm";
import { sql } from "drizzle-orm";

export interface ValidationResult {
  valid: boolean;
  error?: string;
  errorCode?: "OVERLAP" | "LIMIT_EXCEEDED" | "FORBIDDEN";
}

type DbClient = NonNullable<Awaited<ReturnType<typeof getDb>>>;

type ShiftWindow = {
  startAt: Date;
  endAt: Date;
};

type ValidationContext = {
  db: DbClient;
  targetShiftCache: Map<number, ShiftWindow | null>;
};

async function createValidationContext(): Promise<ValidationContext | null> {
  const db = await getDb();
  if (!db) {
    return null;
  }

  return {
    db,
    targetShiftCache: new Map<number, ShiftWindow | null>(),
  };
}

function parseCountValue(value: unknown): number {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : 0;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function extractRows(result: unknown): any[] {
  if (!result) return [];
  if (Array.isArray(result)) {
    const first = result[0];
    if (Array.isArray(first)) return first as any[];
    return result as any[];
  }
  if (typeof result === "object" && result !== null && "rows" in (result as any)) {
    const rows = (result as any).rows;
    return Array.isArray(rows) ? rows : [];
  }
  return [];
}

async function getTargetShiftWindow(
  context: ValidationContext,
  shiftInstanceId: number,
): Promise<ShiftWindow | null> {
  if (context.targetShiftCache.has(shiftInstanceId)) {
    return context.targetShiftCache.get(shiftInstanceId) || null;
  }

  const [targetShift] = await context.db
    .select({
      startAt: shiftInstances.startAt,
      endAt: shiftInstances.endAt,
    })
    .from(shiftInstances)
    .where(eq(shiftInstances.id, shiftInstanceId));

  const parsed = targetShift
    ? {
        startAt: targetShift.startAt,
        endAt: targetShift.endAt,
      }
    : null;

  context.targetShiftCache.set(shiftInstanceId, parsed);
  return parsed;
}

/**
 * Validação A: Overlap global
 * Verifica se o profissional já está alocado em outro turno no mesmo horário
 */
async function validateOverlapWithContext(
  context: ValidationContext,
  professionalId: number,
  shiftInstanceId: number
): Promise<ValidationResult> {
  const targetShift = await getTargetShiftWindow(context, shiftInstanceId);

  if (!targetShift) {
    return { valid: false, error: "Shift instance not found" };
  }

  // Conflito global por usuário (não por vínculo): se o mesmo user tiver
  // outro vínculo/profissional ativo no mesmo horário, deve bloquear.
  const overlapResult = await context.db.execute<any>(
    sql`SELECT COUNT(*) as count
        FROM shift_assignments_v2 sa
        INNER JOIN shift_instances si ON sa.shift_instance_id = si.id
        INNER JOIN professionals p_existing ON p_existing.id = sa.professional_id
        INNER JOIN professionals p_target ON p_target.id = ${professionalId}
        WHERE p_existing.user_id = p_target.user_id
          AND sa.is_active = true
          AND sa.shift_instance_id <> ${shiftInstanceId}
          AND si.start_at < ${targetShift.endAt}
          AND si.end_at > ${targetShift.startAt}`
  );
  const overlapRows = extractRows(overlapResult);
  const conflictCount = parseCountValue(overlapRows[0]?.count);

  if (conflictCount > 0) {
    return {
      valid: false,
      error: "Conflito: médico já está alocado em outro vínculo/hospital nesse horário.",
      errorCode: "OVERLAP",
    };
  }

  return { valid: true };
}

export async function validateOverlap(
  professionalId: number,
  shiftInstanceId: number
): Promise<ValidationResult> {
  const context = await createValidationContext();
  if (!context) {
    return { valid: false, error: "Database not available" };
  }

  return validateOverlapWithContext(context, professionalId, shiftInstanceId);
}

/**
 * Validação B: Limite de 20 profissionais por setor/turno
 * Conta quantos profissionais já estão alocados no turno
 */
async function validateLimitWithContext(
  context: ValidationContext,
  shiftInstanceId: number,
  sectorId: number
): Promise<ValidationResult> {
  // Contar alocações ativas para este turno e setor
  const [result] = await context.db
    .select({ count: count() })
    .from(shiftAssignmentsV2)
    .where(
      and(
        eq(shiftAssignmentsV2.shiftInstanceId, shiftInstanceId),
        eq(shiftAssignmentsV2.sectorId, sectorId),
        eq(shiftAssignmentsV2.isActive, true)
      )
    );

  const currentCount = parseCountValue(result?.count);

  if (currentCount >= 20) {
    return {
      valid: false,
      error: `Limite de 20 profissionais por turno atingido (${currentCount}/20).`,
      errorCode: "LIMIT_EXCEEDED",
    };
  }

  return { valid: true };
}

export async function validateLimit(
  shiftInstanceId: number,
  sectorId: number
): Promise<ValidationResult> {
  const context = await createValidationContext();
  if (!context) {
    return { valid: false, error: "Database not available" };
  }

  return validateLimitWithContext(context, shiftInstanceId, sectorId);
}

/**
 * Validação C: Permissão TI
 * Verifica se o profissional tem acesso ao hospital/setor
 */
async function validateAccessWithContext(
  context: ValidationContext,
  professionalId: number,
  hospitalId: number,
  sectorId: number
): Promise<ValidationResult> {
  // Buscar permissões do profissional
  // Pode ter acesso geral ao hospital (sectorId = null) ou específico ao setor
  const accessRecords = await context.db
    .select()
    .from(professionalAccess)
    .where(
      and(
        eq(professionalAccess.professionalId, professionalId),
        eq(professionalAccess.hospitalId, hospitalId),
        eq(professionalAccess.canAccess, true)
      )
    );

  if (accessRecords.length === 0) {
    return {
      valid: false,
      error: "Profissional não tem acesso a este hospital.",
      errorCode: "FORBIDDEN",
    };
  }

  // Verificar se tem acesso específico ao setor ou acesso geral ao hospital
  const hasAccess = accessRecords.some(
    (record) => record.sectorId === null || record.sectorId === sectorId
  );

  if (!hasAccess) {
    return {
      valid: false,
      error: "Profissional não tem acesso a este setor.",
      errorCode: "FORBIDDEN",
    };
  }

  return { valid: true };
}

export async function validateAccess(
  professionalId: number,
  hospitalId: number,
  sectorId: number
): Promise<ValidationResult> {
  const context = await createValidationContext();
  if (!context) {
    return { valid: false, error: "Database not available" };
  }

  return validateAccessWithContext(context, professionalId, hospitalId, sectorId);
}

/**
 * Validação completa: executa todas as validações em ordem
 * Retorna o primeiro erro encontrado ou sucesso se todas passarem
 */
export async function validateAssignment(
  professionalId: number,
  shiftInstanceId: number,
  hospitalId: number,
  sectorId: number
): Promise<ValidationResult> {
  const context = await createValidationContext();
  if (!context) {
    return { valid: false, error: "Database not available" };
  }

  // Validação C: Permissão TI (executar primeiro para evitar queries desnecessárias)
  const accessResult = await validateAccessWithContext(context, professionalId, hospitalId, sectorId);
  if (!accessResult.valid) {
    return accessResult;
  }

  // Validação A: Overlap global
  const overlapResult = await validateOverlapWithContext(context, professionalId, shiftInstanceId);
  if (!overlapResult.valid) {
    return overlapResult;
  }

  // Validação B: Limite de 20 profissionais
  const limitResult = await validateLimitWithContext(context, shiftInstanceId, sectorId);
  if (!limitResult.valid) {
    return limitResult;
  }

  return { valid: true };
}

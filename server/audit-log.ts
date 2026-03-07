import { shiftAuditLog } from "../drizzle/schema";
import { eq, desc } from "drizzle-orm";
import { getDb } from "./db";

/**
 * Sistema de Auditoria Obrigatória
 * 
 * Registra todos os eventos de mutação em turnos para governança e compliance.
 * RETROACTIVE_EDIT exige motivo obrigatório.
 */

export type AuditEvent =
  | "SHIFT_ASSIGNED"
  | "SHIFT_UNASSIGNED"
  | "SHIFT_MARKED_VACANT"
  | "SHIFT_OFFERED"
  | "SWAP_PROPOSED"
  | "SWAP_ACCEPTED"
  | "SWAP_REJECTED"
  | "ASSIGNMENT_APPROVED"
  | "ASSIGNMENT_REJECTED"
  | "VACANCY_REQUESTED" // Quando USER assume vaga (cria PENDENTE)
  | "RETROACTIVE_EDIT";

export interface AuditLogParams {
  event: AuditEvent;
  shiftInstanceId: number;
  professionalId: number | null;
  reason?: string | null;
  metadata?: Record<string, any> | null;
}

/**
 * Registrar evento de auditoria
 * 
 * @param params - Parâmetros do evento
 * @throws Error se RETROACTIVE_EDIT não tiver motivo
 */
export async function auditLog(params: AuditLogParams): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const { event, shiftInstanceId, professionalId, reason, metadata } = params;

  // Validar que RETROACTIVE_EDIT exige motivo obrigatório
  if (event === "RETROACTIVE_EDIT" && !reason) {
    throw new Error("RETROACTIVE_EDIT exige motivo obrigatório");
  }

  await db.insert(shiftAuditLog).values({
    event,
    shiftInstanceId,
    professionalId,
    reason: reason ?? null,
    metadata: metadata ? JSON.stringify(metadata) : null,
  });
}
  // Inserir log de auditoria
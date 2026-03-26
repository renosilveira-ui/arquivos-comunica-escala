import { getDb } from "./db";
import { auditTrail } from "../drizzle/schema";

export interface AuditEntry {
  actorUserId: number;
  actorRole: string;
  actorName?: string;
  action:
    | "SHIFT_CREATED"
    | "SHIFT_UPDATED"
    | "SHIFT_DELETED"
    | "ASSIGNMENT_CREATED"
    | "ASSIGNMENT_REMOVED"
    | "ASSIGNMENT_ASSUMED_VACANCY"
    | "ASSIGNMENT_APPROVED"
    | "ASSIGNMENT_REJECTED"
    | "SWAP_REQUESTED"
    | "SWAP_ACCEPTED"
    | "SWAP_REJECTED"
    | "SWAP_APPROVED_BY_MANAGER"
    | "SWAP_CANCELLED"
    | "TRANSFER_OFFERED"
    | "TRANSFER_ACCEPTED"
    | "TRANSFER_REJECTED"
    | "TRANSFER_APPROVED_BY_MANAGER"
    | "TRANSFER_CANCELLED"
    | "ROSTER_PUBLISHED"
    | "ROSTER_LOCKED"
    | "USER_CREATED"
    | "USER_UPDATED"
    | "USER_ROLE_CHANGED"
    | "CONFLICT_DETECTED"
    | "CONFLICT_OVERRIDDEN";
  entityType:
    | "SHIFT_INSTANCE"
    | "SHIFT_ASSIGNMENT"
    | "SWAP_REQUEST"
    | "TRANSFER_REQUEST"
    | "MONTHLY_ROSTER"
    | "USER"
    | "PROFESSIONAL";
  entityId: number;
  description: string;
  metadata?: Record<string, unknown>;
  fromProfessionalId?: number;
  toProfessionalId?: number;
  fromUserId?: number;
  toUserId?: number;
  institutionId?: number;
  hospitalId?: number;
  sectorId?: number;
  shiftInstanceId?: number;
  ipAddress?: string;
  userAgent?: string;
}

/**
 * Grava uma entrada no audit trail de forma fire-and-forget.
 * Nunca bloqueia a operação principal em caso de falha.
 */
export async function recordAudit(entry: AuditEntry): Promise<void> {
  try {
    const db = await getDb();
    if (!db) return;
    await db.insert(auditTrail).values(entry as any);
  } catch (err) {
    // Nunca bloquear a operação por falha de audit
    console.error("[AuditTrail] Failed to record:", err);
  }
}

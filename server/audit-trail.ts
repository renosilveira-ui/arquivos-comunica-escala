import { getDb } from "./db";
import { auditTrail } from "../drizzle/schema";

type AuditDb = Pick<NonNullable<Awaited<ReturnType<typeof getDb>>>, "insert">;

export interface AuditEntry {
  institutionId: number;
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
    | "SWAP_APPROVED_BY_OWNER"
    | "SWAP_CANCELLED"
    | "TRANSFER_OFFERED"
    | "TRANSFER_ACCEPTED"
    | "TRANSFER_REJECTED"
    | "TRANSFER_APPROVED_BY_MANAGER"
    | "TRANSFER_APPROVED_BY_OWNER"
    | "TRANSFER_CANCELLED"
    | "CESSAO_OFFERED"
    | "CESSAO_ACCEPTED"
    | "CESSAO_REJECTED"
    | "CESSAO_APPROVED_BY_OWNER"
    | "CESSAO_CANCELLED"
    | "ROSTER_PUBLISHED"
    | "ROSTER_LOCKED"
    | "USER_CREATED"
    | "USER_UPDATED"
    | "USER_ROLE_CHANGED"
    | "SECTOR_SERVICE_SPECIALTIES_UPDATED"
    | "SSO_JIT_LINK_CREATED"
    | "PUSH_DISPATCHED"
    | "CONFLICT_DETECTED"
    | "CONFLICT_OVERRIDDEN";
  entityType:
    | "SHIFT_INSTANCE"
    | "SHIFT_ASSIGNMENT"
    | "SWAP_REQUEST"
    | "TRANSFER_REQUEST"
    | "MONTHLY_ROSTER"
    | "USER"
    | "PROFESSIONAL"
    | "SECTOR";
  entityId: number;
  description: string;
  metadata?: Record<string, unknown>;
  fromProfessionalId?: number;
  toProfessionalId?: number;
  fromUserId?: number;
  toUserId?: number;
  hospitalId?: number;
  sectorId?: number;
  shiftInstanceId?: number;
  ipAddress?: string;
  userAgent?: string;
}

/**
 * Grava uma entrada no audit trail. Auditoria é parte do contrato da mutação:
 * qualquer falha é propagada para que o caller possa fazer rollback. `strict`
 * aceita apenas `true` por compatibilidade explícita com os callsites
 * transacionais; não existe modo best-effort.
 */
export async function recordAudit(
  entry: AuditEntry,
  options: { db?: AuditDb; strict?: true } = {},
): Promise<void> {
  if (!Number.isInteger(entry.institutionId) || entry.institutionId <= 0) {
    throw new TypeError("AuditEntry.institutionId deve ser um identificador positivo");
  }

  const db = options.db ?? await getDb();
  if (!db) throw new Error("Audit database unavailable");
  await db.insert(auditTrail).values(entry);
}

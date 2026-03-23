import { getDb } from "./db";
import { auditTrail } from "../drizzle/schema";
import type { Request } from "express";

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
function extractAuditRequestMeta(req?: Request | null): Pick<AuditEntry, "ipAddress" | "userAgent"> {
  if (!req) return {};
  const forwardedFor = req.headers["x-forwarded-for"];
  const realIp = req.headers["x-real-ip"];
  const forwardedIp = Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor?.split(",")[0]?.trim();
  const ipAddress =
    (typeof forwardedIp === "string" && forwardedIp) ||
    (typeof realIp === "string" && realIp) ||
    req.ip ||
    undefined;
  const userAgent = typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : undefined;
  return { ipAddress, userAgent };
}

export async function recordAudit(entry: AuditEntry, req?: Request | null): Promise<void> {
  try {
    const db = await getDb();
    if (!db) return;
    const requestMeta = extractAuditRequestMeta(req);
    await db
      .insert(auditTrail)
      .values({
        ...entry,
        ipAddress: entry.ipAddress ?? requestMeta.ipAddress,
        userAgent: entry.userAgent ?? requestMeta.userAgent,
      } as any);
  } catch (err) {
    // Nunca bloquear a operação por falha de audit
    console.error("[AuditTrail] Failed to record:", err);
  }
}

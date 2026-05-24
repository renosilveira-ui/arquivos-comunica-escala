// server/sso/duty-resolver.ts — Resolve active duty context for SSO token
import { and, eq, gte, lte, sql } from "drizzle-orm";
import { getDb } from "../db";
import {
  shiftInstances,
  shiftAssignmentsV2,
  professionals,
  sectors,
} from "../../drizzle/schema";

export interface ActiveDutyContext {
  dutyType: "PLANTAO" | "SOBREAVISO";
  serviceName: string;
  sectorId: number;
  sectorRef: string | null;
  dutyStart: string; // ISO 8601
  dutyEnd: string;   // ISO 8601
}

export interface DutyResolution {
  activeDutyCount: number;
  contextConflict: boolean;
  duty: ActiveDutyContext | null;
}

/**
 * Maps Escala assignmentType to Comunica+ dutyType.
 * ON_DUTY → PLANTAO, BACKUP/ON_CALL → SOBREAVISO
 */
function mapDutyType(assignmentType: string): "PLANTAO" | "SOBREAVISO" {
  if (assignmentType === "ON_DUTY") return "PLANTAO";
  return "SOBREAVISO";
}

/**
 * Finds active shift assignments for a user in a specific institution.
 * "Active" means the shift window includes now (with 30min tolerance).
 */
export async function resolveActiveDuty(
  userId: number,
  institutionId: number,
): Promise<DutyResolution> {
  const db = await getDb();
  if (!db) {
    return { activeDutyCount: 0, contextConflict: false, duty: null };
  }

  const toleranceMinutes = 30;
  const now = new Date();

  // Find the professional record for this user
  const [professional] = await db
    .select({ id: professionals.id })
    .from(professionals)
    .where(eq(professionals.userId, userId))
    .limit(1);

  if (!professional) {
    return { activeDutyCount: 0, contextConflict: false, duty: null };
  }

  // Query active assignments within duty window (with tolerance)
  const activeAssignments = await db
    .select({
      assignmentType: shiftAssignmentsV2.assignmentType,
      startAt: shiftInstances.startAt,
      endAt: shiftInstances.endAt,
      sectorId: shiftInstances.sectorId,
      sectorName: sectors.name,
    })
    .from(shiftAssignmentsV2)
    .innerJoin(shiftInstances, eq(shiftAssignmentsV2.shiftInstanceId, shiftInstances.id))
    .innerJoin(sectors, eq(shiftInstances.sectorId, sectors.id))
    .where(
      and(
        eq(shiftAssignmentsV2.professionalId, professional.id),
        eq(shiftAssignmentsV2.institutionId, institutionId),
        eq(shiftAssignmentsV2.isActive, true),
        lte(shiftInstances.startAt, sql`DATE_ADD(${now.toISOString()}, INTERVAL ${toleranceMinutes} MINUTE)`),
        gte(shiftInstances.endAt, sql`DATE_SUB(${now.toISOString()}, INTERVAL ${toleranceMinutes} MINUTE)`),
      ),
    );

  if (activeAssignments.length === 0) {
    return { activeDutyCount: 0, contextConflict: false, duty: null };
  }

  if (activeAssignments.length > 1) {
    // Multiple active duties — flag conflict, return first for reference
    const first = activeAssignments[0]!;
    return {
      activeDutyCount: activeAssignments.length,
      contextConflict: true,
      duty: {
        dutyType: mapDutyType(first.assignmentType),
        serviceName: first.sectorName,
        sectorId: first.sectorId,
        sectorRef: null,
        dutyStart: new Date(first.startAt).toISOString(),
        dutyEnd: new Date(first.endAt).toISOString(),
      },
    };
  }

  const assignment = activeAssignments[0]!;
  return {
    activeDutyCount: 1,
    contextConflict: false,
    duty: {
      dutyType: mapDutyType(assignment.assignmentType),
      serviceName: assignment.sectorName,
      sectorId: assignment.sectorId,
      sectorRef: null,
      dutyStart: new Date(assignment.startAt).toISOString(),
      dutyEnd: new Date(assignment.endAt).toISOString(),
    },
  };
}

/**
 * server/authz/enforce.ts — Central AuthZ v1 enforcement layer
 *
 * Rules (non-negotiable):
 *  - All sensitive authorization must pass through authorize(actor, action, resource, context).
 *  - No new "if role" outside this layer.
 *  - functional_profile does NOT authorize.
 *  - directory_entry_id does NOT authorize.
 *  - stationId from client does NOT authorize by itself.
 *  - PIN does NOT elevate privilege; it only signs critical actions.
 *  - Service accounts are NOT disguised human users.
 *  - Every session must be org-scoped.
 *  - Every critical mutation must have ALLOW/DENY audit with reason.
 *  - Legacy fallback is controlled by AUTHZ_V1_ENFORCE flag.
 */

import { ENV } from "../_core/env";
import { recordAudit } from "../audit-trail";

// ── AuthZ v1 types ────────────────────────────────────────────────────────────

export type PrincipalType = "HUMAN_INTERNAL" | "HUMAN_EXTERNAL" | "SERVICE_ACCOUNT";

export type Bundle =
  | "OPERATOR"
  | "MANAGER"
  | "DIRECTORY_ADMIN"
  | "ORG_ADMIN"
  | "AUDITOR_READONLY"
  | "SERVICE_INTEGRATION";

export type Scope = "ORGANIZATION" | "SECTOR" | "STATION" | "SELF_ONLY";

export type ActiveMode = "MOBILE" | "STATION" | "ADMIN";

export interface Actor {
  /** User ID (numeric, from session). Required for HUMAN_* principals. */
  userId?: number;
  /** Service account identifier. Required for SERVICE_ACCOUNT principal. */
  serviceAccountId?: string;
  principalType: PrincipalType;
  bundle: Bundle;
  scope: Scope;
  activeMode: ActiveMode;
  /** Org/institution ID — every session must be org-scoped. */
  orgId: number;
  /**
   * functional_profile is carried for UI/operational semantics only.
   * It MUST NOT be used for authorization decisions.
   */
  functionalProfile?: string;
}

export interface AuthzResource {
  type: string;
  id?: number | string;
  institutionId?: number;
  hospitalId?: number;
  sectorId?: number;
}

export interface AuthzContext {
  /** When true, the action carries a signed PIN confirmation. */
  pinConfirmed?: boolean;
  requestIp?: string;
  userAgent?: string;
}

export type AuthzDecision = "ALLOW" | "DENY";

export interface AuthzResult {
  decision: AuthzDecision;
  reason: string;
}

// ── Action → required bundle mapping ─────────────────────────────────────────

/**
 * Minimum bundle required for each action.
 * Bundles are ordered from least to most privileged:
 *   OPERATOR < MANAGER < DIRECTORY_ADMIN < ORG_ADMIN
 * AUDITOR_READONLY can only read; SERVICE_INTEGRATION only integration ops.
 */
const BUNDLE_ORDER: Bundle[] = [
  "OPERATOR",
  "MANAGER",
  "DIRECTORY_ADMIN",
  "ORG_ADMIN",
];

function bundleRank(b: Bundle): number {
  const idx = BUNDLE_ORDER.indexOf(b);
  return idx === -1 ? -1 : idx;
}

function hasMinBundle(actor: Actor, required: Bundle): boolean {
  return bundleRank(actor.bundle) >= bundleRank(required);
}

const ACTION_REQUIRED_BUNDLE: Record<string, Bundle> = {
  // Shift / assignment operations
  "shift:create": "MANAGER",
  "shift:update": "MANAGER",
  "shift:delete": "MANAGER",
  "assignment:approve": "MANAGER",
  "assignment:reject": "MANAGER",
  "vacancy:assume": "OPERATOR",

  // Swap / transfer
  "swap:propose": "OPERATOR",
  "swap:approve": "MANAGER",
  "swap:reject": "MANAGER",

  // Roster
  "roster:publish": "MANAGER",
  "roster:lock": "MANAGER",

  // Admin
  "user:create": "DIRECTORY_ADMIN",
  "user:update": "DIRECTORY_ADMIN",
  "user:role_change": "ORG_ADMIN",

  // Audit
  "audit:read": "AUDITOR_READONLY",

  // Service integration
  "integration:push": "SERVICE_INTEGRATION",
  "integration:pull": "SERVICE_INTEGRATION",
};

// ── Scope enforcement ─────────────────────────────────────────────────────────

function scopeAllows(actor: Actor, resource: AuthzResource): boolean {
  switch (actor.scope) {
    case "ORGANIZATION":
      // Org-wide scope: any resource within the org is accessible.
      // Cross-org enforcement is done separately (step 5 in authorize()).
      return true;
    case "SECTOR":
      // Sector scope: resource must have a sectorId
      return resource.sectorId !== undefined;
    case "STATION":
      // Station scope: limited to station-level operations
      return resource.sectorId !== undefined || resource.hospitalId !== undefined;
    case "SELF_ONLY":
      // SELF_ONLY: actor can only act on resources tied to their own userId
      return false; // Callers must handle self-check before calling authorize()
    default:
      return false;
  }
}

// ── Core authorize function ───────────────────────────────────────────────────

/**
 * Central authorization gate for AuthZ v1.
 *
 * When AUTHZ_V1_ENFORCE=0 (flag off), the function returns ALLOW and emits a
 * LEGACY_BYPASS audit entry so the rollback path is fully visible.
 *
 * When AUTHZ_V1_ENFORCE=1 (flag on), full v1 enforcement is applied.
 */
export async function authorize(
  actor: Actor,
  action: string,
  resource: AuthzResource,
  context: AuthzContext = {},
): Promise<AuthzResult> {
  // ── Legacy fallback ───────────────────────────────────────────────────────
  if (!ENV.authzV1Enforce) {
    // Log the bypass for observability; never blocks the request.
    void emitAudit(actor, action, resource, context, "ALLOW", "LEGACY_BYPASS: AUTHZ_V1_ENFORCE=0");
    return { decision: "ALLOW", reason: "LEGACY_BYPASS: AUTHZ_V1_ENFORCE=0" };
  }

  // ── AuthZ v1 enforcement ──────────────────────────────────────────────────

  // 1. Org-scope check: every session must be org-scoped
  if (!actor.orgId) {
    const reason = "DENY: session not org-scoped (missing orgId)";
    void emitAudit(actor, action, resource, context, "DENY", reason);
    return { decision: "DENY", reason };
  }

  // 2. Service account is never a human user
  if (actor.principalType === "SERVICE_ACCOUNT") {
    const required: Bundle = ACTION_REQUIRED_BUNDLE[action] ?? "ORG_ADMIN";
    if (required !== "SERVICE_INTEGRATION") {
      const reason = `DENY: SERVICE_ACCOUNT cannot perform action '${action}'`;
      void emitAudit(actor, action, resource, context, "DENY", reason);
      return { decision: "DENY", reason };
    }
    if (actor.bundle !== "SERVICE_INTEGRATION") {
      const reason = "DENY: SERVICE_ACCOUNT must have SERVICE_INTEGRATION bundle";
      void emitAudit(actor, action, resource, context, "DENY", reason);
      return { decision: "DENY", reason };
    }
    void emitAudit(actor, action, resource, context, "ALLOW", "SERVICE_ACCOUNT integration action allowed");
    return { decision: "ALLOW", reason: "SERVICE_ACCOUNT integration action allowed" };
  }

  // 3. Bundle check
  const requiredBundle = ACTION_REQUIRED_BUNDLE[action];
  if (!requiredBundle) {
    const reason = `DENY: unknown action '${action}' — not registered in AuthZ policy`;
    void emitAudit(actor, action, resource, context, "DENY", reason);
    return { decision: "DENY", reason };
  }

  // AUDITOR_READONLY: special case — only audit:read is allowed
  if (actor.bundle === "AUDITOR_READONLY") {
    if (action !== "audit:read") {
      const reason = "DENY: AUDITOR_READONLY bundle cannot perform write actions";
      void emitAudit(actor, action, resource, context, "DENY", reason);
      return { decision: "DENY", reason };
    }
    void emitAudit(actor, action, resource, context, "ALLOW", "AUDITOR_READONLY read access");
    return { decision: "ALLOW", reason: "AUDITOR_READONLY read access" };
  }

  if (!hasMinBundle(actor, requiredBundle)) {
    const reason = `DENY: bundle '${actor.bundle}' is below required '${requiredBundle}' for action '${action}'`;
    void emitAudit(actor, action, resource, context, "DENY", reason);
    return { decision: "DENY", reason };
  }

  // 4. Scope check
  if (!scopeAllows(actor, resource)) {
    const reason = `DENY: scope '${actor.scope}' does not permit action '${action}' on resource type '${resource.type}'`;
    void emitAudit(actor, action, resource, context, "DENY", reason);
    return { decision: "DENY", reason };
  }

  // 5. Cross-org check
  if (resource.institutionId !== undefined && resource.institutionId !== actor.orgId) {
    const reason = `DENY: resource institutionId ${resource.institutionId} does not match actor orgId ${actor.orgId}`;
    void emitAudit(actor, action, resource, context, "DENY", reason);
    return { decision: "DENY", reason };
  }

  const reason = `ALLOW: bundle=${actor.bundle} scope=${actor.scope} action=${action}`;
  void emitAudit(actor, action, resource, context, "ALLOW", reason);
  return { decision: "ALLOW", reason };
}

// ── Audit emission ────────────────────────────────────────────────────────────

async function emitAudit(
  actor: Actor,
  action: string,
  resource: AuthzResource,
  context: AuthzContext,
  decision: AuthzDecision,
  reason: string,
): Promise<void> {
  try {
    // Only record to the audit trail for human actors (service accounts use
    // their own audit path). Fire-and-forget; never blocks the request.
    if (actor.userId !== undefined) {
      await recordAudit({
        actorUserId: actor.userId,
        actorRole: actor.bundle,
        action: "AUTHZ_DECISION",
        entityType: "SHIFT_INSTANCE" as any,
        entityId: typeof resource.id === "number" ? resource.id : 0,
        description: `[AUTHZ_V1] decision=${decision} action=${action} reason=${reason}`,
        institutionId: actor.orgId,
        hospitalId: resource.hospitalId,
        sectorId: resource.sectorId,
        ipAddress: context.requestIp,
        userAgent: context.userAgent,
        metadata: { decision, action, reason, resource },
      });
    }
  } catch {
    // Never block the authorization result due to audit failure.
  }
}

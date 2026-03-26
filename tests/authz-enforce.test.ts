/**
 * tests/authz-enforce.test.ts
 *
 * Unit tests for server/authz/enforce.ts — the central AuthZ v1 enforcement layer.
 *
 * These tests run with AUTHZ_V1_ENFORCE=1 (set via vitest env or CI env var).
 * They do NOT require a database connection — the authorize() function itself
 * is pure logic; only the audit fire-and-forget path touches the DB and is
 * safely no-op when the DB is unavailable.
 */

import { describe, it, expect, beforeAll } from "vitest";

// Force v1 enforcement for these tests regardless of .env
beforeAll(() => {
  process.env.AUTHZ_V1_ENFORCE = "1";
});

// Import after setting the env so ENV.authzV1Enforce is re-read
// (dynamic import ensures module re-evaluation in each test run)
async function getAuthorize() {
  // Re-import to pick up the env override in each test file run
  const mod = await import("../server/authz/enforce");
  return mod.authorize;
}

import type { Actor, AuthzResource, AuthzContext } from "../server/authz/enforce";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeActor(overrides: Partial<Actor> = {}): Actor {
  return {
    userId: 1,
    principalType: "HUMAN_INTERNAL",
    bundle: "MANAGER",
    scope: "ORGANIZATION",
    activeMode: "ADMIN",
    orgId: 10,
    ...overrides,
  };
}

function makeResource(overrides: Partial<AuthzResource> = {}): AuthzResource {
  return {
    type: "SHIFT_ASSIGNMENT",
    id: 42,
    institutionId: 10,
    hospitalId: 5,
    sectorId: 3,
    ...overrides,
  };
}

const ctx: AuthzContext = {};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("authorize() — AuthZ v1 enforcement", () => {
  it("ALLOW: MANAGER approves assignment in same org", async () => {
    const authorize = await getAuthorize();
    const result = await authorize(
      makeActor({ bundle: "MANAGER" }),
      "assignment:approve",
      makeResource(),
      ctx,
    );
    expect(result.decision).toBe("ALLOW");
  });

  it("DENY: OPERATOR cannot approve assignment (requires MANAGER)", async () => {
    const authorize = await getAuthorize();
    const result = await authorize(
      makeActor({ bundle: "OPERATOR" }),
      "assignment:approve",
      makeResource(),
      ctx,
    );
    expect(result.decision).toBe("DENY");
    expect(result.reason).toContain("below required");
  });

  it("ALLOW: OPERATOR can assume vacancy", async () => {
    const authorize = await getAuthorize();
    const result = await authorize(
      makeActor({ bundle: "OPERATOR" }),
      "vacancy:assume",
      makeResource({ type: "SHIFT_INSTANCE" }),
      ctx,
    );
    expect(result.decision).toBe("ALLOW");
  });

  it("DENY: cross-org resource access is rejected", async () => {
    const authorize = await getAuthorize();
    const result = await authorize(
      makeActor({ orgId: 10 }),
      "assignment:approve",
      makeResource({ institutionId: 99 }), // different org
      ctx,
    );
    expect(result.decision).toBe("DENY");
    expect(result.reason).toContain("does not match actor orgId");
  });

  it("DENY: session without orgId is rejected", async () => {
    const authorize = await getAuthorize();
    const result = await authorize(
      makeActor({ orgId: 0 }),
      "assignment:approve",
      makeResource(),
      ctx,
    );
    expect(result.decision).toBe("DENY");
    expect(result.reason).toContain("not org-scoped");
  });

  it("DENY: unknown action is rejected", async () => {
    const authorize = await getAuthorize();
    const result = await authorize(
      makeActor({ bundle: "ORG_ADMIN" }),
      "unknown:action",
      makeResource(),
      ctx,
    );
    expect(result.decision).toBe("DENY");
    expect(result.reason).toContain("unknown action");
  });

  it("ALLOW: ORG_ADMIN can change user role", async () => {
    const authorize = await getAuthorize();
    const result = await authorize(
      makeActor({ bundle: "ORG_ADMIN" }),
      "user:role_change",
      makeResource({ type: "USER" }),
      ctx,
    );
    expect(result.decision).toBe("ALLOW");
  });

  it("DENY: MANAGER cannot change user role (requires ORG_ADMIN)", async () => {
    const authorize = await getAuthorize();
    const result = await authorize(
      makeActor({ bundle: "MANAGER" }),
      "user:role_change",
      makeResource({ type: "USER" }),
      ctx,
    );
    expect(result.decision).toBe("DENY");
    expect(result.reason).toContain("below required");
  });

  it("ALLOW: AUDITOR_READONLY can read audit trail", async () => {
    const authorize = await getAuthorize();
    const result = await authorize(
      makeActor({ bundle: "AUDITOR_READONLY" }),
      "audit:read",
      makeResource({ type: "AUDIT_TRAIL" }),
      ctx,
    );
    expect(result.decision).toBe("ALLOW");
  });

  it("DENY: AUDITOR_READONLY cannot approve assignment", async () => {
    const authorize = await getAuthorize();
    const result = await authorize(
      makeActor({ bundle: "AUDITOR_READONLY" }),
      "assignment:approve",
      makeResource(),
      ctx,
    );
    expect(result.decision).toBe("DENY");
    expect(result.reason).toContain("AUDITOR_READONLY");
  });

  it("ALLOW: SERVICE_ACCOUNT with SERVICE_INTEGRATION can push integration", async () => {
    const authorize = await getAuthorize();
    const result = await authorize(
      makeActor({
        userId: undefined,
        serviceAccountId: "sa-hospital-alert",
        principalType: "SERVICE_ACCOUNT",
        bundle: "SERVICE_INTEGRATION",
      }),
      "integration:push",
      makeResource({ type: "INTEGRATION_EVENT" }),
      ctx,
    );
    expect(result.decision).toBe("ALLOW");
  });

  it("DENY: SERVICE_ACCOUNT cannot approve assignment (human action)", async () => {
    const authorize = await getAuthorize();
    const result = await authorize(
      makeActor({
        userId: undefined,
        serviceAccountId: "sa-hospital-alert",
        principalType: "SERVICE_ACCOUNT",
        bundle: "SERVICE_INTEGRATION",
      }),
      "assignment:approve",
      makeResource(),
      ctx,
    );
    expect(result.decision).toBe("DENY");
    expect(result.reason).toContain("SERVICE_ACCOUNT cannot perform action");
  });

  it("DENY: SERVICE_ACCOUNT with non-SERVICE_INTEGRATION bundle is rejected", async () => {
    const authorize = await getAuthorize();
    const result = await authorize(
      makeActor({
        userId: undefined,
        serviceAccountId: "sa-rogue",
        principalType: "SERVICE_ACCOUNT",
        bundle: "MANAGER", // wrong bundle for service account
      }),
      "integration:push",
      makeResource({ type: "INTEGRATION_EVENT" }),
      ctx,
    );
    expect(result.decision).toBe("DENY");
    expect(result.reason).toContain("SERVICE_INTEGRATION bundle");
  });

  it("result.reason is always a non-empty string", async () => {
    const authorize = await getAuthorize();
    const cases: [Actor, string, AuthzResource][] = [
      [makeActor({ bundle: "MANAGER" }), "shift:create", makeResource()],
      [makeActor({ bundle: "OPERATOR" }), "assignment:approve", makeResource()],
      [makeActor({ orgId: 0 }), "vacancy:assume", makeResource()],
    ];
    for (const [actor, action, resource] of cases) {
      const r = await authorize(actor, action, resource, ctx);
      expect(typeof r.reason).toBe("string");
      expect(r.reason.length).toBeGreaterThan(0);
    }
  });
});

describe("authorize() — legacy fallback (AUTHZ_V1_ENFORCE=0)", () => {
  it("ALLOW: every action is allowed when flag is off", async () => {
    // Temporarily override ENV.authzV1Enforce — safe because:
    // 1. vitest.authz.config.ts sets fileParallelism: false (sequential execution)
    // 2. The try/finally below always restores the original value
    // 3. No other test in this file sets authzV1Enforce=true independently
    const envModule = await import("../server/_core/env");
    const original = envModule.ENV.authzV1Enforce;
    envModule.ENV.authzV1Enforce = false;

    try {
      const { authorize } = await import("../server/authz/enforce");
      const result = await authorize(
        makeActor({ bundle: "OPERATOR" }),
        "assignment:approve", // would normally be DENY for OPERATOR
        makeResource(),
        ctx,
      );
      expect(result.decision).toBe("ALLOW");
      expect(result.reason).toContain("LEGACY_BYPASS");
    } finally {
      // Always restore the original value
      envModule.ENV.authzV1Enforce = original;
    }
  });
});

/**
 * server/authz/health.ts — AuthZ-aware health check helper
 *
 * Used by the /api/health endpoint and the authz-rollout smoke tests.
 * Returns a structured status that includes DB reachability and the current
 * state of the AUTHZ_V1_ENFORCE flag so runbook operators can confirm
 * the flag is applied without a code deployment.
 */

import { ENV } from "../_core/env";
import { getDb } from "../db";

export interface HealthStatus {
  ok: boolean;
  timestamp: number;
  db: "up" | "down" | "unknown";
  authzV1Enforce: boolean;
  /** "legacy" when AUTHZ_V1_ENFORCE=0, "v1" when =1 */
  authzMode: "legacy" | "v1";
  details?: string;
}

export async function getHealthStatus(): Promise<HealthStatus> {
  const timestamp = Date.now();
  let db: "up" | "down" | "unknown" = "unknown";

  try {
    const client = await getDb();
    if (client) {
      await client.execute("SELECT 1");
      db = "up";
    } else {
      db = "down";
    }
  } catch {
    db = "down";
  }

  const authzV1Enforce = ENV.authzV1Enforce;
  const authzMode: "legacy" | "v1" = authzV1Enforce ? "v1" : "legacy";
  const ok = db === "up";

  return {
    ok,
    timestamp,
    db,
    authzV1Enforce,
    authzMode,
    details: ok ? undefined : "DB unreachable",
  };
}

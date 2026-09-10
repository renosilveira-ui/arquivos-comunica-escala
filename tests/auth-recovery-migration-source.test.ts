import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../drizzle/migrations/manual/2026-09-10-auth-recovery-requests.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("auth recovery migration: contrato estático", () => {
  it("recusa homônimo incompatível antes do primeiro DDL e recalcula postflight", () => {
    const preflight = migration.indexOf("EXECUTE auth_recovery_preflight_stmt");
    const create = migration.indexOf("CREATE TABLE IF NOT EXISTS auth_recovery_requests");
    const postflight = migration.indexOf("SET @auth_recovery_post_columns_hash");
    expect(preflight).toBeGreaterThan(0);
    expect(create).toBeGreaterThan(preflight);
    expect(postflight).toBeGreaterThan(create);
    expect(migration).toContain("@auth_recovery_postflight_ok");
    expect(migration).not.toMatch(/\b(?:ALTER|DROP|RENAME|TRUNCATE)\s+TABLE\b/i);
  });

  it("fixa o contrato de índices, FKs e invariantes de estado", () => {
    for (const required of [
      "uniq_auth_recovery_token_hash",
      "idx_auth_recovery_ready",
      "idx_auth_recovery_target",
      "fk_auth_recovery_target_user",
      "fk_auth_recovery_target_membership",
      "fk_auth_recovery_actor_user",
      "fk_auth_recovery_actor_membership",
      "fk_auth_recovery_institution",
      "chk_auth_recovery_attempts",
      "chk_auth_recovery_admin_binding",
      "chk_auth_recovery_active_binding",
    ]) {
      expect(migration).toContain(required);
    }
    expect(migration).toContain("COALESCE(indexes.IS_VISIBLE, '<NULL>')");
    expect(migration).toContain("ENGINE = 'InnoDB'");
    expect(migration).toContain("TABLE_COLLATION = (");
  });
});

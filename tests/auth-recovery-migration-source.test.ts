import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../drizzle/migrations/manual/2026-09-10-auth-recovery-requests.sql",
    import.meta.url,
  ),
  "utf8",
);
const migrationConfig = readFileSync("vitest.migration.config.ts", "utf8");
const ciWorkflow = readFileSync(".github/workflows/ci.yml", "utf8");

describe("auth recovery migration: contrato estático", () => {
  it("recusa homônimo incompatível antes do primeiro DDL e recalcula postflight", () => {
    const preflight = migration.indexOf("EXECUTE auth_recovery_preflight_stmt");
    const create = migration.indexOf(
      "CREATE TABLE IF NOT EXISTS auth_recovery_requests",
    );
    const postflight = migration.indexOf(
      "SET @auth_recovery_post_columns_hash",
    );
    expect(preflight).toBeGreaterThan(0);
    expect(create).toBeGreaterThan(preflight);
    expect(postflight).toBeGreaterThan(create);
    expect(migration).toContain("@auth_recovery_postflight_ok");
    expect(migration).not.toMatch(
      /\b(?:ALTER|DROP|RENAME|TRUNCATE)\s+TABLE\b/i,
    );
  });

  it("fixa o contrato de índices, FKs e invariantes de estado", () => {
    for (const required of [
      "uniq_auth_recovery_token_hash",
      "uniq_auth_recovery_active_target",
      "idx_auth_recovery_ready",
      "idx_auth_recovery_target",
      "fk_auth_recovery_target_user",
      "fk_auth_recovery_target_membership",
      "fk_auth_recovery_actor_user",
      "fk_auth_recovery_actor_membership",
      "fk_auth_recovery_institution",
      "chk_auth_recovery_attempts",
      "chk_auth_recovery_actor_binding",
      "chk_auth_recovery_active_binding",
      "chk_auth_recovery_active_slot",
      "chk_auth_recovery_deadline",
      "chk_auth_recovery_hashes",
      "chk_auth_recovery_state_payload",
    ]) {
      expect(migration).toContain(required);
    }
    expect(migration).toContain("COALESCE(indexes.IS_VISIBLE, '<NULL>')");
    expect(migration).toContain("ENGINE = 'InnoDB'");
    expect(migration).toContain("TABLE_COLLATION = (");
    expect(migration).toContain("INFORMATION_SCHEMA.TRIGGERS");
    expect(migration).toContain("table_constraints.ENFORCED");
    expect(migration).toContain("COALESCE(CREATE_OPTIONS, '') = ''");
    expect(migration).toContain("@auth_recovery_expected_columns_manifest");
    expect(migration).toContain("@auth_recovery_expected_checks_manifest");
    expect(migration).not.toContain("MYSQL8_PROOF_REQUIRED");
    expect(migration).not.toContain("PENDING_DELIVERY");
  });

  it("declara ator, deadline, teto, slot ACTIVE e terminais sem payload", () => {
    expect(migration).toContain(
      "request_actor_kind ENUM('UNAUTHENTICATED','AUTHENTICATED_ADMIN') NOT NULL",
    );
    expect(migration).toContain("delivery_deadline_at DATETIME NOT NULL");
    expect(migration).toContain("attempt_count >= 0 AND attempt_count <= 5");
    expect(migration).toContain("state = 'ACTIVE' AND active_slot = 1");
    expect(migration).toContain("state IN ('SKIPPED', 'DEAD')");
    expect(migration).toContain("finished_at IS NOT NULL");
    expect(migration).toContain("sealed_payload IS NULL");
  });

  it("modela SELF_SERVICE como trilha account-wide sem PI implícita", () => {
    expect(migration).toContain(
      "kind = 'SELF_SERVICE' AND target_membership_id IS NULL",
    );
    expect(migration).toContain(
      "kind = 'ADMIN_INITIATED' AND target_membership_id IS NOT NULL",
    );
    expect(migration).toMatch(
      /expected_actor_session_version IS NULL\s+AND target_membership_id IS NULL/,
    );
  });

  it("exige prova MySQL local e fixa a representação de catálogo comprovada", () => {
    expect(migration).toContain("MySQL 8.0.46 serializa CHECK_CLAUSE");
    expect(migration).toContain("CHAR(92)");
    expect(migration).toContain("REGEXP_LIKE");
    expect(migrationConfig).toContain(
      "tests/auth-recovery-migration-mysql.test.ts",
    );
    expect(ciWorkflow).toContain(
      "AUTH_RECOVERY_MIGRATION_TEST_SERVER_URL: mysql://root:root@127.0.0.1:3306/mysql",
    );
    expect(ciWorkflow).toContain("AUTH_RECOVERY_MIGRATION_TEST_MARKER:");
    expect(ciWorkflow).toContain("image: mysql:8.0.46");
  });
});

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migrationPath =
  "drizzle/migrations/manual/2026-09-10-swap-expiry-audit-index.sql";

describe("migration da expiração auditável de ofertas", () => {
  const migration = readFileSync(migrationPath, "utf8");

  it("converge os dois baselines exatos para um único sucessor", () => {
    expect(migration).toContain("@swap_expiry_action_fresh_before");
    expect(migration).toContain("@swap_expiry_action_upgraded_before");
    expect(migration).toContain("@swap_expiry_action_after");
    expect(migration).toContain(
      "COLUMN_TYPE IN (\n      @swap_expiry_action_fresh_before,\n      @swap_expiry_action_upgraded_before,\n      @swap_expiry_action_after\n    )",
    );
    expect(migration).toContain(
      "'CONFLICT_OVERRIDDEN'',''SECTOR_SERVICE_SPECIALTIES_UPDATED'',''INSTITUTION_FEATURE_UPDATED'',''SWAP_EXPIRED'',''TRANSFER_EXPIRED'',''CESSAO_EXPIRED'')'",
    );
    expect(migration).toContain(
      "@swap_expiry_action_current <> @swap_expiry_action_after",
    );
    expect(migration).toContain("CHARACTER_SET_NAME = 'utf8mb4'");
    expect(migration).toContain("COLLATION_NAME = 'utf8mb4_0900_ai_ci'");
    expect(migration).toContain("IS_NULLABLE = 'NO'");
    expect(migration).toContain("COLUMN_DEFAULT IS NULL");
  });

  it("recusa índice homônimo divergente antes do DDL e valida o pós-estado", () => {
    expect(migration).toContain("@swap_expiry_index_rows = 0");
    expect(migration).toContain("@swap_expiry_index_rows = 5");
    expect(migration).toContain("NON_UNIQUE = 1 AND SEQ_IN_INDEX = 1 AND COLUMN_NAME = 'institution_id'");
    expect(migration).toContain("NON_UNIQUE = 1 AND SEQ_IN_INDEX = 2 AND COLUMN_NAME = 'from_assignment_id'");
    expect(migration).toContain("NON_UNIQUE = 1 AND SEQ_IN_INDEX = 3 AND COLUMN_NAME = 'status'");
    expect(migration).toContain("NON_UNIQUE = 1 AND SEQ_IN_INDEX = 4 AND COLUMN_NAME = 'expires_at'");
    expect(migration).toContain("NON_UNIQUE = 1 AND SEQ_IN_INDEX = 5 AND COLUMN_NAME = 'id'");
    expect(migration.match(/IS_VISIBLE = 'YES'/g)).toHaveLength(10);
    expect(migration.match(/SELECT JSON_EXTRACT\(''\[\]'', ''\$\[''\)/g)).toHaveLength(2);
    expect(migration).not.toContain("swap_expiry_reoffer_contract_mismatch");
    expect(migration).not.toContain("swap_expiry_reoffer_postflight_mismatch");

    const preflight = migration.indexOf("EXECUTE swap_expiry_preflight_guard_stmt");
    const enumDdl = migration.indexOf("EXECUTE swap_expiry_action_ddl_stmt");
    const indexDdl = migration.indexOf("EXECUTE swap_expiry_index_ddl_stmt");
    const postflight = migration.indexOf("EXECUTE swap_expiry_postflight_guard_stmt");
    expect(preflight).toBeGreaterThan(-1);
    expect(enumDdl).toBeGreaterThan(preflight);
    expect(indexDdl).toBeGreaterThan(enumDdl);
    expect(postflight).toBeGreaterThan(indexDdl);
  });

  it("documenta metadata lock e rollback sem apagar evidência", () => {
    expect(migration).toContain("metadata lock");
    expect(migration).toContain("Converter o baseline fresh reordena ENUM");
    expect(migration).toContain(
      "DROP INDEX idx_swap_expiry_reoffer ON swap_requests",
    );
    expect(migration).toContain("rollback é proibido");
  });
});

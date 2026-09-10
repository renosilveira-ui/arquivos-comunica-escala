import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../drizzle/migrations/manual/2026-09-09-core-schema-reproducibility.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("migration de reprodutibilidade do schema central", () => {
  it("é aditiva, idempotente e falha fechada sobre objetos parciais", () => {
    expect(migration).toContain("core_schema_reproducibility_contract_mismatch");
    expect(migration).toContain("LOWER(COLUMN_TYPE) = 'int'");
    expect(migration).toContain("= 'auto_increment'");
    expect(migration).toContain("COUNT(*) = 1");
    expect(migration).toContain("TABLE_TYPE = 'BASE TABLE'");
    expect(migration).toContain("UPPER(ENGINE) = 'INNODB'");
    expect(migration).toContain(
      "COLLATION_NAME = @csr_shift_instances_table_collation",
    );
    expect(migration).toContain(
      "@csr_institution_config_fk_name_available = 1",
    );
    expect(migration).toContain("POSITION_IN_UNIQUE_CONSTRAINT = 1");
    expect(migration).toContain("UNIQUE_CONSTRAINT_NAME = 'PRIMARY'");
    expect(migration).toContain("@csr_modality_column_count = 0");
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS institution_config");
    expect(migration).toContain("idx_shift_instances_modality");
    expect(migration).toContain("fk_institution_config_institution");
    expect(migration).toContain("ON DELETE CASCADE");
    expect(migration).toContain("core_schema_reproducibility_postflight_failed");
    expect(migration).not.toMatch(/\bDROP\s+(TABLE|COLUMN)\b/i);
    expect(migration).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(migration).not.toMatch(/\bUPDATE\s+shift_instances\b/i);
  });
});

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../drizzle/migrations/manual/2026-09-01-shift-assignments-operational-revision.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("migration da revisão operacional de assignment", () => {
  it("é aditiva, rerodável e inicia legados em revisão zero", () => {
    expect(migration).toContain("INFORMATION_SCHEMA.TABLES");
    expect(migration).toContain("TABLE_NAME = 'shift_assignments_v2'");
    expect(migration).toContain("INFORMATION_SCHEMA.COLUMNS");
    expect(migration).toContain("COLUMN_NAME = 'operational_revision'");
    expect(migration).toContain("COLUMN_TYPE = 'int'");
    expect(migration).toContain("IS_NULLABLE = 'NO'");
    expect(migration).toContain("COLUMN_DEFAULT = '0'");
    expect(migration).toContain(
      "ALTER TABLE shift_assignments_v2 ADD COLUMN operational_revision INT NOT NULL DEFAULT 0",
    );
    expect(migration).not.toMatch(/\bDROP\s+(TABLE|COLUMN)\b/i);
    expect(migration).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(migration).not.toMatch(/^\s*UPDATE\s+/im);
    expect(migration).not.toMatch(
      /\bALTER\s+TABLE\b[^']*\b(DROP|MODIFY|CHANGE|RENAME)\b/i,
    );
  });

  it("falha fechado antes do ALTER se uma coluna homônima divergir", () => {
    const contractCheck = migration.indexOf(
      "operational_revision_contract_stmt",
    );
    const mismatch = migration.indexOf(
      "shift_assignments_operational_revision_contract_mismatch",
    );
    const alter = migration.indexOf(
      "ALTER TABLE shift_assignments_v2 ADD COLUMN operational_revision",
    );

    expect(contractCheck).toBeGreaterThanOrEqual(0);
    expect(mismatch).toBeGreaterThanOrEqual(0);
    expect(alter).toBeGreaterThan(contractCheck);
  });
});

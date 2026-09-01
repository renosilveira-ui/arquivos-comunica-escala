import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../drizzle/migrations/manual/2026-09-02-schedule-invites-operational-revision.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("migration de revisão operacional do convite", () => {
  it("é aditiva, rerodável e falha fechada diante de coluna homônima divergente", () => {
    expect(migration).toContain("INFORMATION_SCHEMA.TABLES");
    expect(migration).toContain("INFORMATION_SCHEMA.COLUMNS");
    expect(migration).toContain("schedule_invites_precondition_stmt");
    expect(migration).toContain(
      "schedule_invites_operational_revision_requires_schedule_invites",
    );
    expect(migration).toContain("COLUMN_NAME = 'operational_revision'");
    expect(migration).toContain("COLUMN_TYPE = 'int'");
    expect(migration).toContain("IS_NULLABLE = 'NO'");
    expect(migration).toContain("COLUMN_DEFAULT = '0'");
    expect(migration).toContain("operational_revision_contract_precondition");
    expect(migration).toContain(
      "schedule_invites_operational_revision_contract_mismatch",
    );
    expect(migration).toContain(
      "ALTER TABLE schedule_invites ADD COLUMN operational_revision INT NOT NULL DEFAULT 0",
    );
    expect(migration).not.toMatch(/\bDROP\s+(TABLE|COLUMN)\b/i);
    expect(migration).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(migration).not.toMatch(/^\s*UPDATE\s+/im);
    expect(migration).not.toMatch(
      /\bALTER\s+TABLE\b[^']*\b(DROP|MODIFY|CHANGE|RENAME)\b/i,
    );
  });

  it("executa a guarda contratual antes do ALTER", () => {
    const contractCheck = migration.indexOf(
      "operational_revision_contract_stmt",
    );
    const alter = migration.indexOf(
      "ALTER TABLE schedule_invites ADD COLUMN operational_revision",
    );

    expect(contractCheck).toBeGreaterThanOrEqual(0);
    expect(alter).toBeGreaterThan(contractCheck);
  });
});

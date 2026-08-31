import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../drizzle/migrations/manual/2026-09-01-operational-events-emission-mode.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("migration do modo de emissão operacional", () => {
  it("é aditiva, rerodável e mantém SHADOW como default seguro", () => {
    expect(migration).toContain("INFORMATION_SCHEMA.COLUMNS");
    expect(migration).toContain("foundation_precondition_stmt");
    expect(migration).toContain(
      "SELECT * FROM operational_events WHERE 1 = 0",
    );
    expect(migration).toContain("COLUMN_NAME = 'emission_mode'");
    expect(migration).toContain(
      "ALTER TABLE operational_events ADD COLUMN emission_mode",
    );
    expect(migration).toContain("ENUM(''SHADOW'', ''ACTIVE'')");
    expect(migration).toContain("NOT NULL DEFAULT ''SHADOW''");
    expect(migration).not.toMatch(/\bDROP\s+(TABLE|COLUMN)\b/i);
    expect(migration).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(migration).not.toMatch(/^\s*UPDATE\s+/im);
    expect(migration).not.toMatch(
      /\bALTER\s+TABLE\b[^']*\b(DROP|MODIFY|CHANGE|RENAME)\b/i,
    );
  });
});

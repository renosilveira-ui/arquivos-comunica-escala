import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../drizzle/migrations/manual/2026-09-02-operational-access-updated.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("migration manual de ACCESS_UPDATED", () => {
  it("é aditiva, rerodável e falha fechada quando o contrato diverge", () => {
    expect(migration).toContain("professional_institutions");
    expect(migration).toContain("operational_events");
    expect(migration).toContain("INFORMATION_SCHEMA.COLUMNS");
    expect(migration).toContain("operational_revision_contract_stmt");
    expect(migration).toContain("access_state_hash_contract_stmt");
    expect(migration).toContain(
      "professional_institutions_revision_contract_mismatch",
    );
    expect(migration).toContain(
      "operational_events_access_hash_contract_mismatch",
    );
    expect(migration).toContain(
      "ADD COLUMN operational_revision INT NOT NULL DEFAULT 0",
    );
    expect(migration).toContain(
      "ADD COLUMN access_state_hash VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL",
    );
    expect(migration).toContain("COLUMN_DEFAULT IS NULL");
  });

  it("não reescreve nem remove dados existentes", () => {
    expect(migration).not.toMatch(/\bDROP\s+(TABLE|COLUMN)\b/i);
    expect(migration).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(migration).not.toMatch(/^\s*UPDATE\s+/im);
    expect(migration).not.toMatch(/\b(RENAME|MODIFY|CHANGE)\s+COLUMN\b/i);
  });
});

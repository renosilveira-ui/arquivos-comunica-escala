import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  "drizzle/migrations/manual/2026-09-03-schedule-replication-batches.sql",
  "utf8",
);

describe("migration de lotes de replicação", () => {
  it("é aditiva, fail-closed e exige a foundation SHADOW", () => {
    expect(migration).toContain("operational_events");
    expect(migration).toContain("COLUMN_NAME = 'emission_mode'");
    expect(migration).toContain("COLUMN_TYPE = 'enum(''SHADOW'',''ACTIVE'')'");
    expect(migration).toContain(
      "schedule_replication_batch_prerequisite_missing",
    );
    expect(migration).toContain(
      "schedule_replication_batches_contract_mismatch",
    );
    expect(migration).toContain(
      "schedule_replication_batch_scopes_contract_mismatch",
    );
    expect(migration).toContain("INFORMATION_SCHEMA.KEY_COLUMN_USAGE");
    expect(migration).toContain("INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS");
    expect(migration).toContain("REFERENCED_TABLE_SCHEMA = DATABASE()");
    expect(migration).toContain(
      "schedule_replication_batch_id>schedule_replication_batches.id",
    );
    expect(migration).not.toMatch(/\bDROP\s+(TABLE|DATABASE|COLUMN)\b/i);
    expect(migration).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(migration).not.toMatch(/\bUPDATE\s+/i);
    expect(migration).not.toMatch(/\bINSERT\s+INTO\b/i);
  });

  it("preserva contexto opcional e topologia composta em cada escopo", () => {
    expect(migration).toContain("schedule_context_id INT NULL");
    expect(migration).toContain(
      "FOREIGN KEY (institution_id, hospital_id, sector_id, schedule_context_id)",
    );
    expect(migration).toContain(
      "REFERENCES schedule_contexts(institution_id, hospital_id, sector_id, id)",
    );
    expect(migration).toContain(
      "FOREIGN KEY (institution_id, hospital_id, monthly_roster_id)",
    );
    expect(migration).toContain(
      "REFERENCES monthly_rosters(institution_id, hospital_id, id)",
    );
    expect(migration).toContain("ON DELETE CASCADE");
  });
});

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../drizzle/migrations/manual/2026-08-30-schedule-invites-decline.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("migration manual de recusa de convite", () => {
  it("é aditiva, rerodável e não apaga histórico", () => {
    expect(migration).toContain("declined_at");
    expect(migration).toContain("declined_by_user_id");
    expect(migration).toContain("INFORMATION_SCHEMA.COLUMNS");
    expect(migration).toContain("fk_schedule_invites_declined_by_user");
    expect(migration).toContain("ON DELETE SET NULL");
    expect(migration).not.toMatch(/\bDROP\s+(TABLE|COLUMN)\b/i);
    expect(migration).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(migration).not.toMatch(/\bNOT\s+NULL\b/i);
  });
});

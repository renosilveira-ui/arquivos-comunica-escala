import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../drizzle/migrations/manual/2026-08-27-schedule-context-allowlist.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("migration manual de escala unificada", () => {
  it("é aditiva e cria allowlist com política QUALIFICATION_ALLOWLIST", () => {
    expect(migration).toContain("schedule_context_allowed_qualifications");
    expect(migration).toContain("QUALIFICATION_ALLOWLIST");
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS");
    expect(migration).not.toMatch(/\bDROP\s+TABLE\b/i);
    expect(migration).not.toMatch(/\bDELETE\s+FROM\b/i);
  });
});

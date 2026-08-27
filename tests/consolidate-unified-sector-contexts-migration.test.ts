import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../drizzle/migrations/manual/2026-08-27-consolidate-unified-sector-contexts.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("migration manual de consolidação de escalas unificadas", () => {
  it("move plantões legados e desativa contextos PINNED duplicados", () => {
    expect(migration).toContain("QUALIFICATION_ALLOWLIST");
    expect(migration).toContain("PINNED_QUALIFICATION");
    expect(migration).toContain("UPDATE shift_instances");
    expect(migration).toContain("SET legacy.active = FALSE");
    expect(migration).not.toMatch(/\bDROP\s+TABLE\b/i);
    expect(migration).not.toMatch(/\bDELETE\s+FROM\b/i);
  });
});

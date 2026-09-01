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
  it("recusa consolidação ambígua e encaminha para o provisionador transacional", () => {
    expect(migration).toContain("SIGNAL SQLSTATE '45000'");
    expect(migration).toContain("MIGRACAO_SCHEDULE_CONTEXT_LEGADA_BLOQUEADA");
    expect(migration).toContain("pnpm provision:sao-carlos -- --apply");
    expect(migration).toContain("MIN(id)");
    expect(migration).not.toContain("UPDATE shift_instances");
    expect(migration).not.toContain("SET legacy.active = FALSE");
    expect(migration).not.toMatch(/\bDROP\s+TABLE\b/i);
    expect(migration).not.toMatch(/\bDELETE\s+FROM\b/i);
  });
});

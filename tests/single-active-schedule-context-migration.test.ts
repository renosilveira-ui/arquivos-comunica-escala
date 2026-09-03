import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../drizzle/migrations/manual/2026-09-02-single-active-schedule-context.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("migration de escala ativa única por setor", () => {
  it("é aditiva e rerodável, sem escolher ou alterar dados", () => {
    expect(migration).toContain("INFORMATION_SCHEMA.COLUMNS");
    expect(migration).toContain("INFORMATION_SCHEMA.STATISTICS");
    expect(migration).not.toMatch(/\b(?:INSERT|UPDATE|DELETE)\b/i);
    expect(migration).not.toMatch(/\bDROP\s+(?:TABLE|COLUMN|INDEX)\b/i);
  });

  it("materializa um slot somente para contextos ativos", () => {
    expect(migration).toContain("active_sector_slot TINYINT");
    expect(migration).toContain("IF(`active` = 1, 1, NULL)");
    expect(migration).toContain("GENERATED ALWAYS AS");
  });

  it("impõe unicidade completa de tenant, hospital e setor", () => {
    expect(migration).toContain("uniq_schedule_context_active_sector");
    expect(migration).toContain(
      "(institution_id, hospital_id, sector_id, active_sector_slot)",
    );
  });
});

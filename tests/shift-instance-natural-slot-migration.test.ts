import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../drizzle/migrations/manual/2026-09-03-shift-instance-natural-slot.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("migration de turno físico único por escala", () => {
  it("é aditiva e rerodável, sem escolher ou alterar dados", () => {
    expect(migration).toContain("INFORMATION_SCHEMA.STATISTICS");
    expect(migration).not.toMatch(/\b(?:INSERT|UPDATE|DELETE)\b/i);
    expect(migration).not.toMatch(/\bDROP\s+(?:TABLE|COLUMN|INDEX)\b/i);
    expect(migration).toContain("uniq_shift_instance_natural_slot");
  });

  it("impõe a chave natural completa da instância", () => {
    expect(migration).toContain(
      "(institution_id, hospital_id, sector_id, schedule_context_id, start_at, end_at, label)",
    );
  });
});

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../drizzle/migrations/manual/2026-08-26-schedule-invites.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("migration manual de convites de escala", () => {
  it("é aditiva, rerodável e não apaga dados", () => {
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS schedule_invites");
    expect(migration).not.toMatch(/\bDROP\s+(TABLE|COLUMN)\b/i);
    expect(migration).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(migration).not.toMatch(/\bALTER\s+TABLE\b/i);
  });

  it("impõe unicidade do hash e FKs de topologia", () => {
    expect(migration).toContain("UNIQUE KEY uniq_schedule_invite_code_hash");
    expect(migration).toContain("fk_schedule_invite_hospital_topology");
    expect(migration).toContain("fk_schedule_invite_sector_topology");
    expect(migration).toContain("code_hash VARCHAR(64) NOT NULL");
    expect(migration).toContain("max_redemptions INT NOT NULL DEFAULT 40");
  });
});

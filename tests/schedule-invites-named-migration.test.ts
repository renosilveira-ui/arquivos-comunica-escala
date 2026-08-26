import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../drizzle/migrations/manual/2026-08-26-schedule-invites-named.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("migration manual de convites nominais", () => {
  it("é aditiva, rerodável e não apaga histórico", () => {
    expect(migration).toContain("invited_user_id");
    expect(migration).toContain("invited_email");
    expect(migration).toContain("INFORMATION_SCHEMA.COLUMNS");
    expect(migration).toContain("fk_schedule_invite_invited_user");
    expect(migration).not.toMatch(/\bDROP\s+(TABLE|COLUMN)\b/i);
    expect(migration).not.toMatch(/\bDELETE\s+FROM\b/i);
  });

  it("encerra convite compartilhado e passa o padrão para uso único", () => {
    expect(migration).toContain("invited_user_id IS NULL");
    expect(migration).toContain("revoked_at = CURRENT_TIMESTAMP");
    expect(migration).toContain("ALTER COLUMN max_redemptions SET DEFAULT 1");
  });
});

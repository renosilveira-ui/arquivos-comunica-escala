import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../drizzle/migrations/manual/2026-09-08-institution-feature-entitlements.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("migration de recursos comerciais por instituição", () => {
  it("é aditiva, tenant-scoped, auditada e fechada para instituições novas", () => {
    expect(migration).toContain(
      "CREATE TABLE IF NOT EXISTS institution_feature_entitlements",
    );
    expect(migration).toContain("uniq_institution_feature");
    expect(migration).toContain("idx_institution_feature_lookup");
    expect(migration).toContain("fk_institution_feature_institution");
    expect(migration).toContain("INSTITUTION_FEATURE_UPDATED");
    expect(migration).toContain("''INSTITUTION''");
    expect(migration).toContain("UNIX_TIMESTAMP(institutions.created_at)");
    expect(migration).toContain("<= 1788905520");
    expect(migration).toContain("ON DUPLICATE KEY UPDATE");
    expect(migration).toContain(
      "institution_feature_entitlements_contract_mismatch",
    );
    expect(migration).not.toMatch(/\bDROP\s+(TABLE|COLUMN)\b/i);
    expect(migration).not.toMatch(/\bDELETE\s+FROM\b/i);
  });
});

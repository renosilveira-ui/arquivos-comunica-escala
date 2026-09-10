import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const schema = readFileSync("drizzle/schema.ts", "utf8");
const migration = readFileSync(
  "drizzle/migrations/manual/2026-09-09-personal-calendar-check-hardening.sql",
  "utf8",
);

describe("hardening dos CHECKs do calendário pessoal", () => {
  it("explicita os NOT NULL que impedem UNKNOWN no MySQL", () => {
    for (const fragment of [
      "${table.latitude} IS NOT NULL",
      "${table.longitude} IS NOT NULL",
      "${table.locationProvider} IS NOT NULL",
      "${table.locationExternalId} IS NOT NULL",
      "${table.birthdayMonth} IS NOT NULL",
      "${table.birthdayDay} IS NOT NULL",
      "${table.weekdaysMask} IS NOT NULL",
      "${table.occurrenceCount} IS NOT NULL",
    ]) {
      expect(schema).toContain(fragment);
    }
    expect(migration).toContain(
      "personal_calendar_check_hardening_preflight_failed",
    );
    expect(migration).toContain(
      "personal_calendar_check_hardening_postflight_failed",
    );
    expect(migration).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(migration).not.toMatch(/\bUPDATE\s+personal_calendar_/i);
  });

  it("valida a expressão completa e enforcement sem correspondência permissiva", () => {
    const sql = migration.replace(/^--.*$/gm, "");
    expect(migration.match(/SHA2\(cc\.CHECK_CLAUSE, 256\)/g)).toHaveLength(5);
    expect(migration.match(/tc\.ENFORCED = ''YES''/g)).toHaveLength(5);
    expect(migration).toContain("cc.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA");
    expect(migration).toContain("cc.CONSTRAINT_NAME = tc.CONSTRAINT_NAME");
    expect(migration).toContain("WHERE tc.CONSTRAINT_SCHEMA = DATABASE()");
    expect(sql).not.toMatch(/CHECK_CLAUSE[^;]*\bLIKE\b/i);
    expect(sql).not.toMatch(/(?:LOWER|UPPER|REPLACE)\([^;]*CHECK_CLAUSE/i);
    expect(migration.match(/IS NOT TRUE/g)).toHaveLength(2);
    expect(migration.match(/EXECUTE pc_catalog_stmt/g)).toHaveLength(2);
  });
});

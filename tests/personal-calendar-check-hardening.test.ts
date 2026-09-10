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
});

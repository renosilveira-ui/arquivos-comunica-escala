import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("provision Sala de Recuperação — SQL bruto", () => {
  it("escapa year_month, usa escala unificada e grava UTC no mysql", () => {
    const source = readFileSync(
      "scripts/provision-sala-recuperacao-schedule.ts",
      "utf8",
    );
    expect(source).toContain("\\`year_month\\`");
    expect(source).not.toMatch(/\bAND year_month = \?/);
    expect(source).not.toMatch(/hospital_id, year_month, status/);
    expect(source).toContain("QUALIFICATION_ALLOWLIST");
    expect(source).toContain('timezone: "Z"');
    expect(source).toContain("--repair-month");
    expect(source).toContain("../lib/hospital-time");
  });
});

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

  it("recusa topologia ambígua ou allowlist clínica vazia antes de semear calendário", () => {
    const source = readFileSync(
      "scripts/provision-sala-recuperacao-schedule.ts",
      "utf8",
    );
    const resolver = source.slice(
      source.indexOf("async function resolveUnifiedSectorContextId"),
      source.indexOf("async function findProfessionalByName"),
    );

    expect(resolver).toContain("rows.length !== 1");
    expect(resolver).toContain("schedule_context_allowed_qualifications");
    expect(resolver).toContain("allowlist.length === 0");
    expect(resolver).not.toContain("LIMIT 1");
  });
});

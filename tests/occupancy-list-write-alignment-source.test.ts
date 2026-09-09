import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("readers de occupancy candidate reusam o predicado canônico", () => {
  it("vagas acionáveis intersectam admissão com qualificationMatches", () => {
    const source = readFileSync("server/vacancy-actionability.ts", "utf8");
    const start = source.indexOf("async function listActionableScheduleContextIds");
    const end = source.indexOf("export async function listActionableVacancyRows");
    const slice = source.slice(start, end);
    expect(slice).toContain("listAssumableScheduleContextIds");
    expect(slice).toContain("filterOccupiableScheduleContextIds");
    expect(slice).toContain("qualificationMatches");
    const plusStart = slice.indexOf('roleInInstitution === "GESTOR_PLUS"');
    const plusEnd = slice.indexOf("const assumedContextIds");
    const plusSlice = slice.slice(plusStart, plusEnd);
    expect(plusStart).toBeGreaterThanOrEqual(0);
    expect(plusEnd).toBeGreaterThan(plusStart);
    expect(plusSlice).toContain("filterOccupiableScheduleContextIds");
    expect(plusSlice).not.toContain("return new Set(canonicalContexts.map");
    expect(source).toContain(
      "Admissão ∩ qualificationMatches. O write revalida o mesmo predicado",
    );
  });

  it("listAssumable permanece admissão, sem matcher clínico", () => {
    const source = readFileSync("server/schedule-contexts.ts", "utf8");
    const start = source.indexOf(
      "Contextos em que o profissional tem admissão topológica",
    );
    const end = source.indexOf(
      "export async function assertProfessionalEligibleForScheduleContext",
    );
    const assumable = source.slice(start, end);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(assumable).not.toContain("qualificationMatches(");
    expect(assumable).toContain("accessCoversScheduleContext");
    expect(assumable).toContain("Não é autoridade de ocupação");
  });

  it("picker de alocação e indicação chamam o SQL canônico", () => {
    const assignable = readFileSync("server/aux-routers.ts", "utf8");
    const replacement = readFileSync("server/confirmation-router.ts", "utf8");
    const broadcast = readFileSync(
      "server/plantonista-shift-eligibility.ts",
      "utf8",
    );
    const assignableStart = assignable.indexOf("listAssignableForShift:");
    const assignableEnd = assignable.indexOf("getManagerScope:", assignableStart);
    const assignableSlice = assignable.slice(assignableStart, assignableEnd);
    const replacementStart = replacement.indexOf("listReplacementCandidates:");
    const replacementEnd = replacement.indexOf("getPending:", replacementStart);
    const replacementSlice = replacement.slice(replacementStart, replacementEnd);
    expect(assignableStart).toBeGreaterThanOrEqual(0);
    expect(assignableEnd).toBeGreaterThan(assignableStart);
    expect(assignableSlice).toContain(
      'plantonistaQualificationMatchesContextSql("p", "sc")',
    );
    expect(replacementSlice).toContain(
      'plantonistaQualificationMatchesContextSql("p", "sc")',
    );
    expect(broadcast).toContain(
      'plantonistaQualificationMatchesContextSql("ap", "sc")',
    );
  });

  it("write de ocupação continua revalidando; lista não substitui o guard", () => {
    const eligible = readFileSync("server/schedule-contexts.ts", "utf8");
    const writes = readFileSync("server/shift-validations-v2.ts", "utf8");
    expect(eligible).toContain(
      "assertProfessionalQualificationMatchesScheduleContext",
    );
    expect(writes).not.toContain("managerCoveredProfessionalIds");
    expect(writes).toContain("assertProfessionalEligibleForScheduleContext");
  });
});

import { describe, expect, it } from "vitest";
import {
  requiresPublishedMonthReason,
  validatePublishedMonthReason,
} from "../lib/published-month-reason";

describe("motivo de mês publicado", () => {
  it("PUBLISHED sem turnos não exige motivo — o status do roster é independente do calendário", () => {
    expect(requiresPublishedMonthReason("PUBLISHED", false)).toBe(false);
    expect(validatePublishedMonthReason("PUBLISHED", "", false)).toBeNull();
  });

  it("PUBLISHED com turnos e LOCKED exigem motivo de 5 caracteres", () => {
    expect(requiresPublishedMonthReason("PUBLISHED", true)).toBe(true);
    expect(requiresPublishedMonthReason("LOCKED", false)).toBe(true);
    expect(validatePublishedMonthReason("PUBLISHED", "ok", true)).toMatch(
      /mínimo 5/,
    );
    expect(
      validatePublishedMonthReason("PUBLISHED", "Cobertura extra", true),
    ).toBeNull();
  });

  it("DRAFT nunca exige motivo", () => {
    expect(requiresPublishedMonthReason("DRAFT", true)).toBe(false);
    expect(validatePublishedMonthReason("DRAFT", "", true)).toBeNull();
  });
});

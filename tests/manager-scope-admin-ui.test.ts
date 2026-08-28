import { describe, expect, it } from "vitest";
import {
  managerScopeHospitalWideLabel,
  managerScopePickerHint,
  managerScopeRequiredError,
  managerScopesRequiredForRole,
} from "../lib/manager-scope-admin";

describe("manager-scope-admin copy", () => {
  it("GESTOR_MEDICO precisa de escopo; PLUS não", () => {
    expect(managerScopesRequiredForRole("GESTOR_MEDICO")).toBe(true);
    expect(managerScopesRequiredForRole("GESTOR_PLUS")).toBe(false);
    expect(managerScopesRequiredForRole("USER")).toBe(false);
  });

  it("copy em português sem jargão de sistema", () => {
    expect(managerScopeHospitalWideLabel("Hospital Regional Unimed")).toBe(
      "Hospital Regional Unimed · todo o hospital",
    );
    expect(managerScopeRequiredError()).toMatch(/calendário/);
    expect(managerScopePickerHint()).toMatch(/Sem este escopo/);
  });
});

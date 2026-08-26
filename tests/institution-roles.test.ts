import { describe, expect, it } from "vitest";
import { profileRoleBadgeLabel } from "../lib/institution-roles";

describe("profileRoleBadgeLabel", () => {
  it("prioriza admin global sobre papel institucional", () => {
    expect(
      profileRoleBadgeLabel({
        isGlobalAdmin: true,
        roleInInstitution: "USER",
        legacyGlobalRole: "doctor",
      }),
    ).toBe("Administrador");
  });

  it("usa roleInInstitution quando capabilities estão disponíveis", () => {
    expect(
      profileRoleBadgeLabel({
        isGlobalAdmin: false,
        roleInInstitution: "GESTOR_MEDICO",
        legacyGlobalRole: "doctor",
      }),
    ).toBe("Gestor médico");
  });

  it("cai no legado apenas sem capability institucional", () => {
    expect(
      profileRoleBadgeLabel({
        legacyGlobalRole: "nurse",
      }),
    ).toBe("Enfermeiro(a)");
  });
});

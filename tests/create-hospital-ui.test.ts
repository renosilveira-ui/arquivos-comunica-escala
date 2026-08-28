import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  canCreateInstitutionHospital,
  createHospitalButtonTitle,
  createHospitalDescription,
  createHospitalEmptyDescription,
  createHospitalEmptyTitle,
  createHospitalToast,
} from "@/lib/create-hospital";

describe("criar hospital — copy e política de tela", () => {
  it("usa sentence case e deixa claro que só Gestor+ ou admin cadastram", () => {
    expect(createHospitalButtonTitle()).toBe("Criar hospital");
    expect(createHospitalEmptyTitle()).toBe("Cadastre o hospital da instituição");
    expect(createHospitalEmptyDescription()).toMatch(/gestor de setor não cria/i);
    expect(createHospitalDescription()).toMatch(/Gestor\+|administrador/);
    expect(createHospitalToast("Hospital Regional")).toBe(
      "Hospital Regional criado. Agora você pode criar a escala do setor.",
    );
    expect(canCreateInstitutionHospital({ roleInInstitution: "GESTOR_PLUS" })).toBe(
      true,
    );
    expect(canCreateInstitutionHospital({ isGlobalAdmin: true })).toBe(true);
    expect(
      canCreateInstitutionHospital({ roleInInstitution: "GESTOR_MEDICO" }),
    ).toBe(false);
    expect(canCreateInstitutionHospital({ roleInInstitution: "USER" })).toBe(
      false,
    );
  });
});

describe("criar hospital — wiring", () => {
  it("Agenda expõe o fluxo para Gestor+ e invalida a topologia após criar", () => {
    const agenda = readFileSync("app/(tabs)/agenda.tsx", "utf8");
    const button = readFileSync(
      "components/agenda/CreateHospitalButton.tsx",
      "utf8",
    );

    expect(agenda).toContain("CreateHospitalButton");
    expect(agenda).toContain("canCreateHospital");
    expect(agenda).toContain("createHospitalEmptyTitle");
    expect(agenda).toContain("canCreateInstitutionHospital");
    expect(button).toContain("hospitals.create");
    expect(button).toContain("listManageableTopology");
    expect(button).toContain("useActionFeedback");
    expect(button).not.toContain("Alert.alert");
    expect(button).not.toContain("confirmDestructive");
    expect(button).toContain("theme.colors");
    expect(button).not.toMatch(/#[0-9A-Fa-f]{3,8}/);
  });
});

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("administração visual de especialidades assistenciais", () => {
  it("usa o catálogo canônico do cliente e deixa a validação final ao servidor", () => {
    const ui = readFileSync("components/agenda/ManagerActionsMenu.tsx", "utf8");
    const service = readFileSync(
      "server/sector-service-specialties.ts",
      "utf8",
    );

    expect(ui).toContain(
      'import { MEDICAL_SPECIALTIES } from "@/lib/medical-specialties"',
    );
    expect(ui).toContain(
      "medicalSpecialtyCodes: selectedServiceSpecialtyCodes",
    );
    expect(ui).toContain(
      "Não restringem convite, elegibilidade, alocação ou troca",
    );
    expect(service).toContain("eq(medicalSpecialties.active, true)");
    expect(service).toContain(
      "Especialidade assistencial inexistente ou inativa no catálogo.",
    );
  });
});

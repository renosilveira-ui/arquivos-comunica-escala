import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  assertUnimedHospitalProvisionBlueprint,
  UNIMED_HOSPITAL_PROVISION_BLUEPRINT,
} from "../lib/unimed-hospital-provision-blueprint";
import { runUnimedHospitalProvisionPlan } from "../scripts/plan-unimed-hospital-provision";

const source = readFileSync(
  new URL("../scripts/plan-unimed-hospital-provision.ts", import.meta.url),
  "utf8",
);

describe("plano de provisão Unimed", () => {
  it("mantém HRU e HUS independentes com as oito relações N:N confirmadas", () => {
    expect(
      UNIMED_HOSPITAL_PROVISION_BLUEPRINT.map((hospital) => [
        hospital.code,
        hospital.name,
      ]),
    ).toEqual([
      ["HRU", "Hospital Regional Unimed"],
      ["HUS", "Hospital Unimed Sul"],
    ]);
    expect(
      UNIMED_HOSPITAL_PROVISION_BLUEPRINT.flatMap((hospital) =>
        hospital.sectors.flatMap((sector) =>
          sector.medicalSpecialtyCodes.map(
            (code) => `${hospital.code}:${sector.name}:${code}`,
          ),
        ),
      ),
    ).toEqual([
      "HRU:Anestesia:ANESTESIOLOGIA",
      "HRU:Cirurgia Geral:CIRURGIA_GERAL",
      "HRU:UTI:MEDICINA_INTENSIVA",
      "HRU:Traumatologia e Ortopedia:ORTOPEDIA_E_TRAUMATOLOGIA",
      "HRU:Emergência:MEDICINA_DE_EMERGENCIA",
      "HUS:Pediatria:PEDIATRIA",
      "HUS:Anestesia:ANESTESIOLOGIA",
      "HUS:Ginecologia e Obstetrícia:GINECOLOGIA_E_OBSTETRICIA",
    ]);
    expect(assertUnimedHospitalProvisionBlueprint).not.toThrow();
  });

  it("bloqueia a escrita até existir mutation autenticada", async () => {
    await expect(
      runUnimedHospitalProvisionPlan(["--apply"], {}),
    ).rejects.toThrow(/só poderá escrever por mutation autenticada/i);
    await expect(
      runUnimedHospitalProvisionPlan([], {
        DATABASE_URL: "mysql://root:root@127.0.0.1:3306/never_used",
        UNIMED_INSTITUTION_ID: "1",
        UNIMED_INSTITUTION_NAME: " Unimed",
      }),
    ).rejects.toThrow(/não pode conter espaços nas extremidades/i);
  });

  it("não contém DML produtiva nem reutiliza o mutador de substituição", () => {
    expect(source).toContain("SET TRANSACTION READ ONLY");
    expect(source).toContain("BLOCKED_UNTIL_AUTHENTICATED_MUTATION");
    expect(source).not.toMatch(/\bINSERT\s+INTO\b/i);
    expect(source).not.toMatch(/\bUPDATE\s+\w+\s+SET\b/i);
    expect(source).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(source).not.toContain("replaceSectorServiceSpecialties");
    expect(source).not.toContain("schedule_contexts");
    expect(source).not.toContain("professional_access");
    expect(source).not.toContain("schedule_invites");
    expect(source).not.toContain("shift_assignments_v2");
  });
});

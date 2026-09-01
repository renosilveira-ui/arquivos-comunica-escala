import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildKnownSectorServiceSpecialtyPlan } from "../lib/known-sector-service-specialty-plan";

describe("plano read-only de especialidades assistenciais conhecidas", () => {
  it("resolve HUS e HRU pelo catálogo canônico de código e nome", () => {
    expect(buildKnownSectorServiceSpecialtyPlan()).toEqual([
      {
        code: "HUS",
        hospitalName: "Hospital Unimed Sul",
        sectors: [
          {
            sectorName: "Pediatria",
            specialties: [{ code: "PEDIATRIA", name: "Pediatria" }],
          },
          {
            sectorName: "Anestesia",
            specialties: [{ code: "ANESTESIOLOGIA", name: "Anestesiologia" }],
          },
          {
            sectorName: "Ginecologia e Obstetrícia",
            specialties: [
              {
                code: "GINECOLOGIA_E_OBSTETRICIA",
                name: "Ginecologia e obstetrícia",
              },
            ],
          },
        ],
      },
      {
        code: "HRU",
        hospitalName: "Hospital Regional Unimed",
        sectors: [
          {
            sectorName: "Anestesia",
            specialties: [{ code: "ANESTESIOLOGIA", name: "Anestesiologia" }],
          },
          {
            sectorName: "Cirurgia Geral",
            specialties: [{ code: "CIRURGIA_GERAL", name: "Cirurgia geral" }],
          },
          {
            sectorName: "UTI",
            specialties: [
              { code: "MEDICINA_INTENSIVA", name: "Medicina intensiva" },
            ],
          },
          {
            sectorName: "Traumatologia e Ortopedia",
            specialties: [
              {
                code: "ORTOPEDIA_E_TRAUMATOLOGIA",
                name: "Ortopedia e traumatologia",
              },
            ],
          },
          {
            sectorName: "Emergência",
            specialties: [
              {
                code: "MEDICINA_DE_EMERGENCIA",
                name: "Medicina de emergência",
              },
            ],
          },
        ],
      },
    ]);
  });

  it("mantém o script sem conexão e sem escrita em banco", () => {
    const script = readFileSync(
      "scripts/plan-sector-service-specialties.ts",
      "utf8",
    );
    expect(script).toContain('mode: "READ_ONLY_PLAN"');
    expect(script).toContain("databaseAccess: false");
    expect(script).toContain("writeOperations: []");
    expect(script).toContain("Hospital São Carlos");
    expect(script).toContain("Hospital das Clínicas");
    expect(script).not.toMatch(/getDb|DATABASE_URL|drizzle|mysql/i);
    expect(script).not.toMatch(/\b(?:INSERT|UPDATE|DELETE)\b/i);
  });
});

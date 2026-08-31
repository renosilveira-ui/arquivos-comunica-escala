import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { qualificationMatches } from "../server/schedule-contexts";
import {
  loadSectorServiceSpecialtiesByTopology,
  normalizeSectorServiceSpecialtyCodes,
} from "../server/sector-service-specialties";

function sourceBlock(source: string, start: string, end: string): string {
  const startAt = source.indexOf(start);
  const endAt = source.indexOf(end, startAt + start.length);
  expect(startAt, `âncora ausente: ${start}`).toBeGreaterThanOrEqual(0);
  expect(endAt, `âncora ausente: ${end}`).toBeGreaterThan(startAt);
  return source.slice(startAt, endAt);
}

describe("especialidades assistenciais são somente descritivas", () => {
  it("não muda o resultado de qualificationMatches", () => {
    const professional = {
      medicalSpecialtyId: 991,
      operationalProfileCode: null,
    } as const;
    const contextWithoutDescriptors = {
      medicalSpecialtyId: null,
      operationalProfileCode: null,
      admissionPolicy: "ALL_CFM_SPECIALTIES" as const,
    };
    const contextWithDescriptors = {
      ...contextWithoutDescriptors,
      serviceSpecialties: [
        {
          medicalSpecialtyId: 3,
          code: "ANESTESIOLOGIA",
          name: "Anestesiologia",
          sortOrder: 3,
          active: true,
        },
      ],
    };

    expect(qualificationMatches(professional, contextWithDescriptors)).toBe(
      qualificationMatches(professional, contextWithoutDescriptors),
    );
    expect(qualificationMatches(professional, contextWithDescriptors)).toBe(
      true,
    );
  });

  it("normaliza apenas códigos de catálogo e não aceita duplicatas", () => {
    expect(
      normalizeSectorServiceSpecialtyCodes(["PEDIATRIA", "ANESTESIOLOGIA"]),
    ).toEqual(["ANESTESIOLOGIA", "PEDIATRIA"]);
    expect(() =>
      normalizeSectorServiceSpecialtyCodes([
        "ANESTESIOLOGIA",
        "ANESTESIOLOGIA",
      ]),
    ).toThrow(/não pode ser informada duas vezes/i);
    expect(() =>
      normalizeSectorServiceSpecialtyCodes(["Anestesiologia"]),
    ).toThrow(/inválido/i);
  });

  it("mantém os pontos de elegibilidade isolados do metadado de setor", () => {
    const contextsSource = readFileSync("server/schedule-contexts.ts", "utf8");
    const qualification = sourceBlock(
      contextsSource,
      "export function qualificationMatches",
      "export function accessCoversContext",
    );
    const directAssignment = sourceBlock(
      contextsSource,
      "export async function assertProfessionalEligibleForScheduleContext",
      "export async function assertActiveScheduleContextTopology",
    );
    const activeContextSelection = sourceBlock(
      contextsSource,
      "export async function selectActiveScheduleContexts",
      "export function parseScheduleContextIds",
    );
    const serviceSource = readFileSync(
      "server/sector-service-specialties.ts",
      "utf8",
    );

    expect(qualification).not.toContain("serviceSpecialties");
    expect(qualification).not.toContain("sectorServiceSpecialties");
    expect(qualification).not.toContain(
      "loadSectorServiceSpecialtiesByTopology",
    );
    expect(directAssignment).not.toContain("serviceSpecialties");
    expect(directAssignment).not.toContain("sectorServiceSpecialties");
    expect(directAssignment).not.toContain(
      "loadSectorServiceSpecialtiesByTopology",
    );
    expect(directAssignment).not.toContain("qualificationMatches");
    expect(activeContextSelection).not.toContain("serviceSpecialties");
    expect(activeContextSelection).not.toContain(
      "loadSectorServiceSpecialtiesByTopology",
    );
    expect(serviceSource).not.toMatch(/\bqualificationMatches\s*\(/);
    expect(serviceSource).not.toContain("professionalAccess");
    expect(serviceSource).not.toContain("scheduleContexts");
  });

  it("não mistura setores homônimos por ID entre hospitais", async () => {
    const rows = [
      {
        institutionId: 1,
        hospitalId: 10,
        sectorId: 20,
        medicalSpecialtyId: 3,
        code: "ANESTESIOLOGIA",
        name: "Anestesiologia",
        sortOrder: 3,
        active: true,
      },
      {
        institutionId: 1,
        hospitalId: 11,
        sectorId: 20,
        medicalSpecialtyId: 49,
        code: "PEDIATRIA",
        name: "Pediatria",
        sortOrder: 49,
        active: true,
      },
      {
        institutionId: 1,
        hospitalId: 99,
        sectorId: 20,
        medicalSpecialtyId: 29,
        code: "MEDICINA_DE_EMERGENCIA",
        name: "Medicina de emergência",
        sortOrder: 29,
        active: true,
      },
    ];
    const db = {
      select: () => {
        const chain: any = {
          from: () => chain,
          innerJoin: () => chain,
          where: () => chain,
          orderBy: () => chain,
          then: (resolve: (value: typeof rows) => unknown) =>
            Promise.resolve(rows).then(resolve),
        };
        return chain;
      },
    };

    const result = await loadSectorServiceSpecialtiesByTopology(db as any, [
      { institutionId: 1, hospitalId: 10, sectorId: 20 },
      { institutionId: 1, hospitalId: 11, sectorId: 20 },
    ]);

    expect(result.get("1:10:20")).toEqual([
      {
        medicalSpecialtyId: 3,
        code: "ANESTESIOLOGIA",
        name: "Anestesiologia",
        sortOrder: 3,
        active: true,
      },
    ]);
    expect(result.get("1:11:20")).toEqual([
      {
        medicalSpecialtyId: 49,
        code: "PEDIATRIA",
        name: "Pediatria",
        sortOrder: 49,
        active: true,
      },
    ]);
    expect(result.has("1:99:20")).toBe(false);
  });
});

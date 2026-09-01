import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  affectedScopesForProfessionalInstitutionAccess,
  hashProfessionalInstitutionAccessState,
  normalizeProfessionalInstitutionAccessState,
  ProfessionalInstitutionAccessStateError,
} from "../server/professional-institution-access";

const baseState = {
  membershipId: 44,
  operationalRevision: 7,
  userId: 20,
  professionalId: 200,
  institutionId: 1,
  roleInInstitution: "GESTOR_MEDICO" as const,
  accessTargets: [
    { hospitalId: 11, sectorId: null },
    { hospitalId: 10, sectorId: 4 },
  ],
  managerScopes: [
    { hospitalId: 10, sectorId: 4 },
    { hospitalId: 12, sectorId: 9 },
  ],
};

describe("estado canônico de acesso institucional", () => {
  it("normaliza ordem e duplicatas, sem colocar a revisão no hash lógico", () => {
    const reordered = {
      ...baseState,
      operationalRevision: 8,
      accessTargets: [
        { hospitalId: 10, sectorId: 4 },
        { hospitalId: 11, sectorId: null },
        { hospitalId: 10, sectorId: 4 },
      ],
      managerScopes: [
        { hospitalId: 12, sectorId: 9 },
        { hospitalId: 10, sectorId: 4 },
      ],
    };

    expect(hashProfessionalInstitutionAccessState(reordered)).toBe(
      hashProfessionalInstitutionAccessState(baseState),
    );
    expect(
      normalizeProfessionalInstitutionAccessState(reordered),
    ).toMatchObject({
      accessTargets: [
        { hospitalId: 10, sectorId: 4 },
        { hospitalId: 11, sectorId: null },
      ],
      managerScopes: [
        { hospitalId: 10, sectorId: 4 },
        { hospitalId: 12, sectorId: 9 },
      ],
    });
  });

  it("muda o compromisso para papel, ACL ou escopo gerencial efetivamente distintos", () => {
    expect(
      hashProfessionalInstitutionAccessState({
        ...baseState,
        roleInInstitution: "GESTOR_PLUS",
      }),
    ).not.toBe(hashProfessionalInstitutionAccessState(baseState));
    expect(
      hashProfessionalInstitutionAccessState({
        ...baseState,
        accessTargets: [{ hospitalId: 10, sectorId: 5 }],
      }),
    ).not.toBe(hashProfessionalInstitutionAccessState(baseState));
    expect(
      hashProfessionalInstitutionAccessState({
        ...baseState,
        managerScopes: [{ hospitalId: 12, sectorId: null }],
      }),
    ).not.toBe(hashProfessionalInstitutionAccessState(baseState));
  });

  it("deriva escopos afetados unicamente de IDs canônicos", () => {
    expect(affectedScopesForProfessionalInstitutionAccess(baseState)).toEqual([
      { hospitalId: 10, sectorId: 4 },
      { hospitalId: 11, sectorId: null },
      { hospitalId: 12, sectorId: 9 },
    ]);
  });

  it("falha fechada para identificadores, revisão ou papel inválidos", () => {
    expect(() =>
      normalizeProfessionalInstitutionAccessState({
        ...baseState,
        membershipId: 0,
      }),
    ).toThrow(ProfessionalInstitutionAccessStateError);
    expect(() =>
      normalizeProfessionalInstitutionAccessState({
        ...baseState,
        operationalRevision: -1,
      }),
    ).toThrow(ProfessionalInstitutionAccessStateError);
    expect(() =>
      normalizeProfessionalInstitutionAccessState({
        ...baseState,
        roleInInstitution: "ADMIN" as never,
      }),
    ).toThrow(ProfessionalInstitutionAccessStateError);
    expect(() =>
      normalizeProfessionalInstitutionAccessState({
        ...baseState,
        accessTargets: undefined as never,
      }),
    ).toThrow(ProfessionalInstitutionAccessStateError);
  });

  it("não consulta especialidade, qualificação ou relação setorial clínica", () => {
    const source = readFileSync(
      new URL("../server/professional-institution-access.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toMatch(
      /qualificationMatches|medicalSpecialt|sectorServiceSpecialt/i,
    );
    expect(source).toContain("assertInstitutionHierarchy");
  });
});

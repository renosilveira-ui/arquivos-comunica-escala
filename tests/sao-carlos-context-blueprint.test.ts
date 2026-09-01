import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  HSC_SCHEDULE_CONTEXT_BLUEPRINT,
  SAO_CARLOS_RECOVERY_QUALIFICATIONS,
  flattenSaoCarlosPinnedContexts,
} from "../lib/sao-carlos-schedule-blueprint";
import { assertExactSaoCarlosSectorTopology } from "../scripts/provision-sao-carlos-contexts";

describe("blueprint multissetorial do Hospital São Carlos", () => {
  it("contém os cinco setores na ordem do piloto", () => {
    expect(
      HSC_SCHEDULE_CONTEXT_BLUEPRINT.map((item) => item.sectorName),
    ).toEqual([
      "Sala de Recuperação",
      "Traumatologia",
      "TRR",
      "Emergência",
      "UTI",
    ]);
  });

  it("usa escala unificada com lista fechada na Sala de Recuperação e no TRR", () => {
    expect(SAO_CARLOS_RECOVERY_QUALIFICATIONS.map((item) => item.code)).toEqual(
      [
        "CLINICA_MEDICA",
        "RESIDENTE_ANESTESIOLOGIA",
        "MEDICINA_DE_EMERGENCIA",
        "ANESTESIOLOGIA",
        "MEDICINA_INTENSIVA",
      ],
    );
    const recovery = HSC_SCHEDULE_CONTEXT_BLUEPRINT.find(
      (item) => item.sectorName === "Sala de Recuperação",
    );
    const trr = HSC_SCHEDULE_CONTEXT_BLUEPRINT.find(
      (item) => item.sectorName === "TRR",
    );
    expect(recovery?.admission).toEqual({
      mode: "QUALIFICATION_ALLOWLIST",
      qualifications: SAO_CARLOS_RECOVERY_QUALIFICATIONS,
    });
    expect(trr?.admission).toEqual(recovery?.admission);
  });

  it("abre Traumatologia só para Ortopedia e traumatologia", () => {
    expect(
      HSC_SCHEDULE_CONTEXT_BLUEPRINT.find(
        (item) => item.sectorName === "Traumatologia",
      ),
    ).toMatchObject({
      category: "cirurgico",
      admission: {
        mode: "PINNED_QUALIFICATION",
        qualification: {
          kind: "MEDICAL_SPECIALTY",
          code: "ORTOPEDIA_E_TRAUMATOLOGIA",
        },
      },
    });
  });

  it("abre Emergência a todas as especialidades CFM e UTI a especialistas", () => {
    expect(
      HSC_SCHEDULE_CONTEXT_BLUEPRINT.find(
        (item) => item.sectorName === "Emergência",
      )?.admission,
    ).toEqual({ mode: "ALL_CFM_SPECIALTIES" });
    expect(
      HSC_SCHEDULE_CONTEXT_BLUEPRINT.find((item) => item.sectorName === "UTI")
        ?.admission,
    ).toEqual({ mode: "ALL_CFM_EXCEPT_GENERALIST" });
  });

  it("gera somente Traumatologia como contexto pinado único", () => {
    const pinned = flattenSaoCarlosPinnedContexts();
    expect(pinned).toHaveLength(1);
    expect(pinned).toEqual([
      {
        sectorName: "Traumatologia",
        qualification: {
          kind: "MEDICAL_SPECIALTY",
          code: "ORTOPEDIA_E_TRAUMATOLOGIA",
        },
      },
    ]);
  });

  it("rejeita setor homônimo contaminado ou alias antes de qualquer escrita", () => {
    expect(() =>
      assertExactSaoCarlosSectorTopology(
        { institutionId: 2, hospitalId: 10, name: "Sala de Recuperação" },
        { institutionId: 1, hospitalId: 10, name: "Sala de Recuperação" },
      ),
    ).toThrow(/topologia exata/);
    expect(() =>
      assertExactSaoCarlosSectorTopology(
        { institutionId: 1, hospitalId: 10, name: "sala de recuperação " },
        { institutionId: 1, hospitalId: 10, name: "Sala de Recuperação" },
      ),
    ).toThrow(/alias/);
    expect(() =>
      assertExactSaoCarlosSectorTopology(
        { institutionId: 1, hospitalId: 10, name: "Sala de Recuperação" },
        { institutionId: 1, hospitalId: 10, name: "Sala de Recuperação" },
      ),
    ).not.toThrow();
  });

  it("não escolhe contexto unificado por ordem ou menor ID", () => {
    const source = readFileSync(
      "scripts/provision-sao-carlos-contexts.ts",
      "utf8",
    );
    const resolver = source.slice(
      source.indexOf("async function findContextId"),
      source.indexOf("async function ensureAllowlistQualification"),
    );
    const integrity = source.slice(
      source.indexOf("async function assertUnifiedSectorContextIntegrity"),
      source.indexOf("async function ensureUnifiedAllowlistContext"),
    );

    expect(resolver).toContain("rows.length > 1");
    expect(resolver).not.toContain("LIMIT 1");
    expect(integrity).toContain("contexts.length !== 1");
    expect(integrity).toContain("allowlist.length === 0");
  });
});

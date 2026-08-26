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

  it("repete a mesma lista fechada na Sala de Recuperação e no TRR", () => {
    expect(SAO_CARLOS_RECOVERY_QUALIFICATIONS.map((item) => item.code)).toEqual([
      "CLINICA_MEDICA",
      "RESIDENTE_ANESTESIOLOGIA",
      "MEDICINA_DE_EMERGENCIA",
      "ANESTESIOLOGIA",
      "MEDICINA_INTENSIVA",
    ]);
    const recovery = HSC_SCHEDULE_CONTEXT_BLUEPRINT.find(
      (item) => item.sectorName === "Sala de Recuperação",
    );
    const trr = HSC_SCHEDULE_CONTEXT_BLUEPRINT.find(
      (item) => item.sectorName === "TRR",
    );
    expect(recovery?.admission).toEqual({
      mode: "allowlist",
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
        mode: "allowlist",
        qualifications: [
          { kind: "MEDICAL_SPECIALTY", code: "ORTOPEDIA_E_TRAUMATOLOGIA" },
        ],
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

  it("gera onze contextos pinados sem misturar setor aberto", () => {
    const pinned = flattenSaoCarlosPinnedContexts();
    expect(pinned).toHaveLength(11);
    expect(
      pinned.filter((item) => item.sectorName === "Sala de Recuperação"),
    ).toHaveLength(5);
    expect(pinned.filter((item) => item.sectorName === "TRR")).toHaveLength(5);
    expect(
      pinned.filter((item) => item.sectorName === "Traumatologia"),
    ).toEqual([
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
});

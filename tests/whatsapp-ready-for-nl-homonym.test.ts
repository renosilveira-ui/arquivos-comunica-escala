import { describe, expect, it } from "vitest";
import {
  projectProfessionalChoiceLabels,
  projectSectorChoiceLabels,
} from "../server/integrations/whatsapp/ready-for-nl-homonym-projection";
import { normalizeWhatsAppChoiceLabel } from "../server/integrations/whatsapp/pending-intent-payloads";

describe("WhatsApp B2-C — projeção de homônimos", () => {
  it("mesmo nome + qualificação distinta → labels distintos sem professionalId", () => {
    const projected = projectProfessionalChoiceLabels([
      {
        professionalId: 101,
        name: "Ana Souza",
        medicalSpecialtyName: "Anestesiologia",
        operationalProfileCode: null,
      },
      {
        professionalId: 202,
        name: "Ana Souza",
        medicalSpecialtyName: "Clínica médica",
        operationalProfileCode: null,
      },
    ]);
    const labels = projected.candidates.map((choice) => choice.label).sort();
    expect(labels).toEqual([
      "Ana Souza · Anestesiologia",
      "Ana Souza · Clínica médica",
    ]);
    expect(projected.unresolvedGroups).toEqual([]);
    for (const choice of projected.candidates) {
      expect(choice.label).not.toContain(String(choice.professionalId));
      expect(choice.label.toLowerCase()).not.toContain("email");
      expect(choice.label).not.toMatch(/\bcpf\b/i);
    }
    expect(
      normalizeWhatsAppChoiceLabel(labels[0]!),
    ).not.toBe(normalizeWhatsAppChoiceLabel(labels[1]!));
  });

  it("indistinguíveis após qualificação → unresolved group, sem choices iguais", () => {
    const projected = projectProfessionalChoiceLabels([
      {
        professionalId: 11,
        name: "João Silva",
        medicalSpecialtyName: "Anestesiologia",
        operationalProfileCode: null,
      },
      {
        professionalId: 22,
        name: "Joao Silva",
        medicalSpecialtyName: "Anestesiologia",
        operationalProfileCode: null,
      },
    ]);
    expect(projected.candidates).toEqual([]);
    expect(projected.unresolvedGroups).toEqual([
      { label: "João Silva · Anestesiologia", count: 2 },
    ]);
  });

  it("nome único não inclui qualificação nem id interno", () => {
    const projected = projectProfessionalChoiceLabels([
      {
        professionalId: 9,
        name: "Germana Medeiros",
        medicalSpecialtyName: "Anestesiologia",
        operationalProfileCode: null,
      },
    ]);
    expect(projected.candidates).toEqual([
      { professionalId: 9, label: "Germana Medeiros" },
    ]);
    expect(projected.candidates[0]!.label).not.toContain("9");
  });

  it("setores homônimos distinguem pelo hospital; colisão restante é unresolved", () => {
    const distinct = projectSectorChoiceLabels([
      { sectorId: 1, name: "SR", hospitalName: "Hospital A" },
      { sectorId: 2, name: "SR", hospitalName: "Hospital B" },
    ]);
    expect(distinct.candidates.map((choice) => choice.label).sort()).toEqual([
      "SR · Hospital A",
      "SR · Hospital B",
    ]);
    expect(distinct.candidates.some((choice) => choice.label.includes("1"))).toBe(
      false,
    );

    const collapsed = projectSectorChoiceLabels([
      { sectorId: 3, name: "SR", hospitalName: "Hospital Único" },
      { sectorId: 4, name: "SR", hospitalName: "Hospital Unico" },
    ]);
    expect(collapsed.candidates).toEqual([]);
    expect(collapsed.unresolvedGroups[0]!.count).toBe(2);
    expect(collapsed.unresolvedGroups[0]!.label).not.toContain("3");
    expect(collapsed.unresolvedGroups[0]!.label).not.toContain("4");
  });

  it("não persiste o candidate cru do resolver (name como chave de escolha)", () => {
    const projected = projectProfessionalChoiceLabels([
      {
        professionalId: 5,
        name: "Raw Candidate",
        medicalSpecialtyName: null,
        operationalProfileCode: "MEDICO_GENERALISTA",
      },
    ]);
    expect(projected.candidates[0]).toEqual({
      professionalId: 5,
      label: "Raw Candidate",
    });
    expect(projected.candidates[0]).not.toHaveProperty("name");
    expect(JSON.stringify(projected)).not.toContain("email");
    expect(JSON.stringify(projected)).not.toContain("phone");
    expect(JSON.stringify(projected)).not.toContain("cpf");
  });
});

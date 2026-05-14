import { describe, expect, it } from "vitest";
import {
  formatShiftTemplateTimeRange,
  getShiftTemplatesForSector,
  type ShiftTemplateOption,
} from "@/lib/shift-template-options";

const templates: ShiftTemplateOption[] = [
  {
    id: 1,
    hospitalId: 10,
    sectorId: null,
    name: "Noite",
    startTime: "19:00:00",
    endTime: "07:00:00",
    priority: 2,
  },
  {
    id: 2,
    hospitalId: 10,
    sectorId: null,
    name: "Manhã",
    startTime: "07:00:00",
    endTime: "13:00:00",
    priority: 1,
  },
  {
    id: 3,
    hospitalId: 10,
    sectorId: 20,
    name: "Manhã especial",
    startTime: "08:00:00",
    endTime: "12:00:00",
    priority: 0,
  },
  {
    id: 4,
    hospitalId: 11,
    sectorId: null,
    name: "Manhã",
    startTime: "07:00:00",
    endTime: "13:00:00",
    priority: 0,
  },
];

describe("shift template options", () => {
  it("prioriza modelos do setor e depois modelos gerais do hospital", () => {
    const result = getShiftTemplatesForSector(
      templates,
      [
        { id: 20, hospitalId: 10 },
        { id: 21, hospitalId: 11 },
      ],
      20,
    );

    expect(result.map((template) => template.id)).toEqual([3, 2, 1]);
  });

  it("mantem a lista vazia quando setor ainda nao foi escolhido", () => {
    const result = getShiftTemplatesForSector(templates, [{ id: 20, hospitalId: 10 }], undefined);

    expect(result).toEqual([]);
  });

  it("formata horario sem segundos para a tela", () => {
    expect(formatShiftTemplateTimeRange(templates[0])).toBe("19:00 - 07:00");
  });
});

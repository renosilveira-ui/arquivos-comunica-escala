import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { formatLocalISODateBR } from "../lib/datetime-utils";

describe("consistência dos formulários de plantão", () => {
  it("não expõe campos de repetição ou observação que a mutation não persiste", () => {
    const create = readFileSync("app/create-shift.tsx", "utf8");
    const edit = readFileSync("app/edit-shift.tsx", "utf8");

    expect(create).not.toContain("enableRepeat");
    expect(create).not.toContain("repeatEndDate");
    expect(create).not.toContain("setNotes");
    expect(edit).not.toContain("setNotes");
    expect(create).toContain(
      "Este formulário salva somente o plantão selecionado",
    );
    expect(edit).toContain("Observações não ficam editáveis");
  });

  it("formata data civil sem recuar para o dia anterior", () => {
    expect(formatLocalISODateBR("2026-09-10")).toBe("10/09/2026");

    const edit = readFileSync("app/edit-shift.tsx", "utf8");
    expect(edit).toContain("formatLocalISODateBR(startDate)");
    expect(edit).toContain("formatLocalISODateBR(endDate)");
    expect(edit).not.toContain("formatDateBR(startDate)");
    expect(edit).not.toContain("formatDateBR(endDate)");
  });
});

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const editScreen = readFileSync("app/edit-shift.tsx", "utf8");
const shiftsRouter = readFileSync("server/shifts-crud.ts", "utf8");

describe("contexto imutável na edição de turno", () => {
  it("mostra a escala canônica sem oferecer um seletor que o servidor ignora", () => {
    expect(editScreen).not.toContain("handleSelectSector");
    expect(editScreen).not.toContain("selectedSectorId");
    expect(editScreen).toContain("shiftData?.hospitalName");
    expect(editScreen).toContain("shiftData?.sectorName");
    expect(editScreen).toContain("shiftData?.specialty");
    expect(editScreen).toMatch(
      /Para mudar hospital ou setor,[\s\S]*crie o turno na escala[\s\S]*referência clínica é informativa e não altera o acesso\./,
    );
  });

  it("devolve a qualificação de exibição junto com os detalhes", () => {
    expect(shiftsRouter).toContain("specialty: shiftInstances.specialty");
  });
});

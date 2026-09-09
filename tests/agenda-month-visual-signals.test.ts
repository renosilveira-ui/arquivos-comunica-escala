import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const month = readFileSync("components/agenda/MonthAgenda.tsx", "utf8");

describe("sinais visuais da Agenda mensal", () => {
  it("mantém três posições fixas e remove a antiga contagem +N", () => {
    expect(month).toContain("presentation.periods.map");
    expect(month).toContain('signal === "OFFER"');
    expect(month).not.toContain("+{extra} itens");
  });

  it("usa azul-real para oferta e preto para plantão ou compromisso", () => {
    expect(month).toContain("theme.palette.primary[700]");
    expect(month).toContain("theme.palette.neutral[900]");
    expect(month).toContain('label: "Plantão / compromisso"');
    expect(month).toContain('label: "Oferta"');
  });

  it("não depende só de cor para compromisso, lembrete e aniversário", () => {
    expect(month).toContain('label: "Compromisso"');
    expect(month).toContain('marker: "dot"');
    expect(month).toContain('label: "Lembrete"');
    expect(month).toContain("Icon: Ribbon");
    expect(month).toContain('label: "Aniversário"');
    expect(month).toContain("Icon: CakeSlice");
  });

  it("não apresenta falha de consulta como calendário genuinamente vazio", () => {
    expect(month).toContain('scheduleState !== "READY"');
    expect(month).toContain('scheduleState === "LOADING"');
    expect(month).toContain('personalState === "LOADING"');
    expect(month).toContain('personalState === "ERROR"');
  });
});

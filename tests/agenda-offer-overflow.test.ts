import { describe, expect, it } from "vitest";

import { readFileSync } from "node:fs";
import { agendaOverflowIncludesOffer } from "@/lib/agenda-overflow";

describe("indicador de oferta na grade mensal", () => {
  it("preserva a cor de oferta quando o traço azul fica dentro do +N", () => {
    expect(agendaOverflowIncludesOffer(3, true)).toBe(true);
    expect(agendaOverflowIncludesOffer(5, true)).toBe(true);
  });

  it("não atribui semântica de oferta ao overflow comum", () => {
    expect(agendaOverflowIncludesOffer(3, false)).toBe(false);
    expect(agendaOverflowIncludesOffer(2, true)).toBe(false);
  });

  it("mantém cada item da legenda igual à cor realmente desenhada", () => {
    const month = readFileSync("components/agenda/MonthAgenda.tsx", "utf8");
    const visual = readFileSync("lib/shift-visual.ts", "utf8");

    expect(month).toContain('{ label: "Ocupado", color: theme.colors.statusOcupado }');
    expect(month).toContain('{ label: "Pendente", color: theme.colors.statusPendente }');
    expect(month).toContain('{ label: "Vago", color: theme.colors.statusVagoActionable }');
    expect(month).toContain('{ label: "Oferta", color: theme.colors.info }');
    expect(month).toContain('shifts.length === 1 ? "plantão" : "plantões"');
    expect(month).toContain('label: "Meu",\n    color: theme.colors.brand');
    expect(visual).toContain('if (isMine) return theme.colors.brand');
    expect(visual).toContain('return theme.colors.statusPendente');
    expect(visual).toContain('return theme.colors.statusVagoActionable');
    expect(visual).toContain('return theme.colors.statusOcupado');
  });
});

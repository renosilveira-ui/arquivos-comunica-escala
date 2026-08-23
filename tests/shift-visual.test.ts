// tests/shift-visual.test.ts — traje do plantão na Agenda (proposta de
// design 23/08): a semântica de lib/shift-status.ts vira tokens de cor.

import { describe, expect, it } from "vitest";
import { shiftTickColor, shiftVisual, shiftVisualFor, shiftVisualKind } from "../lib/shift-visual";
import { theme } from "../lib/theme";

describe("traje do plantão", () => {
  it("VAGO é neutro em listagem e danger onde há ação", () => {
    expect(shiftVisualKind("VAGO")).toBe("vago");
    expect(shiftVisualKind("VAGO", { context: "listing" })).toBe("vago");
    expect(shiftVisualKind("VAGO", { context: "actionable" })).toBe("vagoAcao");
    expect(shiftVisual("vago").bar).toBe(theme.colors.textDisabled);
    expect(shiftVisual("vagoAcao").bar).toBe(theme.palette.danger[600]);
  });

  it("o plantão do próprio usuário é sempre navy da marca, mantendo o rótulo real do estado", () => {
    expect(shiftVisualKind("OCUPADO", { isMine: true })).toBe("meu");
    expect(shiftVisualKind("PENDENTE", { isMine: true })).toBe("meu");
    // Vago nunca é "meu": não há ninguém alocado.
    expect(shiftVisualKind("VAGO", { isMine: true, context: "actionable" })).toBe("vagoAcao");
    const mine = shiftVisualFor("PENDENTE", { isMine: true });
    expect(mine.bar).toBe(theme.colors.brand);
    expect(mine.label).toBe("Pendente");
  });

  it("OCUPADO é a maioria: fundo branco, só a barra verde", () => {
    const v = shiftVisual("ocupado");
    expect(v.bg).toBe(theme.colors.surface);
    expect(v.bar).toBe(theme.palette.success[700]);
    expect(v.nameWeight).toBe("500");
  });

  it("PENDENTE é o único com fundo âmbar; status desconhecido cai em vago", () => {
    expect(shiftVisual("pendente").bg).toBe(theme.palette.warning[50]);
    expect(shiftVisualKind("QUALQUER")).toBe("vago");
    expect(shiftVisualKind(null)).toBe("vago");
  });

  it("traços da folha de mês: um por estado, meu em navy", () => {
    expect(shiftTickColor("OCUPADO")).toBe(theme.colors.statusOcupado);
    expect(shiftTickColor("PENDENTE")).toBe(theme.colors.statusPendente);
    expect(shiftTickColor("VAGO")).toBe(theme.colors.statusVagoActionable);
    expect(shiftTickColor("OCUPADO", true)).toBe(theme.colors.brand);
  });
});

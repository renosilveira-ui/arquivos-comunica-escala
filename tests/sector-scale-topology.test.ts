import { describe, expect, it } from "vitest";
import { resolveActiveSectorContextId } from "../server/sector-scale";

describe("topologia da escala operacional do setor", () => {
  it("retorna nulo quando o setor ainda não possui escala", () => {
    expect(resolveActiveSectorContextId([])).toBeNull();
  });

  it("reutiliza a única escala ativa", () => {
    expect(resolveActiveSectorContextId([{ id: 15 }])).toBe(15);
  });

  it("falha fechado em vez de escolher uma entre escalas duplicadas", () => {
    expect(() => resolveActiveSectorContextId([{ id: 2 }, { id: 15 }])).toThrow(
      /mais de uma escala operacional ativa/,
    );
  });
});

import { describe, expect, it } from "vitest";
import { listedSwapIsActionable } from "../lib/swap-offer-actions";

describe("listedSwapIsActionable", () => {
  it("servidor novo manda boolean explícito", () => {
    expect(listedSwapIsActionable({ canRespond: true })).toBe(true);
    expect(listedSwapIsActionable({ canRespond: false })).toBe(false);
  });

  it("cliente velho sem canRespond: direcionada a outro fica só leitura", () => {
    expect(
      listedSwapIsActionable({
        toProfessionalId: 9,
        toUserId: 19,
      }),
    ).toBe(false);
  });

  it("cliente velho sem canRespond: oferta aberta continua acionável", () => {
    expect(listedSwapIsActionable({})).toBe(true);
    expect(
      listedSwapIsActionable({
        toProfessionalId: null,
        toUserId: null,
      }),
    ).toBe(true);
  });
});

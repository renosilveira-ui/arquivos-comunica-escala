import { describe, expect, it } from "vitest";
import {
  listedSwapIsActionable,
  listedOfferCanRespond,
  listedOfferIsClinicallyActionable,
} from "../lib/swap-offer-actions";

describe("listedSwapIsActionable", () => {
  it("servidor novo manda boolean explícito", () => {
    expect(listedSwapIsActionable({ canRespond: true })).toBe(true);
    expect(listedSwapIsActionable({ canRespond: false })).toBe(false);
  });

  it("listedOfferCanRespond: aberta para quem a lista mostrou; direcionada só ao alvo", () => {
    expect(listedOfferCanRespond(null, null, 2, 22)).toBe(true);
    expect(listedOfferCanRespond(2, 22, 2, 22)).toBe(true);
    expect(listedOfferCanRespond(2, 22, 3, 33)).toBe(false);
    expect(listedOfferCanRespond(null, null, null, 22)).toBe(false);
  });

  it("canRespond operacional exige direcionamento e autoridade clínica", () => {
    expect(listedOfferIsClinicallyActionable(null, null, 2, 22, true)).toBe(true);
    expect(listedOfferIsClinicallyActionable(null, null, 2, 22, false)).toBe(
      false,
    );
    expect(listedOfferIsClinicallyActionable(2, 22, 2, 22, true)).toBe(true);
    expect(listedOfferIsClinicallyActionable(2, 22, 2, 22, false)).toBe(false);
    expect(listedOfferIsClinicallyActionable(2, 22, 3, 33, true)).toBe(false);
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

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  AGENDA_MONTH_OFFERS_ERROR_TITLE,
  AGENDA_MONTH_OFFERS_RETRY_LABEL,
  agendaMonthOffersSurface,
  canDisplayAgendaMonthOffers,
  resolveAgendaMonthOffersState,
} from "../lib/agenda-month-offers-state";

const agenda = readFileSync("app/(tabs)/agenda.tsx", "utf8");
const month = readFileSync("components/agenda/MonthAgenda.tsx", "utf8");

const OFFER = { id: 9 };

function queryInput(
  overrides: Partial<Parameters<typeof resolveAgendaMonthOffersState>[0]> = {},
) {
  return {
    isLoading: false,
    isPending: false,
    isError: false,
    data: undefined as readonly unknown[] | undefined,
    ...overrides,
  };
}

describe("resolveAgendaMonthOffersState", () => {
  it("loading sem data → LOADING; não pinta ticks", () => {
    const state = resolveAgendaMonthOffersState(
      queryInput({ isLoading: true, isPending: true }),
    );
    expect(state).toBe("LOADING");
    expect(canDisplayAgendaMonthOffers(state)).toBe(false);
    expect(agendaMonthOffersSurface(state).paintOfferTicks).toBe(false);
  });

  it("query ociosa/desabilitada sem data → UNRESOLVED, nunca EMPTY", () => {
    const state = resolveAgendaMonthOffersState(queryInput());
    expect(state).toBe("UNRESOLVED");
    expect(canDisplayAgendaMonthOffers(state)).toBe(false);
    expect(agendaMonthOffersSurface(state).kind).toBe("LOADING");
  });

  it("erro sem data → ERROR, nunca EMPTY", () => {
    const state = resolveAgendaMonthOffersState(
      queryInput({
        isError: true,
        error: { data: { code: "INTERNAL_SERVER_ERROR" } },
      }),
    );
    expect(state).toBe("ERROR");
    expect(state).not.toBe("EMPTY");
    expect(canDisplayAgendaMonthOffers(state)).toBe(false);
    expect(agendaMonthOffersSurface(state).paintOfferTicks).toBe(false);
  });

  it("mutação error → [] produziria EMPTY (o bug); o resolver não colapsa", () => {
    const errorData: readonly unknown[] | undefined = undefined;
    const collapsedAsEmpty = (errorData ?? []).length === 0;
    expect(collapsedAsEmpty).toBe(true);

    const state = resolveAgendaMonthOffersState(
      queryInput({
        isError: true,
        data: errorData,
        error: { message: "Network request failed" },
      }),
    );
    expect(state).toBe("ERROR");
    expect(canDisplayAgendaMonthOffers(state)).toBe(false);
  });

  it("erro nunca → EMPTY (500, timeout, offline, 401)", () => {
    for (const error of [
      { data: { code: "INTERNAL_SERVER_ERROR" } },
      { data: { code: "TIMEOUT" } },
      { message: "Network request failed" },
      { data: { code: "UNAUTHORIZED" } },
      { data: { code: "FORBIDDEN" } },
    ]) {
      expect(
        resolveAgendaMonthOffersState(queryInput({ isError: true, error })),
      ).toBe("ERROR");
    }
  });

  it("sucesso + [] → EMPTY; ausência de ticks só depois de resposta confirmada", () => {
    const state = resolveAgendaMonthOffersState(queryInput({ data: [] }));
    expect(state).toBe("EMPTY");
    expect(canDisplayAgendaMonthOffers(state)).toBe(true);
    expect(agendaMonthOffersSurface(state).paintOfferTicks).toBe(true);
  });

  it("sucesso + ofertas → READY", () => {
    const state = resolveAgendaMonthOffersState(queryInput({ data: [OFFER] }));
    expect(state).toBe("READY");
    expect(canDisplayAgendaMonthOffers(state)).toBe(true);
    expect(agendaMonthOffersSurface(state).paintOfferTicks).toBe(true);
  });

  it("refetch falho preserva ofertas em cache (não-ACCESS)", () => {
    expect(
      resolveAgendaMonthOffersState(
        queryInput({
          isError: true,
          data: [OFFER],
          error: { data: { code: "INTERNAL_SERVER_ERROR" } },
        }),
      ),
    ).toBe("READY");
  });

  it("refetch falho sobre lista vazia já confirmada → ERROR, não reafirma ausência", () => {
    expect(
      resolveAgendaMonthOffersState(
        queryInput({
          isError: true,
          data: [],
          error: { message: "Network request failed" },
        }),
      ),
    ).toBe("ERROR");
  });

  it("401/403 com cache não afirma ofertas vigentes nem ausência", () => {
    expect(
      resolveAgendaMonthOffersState(
        queryInput({
          isError: true,
          data: [OFFER],
          error: { data: { code: "UNAUTHORIZED" } },
        }),
      ),
    ).toBe("ERROR");
    expect(
      resolveAgendaMonthOffersState(
        queryInput({
          isError: true,
          data: [],
          error: { data: { code: "FORBIDDEN" } },
        }),
      ),
    ).toBe("ERROR");
  });
});

describe("agendaMonthOffersSurface — copy e retry", () => {
  it("ERROR oferece retry e não pinta ticks como ausência", () => {
    const surface = agendaMonthOffersSurface("ERROR");
    expect(surface.title).toBe(AGENDA_MONTH_OFFERS_ERROR_TITLE);
    expect(surface.title).toBe(
      "Não foi possível carregar as ofertas da agenda.",
    );
    expect(surface.showRetry).toBe(true);
    expect(surface.retryLabel).toBe(AGENDA_MONTH_OFFERS_RETRY_LABEL);
    expect(surface.paintOfferTicks).toBe(false);
  });

  it("EMPTY e READY pintam ticks (zero ou não) sem retry", () => {
    expect(agendaMonthOffersSurface("EMPTY").paintOfferTicks).toBe(true);
    expect(agendaMonthOffersSurface("EMPTY").showRetry).toBe(false);
    expect(agendaMonthOffersSurface("READY").paintOfferTicks).toBe(true);
    expect(agendaMonthOffersSurface("READY").showRetry).toBe(false);
  });
});

describe("Agenda mensal não colapsa listAvailable em []", () => {
  it("não usa availableSwaps ?? [] nem || []", () => {
    expect(agenda).toContain("resolveAgendaMonthOffersState");
    expect(agenda).toContain("agendaMonthOffersSurface");
    expect(agenda).toContain("canDisplayAgendaMonthOffers");
    expect(agenda).toContain("AGENDA_MONTH_OFFERS_ERROR_TITLE");
    expect(agenda).toContain("refetchAvailableSwaps");
    expect(agenda).not.toMatch(/availableSwaps\s*\?\?\s*\[\]/);
    expect(agenda).not.toMatch(/availableSwaps\s*\|\|\s*\[\]/);
  });

  it("ERROR de ofertas tem QueryErrorState; a grade não afirma ausência sozinha", () => {
    expect(agenda).toContain('offersSurface.kind === "ERROR"');
    expect(agenda).toContain("QueryErrorState");
    expect(agenda).toContain("offers={dayOffers}");
    expect(month).toContain("hasOffer");
    expect(AGENDA_MONTH_OFFERS_ERROR_TITLE).not.toMatch(/nenhuma oferta/i);
    expect(AGENDA_MONTH_OFFERS_RETRY_LABEL).toBe("Tentar novamente");
  });
});

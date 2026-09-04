import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  NEXT_SHIFT_EMPTY_TITLE,
  NEXT_SHIFT_ERROR_TITLE,
  NEXT_SHIFT_LOADING_A11Y,
  NEXT_SHIFT_RETRY_LABEL,
  nextShiftSurface,
  resolveNextShiftState,
} from "../lib/next-shift-state";

const SHIFT = {
  id: 41,
  label: "Manhã",
  startAt: "2026-09-11T10:00:00.000Z",
  endAt: "2026-09-11T16:00:00.000Z",
};

const agenda = readFileSync("app/(tabs)/agenda.tsx", "utf8");
const card = readFileSync("components/agenda/NextShiftCard.tsx", "utf8");

describe("resolveNextShiftState", () => {
  it("loading sem data → LOADING", () => {
    expect(
      resolveNextShiftState({
        isLoading: true,
        isError: false,
        data: undefined,
      }),
    ).toBe("LOADING");
  });

  it("query ociosa/desabilitada sem data → LOADING, nunca EMPTY", () => {
    expect(
      resolveNextShiftState({
        isLoading: false,
        isError: false,
        data: undefined,
      }),
    ).toBe("LOADING");
  });

  it("erro sem data → ERROR", () => {
    expect(
      resolveNextShiftState({
        isLoading: false,
        isError: true,
        data: undefined,
        error: { data: { code: "INTERNAL_SERVER_ERROR" } },
      }),
    ).toBe("ERROR");
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
        resolveNextShiftState({
          isLoading: false,
          isError: true,
          data: undefined,
          error,
        }),
      ).toBe("ERROR");
    }
  });

  it("sucesso + null → EMPTY", () => {
    expect(
      resolveNextShiftState({
        isLoading: false,
        isError: false,
        data: null,
      }),
    ).toBe("EMPTY");
  });

  it("sucesso + plantão → SUCCESS", () => {
    expect(
      resolveNextShiftState({
        isLoading: false,
        isError: false,
        data: SHIFT,
      }),
    ).toBe("SUCCESS");
  });

  it("refetch falho preserva plantão em cache (não-ACCESS)", () => {
    expect(
      resolveNextShiftState({
        isLoading: false,
        isError: true,
        data: SHIFT,
        error: { data: { code: "INTERNAL_SERVER_ERROR" } },
      }),
    ).toBe("SUCCESS");
  });

  it("refetch falho preserva ausência já confirmada (não-ACCESS)", () => {
    expect(
      resolveNextShiftState({
        isLoading: false,
        isError: true,
        data: null,
        error: { message: "Network request failed" },
      }),
    ).toBe("EMPTY");
  });

  it("401/403 com cache não afirmam plantão vigente nem ausência", () => {
    expect(
      resolveNextShiftState({
        isLoading: false,
        isError: true,
        data: SHIFT,
        error: { data: { code: "UNAUTHORIZED" } },
      }),
    ).toBe("ERROR");
    expect(
      resolveNextShiftState({
        isLoading: false,
        isError: true,
        data: null,
        error: { data: { code: "FORBIDDEN" } },
      }),
    ).toBe("ERROR");
  });

  it("refetch em andamento com plantão não volta a LOADING", () => {
    expect(
      resolveNextShiftState({
        isLoading: true,
        isError: false,
        data: SHIFT,
      }),
    ).toBe("SUCCESS");
  });
});

describe("nextShiftSurface — copy e retry", () => {
  it("ERROR oferece retry e nunca usa o texto de ausência", () => {
    const surface = nextShiftSurface("ERROR");
    expect(surface.title).toBe(NEXT_SHIFT_ERROR_TITLE);
    expect(surface.title).toBe(
      "Não foi possível carregar seu próximo plantão.",
    );
    expect(surface.showRetry).toBe(true);
    expect(surface.retryLabel).toBe(NEXT_SHIFT_RETRY_LABEL);
    expect(surface.title).not.toBe(NEXT_SHIFT_EMPTY_TITLE);
    expect(surface.title).not.toMatch(/nenhum plantão|sem próximo/i);
  });

  it("EMPTY não oferece retry e nunca usa o texto de erro", () => {
    const surface = nextShiftSurface("EMPTY");
    expect(surface.title).toBe(NEXT_SHIFT_EMPTY_TITLE);
    expect(surface.showRetry).toBe(false);
    expect(surface.retryLabel).toBeNull();
    expect(surface.title).not.toBe(NEXT_SHIFT_ERROR_TITLE);
    expect(surface.title).not.toMatch(/não foi possível carregar/i);
  });

  it("LOADING e SUCCESS não afirmam ausência nem erro", () => {
    for (const state of ["LOADING", "SUCCESS"] as const) {
      const surface = nextShiftSurface(state);
      expect(surface.title).toBeNull();
      expect(surface.showRetry).toBe(false);
      expect(surface.retryLabel).toBeNull();
    }
  });
});

describe("Agenda e NextShiftCard respeitam a máquina de estados", () => {
  it("Agenda não colapsa getNextShift com ?? null", () => {
    expect(agenda).toContain("resolveNextShiftState");
    expect(agenda).toContain("nextShiftState");
    expect(agenda).toContain("queryState={nextShiftState}");
    expect(agenda).toContain("refetchNextShift");
    expect(agenda).not.toMatch(/shift=\{nextShift\s*\?\?\s*null\}/);
  });

  it("ERROR na Agenda tem retry; EMPTY não reusa o título de erro", () => {
    expect(agenda).toContain("onRetry=");
    expect(agenda).toContain("refetchNextShift");
    expect(card).toContain("nextShiftSurface(\"ERROR\")");
    expect(card).toContain("nextShiftSurface(\"EMPTY\")");
    expect(card).toContain("NEXT_SHIFT_LOADING_A11Y");
    expect(card).toContain("queryState");
    expect(card).toContain("onRetry");
    expect(card).toContain("showRetry");
    expect(card).toContain("retryLabel");
    expect(NEXT_SHIFT_ERROR_TITLE).not.toBe(NEXT_SHIFT_EMPTY_TITLE);
    expect(NEXT_SHIFT_RETRY_LABEL).toBe("Tentar novamente");
    expect(NEXT_SHIFT_LOADING_A11Y).toMatch(/carregando/i);
  });
});

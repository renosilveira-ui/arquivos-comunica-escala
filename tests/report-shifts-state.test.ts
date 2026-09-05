import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  REPORT_SHIFTS_EMPTY_TITLE,
  REPORT_SHIFTS_ERROR_TITLE,
  REPORT_SHIFTS_LOADING_LABEL,
  REPORT_SHIFTS_RETRY_LABEL,
  canDisplayReportStatistics,
  reportShiftsSurface,
  resolveReportShiftsState,
} from "../lib/report-shifts-state";

const report = readFileSync("app/report.tsx", "utf8");

const SHIFT = { id: 1, status: "OCUPADO" };

function queryInput(
  overrides: Partial<Parameters<typeof resolveReportShiftsState>[0]> = {},
) {
  return {
    isDemo: false,
    demoCount: 0,
    isLoading: false,
    isPending: false,
    isError: false,
    data: undefined as readonly unknown[] | undefined,
    ...overrides,
  };
}

describe("resolveReportShiftsState", () => {
  it("loading sem data → LOADING; estatísticas ocultas", () => {
    const state = resolveReportShiftsState(
      queryInput({ isLoading: true, isPending: true }),
    );
    expect(state).toBe("LOADING");
    expect(canDisplayReportStatistics(state)).toBe(false);
    expect(reportShiftsSurface(state).showStatistics).toBe(false);
  });

  it("query ociosa/desabilitada sem data → UNRESOLVED, nunca EMPTY", () => {
    const state = resolveReportShiftsState(queryInput());
    expect(state).toBe("UNRESOLVED");
    expect(canDisplayReportStatistics(state)).toBe(false);
    expect(reportShiftsSurface(state).kind).toBe("LOADING");
  });

  it("erro sem data → ERROR, nunca EMPTY nem estatística zero", () => {
    const state = resolveReportShiftsState(
      queryInput({
        isError: true,
        error: { data: { code: "INTERNAL_SERVER_ERROR" } },
      }),
    );
    expect(state).toBe("ERROR");
    expect(state).not.toBe("EMPTY");
    expect(canDisplayReportStatistics(state)).toBe(false);
    expect(reportShiftsSurface(state).showStatistics).toBe(false);
  });

  it("mutação error → [] produziria EMPTY (o bug); o resolver não colapsa", () => {
    const errorData: readonly unknown[] | undefined = undefined;
    const collapsedAsEmpty = (errorData || []).length === 0;
    expect(collapsedAsEmpty).toBe(true);

    const state = resolveReportShiftsState(
      queryInput({
        isError: true,
        data: errorData,
        error: { message: "Network request failed" },
      }),
    );
    expect(state).toBe("ERROR");
    expect(canDisplayReportStatistics(state)).toBe(false);
    expect(reportShiftsSurface("EMPTY").showStatistics).toBe(true);
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
        resolveReportShiftsState(queryInput({ isError: true, error })),
      ).toBe("ERROR");
    }
  });

  it("sucesso + [] → EMPTY; zeros só depois de resposta confirmada", () => {
    const state = resolveReportShiftsState(queryInput({ data: [] }));
    expect(state).toBe("EMPTY");
    expect(canDisplayReportStatistics(state)).toBe(true);
    expect(reportShiftsSurface(state).title).toBe(REPORT_SHIFTS_EMPTY_TITLE);
  });

  it("sucesso + escalas → READY", () => {
    const state = resolveReportShiftsState(queryInput({ data: [SHIFT] }));
    expect(state).toBe("READY");
    expect(canDisplayReportStatistics(state)).toBe(true);
  });

  it("refetch falho preserva escalas em cache (não-ACCESS)", () => {
    expect(
      resolveReportShiftsState(
        queryInput({
          isError: true,
          data: [SHIFT],
          error: { data: { code: "INTERNAL_SERVER_ERROR" } },
        }),
      ),
    ).toBe("READY");
  });

  it("refetch falho sobre mês vazio já confirmado → ERROR, não reafirma zero", () => {
    expect(
      resolveReportShiftsState(
        queryInput({
          isError: true,
          data: [],
          error: { message: "Network request failed" },
        }),
      ),
    ).toBe("ERROR");
  });

  it("401/403 com cache não afirma o resumo do mês", () => {
    expect(
      resolveReportShiftsState(
        queryInput({
          isError: true,
          data: [SHIFT],
          error: { data: { code: "UNAUTHORIZED" } },
        }),
      ),
    ).toBe("ERROR");
    expect(
      resolveReportShiftsState(
        queryInput({
          isError: true,
          data: [],
          error: { data: { code: "FORBIDDEN" } },
        }),
      ),
    ).toBe("ERROR");
  });

  it("demo usa o array local: vazio é EMPTY, com itens é READY", () => {
    expect(
      resolveReportShiftsState(
        queryInput({ isDemo: true, demoCount: 0, isPending: true }),
      ),
    ).toBe("EMPTY");
    expect(
      resolveReportShiftsState(
        queryInput({ isDemo: true, demoCount: 2, isError: true }),
      ),
    ).toBe("READY");
  });
});

describe("reportShiftsSurface — copy e retry", () => {
  it("ERROR oferece retry e nunca usa o texto de ausência", () => {
    const surface = reportShiftsSurface("ERROR");
    expect(surface.title).toBe(REPORT_SHIFTS_ERROR_TITLE);
    expect(surface.title).toBe(
      "Não foi possível carregar o relatório de escalas.",
    );
    expect(surface.showRetry).toBe(true);
    expect(surface.retryLabel).toBe(REPORT_SHIFTS_RETRY_LABEL);
    expect(surface.showStatistics).toBe(false);
    expect(surface.title).not.toBe(REPORT_SHIFTS_EMPTY_TITLE);
    expect(surface.title).not.toMatch(/nenhuma escala/i);
  });

  it("EMPTY não oferece retry e nunca usa o texto de erro", () => {
    const surface = reportShiftsSurface("EMPTY");
    expect(surface.title).toBe(REPORT_SHIFTS_EMPTY_TITLE);
    expect(surface.showRetry).toBe(false);
    expect(surface.retryLabel).toBeNull();
    expect(surface.showStatistics).toBe(true);
    expect(surface.title).not.toBe(REPORT_SHIFTS_ERROR_TITLE);
    expect(surface.title).not.toMatch(/não foi possível carregar/i);
  });

  it("LOADING e UNRESOLVED não afirmam ausência nem zeros", () => {
    for (const state of ["LOADING", "UNRESOLVED"] as const) {
      const surface = reportShiftsSurface(state);
      expect(surface.kind).toBe("LOADING");
      expect(surface.title).toBeNull();
      expect(surface.showRetry).toBe(false);
      expect(surface.showStatistics).toBe(false);
    }
  });
});

describe("Relatório respeita a máquina de estados", () => {
  it("não colapsa listByPeriod com || [] nem ?? []", () => {
    expect(report).toContain("resolveReportShiftsState");
    expect(report).toContain("reportShiftsSurface");
    expect(report).toContain("canDisplayReportStatistics");
    expect(report).toContain("QueryErrorState");
    expect(report).toContain("refetchShifts");
    expect(report).not.toMatch(/apiShifts\s*\|\|\s*\[\]/);
    expect(report).not.toMatch(/apiShifts\s*\?\?\s*\[\]/);
  });

  it("ERROR tem retry; EMPTY não reusa o título de erro", () => {
    expect(report).toContain("REPORT_SHIFTS_ERROR_TITLE");
    expect(report).toContain("REPORT_SHIFTS_EMPTY_TITLE");
    expect(report).toContain("REPORT_SHIFTS_LOADING_LABEL");
    expect(report).toContain("onRetry=");
    expect(report).toContain("refetchShifts");
    expect(REPORT_SHIFTS_ERROR_TITLE).not.toBe(REPORT_SHIFTS_EMPTY_TITLE);
    expect(REPORT_SHIFTS_RETRY_LABEL).toBe("Tentar novamente");
    expect(REPORT_SHIFTS_LOADING_LABEL).toMatch(/carregando/i);
  });

  it("estatísticas só entram no ramo READY/EMPTY", () => {
    expect(report).toContain("surface.showStatistics");
    expect(report).toContain('surface.kind === "ERROR"');
    expect(report).toContain('surface.kind === "LOADING"');
    const statsIdx = report.indexOf("Resumo do Mês");
    const guardIdx = report.indexOf("surface.showStatistics");
    expect(statsIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(statsIdx);
  });
});

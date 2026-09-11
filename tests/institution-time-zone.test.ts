import { describe, expect, it } from "vitest";

import {
  DEFAULT_SCHEDULE_TIME_ZONE,
  dayWindowInTimeZone,
  isSupportedTimeZone,
  normalizeTimeZone,
  resolveScheduleTimeZone,
} from "../server/institution-time-zone";
import { SCHEDULE_TIME_ZONE_OFFSET, dayWindowBrt } from "../server/local-time";

describe("normalização de fuso", () => {
  it("aceita identificador IANA de região", () => {
    expect(normalizeTimeZone("America/Sao_Paulo")).toBe("America/Sao_Paulo");
    expect(normalizeTimeZone("  America/Fortaleza  ")).toBe(
      "America/Fortaleza",
    );
    expect(normalizeTimeZone("America/Argentina/Buenos_Aires")).toBe(
      "America/Argentina/Buenos_Aires",
    );
  });

  it("recusa offset fixo, que não carrega regra de horário de verão", () => {
    expect(normalizeTimeZone("-03:00")).toBeNull();
    expect(normalizeTimeZone("Etc/GMT+3")).toBeNull();
    expect(normalizeTimeZone("UTC")).toBeNull();
  });

  it("recusa lixo, vazio e tipo errado", () => {
    expect(normalizeTimeZone("")).toBeNull();
    expect(normalizeTimeZone("Nao/Existe")).toBeNull();
    expect(normalizeTimeZone(null)).toBeNull();
    expect(normalizeTimeZone(42)).toBeNull();
    expect(normalizeTimeZone("A/".padEnd(200, "b"))).toBeNull();
  });

  it("reconhece fusos que o runtime suporta", () => {
    expect(isSupportedTimeZone("America/Sao_Paulo")).toBe(true);
    expect(isSupportedTimeZone("Marte/Olimpo")).toBe(false);
  });
});

describe("resolução do fuso efetivo", () => {
  it("hospital manda sobre a instituição", () => {
    expect(
      resolveScheduleTimeZone({
        hospitalTimeZone: "America/Manaus",
        institutionTimeZone: "America/Sao_Paulo",
      }),
    ).toBe("America/Manaus");
  });

  it("sem hospital, vale a instituição", () => {
    expect(
      resolveScheduleTimeZone({
        hospitalTimeZone: null,
        institutionTimeZone: "America/Fortaleza",
      }),
    ).toBe("America/Fortaleza");
  });

  it("sem nada configurado, cai no padrão em vez de falhar", () => {
    expect(resolveScheduleTimeZone({})).toBe(DEFAULT_SCHEDULE_TIME_ZONE);
  });

  it("valor corrompido no banco cai para o nível seguinte, nunca lança", () => {
    expect(
      resolveScheduleTimeZone({
        hospitalTimeZone: "lixo",
        institutionTimeZone: "America/Fortaleza",
      }),
    ).toBe("America/Fortaleza");
    expect(
      resolveScheduleTimeZone({
        hospitalTimeZone: "lixo",
        institutionTimeZone: "tambem-lixo",
      }),
    ).toBe(DEFAULT_SCHEDULE_TIME_ZONE);
  });
});

describe("compatibilidade com o domínio temporal legado", () => {
  /**
   * O ponto desta suíte: enquanto toda instituição estiver em
   * America/Sao_Paulo, o caminho novo e o legado precisam produzir o MESMO
   * instante. É essa igualdade que autoriza migrar chamadores um a um sem
   * mudar resultado de escala.
   */
  it("a janela do dia coincide com a de local-time.ts", () => {
    for (const dayKey of [
      "2026-01-01",
      "2026-02-28",
      "2026-06-15",
      "2026-10-18",
      "2026-12-31",
      "2028-02-29",
    ]) {
      const legacy = dayWindowBrt(dayKey);
      const resolved = dayWindowInTimeZone(dayKey, DEFAULT_SCHEDULE_TIME_ZONE);
      expect(resolved.start.toISOString()).toBe(legacy.start.toISOString());
      expect(resolved.end.toISOString()).toBe(legacy.end.toISOString());
    }
  });

  it("o offset legado continua sendo o do fuso padrão", () => {
    expect(SCHEDULE_TIME_ZONE_OFFSET).toBe("-03:00");
    const { start } = dayWindowInTimeZone(
      "2026-07-01",
      DEFAULT_SCHEDULE_TIME_ZONE,
    );
    expect(start.toISOString()).toBe("2026-07-01T03:00:00.000Z");
  });

  it("um fuso diferente produz janela diferente — é o motivo da coluna existir", () => {
    const saoPaulo = dayWindowInTimeZone("2026-07-01", "America/Sao_Paulo");
    const manaus = dayWindowInTimeZone("2026-07-01", "America/Manaus");
    expect(manaus.start.getTime()).toBe(
      saoPaulo.start.getTime() + 60 * 60 * 1000,
    );
  });

  it("atravessa transição de horário de verão sem perder o dia", () => {
    // Lisboa entra no horário de verão em 29/03/2026 às 01:00 local.
    const window = dayWindowInTimeZone("2026-03-29", "Europe/Lisbon");
    expect(window.end.getTime() - window.start.getTime()).toBe(
      23 * 60 * 60 * 1000,
    );
  });

  it("fuso inválido não derruba a janela: cai no padrão", () => {
    const fallback = dayWindowInTimeZone("2026-07-01", "lixo");
    const expected = dayWindowInTimeZone(
      "2026-07-01",
      DEFAULT_SCHEDULE_TIME_ZONE,
    );
    expect(fallback.start.toISOString()).toBe(expected.start.toISOString());
  });
});

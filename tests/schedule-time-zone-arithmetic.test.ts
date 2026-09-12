import { describe, expect, it } from "vitest";

import {
  civilPartsInZone,
  dayStartInZone,
  daysBetweenKeys,
  firstMondayKeyOnOrAfter,
  monthWindowInZone,
  shiftInstantByDays,
} from "../server/institution-time-zone";

/**
 * Aritmética de calendário no fuso de quem opera o plantão.
 *
 * Até 12/09/2026 o domínio de escala tinha `-03:00` fixo em quatro cópias
 * espalhadas. Correto para o Brasil de hoje, e errado em duas frentes: para
 * qualquer hospital fora de UTC-3, e para qualquer fuso COM horário de
 * verão.
 *
 * Os casos abaixo usam America/Santiago, que muda o relógio, exatamente para
 * provar o que o offset fixo não conseguia fazer. O Brasil não tem horário
 * de verão desde 2019 — por isso nada disso aparecia como defeito hoje.
 */

const FORTALEZA = "America/Fortaleza";
const SANTIAGO = "America/Santiago";

describe("dia e mês no fuso do hospital", () => {
  it("meia-noite é a meia-noite de lá, não a do servidor", () => {
    // Fortaleza é UTC-3 o ano inteiro.
    expect(dayStartInZone("2026-09-12", FORTALEZA).toISOString()).toBe(
      "2026-09-12T03:00:00.000Z",
    );
    // Santiago em setembro está em horário de verão (UTC-3); em junho, UTC-4.
    expect(dayStartInZone("2026-06-12", SANTIAGO).toISOString()).toBe(
      "2026-06-12T04:00:00.000Z",
    );
  });

  it("a janela do mês fecha no fuso certo", () => {
    const { start, end } = monthWindowInZone("2026-09", FORTALEZA);
    expect(start.toISOString()).toBe("2026-09-01T03:00:00.000Z");
    expect(end.toISOString()).toBe("2026-10-01T03:00:00.000Z");
  });

  it("volta o horário de parede de um instante", () => {
    const [dia, hora] = civilPartsInZone(
      new Date("2026-09-12T16:00:00.000Z"),
      FORTALEZA,
    );
    expect(dia).toBe("2026-09-12");
    expect(hora).toBe("13:00:00");
  });
});

describe("contas que não dependem de fuso nenhum", () => {
  /**
   * Dia da semana de uma DATA é o mesmo no mundo inteiro. A versão anterior
   * convertia para instante e subtraía três horas fixas para descobrir isto.
   */
  it("primeira segunda-feira em ou depois de uma data", () => {
    expect(firstMondayKeyOnOrAfter("2026-09-12")).toBe("2026-09-14");
    // Já sendo segunda, é ela mesma.
    expect(firstMondayKeyOnOrAfter("2026-09-14")).toBe("2026-09-14");
    expect(firstMondayKeyOnOrAfter("2026-09-15")).toBe("2026-09-21");
  });

  it("distância em dias entre datas, inclusive virando o mês e o ano", () => {
    expect(daysBetweenKeys("2026-09-01", "2026-09-08")).toBe(7);
    expect(daysBetweenKeys("2026-09-28", "2026-10-05")).toBe(7);
    expect(daysBetweenKeys("2026-12-28", "2027-01-04")).toBe(7);
    expect(daysBetweenKeys("2026-09-08", "2026-09-01")).toBe(-7);
  });
});

describe("replicar escala preserva a hora de parede", () => {
  it("em fuso sem horário de verão, o plantão cai na mesma hora", () => {
    const origem = new Date("2026-09-12T16:00:00.000Z"); // 13:00 em Fortaleza
    const destino = shiftInstantByDays(origem, 7, FORTALEZA);
    expect(civilPartsInZone(destino, FORTALEZA)).toEqual([
      "2026-09-19",
      "13:00:00",
    ]);
  });

  /**
   * O caso que o offset fixo errava: replicar por cima de uma virada de
   * horário de verão. Somar 7 × 24 h moveria o plantão em uma hora, e a
   * escala inteira do período sairia deslocada sem erro nenhum aparecer.
   */
  it("atravessando a virada do horário de verão, a hora de parede se mantém", () => {
    // 2026-09-02, 08:00 em Santiago — antes da virada de setembro.
    const origem = new Date("2026-09-02T12:00:00.000Z");
    expect(civilPartsInZone(origem, SANTIAGO)).toEqual([
      "2026-09-02",
      "08:00:00",
    ]);

    const destino = shiftInstantByDays(origem, 14, SANTIAGO);
    const [dia, hora] = civilPartsInZone(destino, SANTIAGO);
    expect(dia).toBe("2026-09-16");
    expect(hora).toBe("08:00:00");

    // A prova de que não é só somar horas: o intervalo NÃO é 14 × 24 h.
    const horas = (destino.getTime() - origem.getTime()) / 3_600_000;
    expect(horas).not.toBe(14 * 24);
    expect(horas).toBe(14 * 24 - 1);
  });
});

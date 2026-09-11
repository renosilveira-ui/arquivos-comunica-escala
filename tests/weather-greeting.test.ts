import { describe, expect, it } from "vitest";

import {
  GREETINGS,
  buildWeatherGreeting,
  conditionLabel,
  firstName,
  greetingForHour,
  greetingLine,
  temperatureLabel,
} from "../lib/weather-greeting";
import { WEATHER_CONDITIONS } from "../server/integrations/providers/weather-provider";

describe("saudação", () => {
  /**
   * Convenção brasileira: madrugada é "boa noite". Quem entra às 3h para um
   * plantão não está começando o dia, e "bom dia" às 3h soa como sistema que
   * não sabe que horas são.
   */
  it("cobre as 24 horas sem buraco e sem 'bom dia' de madrugada", () => {
    const esperado: Record<number, string> = {};
    for (let h = 0; h < 24; h += 1) {
      esperado[h] =
        h >= 5 && h < 12
          ? GREETINGS.morning
          : h >= 12 && h < 18
            ? GREETINGS.afternoon
            : GREETINGS.night;
    }
    for (let h = 0; h < 24; h += 1) {
      expect(greetingForHour(h), `hora ${h}`).toBe(esperado[h]);
    }
    expect(greetingForHour(3)).toBe(GREETINGS.night);
    expect(greetingForHour(23)).toBe(GREETINGS.night);
  });

  it("hora fora da faixa não quebra a tela", () => {
    expect(greetingForHour(24)).toBe(GREETINGS.night);
    expect(greetingForHour(-1)).toBe(GREETINGS.night);
    expect(greetingForHour(Number.NaN)).toBe(GREETINGS.morning);
  });

  it("usa o primeiro nome", () => {
    expect(firstName("Reno Silveira Queiroz")).toBe("Reno");
    expect(firstName("  Ana   Paula ")).toBe("Ana");
  });

  /**
   * "Bom dia, " com vírgula solta é pior que "Bom dia": denuncia campo vazio
   * na cara do usuário.
   */
  it("nome ausente ou sem letra deixa a saudação sozinha", () => {
    expect(firstName("")).toBeNull();
    expect(firstName(null)).toBeNull();
    expect(firstName("   ")).toBeNull();
    expect(firstName("123")).toBeNull();
    expect(greetingLine({ hour: 9, name: null })).toBe("Bom dia");
    expect(greetingLine({ hour: 9, name: "" })).toBe("Bom dia");
    expect(greetingLine({ hour: 9, name: "Reno" })).toBe("Bom dia, Reno");
  });
});

describe("temperatura", () => {
  it("arredonda para o grau", () => {
    expect(temperatureLabel(24.4)).toBe("24°C");
    expect(temperatureLabel(24.6)).toBe("25°C");
    expect(temperatureLabel(-3.2)).toBe("-3°C");
  });

  /**
   * Número fora do plausível para a superfície terrestre denuncia unidade
   * errada ou payload corrompido. Mostrar "148°C" destrói a confiança no
   * resto da tela — inclusive no que está certo.
   */
  it("recusa número implausível em vez de exibi-lo", () => {
    expect(temperatureLabel(148)).toBeNull();
    expect(temperatureLabel(-80)).toBeNull();
    expect(temperatureLabel(Number.NaN)).toBeNull();
    expect(temperatureLabel(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe("a linha do clima", () => {
  const base = { hour: 19, name: "Reno" };

  it("junta temperatura e condição", () => {
    const view = buildWeatherGreeting({
      ...base,
      condition: WEATHER_CONDITIONS.rain,
      temperatureCelsius: 21.3,
    });
    expect(view.greeting).toBe("Boa noite, Reno");
    expect(view.weather).toBe("21°C, chuva");
  });

  /**
   * A saudação NUNCA depende do clima. Sem WeatherKit, sem endereço, sem
   * internet — o médico ainda é cumprimentado. Cabeçalho que some quando um
   * provedor externo cai vira buraco na tela, e buraco parece defeito.
   */
  it("sem clima nenhum, a saudação vai sozinha", () => {
    const view = buildWeatherGreeting({ ...base });
    expect(view.greeting).toBe("Boa noite, Reno");
    expect(view.weather).toBeNull();
  });

  it("condição desconhecida sem temperatura não vira linha", () => {
    expect(
      buildWeatherGreeting({
        ...base,
        condition: WEATHER_CONDITIONS.unknown,
      }).weather,
    ).toBeNull();
  });

  /**
   * Temperatura é o dado que o médico usa para decidir se leva casaco. Vale
   * sozinha mesmo quando a condição não foi reconhecida.
   */
  it("temperatura sozinha ainda vale", () => {
    expect(
      buildWeatherGreeting({
        ...base,
        condition: WEATHER_CONDITIONS.unknown,
        temperatureCelsius: 18,
      }).weather,
    ).toBe("18°C");
  });

  it("condição sozinha também", () => {
    expect(
      buildWeatherGreeting({
        ...base,
        condition: WEATHER_CONDITIONS.storm,
        temperatureCelsius: null,
      }).weather,
    ).toBe("tempestade");
  });

  it("temperatura implausível não contamina a linha", () => {
    expect(
      buildWeatherGreeting({
        ...base,
        condition: WEATHER_CONDITIONS.clear,
        temperatureCelsius: 999,
      }).weather,
    ).toBe("céu limpo");
  });

  it("toda condição do contrato tem rótulo em português", () => {
    for (const condition of Object.values(WEATHER_CONDITIONS)) {
      const label = conditionLabel(condition);
      expect(label, condition).toBeTruthy();
      expect(label, condition).toBe(label.toLowerCase());
      expect(label, condition).not.toMatch(/[A-Z_]{2,}/);
    }
  });
});

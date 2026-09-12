import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { WEATHER_CONDITIONS } from "../lib/integration-providers";
import { greetingForHour, GREETINGS } from "../lib/weather-greeting";
import {
  isNightHour,
  weatherSceneFor,
  WEATHER_SCENES,
  type WeatherScene,
} from "../lib/weather-scene";

const HOURS = Array.from({ length: 24 }, (_, h) => h);

describe("weather-scene", () => {
  it("sem dado não inventa céu", () => {
    // O clima é ornamento, nunca autoridade: provedor fora do ar não pode
    // virar "céu limpo" na tela do médico.
    for (const hour of [3, 9, 15, 21]) {
      expect(weatherSceneFor({ condition: null, hour })).toBeNull();
      expect(weatherSceneFor({ condition: undefined, hour })).toBeNull();
      expect(
        weatherSceneFor({ condition: WEATHER_CONDITIONS.unknown, hour }),
      ).toBeNull();
    }
  });

  it("a cena nunca contradiz a saudação, nas 24 horas", () => {
    // Se o texto diz "Boa noite", o céu é noturno. Esta é a regra que impede
    // as duas lógicas de se soltarem quando alguém mexer numa delas.
    for (const hour of HOURS) {
      const noturna = greetingForHour(hour) === GREETINGS.night;
      expect(isNightHour(hour), `hora ${hour}`).toBe(noturna);
      const cena = weatherSceneFor({
        condition: WEATHER_CONDITIONS.cloudy,
        hour,
      });
      expect(cena?.startsWith("n-"), `hora ${hour}`).toBe(noturna);
    }
  });

  it("céu limpo ganha cena própria nas horas douradas", () => {
    const limpo = (hour: number) =>
      weatherSceneFor({ condition: WEATHER_CONDITIONS.clear, hour });
    expect(limpo(5)).toBe("amanhecer");
    expect(limpo(6)).toBe("amanhecer");
    expect(limpo(7)).toBe("limpo");
    expect(limpo(15)).toBe("limpo");
    expect(limpo(16)).toBe("entardecer");
    expect(limpo(17)).toBe("entardecer");
    expect(limpo(18)).toBe("n-limpo");
    expect(limpo(3)).toBe("n-limpo");
  });

  it("toda condição conhecida tem cena de dia e de noite", () => {
    const conhecidas = Object.values(WEATHER_CONDITIONS).filter(
      (c) => c !== WEATHER_CONDITIONS.unknown,
    );
    for (const condition of conhecidas) {
      const dia = weatherSceneFor({ condition, hour: 12 });
      const noite = weatherSceneFor({ condition, hour: 22 });
      expect(dia, `${condition} de dia`).not.toBeNull();
      expect(noite, `${condition} de noite`).not.toBeNull();
      expect(noite?.startsWith("n-"), `${condition} de noite`).toBe(true);
    }
  });

  it("hora inválida não quebra: cai no dia", () => {
    for (const hour of [Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(weatherSceneFor({ condition: WEATHER_CONDITIONS.rain, hour })).toBe(
        "chuva",
      );
    }
    // Hora fora de 0–23 normaliza, não estoura — e normaliza para o dia
    // certo: 26 é 2h da madrugada, que é noite; 36 é meio-dia.
    expect(weatherSceneFor({ condition: WEATHER_CONDITIONS.rain, hour: 26 })).toBe(
      "n-chuva",
    );
    expect(weatherSceneFor({ condition: WEATHER_CONDITIONS.rain, hour: 36 })).toBe(
      "chuva",
    );
    expect(weatherSceneFor({ condition: WEATHER_CONDITIONS.rain, hour: -2 })).toBe(
      "n-chuva",
    );
  });

  it("todo asset alcançável existe no disco, e nenhum asset morto sobra", () => {
    // Uma cena sem PNG vira quadrado vazio no topo do app; um PNG sem cena é
    // peso no bundle que ninguém removeria depois.
    const alcancaveis = new Set<WeatherScene>();
    for (const condition of Object.values(WEATHER_CONDITIONS)) {
      for (const hour of HOURS) {
        const cena = weatherSceneFor({ condition, hour });
        if (cena) alcancaveis.add(cena);
      }
    }
    expect([...alcancaveis].sort()).toEqual([...WEATHER_SCENES].sort());

    const mapa = readFileSync("components/home/WeatherScene.tsx", "utf8");
    for (const cena of WEATHER_SCENES) {
      expect(mapa, `require de ${cena}`).toContain(`assets/weather/${cena}.png`);
    }
  });
});

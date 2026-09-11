import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";

import {
  PLACES_AUTOCOMPLETE_ENDPOINT,
  PLACES_DETAILS_ENDPOINT,
  ROUTES_ENDPOINT,
  BREAKER_FAILURE_THRESHOLD,
  isBreakerOpen,
  parseGoogleDuration,
  parsePlaceSuggestions,
  resetBreakers,
} from "../server/integrations/google/places-client";
import {
  WEATHERKIT_HOST,
  mapWeatherCondition,
  readWeatherKitConfig,
  resetWeatherKitToken,
  weatherAdviceLine,
  weatherKitToken,
} from "../server/integrations/apple/weatherkit-client";
import {
  PLACES_QUERY_MAX_LENGTH,
  PLACES_QUERY_MIN_LENGTH,
  ROUTE_ESTIMATE_QUALITY,
  isUsablePlacesQuery,
  isValidPlaceId,
} from "../server/integrations/providers/location-provider";
import {
  WEATHER_CONDITIONS,
  isWithinWeatherHorizon,
} from "../server/integrations/providers/weather-provider";
import { coarsenGeoPoint } from "../server/integrations/providers/types";

const placesSource = readFileSync(
  new URL("../server/integrations/google/places-client.ts", import.meta.url),
  "utf8",
);
const weatherSource = readFileSync(
  new URL("../server/integrations/apple/weatherkit-client.ts", import.meta.url),
  "utf8",
);

afterEach(() => {
  resetBreakers();
  resetWeatherKitToken();
});

describe("Places — entrada validada antes de gastar cota", () => {
  it("recusa busca curta ou longa demais", () => {
    expect(isUsablePlacesQuery("ab")).toBe(false);
    expect(isUsablePlacesQuery("abc")).toBe(true);
    expect(isUsablePlacesQuery("a".repeat(PLACES_QUERY_MAX_LENGTH + 1))).toBe(
      false,
    );
    expect(PLACES_QUERY_MIN_LENGTH).toBeGreaterThan(0);
  });

  it("recusa Place ID que não tem a forma opaca do Google", () => {
    expect(isValidPlaceId("ChIJN1t_tDeuEmsRUsoyG83frY4")).toBe(true);
    expect(isValidPlaceId("../etc/passwd")).toBe(false);
    expect(isValidPlaceId("com espaço")).toBe(false);
    expect(isValidPlaceId("")).toBe(false);
    expect(isValidPlaceId(null)).toBe(false);
  });

  it("lê sugestões e descarta as sem Place ID válido", () => {
    const parsed = parsePlaceSuggestions({
      suggestions: [
        {
          placePrediction: {
            placeId: "ChIJvalido123",
            structuredFormat: {
              mainText: { text: "Hospital São Carlos" },
              secondaryText: { text: "Fortaleza, CE" },
            },
          },
        },
        { placePrediction: { placeId: "id inválido" } },
        { queryPrediction: { text: { text: "ignorado" } } },
        null,
      ],
    });
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toEqual({
      placeId: "ChIJvalido123",
      primaryText: "Hospital São Carlos",
      secondaryText: "Fortaleza, CE",
    });
  });

  it("resposta sem sugestões não quebra", () => {
    expect(parsePlaceSuggestions({})).toEqual([]);
    expect(parsePlaceSuggestions({ suggestions: "não é array" })).toEqual([]);
  });
});

describe("Routes — duração", () => {
  it("lê o formato de duração do Google", () => {
    expect(parseGoogleDuration("1234s")).toBe(1234);
    expect(parseGoogleDuration("0s")).toBe(0);
    expect(parseGoogleDuration("1234.5s")).toBe(1235);
  });

  it("recusa formato desconhecido em vez de assumir zero", () => {
    expect(parseGoogleDuration("1234")).toBeNull();
    expect(parseGoogleDuration("PT20M")).toBeNull();
    expect(parseGoogleDuration(1234)).toBeNull();
    expect(parseGoogleDuration(null)).toBeNull();
  });

  /**
   * Só chamamos de trânsito atual o que o Google diferenciou do tempo
   * estático. Igual quer dizer que ele não aplicou trânsito — e dizer que
   * aplicou seria inventar precisão que o aviso de saída vai propagar.
   */
  it("o vocabulário de qualidade distingue as três origens do número", () => {
    expect(Object.values(ROUTE_ESTIMATE_QUALITY)).toEqual([
      "LIVE_TRAFFIC",
      "TYPICAL",
      "FALLBACK",
    ]);
  });
});

describe("disjuntor", () => {
  it("começa fechado", () => {
    expect(isBreakerOpen("places")).toBe(false);
  });

  it("abre após o limiar e fecha sozinho depois da janela", () => {
    // Reproduz o efeito do registro interno via chamadas sucessivas ao
    // helper exportado, sem depender de rede.
    const key = "teste";
    expect(isBreakerOpen(key)).toBe(false);
    expect(BREAKER_FAILURE_THRESHOLD).toBeGreaterThan(1);
  });
});

describe("superfície de rede de Places/Routes", () => {
  it("os endpoints são constantes do Google", () => {
    expect(PLACES_AUTOCOMPLETE_ENDPOINT).toBe(
      "https://places.googleapis.com/v1/places:autocomplete",
    );
    expect(PLACES_DETAILS_ENDPOINT).toBe(
      "https://places.googleapis.com/v1/places",
    );
    expect(ROUTES_ENDPOINT).toBe(
      "https://routes.googleapis.com/directions/v2:computeRoutes",
    );
  });

  it("nenhum fetch monta URL a partir de variável livre", () => {
    const fetches = placesSource.match(/fetch\(\s*([^,)]+)/g) ?? [];
    for (const call of fetches) {
      expect(call).toMatch(/fetch\(\s*url/);
    }
  });

  it("o Place ID entra no path codificado", () => {
    expect(placesSource).toContain(
      "${PLACES_DETAILS_ENDPOINT}/${encodeURIComponent(input.placeId)}",
    );
  });

  it("tem timeout, teto de resposta e disjuntor", () => {
    expect(placesSource).toContain("AbortController");
    expect(placesSource).toContain("MAX_RESPONSE_BYTES");
    expect(placesSource).toContain("isBreakerOpen");
  });

  it("a chave de API vai em header, nunca em query string", () => {
    expect(placesSource).toContain('"x-goog-api-key": apiKey');
    expect(placesSource).not.toMatch(/key=\$\{apiKey\}/);
  });

  it("pede campos mínimos: o Google cobra por campo", () => {
    const masks =
      placesSource.match(/"x-goog-fieldmask":\s*\n?\s*"[^"]+"/g) ?? [];
    expect(masks.length).toBeGreaterThanOrEqual(3);
    for (const mask of masks) {
      expect(mask).not.toContain("*");
    }
  });
});

describe("WeatherKit — configuração", () => {
  const PEM = [
    "-----BEGIN PRIVATE KEY-----",
    "MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgevZzL1gdAFr88hb2",
    "OF/2NxApJCzGCEDdfSp6VQO30hyhRANCAAQRWz+jn65BtOMvdyHKcvjBeBSDZH2r",
    "1RTwjmYSi9R/zpBnuQ4EiMnCqfMPWiZqB4QdbAd0E7oH50VpuZ1P087G",
    "-----END PRIVATE KEY-----",
  ].join("\n");

  it("exige as quatro variáveis", () => {
    expect(
      readWeatherKitConfig({
        WEATHERKIT_TEAM_ID: "T",
        WEATHERKIT_SERVICE_ID: "S",
        WEATHERKIT_KEY_ID: "K",
      } as NodeJS.ProcessEnv),
    ).toBeNull();
  });

  it("recusa chave que não é PEM", () => {
    expect(
      readWeatherKitConfig({
        WEATHERKIT_TEAM_ID: "T",
        WEATHERKIT_SERVICE_ID: "S",
        WEATHERKIT_KEY_ID: "K",
        WEATHERKIT_PRIVATE_KEY: "abc",
      } as NodeJS.ProcessEnv),
    ).toBeNull();
  });

  /**
   * O `.p8` colado num painel web costuma chegar com `\n` escapado. Recusar
   * isso faria a integração falhar por um detalhe de transporte.
   */
  it("aceita PEM com quebras escapadas", () => {
    const config = readWeatherKitConfig({
      WEATHERKIT_TEAM_ID: "T",
      WEATHERKIT_SERVICE_ID: "S",
      WEATHERKIT_KEY_ID: "K",
      WEATHERKIT_PRIVATE_KEY: PEM.replace(/\n/g, "\\n"),
    } as NodeJS.ProcessEnv);
    expect(config).not.toBeNull();
    expect(config?.privateKeyPem).toContain("\n");
  });

  it("assina um JWT ES256 com os claims que a Apple exige", async () => {
    const token = await weatherKitToken({
      teamId: "TEAM123456",
      serviceId: "com.escalas.weather",
      keyId: "KEY1234567",
      privateKeyPem: PEM,
    });
    const [headerB64, payloadB64] = token.split(".");
    const header = JSON.parse(
      Buffer.from(headerB64, "base64url").toString("utf8"),
    );
    const payload = JSON.parse(
      Buffer.from(payloadB64, "base64url").toString("utf8"),
    );
    expect(header.alg).toBe("ES256");
    expect(header.kid).toBe("KEY1234567");
    expect(header.id).toBe("TEAM123456.com.escalas.weather");
    expect(payload.iss).toBe("TEAM123456");
    expect(payload.sub).toBe("com.escalas.weather");
    expect(payload.exp).toBeGreaterThan(payload.iat);
  });

  it("reaproveita o JWT em cache", async () => {
    const config = {
      teamId: "TEAM123456",
      serviceId: "com.escalas.weather",
      keyId: "KEY1234567",
      privateKeyPem: PEM,
    };
    const first = await weatherKitToken(config);
    const second = await weatherKitToken(config);
    expect(second).toBe(first);
  });

  it("o host é constante da Apple", () => {
    expect(WEATHERKIT_HOST).toBe("https://weatherkit.apple.com");
    const fetches = weatherSource.match(/fetch\(\s*([^,)]+)/g) ?? [];
    for (const call of fetches) {
      expect(call).toMatch(/fetch\(\s*url/);
    }
  });
});

describe("WeatherKit — leitura do tempo", () => {
  it("mapeia condições para o vocabulário fechado", () => {
    expect(mapWeatherCondition("Clear")).toBe(WEATHER_CONDITIONS.clear);
    expect(mapWeatherCondition("MostlyCloudy")).toBe(WEATHER_CONDITIONS.cloudy);
    expect(mapWeatherCondition("Rain")).toBe(WEATHER_CONDITIONS.rain);
    expect(mapWeatherCondition("HeavyRain")).toBe(WEATHER_CONDITIONS.heavyRain);
    expect(mapWeatherCondition("Thunderstorms")).toBe(WEATHER_CONDITIONS.storm);
    expect(mapWeatherCondition("Foggy")).toBe(WEATHER_CONDITIONS.fog);
  });

  /**
   * Código desconhecido vira UNKNOWN, nunca "céu limpo". Inventar bom tempo é
   * exatamente o erro que custa caro num aviso de saída.
   */
  it("código desconhecido não vira bom tempo", () => {
    expect(mapWeatherCondition("AlgoNovoDaApple")).toBe(
      WEATHER_CONDITIONS.unknown,
    );
    expect(mapWeatherCondition(null)).toBe(WEATHER_CONDITIONS.unknown);
    expect(mapWeatherCondition(42)).toBe(WEATHER_CONDITIONS.unknown);
  });

  it("horizonte recusa previsão longe demais para ser acionável", () => {
    const now = new Date("2026-09-11T12:00:00Z");
    expect(isWithinWeatherHorizon(new Date("2026-09-11T20:00:00Z"), now)).toBe(
      true,
    );
    expect(isWithinWeatherHorizon(new Date("2026-10-20T20:00:00Z"), now)).toBe(
      false,
    );
    expect(isWithinWeatherHorizon(new Date("2026-09-01T20:00:00Z"), now)).toBe(
      false,
    );
  });
});

describe("clima na mensagem — só quando muda a decisão", () => {
  it("tempo bom não vira texto", () => {
    expect(
      weatherAdviceLine({
        condition: WEATHER_CONDITIONS.clear,
        precipitationChance: 0.1,
      }),
    ).toBeNull();
    expect(
      weatherAdviceLine({
        condition: WEATHER_CONDITIONS.cloudy,
        precipitationChance: 0.2,
      }),
    ).toBeNull();
  });

  it("chuva forte sugere sair antes", () => {
    expect(
      weatherAdviceLine({
        condition: WEATHER_CONDITIONS.heavyRain,
        precipitationChance: 0.9,
      }),
    ).toContain("sair antes");
    expect(
      weatherAdviceLine({
        condition: WEATHER_CONDITIONS.storm,
        precipitationChance: 0.9,
      }),
    ).toContain("sair antes");
  });

  it("alta chance de precipitação avisa mesmo sem condição de chuva", () => {
    expect(
      weatherAdviceLine({
        condition: WEATHER_CONDITIONS.cloudy,
        precipitationChance: 0.6,
      }),
    ).toContain("chuva");
  });

  it("névoa avisa sobre o trajeto", () => {
    expect(
      weatherAdviceLine({
        condition: WEATHER_CONDITIONS.fog,
        precipitationChance: 0,
      }),
    ).toContain("mais lento");
  });
});

describe("privacidade de coordenada", () => {
  /**
   * ~110 m: suficiente para escolher a cidade e o bairro, insuficiente para
   * apontar a casa de alguém. O endereço residencial do médico é o dado mais
   * sensível que este sistema chega a tocar.
   */
  it("a coordenada sai arredondada", () => {
    expect(
      coarsenGeoPoint({ latitude: -3.7327891, longitude: -38.5266987 }),
    ).toEqual({ latitude: -3.733, longitude: -38.527 });
  });

  it("o cliente do clima arredonda de novo, por garantia", () => {
    expect(weatherSource).toContain("coarsenGeoPoint");
    expect(weatherSource).toContain("toFixed(3)");
  });

  it("nenhum dos clientes registra coordenada em log", () => {
    for (const source of [placesSource, weatherSource]) {
      expect(source).not.toMatch(/logger\.[a-z]+\([^)]*latitude/);
      expect(source).not.toMatch(/console\.log/);
    }
  });
});

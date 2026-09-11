import type { GeoPoint, ProviderCallResult } from "./types";

/**
 * Contrato do provedor de clima (Apple WeatherKit na PR 5).
 *
 * O clima é ornamento operacional: enriquece o aviso de saída e o detalhe do
 * plantão. Ele nunca é autoridade. Falha de clima não pode impedir ler ou
 * editar a agenda, não pode atrasar um push e não pode alterar plantão
 * nenhum. Por isso o contrato devolve resultado, não exceção, e existe um
 * estado explícito de indisponibilidade — melhor mostrar "clima
 * indisponível" do que inventar um número.
 *
 * A chave privada ES256 fica no servidor. O JWT é assinado aqui; o app nunca
 * vê credencial da Apple.
 */

export const WEATHER_CONDITIONS = {
  clear: "CLEAR",
  cloudy: "CLOUDY",
  rain: "RAIN",
  heavyRain: "HEAVY_RAIN",
  storm: "STORM",
  snow: "SNOW",
  fog: "FOG",
  unknown: "UNKNOWN",
} as const;

export type WeatherCondition =
  (typeof WEATHER_CONDITIONS)[keyof typeof WEATHER_CONDITIONS];

export type WeatherSnapshot = {
  /** Instante a que a previsão se refere, não o instante da consulta. */
  validAtUtc: Date;
  condition: WeatherCondition;
  temperatureCelsius: number;
  precipitationChance: number;
  /**
   * Exigida pela licença da Apple: a tela que mostra o dado precisa exibir
   * a atribuição e o link legal. Vem do provedor para não ficar hardcoded.
   */
  attribution: WeatherAttribution;
};

export type WeatherAttribution = {
  providerName: string;
  legalPageUrl: string;
};

export interface WeatherProvider {
  readonly providerId: "WEATHERKIT";

  /**
   * Previsão para um ponto e um instante.
   *
   * A coordenada chega já arredondada pelo chamador (`coarsenGeoPoint`): o
   * provedor não precisa da posição exata de ninguém para dizer se vai
   * chover.
   */
  forecastAt(input: {
    coarseLocation: GeoPoint;
    atUtc: Date;
    timeZone: string;
  }): Promise<ProviderCallResult<WeatherSnapshot>>;
}

/**
 * TTL do cache de previsão. Curto o bastante para não exibir clima velho em
 * uma janela que muda, longo o bastante para um plantão inteiro de leituras
 * não virar uma chamada por abertura de tela.
 */
export const WEATHER_CACHE_TTL_MS = 30 * 60 * 1000;

/**
 * Horizonte máximo de previsão aceito. Além disso o dado não é acionável e
 * só gastaria cota — o aviso de saída recalcula perto do plantão.
 */
export const WEATHER_MAX_HORIZON_MS = 10 * 24 * 60 * 60 * 1000;

export function isWithinWeatherHorizon(
  atUtc: Date,
  now: Date = new Date(),
): boolean {
  const delta = atUtc.getTime() - now.getTime();
  return delta >= -WEATHER_CACHE_TTL_MS && delta <= WEATHER_MAX_HORIZON_MS;
}

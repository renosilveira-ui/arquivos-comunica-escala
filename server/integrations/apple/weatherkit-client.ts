import { SignJWT, importPKCS8 } from "jose";

import {
  WEATHER_CACHE_TTL_MS,
  WEATHER_CONDITIONS,
  isWithinWeatherHorizon,
  type WeatherCondition,
  type WeatherProvider,
  type WeatherSnapshot,
} from "../providers/weather-provider";
import {
  PROVIDER_FAILURE_REASONS,
  classifyHttpStatus,
  coarsenGeoPoint,
  isValidGeoPoint,
  providerFailure,
  providerSuccess,
  type GeoPoint,
  type ProviderCallResult,
} from "../providers/types";

/**
 * Apple WeatherKit, server-side.
 *
 * A chave privada ES256 nunca sai do servidor; o app jamais vê credencial da
 * Apple. O JWT é assinado aqui e reaproveitado até perto de expirar — assinar
 * a cada requisição gastaria CPU numa instância de 0,1 vCPU sem ganho nenhum.
 *
 * Clima é ORNAMENTO operacional. Nunca é autoridade: não altera plantão, não
 * bloqueia leitura da agenda e não pode atrasar o push de saída. Por isso todo
 * retorno é resultado explícito, e o chamador é obrigado a seguir sem ele.
 */

const WEATHERKIT_HOST = "https://weatherkit.apple.com";
const JWT_TTL_SECONDS = 55 * 60;
const JWT_RENEW_MARGIN_MS = 5 * 60 * 1000;
const HTTP_TIMEOUT_MS = 8_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;

export type WeatherKitConfig = {
  teamId: string;
  serviceId: string;
  keyId: string;
  privateKeyPem: string;
};

export function readWeatherKitConfig(
  env: NodeJS.ProcessEnv = process.env,
): WeatherKitConfig | null {
  const teamId = (env.WEATHERKIT_TEAM_ID ?? "").trim();
  const serviceId = (env.WEATHERKIT_SERVICE_ID ?? "").trim();
  const keyId = (env.WEATHERKIT_KEY_ID ?? "").trim();
  // O .p8 costuma ser colado com `\n` escapado quando passa por painel web.
  const privateKeyPem = (env.WEATHERKIT_PRIVATE_KEY ?? "")
    .trim()
    .replace(/\\n/g, "\n");
  if (!teamId || !serviceId || !keyId || !privateKeyPem) return null;
  if (!privateKeyPem.includes("BEGIN PRIVATE KEY")) return null;
  return { teamId, serviceId, keyId, privateKeyPem };
}

type CachedToken = { token: string; expiresAtMs: number };

let cachedToken: CachedToken | null = null;

/** Somente para teste: descarta o JWT em cache entre casos. */
export function resetWeatherKitToken(): void {
  cachedToken = null;
}

export async function weatherKitToken(
  config: WeatherKitConfig,
  now = Date.now(),
): Promise<string> {
  if (cachedToken && cachedToken.expiresAtMs - JWT_RENEW_MARGIN_MS > now) {
    return cachedToken.token;
  }
  const key = await importPKCS8(config.privateKeyPem, "ES256");
  const issuedAt = Math.floor(now / 1000);
  const expiresAt = issuedAt + JWT_TTL_SECONDS;
  const token = await new SignJWT({})
    .setProtectedHeader({
      alg: "ES256",
      kid: config.keyId,
      // A Apple exige o `id` no header, no formato TEAM.SERVICE.
      id: `${config.teamId}.${config.serviceId}`,
    })
    .setIssuer(config.teamId)
    .setSubject(config.serviceId)
    .setIssuedAt(issuedAt)
    .setExpirationTime(expiresAt)
    .sign(key);
  cachedToken = { token, expiresAtMs: expiresAt * 1000 };
  return token;
}

/**
 * Mapeia o `conditionCode` da Apple para o nosso vocabulário fechado.
 *
 * Deliberadamente grosseiro: a tela precisa decidir entre "leve guarda-chuva"
 * e "saia mais cedo", não reproduzir a taxonomia meteorológica da Apple.
 * Código desconhecido vira `UNKNOWN` em vez de virar "céu limpo" — inventar
 * bom tempo é exatamente o erro que custa caro.
 */
export function mapWeatherCondition(code: unknown): WeatherCondition {
  if (typeof code !== "string") return WEATHER_CONDITIONS.unknown;
  const normalized = code.toLowerCase();
  if (normalized.includes("thunder")) return WEATHER_CONDITIONS.storm;
  if (normalized.includes("snow") || normalized.includes("sleet")) {
    return WEATHER_CONDITIONS.snow;
  }
  if (
    normalized.includes("heavyrain") ||
    normalized.includes("hurricane") ||
    normalized.includes("tropicalstorm")
  ) {
    return WEATHER_CONDITIONS.heavyRain;
  }
  if (normalized.includes("rain") || normalized.includes("drizzle")) {
    return WEATHER_CONDITIONS.rain;
  }
  if (normalized.includes("fog") || normalized.includes("haze")) {
    return WEATHER_CONDITIONS.fog;
  }
  if (normalized.includes("cloud") || normalized.includes("overcast")) {
    return WEATHER_CONDITIONS.cloudy;
  }
  if (normalized.includes("clear") || normalized.includes("mostlyclear")) {
    return WEATHER_CONDITIONS.clear;
  }
  return WEATHER_CONDITIONS.unknown;
}

/**
 * Frase curta para o push. Só aparece quando o tempo MUDA a decisão.
 *
 * Céu limpo não vira texto: encher a notificação com "tempo bom" treina o
 * médico a não ler o resto, e o resto é a hora de sair.
 */
export function weatherAdviceLine(
  snapshot: Pick<WeatherSnapshot, "condition" | "precipitationChance">,
): string | null {
  const heavy =
    snapshot.condition === WEATHER_CONDITIONS.storm ||
    snapshot.condition === WEATHER_CONDITIONS.heavyRain;
  if (heavy) return "Chuva forte prevista — considere sair antes.";
  if (
    snapshot.condition === WEATHER_CONDITIONS.rain ||
    snapshot.precipitationChance >= 0.5
  ) {
    return "Previsão de chuva na saída.";
  }
  if (snapshot.condition === WEATHER_CONDITIONS.fog) {
    return "Névoa prevista — trajeto pode ficar mais lento.";
  }
  return null;
}

function pickHourly(
  body: Record<string, unknown>,
  atUtc: Date,
): {
  condition: WeatherCondition;
  temperature: number;
  precipitation: number;
} | null {
  const hourly = body.forecastHourly as Record<string, unknown> | undefined;
  const hours = Array.isArray(hourly?.hours) ? hourly.hours : [];
  let best: Record<string, unknown> | null = null;
  let bestDelta = Number.POSITIVE_INFINITY;
  for (const entry of hours) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    const at =
      typeof row.forecastStart === "string"
        ? Date.parse(row.forecastStart)
        : NaN;
    if (!Number.isFinite(at)) continue;
    const delta = Math.abs(at - atUtc.getTime());
    if (delta < bestDelta) {
      bestDelta = delta;
      best = row;
    }
  }
  if (!best) return null;
  const temperature = Number(best.temperature);
  const precipitation = Number(best.precipitationChance);
  return {
    condition: mapWeatherCondition(best.conditionCode),
    temperature: Number.isFinite(temperature) ? temperature : 0,
    precipitation: Number.isFinite(precipitation) ? precipitation : 0,
  };
}

export function createWeatherKitProvider(
  config: WeatherKitConfig,
): WeatherProvider {
  return {
    providerId: "WEATHERKIT",

    async forecastAt(input): Promise<ProviderCallResult<WeatherSnapshot>> {
      if (!isValidGeoPoint(input.coarseLocation)) {
        return providerFailure(PROVIDER_FAILURE_REASONS.invalidRequest);
      }
      if (!isWithinWeatherHorizon(input.atUtc)) {
        // Fora do horizonte o dado não é acionável; pedir só gastaria cota.
        return providerFailure(PROVIDER_FAILURE_REASONS.invalidRequest);
      }

      // Defesa em profundidade: o chamador já deveria ter arredondado, mas
      // não é preciso saber onde alguém mora para dizer se vai chover.
      const point: GeoPoint = coarsenGeoPoint(input.coarseLocation);

      let token: string;
      try {
        token = await weatherKitToken(config);
      } catch {
        // Chave malformada é configuração, não indisponibilidade do serviço.
        return providerFailure(PROVIDER_FAILURE_REASONS.notConfigured);
      }

      const url =
        `${WEATHERKIT_HOST}/api/v1/weather/pt-BR/` +
        `${encodeURIComponent(point.latitude.toFixed(3))}/` +
        `${encodeURIComponent(point.longitude.toFixed(3))}` +
        `?dataSets=forecastHourly&countryCode=BR`;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
      try {
        const response = await fetch(url, {
          method: "GET",
          headers: { authorization: `Bearer ${token}` },
          signal: controller.signal,
        });
        if (!response.ok) {
          if (response.status === 401 || response.status === 403) {
            // JWT pode ter expirado no voo; a próxima chamada reassina.
            cachedToken = null;
          }
          return providerFailure(classifyHttpStatus(response.status));
        }
        const text = await response.text();
        if (text.length > MAX_RESPONSE_BYTES) {
          return providerFailure(PROVIDER_FAILURE_REASONS.upstreamError);
        }
        const body = JSON.parse(text || "{}") as Record<string, unknown>;
        const picked = pickHourly(body, input.atUtc);
        if (!picked) return providerFailure(PROVIDER_FAILURE_REASONS.notFound);

        return providerSuccess({
          validAtUtc: input.atUtc,
          condition: picked.condition,
          temperatureCelsius: picked.temperature,
          precipitationChance: picked.precipitation,
          attribution: {
            providerName: "Apple Weather",
            legalPageUrl: "https://weatherkit.apple.com/legal-attribution.html",
          },
        });
      } catch (error) {
        const aborted =
          error instanceof Error &&
          (error.name === "AbortError" || error.name === "TimeoutError");
        return providerFailure(
          aborted
            ? PROVIDER_FAILURE_REASONS.timeout
            : PROVIDER_FAILURE_REASONS.network,
        );
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export { WEATHERKIT_HOST, WEATHER_CACHE_TTL_MS };

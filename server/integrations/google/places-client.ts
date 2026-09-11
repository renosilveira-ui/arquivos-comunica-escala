import {
  ROUTE_ESTIMATE_QUALITY,
  TRAVEL_MODES,
  isUsablePlacesQuery,
  isValidPlaceId,
  type ComputeRouteRequest,
  type LocationProvider,
  type PlaceDetails,
  type PlaceSuggestion,
  type RouteEstimate,
} from "../providers/location-provider";
import {
  PROVIDER_FAILURE_REASONS,
  classifyHttpStatus,
  isValidGeoPoint,
  providerFailure,
  providerSuccess,
  type ProviderCallResult,
} from "../providers/types";

/**
 * Google Places (New) + Routes, server-side.
 *
 * A chave nunca sai do servidor. O app pede ao Escala+, que decide, limita e
 * registra — é o que mantém a chave fora do bundle Expo e o rate limit sob
 * nosso controle em vez do de cada aparelho.
 *
 * Endpoints são constantes deste módulo. Nenhum valor externo escolhe host ou
 * caminho; identificador entra só por `encodeURIComponent` no path.
 *
 * O `FieldMask` é obrigatório na Places/Routes v1 e aqui é deliberadamente
 * mínimo: o Google cobra por campo pedido, e pedir menos é ao mesmo tempo mais
 * barato e menos dado sensível trafegando.
 */

const PLACES_AUTOCOMPLETE_ENDPOINT =
  "https://places.googleapis.com/v1/places:autocomplete";
const PLACES_DETAILS_ENDPOINT = "https://places.googleapis.com/v1/places";
const ROUTES_ENDPOINT =
  "https://routes.googleapis.com/directions/v2:computeRoutes";

const HTTP_TIMEOUT_MS = 12_000;
const MAX_RESPONSE_BYTES = 512 * 1024;

/**
 * Circuit breaker por processo.
 *
 * Places e Routes são pagos e têm cota. Um endpoint em falha sustentada não
 * pode ser martelado a cada abertura de tela: além do custo, mantém o usuário
 * esperando pelo timeout em vez de receber o fallback imediatamente.
 */
const BREAKER_FAILURE_THRESHOLD = 5;
const BREAKER_OPEN_MS = 60_000;

type BreakerState = { failures: number; openedAt: number | null };

const breakers = new Map<string, BreakerState>();

function breakerFor(key: string): BreakerState {
  const existing = breakers.get(key);
  if (existing) return existing;
  const created: BreakerState = { failures: 0, openedAt: null };
  breakers.set(key, created);
  return created;
}

export function isBreakerOpen(key: string, now = Date.now()): boolean {
  const breaker = breakerFor(key);
  if (breaker.openedAt === null) return false;
  if (now - breaker.openedAt >= BREAKER_OPEN_MS) {
    // Meio-aberto: deixa uma tentativa passar para descobrir se voltou.
    breaker.openedAt = null;
    breaker.failures = 0;
    return false;
  }
  return true;
}

function recordBreaker(key: string, ok: boolean, now = Date.now()): void {
  const breaker = breakerFor(key);
  if (ok) {
    breaker.failures = 0;
    breaker.openedAt = null;
    return;
  }
  breaker.failures += 1;
  if (breaker.failures >= BREAKER_FAILURE_THRESHOLD) {
    breaker.openedAt = now;
  }
}

/** Somente para teste: zera o estado do disjuntor entre casos. */
export function resetBreakers(): void {
  breakers.clear();
}

type Json = Record<string, unknown>;

async function call(
  key: string,
  url: string,
  init: RequestInit,
): Promise<ProviderCallResult<Json>> {
  if (isBreakerOpen(key)) {
    return providerFailure(PROVIDER_FAILURE_REASONS.circuitOpen);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) {
      const reason = classifyHttpStatus(response.status);
      // Erro de pedido não é falha do provedor: martelar o disjuntor com um
      // 400 nosso esconderia uma indisponibilidade real depois.
      recordBreaker(key, reason === PROVIDER_FAILURE_REASONS.invalidRequest);
      const retryAfter = Number(response.headers.get("retry-after"));
      return providerFailure(
        reason,
        Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : undefined,
      );
    }
    const text = await response.text();
    if (text.length > MAX_RESPONSE_BYTES) {
      recordBreaker(key, false);
      return providerFailure(PROVIDER_FAILURE_REASONS.upstreamError);
    }
    recordBreaker(key, true);
    try {
      const parsed = JSON.parse(text || "{}") as unknown;
      if (!parsed || typeof parsed !== "object") {
        return providerFailure(PROVIDER_FAILURE_REASONS.upstreamError);
      }
      return providerSuccess(parsed as Json);
    } catch {
      return providerFailure(PROVIDER_FAILURE_REASONS.upstreamError);
    }
  } catch (error) {
    recordBreaker(key, false);
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
}

/** ISO 8601 de duração ("1234s") → segundos. */
export function parseGoogleDuration(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = /^(\d+(?:\.\d+)?)s$/.exec(value.trim());
  if (!match) return null;
  const seconds = Number(match[1]);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds) : null;
}

export function parsePlaceSuggestions(body: Json): PlaceSuggestion[] {
  const raw = Array.isArray(body.suggestions) ? body.suggestions : [];
  const suggestions: PlaceSuggestion[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const prediction = (entry as Json).placePrediction as Json | undefined;
    if (!prediction) continue;
    const placeId = prediction.placeId;
    if (!isValidPlaceId(placeId)) continue;
    const format = prediction.structuredFormat as Json | undefined;
    const main = (format?.mainText as Json | undefined)?.text;
    const secondary = (format?.secondaryText as Json | undefined)?.text;
    const fallback = (prediction.text as Json | undefined)?.text;
    suggestions.push({
      placeId,
      primaryText:
        typeof main === "string"
          ? main
          : typeof fallback === "string"
            ? fallback
            : placeId,
      secondaryText: typeof secondary === "string" ? secondary : "",
    });
  }
  return suggestions;
}

export function createGoogleLocationProvider(apiKey: string): LocationProvider {
  const headers = {
    "content-type": "application/json",
    "x-goog-api-key": apiKey,
  } as const;

  return {
    providerId: "GOOGLE_PLACES_ROUTES",

    async autocomplete(input) {
      if (!isUsablePlacesQuery(input.query)) {
        return providerFailure(PROVIDER_FAILURE_REASONS.invalidRequest);
      }
      const body: Json = {
        input: input.query.trim(),
        sessionToken: input.sessionToken,
        languageCode: "pt-BR",
        regionCode: "BR",
      };
      if (input.near && isValidGeoPoint(input.near)) {
        body.locationBias = {
          circle: {
            center: {
              latitude: input.near.latitude,
              longitude: input.near.longitude,
            },
            radius: 50_000,
          },
        };
      }
      const result = await call("places", PLACES_AUTOCOMPLETE_ENDPOINT, {
        method: "POST",
        headers: {
          ...headers,
          // Campo mínimo: o Google cobra por campo, e não precisamos de mais.
          "x-goog-fieldmask":
            "suggestions.placePrediction.placeId,suggestions.placePrediction.text,suggestions.placePrediction.structuredFormat",
        },
        body: JSON.stringify(body),
      });
      if (!result.ok) return result;
      return providerSuccess(parsePlaceSuggestions(result.value));
    },

    async placeDetails(input) {
      if (!isValidPlaceId(input.placeId)) {
        return providerFailure(PROVIDER_FAILURE_REASONS.invalidRequest);
      }
      const query = input.sessionToken
        ? `?sessionToken=${encodeURIComponent(input.sessionToken)}`
        : "";
      const result = await call(
        "places",
        `${PLACES_DETAILS_ENDPOINT}/${encodeURIComponent(input.placeId)}${query}`,
        {
          method: "GET",
          headers: {
            ...headers,
            "x-goog-fieldmask": "id,formattedAddress,location,utcOffsetMinutes",
          },
        },
      );
      if (!result.ok) return result;

      const body = result.value;
      const location = body.location as Json | undefined;
      const point = {
        latitude: Number(location?.latitude),
        longitude: Number(location?.longitude),
      };
      if (!isValidGeoPoint(point)) {
        return providerFailure(PROVIDER_FAILURE_REASONS.upstreamError);
      }
      return providerSuccess({
        placeId: typeof body.id === "string" ? body.id : input.placeId,
        formattedAddress:
          typeof body.formattedAddress === "string"
            ? body.formattedAddress
            : "",
        location: point,
        // A Places devolve offset em minutos, não fuso IANA. Offset não
        // carrega regra de horário de verão, então não o promovemos a fuso:
        // quem precisa de fuso usa o do hospital.
        timeZone: null,
      } satisfies PlaceDetails);
    },

    async computeRoute(
      request: ComputeRouteRequest,
    ): Promise<ProviderCallResult<RouteEstimate>> {
      if (
        !isValidGeoPoint(request.origin) ||
        !isValidGeoPoint(request.destination)
      ) {
        return providerFailure(PROVIDER_FAILURE_REASONS.invalidRequest);
      }

      const now = Date.now();
      // A Routes API recusa `departureTime` no passado. Um recálculo que
      // chega atrasado deve virar "agora", não erro.
      const departAt = new Date(
        Math.max(request.departAtUtc.getTime(), now + 1000),
      );
      const mode =
        request.travelMode === TRAVEL_MODES.walking
          ? "WALK"
          : request.travelMode === TRAVEL_MODES.transit
            ? "TRANSIT"
            : "DRIVE";

      const body: Json = {
        origin: {
          location: {
            latLng: {
              latitude: request.origin.latitude,
              longitude: request.origin.longitude,
            },
          },
        },
        destination: {
          location: {
            latLng: {
              latitude: request.destination.latitude,
              longitude: request.destination.longitude,
            },
          },
        },
        travelMode: mode,
        departureTime: departAt.toISOString(),
        languageCode: "pt-BR",
        regionCode: "BR",
        units: "METRIC",
      };
      if (mode === "DRIVE") {
        body.routingPreference = "TRAFFIC_AWARE_OPTIMAL";
      }

      const result = await call("routes", ROUTES_ENDPOINT, {
        method: "POST",
        headers: {
          ...headers,
          "x-goog-fieldmask":
            "routes.duration,routes.staticDuration,routes.distanceMeters",
        },
        body: JSON.stringify(body),
      });
      if (!result.ok) return result;

      const routes = Array.isArray(result.value.routes)
        ? result.value.routes
        : [];
      const first = routes[0] as Json | undefined;
      if (!first) return providerFailure(PROVIDER_FAILURE_REASONS.notFound);

      const duration = parseGoogleDuration(first.duration);
      const staticDuration = parseGoogleDuration(first.staticDuration);
      if (duration === null) {
        return providerFailure(PROVIDER_FAILURE_REASONS.upstreamError);
      }

      const distance = Number(first.distanceMeters);

      return providerSuccess({
        durationSeconds: duration,
        distanceMeters: Number.isFinite(distance) ? Math.round(distance) : 0,
        // Só chamamos de trânsito atual o que o Google diferenciou do tempo
        // estático. Igual quer dizer que ele não aplicou trânsito — e dizer
        // que aplicou seria inventar precisão.
        quality:
          mode === "DRIVE" &&
          staticDuration !== null &&
          staticDuration !== duration
            ? ROUTE_ESTIMATE_QUALITY.liveTraffic
            : ROUTE_ESTIMATE_QUALITY.typical,
        computedAtUtc: new Date(),
      } satisfies RouteEstimate);
    },
  };
}

export {
  PLACES_AUTOCOMPLETE_ENDPOINT,
  PLACES_DETAILS_ENDPOINT,
  ROUTES_ENDPOINT,
  BREAKER_FAILURE_THRESHOLD,
  BREAKER_OPEN_MS,
};

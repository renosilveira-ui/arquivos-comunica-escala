import {
  PROVIDER_OUTCOMES,
  type ProviderOutcome,
} from "../../../lib/integration-providers";

/**
 * Vocabulário comum dos provedores externos.
 *
 * Toda chamada externa retorna um resultado explícito em vez de lançar. O
 * motivo é operacional: clima indisponível não pode impedir a leitura da
 * agenda, e rota indisponível não pode cancelar um plantão. Quem chama é
 * obrigado a olhar o `ok` e decidir o fallback — um `throw` atravessaria a
 * tela inteira sem essa decisão.
 */

/**
 * Classificação grosseira da falha. Deliberadamente sem corpo da resposta,
 * URL, coordenada, endereço ou identificador do usuário: este valor é o que
 * pode ser logado e devolvido ao cliente.
 */
export const PROVIDER_FAILURE_REASONS = {
  notConfigured: "NOT_CONFIGURED",
  network: "NETWORK",
  timeout: "TIMEOUT",
  rateLimited: "RATE_LIMITED",
  upstreamError: "UPSTREAM_ERROR",
  invalidRequest: "INVALID_REQUEST",
  notFound: "NOT_FOUND",
  authRejected: "AUTH_REJECTED",
  circuitOpen: "CIRCUIT_OPEN",
} as const;

export type ProviderFailureReason =
  (typeof PROVIDER_FAILURE_REASONS)[keyof typeof PROVIDER_FAILURE_REASONS];

export type ProviderFailure = {
  ok: false;
  reason: ProviderFailureReason;
  outcome: Exclude<ProviderOutcome, typeof PROVIDER_OUTCOMES.success>;
  /** Sugestão do provedor para a próxima tentativa, quando ele informa. */
  retryAfterMs?: number;
};

export type ProviderSuccess<T> = { ok: true; value: T };

export type ProviderCallResult<T> = ProviderSuccess<T> | ProviderFailure;

const RETRYABLE_REASONS: readonly ProviderFailureReason[] = [
  PROVIDER_FAILURE_REASONS.network,
  PROVIDER_FAILURE_REASONS.timeout,
  PROVIDER_FAILURE_REASONS.rateLimited,
  PROVIDER_FAILURE_REASONS.upstreamError,
  PROVIDER_FAILURE_REASONS.circuitOpen,
];

export function isRetryableReason(reason: ProviderFailureReason): boolean {
  return RETRYABLE_REASONS.includes(reason);
}

export function providerFailure(
  reason: ProviderFailureReason,
  retryAfterMs?: number,
): ProviderFailure {
  return {
    ok: false,
    reason,
    outcome: isRetryableReason(reason)
      ? PROVIDER_OUTCOMES.retryableFailure
      : PROVIDER_OUTCOMES.authRejected,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  };
}

export function providerSuccess<T>(value: T): ProviderSuccess<T> {
  return { ok: true, value };
}

/**
 * Status HTTP → classificação.
 *
 * 404 é `NOT_FOUND` e não retryable: repetir não faz o recurso existir.
 * 403 fica separado de 401 porque o Google usa 403 tanto para cota quanto
 * para permissão; a distinção vem do corpo, que o chamador classifica — na
 * dúvida esta função escolhe o lado que NÃO derruba o vínculo do usuário.
 */
export function classifyHttpStatus(status: number): ProviderFailureReason {
  if (status === 401) return PROVIDER_FAILURE_REASONS.authRejected;
  if (status === 403) return PROVIDER_FAILURE_REASONS.upstreamError;
  if (status === 404) return PROVIDER_FAILURE_REASONS.notFound;
  if (status === 408) return PROVIDER_FAILURE_REASONS.timeout;
  if (status === 429) return PROVIDER_FAILURE_REASONS.rateLimited;
  if (status >= 500) return PROVIDER_FAILURE_REASONS.upstreamError;
  if (status >= 400) return PROVIDER_FAILURE_REASONS.invalidRequest;
  return PROVIDER_FAILURE_REASONS.upstreamError;
}

/** Coordenada geográfica. Dado sensível: nunca vai para log. */
export type GeoPoint = {
  latitude: number;
  longitude: number;
};

export const MAX_LATITUDE = 90;
export const MAX_LONGITUDE = 180;

export function isValidGeoPoint(point: unknown): point is GeoPoint {
  if (!point || typeof point !== "object") return false;
  const { latitude, longitude } = point as Partial<GeoPoint>;
  return (
    typeof latitude === "number" &&
    Number.isFinite(latitude) &&
    Math.abs(latitude) <= MAX_LATITUDE &&
    typeof longitude === "number" &&
    Number.isFinite(longitude) &&
    Math.abs(longitude) <= MAX_LONGITUDE
  );
}

/**
 * Arredondamento de coordenada antes de sair do servidor.
 *
 * Três casas decimais ≈ 110 m: suficiente para clima e para escolher a
 * cidade, insuficiente para apontar a casa de alguém. O destino hospitalar
 * usa precisão cheia porque é endereço institucional, não residencial.
 */
export const COARSE_COORDINATE_DECIMALS = 3;

export function coarsenGeoPoint(
  point: GeoPoint,
  decimals: number = COARSE_COORDINATE_DECIMALS,
): GeoPoint {
  const factor = 10 ** decimals;
  return {
    latitude: Math.round(point.latitude * factor) / factor,
    longitude: Math.round(point.longitude * factor) / factor,
  };
}

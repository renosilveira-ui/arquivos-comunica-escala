import type { GeoPoint, ProviderCallResult } from "./types";

/**
 * Contrato do provedor de lugares e rotas (Google Places/Routes na PR 4).
 *
 * A chave de API é server-side. O app nunca fala com o Google: ele pede ao
 * nosso servidor, que decide, limita e registra. Isso mantém a chave fora do
 * bundle Expo e deixa o rate limit sob nosso controle, não sob o do cliente.
 *
 * Nenhum método aceita URL. O provedor monta os endereços a partir de
 * constantes próprias — não existe caminho em que um dado vindo do usuário
 * escolha o destino da requisição (SSRF).
 */

export type PlaceSuggestion = {
  placeId: string;
  /** Texto principal, já pronto para a lista (ex.: "Hospital São Carlos"). */
  primaryText: string;
  /** Complemento (ex.: "Fortaleza, CE, Brasil"). */
  secondaryText: string;
};

export type PlaceDetails = {
  placeId: string;
  formattedAddress: string;
  location: GeoPoint;
  /** Fuso IANA do lugar, quando o provedor informa. */
  timeZone: string | null;
};

/**
 * Sessão de autocomplete. O Google cobra a sessão inteira como uma busca se
 * o token for reaproveitado entre as teclas e descartado no details; sem
 * ele, cada tecla vira uma cobrança separada.
 */
export type PlacesSessionToken = string;

export const TRAVEL_MODES = {
  driving: "DRIVING",
  walking: "WALKING",
  transit: "TRANSIT",
} as const;

export type TravelMode = (typeof TRAVEL_MODES)[keyof typeof TRAVEL_MODES];

/**
 * Qualidade da estimativa devolvida.
 *
 * `LIVE_TRAFFIC` é a única que pode ser apresentada como trânsito atual.
 * `TYPICAL` usa o histórico do provedor. `FALLBACK` é cálculo nosso quando o
 * provedor falhou — precisa aparecer como tal para o usuário, nunca
 * disfarçada de dado do Google.
 */
export const ROUTE_ESTIMATE_QUALITY = {
  liveTraffic: "LIVE_TRAFFIC",
  typical: "TYPICAL",
  fallback: "FALLBACK",
} as const;

export type RouteEstimateQuality =
  (typeof ROUTE_ESTIMATE_QUALITY)[keyof typeof ROUTE_ESTIMATE_QUALITY];

export type RouteEstimate = {
  durationSeconds: number;
  distanceMeters: number;
  quality: RouteEstimateQuality;
  /** Instante em que a estimativa foi produzida; base do TTL. */
  computedAtUtc: Date;
};

export type ComputeRouteRequest = {
  origin: GeoPoint;
  destination: GeoPoint;
  travelMode: TravelMode;
  /**
   * Instante da PARTIDA.
   *
   * A Routes API modela trânsito a partir da saída, não da chegada: o custo
   * do trajeto depende de quando se entra nele. Transformar "quero chegar às
   * 19h" em "saia às 18h07" é convergência de duas chamadas, e mora no motor
   * de aviso de saída — não aqui. Esconder isso atrás de um parâmetro
   * `arrivalAt` faria o contrato prometer o que a API não entrega.
   */
  departAtUtc: Date;
};

export interface LocationProvider {
  readonly providerId: "GOOGLE_PLACES_ROUTES";

  autocomplete(input: {
    query: string;
    sessionToken: PlacesSessionToken;
    /** Viés geográfico opcional; não restringe o resultado. */
    near?: GeoPoint;
  }): Promise<ProviderCallResult<readonly PlaceSuggestion[]>>;

  placeDetails(input: {
    placeId: string;
    sessionToken?: PlacesSessionToken;
  }): Promise<ProviderCallResult<PlaceDetails>>;

  computeRoute(
    input: ComputeRouteRequest,
  ): Promise<ProviderCallResult<RouteEstimate>>;
}

/** Limites de entrada do autocomplete, aplicados antes de gastar cota. */
export const PLACES_QUERY_MIN_LENGTH = 3;
export const PLACES_QUERY_MAX_LENGTH = 120;

export function isUsablePlacesQuery(query: string): boolean {
  const trimmed = query.trim();
  return (
    trimmed.length >= PLACES_QUERY_MIN_LENGTH &&
    trimmed.length <= PLACES_QUERY_MAX_LENGTH
  );
}

/**
 * Place ID do Google: opaco, ASCII seguro para URL. Validar o formato antes
 * de usar impede que texto arbitrário chegue à montagem da requisição.
 */
export const PLACE_ID_PATTERN = /^[A-Za-z0-9_-]{5,255}$/;

export function isValidPlaceId(placeId: unknown): placeId is string {
  return typeof placeId === "string" && PLACE_ID_PATTERN.test(placeId);
}

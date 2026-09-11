/**
 * Contratos compartilhados das integrações externas (Google Calendar,
 * Google Places/Routes, WeatherKit).
 *
 * Importado pelo servidor e pelo app: não pode conter segredo, chamada de
 * rede ou dependência de Node. Descreve somente *estados* e vocabulário —
 * quem executa a integração é sempre o servidor.
 *
 * Duas dimensões independentes, deliberadamente separadas:
 *
 * - configuração do PROVEDOR: o servidor tem credencial para falar com ele?
 *   É global, não pertence a nenhuma conta nem instituição.
 * - vínculo da CONTA: este usuário autorizou o provedor? É account-wide e
 *   nunca depende do tenant ativo.
 *
 * Um provedor configurado não implica conta vinculada, e uma conta vinculada
 * não implica provedor disponível agora.
 */

export const EXTERNAL_PROVIDERS = {
  googleCalendar: "GOOGLE_CALENDAR",
  googlePlaces: "GOOGLE_PLACES",
  googleRoutes: "GOOGLE_ROUTES",
  weatherKit: "WEATHERKIT",
} as const;

export type ExternalProvider =
  (typeof EXTERNAL_PROVIDERS)[keyof typeof EXTERNAL_PROVIDERS];

export const EXTERNAL_PROVIDER_VALUES = Object.values(
  EXTERNAL_PROVIDERS,
) as readonly ExternalProvider[];

export function isExternalProvider(value: unknown): value is ExternalProvider {
  return (
    typeof value === "string" &&
    (EXTERNAL_PROVIDER_VALUES as readonly string[]).includes(value)
  );
}

/**
 * Domínio de selagem de um dado em repouso.
 *
 * Quase todo segredo pertence a um provedor (o refresh token do Google, por
 * exemplo), mas a origem de deslocamento do usuário **não pertence a nenhum**:
 * ela é um dado pessoal que alimenta rota e clima. Sem um escopo próprio, o
 * writer teria de escolher um provedor arbitrário para selá-la, e quem fosse
 * abrir mais tarde precisaria adivinhar a mesma escolha — o envelope só
 * falharia na PR seguinte, longe da causa.
 */
export const TRAVEL_ORIGIN_SEAL_SCOPE = "TRAVEL_ORIGIN";

export type SealScope = ExternalProvider | typeof TRAVEL_ORIGIN_SEAL_SCOPE;

export function isSealScope(value: unknown): value is SealScope {
  return isExternalProvider(value) || value === TRAVEL_ORIGIN_SEAL_SCOPE;
}

/**
 * Provedores que exigem autorização do usuário (OAuth). Os demais são
 * server-to-server e não criam vínculo por conta.
 */
export const USER_LINKED_PROVIDERS: readonly ExternalProvider[] = [
  EXTERNAL_PROVIDERS.googleCalendar,
];

export function requiresUserLink(provider: ExternalProvider): boolean {
  return USER_LINKED_PROVIDERS.includes(provider);
}

/**
 * Estado do vínculo de UMA conta com UM provedor.
 *
 * - `CONNECTED`: credencial válida e última operação bem-sucedida.
 * - `DEGRADED`: vínculo íntegro, última operação falhou de forma retryável
 *   (rede, 5xx, rate limit). O servidor continua tentando sozinho.
 * - `REAUTH_REQUIRED`: a credencial foi rejeitada ou revogada. Só o usuário
 *   resolve; nenhum retry automático recupera.
 * - `DISCONNECTED`: não existe vínculo (nunca houve, ou foi desfeito).
 */
export const EXTERNAL_LINK_STATES = {
  connected: "CONNECTED",
  degraded: "DEGRADED",
  reauthRequired: "REAUTH_REQUIRED",
  disconnected: "DISCONNECTED",
} as const;

export type ExternalLinkState =
  (typeof EXTERNAL_LINK_STATES)[keyof typeof EXTERNAL_LINK_STATES];

export const EXTERNAL_LINK_STATE_VALUES = Object.values(
  EXTERNAL_LINK_STATES,
) as readonly ExternalLinkState[];

export function isExternalLinkState(
  value: unknown,
): value is ExternalLinkState {
  return (
    typeof value === "string" &&
    (EXTERNAL_LINK_STATE_VALUES as readonly string[]).includes(value)
  );
}

/**
 * Estado da configuração do provedor no servidor.
 *
 * `MISCONFIGURED` existe para não confundir "o PO ainda não contratou" com
 * "alguém preencheu a credencial pela metade". O primeiro é esperado; o
 * segundo é defeito operacional e precisa aparecer.
 */
export const PROVIDER_CONFIGURATION_STATES = {
  configured: "CONFIGURED",
  notConfigured: "NOT_CONFIGURED",
  misconfigured: "MISCONFIGURED",
} as const;

export type ProviderConfigurationState =
  (typeof PROVIDER_CONFIGURATION_STATES)[keyof typeof PROVIDER_CONFIGURATION_STATES];

/**
 * Resultado observado de uma operação contra o provedor.
 *
 * `AUTH_REJECTED` é terminal por natureza: repetir a mesma credencial só
 * gasta rate limit. `RETRYABLE_FAILURE` é o oposto — falhou por causa
 * transitória e não pode derrubar o vínculo.
 */
export const PROVIDER_OUTCOMES = {
  success: "SUCCESS",
  retryableFailure: "RETRYABLE_FAILURE",
  authRejected: "AUTH_REJECTED",
  revokedByUser: "REVOKED_BY_USER",
} as const;

export type ProviderOutcome =
  (typeof PROVIDER_OUTCOMES)[keyof typeof PROVIDER_OUTCOMES];

/**
 * Transição de estado do vínculo. Função pura: a decisão de "o que este
 * resultado significa para o vínculo" mora em um lugar só, e os writers de
 * PR 3 em diante não podem divergir cada um por conta própria.
 *
 * Regra que não pode ser afrouxada: uma falha retryável NUNCA rebaixa um
 * vínculo para `DISCONNECTED` nem exige reautenticação. Perder a conexão do
 * usuário por instabilidade de rede seria transformar um incidente do
 * provedor em trabalho manual do médico.
 */
export function nextExternalLinkState(
  current: ExternalLinkState,
  outcome: ProviderOutcome,
): ExternalLinkState {
  if (outcome === PROVIDER_OUTCOMES.revokedByUser) {
    return EXTERNAL_LINK_STATES.disconnected;
  }
  if (current === EXTERNAL_LINK_STATES.disconnected) {
    // Sem vínculo não há o que degradar: só uma nova autorização reconecta.
    return outcome === PROVIDER_OUTCOMES.success
      ? EXTERNAL_LINK_STATES.connected
      : EXTERNAL_LINK_STATES.disconnected;
  }
  if (outcome === PROVIDER_OUTCOMES.authRejected) {
    return EXTERNAL_LINK_STATES.reauthRequired;
  }
  if (outcome === PROVIDER_OUTCOMES.retryableFailure) {
    // Reautenticação pendente não volta a "só instável" por causa de um 503.
    return current === EXTERNAL_LINK_STATES.reauthRequired
      ? EXTERNAL_LINK_STATES.reauthRequired
      : EXTERNAL_LINK_STATES.degraded;
  }
  return EXTERNAL_LINK_STATES.connected;
}

/** O usuário precisa agir para o vínculo voltar a funcionar? */
export function requiresUserAction(state: ExternalLinkState): boolean {
  return (
    state === EXTERNAL_LINK_STATES.reauthRequired ||
    state === EXTERNAL_LINK_STATES.disconnected
  );
}

/** O servidor ainda pode tentar operar com este vínculo? */
export function canAttemptSync(state: ExternalLinkState): boolean {
  return (
    state === EXTERNAL_LINK_STATES.connected ||
    state === EXTERNAL_LINK_STATES.degraded
  );
}

export const EXTERNAL_LINK_STATE_LABELS: Record<ExternalLinkState, string> = {
  CONNECTED: "Conectado",
  DEGRADED: "Instável",
  REAUTH_REQUIRED: "Reconexão necessária",
  DISCONNECTED: "Desconectado",
};

export const EXTERNAL_PROVIDER_LABELS: Record<ExternalProvider, string> = {
  GOOGLE_CALENDAR: "Google Agenda",
  GOOGLE_PLACES: "Google Places",
  GOOGLE_ROUTES: "Google Rotas",
  WEATHERKIT: "Apple WeatherKit",
};

/**
 * Vocabulário de condição do tempo.
 *
 * Mora aqui, e não no contrato do provedor no servidor, porque a TELA precisa
 * dele para escrever "chuva forte" em português. Código do app não pode
 * importar código do servidor: o bundler do Expo não resolve, e mesmo que
 * resolvesse arrastaria o servidor para dentro do aplicativo.
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

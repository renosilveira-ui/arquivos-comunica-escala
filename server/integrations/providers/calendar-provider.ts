import type { ProviderCallResult } from "./types";

/**
 * Contrato do provedor de calendário externo (Google Calendar na PR 3).
 *
 * A interface existe antes da implementação para fixar a semântica que a
 * integração precisa respeitar — e para que os testes das PRs seguintes
 * rodem contra um fake, sem rede, sem credencial e sem CI dependente do
 * Google.
 *
 * Divisão de autoridade, que nenhuma implementação pode afrouxar:
 *
 * - compromisso pessoal: bidirecional. O usuário é dono dos dois lados.
 * - plantão atribuído: exportação read-only para um calendário dedicado.
 *   Editar ou apagar o evento no Google NUNCA altera a escala — a escala é
 *   a verdade operacional, e o Google é uma vitrine dela.
 * - evento externo do usuário: entra como bloco ocupado na detecção de
 *   conflito e nunca vira plantão.
 */

/** Escopos mínimos. Pedir mais do que isto é ampliar superfície à toa. */
export const GOOGLE_CALENDAR_SCOPES: readonly string[] = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.calendarlist",
];

/** Nome do calendário dedicado criado na conta do usuário. */
export const ESCALA_CALENDAR_SUMMARY = "Escala+";

export type ExternalCalendarRef = {
  calendarId: string;
  summary: string;
};

/**
 * Origem do evento no nosso lado. Persistida junto ao vínculo para que o
 * consumidor de mudanças saiba o que pode e o que não pode escrever de
 * volta — sem isso, um eco do Google reescreveria a própria escala.
 */
export const EXTERNAL_EVENT_ORIGINS = {
  personalItem: "PERSONAL_ITEM",
  dutyAssignment: "DUTY_ASSIGNMENT",
  foreign: "FOREIGN",
} as const;

export type ExternalEventOrigin =
  (typeof EXTERNAL_EVENT_ORIGINS)[keyof typeof EXTERNAL_EVENT_ORIGINS];

export type ExternalCalendarEvent = {
  externalEventId: string;
  calendarId: string;
  /** Controle de concorrência do provedor; usado para detectar edição alheia. */
  etag: string | null;
  summary: string;
  startsAtUtc: Date;
  endsAtUtc: Date;
  allDay: boolean;
  busy: boolean;
  cancelled: boolean;
  /**
   * Marcador gravado por nós nas propriedades privadas do evento. Presente
   * apenas no que este sistema criou: é ele que separa `FOREIGN` do resto e
   * impede laço de sincronização.
   */
  originMarker: string | null;
};

export type ExternalCalendarChangePage = {
  events: readonly ExternalCalendarEvent[];
  /** `null` quando há mais páginas; o chamador segue pelo `pageToken`. */
  nextSyncToken: string | null;
  nextPageToken: string | null;
};

export type ExternalCalendarWriteRequest = {
  calendarId: string;
  externalEventId: string | null;
  summary: string;
  startsAtUtc: Date;
  endsAtUtc: Date;
  allDay: boolean;
  busy: boolean;
  timeZone: string;
  originMarker: string;
  /** Edição condicional: rejeita se o evento mudou no provedor. */
  expectedEtag: string | null;
};

export type OAuthTokenGrant = {
  accessToken: string;
  /** Ausente quando o provedor não reemite refresh token na renovação. */
  refreshToken: string | null;
  expiresAtUtc: Date;
  grantedScopes: readonly string[];
};

/**
 * `INVALID_SYNC_TOKEN` é um estado esperado, não um erro: o Google expira
 * sync tokens (HTTP 410) e a resposta correta é resync completo, não
 * desconectar o usuário.
 */
export type CalendarSyncCursor =
  { kind: "SYNC_TOKEN"; token: string } | { kind: "FULL_RESYNC"; since: Date };

export interface ExternalCalendarProvider {
  readonly providerId: "GOOGLE_CALENDAR";

  /** Troca o authorization code por tokens. PKCE é obrigatório. */
  exchangeAuthorizationCode(input: {
    code: string;
    codeVerifier: string;
    redirectUri: string;
  }): Promise<ProviderCallResult<OAuthTokenGrant>>;

  refreshAccessToken(input: {
    refreshToken: string;
  }): Promise<ProviderCallResult<OAuthTokenGrant>>;

  /** Revoga no provedor. Desconectar sem isto deixa a autorização de pé. */
  revoke(input: { refreshToken: string }): Promise<ProviderCallResult<null>>;

  /** Idempotente: devolve o calendário "Escala+" existente ou cria um. */
  ensureDedicatedCalendar(input: {
    accessToken: string;
    timeZone: string;
  }): Promise<ProviderCallResult<ExternalCalendarRef>>;

  listChanges(input: {
    accessToken: string;
    calendarId: string;
    cursor: CalendarSyncCursor;
    pageToken?: string;
  }): Promise<ProviderCallResult<ExternalCalendarChangePage>>;

  upsertEvent(input: {
    accessToken: string;
    request: ExternalCalendarWriteRequest;
  }): Promise<ProviderCallResult<ExternalCalendarEvent>>;

  deleteEvent(input: {
    accessToken: string;
    calendarId: string;
    externalEventId: string;
    expectedEtag: string | null;
  }): Promise<ProviderCallResult<null>>;
}

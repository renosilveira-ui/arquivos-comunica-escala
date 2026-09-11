import {
  ESCALA_CALENDAR_SUMMARY,
  type ExternalCalendarChangePage,
  type ExternalCalendarEvent,
  type ExternalCalendarProvider,
  type ExternalCalendarRef,
  type OAuthTokenGrant,
} from "../providers/calendar-provider";
import {
  PROVIDER_FAILURE_REASONS,
  classifyHttpStatus,
  providerFailure,
  providerSuccess,
  type ProviderCallResult,
  type ProviderFailure,
} from "../providers/types";
import {
  exchangeGoogleAuthorizationCode,
  refreshGoogleAccessToken,
  revokeGoogleToken,
  type GoogleOAuthConfig,
} from "./oauth";

/**
 * Cliente real do Google Calendar.
 *
 * Todas as URLs são montadas a partir de constantes deste arquivo. Nenhum
 * valor vindo do banco ou do cliente escolhe host ou caminho — identificadores
 * entram apenas via `encodeURIComponent` no path e via query string.
 *
 * A regra de autoridade está codificada no marcador: todo evento que este
 * sistema cria carrega `extendedProperties.private.escalaSource`. É ele que
 * separa "meu eco" de "evento do usuário" e impede o laço de sincronização —
 * sem o marcador, um evento que exportamos voltaria na próxima leitura como
 * se fosse do usuário, e seria importado de novo, indefinidamente.
 */

const CALENDAR_API = "https://www.googleapis.com/calendar/v3";
const HTTP_TIMEOUT_MS = 20_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const EVENTS_PAGE_SIZE = 250;

export const ESCALA_SOURCE_PROPERTY = "escalaSource";
/** `410 Gone` do Google significa sync token expirado, não erro fatal. */
const SYNC_TOKEN_EXPIRED_STATUS = 410;

type Json = Record<string, unknown>;

function authHeaders(accessToken: string): Record<string, string> {
  return {
    authorization: `Bearer ${accessToken}`,
    accept: "application/json",
  };
}

async function readJsonBounded(response: Response): Promise<Json | null> {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) return null;
  const text = await response.text();
  if (text.length > MAX_RESPONSE_BYTES) return null;
  if (!text) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Json) : null;
  } catch {
    return null;
  }
}

async function request(
  url: string,
  init: RequestInit,
): Promise<
  | { ok: true; status: number; body: Json }
  | (ProviderFailure & { status?: number })
> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) {
      const retryAfter = Number(response.headers.get("retry-after"));
      return {
        ...providerFailure(
          classifyHttpStatus(response.status),
          Number.isFinite(retryAfter) && retryAfter > 0
            ? retryAfter * 1000
            : undefined,
        ),
        status: response.status,
      };
    }
    const body = await readJsonBounded(response);
    if (body === null) {
      return providerFailure(PROVIDER_FAILURE_REASONS.upstreamError);
    }
    return { ok: true, status: response.status, body };
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
}

function eventDateTime(
  startsAtUtc: Date,
  endsAtUtc: Date,
  allDay: boolean,
  timeZone: string,
): { start: Json; end: Json } {
  if (!allDay) {
    return {
      start: { dateTime: startsAtUtc.toISOString(), timeZone },
      end: { dateTime: endsAtUtc.toISOString(), timeZone },
    };
  }
  // Dia inteiro no Google usa data civil com fim EXCLUSIVO.
  return {
    start: { date: startsAtUtc.toISOString().slice(0, 10) },
    end: { date: endsAtUtc.toISOString().slice(0, 10) },
  };
}

function parseEventInstant(value: unknown): Date | null {
  if (!value || typeof value !== "object") return null;
  const slot = value as { dateTime?: unknown; date?: unknown };
  if (typeof slot.dateTime === "string") {
    const parsed = new Date(slot.dateTime);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  if (typeof slot.date === "string") {
    const parsed = new Date(`${slot.date}T00:00:00Z`);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

export function parseGoogleEvent(raw: unknown): ExternalCalendarEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const event = raw as Json;
  const id = event.id;
  if (typeof id !== "string" || !id) return null;
  const status = typeof event.status === "string" ? event.status : "confirmed";
  const cancelled = status === "cancelled";
  const start = parseEventInstant(event.start);
  const end = parseEventInstant(event.end);
  const allDay =
    Boolean(event.start) &&
    typeof (event.start as Json).date === "string" &&
    (event.start as Json).dateTime === undefined;

  const extended = event.extendedProperties as Json | undefined;
  const privateProps = extended?.private as Json | undefined;
  const marker = privateProps?.[ESCALA_SOURCE_PROPERTY];

  return {
    externalEventId: id,
    calendarId:
      typeof event.organizer === "object" && event.organizer
        ? String((event.organizer as Json).email ?? "")
        : "",
    etag: typeof event.etag === "string" ? event.etag : null,
    summary: typeof event.summary === "string" ? event.summary : "(sem título)",
    // Um evento cancelado chega sem horário; usar epoch aqui seria inventar
    // um instante. O consumidor só olha `cancelled` nesse caso.
    startsAtUtc: start ?? new Date(0),
    endsAtUtc: end ?? start ?? new Date(0),
    allDay,
    busy:
      (typeof event.transparency === "string"
        ? event.transparency
        : "opaque") !== "transparent",
    cancelled,
    originMarker: typeof marker === "string" ? marker : null,
  };
}

export function createGoogleCalendarProvider(
  config: GoogleOAuthConfig,
): ExternalCalendarProvider {
  return {
    providerId: "GOOGLE_CALENDAR",

    exchangeAuthorizationCode: (input) =>
      exchangeGoogleAuthorizationCode({
        config,
        code: input.code,
        codeVerifier: input.codeVerifier,
      }),

    refreshAccessToken: (input): Promise<ProviderCallResult<OAuthTokenGrant>> =>
      refreshGoogleAccessToken({ config, refreshToken: input.refreshToken }),

    revoke: (input) => revokeGoogleToken({ refreshToken: input.refreshToken }),

    async ensureDedicatedCalendar(input) {
      // Procura antes de criar: sem isso, cada reconexão criaria um
      // calendário "Escala+" novo na conta do médico.
      const listed = await request(
        `${CALENDAR_API}/users/me/calendarList?maxResults=250&minAccessRole=owner`,
        { method: "GET", headers: authHeaders(input.accessToken) },
      );
      if (!listed.ok) return listed;
      const items = Array.isArray(listed.body.items) ? listed.body.items : [];
      for (const item of items) {
        if (!item || typeof item !== "object") continue;
        const entry = item as Json;
        if (
          entry.summary === ESCALA_CALENDAR_SUMMARY &&
          typeof entry.id === "string"
        ) {
          return providerSuccess({
            calendarId: entry.id,
            summary: ESCALA_CALENDAR_SUMMARY,
          } satisfies ExternalCalendarRef);
        }
      }

      const created = await request(`${CALENDAR_API}/calendars`, {
        method: "POST",
        headers: {
          ...authHeaders(input.accessToken),
          "content-type": "application/json",
        },
        body: JSON.stringify({
          summary: ESCALA_CALENDAR_SUMMARY,
          description:
            "Plantões e compromissos exportados pelo Escala+. Editar aqui não altera a escala.",
          timeZone: input.timeZone,
        }),
      });
      if (!created.ok) return created;
      const calendarId = created.body.id;
      if (typeof calendarId !== "string" || !calendarId) {
        return providerFailure(PROVIDER_FAILURE_REASONS.upstreamError);
      }
      return providerSuccess({
        calendarId,
        summary: ESCALA_CALENDAR_SUMMARY,
      });
    },

    async listChanges(input) {
      const path = `${CALENDAR_API}/calendars/${encodeURIComponent(
        input.calendarId,
      )}/events`;
      const query = new URLSearchParams({
        maxResults: String(EVENTS_PAGE_SIZE),
        singleEvents: "true",
        showDeleted: "true",
      });
      if (input.pageToken) query.set("pageToken", input.pageToken);
      if (input.cursor.kind === "SYNC_TOKEN") {
        query.set("syncToken", input.cursor.token);
      } else {
        // Só timeMin. `orderBy` é incompatível com sync token, e o Google
        // exige que a leitura inicial use os mesmos parâmetros da incremental
        // — com `orderBy` aqui, o `nextSyncToken` simplesmente não vinha, e
        // toda sincronização relia a janela inteira (staging, 11/09).
        query.set("timeMin", input.cursor.since.toISOString());
      }

      const result = await request(`${path}?${query.toString()}`, {
        method: "GET",
        headers: authHeaders(input.accessToken),
      });
      if (!result.ok) {
        // 410 é estado esperado: o token de sync expirou e a resposta certa é
        // ressincronizar, nunca desconectar o usuário.
        if (result.status === SYNC_TOKEN_EXPIRED_STATUS) {
          return providerFailure(PROVIDER_FAILURE_REASONS.notFound);
        }
        return result;
      }

      const items = Array.isArray(result.body.items) ? result.body.items : [];
      const events = items
        .map(parseGoogleEvent)
        .filter((event): event is ExternalCalendarEvent => event !== null);

      return providerSuccess({
        events,
        nextSyncToken:
          typeof result.body.nextSyncToken === "string"
            ? result.body.nextSyncToken
            : null,
        nextPageToken:
          typeof result.body.nextPageToken === "string"
            ? result.body.nextPageToken
            : null,
      } satisfies ExternalCalendarChangePage);
    },

    async upsertEvent(input) {
      const { request: write } = input;
      const body: Json = {
        summary: write.summary,
        ...eventDateTime(
          write.startsAtUtc,
          write.endsAtUtc,
          write.allDay,
          write.timeZone,
        ),
        transparency: write.busy ? "opaque" : "transparent",
        extendedProperties: {
          private: { [ESCALA_SOURCE_PROPERTY]: write.originMarker },
        },
      };

      const base = `${CALENDAR_API}/calendars/${encodeURIComponent(
        write.calendarId,
      )}/events`;
      const isUpdate = Boolean(write.externalEventId);
      const url = isUpdate
        ? `${base}/${encodeURIComponent(write.externalEventId as string)}`
        : base;

      const headers: Record<string, string> = {
        ...authHeaders(input.accessToken),
        "content-type": "application/json",
      };
      // Edição condicional: se alguém mudou o evento no Google, a escrita é
      // recusada em vez de sobrescrever a alteração de outra pessoa.
      if (isUpdate && write.expectedEtag) {
        headers["if-match"] = write.expectedEtag;
      }

      const result = await request(url, {
        method: isUpdate ? "PUT" : "POST",
        headers,
        body: JSON.stringify(body),
      });
      if (!result.ok) return result;
      const parsed = parseGoogleEvent(result.body);
      if (!parsed)
        return providerFailure(PROVIDER_FAILURE_REASONS.upstreamError);
      return providerSuccess({ ...parsed, calendarId: write.calendarId });
    },

    async deleteEvent(input) {
      const headers: Record<string, string> = authHeaders(input.accessToken);
      if (input.expectedEtag) headers["if-match"] = input.expectedEtag;
      const result = await request(
        `${CALENDAR_API}/calendars/${encodeURIComponent(
          input.calendarId,
        )}/events/${encodeURIComponent(input.externalEventId)}`,
        { method: "DELETE", headers },
      );
      if (!result.ok) {
        // Já não existe: o objetivo da exclusão foi atingido.
        if (result.reason === PROVIDER_FAILURE_REASONS.notFound) {
          return providerSuccess(null);
        }
        return result;
      }
      return providerSuccess(null);
    },
  };
}

export { CALENDAR_API, SYNC_TOKEN_EXPIRED_STATUS };

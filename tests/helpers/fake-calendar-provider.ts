import {
  ESCALA_CALENDAR_SUMMARY,
  type ExternalCalendarEvent,
  type ExternalCalendarProvider,
} from "../../server/integrations/providers/calendar-provider";
import {
  PROVIDER_FAILURE_REASONS,
  providerFailure,
  providerSuccess,
  type ProviderCallResult,
  type ProviderFailureReason,
} from "../../server/integrations/providers/types";

/**
 * Provedor de calendário falso, em memória.
 *
 * Existe para que as suítes exercitem o motor de sincronização inteiro sem
 * rede, sem credencial e sem CI dependente do Google. Ele imita o que
 * importa do contrato real:
 *
 * - devolve `etag` e o muda a cada escrita (para exercitar edição condicional);
 * - recusa escrita com `If-Match` desatualizado, como o Google faz;
 * - guarda o marcador de origem nas propriedades privadas;
 * - sabe simular `410 Gone` do sync token e falhas classificadas.
 */

type StoredEvent = ExternalCalendarEvent & { deleted: boolean };

export type FakeCalendarProvider = ExternalCalendarProvider & {
  events: Map<string, StoredEvent>;
  calendars: Map<string, string>;
  /** Próxima chamada de `listChanges` responde como sync token expirado. */
  expireSyncTokenOnce(): void;
  /** Próxima chamada do método indicado falha com a razão dada. */
  failNext(
    method: "upsertEvent" | "deleteEvent",
    reason: ProviderFailureReason,
  ): void;
  calls: { upsert: number; delete: number; list: number; ensure: number };
  /** Simula edição feita pelo usuário direto no Google. */
  externallyCancel(externalEventId: string): void;
};

export function createFakeCalendarProvider(): FakeCalendarProvider {
  const events = new Map<string, StoredEvent>();
  const calendars = new Map<string, string>();
  const calls = { upsert: 0, delete: 0, list: 0, ensure: 0 };
  let sequence = 0;
  let expireSyncToken = false;
  const pendingFailures = new Map<string, ProviderFailureReason>();

  function nextId(prefix: string): string {
    sequence += 1;
    return `${prefix}-${sequence}`;
  }

  return {
    providerId: "GOOGLE_CALENDAR",
    events,
    calendars,
    calls,

    expireSyncTokenOnce() {
      expireSyncToken = true;
    },
    failNext(method, reason) {
      pendingFailures.set(method, reason);
    },
    externallyCancel(externalEventId) {
      const event = events.get(externalEventId);
      if (event) events.set(externalEventId, { ...event, cancelled: true });
    },

    async exchangeAuthorizationCode() {
      return providerSuccess({
        accessToken: "fake-access",
        refreshToken: "fake-refresh",
        expiresAtUtc: new Date(Date.now() + 3_600_000),
        grantedScopes: ["https://www.googleapis.com/auth/calendar.events"],
      });
    },

    async refreshAccessToken() {
      return providerSuccess({
        accessToken: "fake-access",
        refreshToken: null,
        expiresAtUtc: new Date(Date.now() + 3_600_000),
        grantedScopes: ["https://www.googleapis.com/auth/calendar.events"],
      });
    },

    async revoke() {
      return providerSuccess(null);
    },

    async ensureDedicatedCalendar() {
      calls.ensure += 1;
      const existing = [...calendars.entries()].find(
        ([, summary]) => summary === ESCALA_CALENDAR_SUMMARY,
      );
      if (existing) {
        return providerSuccess({
          calendarId: existing[0],
          summary: ESCALA_CALENDAR_SUMMARY,
        });
      }
      const calendarId = nextId("cal");
      calendars.set(calendarId, ESCALA_CALENDAR_SUMMARY);
      return providerSuccess({
        calendarId,
        summary: ESCALA_CALENDAR_SUMMARY,
      });
    },

    async listChanges(input) {
      calls.list += 1;
      if (expireSyncToken && input.cursor.kind === "SYNC_TOKEN") {
        expireSyncToken = false;
        // O cliente real traduz 410 para NOT_FOUND.
        return providerFailure(PROVIDER_FAILURE_REASONS.notFound);
      }
      return providerSuccess({
        events: [...events.values()],
        nextSyncToken: nextId("sync"),
        nextPageToken: null,
      });
    },

    async upsertEvent(
      input,
    ): Promise<ProviderCallResult<ExternalCalendarEvent>> {
      calls.upsert += 1;
      const failure = pendingFailures.get("upsertEvent");
      if (failure) {
        pendingFailures.delete("upsertEvent");
        return providerFailure(failure);
      }
      const { request } = input;
      const id = request.externalEventId ?? nextId("ev");
      const current = events.get(id);
      if (
        current &&
        request.expectedEtag &&
        current.etag !== request.expectedEtag
      ) {
        // Igual ao Google: If-Match desatualizado é conflito, não sobrescrita.
        return providerFailure(PROVIDER_FAILURE_REASONS.upstreamError);
      }
      const stored: StoredEvent = {
        externalEventId: id,
        calendarId: request.calendarId,
        etag: nextId("etag"),
        summary: request.summary,
        startsAtUtc: request.startsAtUtc,
        endsAtUtc: request.endsAtUtc,
        allDay: request.allDay,
        busy: request.busy,
        cancelled: false,
        originMarker: request.originMarker,
        deleted: false,
      };
      events.set(id, stored);
      return providerSuccess(stored);
    },

    async deleteEvent(input) {
      calls.delete += 1;
      const failure = pendingFailures.get("deleteEvent");
      if (failure) {
        pendingFailures.delete("deleteEvent");
        return providerFailure(failure);
      }
      events.delete(input.externalEventId);
      return providerSuccess(null);
    },
  };
}

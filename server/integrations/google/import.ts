import { and, eq, inArray } from "drizzle-orm";

import {
  personalCalendarExternalLinks,
  personalCalendarImportCursors,
  personalCalendarItems,
} from "../../../drizzle/schema";
import { EXTERNAL_PROVIDERS } from "../../../lib/integration-providers";
import {
  createPersonalCalendarItem,
  deletePersonalCalendarItem,
  updatePersonalCalendarItem,
} from "../../personal-calendar-service";
import type { PersonalCalendarItemDraft } from "../../personal-calendar-domain";
import type {
  ExternalCalendarEvent,
  ExternalCalendarProvider,
} from "../providers/calendar-provider";
import {
  PROVIDER_FAILURE_REASONS,
  providerFailure,
  type ProviderCallResult,
  type ProviderFailureReason,
} from "../providers/types";
import { withGoogleAccessToken } from "./link-service";
import type { GoogleOAuthConfig } from "./oauth";
import { ESCALA_ORIGIN_MARKER, SYNC_PAST_DAYS } from "./sync";

/**
 * Importação do calendário principal do Google para a Agenda de Compromissos.
 *
 * Decisão do PO em 11/09/2026: o Escala+ é o centro da gestão de tempo do
 * médico. Compromissos que ele cria no Google aparecem aqui, entram na
 * detecção de conflito com plantão e no calendário unificado.
 *
 * ## Direção, nesta frente
 *
 * Google → Escala+, **somente leitura no app**. O compromisso importado
 * aparece, avisa, conflita — mas é editado no Google, que continua sendo o
 * dono dele. Escrever de volta é o incremento seguinte; fazer as duas
 * direções de uma vez sem um modelo de conflito de edição seria trocar
 * "importa" por "corrompe".
 *
 * ## O que impede laço
 *
 * O Escala+ exporta para o calendário dedicado "Escala+", não para o
 * principal — então ler o principal não devolve o que nós escrevemos. E, se
 * um dia devolver (usuário moveu um evento nosso para lá), o marcador de
 * origem nas propriedades privadas o identifica e ele é ignorado.
 *
 * ## Idempotência
 *
 * `clientMutationId` é determinístico por evento (`google:<calendário>:<id>`).
 * A criação replayada devolve o item existente em vez de duplicar — a chave
 * única `(owner, client_mutation_id)` garante isso no banco, não aqui.
 */

export const IMPORT_SOURCE_CALENDAR_ID = "primary";
const PROVIDER = EXTERNAL_PROVIDERS.googleCalendar;
const IMPORT_TITLE_MAX = 160;
/** Teto por ciclo: um calendário com anos de histórico não trava o worker. */
export const IMPORT_MAX_EVENTS_PER_RUN = 200;

export type ImportSummary = {
  created: number;
  updated: number;
  removed: number;
  /** Eventos nossos (marcador de origem) ou fora do que importamos. */
  ignored: number;
  /** Cursor expirado: leitura completa refeita. */
  resynced: boolean;
};

function emptyImportSummary(): ImportSummary {
  return { created: 0, updated: 0, removed: 0, ignored: 0, resynced: false };
}

export function importMutationId(calendarId: string, eventId: string): string {
  // Cabe em 64 chars com folga só se o id for curto; ids do Google chegam a
  // ~26 chars, calendários "primary". Para ids longos, um hash estável.
  const raw = `google:${calendarId}:${eventId}`;
  if (raw.length <= 64) return raw;
  let h = 0;
  for (let i = 0; i < raw.length; i += 1)
    h = (h * 31 + raw.charCodeAt(i)) >>> 0;
  return `google:${calendarId}:${h.toString(16)}:${eventId.slice(-24)}`.slice(
    0,
    64,
  );
}

function localDateKey(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instant);
}

function localTimeKey(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(instant);
}

function addDays(dateKey: string, days: number): string {
  const [y, m, d] = dateKey.split("-").map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + days));
  return next.toISOString().slice(0, 10);
}

/**
 * Evento do Google → rascunho de compromisso do domínio.
 *
 * Puro: a tradução de instante para data/hora civil no fuso do usuário é o
 * ponto que mais erra em calendário (dia inteiro cruzando meia-noite, fim
 * exclusivo do Google), e precisa de teste sem rede.
 */
export function draftFromExternalEvent(
  event: ExternalCalendarEvent,
  timeZone: string,
): PersonalCalendarItemDraft {
  const title = (event.summary || "(sem título)").slice(0, IMPORT_TITLE_MAX);
  const availability = event.busy ? "BUSY" : "FREE";
  if (event.allDay) {
    // Google marca dia inteiro com fim EXCLUSIVO (dia seguinte, 00:00).
    // Nosso domínio usa fim inclusivo.
    const start = localDateKey(event.startsAtUtc, "UTC");
    const endExclusive = localDateKey(event.endsAtUtc, "UTC");
    const end = endExclusive > start ? addDays(endExclusive, -1) : start;
    return {
      kind: "APPOINTMENT",
      allDay: true,
      availability,
      title,
      startLocalDate: start,
      endLocalDate: end,
      timeZone,
      locationLabel: null,
      locationProvider: null,
      locationExternalId: null,
      latitude: null,
      longitude: null,
      notes: null,
    } as PersonalCalendarItemDraft;
  }
  return {
    kind: "APPOINTMENT",
    allDay: false,
    availability,
    title,
    startLocalDate: localDateKey(event.startsAtUtc, timeZone),
    startLocalTime: localTimeKey(event.startsAtUtc, timeZone),
    endLocalDate: localDateKey(event.endsAtUtc, timeZone),
    endLocalTime: localTimeKey(event.endsAtUtc, timeZone),
    timeZone,
    locationLabel: null,
    locationProvider: null,
    locationExternalId: null,
    latitude: null,
    longitude: null,
    notes: null,
  } as PersonalCalendarItemDraft;
}

type ImportDb = Parameters<typeof withGoogleAccessToken>[0]["db"] &
  Parameters<typeof createPersonalCalendarItem>[0]["db"];

async function readCursor(
  db: ImportDb,
  userId: number,
): Promise<string | null> {
  const [row] = await db
    .select({ syncCursor: personalCalendarImportCursors.syncCursor })
    .from(personalCalendarImportCursors)
    .where(
      and(
        eq(personalCalendarImportCursors.ownerUserId, userId),
        eq(personalCalendarImportCursors.provider, PROVIDER),
        eq(
          personalCalendarImportCursors.externalCalendarId,
          IMPORT_SOURCE_CALENDAR_ID,
        ),
      ),
    )
    .limit(1);
  return row?.syncCursor ?? null;
}

async function saveCursor(
  db: ImportDb,
  userId: number,
  cursor: string | null,
  now: Date,
): Promise<void> {
  await db
    .insert(personalCalendarImportCursors)
    .values({
      ownerUserId: userId,
      provider: PROVIDER,
      externalCalendarId: IMPORT_SOURCE_CALENDAR_ID,
      syncCursor: cursor,
      lastImportedAt: now,
    })
    .onDuplicateKeyUpdate({
      set: { syncCursor: cursor, lastImportedAt: now },
    });
}

export async function runGoogleCalendarImport(input: {
  db: ImportDb;
  userId: number;
  expectedSessionVersion: number;
  config: GoogleOAuthConfig;
  provider: ExternalCalendarProvider;
  timeZone: string;
  now?: Date;
}): Promise<ProviderCallResult<ImportSummary>> {
  const now = input.now ?? new Date();
  return withGoogleAccessToken({
    db: input.db,
    userId: input.userId,
    refresh: (refreshToken) =>
      input.provider.refreshAccessToken({ refreshToken }),
    run: async (accessToken) => {
      const summary = emptyImportSummary();
      const savedCursor = await readCursor(input.db, input.userId);
      let cursor = savedCursor
        ? ({ kind: "SYNC_TOKEN", token: savedCursor } as const)
        : ({
            kind: "FULL_RESYNC",
            since: new Date(now.getTime() - SYNC_PAST_DAYS * 86_400_000),
          } as const);

      let page = await input.provider.listChanges({
        accessToken,
        calendarId: IMPORT_SOURCE_CALENDAR_ID,
        cursor,
      });
      if (!page.ok && page.reason === PROVIDER_FAILURE_REASONS.notFound) {
        // 410: sync token expirado. Estado esperado — leitura completa.
        summary.resynced = true;
        cursor = {
          kind: "FULL_RESYNC",
          since: new Date(now.getTime() - SYNC_PAST_DAYS * 86_400_000),
        } as const;
        page = await input.provider.listChanges({
          accessToken,
          calendarId: IMPORT_SOURCE_CALENDAR_ID,
          cursor,
        });
      }
      if (!page.ok) throw new ImportUnavailableError(page.reason);

      const events = page.value.events.slice(0, IMPORT_MAX_EVENTS_PER_RUN);
      const eventIds = events.map((event) => event.externalEventId);
      const links = eventIds.length
        ? await input.db
            .select({
              id: personalCalendarExternalLinks.id,
              itemId: personalCalendarExternalLinks.itemId,
              externalEventId: personalCalendarExternalLinks.externalEventId,
              externalEtag: personalCalendarExternalLinks.externalEtag,
              deletedAt: personalCalendarExternalLinks.deletedAt,
            })
            .from(personalCalendarExternalLinks)
            .where(
              and(
                eq(personalCalendarExternalLinks.ownerUserId, input.userId),
                eq(personalCalendarExternalLinks.provider, PROVIDER),
                eq(
                  personalCalendarExternalLinks.externalCalendarId,
                  IMPORT_SOURCE_CALENDAR_ID,
                ),
                inArray(
                  personalCalendarExternalLinks.externalEventId,
                  eventIds,
                ),
              ),
            )
        : [];
      const linkByEvent = new Map(links.map((l) => [l.externalEventId, l]));
      const itemIds = links.map((l) => l.itemId);
      const versions = itemIds.length
        ? await input.db
            .select({
              id: personalCalendarItems.id,
              version: personalCalendarItems.version,
              deletedAt: personalCalendarItems.deletedAt,
            })
            .from(personalCalendarItems)
            .where(inArray(personalCalendarItems.id, itemIds))
        : [];
      const versionById = new Map(versions.map((v) => [v.id, v]));

      for (const event of events) {
        // Nosso próprio evento, movido para o calendário principal: ignorar,
        // senão vira laço (importa → exporta → importa).
        if (event.originMarker === ESCALA_ORIGIN_MARKER) {
          summary.ignored += 1;
          continue;
        }
        const link = linkByEvent.get(event.externalEventId);
        const current = link ? versionById.get(link.itemId) : undefined;

        if (event.cancelled) {
          if (link && current && !current.deletedAt) {
            await deletePersonalCalendarItem({
              db: input.db,
              ownerUserId: input.userId,
              expectedSessionVersion: input.expectedSessionVersion,
              itemId: link.itemId,
              expectedVersion: current.version,
              allowExternal: true,
            });
            await input.db
              .update(personalCalendarExternalLinks)
              .set({ deletedAt: now, externalEtag: event.etag })
              .where(eq(personalCalendarExternalLinks.id, link.id));
            summary.removed += 1;
          } else {
            summary.ignored += 1;
          }
          continue;
        }

        const draft = draftFromExternalEvent(event, input.timeZone);

        if (link && current && !current.deletedAt && !link.deletedAt) {
          if (link.externalEtag && link.externalEtag === event.etag) {
            summary.ignored += 1;
            continue;
          }
          await updatePersonalCalendarItem({
            db: input.db,
            ownerUserId: input.userId,
            expectedSessionVersion: input.expectedSessionVersion,
            itemId: link.itemId,
            expectedVersion: current.version,
            item: draft,
            recurrence: null,
            alertOffsets: [],
            allowExternal: true,
          });
          await input.db
            .update(personalCalendarExternalLinks)
            .set({ externalEtag: event.etag, importedAt: now })
            .where(eq(personalCalendarExternalLinks.id, link.id));
          summary.updated += 1;
          continue;
        }

        // Novo — ou cancelado antes e recriado no Google.
        const created = await createPersonalCalendarItem({
          db: input.db,
          ownerUserId: input.userId,
          expectedSessionVersion: input.expectedSessionVersion,
          clientMutationId: importMutationId(
            IMPORT_SOURCE_CALENDAR_ID,
            event.externalEventId,
          ),
          item: draft,
          recurrence: null,
          alertOffsets: [],
        });
        await input.db
          .insert(personalCalendarExternalLinks)
          .values({
            ownerUserId: input.userId,
            itemId: created.item.id,
            provider: PROVIDER,
            externalCalendarId: IMPORT_SOURCE_CALENDAR_ID,
            externalEventId: event.externalEventId,
            externalEtag: event.etag,
            importedAt: now,
            deletedAt: null,
          })
          .onDuplicateKeyUpdate({
            set: {
              itemId: created.item.id,
              externalEtag: event.etag,
              importedAt: now,
              deletedAt: null,
            },
          });
        summary.created += created.replayed ? 0 : 1;
        if (created.replayed) summary.updated += 1;
      }

      await saveCursor(input.db, input.userId, page.value.nextSyncToken, now);
      return summary;
    },
  })
    .then((result) => {
      if (result.ok) return result;
      return providerFailure(result.reason);
    })
    .catch((error) => {
      if (error instanceof ImportUnavailableError) {
        return providerFailure(error.reason);
      }
      throw error;
    });
}

export class ImportUnavailableError extends Error {
  readonly reason: ProviderFailureReason;
  constructor(reason: ProviderFailureReason) {
    super(`Importação indisponível: ${reason}`);
    this.name = "ImportUnavailableError";
    this.reason = reason;
  }
}

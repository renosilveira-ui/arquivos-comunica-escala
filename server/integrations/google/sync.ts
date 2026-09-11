import { createHash } from "node:crypto";
import { and, eq, gte, isNull, lte } from "drizzle-orm";

import {
  externalCalendarEventLinks,
  hospitals,
  institutions,
  professionals,
  sectors,
  shiftAssignmentsV2,
  shiftInstances,
  userExternalCredentials,
} from "../../../drizzle/schema";
import {
  EXTERNAL_PROVIDERS,
  PROVIDER_OUTCOMES,
} from "../../../lib/integration-providers";
import { getDb } from "../../db";
import { listPersonalCalendarWindow } from "../../personal-calendar-service";
import type {
  ExternalCalendarProvider,
  ExternalCalendarWriteRequest,
} from "../providers/calendar-provider";
import {
  PROVIDER_FAILURE_REASONS,
  type ProviderCallResult,
} from "../providers/types";
import {
  recordGoogleOutcome,
  saveGoogleSyncCursor,
  withGoogleAccessToken,
  type GoogleLinkSnapshot,
} from "./link-service";
import type { GoogleOAuthConfig } from "./oauth";

/**
 * Exportação do Escala+ para o calendário dedicado do usuário no Google.
 *
 * Duas autoridades, uma direção cada:
 *
 * - **Plantão** (`DUTY_ASSIGNMENT`): exportação read-only. Editar ou apagar o
 *   evento no Google NUNCA altera a escala. A escala é a verdade operacional;
 *   o Google é vitrine dela. Se o usuário apagar o evento lá, o próximo ciclo
 *   o recria — é isso que "read-only" significa na prática.
 * - **Compromisso pessoal** (`PERSONAL_ITEM`): o usuário é dono dos dois
 *   lados; esta frente exporta, e a importação de volta é o incremento
 *   seguinte (documentado no contrato).
 *
 * Nada é reescrito sem necessidade: o `content_fingerprint` compara o que
 * seria enviado com o que já foi. Sem ele, cada ciclo reescreveria todos os
 * eventos do mês e queimaria cota do usuário à toa.
 */

const PROVIDER = EXTERNAL_PROVIDERS.googleCalendar;

/** Marcador que identifica um evento criado por nós. Impede laço de sync. */
export const ESCALA_ORIGIN_MARKER = "escala-plus:v1";

/** Janela exportada: passado curto para contexto, futuro suficiente. */
export const SYNC_PAST_DAYS = 7;
export const SYNC_FUTURE_DAYS = 92;
/** Teto por ciclo. Um mês de plantões cabe folgado; protege cota e tempo. */
export const SYNC_MAX_WRITES_PER_RUN = 200;

type SyncDb = NonNullable<Awaited<ReturnType<typeof getDb>>>;

export type SyncSummary = {
  created: number;
  updated: number;
  deleted: number;
  unchanged: number;
  skipped: number;
};

function emptySummary(): SyncSummary {
  return { created: 0, updated: 0, deleted: 0, unchanged: 0, skipped: 0 };
}

export function fingerprintEvent(request: {
  summary: string;
  startsAtUtc: Date;
  endsAtUtc: Date;
  allDay: boolean;
  busy: boolean;
  timeZone: string;
}): string {
  return createHash("sha256")
    .update(
      [
        request.summary,
        request.startsAtUtc.toISOString(),
        request.endsAtUtc.toISOString(),
        String(request.allDay),
        String(request.busy),
        request.timeZone,
      // Separador NUL: um titulo que contenha o separador nao pode forjar
      // o fingerprint de outro evento. Escrito como escape porque byte de
      // controle cru no fonte faz o git tratar o arquivo como binario.
      ].join("\u0000"),
    )
    .digest("hex");
}

export type ExportCandidate = {
  sourceKind: "PERSONAL_ITEM" | "DUTY_ASSIGNMENT";
  sourceId: number;
  occurrenceKey: string | null;
  summary: string;
  startsAtUtc: Date;
  endsAtUtc: Date;
  allDay: boolean;
  busy: boolean;
  timeZone: string;
};

/**
 * Plantões PRÓPRIOS do usuário, em todas as instituições dele.
 *
 * Account-wide de propósito: a agenda do Google do médico não tem abas por
 * hospital. O `WHERE` continua preso ao `user_id` dele — nenhum plantão de
 * terceiro entra, e nenhum tenant lê o do outro.
 *
 * O título nomeia setor e hospital sem conteúdo clínico: o calendário do
 * Google é uma superfície fora do nosso controle, e não é lugar para PHI.
 */
export async function collectDutyExports(input: {
  db: SyncDb;
  userId: number;
  fromUtc: Date;
  toUtc: Date;
}): Promise<ExportCandidate[]> {
  const rows = await input.db
    .select({
      assignmentId: shiftAssignmentsV2.id,
      startAt: shiftInstances.startAt,
      endAt: shiftInstances.endAt,
      sectorName: sectors.name,
      hospitalName: hospitals.name,
      institutionTimeZone: institutions.timeZone,
      hospitalTimeZone: hospitals.timeZone,
      modality: shiftInstances.modality,
    })
    .from(shiftAssignmentsV2)
    .innerJoin(
      shiftInstances,
      eq(shiftInstances.id, shiftAssignmentsV2.shiftInstanceId),
    )
    .innerJoin(
      professionals,
      eq(professionals.id, shiftAssignmentsV2.professionalId),
    )
    .innerJoin(sectors, eq(sectors.id, shiftInstances.sectorId))
    .innerJoin(hospitals, eq(hospitals.id, sectors.hospitalId))
    .innerJoin(institutions, eq(institutions.id, hospitals.institutionId))
    .where(
      and(
        eq(professionals.userId, input.userId),
        gte(shiftInstances.startAt, input.fromUtc),
        lte(shiftInstances.startAt, input.toUtc),
      ),
    )
    .limit(SYNC_MAX_WRITES_PER_RUN);

  return rows.map((row) => {
    const timeZone =
      row.hospitalTimeZone || row.institutionTimeZone || "America/Sao_Paulo";
    const modalityLabel =
      row.modality === "SOBREAVISO" ? "Sobreaviso" : "Plantão";
    return {
      sourceKind: "DUTY_ASSIGNMENT" as const,
      sourceId: row.assignmentId,
      occurrenceKey: null,
      summary: `${modalityLabel} · ${row.sectorName} · ${row.hospitalName}`,
      startsAtUtc: row.startAt,
      endsAtUtc: row.endAt,
      allDay: false,
      // Sobreaviso não bloqueia o dia do médico da mesma forma que plantão
      // presencial; marcá-lo como ocupado tornaria a agenda dele inútil.
      busy: row.modality !== "SOBREAVISO",
      timeZone,
    };
  });
}

export async function collectPersonalExports(input: {
  db: SyncDb;
  userId: number;
  fromDate: string;
  toDate: string;
  timeZone: string;
}): Promise<ExportCandidate[]> {
  const result = await listPersonalCalendarWindow({
    db: input.db,
    ownerUserId: input.userId,
    window: { fromDate: input.fromDate, toDate: input.toDate },
  });
  return result.occurrences.slice(0, SYNC_MAX_WRITES_PER_RUN).map((o) => ({
    sourceKind: "PERSONAL_ITEM" as const,
    sourceId: o.itemId,
    occurrenceKey: o.occurrenceKey,
    summary: o.title,
    startsAtUtc: o.startsAtUtc,
    endsAtUtc: o.endsAtUtc,
    allDay: o.allDay,
    busy: o.availability === "BUSY",
    timeZone: input.timeZone,
  }));
}

type LinkRow = {
  id: number;
  externalEventId: string;
  externalEtag: string | null;
  contentFingerprint: string | null;
  sourceKind: string;
  sourceId: number;
  occurrenceKey: string | null;
  deletedAt: Date | null;
};

function candidateKey(candidate: {
  sourceKind: string;
  sourceId: number;
  occurrenceKey: string | null;
}): string {
  return `${candidate.sourceKind}:${candidate.sourceId}:${candidate.occurrenceKey ?? ""}`;
}

/**
 * Um ciclo de exportação.
 *
 * Idempotente por construção: o que já está no Google com o mesmo
 * fingerprint não é reescrito, e o que sumiu da origem é apagado lá. Rodar
 * duas vezes seguidas produz o mesmo estado — é o que permite chamar isto de
 * um botão, de um cron e de um webhook sem coordenação entre eles.
 */
export async function runGoogleCalendarExport(input: {
  db: SyncDb;
  userId: number;
  config: GoogleOAuthConfig;
  provider: ExternalCalendarProvider;
  timeZone: string;
  now?: Date;
}): Promise<ProviderCallResult<SyncSummary>> {
  const now = input.now ?? new Date();
  const fromUtc = new Date(now.getTime() - SYNC_PAST_DAYS * 86_400_000);
  const toUtc = new Date(now.getTime() + SYNC_FUTURE_DAYS * 86_400_000);

  return withGoogleAccessToken({
    db: input.db,
    userId: input.userId,
    refresh: (refreshToken) =>
      input.provider.refreshAccessToken({ refreshToken }),
    run: async (accessToken, link) => {
      const summary = emptySummary();
      const calendarId = await ensureCalendar({
        accessToken,
        link,
        provider: input.provider,
        timeZone: input.timeZone,
        db: input.db,
        userId: input.userId,
      });
      if (!calendarId) {
        summary.skipped += 1;
        return summary;
      }

      const [duties, personal] = await Promise.all([
        collectDutyExports({
          db: input.db,
          userId: input.userId,
          fromUtc,
          toUtc,
        }),
        collectPersonalExports({
          db: input.db,
          userId: input.userId,
          fromDate: fromUtc.toISOString().slice(0, 10),
          toDate: toUtc.toISOString().slice(0, 10),
          timeZone: input.timeZone,
        }),
      ]);
      const candidates = [...duties, ...personal];
      const byKey = new Map(
        candidates.map((candidate) => [candidateKey(candidate), candidate]),
      );

      const existing = (await input.db
        .select({
          id: externalCalendarEventLinks.id,
          externalEventId: externalCalendarEventLinks.externalEventId,
          externalEtag: externalCalendarEventLinks.externalEtag,
          contentFingerprint: externalCalendarEventLinks.contentFingerprint,
          sourceKind: externalCalendarEventLinks.sourceKind,
          sourceId: externalCalendarEventLinks.sourceId,
          occurrenceKey: externalCalendarEventLinks.occurrenceKey,
          deletedAt: externalCalendarEventLinks.deletedAt,
        })
        .from(externalCalendarEventLinks)
        .where(
          and(
            eq(externalCalendarEventLinks.userId, input.userId),
            eq(externalCalendarEventLinks.provider, PROVIDER),
            eq(externalCalendarEventLinks.externalCalendarId, calendarId),
          ),
        )) as LinkRow[];

      const existingByKey = new Map(
        existing.map((row) => [candidateKey(row), row]),
      );

      let writes = 0;
      for (const [key, candidate] of byKey) {
        if (writes >= SYNC_MAX_WRITES_PER_RUN) {
          summary.skipped += 1;
          continue;
        }
        const fingerprint = fingerprintEvent(candidate);
        const row = existingByKey.get(key);
        if (row && !row.deletedAt && row.contentFingerprint === fingerprint) {
          summary.unchanged += 1;
          continue;
        }

        const write: ExternalCalendarWriteRequest = {
          calendarId,
          externalEventId: row && !row.deletedAt ? row.externalEventId : null,
          summary: candidate.summary,
          startsAtUtc: candidate.startsAtUtc,
          endsAtUtc: candidate.endsAtUtc,
          allDay: candidate.allDay,
          busy: candidate.busy,
          timeZone: candidate.timeZone,
          originMarker: ESCALA_ORIGIN_MARKER,
          expectedEtag: row?.externalEtag ?? null,
        };

        const result = await input.provider.upsertEvent({
          accessToken,
          request: write,
        });
        writes += 1;
        if (!result.ok) {
          // Uma falha pontual não pode abortar o ciclo inteiro: o próximo
          // item pode estar são, e o retry cobre este.
          summary.skipped += 1;
          continue;
        }

        if (row) {
          const wasTombstoned = Boolean(row.deletedAt);
          await input.db
            .update(externalCalendarEventLinks)
            .set({
              externalEventId: result.value.externalEventId,
              externalEtag: result.value.etag,
              contentFingerprint: fingerprint,
              lastPushedAt: now,
              deletedAt: null,
            })
            .where(eq(externalCalendarEventLinks.id, row.id));
          // Uma linha com tombstone significa que o evento não existe mais no
          // provedor — o que acabou de acontecer foi criação, não atualização.
          // Contar como "atualizado" faria o resumo mentir para quem o lê.
          if (wasTombstoned) summary.created += 1;
          else summary.updated += 1;
        } else {
          await input.db
            .insert(externalCalendarEventLinks)
            .values({
              userId: input.userId,
              provider: PROVIDER,
              externalCalendarId: calendarId,
              externalEventId: result.value.externalEventId,
              sourceKind: candidate.sourceKind,
              sourceId: candidate.sourceId,
              occurrenceKey: candidate.occurrenceKey,
              externalEtag: result.value.etag,
              contentFingerprint: fingerprint,
              lastPushedAt: now,
            })
            .onDuplicateKeyUpdate({
              set: {
                externalEventId: result.value.externalEventId,
                externalEtag: result.value.etag,
                contentFingerprint: fingerprint,
                lastPushedAt: now,
                deletedAt: null,
              },
            });
          summary.created += 1;
        }
      }

      // Tombstones: o que saiu da origem sai do Google. Sem isto, um plantão
      // cancelado continuaria no calendário do médico para sempre.
      for (const row of existing) {
        if (row.deletedAt) continue;
        if (byKey.has(candidateKey(row))) continue;
        if (writes >= SYNC_MAX_WRITES_PER_RUN) break;
        const deleted = await input.provider.deleteEvent({
          accessToken,
          calendarId,
          externalEventId: row.externalEventId,
          expectedEtag: row.externalEtag,
        });
        writes += 1;
        if (!deleted.ok) {
          summary.skipped += 1;
          continue;
        }
        await input.db
          .update(externalCalendarEventLinks)
          .set({ deletedAt: now })
          .where(eq(externalCalendarEventLinks.id, row.id));
        summary.deleted += 1;
      }

      await recordGoogleOutcome({
        db: input.db,
        userId: input.userId,
        outcome: PROVIDER_OUTCOMES.success,
        now,
      });
      return summary;
    },
  });
}

async function ensureCalendar(input: {
  accessToken: string;
  link: GoogleLinkSnapshot;
  provider: ExternalCalendarProvider;
  timeZone: string;
  db: SyncDb;
  userId: number;
}): Promise<string | null> {
  if (input.link.externalCalendarId) return input.link.externalCalendarId;
  const created = await input.provider.ensureDedicatedCalendar({
    accessToken: input.accessToken,
    timeZone: input.timeZone,
  });
  if (!created.ok) return null;
  await input.db
    .update(userExternalCredentials)
    .set({ externalCalendarId: created.value.calendarId })
    .where(
      and(
        eq(userExternalCredentials.userId, input.userId),
        eq(userExternalCredentials.provider, PROVIDER),
      ),
    );
  return created.value.calendarId;
}

/**
 * Leitura incremental do calendário dedicado.
 *
 * Serve para uma coisa só nesta frente: perceber que o usuário apagou no
 * Google um evento que nós mantemos. Como plantão é read-only, a resposta
 * correta é recriar no próximo ciclo — e para isso basta esquecer o vínculo.
 *
 * `410 Gone` (sync token expirado) é estado ESPERADO: zera o cursor e o
 * próximo ciclo faz leitura completa. Nunca desconecta o usuário.
 */
export async function pullGoogleCalendarChanges(input: {
  db: SyncDb;
  userId: number;
  config: GoogleOAuthConfig;
  provider: ExternalCalendarProvider;
  now?: Date;
}): Promise<ProviderCallResult<{ forgotten: number; resynced: boolean }>> {
  const now = input.now ?? new Date();
  return withGoogleAccessToken({
    db: input.db,
    userId: input.userId,
    refresh: (refreshToken) =>
      input.provider.refreshAccessToken({ refreshToken }),
    run: async (accessToken, link) => {
      if (!link.externalCalendarId) return { forgotten: 0, resynced: false };

      const cursor = link.syncCursor
        ? ({ kind: "SYNC_TOKEN", token: link.syncCursor } as const)
        : ({
            kind: "FULL_RESYNC",
            since: new Date(now.getTime() - SYNC_PAST_DAYS * 86_400_000),
          } as const);

      const page = await input.provider.listChanges({
        accessToken,
        calendarId: link.externalCalendarId,
        cursor,
      });

      if (!page.ok) {
        if (page.reason === PROVIDER_FAILURE_REASONS.notFound) {
          // Sync token expirado: esquece o cursor e recomeça limpo.
          await saveGoogleSyncCursor({
            db: input.db,
            userId: input.userId,
            cursor: null,
            now,
          });
          return { forgotten: 0, resynced: true };
        }
        return { forgotten: 0, resynced: false };
      }

      let forgotten = 0;
      for (const event of page.value.events) {
        if (!event.cancelled) continue;
        // Só nos importa o que NÓS criamos. Evento alheio cancelado é assunto
        // do usuário, e reagir a ele seria invadir a agenda dele.
        if (event.originMarker !== ESCALA_ORIGIN_MARKER) continue;
        const [updated] = await input.db
          .update(externalCalendarEventLinks)
          .set({ deletedAt: now })
          .where(
            and(
              eq(externalCalendarEventLinks.userId, input.userId),
              eq(externalCalendarEventLinks.provider, PROVIDER),
              eq(
                externalCalendarEventLinks.externalEventId,
                event.externalEventId,
              ),
              isNull(externalCalendarEventLinks.deletedAt),
            ),
          );
        if (updated && updated.affectedRows > 0) forgotten += 1;
      }

      if (page.value.nextSyncToken) {
        await saveGoogleSyncCursor({
          db: input.db,
          userId: input.userId,
          cursor: page.value.nextSyncToken,
          now,
        });
      }

      return { forgotten, resynced: cursor.kind === "FULL_RESYNC" };
    },
  });
}

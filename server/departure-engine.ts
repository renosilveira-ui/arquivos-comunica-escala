import { and, asc, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm";

import {
  departurePlans,
  hospitals,
  institutions,
  professionals,
  sectors,
  shiftAssignmentsV2,
  shiftInstances,
  userDeparturePreferences,
  userTravelOrigins,
} from "../drizzle/schema";
import { getDb } from "./db";
import {
  buildDepartureMessage,
  computeDeparture,
  departureDedupKey,
  desiredArrival,
  isDepartureExpired,
  isWithinPlanningHorizon,
  nextRecomputeAt,
  normalizePreferences,
  originSignature,
  shiftSignature,
  shouldSendDeparture,
  type DeparturePreferences,
  type RouteSample,
} from "./departure-planning";
import {
  EXTERNAL_PROVIDERS,
  TRAVEL_ORIGIN_SEAL_SCOPE,
} from "../lib/integration-providers";
import { openExternalCredential } from "./external-credentials-crypto";
import { resolveScheduleTimeZone } from "./institution-time-zone";
import type { LocationProvider } from "./integrations/providers/location-provider";
import { ROUTE_ESTIMATE_QUALITY } from "./integrations/providers/location-provider";
import type { WeatherProvider } from "./integrations/providers/weather-provider";
import { weatherAdviceLine } from "./integrations/apple/weatherkit-client";
import {
  coarsenGeoPoint,
  isValidGeoPoint,
  type GeoPoint,
} from "./integrations/providers/types";

/**
 * Worker do aviso de "hora de sair".
 *
 * O cálculo NÃO pode viver em `setTimeout`: o processo do Render dorme a cada
 * 15 minutos sem tráfego no plano free, e um timer de 8 horas simplesmente
 * não existe depois disso. A intenção é persistida em `departure_plans`, e
 * cada passo é idempotente — rodar duas vezes produz o mesmo estado.
 *
 * Três fases, deliberadamente separadas:
 *
 * 1. `syncDeparturePlans` — reconcilia planos com as alocações do usuário.
 * 2. `recomputeDuePlans` — calcula rota e clima para os planos que venceram.
 * 3. `dispatchDueDepartures` — envia o push de quem chegou a hora.
 *
 * Separar permite que uma falha de rede na fase 2 não impeça a fase 3 de
 * enviar um plano que já tinha horário calculado.
 */

type EngineDb = NonNullable<Awaited<ReturnType<typeof getDb>>>;

export const RECOMPUTE_BATCH_SIZE = 25;

/**
 * `TIMESTAMP` no MySQL não tem fração de segundo e ARREDONDA o milissegundo
 * em vez de cortá-lo. Um plano gravado em T.700 vira T+1s no banco, e o
 * worker que roda em T deixa de enxergá-lo como vencido — o recálculo só sai
 * no tick seguinte, e o teste passa ou falha conforme o milissegundo do
 * relógio.
 *
 * Truncar antecipa em menos de 1 s, o que é sempre seguro aqui: um aviso
 * calculado um segundo antes não muda nada, e um aviso escondido do worker
 * muda tudo. É o mesmo conserto que o outbox de recuperação de credenciais
 * já carrega.
 */
export function truncateToStoredSecond(instant: Date): Date {
  return new Date(Math.floor(instant.getTime() / 1000) * 1000);
}
export const DISPATCH_BATCH_SIZE = 50;

export type StoredTravelOrigin = {
  id: number;
  label: string;
  location: GeoPoint;
  placeId: string | null;
  formattedAddress: string | null;
  /** Assinatura do conteúdo, para invalidar cálculo quando a origem muda. */
  fingerprint: string;
};

/**
 * Abre a origem selada do usuário.
 *
 * O endereço residencial é o dado mais sensível deste sistema. Ele sai daqui
 * apenas como coordenada para o cálculo de rota, e nunca é registrado em log
 * nem devolvido a nenhuma tela de listagem.
 */
export async function readTravelOrigin(
  db: EngineDb,
  userId: number,
  originId: number | null,
): Promise<StoredTravelOrigin | null> {
  const rows = await db
    .select({
      id: userTravelOrigins.id,
      label: userTravelOrigins.label,
      sealedLocation: userTravelOrigins.sealedLocation,
      isDefault: userTravelOrigins.isDefault,
    })
    .from(userTravelOrigins)
    .where(
      originId
        ? and(
            eq(userTravelOrigins.userId, userId),
            eq(userTravelOrigins.id, originId),
          )
        : and(
            eq(userTravelOrigins.userId, userId),
            eq(userTravelOrigins.isDefault, true),
          ),
    )
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  try {
    const plain = openExternalCredential(row.sealedLocation, {
      userId,
      scope: TRAVEL_ORIGIN_SEAL_SCOPE,
    });
    const parsed = JSON.parse(plain) as {
      latitude?: unknown;
      longitude?: unknown;
      placeId?: unknown;
      formattedAddress?: unknown;
    };
    const location = {
      latitude: Number(parsed.latitude),
      longitude: Number(parsed.longitude),
    };
    if (!isValidGeoPoint(location)) return null;
    return {
      id: row.id,
      label: row.label,
      location,
      placeId: typeof parsed.placeId === "string" ? parsed.placeId : null,
      formattedAddress:
        typeof parsed.formattedAddress === "string"
          ? parsed.formattedAddress
          : null,
      // Coordenada arredondada como impressão digital: muda quando a origem
      // muda de verdade, sem guardar a posição exata numa coluna indexada.
      fingerprint: `${location.latitude.toFixed(4)},${location.longitude.toFixed(4)}`,
    };
  } catch {
    // Envelope ilegível (rotação incompleta, adulteração): trata como origem
    // ausente e o plano cai para o fallback declarado.
    return null;
  }
}

export async function readDeparturePreferences(
  db: EngineDb,
  userId: number,
): Promise<DeparturePreferences & { travelOriginId: number | null }> {
  const [row] = await db
    .select({
      enabled: userDeparturePreferences.enabled,
      travelOriginId: userDeparturePreferences.travelOriginId,
      travelMode: userDeparturePreferences.travelMode,
      arrivalMarginMinutes: userDeparturePreferences.arrivalMarginMinutes,
      fallbackTravelMinutes: userDeparturePreferences.fallbackTravelMinutes,
    })
    .from(userDeparturePreferences)
    .where(eq(userDeparturePreferences.userId, userId))
    .limit(1);

  return {
    ...normalizePreferences(row ?? null),
    travelOriginId: row?.travelOriginId ?? null,
  };
}

type UpcomingAssignment = {
  assignmentId: number;
  institutionId: number;
  shiftInstanceId: number;
  startAt: Date;
  endAt: Date;
  sectorId: number;
  sectorName: string;
  hospitalId: number;
  hospitalName: string;
  hospitalLatitude: string | null;
  hospitalLongitude: string | null;
  hospitalTimeZone: string | null;
  institutionTimeZone: string | null;
};

/**
 * Alocações futuras do usuário, em todas as instituições dele.
 *
 * Account-wide porque o médico só tem um corpo: ele sai de casa uma vez, e o
 * hospital de destino pode ser qualquer um dos vínculos. O `WHERE` continua
 * preso ao `user_id`, então nenhum plantão de terceiro entra.
 */
export async function listUpcomingAssignments(input: {
  db: EngineDb;
  userId: number;
  now: Date;
  horizonMs: number;
}): Promise<UpcomingAssignment[]> {
  const until = new Date(input.now.getTime() + input.horizonMs);
  return input.db
    .select({
      assignmentId: shiftAssignmentsV2.id,
      institutionId: shiftInstances.institutionId,
      shiftInstanceId: shiftInstances.id,
      startAt: shiftInstances.startAt,
      endAt: shiftInstances.endAt,
      sectorId: sectors.id,
      sectorName: sectors.name,
      hospitalId: hospitals.id,
      hospitalName: hospitals.name,
      hospitalLatitude: hospitals.latitude,
      hospitalLongitude: hospitals.longitude,
      hospitalTimeZone: hospitals.timeZone,
      institutionTimeZone: institutions.timeZone,
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
        gt(shiftInstances.startAt, input.now),
        lte(shiftInstances.startAt, until),
      ),
    )
    .orderBy(asc(shiftInstances.startAt))
    .limit(200);
}

export type SyncPlansSummary = {
  created: number;
  refreshed: number;
  cancelled: number;
};

/**
 * Reconcilia os planos do usuário com as alocações dele.
 *
 * Cancela o que perdeu a origem (plantão removido, trocado, preferência
 * desligada) e cria o que falta. Não calcula rota — isso é da fase 2, e
 * misturar as duas faria uma falha de rede impedir o cancelamento de um
 * plano que já não deveria existir.
 */
export async function syncDeparturePlans(input: {
  db: EngineDb;
  userId: number;
  now?: Date;
}): Promise<SyncPlansSummary> {
  const now = input.now ?? new Date();
  const summary: SyncPlansSummary = { created: 0, refreshed: 0, cancelled: 0 };
  const preferences = await readDeparturePreferences(input.db, input.userId);

  const existing = await input.db
    .select({
      id: departurePlans.id,
      assignmentId: departurePlans.assignmentId,
      status: departurePlans.status,
      shiftSignature: departurePlans.shiftSignature,
      originSignature: departurePlans.originSignature,
    })
    .from(departurePlans)
    .where(
      and(
        eq(departurePlans.userId, input.userId),
        inArray(departurePlans.status, ["PENDING", "SCHEDULED", "UNAVAILABLE"]),
      ),
    );

  // Desligou o aviso: todo plano aberto some. Manter planos de quem optou por
  // não receber seria guardar intenção que o usuário revogou.
  if (!preferences.enabled) {
    if (existing.length > 0) {
      await input.db
        .update(departurePlans)
        .set({
          status: "CANCELLED",
          version: sql`${departurePlans.version} + 1`,
        })
        .where(
          inArray(
            departurePlans.id,
            existing.map((plan) => plan.id),
          ),
        );
      summary.cancelled = existing.length;
    }
    return summary;
  }

  const origin = await readTravelOrigin(
    input.db,
    input.userId,
    preferences.travelOriginId,
  );
  const assignments = await listUpcomingAssignments({
    db: input.db,
    userId: input.userId,
    now,
    horizonMs: 30 * 24 * 60 * 60 * 1000,
  });

  const existingByAssignment = new Map(
    existing.map((plan) => [plan.assignmentId, plan]),
  );
  const liveAssignmentIds = new Set<number>();

  for (const assignment of assignments) {
    if (!isWithinPlanningHorizon(assignment.startAt, now)) continue;
    liveAssignmentIds.add(assignment.assignmentId);

    const destination =
      assignment.hospitalLatitude && assignment.hospitalLongitude
        ? {
            latitude: Number(assignment.hospitalLatitude),
            longitude: Number(assignment.hospitalLongitude),
          }
        : null;

    const shiftFingerprint = shiftSignature({
      shiftInstanceId: assignment.shiftInstanceId,
      startsAtUtc: assignment.startAt,
      endsAtUtc: assignment.endAt,
      sectorId: assignment.sectorId,
      hospitalId: assignment.hospitalId,
    });
    const originFingerprint = originSignature({
      travelOriginId: origin?.id ?? null,
      originFingerprint: origin?.fingerprint ?? null,
      destination:
        destination && isValidGeoPoint(destination) ? destination : null,
      preferences,
    });
    const arrival = desiredArrival(
      assignment.startAt,
      preferences.arrivalMarginMinutes,
    );

    const current = existingByAssignment.get(assignment.assignmentId);
    if (current) {
      const unchanged =
        current.shiftSignature === shiftFingerprint &&
        current.originSignature === originFingerprint;
      if (unchanged) continue;
      // Mundo mudou: o cálculo anterior descreve uma realidade que não existe
      // mais. Volta para PENDING em vez de disparar o horário antigo.
      await input.db
        .update(departurePlans)
        .set({
          status: "PENDING",
          desiredArrivalAt: arrival,
          shiftSignature: shiftFingerprint,
          originSignature: originFingerprint,
          travelOriginId: origin?.id ?? null,
          departAt: null,
          nextRecomputeAt: truncateToStoredSecond(now),
          estimatedDurationSeconds: null,
          estimateQuality: null,
          version: sql`${departurePlans.version} + 1`,
        })
        .where(eq(departurePlans.id, current.id));
      summary.refreshed += 1;
      continue;
    }

    await input.db
      .insert(departurePlans)
      .values({
        userId: input.userId,
        institutionId: assignment.institutionId,
        assignmentId: assignment.assignmentId,
        shiftInstanceId: assignment.shiftInstanceId,
        travelOriginId: origin?.id ?? null,
        status: "PENDING",
        desiredArrivalAt: arrival,
        nextRecomputeAt: truncateToStoredSecond(now),
        shiftSignature: shiftFingerprint,
        originSignature: originFingerprint,
        // Chave provisória até haver horário: única por alocação, para a
        // inserção concorrente não duplicar o plano.
        dedupKey: `departure-pending:${input.userId}:${assignment.assignmentId}`,
      })
      .onDuplicateKeyUpdate({
        set: {
          desiredArrivalAt: arrival,
          shiftSignature: shiftFingerprint,
          originSignature: originFingerprint,
          version: sql`${departurePlans.version} + 1`,
        },
      });
    summary.created += 1;
  }

  const orphans = existing.filter(
    (plan) => !liveAssignmentIds.has(plan.assignmentId),
  );
  if (orphans.length > 0) {
    await input.db
      .update(departurePlans)
      .set({ status: "CANCELLED", version: sql`${departurePlans.version} + 1` })
      .where(
        inArray(
          departurePlans.id,
          orphans.map((plan) => plan.id),
        ),
      );
    summary.cancelled = orphans.length;
  }

  return summary;
}

export type RecomputeSummary = {
  computed: number;
  fallback: number;
  unavailable: number;
};

/**
 * Calcula rota (e clima) para os planos vencidos.
 *
 * O clima é enriquecimento: uma falha dele nunca impede o cálculo nem o
 * envio. Já a rota tem hierarquia explícita — fresca, última válida, ou
 * fallback declarado — implementada em `computeDeparture`.
 */
export async function recomputeDuePlans(input: {
  db: EngineDb;
  locationProvider: LocationProvider | null;
  weatherProvider?: WeatherProvider | null;
  now?: Date;
  limit?: number;
}): Promise<RecomputeSummary> {
  const now = input.now ?? new Date();
  const summary: RecomputeSummary = {
    computed: 0,
    fallback: 0,
    unavailable: 0,
  };

  const due = await input.db
    .select({
      id: departurePlans.id,
      userId: departurePlans.userId,
      assignmentId: departurePlans.assignmentId,
      shiftInstanceId: departurePlans.shiftInstanceId,
      travelOriginId: departurePlans.travelOriginId,
      desiredArrivalAt: departurePlans.desiredArrivalAt,
      estimatedDurationSeconds: departurePlans.estimatedDurationSeconds,
      estimateQuality: departurePlans.estimateQuality,
      computedAt: departurePlans.computedAt,
      version: departurePlans.version,
    })
    .from(departurePlans)
    .where(
      and(
        inArray(departurePlans.status, ["PENDING", "SCHEDULED"]),
        or(
          isNull(departurePlans.nextRecomputeAt),
          lte(departurePlans.nextRecomputeAt, now),
        ),
      ),
    )
    .orderBy(asc(departurePlans.desiredArrivalAt))
    .limit(input.limit ?? RECOMPUTE_BATCH_SIZE);

  for (const plan of due) {
    const preferences = await readDeparturePreferences(input.db, plan.userId);
    const origin = await readTravelOrigin(
      input.db,
      plan.userId,
      plan.travelOriginId,
    );

    const [shift] = await input.db
      .select({
        startAt: shiftInstances.startAt,
        hospitalLatitude: hospitals.latitude,
        hospitalLongitude: hospitals.longitude,
      })
      .from(shiftInstances)
      .innerJoin(sectors, eq(sectors.id, shiftInstances.sectorId))
      .innerJoin(hospitals, eq(hospitals.id, sectors.hospitalId))
      .where(eq(shiftInstances.id, plan.shiftInstanceId))
      .limit(1);

    const destination =
      shift?.hospitalLatitude && shift?.hospitalLongitude
        ? {
            latitude: Number(shift.hospitalLatitude),
            longitude: Number(shift.hospitalLongitude),
          }
        : null;

    let fresh: RouteSample | null = null;
    if (
      input.locationProvider &&
      origin &&
      destination &&
      isValidGeoPoint(destination)
    ) {
      // Primeira passada com a chegada desejada como referência de partida;
      // a Routes modela trânsito a partir da saída, então convergir uma vez
      // aproxima o suficiente sem dobrar o custo de cota.
      const guess = await input.locationProvider.computeRoute({
        origin: origin.location,
        destination,
        travelMode: preferences.travelMode,
        departAtUtc: new Date(
          Math.max(
            now.getTime(),
            plan.desiredArrivalAt.getTime() - 60 * 60 * 1000,
          ),
        ),
      });
      if (guess.ok) {
        const refined = await input.locationProvider.computeRoute({
          origin: origin.location,
          destination,
          travelMode: preferences.travelMode,
          departAtUtc: new Date(
            plan.desiredArrivalAt.getTime() -
              guess.value.durationSeconds * 1000,
          ),
        });
        const chosen = refined.ok ? refined.value : guess.value;
        fresh = {
          durationSeconds: chosen.durationSeconds,
          distanceMeters: chosen.distanceMeters,
          quality: chosen.quality,
          computedAtUtc: chosen.computedAtUtc,
        };
      }
    }

    const lastKnown: RouteSample | null =
      plan.estimatedDurationSeconds && plan.computedAt && plan.estimateQuality
        ? {
            durationSeconds: plan.estimatedDurationSeconds,
            distanceMeters: 0,
            quality: plan.estimateQuality,
            computedAtUtc: plan.computedAt,
          }
        : null;

    const computed = computeDeparture({
      desiredArrivalAtUtc: plan.desiredArrivalAt,
      fresh,
      lastKnown,
      fallbackTravelMinutes: preferences.fallbackTravelMinutes,
      now,
    });

    let weatherSummary: string | null = null;
    if (input.weatherProvider && destination && isValidGeoPoint(destination)) {
      const forecast = await input.weatherProvider.forecastAt({
        coarseLocation: coarsenGeoPoint(destination),
        atUtc: computed.departAt,
        timeZone: "America/Sao_Paulo",
      });
      // Clima é ornamento: falha aqui não altera o cálculo nem impede o envio.
      if (forecast.ok) weatherSummary = weatherAdviceLine(forecast.value);
    }

    const dedupKey = departureDedupKey({
      userId: plan.userId,
      assignmentId: plan.assignmentId,
      departAtUtc: computed.departAt,
    });

    const [updated] = await input.db
      .update(departurePlans)
      .set({
        status: "SCHEDULED",
        departAt: truncateToStoredSecond(computed.departAt),
        estimatedDurationSeconds: computed.durationSeconds,
        estimatedDistanceMeters: fresh?.distanceMeters ?? null,
        estimateQuality: computed.quality,
        weatherSummary,
        dedupKey,
        computedAt: now,
        nextRecomputeAt: (() => {
          const next = nextRecomputeAt(computed.departAt, now);
          return next ? truncateToStoredSecond(next) : null;
        })(),
        lastFailureReason: null,
        version: sql`${departurePlans.version} + 1`,
      })
      .where(
        and(
          eq(departurePlans.id, plan.id),
          // CAS: se outra execução recalculou este plano no meio, esta desiste.
          eq(departurePlans.version, plan.version),
        ),
      );

    if (!updated || updated.affectedRows !== 1) continue;

    if (computed.quality === ROUTE_ESTIMATE_QUALITY.fallback) {
      summary.fallback += 1;
    } else {
      summary.computed += 1;
    }
  }

  return summary;
}

export type DispatchSummary = {
  sent: number;
  expired: number;
  /** Entregas que falharam no transporte; o outbox de push faz o retry. */
  failed: number;
};

export type DepartureSender = (input: {
  institutionId: number;
  userId: number;
  shiftInstanceId: number;
  dedupKey: string;
  title: string;
  body: string;
  deepLink: string;
}) => Promise<void>;

/**
 * Envia os avisos cuja hora chegou.
 *
 * O status vira `SENT` por CAS **antes** do envio: se o push falhar, o
 * plano não é reenviado num loop. Perder um aviso é ruim; mandar cinco é
 * pior — treina o médico a silenciar o app.
 */
export async function dispatchDueDepartures(input: {
  db: EngineDb;
  send: DepartureSender;
  now?: Date;
  limit?: number;
}): Promise<DispatchSummary> {
  const now = input.now ?? new Date();
  const summary: DispatchSummary = { sent: 0, expired: 0, failed: 0 };

  const due = await input.db
    .select({
      id: departurePlans.id,
      userId: departurePlans.userId,
      institutionId: departurePlans.institutionId,
      shiftInstanceId: departurePlans.shiftInstanceId,
      departAt: departurePlans.departAt,
      dedupKey: departurePlans.dedupKey,
      estimatedDurationSeconds: departurePlans.estimatedDurationSeconds,
      estimateQuality: departurePlans.estimateQuality,
      weatherSummary: departurePlans.weatherSummary,
      version: departurePlans.version,
    })
    .from(departurePlans)
    .where(
      and(
        eq(departurePlans.status, "SCHEDULED"),
        lte(departurePlans.departAt, now),
      ),
    )
    .orderBy(asc(departurePlans.departAt))
    .limit(input.limit ?? DISPATCH_BATCH_SIZE);

  for (const plan of due) {
    if (!plan.departAt) continue;

    if (isDepartureExpired({ departAtUtc: plan.departAt, now })) {
      // "Saia às 18h07" entregue às 18h40 não ajuda: o médico confere o
      // relógio e conclui que o app está errado.
      await input.db
        .update(departurePlans)
        .set({
          status: "CANCELLED",
          lastFailureReason: "EXPIRED",
          version: sql`${departurePlans.version} + 1`,
        })
        .where(
          and(
            eq(departurePlans.id, plan.id),
            eq(departurePlans.version, plan.version),
          ),
        );
      summary.expired += 1;
      continue;
    }

    if (!shouldSendDeparture({ departAtUtc: plan.departAt, now })) continue;

    const [shift] = await input.db
      .select({
        startAt: shiftInstances.startAt,
        sectorName: sectors.name,
        hospitalName: hospitals.name,
        hospitalTimeZone: hospitals.timeZone,
        institutionTimeZone: institutions.timeZone,
      })
      .from(shiftInstances)
      .innerJoin(sectors, eq(sectors.id, shiftInstances.sectorId))
      .innerJoin(hospitals, eq(hospitals.id, sectors.hospitalId))
      .innerJoin(institutions, eq(institutions.id, hospitals.institutionId))
      .where(eq(shiftInstances.id, plan.shiftInstanceId))
      .limit(1);
    if (!shift) continue;

    const message = buildDepartureMessage({
      departAtUtc: plan.departAt,
      shiftStartsAtUtc: shift.startAt,
      durationSeconds: plan.estimatedDurationSeconds ?? 0,
      quality: plan.estimateQuality ?? ROUTE_ESTIMATE_QUALITY.fallback,
      stale: plan.estimateQuality === ROUTE_ESTIMATE_QUALITY.fallback,
      sectorName: shift.sectorName,
      hospitalName: shift.hospitalName,
      timeZone: resolveScheduleTimeZone({
        hospitalTimeZone: shift.hospitalTimeZone,
        institutionTimeZone: shift.institutionTimeZone,
      }),
      weatherSummary: plan.weatherSummary,
    });

    // Marca antes de enviar: falha de push não pode virar loop de avisos.
    const [claimed] = await input.db
      .update(departurePlans)
      .set({
        status: "SENT",
        sentAt: now,
        attemptCount: sql`${departurePlans.attemptCount} + 1`,
        version: sql`${departurePlans.version} + 1`,
      })
      .where(
        and(
          eq(departurePlans.id, plan.id),
          eq(departurePlans.status, "SCHEDULED"),
          eq(departurePlans.version, plan.version),
        ),
      );
    if (!claimed || claimed.affectedRows !== 1) continue;

    try {
      await input.send({
        institutionId: plan.institutionId,
        userId: plan.userId,
        shiftInstanceId: plan.shiftInstanceId,
        dedupKey: plan.dedupKey,
        title: message.title,
        body: message.body,
        deepLink: `/shift-details?shiftInstanceId=${plan.shiftInstanceId}`,
      });
      summary.sent += 1;
    } catch {
      // Uma entrega que falha não pode derrubar o lote: os outros médicos do
      // mesmo tick têm plantão hoje também. O plano continua SENT de
      // propósito — o outbox de push já tem retry próprio, e reverter aqui
      // abriria a porta para o mesmo aviso sair duas vezes.
      await input.db
        .update(departurePlans)
        .set({ lastFailureReason: "SEND_FAILED" })
        .where(eq(departurePlans.id, plan.id));
      summary.failed += 1;
    }
  }

  return summary;
}

export { EXTERNAL_PROVIDERS };

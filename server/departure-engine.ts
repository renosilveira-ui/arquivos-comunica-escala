import { and, asc, eq, gt, inArray, lte, or, sql } from "drizzle-orm";

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
  users,
} from "../drizzle/schema";
import { getDb } from "./db";
import {
  PLANNING_HORIZON_MS,
  buildShiftNoticeMessage,
  departureDedupKey,
  departureFor,
  isNoticeExpired,
  isWithinPlanningHorizon,
  noticeAt,
  normalizePreferences,
  originSignature,
  routeComputeAt,
  shiftSignature,
  shouldSendNotice,
  type DeparturePreferences,
  type RouteSample,
} from "./departure-planning";
import {
  AUTOMATIC_ORIGIN_LABEL,
  EXTERNAL_PROVIDERS,
  MAX_ACCEPTED_ACCURACY_METERS,
  MIN_MOVEMENT_METERS,
  TRAVEL_ORIGIN_SEAL_SCOPE,
} from "../lib/integration-providers";
import {
  openExternalCredential,
  sealExternalCredential,
} from "./external-credentials-crypto";
import { resolveScheduleTimeZone } from "./institution-time-zone";
import type { LocationProvider } from "./integrations/providers/location-provider";
import type { WeatherProvider } from "./integrations/providers/weather-provider";
import { weatherAdviceLine } from "./integrations/apple/weatherkit-client";
import {
  coarsenGeoPoint,
  isValidGeoPoint,
  metersBetween,
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
        // Troca e remoção não apagam a alocação: marcam `is_active = 0`. Sem
        // este filtro, o médico receberia "hora de sair" para um plantão que
        // já não é dele — e o plano nunca seria cancelado.
        eq(shiftAssignmentsV2.isActive, true),
        gt(shiftInstances.startAt, input.now),
        lte(shiftInstances.startAt, until),
      ),
    )
    .orderBy(asc(shiftInstances.startAt))
    .limit(200);
}

/** Estados em que um plano ainda pode virar aviso. */
const OPEN_PLAN_STATUSES = ["PENDING", "SCHEDULED"] as const;

type ExistingPlan = {
  status: (typeof departurePlans.$inferSelect)["status"];
  shiftSignature: string | null;
  originSignature: string | null;
};

/**
 * O plano precisa voltar para o início da fila?
 *
 * Três respostas distintas, e confundi-las custa caro nos dois sentidos:
 * ressuscitar o que já foi enviado vira aviso repetido; deixar dormindo o que
 * mudou vira plantão sem aviso.
 */
export function needsReset(input: {
  current: ExistingPlan;
  shiftFingerprint: string;
  originFingerprint: string;
  notice: Date;
  now: Date;
}): boolean {
  const changed =
    input.current.shiftSignature !== input.shiftFingerprint ||
    input.current.originSignature !== input.originFingerprint;
  // Plantão remarcado, setor trocado, origem nova: o cálculo anterior
  // descreve outro mundo.
  if (changed) return true;
  // Mesmo mundo e plano aberto: já está na fila, nada a fazer.
  if (
    input.current.status === "PENDING" ||
    input.current.status === "SCHEDULED"
  )
    return false;
  // Mesmo mundo e já enviado: reenviar treinaria o médico a ignorar.
  if (input.current.status === "SENT") return false;
  // Cancelado com aviso ainda no futuro — foi o usuário desligando e
  // religando o recurso. Cancelado com aviso vencido fica no passado.
  return input.notice.getTime() > input.now.getTime();
}

/**
 * Ponto de partida informado pelo próprio aparelho.
 *
 * Uma linha por conta, sob `AUTOMATIC_ORIGIN_LABEL`: a chave única
 * `(user_id, label)` faz cada envio SUBSTITUIR o anterior. É assim que o
 * sistema guarda onde o médico está agora sem guardar por onde ele andou — a
 * garantia é do banco, não de uma rotina de limpeza.
 *
 * Envio que mal saiu do lugar (< `MIN_MOVEMENT_METERS`) não escreve: o
 * aparelho reporta a cada poucas centenas de metros e regravar o selo a cada
 * quarteirão gastaria escrita sem mudar nenhuma estimativa. Incerteza acima
 * de `MAX_ACCEPTED_ACCURACY_METERS` é recusada: uma estimativa de trânsito
 * sobre "é por aqui, num raio de quilômetros" teria a mesma aparência de uma
 * precisa.
 */
export type RecordAutomaticOriginResult =
  | { stored: true; reason: null }
  | { stored: false; reason: "INVALID" | "IMPRECISE" | "UNCHANGED" };

export async function recordAutomaticOrigin(input: {
  db: EngineDb;
  userId: number;
  point: GeoPoint;
  accuracyMeters: number | null;
  now?: Date;
}): Promise<RecordAutomaticOriginResult> {
  const now = input.now ?? new Date();
  // (0, 0) é o que aparelho sem sinal devolve e fica no Atlântico. Passa em
  // qualquer validação de faixa — e mandaria o médico sair de casa para o
  // golfo da Guiné. O cliente já recusa; o servidor recusa de novo, porque
  // é ele que grava.
  if (
    !isValidGeoPoint(input.point) ||
    (input.point.latitude === 0 && input.point.longitude === 0)
  ) {
    return { stored: false, reason: "INVALID" };
  }
  if (
    input.accuracyMeters !== null &&
    input.accuracyMeters > MAX_ACCEPTED_ACCURACY_METERS
  ) {
    return { stored: false, reason: "IMPRECISE" };
  }

  const current = await readTravelOrigin(input.db, input.userId, null);
  if (
    current &&
    current.label === AUTOMATIC_ORIGIN_LABEL &&
    metersBetween(current.location, input.point) < MIN_MOVEMENT_METERS
  ) {
    return { stored: false, reason: "UNCHANGED" };
  }

  const sealed = sealExternalCredential(
    JSON.stringify({
      placeId: null,
      latitude: input.point.latitude,
      longitude: input.point.longitude,
      formattedAddress: null,
    }),
    { userId: input.userId, scope: TRAVEL_ORIGIN_SEAL_SCOPE },
  );

  await input.db.transaction(async (tx) => {
    await tx
      .update(userTravelOrigins)
      .set({ isDefault: false })
      .where(eq(userTravelOrigins.userId, input.userId));
    await tx
      .insert(userTravelOrigins)
      .values({
        userId: input.userId,
        label: AUTOMATIC_ORIGIN_LABEL,
        sealedLocation: sealed,
        encryptionKid: "current",
        consentGrantedAt: now,
        consentVersion: AUTOMATIC_ORIGIN_CONSENT_VERSION,
        isDefault: true,
      })
      .onDuplicateKeyUpdate({
        set: {
          sealedLocation: sealed,
          encryptionKid: "current",
          consentGrantedAt: now,
          consentVersion: AUTOMATIC_ORIGIN_CONSENT_VERSION,
          isDefault: true,
          version: sql`${userTravelOrigins.version} + 1`,
        },
      });
  });

  // A localização automática passa a ser a origem em uso. Sem isto, uma
  // preferência que apontava para um endereço digitado continuaria mandando
  // o cálculo partir de lá — e o médico, que acabou de ligar a localização,
  // receberia um trânsito de um lugar onde não está. NULL = "usar a padrão",
  // e a padrão agora é a automática.
  await input.db
    .update(userDeparturePreferences)
    .set({
      travelOriginId: null,
      version: sql`${userDeparturePreferences.version} + 1`,
    })
    .where(eq(userDeparturePreferences.userId, input.userId));

  // O plano guarda a assinatura da origem: mudou o ponto, o cálculo anterior
  // descreve outro mundo e precisa refazer.
  await syncDeparturePlans({ db: input.db, userId: input.userId, now });
  return { stored: true, reason: null };
}

/** Versão do consentimento dado pela permissão do sistema operacional. */
export const AUTOMATIC_ORIGIN_CONSENT_VERSION = "localizacao-automatica-v1";

export type SyncPlansSummary = {
  created: number;
  refreshed: number;
  cancelled: number;
};

/**
 * Reconcilia os planos do usuário com as alocações dele.
 *
 * Cancela o que perdeu a origem (plantão removido, trocado, preferência
 * desligada) e cria o que falta. Não chama rede — isso é da fase seguinte, e
 * misturar as duas faria uma falha do Google impedir o cancelamento de um
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
  // Conta excluída (soft-delete) vale como aviso desligado. A exclusão apaga
  // estas linhas, mas um plano que sobreviveu a ela não pode virar aviso.
  const [owner] = await input.db
    .select({ deletedAt: users.deletedAt })
    .from(users)
    .where(eq(users.id, input.userId))
    .limit(1);
  const accountClosed = !owner || owner.deletedAt !== null;
  if (accountClosed && preferences.enabled) {
    // Desliga a preferência de vez: a reconciliação varre só quem está
    // ligado, e uma conta excluída não pode ficar sendo revisitada a cada
    // cinco minutos para sempre.
    await input.db
      .update(userDeparturePreferences)
      .set({
        enabled: false,
        version: sql`${userDeparturePreferences.version} + 1`,
      })
      .where(
        and(
          eq(userDeparturePreferences.userId, input.userId),
          eq(userDeparturePreferences.enabled, true),
        ),
      );
  }

  // Desligou o aviso: todo plano aberto some. Manter intenção que o usuário
  // revogou seria guardar o que ele pediu para esquecer.
  if (!preferences.enabled || accountClosed) {
    const open = await input.db
      .select({ id: departurePlans.id })
      .from(departurePlans)
      .where(
        and(
          eq(departurePlans.userId, input.userId),
          inArray(departurePlans.status, OPEN_PLAN_STATUSES),
        ),
      );
    if (open.length > 0) {
      await input.db
        .update(departurePlans)
        .set({
          status: "CANCELLED",
          version: sql`${departurePlans.version} + 1`,
        })
        .where(
          inArray(
            departurePlans.id,
            open.map((plan) => plan.id),
          ),
        );
      summary.cancelled = open.length;
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
    horizonMs: PLANNING_HORIZON_MS,
  });

  /**
   * Planos que interessam a esta reconciliação: os ainda abertos (para
   * cancelar os órfãos) e os de QUALQUER status cujas alocações continuam de
   * pé.
   *
   * Incluir os terminais é o que permite ressuscitar um plano cancelado
   * quando o médico volta a ligar o aviso, e o que evita cair no caminho de
   * INSERT — onde a chave única `(user_id, assignment_id)` transformaria a
   * reconciliação num erro de duplicidade.
   */
  const assignmentIds = assignments.map(
    (assignment) => assignment.assignmentId,
  );
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
        assignmentIds.length > 0
          ? or(
              inArray(departurePlans.status, OPEN_PLAN_STATUSES),
              inArray(departurePlans.assignmentId, assignmentIds),
            )
          : inArray(departurePlans.status, OPEN_PLAN_STATUSES),
      ),
    );

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

    const notice = noticeAt(assignment.startAt);
    const computeAt = routeComputeAt(assignment.startAt);

    const current = existingByAssignment.get(assignment.assignmentId);
    if (current) {
      if (
        !needsReset({
          current,
          shiftFingerprint,
          originFingerprint,
          notice,
          now,
        })
      )
        continue;
      // Mundo mudou (ou o aviso foi religado): o estado anterior descreve uma
      // realidade que não existe mais. Volta para PENDING com chave de
      // deduplicação nova, em vez de disparar a estimativa antiga — ou de
      // ficar preso num status terminal e nunca mais avisar.
      await input.db
        .update(departurePlans)
        .set({
          status: "PENDING",
          noticeAt: truncateToStoredSecond(notice),
          dedupKey: departureDedupKey({
            userId: input.userId,
            assignmentId: assignment.assignmentId,
            noticeAtUtc: notice,
          }),
          shiftSignature: shiftFingerprint,
          originSignature: originFingerprint,
          travelOriginId: origin?.id ?? null,
          departAt: null,
          estimatedDurationSeconds: null,
          estimatedDistanceMeters: null,
          estimateQuality: null,
          weatherSummary: null,
          computedAt: null,
          sentAt: null,
          lastFailureReason: null,
          nextRecomputeAt: truncateToStoredSecond(computeAt),
          version: sql`${departurePlans.version} + 1`,
        })
        .where(eq(departurePlans.id, current.id));
      summary.refreshed += 1;
      continue;
    }

    const [inserted] = await input.db
      .insert(departurePlans)
      .values({
        userId: input.userId,
        institutionId: assignment.institutionId,
        assignmentId: assignment.assignmentId,
        shiftInstanceId: assignment.shiftInstanceId,
        travelOriginId: origin?.id ?? null,
        status: "PENDING",
        noticeAt: truncateToStoredSecond(notice),
        nextRecomputeAt: truncateToStoredSecond(computeAt),
        shiftSignature: shiftFingerprint,
        originSignature: originFingerprint,
        dedupKey: departureDedupKey({
          userId: input.userId,
          assignmentId: assignment.assignmentId,
          noticeAtUtc: notice,
        }),
      })
      // Rede de concorrência: duas reconciliações simultâneas do mesmo
      // usuário. A que perder a corrida não pode virar erro de duplicidade —
      // a vencedora já gravou o plano correto.
      .onDuplicateKeyUpdate({
        set: { version: sql`${departurePlans.version} + 1` },
      });
    // `affectedRows` 1 = inseriu; 2 = a outra execução chegou antes. Contar a
    // corrida perdida como criação faria o log do worker mentir.
    if (inserted?.affectedRows === 1) summary.created += 1;
  }

  const orphans = existing.filter(
    (plan) =>
      !liveAssignmentIds.has(plan.assignmentId) &&
      (plan.status === "PENDING" || plan.status === "SCHEDULED"),
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

/**
 * Quantos usuários uma passada de reconciliação examina.
 *
 * A reconciliação não chama rede — é só banco —, mas varrer todo mundo a cada
 * tick seria trabalho constante para um recurso opt-in. O cursor avança por
 * `user_id` e dá a volta: em poucos minutos todos foram vistos.
 */
export const RECONCILE_BATCH_SIZE = 100;

export type ReconcileSummary = SyncPlansSummary & {
  /** Usuários examinados nesta passada. */
  scanned: number;
  /** Onde a próxima passada recomeça. Zero = volta ao início. */
  nextCursor: number;
};

/**
 * Reconcilia os planos de quem tem o aviso ligado.
 *
 * Sem isto o aviso só existiria para plantões que já estavam na escala quando
 * o médico ligou a preferência: uma alocação feita depois — que é o caso
 * normal, a escala muda toda semana — nunca viraria aviso. O gestor aloca, o
 * médico não recebe nada, e ninguém descobre por quê.
 *
 * É a única fase que varre usuários, e por isso é a única com cursor.
 */
export async function reconcileEnabledUsers(input: {
  db: EngineDb;
  now?: Date;
  afterUserId?: number;
  limit?: number;
}): Promise<ReconcileSummary> {
  const now = input.now ?? new Date();
  const limit = input.limit ?? RECONCILE_BATCH_SIZE;
  const cursor = input.afterUserId ?? 0;

  const enabled = await input.db
    .select({ userId: userDeparturePreferences.userId })
    .from(userDeparturePreferences)
    .where(
      and(
        eq(userDeparturePreferences.enabled, true),
        gt(userDeparturePreferences.userId, cursor),
      ),
    )
    .orderBy(asc(userDeparturePreferences.userId))
    .limit(limit);

  const summary: ReconcileSummary = {
    created: 0,
    refreshed: 0,
    cancelled: 0,
    scanned: enabled.length,
    // Lote incompleto significa fim da lista: a próxima passada recomeça.
    nextCursor:
      enabled.length < limit ? 0 : (enabled[enabled.length - 1]?.userId ?? 0),
  };

  for (const row of enabled) {
    // Um usuário com dados inconsistentes não pode travar a fila dos outros.
    try {
      const one = await syncDeparturePlans({
        db: input.db,
        userId: row.userId,
        now,
      });
      summary.created += one.created;
      summary.refreshed += one.refreshed;
      summary.cancelled += one.cancelled;
    } catch (error) {
      if (isRetryableSyncFailure(error)) continue;
      throw error;
    }
  }

  return summary;
}

/**
 * Falha de um usuário isolado não derruba a varredura — exceto quando a causa
 * é estrutural (tabela ausente), que precisa chegar ao worker para ele
 * adormecer em vez de repetir o erro a cada minuto.
 */
function isRetryableSyncFailure(error: unknown): boolean {
  if (!error || typeof error !== "object") return true;
  return (error as { code?: unknown }).code !== "ER_NO_SUCH_TABLE";
}

export type RecomputeSummary = {
  /** Planos que ganharam estimativa de trânsito. */
  withTraffic: number;
  /** Planos que vão sair sem estimativa — e dizendo isso. */
  withoutTraffic: number;
  /** Planos cujo aviso já passou da tolerância; encerrados sem consultar rota. */
  expired: number;
};

/**
 * Calcula a rota e o clima pouco antes do aviso.
 *
 * **Uma consulta por plantão.** A pergunta é "quanto leva agora", e ela só
 * tem resposta útil agora — calcular na véspera gastaria cota para responder
 * sobre um trânsito que não é o que o médico vai pegar.
 *
 * Sem rota o plano continua de pé: o aviso sai na mesma hora, dizendo que não
 * sabe o trânsito.
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
    withTraffic: 0,
    withoutTraffic: 0,
    expired: 0,
  };

  const due = await input.db
    .select({
      id: departurePlans.id,
      userId: departurePlans.userId,
      assignmentId: departurePlans.assignmentId,
      shiftInstanceId: departurePlans.shiftInstanceId,
      travelOriginId: departurePlans.travelOriginId,
      noticeAt: departurePlans.noticeAt,
      version: departurePlans.version,
    })
    .from(departurePlans)
    .where(
      and(
        inArray(departurePlans.status, OPEN_PLAN_STATUSES),
        // `next_recompute_at` NULL significa "já calculado, nada a fazer" —
        // nunca "calcule agora". Tratar NULL como vencido faria cada tick do
        // worker reconsultar o Google para todo plano já resolvido, e
        // Places/Routes cobram por requisição.
        lte(departurePlans.nextRecomputeAt, now),
      ),
    )
    .orderBy(asc(departurePlans.noticeAt))
    .limit(input.limit ?? RECOMPUTE_BATCH_SIZE);

  for (const plan of due) {
    /**
     * Aviso vencido não vira consulta paga.
     *
     * O worker pode ter dormido (plano free do Render) e acordado horas
     * depois com planos vencidos na fila. Perguntar ao Google quanto leva o
     * trajeto de um aviso que não vai mais sair é gastar cota por nada — e o
     * despacho descartaria o resultado logo em seguida.
     */
    if (isNoticeExpired({ noticeAtUtc: plan.noticeAt, now })) {
      const [closed] = await input.db
        .update(departurePlans)
        .set({
          status: "CANCELLED",
          lastFailureReason: "EXPIRED",
          nextRecomputeAt: null,
          version: sql`${departurePlans.version} + 1`,
        })
        .where(
          and(
            eq(departurePlans.id, plan.id),
            eq(departurePlans.version, plan.version),
          ),
        );
      if (closed && closed.affectedRows === 1) summary.expired += 1;
      continue;
    }

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

    const destination =
      shift.hospitalLatitude && shift.hospitalLongitude
        ? {
            latitude: Number(shift.hospitalLatitude),
            longitude: Number(shift.hospitalLongitude),
          }
        : null;

    let sample: RouteSample | null = null;
    if (
      input.locationProvider &&
      origin &&
      destination &&
      isValidGeoPoint(destination)
    ) {
      // Partida no instante do aviso: é o trânsito daquele horário que
      // interessa, e é sobre ele que a mensagem vai falar.
      const route = await input.locationProvider.computeRoute({
        origin: origin.location,
        destination,
        travelMode: preferences.travelMode,
        departAtUtc: plan.noticeAt,
      });
      if (route.ok) {
        sample = {
          durationSeconds: route.value.durationSeconds,
          distanceMeters: route.value.distanceMeters,
          quality: route.value.quality,
          computedAtUtc: route.value.computedAtUtc,
        };
      }
    }

    let weatherSummary: string | null = null;
    if (input.weatherProvider && destination && isValidGeoPoint(destination)) {
      const forecast = await input.weatherProvider.forecastAt({
        coarseLocation: coarsenGeoPoint(destination),
        atUtc: plan.noticeAt,
        // Fuso do hospital, não um fixo: "noite com chuva" precisa ser noite
        // onde o plantão acontece. Instituição nova em outro fuso herda o
        // comportamento certo sem configuração extra.
        timeZone: resolveScheduleTimeZone({
          hospitalTimeZone: shift.hospitalTimeZone,
          institutionTimeZone: shift.institutionTimeZone,
        }),
      });
      // Clima é ornamento: falha aqui não altera o aviso nem o impede.
      if (forecast.ok) weatherSummary = weatherAdviceLine(forecast.value);
    }

    const [updated] = await input.db
      .update(departurePlans)
      .set({
        status: "SCHEDULED",
        departAt: sample
          ? truncateToStoredSecond(
              departureFor(shift.startAt, sample.durationSeconds),
            )
          : null,
        estimatedDurationSeconds: sample?.durationSeconds ?? null,
        estimatedDistanceMeters: sample?.distanceMeters ?? null,
        estimateQuality: sample?.quality ?? null,
        weatherSummary,
        computedAt: now,
        // Uma consulta por plantão: calculado o trânsito do horário do aviso,
        // não há o que recalcular.
        nextRecomputeAt: null,
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
    if (sample) summary.withTraffic += 1;
    else summary.withoutTraffic += 1;
  }

  return summary;
}

export type DispatchSummary = {
  sent: number;
  expired: number;
  /** Enfileiramentos que falharam; o plano reabre para o próximo tick. */
  failed: number;
  /** Planos de conta excluída, encerrados sem envio. */
  cancelled: number;
};

export type DepartureSender = (input: {
  institutionId: number;
  userId: number;
  shiftInstanceId: number;
  dedupKey: string;
  title: string;
  body: string;
  deepLink: string;
  /**
   * Topologia que permite ao envio provar o destinatário e mandar o texto
   * de verdade. Nula quando alguma peça sumiu entre o cálculo e o envio; aí
   * o aviso sai com a apresentação neutra, como saía antes.
   */
  authority: {
    planId: number;
    assignmentId: number;
    professionalId: number;
    hospitalId: number;
    sectorId: number;
  } | null;
}) => Promise<void>;

/**
 * Envia os avisos cuja hora chegou.
 *
 * O status vira `SENT` por CAS **antes** do envio: dois workers não mandam o
 * mesmo aviso. Se o enfileiramento falhar, o plano reabre para o próximo
 * tick — o outbox de push é idempotente por `dedupKey`, então não há
 * duplicata. Quem limita as retentativas é a janela do aviso
 * (`isNoticeExpired`, 30 min): passada ela, o plano é encerrado como
 * EXPIRED sem enviar. Perder um aviso é ruim; mandar cinco é pior — treina
 * o médico a silenciar o app.
 */
export async function dispatchDueDepartures(input: {
  db: EngineDb;
  send: DepartureSender;
  now?: Date;
  limit?: number;
}): Promise<DispatchSummary> {
  const now = input.now ?? new Date();
  const summary: DispatchSummary = {
    sent: 0,
    expired: 0,
    failed: 0,
    cancelled: 0,
  };

  const due = await input.db
    .select({
      id: departurePlans.id,
      userId: departurePlans.userId,
      institutionId: departurePlans.institutionId,
      shiftInstanceId: departurePlans.shiftInstanceId,
      noticeAt: departurePlans.noticeAt,
      dedupKey: departurePlans.dedupKey,
      estimatedDurationSeconds: departurePlans.estimatedDurationSeconds,
      weatherSummary: departurePlans.weatherSummary,
      attemptCount: departurePlans.attemptCount,
      version: departurePlans.version,
      ownerDeletedAt: users.deletedAt,
      // Topologia do aviso, para o push poder provar o destinatário e enviar
      // o texto de verdade em vez da apresentação neutra. `leftJoin` de
      // propósito: se a alocação tiver sumido, o aviso ainda sai (como saía
      // antes), só que sem autoridade.
      //
      // Com autoridade, o único caso em que o aviso NÃO sai é o plantão ter
      // trocado de mãos — ver `requireAuthorizedDepartureRecipient`. Falha de
      // dado (rota não calculou, setor mudou) devolve o texto neutro, nunca
      // silêncio: `depart_at` nulo chega aqui porque o disparo não filtra por
      // ele, e quem tem plantão precisa ser avisado de alguma forma.
      assignmentId: departurePlans.assignmentId,
      professionalId: shiftAssignmentsV2.professionalId,
      hospitalId: shiftInstances.hospitalId,
      sectorId: shiftInstances.sectorId,
    })
    .from(departurePlans)
    .innerJoin(users, eq(users.id, departurePlans.userId))
    .leftJoin(
      shiftAssignmentsV2,
      and(
        eq(shiftAssignmentsV2.id, departurePlans.assignmentId),
        eq(shiftAssignmentsV2.institutionId, departurePlans.institutionId),
        eq(shiftAssignmentsV2.shiftInstanceId, departurePlans.shiftInstanceId),
      ),
    )
    .leftJoin(
      shiftInstances,
      and(
        eq(shiftInstances.id, departurePlans.shiftInstanceId),
        eq(shiftInstances.institutionId, departurePlans.institutionId),
      ),
    )
    .where(
      and(
        eq(departurePlans.status, "SCHEDULED"),
        lte(departurePlans.noticeAt, now),
      ),
    )
    .orderBy(asc(departurePlans.noticeAt))
    .limit(input.limit ?? DISPATCH_BATCH_SIZE);

  for (const plan of due) {
    if (plan.ownerDeletedAt) {
      // Conta excluída: a exclusão apaga os planos, mas um que tenha
      // sobrevivido não pode virar push para quem encerrou a conta.
      const [closed] = await input.db
        .update(departurePlans)
        .set({
          status: "CANCELLED",
          lastFailureReason: "ACCOUNT_DELETED",
          version: sql`${departurePlans.version} + 1`,
        })
        .where(
          and(
            eq(departurePlans.id, plan.id),
            eq(departurePlans.version, plan.version),
          ),
        );
      // CAS perdido: outro passo já mexeu no plano; conta só o que aconteceu.
      if (closed && closed.affectedRows === 1) summary.cancelled += 1;
      continue;
    }

    if (isNoticeExpired({ noticeAtUtc: plan.noticeAt, now })) {
      // Entregue muito depois, o aviso atrapalha: o médico confere o relógio
      // e conclui que o app está errado.
      const [expired] = await input.db
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
      if (expired && expired.affectedRows === 1) summary.expired += 1;
      continue;
    }

    if (!shouldSendNotice({ noticeAtUtc: plan.noticeAt, now })) continue;

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

    const message = buildShiftNoticeMessage({
      shiftStartsAtUtc: shift.startAt,
      sectorName: shift.sectorName,
      hospitalName: shift.hospitalName,
      timeZone: resolveScheduleTimeZone({
        hospitalTimeZone: shift.hospitalTimeZone,
        institutionTimeZone: shift.institutionTimeZone,
      }),
      durationSeconds: plan.estimatedDurationSeconds,
      weatherSummary: plan.weatherSummary,
      now,
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
        // Só quando a topologia inteira está de pé. Falta de qualquer peça
        // mantém o comportamento antigo (apresentação neutra), em vez de
        // engolir o aviso.
        authority:
          plan.professionalId && plan.hospitalId && plan.sectorId
            ? {
                planId: plan.id,
                assignmentId: plan.assignmentId,
                professionalId: plan.professionalId,
                hospitalId: plan.hospitalId,
                sectorId: plan.sectorId,
              }
            : null,
      });
      summary.sent += 1;
    } catch {
      // Uma entrega que falha não derruba o lote: os outros médicos do mesmo
      // tick têm plantão hoje também. O que falhou aqui foi o ENFILEIRAMENTO,
      // então reabrir o plano para o próximo tick não duplica nada — o
      // outbox é idempotente por dedupKey, e o envio trata a intenção já
      // gravada como entregue. Quem encerra as retentativas é a janela do
      // aviso (`isNoticeExpired`): passada ela, o plano vira EXPIRED sem
      // enviar, e não há loop.
      const [reopened] = await input.db
        .update(departurePlans)
        .set({
          status: "SCHEDULED",
          sentAt: null,
          lastFailureReason: "SEND_FAILED",
          version: sql`${departurePlans.version} + 1`,
        })
        .where(
          and(
            eq(departurePlans.id, plan.id),
            eq(departurePlans.status, "SENT"),
            eq(departurePlans.version, plan.version + 1),
          ),
        );
      // CAS perdido: outro processo já decidiu o destino deste plano.
      if (reopened && reopened.affectedRows === 1) summary.failed += 1;
    }
  }

  return summary;
}

export { EXTERNAL_PROVIDERS };

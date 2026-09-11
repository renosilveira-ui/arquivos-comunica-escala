import { createHash } from "node:crypto";

import {
  ROUTE_ESTIMATE_QUALITY,
  type RouteEstimateQuality,
  type TravelMode,
} from "./integrations/providers/location-provider";
import type { GeoPoint } from "./integrations/providers/types";

/**
 * Núcleo do aviso de "hora de sair".
 *
 * Puro de propósito: converter plantão + origem + trânsito em um instante de
 * saída é aritmética com regras de negócio, e regra de negócio precisa de
 * teste sem banco e sem rede. O worker acima disto só persiste e envia.
 *
 * A pergunta que o motor responde é "que horas sair", e ela tem uma
 * assimetria que manda no desenho: **errar para cedo custa minutos de espera;
 * errar para tarde custa um plantão começando sem anestesista.** Toda escolha
 * duvidosa aqui arredonda para sair antes.
 */

/** Margem de chegada permitida (minutos antes do início do plantão). */
export const MIN_ARRIVAL_MARGIN_MINUTES = 0;
export const MAX_ARRIVAL_MARGIN_MINUTES = 240;
export const DEFAULT_ARRIVAL_MARGIN_MINUTES = 15;

/** Tempo assumido quando a rota não pôde ser calculada. */
export const MIN_FALLBACK_TRAVEL_MINUTES = 5;
export const MAX_FALLBACK_TRAVEL_MINUTES = 480;
export const DEFAULT_FALLBACK_TRAVEL_MINUTES = 40;

/**
 * Validade de uma estimativa de rota.
 *
 * Trânsito de 40 minutos atrás ainda diz algo; de 6 horas atrás, não. Passado
 * o TTL, a estimativa deixa de ser "atual" e vira, no máximo, base para o
 * fallback declarado.
 */
export const ROUTE_ESTIMATE_TTL_MS = 45 * 60 * 1000;

/**
 * Quando recalcular, contado a partir do instante de saída.
 *
 * O trânsito do fim da tarde não se parece com o previsto na véspera. Três
 * recálculos cobrem a curva sem gastar cota: um dia antes fixa a existência
 * do plano, três horas antes pega a tendência, e uma hora antes pega o
 * trânsito real que vai valer.
 */
export const RECOMPUTE_OFFSETS_MS = [
  24 * 60 * 60 * 1000,
  3 * 60 * 60 * 1000,
  60 * 60 * 1000,
] as const;

/** Teto de horizonte: plantão daqui a meses não ocupa fila de cálculo. */
export const PLANNING_HORIZON_MS = 30 * 24 * 60 * 60 * 1000;

export type DeparturePreferences = {
  enabled: boolean;
  travelMode: TravelMode;
  arrivalMarginMinutes: number;
  fallbackTravelMinutes: number;
};

export function normalizePreferences(
  input: Partial<DeparturePreferences> | null | undefined,
): DeparturePreferences {
  const clamp = (
    value: unknown,
    min: number,
    max: number,
    fallback: number,
  ) => {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return fallback;
    return Math.min(max, Math.max(min, Math.round(numeric)));
  };
  return {
    enabled: input?.enabled === true,
    travelMode:
      input?.travelMode === "WALKING" || input?.travelMode === "TRANSIT"
        ? input.travelMode
        : "DRIVING",
    arrivalMarginMinutes: clamp(
      input?.arrivalMarginMinutes,
      MIN_ARRIVAL_MARGIN_MINUTES,
      MAX_ARRIVAL_MARGIN_MINUTES,
      DEFAULT_ARRIVAL_MARGIN_MINUTES,
    ),
    fallbackTravelMinutes: clamp(
      input?.fallbackTravelMinutes,
      MIN_FALLBACK_TRAVEL_MINUTES,
      MAX_FALLBACK_TRAVEL_MINUTES,
      DEFAULT_FALLBACK_TRAVEL_MINUTES,
    ),
  };
}

/** Chegada desejada: início do plantão menos a margem do usuário. */
export function desiredArrival(
  shiftStartsAtUtc: Date,
  marginMinutes: number,
): Date {
  return new Date(shiftStartsAtUtc.getTime() - marginMinutes * 60_000);
}

export type RouteSample = {
  durationSeconds: number;
  distanceMeters: number;
  quality: RouteEstimateQuality;
  computedAtUtc: Date;
};

export type DepartureComputation = {
  departAt: Date;
  durationSeconds: number;
  quality: RouteEstimateQuality;
  /** A estimativa é atual, ou estamos usando o último cálculo ainda válido? */
  stale: boolean;
};

/**
 * Converte chegada desejada + estimativa em instante de saída.
 *
 * A hierarquia é explícita e não pode ser reordenada:
 *
 * 1. estimativa fresca → usa e marca a qualidade que o provedor deu;
 * 2. estimativa vencida mas dentro do TTL → usa, marcada como não-atual;
 * 3. nada utilizável → fallback fixo, marcado como `FALLBACK`.
 *
 * O passo 3 é o ponto do desenho: a ausência do Google não pode virar
 * ausência de aviso. É melhor avisar com um número declaradamente fixo do que
 * deixar o médico sem aviso — desde que a tela diga qual dos três é.
 */
export function computeDeparture(input: {
  desiredArrivalAtUtc: Date;
  fresh: RouteSample | null;
  lastKnown: RouteSample | null;
  fallbackTravelMinutes: number;
  now: Date;
}): DepartureComputation {
  if (input.fresh) {
    return {
      departAt: new Date(
        input.desiredArrivalAtUtc.getTime() -
          input.fresh.durationSeconds * 1000,
      ),
      durationSeconds: input.fresh.durationSeconds,
      quality: input.fresh.quality,
      stale: false,
    };
  }

  if (
    input.lastKnown &&
    input.now.getTime() - input.lastKnown.computedAtUtc.getTime() <
      ROUTE_ESTIMATE_TTL_MS
  ) {
    return {
      departAt: new Date(
        input.desiredArrivalAtUtc.getTime() -
          input.lastKnown.durationSeconds * 1000,
      ),
      durationSeconds: input.lastKnown.durationSeconds,
      quality: input.lastKnown.quality,
      stale: true,
    };
  }

  const fallbackSeconds = input.fallbackTravelMinutes * 60;
  return {
    departAt: new Date(
      input.desiredArrivalAtUtc.getTime() - fallbackSeconds * 1000,
    ),
    durationSeconds: fallbackSeconds,
    // Nunca apresentado como trânsito atual: é estimativa nossa, e a tela
    // precisa dizer isso.
    quality: ROUTE_ESTIMATE_QUALITY.fallback,
    stale: true,
  };
}

/**
 * Próximo instante de recálculo.
 *
 * Devolve o maior offset que ainda está no futuro — ou seja, recalcula cedo
 * enquanto há tempo e vai apertando conforme a saída se aproxima. `null`
 * significa que não há mais recálculo a fazer: é hora de enviar.
 */
export function nextRecomputeAt(departAtUtc: Date, now: Date): Date | null {
  for (const offset of RECOMPUTE_OFFSETS_MS) {
    const candidate = new Date(departAtUtc.getTime() - offset);
    if (candidate.getTime() > now.getTime()) return candidate;
  }
  return null;
}

export function isWithinPlanningHorizon(
  shiftStartsAtUtc: Date,
  now: Date,
): boolean {
  const delta = shiftStartsAtUtc.getTime() - now.getTime();
  return delta > 0 && delta <= PLANNING_HORIZON_MS;
}

/**
 * Assinatura do mundo em que o cálculo foi feito.
 *
 * Se o plantão mudou de horário ou de setor, ou o usuário trocou a origem ou
 * a margem, a assinatura deixa de bater e o plano é recalculado. Sem isto o
 * médico receberia "saia às 18h07" para um plantão que mudou de hora — um
 * aviso pior que nenhum, porque ele confia.
 */
export function shiftSignature(input: {
  shiftInstanceId: number;
  startsAtUtc: Date;
  endsAtUtc: Date;
  sectorId: number;
  hospitalId: number;
}): string {
  return createHash("sha256")
    .update(
      [
        input.shiftInstanceId,
        input.startsAtUtc.toISOString(),
        input.endsAtUtc.toISOString(),
        input.sectorId,
        input.hospitalId,
      ].join("|"),
    )
    .digest("hex");
}

export function originSignature(input: {
  travelOriginId: number | null;
  originFingerprint: string | null;
  destination: GeoPoint | null;
  preferences: DeparturePreferences;
}): string {
  return createHash("sha256")
    .update(
      [
        input.travelOriginId ?? "none",
        input.originFingerprint ?? "none",
        input.destination
          ? `${input.destination.latitude.toFixed(5)},${input.destination.longitude.toFixed(5)}`
          : "none",
        input.preferences.travelMode,
        input.preferences.arrivalMarginMinutes,
        input.preferences.fallbackTravelMinutes,
      ].join("|"),
    )
    .digest("hex");
}

/**
 * Identidade do aviso.
 *
 * Inclui o instante de saída arredondado ao minuto: se o recálculo mudar o
 * horário, é um aviso NOVO e ele pode sair. Se o horário não mudou, duas
 * execuções do worker produzem a mesma chave e só uma envia.
 */
export function departureDedupKey(input: {
  userId: number;
  assignmentId: number;
  departAtUtc: Date;
}): string {
  const minute = Math.floor(input.departAtUtc.getTime() / 60_000);
  return `departure:${input.userId}:${input.assignmentId}:${minute}`;
}

export type DepartureMessage = {
  title: string;
  body: string;
};

function formatClock(instant: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("pt-BR", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(instant);
  } catch {
    return "--:--";
  }
}

export function formatDurationLabel(seconds: number): string {
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

/**
 * A mensagem do push.
 *
 * Precisa dizer, sem o médico abrir o app: que plantão, que horas começa, que
 * horas sair, quanto dura o trajeto e **de onde veio o número**. Um aviso que
 * esconde ser fallback convida a confiar em algo que não é trânsito atual.
 */
export function buildDepartureMessage(input: {
  departAtUtc: Date;
  shiftStartsAtUtc: Date;
  durationSeconds: number;
  quality: RouteEstimateQuality;
  stale: boolean;
  sectorName: string;
  hospitalName: string;
  timeZone: string;
  weatherSummary?: string | null;
}): DepartureMessage {
  const departure = formatClock(input.departAtUtc, input.timeZone);
  const start = formatClock(input.shiftStartsAtUtc, input.timeZone);
  const travel = formatDurationLabel(input.durationSeconds);

  const source =
    input.quality === ROUTE_ESTIMATE_QUALITY.liveTraffic && !input.stale
      ? "com trânsito agora"
      : input.quality === ROUTE_ESTIMATE_QUALITY.fallback
        ? "estimativa fixa — não foi possível consultar o trânsito"
        : input.stale
          ? "última estimativa disponível"
          : "tempo típico para o horário";

  const parts = [
    `${input.sectorName} · ${input.hospitalName}, plantão às ${start}.`,
    `Trajeto ${travel} (${source}).`,
  ];
  if (input.weatherSummary) parts.push(input.weatherSummary);

  return {
    title: `Saia às ${departure}`,
    body: parts.join(" "),
  };
}

/**
 * O aviso ainda vale a pena?
 *
 * Um push de "saia às 18h07" entregue às 18h40 não ajuda — atrapalha, porque
 * o médico confere o relógio e conclui que o app está errado. Passada a
 * tolerância, o plano é encerrado sem envio.
 */
export const LATE_SEND_TOLERANCE_MS = 10 * 60 * 1000;

export function shouldSendDeparture(input: {
  departAtUtc: Date;
  now: Date;
}): boolean {
  const delta = input.now.getTime() - input.departAtUtc.getTime();
  return delta >= 0 && delta <= LATE_SEND_TOLERANCE_MS;
}

export function isDepartureExpired(input: {
  departAtUtc: Date;
  now: Date;
}): boolean {
  return (
    input.now.getTime() - input.departAtUtc.getTime() > LATE_SEND_TOLERANCE_MS
  );
}

import { createHash } from "node:crypto";

import {
  ROUTE_ESTIMATE_QUALITY,
  type RouteEstimateQuality,
  type TravelMode,
} from "./integrations/providers/location-provider";
import type { GeoPoint } from "./integrations/providers/types";

/**
 * Núcleo do aviso de aproximação de plantão.
 *
 * Puro de propósito: o que o médico recebe e quando é regra de negócio, e
 * regra de negócio precisa de teste sem banco e sem rede. O worker acima
 * disto só persiste e envia.
 *
 * ## As três regras que mandam no desenho
 *
 * **1. O horário do aviso é fixo: uma hora antes do plantão.** Não depende do
 * trânsito, não depende de o Google responder, não depende de configuração.
 * Um aviso que só existe quando tudo dá certo é um aviso em que não se pode
 * confiar — e confiança é o que faz o médico deixar a notificação ligada.
 *
 * **2. O sistema não pergunta nada.** Nem folga de chegada, nem tempo de
 * trajeto. O objetivo é sempre estar no hospital quando o plantão começa, e o
 * trajeto é o Google que calcula.
 *
 * **3. Sem trânsito, o sistema NÃO inventa tempo de trajeto.** Uma versão
 * anterior chutava 40 minutos e chamava aquilo de estimativa. No aparelho do
 * médico um número inventado tem a mesma aparência de um calculado: ele não
 * distingue, confia, e sai tarde num dia de chuva. Sem rota, o aviso sai
 * igual — dizendo, com todas as letras, que não sabe o trânsito.
 */

/**
 * Antecedência do aviso. Fixa.
 *
 * Uma hora dá para reagir sem ser cedo a ponto de o médico esquecer. É também
 * a janela em que uma estimativa de trânsito ainda descreve o trânsito que
 * ele vai pegar.
 */
export const NOTICE_LEAD_MS = 60 * 60 * 1000;

/**
 * Quanto antes do aviso calcular a rota.
 *
 * Perto o bastante para a estimativa valer para o horário do aviso, com folga
 * para o worker rodar e o push sair. Uma consulta por plantão — não seis: a
 * pergunta é "quanto leva agora", e ela só tem resposta útil agora.
 */
export const ROUTE_LOOKAHEAD_MS = 10 * 60 * 1000;

/** Teto de horizonte: plantão daqui a meses não ocupa fila de cálculo. */
export const PLANNING_HORIZON_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Validade de uma estimativa já calculada.
 *
 * Trânsito de 40 minutos atrás ainda diz algo; de 6 horas atrás, não. Passado
 * o TTL, a estimativa é descartada e o aviso sai sem ela.
 */
export const ROUTE_ESTIMATE_TTL_MS = 45 * 60 * 1000;

export type DeparturePreferences = {
  enabled: boolean;
  travelMode: TravelMode;
};

/**
 * O único modo de deslocamento que o produto usa.
 *
 * Médico de plantão vai de carro. A coluna no banco aceita outros valores
 * porque o provedor de rotas aceita, mas **nada no sistema escreve outro** —
 * nem a tela, nem a API. Um valor diferente só poderia chegar por escrita
 * manual no banco, e mesmo essa é normalizada na leitura.
 */
export const DEFAULT_TRAVEL_MODE: TravelMode = "DRIVING";

/**
 * Preferências: uma só — ligado ou desligado.
 *
 * O modo de transporte não é perguntado nem aceito do cliente. Se um dia
 * virar pergunta, que seja por evidência de que médico de plantão noturno vai
 * de metrô, não por completude de formulário.
 */
export function normalizePreferences(
  input: Partial<DeparturePreferences> | null | undefined,
): DeparturePreferences {
  return {
    enabled: input?.enabled === true,
    // Ignora o que estiver gravado: carro é a regra, não um padrão que outra
    // escrita possa ter sobrescrito.
    travelMode: DEFAULT_TRAVEL_MODE,
  };
}

/** Quando o aviso sai: uma hora antes do plantão, sempre. */
export function noticeAt(shiftStartsAtUtc: Date): Date {
  return new Date(shiftStartsAtUtc.getTime() - NOTICE_LEAD_MS);
}

/** Quando calcular a rota para esse aviso. */
export function routeComputeAt(shiftStartsAtUtc: Date): Date {
  return new Date(noticeAt(shiftStartsAtUtc).getTime() - ROUTE_LOOKAHEAD_MS);
}

export type RouteSample = {
  durationSeconds: number;
  distanceMeters: number;
  quality: RouteEstimateQuality;
  computedAtUtc: Date;
};

/** A estimativa ainda descreve o trânsito que o médico vai pegar? */
export function isEstimateUsable(
  sample: RouteSample | null,
  now: Date,
): sample is RouteSample {
  if (!sample) return false;
  return now.getTime() - sample.computedAtUtc.getTime() < ROUTE_ESTIMATE_TTL_MS;
}

export function isWithinPlanningHorizon(
  shiftStartsAtUtc: Date,
  now: Date,
): boolean {
  const delta = shiftStartsAtUtc.getTime() - now.getTime();
  return delta > 0 && delta <= PLANNING_HORIZON_MS;
}

/**
 * Instante em que o médico precisa sair, dado o trajeto.
 *
 * Derivado, não configurado: é a chegada desejada — o início do plantão —
 * menos a duração do trajeto.
 */
export function departureFor(
  shiftStartsAtUtc: Date,
  durationSeconds: number,
): Date {
  return new Date(shiftStartsAtUtc.getTime() - durationSeconds * 1000);
}

/**
 * Assinatura do mundo em que o cálculo foi feito.
 *
 * Se o plantão mudou de horário ou de setor, ou o usuário trocou a origem, a
 * assinatura deixa de bater e o plano é recalculado. Sem isto o médico
 * receberia um aviso descrevendo um plantão que mudou de hora — pior que
 * nenhum, porque ele confia.
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
      ].join("|"),
    )
    .digest("hex");
}

/**
 * Identidade do aviso.
 *
 * Um aviso por plantão, e o horário é fixo — então a chave é estável. Duas
 * execuções do worker produzem a mesma e só uma envia.
 */
export function departureDedupKey(input: {
  userId: number;
  assignmentId: number;
  noticeAtUtc: Date;
}): string {
  const minute = Math.floor(input.noticeAtUtc.getTime() / 60_000);
  return `shift-notice:${input.userId}:${input.assignmentId}:${minute}`;
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
 * A mensagem do aviso.
 *
 * Uma só, montada com o que há. A primeira frase nunca muda — é a informação
 * que sempre existe, e é por ela que o médico reconhece a notificação sem
 * ler o resto. Clima e trânsito entram quando disponíveis.
 *
 * O trecho do trânsito traz a duração **e** o horário derivado de saída.
 * A duração é o dado; o horário é a decisão. Dar só a duração obrigaria o
 * médico a fazer a subtração de cabeça, às 18h, com o celular na mão.
 *
 * Trajeto longo demais para a antecedência de uma hora — ou aviso entregue
 * atrasado — não pode virar um horário de saída que já passou. "Saia às
 * 17:30" lido às 18h parece defeito do app; a mensagem diz **saia agora**,
 * que é a informação verdadeira e acionável.
 */
export function buildShiftNoticeMessage(input: {
  shiftStartsAtUtc: Date;
  sectorName: string;
  hospitalName: string;
  timeZone: string;
  durationSeconds?: number | null;
  weatherSummary?: string | null;
  /** Instante do envio. Padrão: o horário nominal do aviso. */
  now?: Date;
}): DepartureMessage {
  const start = formatClock(input.shiftStartsAtUtc, input.timeZone);
  const parts = [`${input.sectorName} · ${input.hospitalName}, às ${start}.`];

  if (input.weatherSummary) parts.push(input.weatherSummary);

  if (input.durationSeconds && input.durationSeconds > 0) {
    const travel = formatDurationLabel(input.durationSeconds);
    const leave = departureFor(input.shiftStartsAtUtc, input.durationSeconds);
    const reference = input.now ?? noticeAt(input.shiftStartsAtUtc);
    parts.push(
      leave.getTime() <= reference.getTime()
        ? `Trânsito com tempo estimado de ${travel} — saia agora.`
        : `Trânsito com tempo estimado de ${travel} — saia até ${formatClock(leave, input.timeZone)}.`,
    );
  } else {
    parts.push("Estimativas de trânsito não disponíveis.");
  }

  return {
    title: "Horário do plantão se aproxima",
    body: parts.join(" "),
  };
}

/**
 * O aviso ainda vale a pena?
 *
 * Entregue muito depois, ele atrapalha: o médico confere o relógio e conclui
 * que o app está errado. A tolerância é generosa porque o aviso sai uma hora
 * antes — trinta minutos de atraso ainda deixam meia hora útil.
 */
export const LATE_SEND_TOLERANCE_MS = 30 * 60 * 1000;

export function shouldSendNotice(input: {
  noticeAtUtc: Date;
  now: Date;
}): boolean {
  const delta = input.now.getTime() - input.noticeAtUtc.getTime();
  return delta >= 0 && delta <= LATE_SEND_TOLERANCE_MS;
}

export function isNoticeExpired(input: {
  noticeAtUtc: Date;
  now: Date;
}): boolean {
  return (
    input.now.getTime() - input.noticeAtUtc.getTime() > LATE_SEND_TOLERANCE_MS
  );
}

export { ROUTE_ESTIMATE_QUALITY };

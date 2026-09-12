import {
  MAX_ACCEPTED_ACCURACY_METERS,
  MIN_MOVEMENT_METERS,
} from "./integration-providers";

/**
 * Localização automática: o que a tela diz e quando vale reportar.
 *
 * Puro de propósito — o texto que o médico lê antes de decidir sobre a
 * própria localização é regra de produto, e regra de produto precisa de teste
 * sem aparelho, sem permissão e sem rede.
 *
 * ## A regra de escrita que manda aqui
 *
 * Nenhuma frase desta tela menciona coordenada, GPS em segundo plano, selo,
 * chave ou API. Quem lê é um médico decidindo se deixa o app saber de onde
 * ele sai para o plantão. Ele precisa de três coisas: o que ganha, o que o
 * sistema guarda, e o que perde se disser não. Nada além disso.
 */

export const LOCATION_ACCESS = {
  /** Nunca perguntamos ainda. */
  unknown: "UNKNOWN",
  /** O médico recusou. */
  denied: "DENIED",
  /** Vale só com o app aberto. */
  foreground: "FOREGROUND",
  /** Vale também com o app fechado — é o que o aviso precisa. */
  always: "ALWAYS",
} as const;

export type LocationAccess =
  (typeof LOCATION_ACCESS)[keyof typeof LOCATION_ACCESS];

export type LocationGuidance = {
  title: string;
  body: string;
  /** Rótulo do botão. Null quando não há ação a oferecer. */
  action: string | null;
  /** A estimativa de trânsito vai existir neste estado? */
  trafficWorks: boolean;
};

/**
 * Opções que mudam o CAMINHO oferecido, não o estado.
 *
 * `canAskInApp` distingue as duas situações que o estado `FOREGROUND` junta:
 * o sistema ainda aceita mostrar o pedido de "sempre" dentro do app (iPhone,
 * logo após liberar "durante o uso"), ou já não aceita e o único caminho são
 * os ajustes do aparelho. Mandar alguém aos ajustes quando bastava um toque
 * é perder a pessoa no meio do caminho.
 */
export type LocationGuidanceOptions = {
  canAskInApp?: boolean;
};

/**
 * O que dizer ao médico em cada estado da permissão.
 *
 * `FOREGROUND` é o estado traiçoeiro: parece que está tudo certo, e o aviso
 * sairia sem trânsito porque, uma hora antes do plantão, o app está fechado.
 * A tela precisa dizer isso com todas as letras em vez de mostrar um "ok".
 */
export function locationGuidance(
  access: LocationAccess,
  options: LocationGuidanceOptions = {},
): LocationGuidance {
  switch (access) {
    case LOCATION_ACCESS.always:
      return {
        title: "Localização ligada",
        body: "O Escala+ calcula sozinho quanto tempo você leva até o hospital e avisa a hora de sair. Guardamos apenas o seu ponto de partida mais recente, protegido — nunca por onde você andou.",
        action: null,
        trafficWorks: true,
      };
    case LOCATION_ACCESS.foreground:
      return options.canAskInApp
        ? {
            title: "Falta liberar com o app fechado",
            body: "Hoje o Escala+ só enxerga sua localização enquanto o app está aberto. Mas o aviso sai uma hora antes do plantão, quando o app está fechado — e aí ele chega sem o tempo de trânsito. Toque abaixo e escolha “Sempre” quando o aparelho perguntar.",
            action: "Liberar com o app fechado",
            trafficWorks: false,
          }
        : {
            title: "Falta liberar com o app fechado",
            body: "Hoje o Escala+ só enxerga sua localização enquanto o app está aberto. Mas o aviso sai uma hora antes do plantão, quando o app está fechado — e aí ele chega sem o tempo de trânsito. Para resolver, mude a permissão de localização do Escala+ para “Sempre” nos ajustes do aparelho.",
            action: "Abrir ajustes do aparelho",
            trafficWorks: false,
          };
    case LOCATION_ACCESS.denied:
      return {
        title: "Localização desligada",
        body: "O aviso do plantão continua chegando no horário, com a previsão do tempo — mas sem o tempo de trânsito e sem a hora de sair de casa. Você pode liberar a localização nos ajustes do aparelho, ou informar um endereço de partida.",
        action: "Abrir ajustes do aparelho",
        trafficWorks: false,
      };
    default:
      return {
        title: "Deixe o Escala+ calcular sua saída",
        body: "Para avisar a hora certa de sair, o app precisa saber de onde você vai. Ele pergunta uma vez e guarda apenas o seu ponto de partida mais recente, protegido — nunca por onde você andou.",
        action: "Usar minha localização",
        trafficWorks: false,
      };
  }
}

export type ReportedPoint = {
  latitude: number;
  longitude: number;
  accuracyMeters: number | null;
};

export const REPORT_SKIP_REASONS = {
  invalid: "INVALID",
  imprecise: "IMPRECISE",
  unchanged: "UNCHANGED",
} as const;

export type ReportSkipReason =
  (typeof REPORT_SKIP_REASONS)[keyof typeof REPORT_SKIP_REASONS];

export type ReportDecision =
  | { send: true }
  | { send: false; reason: ReportSkipReason };

function metersBetween(a: ReportedPoint, b: ReportedPoint): number {
  const METERS_PER_DEGREE = 111_320;
  const meanLatitude = ((a.latitude + b.latitude) / 2) * (Math.PI / 180);
  const dLat = (b.latitude - a.latitude) * METERS_PER_DEGREE;
  const dLon =
    (b.longitude - a.longitude) * METERS_PER_DEGREE * Math.cos(meanLatitude);
  return Math.hypot(dLat, dLon);
}

/**
 * Vale a pena mandar este ponto para o servidor?
 *
 * A decisão é tomada no aparelho para não gastar rede: o sistema operacional
 * acorda o app a cada poucas centenas de metros, e a maioria desses avisos
 * não muda nada. O servidor repete a checagem — esta é conveniência, aquela é
 * garantia.
 */
export function shouldReport(input: {
  previous: ReportedPoint | null;
  next: ReportedPoint;
}): ReportDecision {
  const { next } = input;
  if (
    !Number.isFinite(next.latitude) ||
    !Number.isFinite(next.longitude) ||
    Math.abs(next.latitude) > 90 ||
    Math.abs(next.longitude) > 180 ||
    (next.latitude === 0 && next.longitude === 0)
  ) {
    return { send: false, reason: REPORT_SKIP_REASONS.invalid };
  }
  if (
    next.accuracyMeters !== null &&
    next.accuracyMeters > MAX_ACCEPTED_ACCURACY_METERS
  ) {
    return { send: false, reason: REPORT_SKIP_REASONS.imprecise };
  }
  if (
    input.previous &&
    metersBetween(input.previous, next) < MIN_MOVEMENT_METERS
  ) {
    return { send: false, reason: REPORT_SKIP_REASONS.unchanged };
  }
  return { send: true };
}

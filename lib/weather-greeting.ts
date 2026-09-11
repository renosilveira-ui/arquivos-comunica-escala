import {
  WEATHER_CONDITIONS,
  type WeatherCondition,
} from "./integration-providers";

/**
 * Saudação com o clima de onde o médico está.
 *
 * Puro de propósito: o texto que aparece no topo do app é regra de produto, e
 * regra de produto precisa de teste sem rede, sem banco e sem relógio real.
 *
 * ## Duas regras que mandam no desenho
 *
 * **1. A saudação nunca depende do clima.** Sem WeatherKit, sem endereço, sem
 * internet — o médico ainda é cumprimentado pelo nome. Um cabeçalho que
 * some quando um provedor externo cai vira um buraco na tela, e buraco na
 * tela parece defeito do app.
 *
 * **2. O clima é ornamento, nunca autoridade.** Ele não muda plantão, não
 * atrasa push e não vira decisão. Se não houver número, não se inventa.
 */

export const GREETINGS = {
  morning: "Bom dia",
  afternoon: "Boa tarde",
  night: "Boa noite",
} as const;

export type Greeting = (typeof GREETINGS)[keyof typeof GREETINGS];

/**
 * Faixas do dia, na convenção brasileira: madrugada é "boa noite", não "bom
 * dia". Quem entra às 3h da manhã para um plantão não está começando o dia.
 */
export function greetingForHour(hour: number): Greeting {
  if (!Number.isFinite(hour)) return GREETINGS.morning;
  const normalized = ((Math.floor(hour) % 24) + 24) % 24;
  if (normalized >= 5 && normalized < 12) return GREETINGS.morning;
  if (normalized >= 12 && normalized < 18) return GREETINGS.afternoon;
  return GREETINGS.night;
}

/**
 * Primeiro nome, para a saudação soar como pessoa falando com pessoa.
 *
 * Nome vazio não vira "Bom dia, " com vírgula solta: a saudação fica sozinha,
 * que é melhor do que um cumprimento pela metade.
 */
export function firstName(fullName: string | null | undefined): string | null {
  const trimmed = (fullName ?? "").trim();
  if (!trimmed) return null;
  const first = trimmed.split(/\s+/)[0];
  if (!first) return null;
  // Nome que é só pontuação ou dígito não é nome.
  if (!/\p{L}/u.test(first)) return null;
  return first;
}

export function greetingLine(input: {
  hour: number;
  name: string | null | undefined;
}): string {
  const greeting = greetingForHour(input.hour);
  const name = firstName(input.name);
  return name ? `${greeting}, ${name}` : greeting;
}

const CONDITION_LABEL: Record<WeatherCondition, string> = {
  [WEATHER_CONDITIONS.clear]: "céu limpo",
  [WEATHER_CONDITIONS.cloudy]: "nublado",
  [WEATHER_CONDITIONS.rain]: "chuva",
  [WEATHER_CONDITIONS.heavyRain]: "chuva forte",
  [WEATHER_CONDITIONS.storm]: "tempestade",
  [WEATHER_CONDITIONS.snow]: "neve",
  [WEATHER_CONDITIONS.fog]: "neblina",
  [WEATHER_CONDITIONS.unknown]: "tempo indefinido",
};

export function conditionLabel(condition: WeatherCondition): string {
  return CONDITION_LABEL[condition] ?? CONDITION_LABEL.UNKNOWN;
}

export function temperatureLabel(celsius: number): string | null {
  if (!Number.isFinite(celsius)) return null;
  // Temperaturas fora do plausível para a superfície terrestre denunciam
  // unidade errada ou payload corrompido. Melhor não mostrar do que mostrar
  // "148°C" e destruir a confiança no resto da tela.
  if (celsius < -60 || celsius > 60) return null;
  return `${Math.round(celsius)}°C`;
}

export type WeatherGreetingView = {
  greeting: string;
  /** Linha do clima. Null quando não há dado — e aí a saudação vai sozinha. */
  weather: string | null;
};

/**
 * Monta o que a tela mostra.
 *
 * `UNKNOWN` com temperatura válida ainda vale a pena: o grau é a informação
 * que o médico usa para decidir se leva casaco. Sem temperatura e sem
 * condição reconhecida, não há linha de clima.
 */
export function buildWeatherGreeting(input: {
  hour: number;
  name: string | null | undefined;
  condition?: WeatherCondition | null;
  temperatureCelsius?: number | null;
}): WeatherGreetingView {
  const greeting = greetingLine({ hour: input.hour, name: input.name });
  const temperature =
    typeof input.temperatureCelsius === "number"
      ? temperatureLabel(input.temperatureCelsius)
      : null;
  const hasCondition =
    !!input.condition && input.condition !== WEATHER_CONDITIONS.unknown;

  if (!temperature && !hasCondition) return { greeting, weather: null };
  if (temperature && hasCondition) {
    return {
      greeting,
      weather: `${temperature}, ${conditionLabel(input.condition!)}`,
    };
  }
  return {
    greeting,
    weather: temperature ?? conditionLabel(input.condition!),
  };
}

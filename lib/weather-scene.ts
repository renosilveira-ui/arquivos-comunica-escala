import {
  WEATHER_CONDITIONS,
  type WeatherCondition,
} from "./integration-providers";

/**
 * Escolhe a cena de clima que ilustra a saudação.
 *
 * Puro de propósito, pelo mesmo motivo de `weather-greeting.ts`: o que aparece
 * no topo do app é regra de produto, e regra de produto precisa de teste sem
 * rede e sem relógio real.
 *
 * ## As regras que mandam no desenho
 *
 * **1. Sem dado, sem cena.** `UNKNOWN` e ausência de condição devolvem `null`.
 * O clima é ornamento, nunca autoridade — desenhar um céu limpo porque o
 * provedor caiu seria inventar informação sobre o mundo lá fora.
 *
 * **2. A cena nunca contradiz a saudação.** Se o texto diz "Boa noite", o céu
 * é noturno. A fronteira de noite aqui é a MESMA de `greetingForHour`, e um
 * teste percorre as 24 horas para garantir que as duas não se soltem.
 *
 * **3. A hora é a do aparelho, e está certo.** Diferente de plantão — que é
 * sempre relógio do hospital — o clima é o de onde a PESSOA está. Quem abre o
 * app em Manaus quer o céu de Manaus.
 */

export const WEATHER_SCENES = [
  "limpo",
  "amanhecer",
  "entardecer",
  "nublado",
  "chuva",
  "tempestade",
  "neblina",
  "frio",
  "n-limpo",
  "n-nublado",
  "n-chuva",
  "n-tempestade",
  "n-neblina",
  "n-frio",
] as const;

export type WeatherScene = (typeof WEATHER_SCENES)[number];

/**
 * Noite é `>= 18` ou `< 5`, igual a `greetingForHour`. Madrugada é noite: quem
 * entra às 3h para um plantão não está começando o dia.
 */
export function isNightHour(hour: number): boolean {
  if (!Number.isFinite(hour)) return false;
  const h = ((Math.floor(hour) % 24) + 24) % 24;
  return h >= 18 || h < 5;
}

/** Céu limpo nas horas douradas ganha cena própria — é quando ele é bonito. */
function clearScene(hour: number): WeatherScene {
  if (isNightHour(hour)) return "n-limpo";
  const h = ((Math.floor(hour) % 24) + 24) % 24;
  if (h >= 5 && h <= 6) return "amanhecer";
  if (h >= 16 && h <= 17) return "entardecer";
  return "limpo";
}

/**
 * `HEAVY_RAIN` cai na mesma cena de `RAIN` de propósito: a diferença já está
 * no texto ao lado ("chuva forte"), e uma segunda arte de chuva mudaria pouco
 * num disco de 44 px. Se virar necessário, a cena entra aqui e em SHIPPED.
 */
const DAY: Record<Exclude<WeatherCondition, "CLEAR" | "UNKNOWN">, WeatherScene> = {
  [WEATHER_CONDITIONS.cloudy]: "nublado",
  [WEATHER_CONDITIONS.rain]: "chuva",
  [WEATHER_CONDITIONS.heavyRain]: "chuva",
  [WEATHER_CONDITIONS.storm]: "tempestade",
  [WEATHER_CONDITIONS.snow]: "frio",
  [WEATHER_CONDITIONS.fog]: "neblina",
};

const NIGHT: Record<Exclude<WeatherCondition, "CLEAR" | "UNKNOWN">, WeatherScene> = {
  [WEATHER_CONDITIONS.cloudy]: "n-nublado",
  [WEATHER_CONDITIONS.rain]: "n-chuva",
  [WEATHER_CONDITIONS.heavyRain]: "n-chuva",
  [WEATHER_CONDITIONS.storm]: "n-tempestade",
  [WEATHER_CONDITIONS.snow]: "n-frio",
  [WEATHER_CONDITIONS.fog]: "n-neblina",
};

export function weatherSceneFor(input: {
  condition?: WeatherCondition | null;
  hour: number;
}): WeatherScene | null {
  const { condition, hour } = input;
  if (!condition || condition === WEATHER_CONDITIONS.unknown) return null;
  if (condition === WEATHER_CONDITIONS.clear) return clearScene(hour);
  const table = isNightHour(hour) ? NIGHT : DAY;
  return table[condition] ?? null;
}

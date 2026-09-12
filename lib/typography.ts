/**
 * A fonte do produto, e como o peso vira uma família.
 *
 * ## Por que existe um mapa, e não um nome só
 *
 * No React Native, `fontFamily` é o nome de UMA fonte instalada. Diferente
 * da web, o aparelho não deriva o negrito a partir da regular: pedir
 * `fontWeight: "700"` sobre uma família que só tem o peso 400 devolve, no
 * Android, a mesma regular — e o título fica visualmente igual ao corpo,
 * sem erro nenhum. Por isso cada peso é uma família própria, e este mapa é
 * quem traduz.
 *
 * O `<Text>` do projeto (components/ui/Text.tsx) chama `interFamilyFor` com
 * o peso que a folha de estilo pediu. Nenhuma tela precisa saber destes
 * nomes.
 *
 * ## Por que Inter
 *
 * É desenhada para interface, em tamanho pequeno: altura de x grande, letras
 * abertas e — o que mais importa aqui — numerais inequívocos. Numa lista de
 * plantões, confundir 19:00 com 10:00 não é um detalhe estético. Licença
 * aberta (SIL OFL), e os pesos vêm prontos do pacote mantido pelo Expo, o
 * que evita a fonte variável, cujo suporte a peso no Android é irregular.
 */

export const FONT_FAMILY_BASE = "Inter";

/** Os pesos que o app realmente usa. Acrescentar aqui exige carregar o arquivo. */
export const INTER_FAMILIES = {
  400: "Inter_400Regular",
  500: "Inter_500Medium",
  600: "Inter_600SemiBold",
  700: "Inter_700Bold",
  800: "Inter_800ExtraBold",
} as const;

export type InterWeight = keyof typeof INTER_FAMILIES;
export type InterFamily = (typeof INTER_FAMILIES)[InterWeight];

const WEIGHTS: InterWeight[] = [400, 500, 600, 700, 800];

/**
 * Peso declarado → família carregada, com o vizinho mais próximo.
 *
 * `"bold"` vale 700 e `"normal"` vale 400, como na web. Peso que não existe
 * (300, 900) cai no mais próximo que existe, em vez de sumir para a fonte do
 * sistema: um texto levemente mais leve é melhor do que uma tela com duas
 * tipografias diferentes.
 */
export function interFamilyFor(
  weight: string | number | null | undefined,
): InterFamily {
  if (weight === undefined || weight === null) return INTER_FAMILIES[400];
  if (weight === "bold") return INTER_FAMILIES[700];
  if (weight === "normal") return INTER_FAMILIES[400];

  const numeric =
    typeof weight === "number" ? weight : Number.parseInt(weight, 10);
  if (!Number.isFinite(numeric)) return INTER_FAMILIES[400];

  let closest: InterWeight = WEIGHTS[0];
  for (const candidate of WEIGHTS) {
    if (
      Math.abs(candidate - numeric) < Math.abs(closest - numeric) ||
      // Empate (ex.: 450) resolve para cima: o desenho pediu ênfase.
      (Math.abs(candidate - numeric) === Math.abs(closest - numeric) &&
        candidate > closest)
    ) {
      closest = candidate;
    }
  }
  return INTER_FAMILIES[closest];
}

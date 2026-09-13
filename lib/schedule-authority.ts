/**
 * Até onde cada papel alcança na escala.
 *
 * Mora em `lib/` porque a regra vale dos dois lados: o servidor a impõe
 * (`server/_core/policy.ts`) e a tela precisa dela para não oferecer ao
 * gestor um horizonte que a escrita vai recusar. Um número só, para que
 * oferta e recusa não possam discordar.
 */

/**
 * Meses de calendário que o gestor de hospital alcança, contando o
 * corrente. 5 = mês corrente e os quatro seguintes.
 *
 * O número vem do horizonte da repetição, que conta a partir da data de
 * origem: repetir por 4 meses cai no mês+4, então a janela precisa
 * alcançar o quarto mês seguinte para que a opção "4 meses" sirva ao
 * gestor. GESTOR_PLUS e admin global não têm janela.
 */
export const GESTOR_MEDICO_MONTH_WINDOW = 5;

export type ScheduleAuthorityRole = "USER" | "GESTOR_MEDICO" | "GESTOR_PLUS";

/**
 * Horizonte de repetição que o papel consegue usar, em meses.
 *
 * Um horizonte de N meses a partir da data de origem cai no mês+N, então o
 * gestor de hospital alcança `janela - 1`. Papel desconhecido (tela ainda
 * carregando) recebe o teto: quem decide de verdade é o servidor, e um
 * seletor encolhido por engano esconde opção legítima.
 */
export function maxRepeatMonthsForRole(
  role: ScheduleAuthorityRole | null | undefined,
  absoluteMax: number,
): number {
  if (role !== "GESTOR_MEDICO") return absoluteMax;
  return Math.min(absoluteMax, GESTOR_MEDICO_MONTH_WINDOW - 1);
}

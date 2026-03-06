/**
 * Converte uma data para o formato yearMonth "YYYY-MM"
 * @param d Data a ser convertida
 * @returns String no formato "YYYY-MM" (ex: "2026-03")
 */
export function yearMonthFromDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

/**
 * Converte string yearMonth "YYYY-MM" para primeiro dia do mês
 * @param yearMonth String no formato "YYYY-MM"
 * @returns Date representando o primeiro dia do mês às 00:00:00
 */
export function yearMonthToDate(yearMonth: string): Date {
  const [year, month] = yearMonth.split("-").map(Number);
  return new Date(year, month - 1, 1, 0, 0, 0, 0);
}

/**
 * Retorna o yearMonth atual
 * @returns String no formato "YYYY-MM" representando o mês atual
 */
export function getCurrentYearMonth(): string {
  return yearMonthFromDate(new Date());
}

/**
 * Adiciona N meses a um yearMonth
 * @param yearMonth String no formato "YYYY-MM"
 * @param months Número de meses a adicionar (pode ser negativo)
 * @returns String no formato "YYYY-MM"
 */
export function addMonths(yearMonth: string, months: number): string {
  const date = yearMonthToDate(yearMonth);
  date.setMonth(date.getMonth() + months);
  return yearMonthFromDate(date);
}

// server/local-time.ts — "dia" e "mês" do hospital (America/Sao_Paulo,
// offset fixo -03:00, sem horário de verão desde 2019).
//
// Instantes vão ao banco em UTC; janelas de dia/mês e chaves "YYYY-MM-DD" /
// "YYYY-MM" são SEMPRE do relógio de parede do hospital. O servidor roda em
// UTC no Render: `new Date("YYYY-MM-DDT00:00:00")` ou `d.getMonth()` ali
// dão o dia/mês errados entre 21h e meia-noite no Brasil (auditoria
// 22/08, achados M2, M6 e M10). Todo cálculo de dia/mês no servidor passa
// por aqui.

export const SCHEDULE_TIME_ZONE_OFFSET = "-03:00";
const OFFSET_MS = 3 * 60 * 60 * 1000;

/** Mesmo instante, deslocado para que os getters UTC leiam o relógio de parede. */
function asWallClock(date: Date): Date {
  return new Date(date.getTime() - OFFSET_MS);
}

/** "YYYY-MM-DD" do instante no relógio do hospital. */
export function dayKeyBrt(date: Date): string {
  const w = asWallClock(date);
  return `${w.getUTCFullYear()}-${String(w.getUTCMonth() + 1).padStart(2, "0")}-${String(w.getUTCDate()).padStart(2, "0")}`;
}

/** "YYYY-MM" do instante no relógio do hospital. */
export function yearMonthBrt(date: Date): string {
  return dayKeyBrt(date).slice(0, 7);
}

/** Janela [início, fim) de um dia "YYYY-MM-DD" no relógio do hospital. */
export function dayWindowBrt(dayKey: string): { start: Date; end: Date } {
  const start = new Date(`${dayKey}T00:00:00${SCHEDULE_TIME_ZONE_OFFSET}`);
  return { start, end: new Date(start.getTime() + 24 * 60 * 60 * 1000) };
}

/** Janela [início, fim) de um mês "YYYY-MM" no relógio do hospital. */
export function monthWindowBrt(yearMonth: string): { start: Date; end: Date } {
  const [y, m] = yearMonth.split("-").map(Number);
  const start = new Date(`${yearMonth}-01T00:00:00${SCHEDULE_TIME_ZONE_OFFSET}`);
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
  return { start, end: new Date(`${next}-01T00:00:00${SCHEDULE_TIME_ZONE_OFFSET}`) };
}

/** Chave "YYYY-MM-DD" deslocada n dias (aritmética pura, sem fuso). */
export function addDaysToKey(dayKey: string, days: number): string {
  const [y, m, d] = dayKey.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}-${String(t.getUTCDate()).padStart(2, "0")}`;
}

/** Dia da semana da chave (0 = domingo … 6 = sábado). */
export function weekdayOfKey(dayKey: string): number {
  const [y, m, d] = dayKey.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** Segunda-feira da semana da chave. */
export function mondayOfKey(dayKey: string): string {
  const dow = weekdayOfKey(dayKey);
  return addDaysToKey(dayKey, dow === 0 ? -6 : 1 - dow);
}

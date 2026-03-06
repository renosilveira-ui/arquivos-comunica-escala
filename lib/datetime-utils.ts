/**
 * Utilitários adicionais para manipulação de datas
 * Complementa lib/datetime.ts com funções específicas para normalização
 */

/**
 * Normaliza uma data para 12:00 local (meio-dia)
 * Evita problemas de timezone ao armazenar apenas a data (sem hora)
 * 
 * Problema: new Date("2026-02-13") é interpretado como UTC 00:00,
 * que em GMT-3 vira 2026-02-12 21:00 (dia -1)
 * 
 * Solução: Sempre setar hora para 12:00 local antes de converter para string
 * 
 * @param date Data a ser normalizada
 * @returns Nova instância de Date com hora 12:00:00.000
 */
export function normalizeToNoon(date: Date): Date {
  const normalized = new Date(date);
  normalized.setHours(12, 0, 0, 0);
  return normalized;
}

/**
 * Converte Date para string YYYY-MM-DD considerando timezone local
 * Usa normalizeToNoon internamente para evitar off-by-one
 * 
 * @param date Data a ser convertida
 * @returns String no formato YYYY-MM-DD
 */
export function toLocalISODateString(date: Date): string {
  const normalized = normalizeToNoon(date);
  const year = normalized.getFullYear();
  const month = String(normalized.getMonth() + 1).padStart(2, "0");
  const day = String(normalized.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Cria Date a partir de string YYYY-MM-DD com hora 12:00 local
 * Evita interpretação como UTC 00:00
 * 
 * @param dateString String no formato YYYY-MM-DD
 * @returns Date com hora 12:00:00.000 local
 */
export function fromLocalISODateString(dateString: string): Date {
  const [year, month, day] = dateString.split("-").map(Number);
  return new Date(year, month - 1, day, 12, 0, 0, 0);
}

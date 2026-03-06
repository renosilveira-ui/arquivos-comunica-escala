/**
 * Utilitário centralizado para formatação de datas em PT-BR
 * Usa date-fns com locale ptBR para formatação consistente
 */

import { format, parse } from "date-fns";
import { ptBR } from "date-fns/locale";

/**
 * Formata data para exibição em formato brasileiro DD/MM/AAAA
 * @param date - Date object, string ISO, ou timestamp
 * @returns String formatada DD/MM/AAAA
 */
export function formatDateBR(date: Date | string | number): string {
  if (!date) return "";
  
  try {
    const dateObj = typeof date === "string" || typeof date === "number" 
      ? new Date(date) 
      : date;
    
    if (isNaN(dateObj.getTime())) return "";
    
    return format(dateObj, "dd/MM/yyyy", { locale: ptBR });
  } catch (error) {
    console.error("[datetime] Erro ao formatar data:", error);
    return "";
  }
}

/**
 * Formata data e hora para exibição em formato brasileiro DD/MM/AAAA HH:mm
 * @param date - Date object, string ISO, ou timestamp
 * @returns String formatada DD/MM/AAAA HH:mm
 */
export function formatDateTimeBR(date: Date | string | number): string {
  if (!date) return "";
  
  try {
    const dateObj = typeof date === "string" || typeof date === "number" 
      ? new Date(date) 
      : date;
    
    if (isNaN(dateObj.getTime())) return "";
    
    return format(dateObj, "dd/MM/yyyy HH:mm", { locale: ptBR });
  } catch (error) {
    console.error("[datetime] Erro ao formatar data/hora:", error);
    return "";
  }
}

/**
 * Formata apenas hora para exibição HH:mm
 * @param date - Date object, string ISO, ou timestamp
 * @returns String formatada HH:mm
 */
export function formatTimeBR(date: Date | string | number): string {
  if (!date) return "";
  
  try {
    const dateObj = typeof date === "string" || typeof date === "number" 
      ? new Date(date) 
      : date;
    
    if (isNaN(dateObj.getTime())) return "";
    
    return format(dateObj, "HH:mm", { locale: ptBR });
  } catch (error) {
    console.error("[datetime] Erro ao formatar hora:", error);
    return "";
  }
}

/**
 * Converte string DD/MM/AAAA para Date object
 * @param dateStr - String no formato DD/MM/AAAA
 * @returns Date object ou null se inválido
 */
export function parseDateBR(dateStr: string): Date | null {
  if (!dateStr) return null;
  
  try {
    const parsed = parse(dateStr, "dd/MM/yyyy", new Date(), { locale: ptBR });
    return isNaN(parsed.getTime()) ? null : parsed;
  } catch (error) {
    console.error("[datetime] Erro ao parsear data:", error);
    return null;
  }
}

/**
 * Converte string DD/MM/AAAA HH:mm para Date object
 * @param dateTimeStr - String no formato DD/MM/AAAA HH:mm
 * @returns Date object ou null se inválido
 */
export function parseDateTimeBR(dateTimeStr: string): Date | null {
  if (!dateTimeStr) return null;
  
  try {
    const parsed = parse(dateTimeStr, "dd/MM/yyyy HH:mm", new Date(), { locale: ptBR });
    return isNaN(parsed.getTime()) ? null : parsed;
  } catch (error) {
    console.error("[datetime] Erro ao parsear data/hora:", error);
    return null;
  }
}

/**
 * Converte Date para string YYYY-MM-DD (formato backend/ISO)
 * @param date - Date object
 * @returns String formatada YYYY-MM-DD
 */
export function toISODateString(date: Date): string {
  if (!date || isNaN(date.getTime())) return "";
  
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  
  return `${year}-${month}-${day}`;
}

/**
 * Formata data relativa (hoje, ontem, amanhã, ou DD/MM/AAAA)
 * @param date - Date object, string ISO, ou timestamp
 * @returns String formatada relativa ou DD/MM/AAAA
 */
export function formatDateRelativeBR(date: Date | string | number): string {
  if (!date) return "";
  
  try {
    const dateObj = typeof date === "string" || typeof date === "number" 
      ? new Date(date) 
      : date;
    
    if (isNaN(dateObj.getTime())) return "";
    
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    
    const isSameDay = (d1: Date, d2: Date) =>
      d1.getDate() === d2.getDate() &&
      d1.getMonth() === d2.getMonth() &&
      d1.getFullYear() === d2.getFullYear();
    
    if (isSameDay(dateObj, today)) return "Hoje";
    if (isSameDay(dateObj, yesterday)) return "Ontem";
    if (isSameDay(dateObj, tomorrow)) return "Amanhã";
    
    return formatDateBR(dateObj);
  } catch (error) {
    console.error("[datetime] Erro ao formatar data relativa:", error);
    return "";
  }
}

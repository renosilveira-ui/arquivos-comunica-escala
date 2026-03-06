// lib/utils.ts — Utilitários compartilhados
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Merge Tailwind classes com suporte a condicionais */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

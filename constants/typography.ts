/**
 * Tipografia iOS-Like Clean
 * 
 * Aumentada globalmente para acessibilidade.
 * Nada abaixo de 16px para conteúdo principal.
 */

import { Platform } from "react-native";

export const Typography = {
  // Títulos
  titleMain: "text-3xl font-extrabold leading-tight",      // Título principal (não text-4xl)
  titleSection: "text-2xl font-bold leading-tight",        // Título de seção
  
  // Textos
  textDefault: "text-lg leading-6",                        // Texto padrão (16px+)
  textSubtext: "text-base leading-5",                      // Subtexto
  textLabel: "text-sm font-semibold tracking-wide",        // Labels pequenos
  
  // Botões
  button: "text-lg font-semibold",                         // Botões
  
  // Fonte system (SF/iOS default)
  fontFamily: Platform.select({
    ios: "System",
    android: "Roboto",
    default: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
  }),
} as const;

// Helper para aplicar fonte system
export const systemFont = {
  fontFamily: Typography.fontFamily,
};

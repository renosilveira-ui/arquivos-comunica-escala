import { useMemo } from "react";

export type AccentTheme = "green" | "yellow" | "pink" | "blue" | "red";

interface AccentColors {
  start: string;
  end: string;
}

const ACCENT_COLORS: Record<AccentTheme, AccentColors> = {
  green: { start: "#10B981", end: "#059669" }, // Verde padrão
  yellow: { start: "#FBBF24", end: "#F59E0B" }, // Setembro Amarelo
  pink: { start: "#EC4899", end: "#DB2777" }, // Outubro Rosa
  blue: { start: "#3B82F6", end: "#1D4ED8" }, // Novembro Azul
  red: { start: "#DC2626", end: "#991B1B" }, // Dezembro Vermelho
};

/**
 * Hook para calcular o tema de accent (cor do mês) automaticamente
 * 
 * Mapeamento:
 * - Setembro: amarelo (Setembro Amarelo)
 * - Outubro: rosa (Outubro Rosa)
 * - Novembro: azul (Novembro Azul)
 * - Dezembro: bordô/vermelho (Dezembro Vermelho)
 * - Outros meses: verde padrão
 * 
 * @param themeOverride - Override manual do tema (opcional)
 * @returns Cores do accent (start e end para gradiente)
 */
export function useAccentTheme(themeOverride?: AccentTheme | "auto"): AccentColors {
  return useMemo(() => {
    // Se houver override e não for "auto", usar o override
    if (themeOverride && themeOverride !== "auto") {
      return ACCENT_COLORS[themeOverride];
    }

    // Calcular tema automático baseado no mês atual
    const currentMonth = new Date().getMonth() + 1; // 1-12

    switch (currentMonth) {
      case 9: // Setembro
        return ACCENT_COLORS.yellow;
      case 10: // Outubro
        return ACCENT_COLORS.pink;
      case 11: // Novembro
        return ACCENT_COLORS.blue;
      case 12: // Dezembro
        return ACCENT_COLORS.red;
      default: // Outros meses
        return ACCENT_COLORS.green;
    }
  }, [themeOverride]);
}

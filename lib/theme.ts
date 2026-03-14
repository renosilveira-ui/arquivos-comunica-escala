/**
 * Design system constants for Escalas Hospitalares.
 * Use these for inline styles; use Tailwind classes for layout.
 */
export const theme = {
  colors: {
    screenBg: "#0B1120",
    cardBg: "#141B2D",
    cardBorder: "rgba(148, 163, 184, 0.15)",
    inputBg: "#0F172A",
    textPrimary: "#F1F5F9",
    textSecondary: "#94A3B8",
    textMuted: "#64748B",
    primary: "#3B82F6",
    success: "#22C55E",
    warning: "#F59E0B",
    danger: "#EF4444",
    statusVago: "#EF4444",
    statusPendente: "#F59E0B",
    statusOcupado: "#22C55E",
  },
  spacing: {
    screenPadding: 16,
    cardPadding: 16,
    gap: 12,
  },
  borderRadius: {
    card: 12,
    button: 10,
    input: 8,
  },
} as const;

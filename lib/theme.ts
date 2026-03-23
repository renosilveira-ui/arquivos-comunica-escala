/**
 * Design system constants for Escalas Hospitalares.
 * Use these for inline styles; use Tailwind classes for layout.
 */
export const theme = {
  colors: {
    background: "#F8FAFC",
    card: "#FFFFFF",
    border: "#E2E8F0",
    textPrimary: "#0F172A",
    textSecondary: "#475569",
    primaryNavy: "#0B1F3A",
    primaryNavyHover: "#12345C",
    accent: "#1D4ED8",
    screenBg: "#F8FAFC",
    cardBg: "#FFFFFF",
    cardBorder: "#E2E8F0",
    inputBg: "#FFFFFF",
    textMuted: "#64748B",
    primary: "#1D4ED8",
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

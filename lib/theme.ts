/**
 * Design system constants for Escalas Hospitalares.
 * Use these for inline styles; use Tailwind classes for layout.
 */
export const theme = {
  colors: {
    // Flat light system (primary source of truth)
    background: "#F8FBFF",
    surface: "#FFFFFF",
    surfaceAlt: "#F1F5F9",
    border: "#DBEAFE",
    textPrimary: "#0F172A",
    textSecondary: "#475569",
    textMuted: "#64748B",
    primary: "#2563EB",
    accent: "#2563EB",

    // Legacy aliases kept for compatibility while migrating screens
    screenBg: "#F8FBFF",
    cardBg: "#FFFFFF",
    cardBorder: "#DBEAFE",
    inputBg: "#FFFFFF",

    success: "#22C55E",
    warning: "#F59E0B",
    danger: "#EF4444",
    statusVago: "#EF4444",
    statusPendente: "#F59E0B",
    statusOcupado: "#22C55E",
  },
  spacing: {
    screenPadding: 24,
    cardPadding: 16,
    gap: 16,
    contentMaxWidth: 1200,
  },
  borderRadius: {
    card: 12,
    button: 10,
    input: 8,
  },
} as const;

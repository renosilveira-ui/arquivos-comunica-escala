/**
 * Design system tokens for Escalas Hospitalares.
 *
 * Spec governando este arquivo: docs/design/ui-system.md (Phase 2 do
 * protocolo /ui-design). Toda mudança aqui precisa estar lá.
 *
 * Estrutura:
 *   - Scales primitivas (palette de cor por família, type scale, spacing,
 *     radius, shadows). Fonte de verdade.
 *   - `theme.colors.*` (papel semântico). O app referencia estes — os
 *     hex acima são fonte de verdade.
 *
 * Regra dura (skill /ui-design): se um valor literal de cor/spacing/
 * tipografia aparece em `app/`, é violação.
 */

// ─── Scales primitivas ──────────────────────────────────────────────────

const palette = {
  neutral: {
    0: "#FFFFFF",
    50: "#F8FAFC",
    100: "#F1F5F9",
    150: "#E4EAF1", // papel de mesa: o fundo do app (proposta de design 23/08)
    200: "#E2E8F0",
    300: "#CBD5E1",
    400: "#94A3B8",
    500: "#64748B",
    600: "#475569",
    700: "#334155",
    800: "#1E293B",
    900: "#0F172A",
  },
  primary: {
    50: "#EFF6FF",
    100: "#DBEAFE",
    200: "#BFDBFE",
    500: "#3B82F6",
    600: "#2563EB",
    700: "#1D4ED8",
    900: "#1E3A8A",
  },
  // Marca (amostrada de assets/images/icon.png e do wordmark ESCALA+): a
  // tinta navy — cabeçalho do panorama, avatar, "meu plantão", sidebar.
  brand: {
    100: "#DBEAFE", // tint claro (reaproveita primary.100)
    500: "#01304A",
    600: "#012639", // pressed
  },
  success: {
    50: "#F0FDF4",
    100: "#DCFCE7",
    500: "#22C55E",
    700: "#15803D",
    900: "#14532D",
  },
  warning: {
    50: "#FFFBEB",
    100: "#FEF3C7",
    500: "#F59E0B",
    700: "#B45309",
    900: "#78350F",
  },
  danger: {
    50: "#FEF2F2",
    100: "#FEE2E2",
    500: "#EF4444",
    600: "#DC2626",
    900: "#7F1D1D",
  },
  info: {
    50: "#EFF6FF",
    500: "#3B82F6",
    700: "#1D4ED8",
  },
} as const;

const fontFamily = {
  sans:
    '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  mono:
    'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
} as const;

const text = {
  display: { fontSize: 32, lineHeight: 40, letterSpacing: -0.5 },
  titleLg: { fontSize: 24, lineHeight: 32, letterSpacing: -0.25 },
  title: { fontSize: 18, lineHeight: 26, letterSpacing: 0 },
  // Título de card/linha (entre title e bodyLg) — nome do plantão, setor.
  titleSm: { fontSize: 16, lineHeight: 22, letterSpacing: -0.1 },
  bodyLg: { fontSize: 16, lineHeight: 24, letterSpacing: 0 },
  body: { fontSize: 14, lineHeight: 20, letterSpacing: 0 },
  caption: { fontSize: 12, lineHeight: 16, letterSpacing: 0.1 },
  // Eyebrow: rótulo curto em caixa alta acima de um título ("PRÓXIMO
  // PLANTÃO", "SETOR"). Sempre com textTransform: "uppercase".
  // Tracking larga do wordmark "E S C A L A +" entra na tipografia.
  eyebrow: { fontSize: 11, lineHeight: 14, letterSpacing: 1.6 },
} as const;

const weight = {
  regular: "400" as const,
  medium: "500" as const,
  semibold: "600" as const,
  bold: "700" as const,
};

const space = {
  0: 0,
  1: 4,
  2: 8,
  3: 12,
  4: 16,
  5: 20,
  6: 24,
  8: 32,
  10: 40,
  14: 56,
  20: 80,
} as const;

const radius = {
  none: 0,
  sm: 4,
  md: 8,
  lg: 12,
  xl: 16,
  "2xl": 24,
  full: 999,
} as const;

// React Native shadows precisam de offset/opacity/radius em vez de
// CSS box-shadow. Tokens encapsulam.
const shadow = {
  sm: {
    shadowColor: "#0F172A",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.04,
    shadowRadius: 2,
    elevation: 1, // Android
  },
  md: {
    shadowColor: "#0F172A",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.08,
    shadowRadius: 12,
    elevation: 4,
  },
  lg: {
    shadowColor: "#0F172A",
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.12,
    shadowRadius: 28,
    elevation: 12,
  },
} as const;

// ─── Theme público ─────────────────────────────────────────────────────

export const theme = {
  // Scales primitivas (acessíveis para casos onde o papel semântico não
  // existe ainda — preferir tokens semânticos abaixo).
  palette,
  fontFamily,
  text,
  weight,
  space,
  radius,
  shadow,

  // ─── Tokens semânticos (papel) ───
  // O app referencia estes. Os hex acima são fonte de verdade.
  colors: {
    // Surfaces
    // Fundo "papel": neutral.50 diferia 1,2% do card branco e nenhuma borda
    // de 1px sustentava o contorno — a correção desce o fundo (23/08).
    background: palette.neutral[150],
    surface: palette.neutral[0],
    surfaceAlt: palette.neutral[100],

    // Borders
    border: palette.neutral[200],
    borderStrong: palette.neutral[300],

    // Text
    textPrimary: palette.neutral[900],
    textSecondary: palette.neutral[600],
    textMuted: palette.neutral[500],
    textDisabled: palette.neutral[400],

    // Brand
    brand: palette.brand[500],
    brandSoft: palette.brand[100],
    /** A malha do ícone vira régua da grade do panorama. */
    gridLine: "rgba(1, 48, 74, 0.14)",
    primary: palette.primary[600],
    primaryHover: palette.primary[500],
    primaryActive: palette.primary[700],
    primarySoft: palette.primary[100],

    // Status (default + soft for tinted backgrounds)
    success: palette.success[500],
    successSoft: palette.success[100],
    warning: palette.warning[500],
    warningSoft: palette.warning[100],
    danger: palette.danger[500],
    dangerSoft: palette.danger[100],
    info: palette.info[500],
    infoSoft: palette.primary[100], // mesmo do primarySoft no piloto

    // Status semânticos para badges/dots de plantão (Pendente / Ocupado).
    // VAGO foi removido aqui — T3 do audit prescreve neutro; consumidores
    // usam theme.colors.textMuted ou theme.colors.border conforme contexto.
    statusPendente: palette.warning[500],
    statusOcupado: palette.success[500],
    // Vago por contexto (lib/shift-status.ts já decide listing × actionable).
    statusVagoListing: palette.neutral[400],
    statusVagoActionable: palette.danger[600],

    // Glass surfaces — DEPRECADO (23/08): blur é iOS-only e Android cai no
    // fallback opaco. Surface cobre todos os usos; remover junto com
    // TintedGlassCard/GlassCard quando as telas antigas migrarem.
    // Não fazem parte da spec canônica de Card (§6.4) porque dependem
    // de blur + transparência que existem só em iOS via BlurView. Em
    // Android caímos para o fallback opaco (mesma cor sem blur).
    glass: {
      lightBg: "rgba(255, 255, 255, 0.92)",
      lightBorder: palette.primary[100],
      darkBg: "rgba(255, 255, 255, 0.08)",
      darkBorder: "rgba(255, 255, 255, 0.12)",
      // Variante "dark opaque": superfície escura translúcida com
      // alpha alto — usada por GlassCard.tsx (não confundir com o
      // tinted-glass branco do TintedGlassCard).
      darkOpaqueBg: "rgba(20, 28, 38, 0.72)",
    },

    // Sidebar (desktop). Cor escolhida pra contraste forte com o canvas
    // claro do app — mais frio/azulado que neutral.900. Spec §6.14.
    sidebarBg: palette.brand[500],

    // Modal/sheet scrim — neutral.900 com 50% (spec §5 modais).
    overlay: "rgba(15, 23, 42, 0.5)",

    // ScreenGradient — pares de cores para o gradiente do canvas. O
    // claro segue paleta primary; o escuro segue sidebarBg + neutral.900.
    gradient: {
      // Par claro = papel: o gradiente fica quase imperceptível de propósito.
      lightStart: palette.neutral[150],
      lightEnd: palette.neutral[100],
      darkStart: "#1E3A5F", // azul-noite mais claro que sidebarBg
      darkEnd: palette.neutral[900],
    },

    // Família "onDark": cores aplicadas sobre superfícies escuras
    // (sidebar, hospital-dashboard, admin). White-on-dark com
    // diferentes graus de presença, mais translúcidos para divisores
    // e hovers; primarySoft é o azul translúcido para chips em dark.
    onDark: {
      text: "#FFFFFF",
      textMuted: "rgba(255, 255, 255, 0.6)",
      textDisabled: "rgba(255, 255, 255, 0.4)",
      textInactive: palette.primary[200], // ítem inativo da sidebar
      surface: "rgba(255, 255, 255, 0.12)", // fill translúcido (avatar)
      divider: "rgba(255, 255, 255, 0.08)",
      hover: "rgba(255, 255, 255, 0.06)",
      primarySoft: "rgba(59, 130, 246, 0.15)", // chip primary em dark
    },
  },

  // ─── Níveis de superfície (camadas) ───
  // A profundidade da UI vem de 3 níveis, não de sombras ad hoc:
  //   canvas   → o fundo (ScreenGradient / background), sem estilo próprio
  //   card     → conteúdo agrupado: surface + borda 1px + sombra sm
  //   raised   → o que precisa se destacar do card: sem borda, sombra md
  //   floating → sheets, menus, toasts: sombra lg
  // Usar via <Surface level="..."> (components/ui/Surface.tsx).
  surface: {
    card: {
      backgroundColor: palette.neutral[0],
      borderWidth: 1,
      borderColor: palette.neutral[300], // 200 não sustentava o contorno sobre o papel
      borderRadius: radius.lg,
      ...shadow.sm,
    },
    raised: {
      backgroundColor: palette.neutral[0],
      // Sem borda, raised existia só pela sombra — que Android achata.
      borderWidth: 1,
      borderColor: palette.neutral[300],
      borderRadius: radius.xl,
      ...shadow.md,
    },
    floating: {
      backgroundColor: palette.neutral[0],
      borderWidth: 0,
      borderRadius: radius.xl,
      ...shadow.lg,
    },
  },

  // ─── Spacing legado ───
  // Mantém os 4 valores antigos como aliases para os tokens novos.
  // Phase 4 migra usos diretos.
  spacing: {
    screenPadding: space[6], // 24
    cardPadding: space[4], // 16
    gap: space[4], // 16
    contentMaxWidth: 1200,
  },

  // ─── Border radius legado ───
  borderRadius: {
    card: radius.lg, // 12
    button: radius.md, // 8 (era 10 — Phase 4 audita)
    input: radius.md, // 8
  },
} as const;

// Tipo do theme — útil para componentes que recebem theme via prop.
export type Theme = typeof theme;

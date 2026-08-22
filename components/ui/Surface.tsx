// components/ui/Surface.tsx — a única forma de criar "camada" na UI.
//
// Antes, cada tela montava o seu card (borderRadius 12 + borderWidth 1 +
// cores soltas) e a profundidade era inconsistente. Aqui há três níveis
// (theme.surface) e cinco tons; qualquer card, painel ou sheet nasce
// deste componente. Cor de texto dentro de um tom vem de `tonedText()`.

import type { ReactNode } from "react";
import { Pressable, View, type StyleProp, type ViewStyle } from "react-native";
import { theme } from "@/lib/theme";

export type SurfaceLevel = "card" | "raised" | "floating";
export type SurfaceTone = "default" | "primary" | "success" | "warning" | "danger" | "muted";

export interface SurfaceProps {
  level?: SurfaceLevel;
  tone?: SurfaceTone;
  /** Padding interno padrão (space.4). `false` para conteúdo edge-to-edge. */
  padded?: boolean | "compact";
  onPress?: () => void;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
  children: ReactNode;
}

function toneStyle(tone: SurfaceTone): ViewStyle {
  switch (tone) {
    case "primary":
      return { backgroundColor: theme.colors.primarySoft, borderColor: theme.palette.primary[200] };
    case "success":
      return { backgroundColor: theme.colors.successSoft, borderColor: theme.palette.success[100] };
    case "warning":
      return { backgroundColor: theme.colors.warningSoft, borderColor: theme.palette.warning[100] };
    case "danger":
      return { backgroundColor: theme.colors.dangerSoft, borderColor: theme.palette.danger[100] };
    case "muted":
      return { backgroundColor: theme.colors.surfaceAlt, borderColor: theme.colors.border };
    default:
      return {};
  }
}

/** Cor de texto legível (≥ 4,5:1) sobre cada tom de superfície. */
export function tonedText(tone: SurfaceTone): { strong: string; soft: string } {
  switch (tone) {
    case "primary":
      return { strong: theme.palette.primary[900], soft: theme.palette.primary[700] };
    case "success":
      return { strong: theme.palette.success[900], soft: theme.palette.success[700] };
    case "warning":
      return { strong: theme.palette.warning[900], soft: theme.palette.warning[700] };
    case "danger":
      return { strong: theme.palette.danger[900], soft: theme.palette.danger[600] };
    default:
      return { strong: theme.colors.textPrimary, soft: theme.colors.textSecondary };
  }
}

export function Surface({
  level = "card",
  tone = "default",
  padded = true,
  onPress,
  accessibilityLabel,
  style,
  children,
}: SurfaceProps) {
  const base: ViewStyle = {
    ...theme.surface[level],
    ...toneStyle(tone),
    padding: padded === "compact" ? theme.space[3] : padded ? theme.space[4] : 0,
    overflow: "hidden",
  };

  if (onPress) {
    return (
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        style={({ pressed }) => [base, { opacity: pressed ? 0.92 : 1 }, style]}
      >
        {children}
      </Pressable>
    );
  }
  return <View style={[base, style]}>{children}</View>;
}

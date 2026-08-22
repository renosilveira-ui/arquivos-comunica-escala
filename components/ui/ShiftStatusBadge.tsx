// components/ui/ShiftStatusBadge.tsx — status do plantão com TEXTO + ÍCONE.
//
// Cor é reforço, nunca o único canal (corredor com pouca luz, daltonismo,
// tela pequena). Tons de texto em [700]/[600] sobre o tint claro para
// bater 4,5:1 mesmo em 12px.

import { Text, View, type StyleProp, type ViewStyle } from "react-native";
import { theme } from "@/lib/theme";
import { shiftStatusMeta, type ShiftStatusContext, type ShiftStatusTone } from "@/lib/shift-status";

function toneTokens(tone: ShiftStatusTone): { bg: string; fg: string } {
  switch (tone) {
    case "danger":
      return { bg: theme.colors.dangerSoft, fg: theme.palette.danger[600] };
    case "warning":
      return { bg: theme.colors.warningSoft, fg: theme.palette.warning[700] };
    case "success":
      return { bg: theme.colors.successSoft, fg: theme.palette.success[700] };
    default:
      return { bg: theme.colors.surfaceAlt, fg: theme.colors.textSecondary };
  }
}

export interface ShiftStatusBadgeProps {
  status: string | null | undefined;
  /** "actionable" = o usuário pode agir (VAGO vira vermelho). */
  context?: ShiftStatusContext;
  size?: "sm" | "md";
  style?: StyleProp<ViewStyle>;
}

export function ShiftStatusBadge({ status, context = "listing", size = "md", style }: ShiftStatusBadgeProps) {
  const meta = shiftStatusMeta(status, { context });
  const tokens = toneTokens(meta.tone);
  const Icon = meta.Icon;
  const height = size === "sm" ? theme.space[5] : theme.space[6];
  const iconSize = size === "sm" ? 12 : 14;

  return (
    <View
      accessibilityLabel={`Status: ${meta.label}`}
      style={[
        {
          flexDirection: "row",
          alignItems: "center",
          gap: theme.space[1],
          height,
          paddingHorizontal: theme.space[2],
          borderRadius: theme.radius.full,
          backgroundColor: tokens.bg,
          alignSelf: "flex-start",
        },
        style,
      ]}
    >
      <Icon size={iconSize} color={tokens.fg} />
      <Text
        style={{
          fontSize: theme.text.caption.fontSize,
          fontWeight: theme.weight.semibold,
          color: tokens.fg,
          letterSpacing: theme.text.caption.letterSpacing,
        }}
      >
        {meta.label}
      </Text>
    </View>
  );
}

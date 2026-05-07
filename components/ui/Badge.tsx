import { View, Text, type ViewProps } from "react-native";
import { theme } from "@/lib/theme";

/**
 * Badge component — pill chip para metadata curta (status, modalidade,
 * role). Spec Phase 2 §6.5 (docs/design/ui-system.md).
 *
 * Variants visuais (5):
 *   - neutral  → bg surfaceAlt,  text textPrimary
 *   - primary  → bg primarySoft, text primary
 *   - success  → bg successSoft, text success.700
 *   - warning  → bg warningSoft, text warning.700
 *   - danger   → bg dangerSoft,  text danger.600
 *
 * Sizes (2):
 *   - sm → height 20, padding-x 8, font 11
 *   - md → height 24, padding-x 12, font 12 (default)
 *
 * Aliases legados aceitos como variant para retrocompat (Phase 4):
 *   "critical" → mapeia para "danger"
 *   "info"     → mapeia para "primary"
 * As 4 telas que ainda usam esses nomes podem migrar gradualmente
 * sem quebrar; quando todas migrarem, removemos os aliases em PR
 * de cleanup-final.
 *
 * Sem border por padrão. Cor tinted + texto colorido carregam o
 * peso visual sem precisar de outline.
 */

export type BadgeVariant =
  | "neutral"
  | "primary"
  | "success"
  | "warning"
  | "danger"
  // Aliases legados — preferir os canônicos acima:
  | "critical" // → danger
  | "info"; // → primary

export type BadgeSize = "sm" | "md";

export interface BadgeProps extends ViewProps {
  variant: BadgeVariant;
  size?: BadgeSize;
  label?: string;
  children?: React.ReactNode;
  className?: string;
}

interface VariantTokens {
  bg: string;
  fg: string;
}

function tokensForVariant(variant: BadgeVariant): VariantTokens {
  switch (variant) {
    case "neutral":
      return { bg: theme.colors.surfaceAlt, fg: theme.colors.textPrimary };
    case "primary":
    case "info": // alias legado
      return { bg: theme.colors.primarySoft, fg: theme.colors.primary };
    case "success":
      return { bg: theme.colors.successSoft, fg: theme.palette.success[700] };
    case "warning":
      return { bg: theme.colors.warningSoft, fg: theme.palette.warning[700] };
    case "danger":
    case "critical": // alias legado
      return { bg: theme.colors.dangerSoft, fg: theme.palette.danger[600] };
  }
}

interface SizeTokens {
  height: number;
  paddingX: number;
  fontSize: number;
}

function tokensForSize(size: BadgeSize): SizeTokens {
  return size === "sm"
    ? { height: 20, paddingX: theme.space[2], fontSize: 11 }
    : { height: 24, paddingX: theme.space[3], fontSize: theme.text.caption.fontSize };
}

export function Badge({
  variant,
  size = "md",
  label,
  children,
  className,
  style,
  ...props
}: BadgeProps) {
  const variantTokens = tokensForVariant(variant);
  const sizeTokens = tokensForSize(size);

  return (
    <View
      style={[
        {
          height: sizeTokens.height,
          paddingHorizontal: sizeTokens.paddingX,
          borderRadius: theme.radius.full,
          backgroundColor: variantTokens.bg,
          alignItems: "center",
          justifyContent: "center",
          alignSelf: "flex-start",
        },
        style,
      ]}
      className={className}
      {...props}
    >
      <Text
        style={{
          fontSize: sizeTokens.fontSize,
          fontWeight: theme.weight.semibold,
          color: variantTokens.fg,
          letterSpacing: theme.text.caption.letterSpacing,
        }}
      >
        {children || label}
      </Text>
    </View>
  );
}

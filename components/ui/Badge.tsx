import { View, Text, type ViewProps } from "react-native";
import { cn } from "@/lib/utils";

export type BadgeVariant = "success" | "warning" | "neutral" | "critical" | "info";

export interface BadgeProps extends ViewProps {
  /**
   * Badge variant
   */
  variant: BadgeVariant;
  /**
   * Badge label (opcional se children for fornecido)
   */
  label?: string;
  /**
   * Badge content (alternativa ao label)
   */
  children?: React.ReactNode;
  /**
   * Tailwind className
   */
  className?: string;
}

/**
 * Badge component - Badges com variantes glass para UI escura
 * 
 * Variantes:
 * - success: rgba(52,211,153,0.18) + border rgba(52,211,153,0.55) - Verde esmeralda
 * - warning: rgba(251,191,36,0.18) + border rgba(251,191,36,0.55) - Amarelo âmbar
 * - neutral: rgba(255,255,255,0.10) + border rgba(255,255,255,0.14) - Branco neutro
 * - critical: rgba(239,68,68,0.18) + border rgba(239,68,68,0.55) - Vermelho
 * - info: rgba(59,130,246,0.18) + border rgba(59,130,246,0.55) - Azul
 * 
 * Texto: sempre #F2F6FF (branco suave)
 */
export function Badge({ variant, label, children, className, style, ...props }: BadgeProps) {
  const variantStyles = {
    success: {
      backgroundColor: "rgba(52,211,153,0.18)",
      borderColor: "rgba(52,211,153,0.55)",
    },
    warning: {
      backgroundColor: "rgba(251,191,36,0.18)",
      borderColor: "rgba(251,191,36,0.55)",
    },
    neutral: {
      backgroundColor: "rgba(255,255,255,0.10)",
      borderColor: "rgba(255,255,255,0.14)",
    },
    critical: {
      backgroundColor: "rgba(239,68,68,0.18)",
      borderColor: "rgba(239,68,68,0.55)",
    },
    info: {
      backgroundColor: "rgba(59,130,246,0.18)",
      borderColor: "rgba(59,130,246,0.55)",
    },
  };

  return (
    <View
      style={[
        {
          paddingHorizontal: 12,
          paddingVertical: 6,
          borderRadius: 9999,
          borderWidth: 1,
          ...variantStyles[variant],
        },
        style,
      ]}
      className={className}
      {...props}
    >
      <Text style={{ fontSize: 12, fontWeight: "600", color: "#F2F6FF" }}>
        {children || label}
      </Text>
    </View>
  );
}

import { View, Text, type ViewProps } from "react-native";
import { cn } from "@/lib/utils";
import { theme } from "@/lib/theme";

export interface StatPillProps extends ViewProps {
  /**
   * Stat label
   */
  label: string;
  /**
   * Stat value
   */
  value: string | number;
  /**
   * Optional icon component
   */
  icon?: React.ReactNode;
  /**
   * Tailwind className
   */
  className?: string;
}

/**
 * StatPill component - Mini métricas para dashboards
 */
export function StatPill({ label, value, icon, className, style, ...props }: StatPillProps) {
  return (
    <View
      className={cn("bg-surface border border-border rounded-xl px-3 py-2.5", className)}
      style={style}
      {...props}
    >
      <View className="flex-row items-center gap-1.5 mb-1">
        {icon}
        <Text style={{ ...theme.text.caption, fontWeight: theme.weight.medium, color: theme.colors.textSecondary }}>{label}</Text>
      </View>
      <Text style={{ ...theme.text.titleLg, fontWeight: theme.weight.bold, color: theme.colors.textPrimary, fontVariant: ["tabular-nums"] }}>{value}</Text>
    </View>
  );
}

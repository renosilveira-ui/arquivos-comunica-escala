import { View, Text, type ViewProps } from "react-native";
import { cn } from "@/lib/utils";

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
        <Text className="text-text2 text-sm font-medium">{label}</Text>
      </View>
      <Text className="text-text text-xl font-bold">{value}</Text>
    </View>
  );
}

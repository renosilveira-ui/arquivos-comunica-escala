import { View, Text, type ViewProps } from "react-native";
import { cn } from "@/lib/utils";

export interface EmptyStateProps extends ViewProps {
  /**
   * Icon component
   */
  icon: React.ReactNode;
  /**
   * Title
   */
  title: string;
  /**
   * Description
   */
  description?: string;
  /**
   * Optional action button
   */
  action?: React.ReactNode;
  /**
   * Tailwind className
   */
  className?: string;
}

/**
 * EmptyState component - Ícone + título + descrição institucional
 */
export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
  style,
  ...props
}: EmptyStateProps) {
  return (
    <View
      className={cn("items-center justify-center py-12 px-6", className)}
      style={style}
      {...props}
    >
      <View className="mb-4 opacity-60">{icon}</View>
      <Text className="text-white text-xl font-bold text-center mb-2">{title}</Text>
      {description && (
        <Text className="text-slate-400 text-base text-center mb-6">{description}</Text>
      )}
      {action && <View className="w-full">{action}</View>}
    </View>
  );
}

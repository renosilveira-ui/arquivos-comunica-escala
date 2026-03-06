import { View, TouchableOpacity, type ViewStyle } from "react-native";
import { cn } from "@/lib/utils";

export interface CardProps {
  /**
   * Tailwind className for the card
   */
  className?: string;
  /**
   * Children elements
   */
  children?: React.ReactNode;
  /**
   * Card variant (default or primary)
   */
  variant?: "default" | "primary";
  /**
   * OnPress handler (makes card touchable)
   */
  onPress?: () => void;
  /**
   * Style object
   */
  style?: ViewStyle;
}

/**
 * Card component - Card padrão
 * bg-surface border border-border rounded-3xl p-5
 */
export function Card({ children, className, style, variant = "default", onPress }: CardProps) {
  const baseStyles = variant === "primary" 
    ? "bg-accent border-accent" 
    : "bg-surface border border-border";

  if (onPress) {
    return (
      <TouchableOpacity
        className={cn(baseStyles, "rounded-3xl p-5", className)}
        style={style}
        activeOpacity={0.7}
        onPress={onPress}
      >
        {children}
      </TouchableOpacity>
    );
  }

  return (
    <View
      className={cn(baseStyles, "rounded-3xl p-5", className)}
      style={style}
    >
      {children}
    </View>
  );
}

import { TouchableOpacity, Text, type TouchableOpacityProps, ActivityIndicator } from "react-native";
import { cn } from "@/lib/utils";

export interface SecondaryButtonProps extends TouchableOpacityProps {
  /**
   * Button label
   */
  label: string;
  /**
   * Loading state
   */
  loading?: boolean;
  /**
   * Tailwind className
   */
  className?: string;
}

/**
 * SecondaryButton component - Botão secundário
 * bg-surface2 border border-border, texto text-text
 */
export function SecondaryButton({
  label,
  loading = false,
  className,
  disabled,
  ...props
}: SecondaryButtonProps) {
  return (
    <TouchableOpacity
      className={cn(
        "bg-surface2 border border-border rounded-3xl h-14 px-5 items-center justify-center",
        disabled && "opacity-50",
        className
      )}
      activeOpacity={0.7}
      disabled={disabled || loading}
      {...props}
    >
      {loading ? (
        <ActivityIndicator color="#A7B3C2" />
      ) : (
        <Text className="text-text text-lg font-semibold">{label}</Text>
      )}
    </TouchableOpacity>
  );
}

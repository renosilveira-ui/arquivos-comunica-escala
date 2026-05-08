import { TouchableOpacity, Text, type TouchableOpacityProps, ActivityIndicator } from "react-native";
import { cn } from "@/lib/utils";
import { theme } from "@/lib/theme";

export interface PrimaryButtonProps extends TouchableOpacityProps {
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
  /**
   * Optional icon (React element)
   */
  icon?: React.ReactNode;
}

/**
 * PrimaryButton component - CTA padrão
 * bg-accent com texto branco, rounded-3xl, active:opacity-90
 */
export function PrimaryButton({
  label,
  loading = false,
  className,
  disabled,
  icon,
  ...props
}: PrimaryButtonProps) {
  return (
    <TouchableOpacity
      className={cn(
        "bg-accent rounded-3xl h-14 px-5 flex-row items-center justify-center gap-2",
        disabled && "opacity-50",
        className
      )}
      activeOpacity={0.9}
      disabled={disabled || loading}
      {...props}
    >
      {loading ? (
        <ActivityIndicator color={theme.colors.surface} />
      ) : (
        <>
          {icon}
          <Text className="text-white text-lg font-semibold">{label}</Text>
        </>
      )}
    </TouchableOpacity>
  );
}

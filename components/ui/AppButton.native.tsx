import React from "react";
import { Pressable, Text, ViewStyle, TextStyle } from "react-native";
import { theme } from "@/lib/theme";

/**
 * AppButton — versão native. Espelha a spec §6.1 (5 variants × 3 sizes).
 *
 * Mantém paridade visual com AppButton.web (cores, sizes, radius via tokens).
 */

type Variant = "primary" | "secondary" | "danger" | "ghost" | "link";
type Size = "sm" | "md" | "lg";

type Props = {
  title: string;
  onPress: () => void;
  disabled?: boolean;
  variant?: Variant;
  size?: Size;
  fullWidth?: boolean;
  style?: ViewStyle;
};

const SIZE_MAP: Record<
  Size,
  { height: number; paddingX: number; fontSize: number; fontWeight: TextStyle["fontWeight"] }
> = {
  sm: {
    height: 32,
    paddingX: theme.space[3],
    fontSize: theme.text.body.fontSize,
    fontWeight: theme.weight.medium,
  },
  md: {
    height: 40,
    paddingX: theme.space[4],
    fontSize: theme.text.body.fontSize,
    fontWeight: theme.weight.semibold,
  },
  lg: {
    height: 48,
    paddingX: theme.space[5],
    fontSize: theme.text.bodyLg.fontSize,
    fontWeight: theme.weight.semibold,
  },
};

function variantStyles(variant: Variant): { container: ViewStyle; text: TextStyle } {
  switch (variant) {
    case "primary":
      return {
        container: { backgroundColor: theme.colors.primary },
        text: { color: theme.colors.surface },
      };
    case "secondary":
      return {
        container: {
          backgroundColor: theme.colors.surface,
          borderWidth: 1,
          borderColor: theme.colors.border,
        },
        text: { color: theme.colors.textPrimary },
      };
    case "danger":
      return {
        container: { backgroundColor: theme.colors.danger },
        text: { color: theme.colors.surface },
      };
    case "ghost":
      return {
        container: { backgroundColor: "transparent" },
        text: { color: theme.colors.textPrimary },
      };
    case "link":
      return {
        container: { backgroundColor: "transparent", paddingHorizontal: 0 },
        text: { color: theme.colors.primary },
      };
  }
}

export function AppButton({
  title,
  onPress,
  disabled = false,
  variant = "primary",
  size = "md",
  fullWidth = true,
  style,
}: Props) {
  const sz = SIZE_MAP[size];
  const v = variantStyles(variant);

  return (
    <Pressable
      onPress={disabled ? undefined : onPress}
      style={({ pressed }) => [
        {
          minHeight: sz.height,
          borderRadius: theme.radius.md,
          paddingHorizontal: sz.paddingX,
          justifyContent: "center",
          alignItems: "center",
          width: fullWidth ? "100%" : undefined,
          opacity: disabled ? 0.4 : pressed ? 0.85 : 1,
        },
        v.container,
        style,
      ]}
    >
      <Text
        style={{
          fontSize: sz.fontSize,
          fontWeight: sz.fontWeight,
          ...v.text,
        }}
      >
        {title}
      </Text>
    </Pressable>
  );
}

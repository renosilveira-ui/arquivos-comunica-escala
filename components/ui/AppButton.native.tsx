import React from "react";
import { Pressable, Text, ViewStyle } from "react-native";

type Props = {
  title: string;
  onPress: () => void;
  disabled?: boolean;
  variant?: "primary" | "danger" | "neutral";
  fullWidth?: boolean;
  style?: ViewStyle;
};

export function AppButton({
  title,
  onPress,
  disabled = false,
  variant = "primary",
  fullWidth = true,
  style,
}: Props) {
  const bg =
    variant === "primary"
      ? "#3B82F6"
      : variant === "danger"
      ? "#EF4444"
      : "rgba(255,255,255,0.08)";

  return (
    <Pressable
      onPress={disabled ? undefined : onPress}
      style={({ pressed }) => [
        {
          minHeight: 52,
          borderRadius: 14,
          paddingHorizontal: 16,
          justifyContent: "center",
          alignItems: "center",
          width: fullWidth ? "100%" : undefined,
          opacity: disabled ? 0.6 : pressed ? 0.85 : 1,
          backgroundColor: bg,
        },
        style,
      ]}
    >
      <Text style={{ color: "white", fontSize: 16, fontWeight: "700" }}>
        {title}
      </Text>
    </Pressable>
  );
}

import { BlurView } from "expo-blur";
import { ReactNode } from "react";
import { Platform, TouchableOpacity, View, ViewStyle } from "react-native";
import { theme } from "@/lib/theme";

/**
 * TintedGlassCard — superfície com efeito de vidro fosco (tinted glass).
 *
 * Variantes:
 *   - `dark`  → tinta branca translúcida sobre gradiente escuro (sidebar,
 *               hospital-dashboard).
 *   - `light` → tinta branca translúcida sobre gradiente claro (uso geral
 *               em telas com `ScreenGradient`).
 *
 * Tokens consumidos:
 *   - cores       → `theme.colors.glass.*`
 *   - radius      → `theme.radius["2xl"]` (24)
 *   - padding     → `theme.space[5]` (20)
 *
 * Não está na spec canônica de Card (§6.4) — esta variante depende de
 * BlurView + transparência (iOS). Em Android cai pro fallback opaco
 * sem blur, mantendo a mesma paleta translúcida.
 */
interface TintedGlassCardProps {
  children: ReactNode;
  onPress?: () => void;
  style?: ViewStyle;
  className?: string;
  variant?: "dark" | "light";
}

const BLUR_INTENSITY = 22;
const CARD_RADIUS = theme.radius["2xl"];
const CARD_PADDING = theme.space[5];

export function TintedGlassCard({
  children,
  onPress,
  style,
  className,
  variant = "dark",
}: TintedGlassCardProps) {
  const isLight = variant === "light";
  const baseCardStyle: ViewStyle = isLight
    ? {
        backgroundColor: theme.colors.glass.lightBg,
        borderWidth: 1,
        borderColor: theme.colors.glass.lightBorder,
      }
    : {
        backgroundColor: theme.colors.glass.darkBg,
        borderWidth: 1,
        borderColor: theme.colors.glass.darkBorder,
      };

  const content = (
    <View
      style={[
        baseCardStyle,
        { borderRadius: CARD_RADIUS, padding: CARD_PADDING, overflow: "hidden" },
        style,
      ]}
      className={className}
    >
      {children}
    </View>
  );

  const wrapperStyle: ViewStyle = { borderRadius: CARD_RADIUS, overflow: "hidden" };

  if (onPress) {
    return (
      <TouchableOpacity onPress={onPress} activeOpacity={0.7} style={wrapperStyle}>
        {Platform.OS === "ios" ? (
          <BlurView
            intensity={BLUR_INTENSITY}
            tint={isLight ? "light" : "dark"}
            style={wrapperStyle}
          >
            {content}
          </BlurView>
        ) : (
          content
        )}
      </TouchableOpacity>
    );
  }

  return Platform.OS === "ios" ? (
    <BlurView
      intensity={BLUR_INTENSITY}
      tint={isLight ? "light" : "dark"}
      style={wrapperStyle}
    >
      {content}
    </BlurView>
  ) : (
    content
  );
}

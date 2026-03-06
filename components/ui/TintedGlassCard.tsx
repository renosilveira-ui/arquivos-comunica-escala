import { BlurView } from "expo-blur";
import { ReactNode } from "react";
import { Platform, TouchableOpacity, View, ViewStyle } from "react-native";

interface TintedGlassCardProps {
  children: ReactNode;
  onPress?: () => void;
  style?: ViewStyle;
  className?: string;
}

/**
 * TintedGlassCard - Card com efeito de vidro fosco (tinted glass)
 * 
 * Especificações:
 * - BlurView intensity 22 (discreto)
 * - Overlay: rgba(255,255,255,0.08)
 * - Border: rgba(255,255,255,0.12)
 * - Radius: 24px (rounded-3xl)
 * - Padding: p-5
 * 
 * Fallback (sem blur):
 * - backgroundColor: rgba(255,255,255,0.06)
 * 
 * Uso:
 * ```tsx
 * <TintedGlassCard>
 *   <Text className="text-white">Content</Text>
 * </TintedGlassCard>
 * ```
 */
export function TintedGlassCard({ children, onPress, style, className }: TintedGlassCardProps) {
  const content = (
    <View
      style={[
        {
          backgroundColor: "rgba(255,255,255,0.08)",
          borderWidth: 1,
          borderColor: "rgba(255,255,255,0.12)",
          borderRadius: 24,
          padding: 20,
          overflow: "hidden",
        },
        style,
      ]}
      className={className}
    >
      {children}
    </View>
  );

  // Se tiver onPress, envolver em TouchableOpacity
  if (onPress) {
    return (
      <TouchableOpacity
        onPress={onPress}
        activeOpacity={0.7}
        style={{ borderRadius: 24, overflow: "hidden" }}
      >
        {Platform.OS === "ios" ? (
          <BlurView intensity={22} tint="dark" style={{ borderRadius: 24, overflow: "hidden" }}>
            {content}
          </BlurView>
        ) : (
          content
        )}
      </TouchableOpacity>
    );
  }

  // Sem onPress, apenas o card
  return Platform.OS === "ios" ? (
    <BlurView intensity={22} tint="dark" style={{ borderRadius: 24, overflow: "hidden" }}>
      {content}
    </BlurView>
  ) : (
    content
  );
}

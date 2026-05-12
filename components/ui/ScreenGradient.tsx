import { LinearGradient } from "expo-linear-gradient";
import { ReactNode } from "react";
import { ScrollView, View, ViewProps, RefreshControlProps } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { theme } from "@/lib/theme";

interface ScreenGradientProps extends ViewProps {
  children: ReactNode;
  scrollable?: boolean;
  refreshControl?: React.ReactElement<RefreshControlProps>;
  variant?: "dark" | "light";
}

/**
 * ScreenGradient - Wrapper global com gradiente escuro premium + imagem de fundo
 * 
 * Camadas:
 * 1. ImageBackground (relógios e calendários via CDN)
 * 2. Overlay gradiente escuro (theme.colors.gradient.darkStart → darkEnd)
 * 3. Conteúdo
 * 
 * Uso:
 * ```tsx
 * <ScreenGradient scrollable>
 *   <View className="space-y-4">
 *     {content}
 *   </View>
 * </ScreenGradient>
 * ```
 */
export function ScreenGradient({
  children,
  scrollable = false,
  refreshControl,
  variant = "light",
  className,
  ...props
}: ScreenGradientProps) {
  const colors =
    variant === "light"
      ? ([theme.colors.gradient.lightStart, theme.colors.gradient.lightEnd] as const)
      : ([theme.colors.gradient.darkStart, theme.colors.gradient.darkEnd] as const);

  return (
    <LinearGradient
      colors={colors}
      start={{ x: 0.5, y: 0 }}
      end={{ x: 0.5, y: 1 }}
      style={{ flex: 1 }}
    >
        <SafeAreaView style={{ flex: 1 }} edges={["top", "left", "right"]}>
          {scrollable ? (
            <ScrollView
              contentContainerStyle={{ paddingHorizontal: theme.space[5], paddingVertical: theme.space[4] }}
              showsVerticalScrollIndicator={false}
              keyboardShouldPersistTaps="handled"
              refreshControl={refreshControl}
              {...props}
            >
              {children}
            </ScrollView>
          ) : (
            <View style={{ flex: 1, paddingHorizontal: theme.space[5], paddingVertical: theme.space[4] }} {...props}>
              {children}
            </View>
          )}
        </SafeAreaView>
    </LinearGradient>
  );
}

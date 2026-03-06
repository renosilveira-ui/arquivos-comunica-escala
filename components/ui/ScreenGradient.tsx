import { LinearGradient } from "expo-linear-gradient";
import { ReactNode } from "react";
import { ScrollView, View, ViewProps, RefreshControlProps } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

interface ScreenGradientProps extends ViewProps {
  children: ReactNode;
  scrollable?: boolean;
  refreshControl?: React.ReactElement<RefreshControlProps>;
}

/**
 * ScreenGradient - Wrapper global com gradiente escuro premium + imagem de fundo
 * 
 * Camadas:
 * 1. ImageBackground (relógios e calendários via CDN)
 * 2. Overlay gradiente escuro (#0F2238 → #0B1220) com 85% opacidade
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
  className,
  ...props
}: ScreenGradientProps) {
  return (
    <LinearGradient
      colors={["#1e3a5f", "#0a1929"]}
      start={{ x: 0.5, y: 0 }}
      end={{ x: 0.5, y: 1 }}
      style={{ flex: 1 }}
    >
        <SafeAreaView style={{ flex: 1 }} edges={["top", "left", "right"]}>
          {scrollable ? (
            <ScrollView
              contentContainerStyle={{ paddingHorizontal: 20, paddingVertical: 16 }}
              showsVerticalScrollIndicator={false}
              refreshControl={refreshControl}
              {...props}
            >
              {children}
            </ScrollView>
          ) : (
            <View style={{ flex: 1, paddingHorizontal: 20, paddingVertical: 16 }} {...props}>
              {children}
            </View>
          )}
        </SafeAreaView>
    </LinearGradient>
  );
}

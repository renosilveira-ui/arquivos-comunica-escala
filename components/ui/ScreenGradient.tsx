import { ReactNode } from "react";
import { ScrollView, View, ViewProps, RefreshControlProps } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { theme } from "@/lib/theme";

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
    <View style={{ flex: 1, backgroundColor: theme.colors.background }}>
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
    </View>
  );
}

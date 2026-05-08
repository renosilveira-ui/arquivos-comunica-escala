import { View, TouchableOpacity, type ViewStyle, Platform } from "react-native";
import { BlurView } from "expo-blur";
import { cn } from "@/lib/utils";
import { theme } from "@/lib/theme";

export interface GlassCardProps {
  /**
   * Tailwind className for the card
   */
  className?: string;
  /**
   * Children elements
   */
  children?: React.ReactNode;
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
 * GlassCard component - Card com glass effect discreto (iOS-like)
 * 
 * ✅ CORRIGIDO: Removido padding duplicado (p-5 + p-4)
 * Agora tem apenas 1 padding (p-5) e 1 borda
 * 
 * Blur intensity 22, overlay theme.colors.glass.darkOpaqueBg, border
 * theme.colors.glass.darkBorder.
 */
export function GlassCard({ children, className, style, onPress }: GlassCardProps) {
  const content = (
    <View className={cn("rounded-3xl overflow-hidden", className)} style={style}>
      {Platform.OS === "web" ? (
        // Fallback para web: fundo sólido
        <View className="bg-surface border border-border rounded-3xl p-5">
          {children}
        </View>
      ) : (
        // Blur nativo para iOS/Android
        <BlurView intensity={22} tint="dark" className="rounded-3xl">
          <View 
            className="rounded-3xl p-5" 
            style={{ 
              backgroundColor: theme.colors.glass.darkOpaqueBg,
              borderWidth: 1,
              borderColor: theme.colors.glass.darkBorder,
            }}
          >
            {children}
          </View>
        </BlurView>
      )}
    </View>
  );

  if (onPress) {
    return (
      <TouchableOpacity
        activeOpacity={0.7}
        onPress={onPress}
        style={style}
      >
        {content}
      </TouchableOpacity>
    );
  }

  return content;
}

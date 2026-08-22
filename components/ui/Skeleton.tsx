// components/ui/Skeleton.tsx — carregamento com a forma do conteúdo.
//
// Um spinner central apaga a tela inteira a cada navegação (o "CARREGANDO"
// do PegaPlantão). O skeleton mantém o layout no lugar e pulsa de leve;
// com "reduzir movimento" ativo, fica estático.

import { useEffect, useRef, useState } from "react";
import { AccessibilityInfo, Animated, Easing, Platform, View, type StyleProp, type ViewStyle } from "react-native";
import { theme } from "@/lib/theme";

interface SkeletonProps {
  width?: number | `${number}%`;
  height?: number;
  radius?: number;
  style?: StyleProp<ViewStyle>;
}

function usePulse(): Animated.Value {
  const value = useRef(new Animated.Value(0.55)).current;
  const [reduceMotion, setReduceMotion] = useState(false);

  useEffect(() => {
    if (Platform.OS === "web") return;
    AccessibilityInfo.isReduceMotionEnabled()
      .then(setReduceMotion)
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (reduceMotion) {
      value.setValue(0.7);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(value, { toValue: 1, duration: 700, easing: Easing.inOut(Easing.quad), useNativeDriver: Platform.OS !== "web" }),
        Animated.timing(value, { toValue: 0.55, duration: 700, easing: Easing.inOut(Easing.quad), useNativeDriver: Platform.OS !== "web" }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [value, reduceMotion]);

  return value;
}

export function Skeleton({ width = "100%", height = theme.space[4], radius = theme.radius.sm, style }: SkeletonProps) {
  const opacity = usePulse();
  return (
    <Animated.View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[{ width, height, borderRadius: radius, backgroundColor: theme.colors.surfaceAlt, opacity }, style]}
    />
  );
}

/** Card de skeleton com título + 2 linhas — para listas de plantões. */
export function SkeletonCard({ lines = 2, style }: { lines?: number; style?: StyleProp<ViewStyle> }) {
  return (
    <View
      style={[
        {
          ...theme.surface.card,
          padding: theme.space[4],
          gap: theme.space[2],
        },
        style,
      ]}
    >
      <Skeleton width="55%" height={theme.space[4]} />
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton key={i} width={i === lines - 1 ? "40%" : "80%"} height={theme.space[3]} />
      ))}
    </View>
  );
}

/** Lista de N SkeletonCards com o espaçamento padrão. */
export function SkeletonList({ count = 3 }: { count?: number }) {
  return (
    <View style={{ gap: theme.space[3] }} accessibilityLabel="Carregando" accessibilityRole="progressbar">
      {Array.from({ length: count }).map((_, i) => (
        <SkeletonCard key={i} />
      ))}
    </View>
  );
}

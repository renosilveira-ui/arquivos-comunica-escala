/**
 * Hook de animações reutilizáveis usando react-native-reanimated
 */

import { useEffect } from "react";
import { useSharedValue, withTiming, withSpring, Easing } from "react-native-reanimated";

/**
 * Animação de fade in ao montar componente
 * @param duration Duração da animação em ms (padrão: 300)
 * @returns Valor animado de opacidade (0 → 1)
 */
export function useFadeIn(duration = 300) {
  const opacity = useSharedValue(0);

  useEffect(() => {
    opacity.value = withTiming(1, {
      duration,
      easing: Easing.out(Easing.ease),
    });
  }, []);

  return opacity;
}

/**
 * Animação de slide in (entrada da esquerda)
 * @param duration Duração da animação em ms (padrão: 300)
 * @returns Valor animado de translateX (-100 → 0)
 */
export function useSlideInLeft(duration = 300) {
  const translateX = useSharedValue(-100);

  useEffect(() => {
    translateX.value = withTiming(0, {
      duration,
      easing: Easing.out(Easing.cubic),
    });
  }, []);

  return translateX;
}

/**
 * Animação de slide in (entrada da direita)
 * @param duration Duração da animação em ms (padrão: 300)
 * @returns Valor animado de translateX (100 → 0)
 */
export function useSlideInRight(duration = 300) {
  const translateX = useSharedValue(100);

  useEffect(() => {
    translateX.value = withTiming(0, {
      duration,
      easing: Easing.out(Easing.cubic),
    });
  }, []);

  return translateX;
}

/**
 * Animação de slide in (entrada de baixo)
 * @param duration Duração da animação em ms (padrão: 300)
 * @returns Valor animado de translateY (50 → 0)
 */
export function useSlideInUp(duration = 300) {
  const translateY = useSharedValue(50);

  useEffect(() => {
    translateY.value = withTiming(0, {
      duration,
      easing: Easing.out(Easing.cubic),
    });
  }, []);

  return translateY;
}

/**
 * Animação de scale in (entrada com escala)
 * @param duration Duração da animação em ms (padrão: 250)
 * @returns Valor animado de scale (0.9 → 1)
 */
export function useScaleIn(duration = 250) {
  const scale = useSharedValue(0.9);

  useEffect(() => {
    scale.value = withSpring(1, {
      damping: 15,
      stiffness: 150,
    });
  }, []);

  return scale;
}

/**
 * Animação de bounce (pulo suave)
 * @param trigger Valor que dispara a animação
 * @returns Valor animado de translateY (0 → -10 → 0)
 */
export function useBounce(trigger: any) {
  const translateY = useSharedValue(0);

  useEffect(() => {
    translateY.value = withTiming(-10, { duration: 150 }, () => {
      translateY.value = withTiming(0, { duration: 150 });
    });
  }, [trigger]);

  return translateY;
}

/**
 * Animação de pulse (pulsação)
 * @param trigger Valor que dispara a animação
 * @returns Valor animado de scale (1 → 1.05 → 1)
 */
export function usePulse(trigger: any) {
  const scale = useSharedValue(1);

  useEffect(() => {
    scale.value = withTiming(1.05, { duration: 150 }, () => {
      scale.value = withTiming(1, { duration: 150 });
    });
  }, [trigger]);

  return scale;
}

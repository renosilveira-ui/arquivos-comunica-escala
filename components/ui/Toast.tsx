// components/ui/Toast.tsx — feedback de ação NÃO bloqueante.
//
// Antes, toda resposta de mutation era um diálogo modal (window.alert /
// Alert.alert) — e no celular algumas telas simplesmente não davam
// retorno nenhum. Aqui: um único toast no rodapé, 3 s, tom por token,
// acessível (live region), com ação opcional ("Tentar novamente").
// Diálogo modal fica só para CONFIRMAR ação irreversível (lib/ui/confirm).

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  AccessibilityInfo,
  Animated,
  Easing,
  Platform,
  Pressable,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AlertCircle, CheckCircle2, Info } from "lucide-react-native";
import { theme } from "@/lib/theme";

export type ToastTone = "success" | "danger" | "neutral";
export interface ToastAction {
  label: string;
  onPress: () => void;
}
export interface ToastOptions {
  tone?: ToastTone;
  durationMs?: number;
  action?: ToastAction;
}
interface ToastItem {
  id: number;
  message: string;
  tone: ToastTone;
  durationMs: number;
  action?: ToastAction;
}
interface ToastContextValue {
  show: (message: string, options?: ToastOptions) => void;
  dismiss: () => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const DEFAULT_DURATION_MS = 3200;
// Acima da tab bar (≈56 + safe-area) para não cobrir as abas no celular.
const TAB_BAR_CLEARANCE = theme.space[14] + theme.space[3];

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<ToastItem | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = () => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  };

  const dismiss = useCallback(() => {
    clearTimer();
    setToast(null);
  }, []);

  const show = useCallback((message: string, options?: ToastOptions) => {
    clearTimer();
    setToast({
      id: Date.now(),
      message,
      tone: options?.tone ?? "neutral",
      durationMs: options?.durationMs ?? DEFAULT_DURATION_MS,
      action: options?.action,
    });
  }, []);

  useEffect(() => {
    if (!toast) return;
    timer.current = setTimeout(() => setToast(null), toast.durationMs);
    return clearTimer;
  }, [toast]);

  const value = useMemo(() => ({ show, dismiss }), [show, dismiss]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <ToastHost toast={toast} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast precisa estar dentro de <ToastProvider>");
  return ctx;
}

function toneTokens(tone: ToastTone): { icon: string; Icon: typeof Info } {
  switch (tone) {
    case "success":
      return { icon: theme.palette.success[500], Icon: CheckCircle2 };
    case "danger":
      return { icon: theme.palette.danger[500], Icon: AlertCircle };
    default:
      return { icon: theme.palette.primary[200], Icon: Info };
  }
}

function ToastHost({ toast, onDismiss }: { toast: ToastItem | null; onDismiss: () => void }) {
  const insets = useSafeAreaInsets();
  const progress = useRef(new Animated.Value(0)).current;
  const [reduceMotion, setReduceMotion] = useState(false);

  useEffect(() => {
    if (Platform.OS === "web") return;
    AccessibilityInfo.isReduceMotionEnabled()
      .then(setReduceMotion)
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!toast) return;
    progress.setValue(0);
    if (reduceMotion) {
      progress.setValue(1);
      return;
    }
    Animated.timing(progress, {
      toValue: 1,
      duration: 180,
      easing: Easing.out(Easing.quad),
      useNativeDriver: Platform.OS !== "web",
    }).start();
  }, [toast, progress, reduceMotion]);

  if (!toast) return null;
  const tone = toneTokens(toast.tone);
  const Icon = tone.Icon;

  return (
    <View
      pointerEvents="box-none"
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        bottom: insets.bottom + TAB_BAR_CLEARANCE,
        alignItems: "center",
        paddingHorizontal: theme.space[4],
      }}
    >
      <Animated.View
        accessibilityRole="alert"
        accessibilityLiveRegion="polite"
        style={{
          width: "100%",
          maxWidth: theme.spacing.contentMaxWidth / 2,
          opacity: progress,
          transform: [
            { translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [12, 0] }) },
          ],
        }}
      >
        <Pressable
          onPress={onDismiss}
          accessibilityLabel="Fechar aviso"
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: theme.space[3],
            minHeight: theme.space[14],
            backgroundColor: theme.palette.neutral[800],
            borderWidth: 1,
            borderColor: theme.palette.neutral[700],
            borderRadius: theme.radius.lg,
            paddingHorizontal: theme.space[4],
            paddingVertical: theme.space[3],
          }}
        >
          <Icon size={20} color={tone.icon} />
          <Text
            style={{
              flex: 1,
              ...theme.text.body,
              color: theme.colors.onDark.text,
              fontWeight: theme.weight.medium,
            }}
          >
            {toast.message}
          </Text>
          {toast.action ? (
            <Pressable
              onPress={() => {
                onDismiss();
                toast.action?.onPress();
              }}
              hitSlop={8}
              style={{ minHeight: theme.space[10], justifyContent: "center", paddingHorizontal: theme.space[2] }}
            >
              <Text style={{ ...theme.text.body, fontWeight: theme.weight.bold, color: tone.icon }}>
                {toast.action.label}
              </Text>
            </Pressable>
          ) : null}
        </Pressable>
      </Animated.View>
    </View>
  );
}

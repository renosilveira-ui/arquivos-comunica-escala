// components/AppErrorBoundary.tsx — rede de segurança global contra crash
//
// Em build release, um erro JS fatal sem boundary FECHA o app sem
// nenhum diagnóstico (crash reportado pelo PO no primeiro teste iOS).
// Este boundary:
//   1. Impede o fechamento — mostra tela amigável com "Tentar novamente"
//   2. Persiste o último erro em AsyncStorage (chave @escala/last-crash)
//      para diagnóstico posterior (Perfil poderá expor/enviar futuramente)
//
// Frente futura: substituir a persistência local por crash reporting
// remoto (Sentry).

import React from "react";
import { View, Text, TouchableOpacity, ScrollView } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { theme } from "@/lib/theme";

const CRASH_KEY = "@escala/last-crash";

interface Props {
  children: React.ReactNode;
}

interface State {
  error: Error | null;
}

export class AppErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    const record = {
      message: error.message,
      stack: error.stack?.slice(0, 4000),
      componentStack: info.componentStack?.slice(0, 2000),
      at: new Date().toISOString(),
    };
    AsyncStorage.setItem(CRASH_KEY, JSON.stringify(record)).catch(() => {});
    console.error("[AppErrorBoundary]", error.message);
  }

  handleRetry = () => {
    this.setState({ error: null });
  };

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <View
        style={{
          flex: 1,
          backgroundColor: theme.colors.background,
          alignItems: "center",
          justifyContent: "center",
          padding: theme.space[6],
        }}
      >
        <Text
          style={{
            fontSize: 20,
            fontWeight: "700",
            color: theme.colors.textPrimary,
            marginBottom: theme.space[2],
            textAlign: "center",
          }}
        >
          Algo deu errado
        </Text>
        <Text
          style={{
            fontSize: 14,
            color: theme.colors.textSecondary,
            textAlign: "center",
            marginBottom: theme.space[5],
          }}
        >
          O aplicativo encontrou um erro inesperado. Seus dados estão seguros.
        </Text>
        <TouchableOpacity
          onPress={this.handleRetry}
          activeOpacity={0.8}
          style={{
            backgroundColor: theme.colors.primary,
            paddingHorizontal: theme.space[6],
            paddingVertical: theme.space[3],
            borderRadius: theme.radius.md,
          }}
        >
          <Text style={{ color: theme.colors.surface, fontSize: 16, fontWeight: "600" }}>
            Tentar novamente
          </Text>
        </TouchableOpacity>
        <ScrollView
          style={{
            maxHeight: 120,
            marginTop: theme.space[6],
            alignSelf: "stretch",
          }}
        >
          <Text style={{ fontSize: 11, color: theme.colors.textDisabled, fontFamily: "Courier" }}>
            {this.state.error.message}
          </Text>
        </ScrollView>
      </View>
    );
  }
}

/** Lê (sem limpar) o último crash persistido — exibido em Perfil → Diagnóstico. */
export async function getLastCrash(): Promise<string | null> {
  try {
    return await AsyncStorage.getItem(CRASH_KEY);
  } catch {
    return null;
  }
}

export async function clearLastCrash(): Promise<void> {
  try {
    await AsyncStorage.removeItem(CRASH_KEY);
  } catch {
    // best-effort
  }
}

/**
 * Captura erros FATAIS fora do ciclo de render (o boundary só pega erros
 * de render). Persiste antes do app morrer, preservando o handler
 * original do RN. Instalado uma única vez no import do root layout.
 */
type RNErrorUtils = {
  getGlobalHandler: () => (error: unknown, isFatal?: boolean) => void;
  setGlobalHandler: (handler: (error: unknown, isFatal?: boolean) => void) => void;
};
const errorUtils = (globalThis as { ErrorUtils?: RNErrorUtils }).ErrorUtils;
if (errorUtils) {
  const previous = errorUtils.getGlobalHandler();
  errorUtils.setGlobalHandler((error, isFatal) => {
    try {
      const e = error as Error;
      const record = {
        message: String(e?.message ?? error),
        stack: e?.stack?.slice(0, 4000),
        fatal: Boolean(isFatal),
        at: new Date().toISOString(),
      };
      AsyncStorage.setItem(CRASH_KEY, JSON.stringify(record)).catch(() => {});
    } catch {
      // nunca interferir no fluxo de erro original
    }
    previous?.(error, isFatal);
  });
}

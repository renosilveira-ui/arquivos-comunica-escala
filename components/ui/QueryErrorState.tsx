// components/ui/QueryErrorState.tsx — estado de erro padrão para telas
// cujas queries falharam.
//
// Regra (revisão 2026-08-19): falha de rede NUNCA pode renderizar o
// empty state normal — "Nenhuma solicitação", "Todos os plantões
// atribuídos", métricas zeradas etc. afirmam um fato que o app não
// sabe, e o usuário confia (gestor deixa de aprovar, médico acha que
// está em dia). Erro tem que parecer erro.

import { View, Text, TouchableOpacity } from "react-native";
import { CloudOff } from "lucide-react-native";
import { theme } from "@/lib/theme";

export function QueryErrorState({
  title = "Não foi possível carregar",
  onRetry,
}: {
  title?: string;
  onRetry: () => void;
}) {
  return (
    <View
      style={{
        alignItems: "center",
        paddingVertical: theme.space[10],
        paddingHorizontal: theme.space[6],
        gap: theme.space[4],
      }}
    >
      <CloudOff size={40} color={theme.colors.textDisabled} />
      <Text
        style={{
          fontSize: 15,
          fontWeight: "600",
          color: theme.colors.textPrimary,
          textAlign: "center",
        }}
      >
        {title}
      </Text>
      <Text
        style={{
          fontSize: 13,
          color: theme.colors.textSecondary,
          textAlign: "center",
        }}
      >
        Verifique sua conexão e tente novamente.
      </Text>
      <TouchableOpacity
        onPress={onRetry}
        activeOpacity={0.8}
        style={{
          paddingHorizontal: theme.space[5],
          paddingVertical: theme.space[3],
          borderRadius: theme.radius.md,
          backgroundColor: theme.colors.primary,
        }}
      >
        <Text style={{ color: theme.colors.surface, fontWeight: "600" }}>
          Tentar novamente
        </Text>
      </TouchableOpacity>
    </View>
  );
}

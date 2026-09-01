// components/ui/QueryErrorState.tsx — estado de erro padrão para telas
// cujas queries falharam.
//
// Regra (revisão 2026-08-19): falha de rede NUNCA pode renderizar o
// empty state normal — "Nenhuma solicitação", "Todos os plantões
// atribuídos", métricas zeradas etc. afirmam um fato que o app não
// sabe, e o usuário confia (gestor deixa de aprovar, médico acha que
// está em dia). Erro tem que parecer erro.

import { View, Text, TouchableOpacity } from "react-native";
import { AlertCircle, CloudOff } from "lucide-react-native";
import { theme } from "@/lib/theme";
import { presentQueryError } from "@/lib/query-error-presentation";

export function QueryErrorState({
  title = "Não foi possível carregar",
  error,
  description,
  onRetry,
}: {
  title?: string;
  error?: unknown;
  description?: string;
  onRetry: () => void;
}) {
  const presentation = presentQueryError(error);
  const Icon = presentation.kind === "NETWORK" ? CloudOff : AlertCircle;

  return (
    <View
      style={{
        alignItems: "center",
        paddingVertical: theme.space[10],
        paddingHorizontal: theme.space[6],
        gap: theme.space[4],
      }}
    >
      <Icon size={40} color={theme.colors.textDisabled} />
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
        {description ?? presentation.body}
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

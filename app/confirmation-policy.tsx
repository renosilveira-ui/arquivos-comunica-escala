import { Stack } from "expo-router";
import { Text, View } from "react-native";

import { ListRow } from "@/components/ui/ListRow";
import { QueryErrorState } from "@/components/ui/QueryErrorState";
import { ScreenContainer } from "@/components/ui/ScreenContainer";
import { ScreenGradient } from "@/components/ui/ScreenGradient";
import { SkeletonList } from "@/components/ui/Skeleton";
import { Surface } from "@/components/ui/Surface";
import { useActionFeedback } from "@/hooks/use-action-feedback";
import { theme } from "@/lib/theme";
import { trpc } from "@/lib/trpc";

/**
 * Plantão não confirmado — aviso ao gestor.
 *
 * Decisão do PO (12/09/2026): o aviso existe, mas é escolha do grupo de
 * trabalho, não imposição do sistema. Quem gerencia a escala liga ou
 * desliga aqui, para a instituição ativa. Texto para leigo, sem jargão.
 */
export default function ConfirmationPolicyScreen() {
  const feedback = useActionFeedback();
  const utils = trpc.useUtils();
  const policyQuery = trpc.institutionPolicy.get.useQuery(undefined, {
    staleTime: 30_000,
  });
  const setPolicy = trpc.institutionPolicy.setConfirmationEscalation.useMutation({
    onSuccess: async (result) => {
      await utils.institutionPolicy.get.invalidate();
      feedback.success(
        result.notifyManagerOnUnconfirmed
          ? "Aviso ao gestor ligado."
          : "Aviso ao gestor desligado.",
      );
    },
    onError: (error) => {
      feedback.error(error.message || "Não foi possível salvar a escolha.");
    },
  });

  const header = <Stack.Screen options={{ title: "Plantão não confirmado" }} />;

  if (policyQuery.isError) {
    return (
      <ScreenGradient>
        {header}
        <ScreenContainer>
          <QueryErrorState
            title="Não foi possível carregar esta configuração"
            error={policyQuery.error}
            onRetry={() => {
              void policyQuery.refetch();
            }}
          />
        </ScreenContainer>
      </ScreenGradient>
    );
  }

  const policy = policyQuery.data;

  return (
    <ScreenGradient scrollable>
      {header}
      <ScreenContainer>
        <View style={{ gap: theme.space[4] }}>
          <View style={{ gap: theme.space[2] }}>
            <Text
              style={{
                ...theme.text.title,
                fontWeight: theme.weight.bold,
                color: theme.colors.textPrimary,
              }}
            >
              Quando alguém não confirma o plantão
            </Text>
            <Text
              style={{
                ...theme.text.body,
                color: theme.colors.textSecondary,
              }}
            >
              O app pede ao médico que confirme presença antes do plantão. Se
              ele não responde a tempo, o gestor da escala pode receber um
              aviso para agir. Ligar ou não esse aviso é uma decisão da sua
              equipe, para toda a instituição.
            </Text>
          </View>

          {!policy ? (
            <SkeletonList count={1} />
          ) : (
            <Surface padded={false}>
              <ListRow
                title="Avisar o gestor"
                subtitle={
                  policy.notifyManagerOnUnconfirmed
                    ? "Ligado: sem resposta do médico, o gestor da escala é avisado."
                    : "Desligado: sem resposta, ninguém é avisado; a pendência encerra sozinha quando o plantão termina."
                }
                toggle={{
                  value: policy.notifyManagerOnUnconfirmed,
                  onValueChange: (value) => {
                    if (!policy.canManage || setPolicy.isPending) return;
                    setPolicy.mutate({ notifyManagerOnUnconfirmed: value });
                  },
                  accessibilityLabel: "Avisar o gestor quando o plantão não for confirmado",
                }}
              />
            </Surface>
          )}

          {policy && !policy.canManage ? (
            <Text
              style={{
                ...theme.text.caption,
                color: theme.colors.textMuted,
              }}
            >
              Só quem gerencia a escala desta instituição pode mudar esta
              escolha.
            </Text>
          ) : null}

          <Text
            style={{
              ...theme.text.caption,
              color: theme.colors.textMuted,
            }}
          >
            Em qualquer caso, uma confirmação sem resposta encerra sozinha
            quando o plantão termina. Ninguém é avisado nesse momento.
          </Text>
        </View>
      </ScreenContainer>
    </ScreenGradient>
  );
}

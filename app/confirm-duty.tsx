import { View, Text, ActivityIndicator, Platform } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Check, X, Clock } from "lucide-react-native";
import * as Haptics from "expo-haptics";
import { uiConfirmDestructive } from "@/lib/ui/alert";
import { ScreenGradient } from "@/components/ui/ScreenGradient";
import { TintedGlassCard } from "@/components/ui/TintedGlassCard";
import { PrimaryButton } from "@/components/ui/PrimaryButton";
import { Badge } from "@/components/ui/Badge";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/hooks/use-auth";
import { theme } from "@/lib/theme";
import { QueryErrorState } from "@/components/ui/QueryErrorState";
import { useActionFeedback } from "@/hooks/use-action-feedback";
import {
  formatHospitalDateLong,
  formatHospitalTime,
} from "@/lib/hospital-time";
import {
  DUTY_ASSUMED_SUCCESS_COPY,
  DUTY_CONFIRM_PROMPT_COPY,
  DUTY_CONFIRMED_SUCCESS_COPY,
  DUTY_NOMINATION_PROMPT_COPY,
} from "@/lib/duty-sync-copy";
import { invalidateOfficialScaleAndVacancyQueries } from "@/lib/official-scale-vacancy-query-refresh";
import {
  parseConfirmationRouteEpoch,
  parseConfirmationRouteToken,
} from "@/lib/confirmation-route-params";

export default function ConfirmDutyScreen() {
  const { user } = useAuth();
  const router = useRouter();
  const params = useLocalSearchParams<{
    token?: string | string[];
    nominationEpoch?: string | string[];
  }>();
  const feedback = useActionFeedback();
  const utils = trpc.useUtils();
  const hasDirectedToken = params.token !== undefined;
  const hasDirectedEpoch = params.nominationEpoch !== undefined;
  const directedToken = parseConfirmationRouteToken(params.token);
  const directedNominationEpoch = parseConfirmationRouteEpoch(
    params.nominationEpoch,
  );
  const malformedDirectedRoute =
    (hasDirectedToken && directedToken === null) ||
    (hasDirectedEpoch &&
      (directedToken === null || directedNominationEpoch === null));
  const directedNominationInput =
    directedToken && directedNominationEpoch
      ? {
          confirmationToken: directedToken,
          nominationEpoch: directedNominationEpoch,
        }
      : undefined;
  const shouldLookupNomination =
    !!user &&
    !malformedDirectedRoute &&
    (!hasDirectedToken || directedNominationInput !== undefined);

  const pendingQuery = trpc.confirmations.getPending.useQuery(
    directedToken ? { confirmationToken: directedToken } : undefined,
    { enabled: !!user && !malformedDirectedRoute, retry: 2 },
  );
  const pending = pendingQuery.data ?? null;
  // Push "duty_nomination": o token é de uma indicação dirigida a MIM.
  const nominationQuery = trpc.confirmations.getNomination.useQuery(
    directedNominationInput,
    { enabled: shouldLookupNomination, retry: 1 },
  );
  const nomination = nominationQuery.data ?? null;

  const acceptNominationMutation = trpc.confirmations.acceptNomination.useMutation({
    onSuccess: async () => {
      await invalidateOfficialScaleAndVacancyQueries(utils);
      feedback.success(DUTY_ASSUMED_SUCCESS_COPY);
      router.replace("/(tabs)/agenda" as any);
    },
    onError: (err) => feedback.error(err.message),
  });
  const declineNominationMutation = trpc.confirmations.declineNomination.useMutation({
    onSuccess: () => {
      feedback.info("Indicação recusada.");
      router.replace("/(tabs)/agenda" as any);
    },
    onError: (err) => feedback.error(err.message),
  });

  const confirmMutation = trpc.confirmations.confirm.useMutation({
    onSuccess: (data) => {
      const syncHint =
        data.dutySyncLocal?.status === "failed"
          ? " A sincronização com o Comunica+ será reprocessada."
          : "";
      feedback.success(
        `${DUTY_CONFIRMED_SUCCESS_COPY}${syncHint}`,
      );
      router.replace("/(tabs)/agenda" as any);
    },
    onError: (err) => {
      feedback.error(err.message);
    },
  });

  const declineMutation = trpc.confirmations.decline.useMutation({
    onSuccess: () => {
      if (Platform.OS !== "web") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      // No web o "confirm" vira: OK = indicar substituto, Cancelar = fechar.
      uiConfirmDestructive(
        "Plantão recusado",
        "Indique um substituto. Se a cobertura continuar pendente, o gestor será avisado para verificar manualmente.",
        "Indicar substituto",
        () => router.push({
          pathname: "/nominate-replacement" as any,
          params: { token: pending?.confirmationToken ?? "" },
        }),
      );
    },
    onError: (err) => {
      feedback.error(err.message);
    },
  });

  const token = directedToken ?? pending?.confirmationToken;
  const isBusy = confirmMutation.isPending || declineMutation.isPending;

  const handleConfirm = () => {
    if (!token) return;
    if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    confirmMutation.mutate({ confirmationToken: token });
  };

  const handleDecline = () => {
    if (!token) return;
    if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    uiConfirmDestructive(
      "Recusar plantão?",
      "Você poderá indicar um substituto. Sem aceite, o plantão continuará pendente e o gestor deverá verificar a cobertura.",
      "Sim, recusar",
      () => declineMutation.mutate({ confirmationToken: token }),
    );
  };

  if (
    pendingQuery.isLoading ||
    (shouldLookupNomination && nominationQuery.isLoading)
  ) {
    return (
      <ScreenGradient variant="light">
        <View style={{ flex: 1, justifyContent: "center", alignItems: "center" }}>
          <ActivityIndicator size="large" color={theme.colors.primary} />
        </View>
      </ScreenGradient>
    );
  }

  // Erro ≠ "tudo em dia": sem esta distinção, uma falha de rede
  // mostrava o check verde de sucesso enquanto uma confirmação real
  // seguia pendente e exigia resposta ou verificação humana.
  const directedLookupMiss =
    hasDirectedToken &&
    !malformedDirectedRoute &&
    !pendingQuery.isError &&
    !nominationQuery.isError &&
    !pending &&
    !nomination;
  if (
    malformedDirectedRoute ||
    pendingQuery.isError ||
    nominationQuery.isError ||
    directedLookupMiss
  ) {
    return (
      <ScreenGradient variant="light">
        <View style={{ flex: 1, justifyContent: "center" }}>
          <QueryErrorState
            title={
              malformedDirectedRoute || directedLookupMiss
                ? "Esta confirmação não está disponível ou já foi encerrada"
                : "Não foi possível verificar suas confirmações"
            }
            onRetry={() => {
              if (malformedDirectedRoute) {
                router.replace("/(tabs)/agenda" as any);
                return;
              }
              void pendingQuery.refetch();
              if (shouldLookupNomination) void nominationQuery.refetch();
            }}
          />
        </View>
      </ScreenGradient>
    );
  }

  if (nomination) {
    const nStart = new Date(nomination.shiftStartAt);
    const nEnd = new Date(nomination.shiftEndAt);
    const fmt = (d: Date) => formatHospitalTime(d);
    const nDate = formatHospitalDateLong(nStart, {
      weekday: "long",
      day: "2-digit",
      month: "long",
    });
    const nBusy = acceptNominationMutation.isPending || declineNominationMutation.isPending;
    return (
      <ScreenGradient variant="light">
        <View style={{ flex: 1, justifyContent: "center", paddingHorizontal: 20, gap: 20 }}>
          <Text style={{ fontSize: 24, fontWeight: "800", color: theme.colors.textPrimary, textAlign: "center" }}>
            Você foi indicado como substituto
          </Text>
          <TintedGlassCard variant="light">
            <View style={{ gap: 12 }}>
              <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
                <Text style={{ fontSize: 20, fontWeight: "700", color: theme.colors.textPrimary }}>{nomination.shiftLabel}</Text>
                <Badge variant="warning" label="Aguardando você" />
              </View>
              <Text style={{ fontSize: 16, color: theme.colors.textSecondary, textTransform: "capitalize" }}>{nDate}</Text>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <Clock size={18} color={theme.colors.textSecondary} />
                <Text style={{ fontSize: 18, fontWeight: "600", color: theme.colors.textPrimary }}>
                  {fmt(nStart)} – {fmt(nEnd)}
                </Text>
              </View>
              <Text style={{ fontSize: 15, color: theme.colors.textSecondary }}>{nomination.sectorName}</Text>
              <Text style={{ fontSize: 15, color: theme.colors.textSecondary }}>Indicado por {nomination.nominatedByName}</Text>
            </View>
          </TintedGlassCard>
          <Text style={{ fontSize: 16, color: theme.colors.textSecondary, textAlign: "center", lineHeight: 22 }}>
            {DUTY_NOMINATION_PROMPT_COPY}
          </Text>
          <View style={{ gap: 12 }}>
            <PrimaryButton
              label={acceptNominationMutation.isPending ? "Assumindo..." : "Aceitar o plantão"}
              icon={<Check size={20} color="#FFFFFF" />}
              onPress={() =>
                acceptNominationMutation.mutate({
                  confirmationToken: nomination.confirmationToken,
                  nominationEpoch: nomination.nominationEpoch,
                })
              }
              disabled={nBusy}
              loading={acceptNominationMutation.isPending}
            />
            <PrimaryButton
              label={declineNominationMutation.isPending ? "Processando..." : "Não posso assumir"}
              icon={<X size={20} color="#FFFFFF" />}
              onPress={() =>
                uiConfirmDestructive(
                  "Recusar a indicação?",
                  "Quem indicou você e a gestão serão avisados; a presença continuará sem confirmação.",
                  "Sim, recusar",
                  () =>
                    declineNominationMutation.mutate({
                      confirmationToken: nomination.confirmationToken,
                      nominationEpoch: nomination.nominationEpoch,
                    }),
                )
              }
              disabled={nBusy}
              loading={declineNominationMutation.isPending}
              className="bg-red-500"
            />
          </View>
        </View>
      </ScreenGradient>
    );
  }

  if (!pending) {
    return (
      <ScreenGradient variant="light">
        <View style={{ flex: 1, justifyContent: "center", alignItems: "center", paddingHorizontal: 24 }}>
          <Check size={48} color={theme.colors.success} />
          <Text style={{ fontSize: 20, fontWeight: "700", color: theme.colors.textPrimary, marginTop: 16, textAlign: "center" }}>
            Nenhuma confirmação pendente
          </Text>
          <Text style={{ fontSize: 15, color: theme.colors.textSecondary, marginTop: 8, textAlign: "center" }}>
            Seus plantões estão em dia.
          </Text>
          <PrimaryButton
            label="Voltar à Agenda"
            onPress={() => router.replace("/(tabs)/agenda" as any)}
            style={{ marginTop: 24, width: "100%" }}
          />
        </View>
      </ScreenGradient>
    );
  }

  const startTime = formatHospitalTime(pending.shiftStartAt);
  const endTime = formatHospitalTime(pending.shiftEndAt);
  const dateStr = formatHospitalDateLong(pending.shiftStartAt, {
    weekday: "long",
    day: "2-digit",
    month: "long",
  });

  return (
    <ScreenGradient variant="light">
      <View style={{ flex: 1, justifyContent: "center", paddingHorizontal: 20, gap: 20 }}>
        <Text style={{ fontSize: 24, fontWeight: "800", color: theme.colors.textPrimary, textAlign: "center" }}>
          Confirmação de Plantão
        </Text>

        <TintedGlassCard variant="light">
          <View style={{ gap: 12 }}>
            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
              <Text style={{ fontSize: 20, fontWeight: "700", color: theme.colors.textPrimary }}>
                {pending.shiftLabel}
              </Text>
              <Badge variant="warning" label="Aguardando" />
            </View>

            <Text style={{ fontSize: 16, color: theme.colors.textSecondary, textTransform: "capitalize" }}>
              {dateStr}
            </Text>

            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Clock size={18} color={theme.colors.textSecondary} />
              <Text style={{ fontSize: 18, fontWeight: "600", color: theme.colors.textPrimary }}>
                {startTime} – {endTime}
              </Text>
            </View>

            <Text style={{ fontSize: 15, color: theme.colors.textSecondary }}>
              {pending.sectorName}
            </Text>
          </View>
        </TintedGlassCard>

        <Text style={{ fontSize: 16, color: theme.colors.textSecondary, textAlign: "center", lineHeight: 22 }}>
          {DUTY_CONFIRM_PROMPT_COPY}
        </Text>

        <View style={{ gap: 12 }}>
          <PrimaryButton
            label={confirmMutation.isPending ? "Confirmando..." : "Sim, confirmo"}
            icon={<Check size={20} color="#FFFFFF" />}
            onPress={handleConfirm}
            disabled={isBusy}
            loading={confirmMutation.isPending}
          />

          <PrimaryButton
            label={declineMutation.isPending ? "Processando..." : "Não poderei estar"}
            icon={<X size={20} color="#FFFFFF" />}
            onPress={handleDecline}
            disabled={isBusy}
            loading={declineMutation.isPending}
            className="bg-red-500"
          />
        </View>
      </View>
    </ScreenGradient>
  );
}

import { View, Text, ActivityIndicator, Platform } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useState } from "react";
import { Check, X, UserPlus, Clock } from "lucide-react-native";
import * as Haptics from "expo-haptics";
import { uiAlert, uiConfirmDestructive } from "@/lib/ui/alert";
import { ScreenGradient } from "@/components/ui/ScreenGradient";
import { TintedGlassCard } from "@/components/ui/TintedGlassCard";
import { PrimaryButton } from "@/components/ui/PrimaryButton";
import { Badge } from "@/components/ui/Badge";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/hooks/use-auth";
import { theme } from "@/lib/theme";

export default function ConfirmDutyScreen() {
  const { user } = useAuth();
  const router = useRouter();
  const params = useLocalSearchParams<{ token?: string }>();
  const utils = trpc.useUtils();

  const { data: pending, isLoading } = trpc.confirmations.getPending.useQuery(
    undefined,
    { enabled: !!user },
  );

  const confirmMutation = trpc.confirmations.confirm.useMutation({
    onSuccess: () => {
      if (Platform.OS !== "web") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      uiAlert(
        "Plantão confirmado",
        "Seu login no Comunica+ será realizado automaticamente.",
        () => router.replace("/(tabs)/agenda" as any),
      );
    },
    onError: (err) => {
      uiAlert("Erro", err.message);
    },
  });

  const declineMutation = trpc.confirmations.decline.useMutation({
    onSuccess: () => {
      if (Platform.OS !== "web") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      // No web o "confirm" vira: OK = indicar substituto, Cancelar = fechar.
      uiConfirmDestructive(
        "Plantão recusado",
        "Indique um substituto ou o sistema confirmará automaticamente em 30 minutos.",
        "Indicar substituto",
        () => router.push({
          pathname: "/nominate-replacement" as any,
          params: { token: pending?.confirmationToken ?? "" },
        }),
      );
    },
    onError: (err) => {
      uiAlert("Erro", err.message);
    },
  });

  const token = params.token ?? pending?.confirmationToken;
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
      "Você poderá indicar um substituto. Se ninguém for indicado em 30 minutos, o sistema confirmará automaticamente.",
      "Sim, recusar",
      () => declineMutation.mutate({ confirmationToken: token }),
    );
  };

  if (isLoading) {
    return (
      <ScreenGradient variant="light">
        <View style={{ flex: 1, justifyContent: "center", alignItems: "center" }}>
          <ActivityIndicator size="large" color={theme.colors.primary} />
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

  const startTime = new Date(pending.shiftStartAt).toLocaleTimeString("pt-BR", {
    hour: "2-digit",
    minute: "2-digit",
  });
  const endTime = new Date(pending.shiftEndAt).toLocaleTimeString("pt-BR", {
    hour: "2-digit",
    minute: "2-digit",
  });
  const dateStr = new Date(pending.shiftStartAt).toLocaleDateString("pt-BR", {
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
          Você confirma sua presença neste plantão? Ao confirmar, o login no Comunica+ será feito automaticamente.
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

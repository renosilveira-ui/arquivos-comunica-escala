import { Text, View, TouchableOpacity, ActivityIndicator, ScrollView, Alert, Platform } from "react-native";
import { ScreenGradient } from "@/components/ui/ScreenGradient";
import { TintedGlassCard } from "@/components/ui/TintedGlassCard";
import { theme } from "@/lib/theme";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/hooks/use-auth";
import { useRouter } from "expo-router";
import * as Haptics from "expo-haptics";
import { ChevronLeft, Inbox, Clock, AlertCircle } from "lucide-react-native";
import { confirmAction } from "@/lib/ui/confirm";

/**
 * Tela "Minhas ofertas" — consome `swaps.list({ role: "OFFERER" })`
 * (PR #64) e `swaps.approveByOwner` (PR #59) para que o ofertante
 * (A) aprove a candidatura sem precisar passar por gestor.
 *
 * Fluxo:
 *   - "Aguardando sua aprovação": status=ACCEPTED, awaitingMyApproval=true.
 *     Render destacado + CTA "Aprovar".
 *   - "Em andamento": demais (PENDING aguardando candidato, ou já APPROVED/
 *     CANCELLED para histórico recente).
 *
 * Acesso: link em /profile (também roteável diretamente via /my-offers).
 */

type SwapType = "SWAP" | "TRANSFER" | "CESSAO";
type SwapStatus =
  | "PENDING"
  | "ACCEPTED"
  | "APPROVED"
  | "REJECTED_BY_PEER"
  | "REJECTED_BY_MANAGER"
  | "CANCELLED"
  | "EXPIRED";

const TYPE_LABEL: Record<SwapType, string> = {
  SWAP: "Troca",
  TRANSFER: "Repasse",
  CESSAO: "Cessão",
};

const STATUS_LABEL: Record<SwapStatus, string> = {
  PENDING: "Aguardando candidato",
  ACCEPTED: "Aguardando sua aprovação",
  APPROVED: "Aprovada",
  REJECTED_BY_PEER: "Recusada pelo profissional",
  REJECTED_BY_MANAGER: "Recusada pelo gestor",
  CANCELLED: "Cancelada",
  EXPIRED: "Expirada",
};

function formatDate(d: Date): string {
  return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "short", year: "numeric" });
}

function formatTimeRange(start: Date, end: Date): string {
  const fmt = (date: Date) =>
    date.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  return `${fmt(start)} – ${fmt(end)}`;
}

export default function MyOffersScreen() {
  const { user, isLoading: authLoading } = useAuth();
  const router = useRouter();

  // Filtro role=OFFERER (PR #64): só ofertas onde sou o ofertante.
  const { data, isLoading, refetch } = trpc.swaps.list.useQuery(
    { role: "OFFERER" },
    { enabled: !!user?.id },
  );

  const utils = trpc.useUtils();

  const approveMutation = trpc.swaps.approveByOwner.useMutation({
    onSuccess: () => {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      utils.swaps.list.invalidate();
      refetch();
    },
    onError: (error) => {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      const msg = error.message || "Erro ao aprovar a candidatura";
      if (Platform.OS === "web") {
        window.alert(msg);
      } else {
        Alert.alert("Erro", msg);
      }
    },
  });

  const cancelMutation = trpc.swaps.cancel.useMutation({
    onSuccess: () => {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      utils.swaps.list.invalidate();
      refetch();
    },
    onError: (error) => {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      const msg = error.message || "Erro ao cancelar a oferta";
      if (Platform.OS === "web") {
        window.alert(msg);
      } else {
        Alert.alert("Erro", msg);
      }
    },
  });

  const handleApprove = async (offer: any) => {
    const fromShiftSummary = offer.fromShift
      ? `${offer.fromShift.label} — ${formatDate(new Date(offer.fromShift.startAt))}`
      : "este plantão";
    const candidateName = offer.toProfessional?.name ?? "candidato";
    const confirmed = await confirmAction(
      `Aprovar candidatura?\n\n${candidateName} assumirá ${fromShiftSummary}.`,
    );
    if (!confirmed) return;
    approveMutation.mutate({ swapRequestId: offer.id });
  };

  const handleCancel = async (offer: any) => {
    const confirmed = await confirmAction(
      "Cancelar esta oferta?\n\nA solicitação será removida das suas ofertas em aberto.",
    );
    if (!confirmed) return;
    cancelMutation.mutate({ swapRequestId: offer.id });
  };

  const handleBack = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    router.back();
  };

  if (authLoading) {
    return (
      <ScreenGradient>
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator size="large" color={theme.colors.primary} />
        </View>
      </ScreenGradient>
    );
  }

  if (!user) {
    return (
      <ScreenGradient>
        <View className="flex-1 items-center justify-center">
          <AlertCircle size={48} color={theme.colors.textMuted} />
          <Text className="mt-4 text-lg" style={{ color: theme.colors.textMuted }}>
            Faça login para ver suas ofertas
          </Text>
        </View>
      </ScreenGradient>
    );
  }

  // Cast defensivo enquanto o tipo do tRPC não infere awaitingMyApproval
  // de forma garantida em todos os clients (PR #64 acabou de pousar).
  const offers = ((data ?? []) as any[]).map((row) => ({
    ...row,
    awaitingMyApproval: !!row.awaitingMyApproval,
  }));

  const awaitingMyApproval = offers.filter((o) => o.awaitingMyApproval);
  const others = offers.filter((o) => !o.awaitingMyApproval);

  return (
    <ScreenGradient>
      <ScrollView contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 20, paddingBottom: 40 }}>
        {/* Header */}
        <View className="flex-row items-center gap-3 mb-6">
          <TouchableOpacity onPress={handleBack} activeOpacity={0.7} accessibilityRole="button" accessibilityLabel="Voltar">
            <ChevronLeft size={28} color={theme.colors.textPrimary} />
          </TouchableOpacity>
          <Text className="text-3xl font-bold" style={{ color: theme.colors.textPrimary }}>
            Minhas ofertas
          </Text>
        </View>

        {isLoading ? (
          <View className="items-center py-20">
            <ActivityIndicator size="large" color={theme.colors.primary} />
            <Text className="mt-4 text-base" style={{ color: theme.colors.textMuted }}>
              Carregando ofertas...
            </Text>
          </View>
        ) : offers.length === 0 ? (
          <View className="items-center justify-center py-20">
            <Inbox size={64} color={theme.colors.textMuted} />
            <Text className="mt-4 text-lg font-semibold text-center" style={{ color: theme.colors.textPrimary }}>
              Nenhuma oferta sua no momento
            </Text>
            <Text className="mt-2 text-sm text-center px-6" style={{ color: theme.colors.textMuted }}>
              Crie uma cessão ou troca a partir de um plantão seu para começar.
            </Text>
          </View>
        ) : (
          <View className="gap-6">
            {awaitingMyApproval.length > 0 && (
              <View className="gap-3">
                <Text className="text-lg font-semibold" style={{ color: theme.colors.textPrimary }}>
                  Aguardando sua aprovação
                </Text>
                {awaitingMyApproval.map((offer) => (
                  <OfferCard
                    key={offer.id}
                    offer={offer}
                    highlighted
                    onApprove={() => handleApprove(offer)}
                    onCancel={null}
                    isApproving={approveMutation.isPending}
                  />
                ))}
              </View>
            )}

            {others.length > 0 && (
              <View className="gap-3">
                <Text className="text-lg font-semibold" style={{ color: theme.colors.textPrimary }}>
                  Em andamento
                </Text>
                {others.map((offer) => (
                  <OfferCard
                    key={offer.id}
                    offer={offer}
                    highlighted={false}
                    onApprove={null}
                    onCancel={offer.status === "PENDING" ? () => handleCancel(offer) : null}
                    isApproving={false}
                  />
                ))}
              </View>
            )}
          </View>
        )}
      </ScrollView>
    </ScreenGradient>
  );
}

function OfferCard({
  offer,
  highlighted,
  onApprove,
  onCancel,
  isApproving,
}: {
  offer: any;
  highlighted: boolean;
  onApprove: (() => void) | null;
  onCancel: (() => void) | null;
  isApproving: boolean;
}) {
  const type = (offer.type ?? "TRANSFER") as SwapType;
  const status = (offer.status ?? "PENDING") as SwapStatus;
  const fromStart = offer.fromShift?.startAt ? new Date(offer.fromShift.startAt) : null;
  const fromEnd = offer.fromShift?.endAt ? new Date(offer.fromShift.endAt) : null;
  const toStart = offer.toShift?.startAt ? new Date(offer.toShift.startAt) : null;
  const toEnd = offer.toShift?.endAt ? new Date(offer.toShift.endAt) : null;
  const expiresAt = offer.expiresAt ? new Date(offer.expiresAt) : null;
  const candidateName = offer.toProfessional?.name as string | undefined;

  return (
    <View
      className="rounded-2xl border p-4 gap-3"
      style={{
        backgroundColor: highlighted ? "rgba(37,99,235,0.08)" : "#FFFFFF",
        borderColor: highlighted ? theme.colors.primary : theme.colors.border,
      }}
    >
      {/* Cabeçalho: tipo + status */}
      <View className="flex-row items-center justify-between">
        <View
          className="rounded-full px-3 py-1"
          style={{ backgroundColor: "rgba(37,99,235,0.12)" }}
        >
          <Text className="text-xs font-semibold" style={{ color: theme.colors.primary }}>
            {TYPE_LABEL[type] ?? type}
          </Text>
        </View>
        <Text className="text-xs" style={{ color: theme.colors.textMuted }}>
          {STATUS_LABEL[status] ?? status}
        </Text>
      </View>

      {/* Plantão de origem */}
      {offer.fromShift && (
        <View>
          <Text className="text-base font-semibold" style={{ color: theme.colors.textPrimary }}>
            {offer.fromShift.label}
          </Text>
          <Text className="text-sm" style={{ color: theme.colors.textSecondary }}>
            {fromStart ? formatDate(fromStart) : "—"}
            {fromStart && fromEnd ? ` · ${formatTimeRange(fromStart, fromEnd)}` : ""}
          </Text>
          {offer.fromShift.hospitalName || offer.fromShift.sectorName ? (
            <Text className="text-xs mt-1" style={{ color: theme.colors.textMuted }}>
              {[offer.fromShift.hospitalName, offer.fromShift.sectorName].filter(Boolean).join(" · ")}
            </Text>
          ) : null}
        </View>
      )}

      {/* SWAP: shift desejado */}
      {type === "SWAP" && offer.toShift && (
        <View
          className="rounded-xl p-3"
          style={{ backgroundColor: theme.colors.surfaceAlt, borderWidth: 1, borderColor: theme.colors.border }}
        >
          <Text className="text-xs mb-1" style={{ color: theme.colors.textMuted }}>↔ Em troca de</Text>
          <Text className="text-base font-semibold" style={{ color: theme.colors.textPrimary }}>
            {offer.toShift.label}
          </Text>
          <Text className="text-sm" style={{ color: theme.colors.textSecondary }}>
            {toStart ? formatDate(toStart) : "—"}
            {toStart && toEnd ? ` · ${formatTimeRange(toStart, toEnd)}` : ""}
          </Text>
        </View>
      )}

      {/* Candidato (quando alguém já aceitou) */}
      {candidateName && (
        <View className="flex-row items-center gap-2">
          <Text className="text-sm" style={{ color: theme.colors.textMuted }}>
            Candidato:
          </Text>
          <Text className="text-sm font-semibold" style={{ color: theme.colors.textPrimary }}>
            {candidateName}
          </Text>
        </View>
      )}

      {/* Expira em */}
      {expiresAt && status === "PENDING" && (
        <View className="flex-row items-center gap-1">
          <Clock size={14} color={theme.colors.textMuted} />
          <Text className="text-xs" style={{ color: theme.colors.textMuted }}>
            Expira em {formatDate(expiresAt)}
          </Text>
        </View>
      )}

      {/* CTA de aprovação (só quando awaitingMyApproval) */}
      {onApprove && (
        <TouchableOpacity
          onPress={onApprove}
          disabled={isApproving}
          activeOpacity={0.8}
          accessibilityRole="button"
          accessibilityLabel="Aprovar candidatura"
          className="rounded-xl py-3 items-center justify-center mt-2"
          style={{ backgroundColor: theme.colors.primary, opacity: isApproving ? 0.6 : 1 }}
        >
          {isApproving ? (
            <ActivityIndicator color="#FFFFFF" />
          ) : (
            <Text className="text-base font-semibold" style={{ color: "#FFFFFF" }}>
              Aprovar candidatura
            </Text>
          )}
        </TouchableOpacity>
      )}

      {/* Cancelar (só PENDING, sem candidato ainda) */}
      {onCancel && (
        <TouchableOpacity
          onPress={onCancel}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel="Cancelar oferta"
          className="rounded-xl py-2 items-center justify-center"
          style={{ borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surfaceAlt }}
        >
          <Text className="text-sm font-medium" style={{ color: theme.colors.textSecondary }}>
            Cancelar oferta
          </Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

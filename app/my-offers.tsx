import { Text, View, TouchableOpacity, ActivityIndicator, ScrollView } from "react-native";
import { ScreenGradient } from "@/components/ui/ScreenGradient";
import { QueryErrorState } from "@/components/ui/QueryErrorState";
import { theme } from "@/lib/theme";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/hooks/use-auth";
import { useRouter } from "expo-router";
import * as Haptics from "expo-haptics";
import { ChevronLeft, Inbox, Clock, AlertCircle } from "lucide-react-native";
import { confirmAction } from "@/lib/ui/confirm";
import { useActionFeedback } from "@/hooks/use-action-feedback";
import { formatHospitalTimeRange } from "@/lib/hospital-time";

/**
 * Tela "Minhas ofertas" — consome `swaps.list({ role: "OFFERER" })`.
 * Quem assume transfere o plantão no aceite; o dono acompanha e pode
 * concluir ou cancelar uma candidatura antiga em ACCEPTED. A conclusão é
 * sempre uma mutation explícita do dono, nunca um efeito da consulta.
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
  PENDING: "Aguardando quem assuma",
  ACCEPTED: "Aguardando sua conclusão",
  APPROVED: "Assumida",
  REJECTED_BY_PEER: "Recusada pelo profissional",
  REJECTED_BY_MANAGER: "Recusada pelo gestor",
  CANCELLED: "Cancelada",
  EXPIRED: "Expirada",
};

function formatDate(d: Date): string {
  return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "short", year: "numeric" });
}

function formatTimeRange(start: Date, end: Date): string {
  return formatHospitalTimeRange(start, end);
}

export default function MyOffersScreen() {
  const { user, isLoading: authLoading } = useAuth();
  const router = useRouter();

  // Filtro role=OFFERER (PR #64): só ofertas onde sou o ofertante.
  const { data, isLoading, isError, refetch } = trpc.swaps.list.useQuery(
    { role: "OFFERER" },
    { enabled: !!user?.id },
  );

  const utils = trpc.useUtils();
  const feedback = useActionFeedback();

  const cancelMutation = trpc.swaps.cancel.useMutation({
    onSuccess: () => {
      utils.swaps.list.invalidate();
      refetch();
      feedback.success("Oferta cancelada.");
    },
    onError: (error) => {
      feedback.error(error.message || "Não foi possível cancelar a oferta.");
    },
  });

  const approveMutation = trpc.swaps.approveByOwner.useMutation({
    onSuccess: async () => {
      await Promise.all([
        utils.swaps.list.invalidate(),
        utils.swaps.listAvailable.invalidate(),
        utils.swaps.countActionable.invalidate(),
        utils.shifts.listAgenda.invalidate(),
        utils.shifts.getNextShift.invalidate(),
        utils.shifts.listByPeriod.invalidate(),
        utils.shifts.get.invalidate(),
        utils.confirmations.getPending.invalidate(),
      ]);
      await refetch();
      feedback.success("Candidatura concluída. A escala foi atualizada.");
    },
    onError: (error) => {
      feedback.error(
        error.message || "Não foi possível concluir a candidatura.",
      );
    },
  });

  const handleCancel = async (offer: any) => {
    const leftover = offer.status === "ACCEPTED";
    const confirmed = await confirmAction(
      leftover
        ? "Desfazer esta candidatura antiga?\n\nO plantão continua com você e a solicitação deixa de ficar presa."
        : "Cancelar esta oferta?\n\nA solicitação será removida das suas ofertas em aberto.",
    );
    if (!confirmed) return;
    cancelMutation.mutate({ swapRequestId: offer.id });
  };

  const handleApprove = async (offer: any) => {
    const confirmed = await confirmAction(
      "Concluir esta candidatura antiga?\n\nO plantão será transferido para o profissional indicado.",
    );
    if (!confirmed) return;
    approveMutation.mutate({ swapRequestId: offer.id });
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

  const offers = (data ?? []) as any[];
  const openOffers = offers.filter(
    (o) => o.status === "PENDING" || o.status === "ACCEPTED",
  );
  const history = offers.filter(
    (o) => o.status !== "PENDING" && o.status !== "ACCEPTED",
  );

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
        ) : isError ? (
          <QueryErrorState
            title="Não foi possível carregar as ofertas"
            onRetry={() => refetch()}
          />
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
            {openOffers.length > 0 && (
              <View className="gap-3">
                <Text className="text-lg font-semibold" style={{ color: theme.colors.textPrimary }}>
                  Em andamento
                </Text>
                {openOffers.map((offer) => (
                  <OfferCard
                    key={offer.id}
                    offer={offer}
                    onCancel={
                      offer.canCancel !== false
                        ? () => handleCancel(offer)
                        : null
                    }
                    onApprove={
                      offer.awaitingMyApproval === true
                        ? () => handleApprove(offer)
                        : null
                    }
                  />
                ))}
              </View>
            )}

            {history.length > 0 && (
              <View className="gap-3">
                <Text className="text-lg font-semibold" style={{ color: theme.colors.textPrimary }}>
                  Histórico
                </Text>
                {history.map((offer) => (
                  <OfferCard
                    key={offer.id}
                    offer={offer}
                    onCancel={null}
                    onApprove={null}
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
  onCancel,
  onApprove,
}: {
  offer: any;
  onCancel: (() => void) | null;
  onApprove: (() => void) | null;
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
        backgroundColor: theme.colors.surface,
        borderColor: theme.colors.border,
      }}
    >
      {/* Cabeçalho: tipo + status */}
      <View className="flex-row items-center justify-between">
        <View
          className="rounded-full px-3 py-1"
          style={{ backgroundColor: theme.colors.primarySoft }}
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
          <Text className="text-xs mb-1" style={{ color: theme.colors.textSecondary }}>↔ Em troca de</Text>
          <Text className="text-base font-semibold" style={{ color: theme.colors.textPrimary }}>
            {offer.toShift.label}
          </Text>
          <Text className="text-sm" style={{ color: theme.colors.textSecondary }}>
            {toStart ? formatDate(toStart) : "—"}
            {toStart && toEnd ? ` · ${formatTimeRange(toStart, toEnd)}` : ""}
          </Text>
        </View>
      )}

      {candidateName && (
        <View className="flex-row items-center gap-2">
          <Text className="text-sm" style={{ color: theme.colors.textMuted }}>
            {status === "APPROVED" ? "Assumido por:" : "Profissional:"}
          </Text>
          <Text className="text-sm font-semibold" style={{ color: theme.colors.textPrimary }}>
            {candidateName}
          </Text>
        </View>
      )}

      {offer.reviewNote ? (
        <Text className="text-xs" style={{ color: theme.colors.textSecondary }}>
          {offer.reviewNote}
        </Text>
      ) : null}

      {/* Expira em */}
      {expiresAt && status === "PENDING" && (
        <View className="flex-row items-center gap-1">
          <Clock size={14} color={theme.colors.textMuted} />
          <Text className="text-xs" style={{ color: theme.colors.textMuted }}>
            Expira em {formatDate(expiresAt)}
          </Text>
        </View>
      )}

      {onApprove && (
        <TouchableOpacity
          onPress={onApprove}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel="Concluir candidatura antiga"
          className="rounded-xl py-2 items-center justify-center"
          style={{ backgroundColor: theme.colors.primary }}
        >
          <Text className="text-sm font-medium" style={{ color: theme.colors.onDark.text }}>
            Concluir candidatura
          </Text>
        </TouchableOpacity>
      )}

      {/* Cancelar PENDING ou ACCEPTED residual que não completou */}
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
            {status === "ACCEPTED" ? "Desfazer candidatura" : "Cancelar oferta"}
          </Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

import { Text, View, TouchableOpacity, ActivityIndicator, ScrollView } from "react-native";
import { ScreenGradient } from "@/components/ui/ScreenGradient";
import { theme } from "@/lib/theme";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/hooks/use-auth";
import { useRouter } from "expo-router";
import * as Haptics from "expo-haptics";
import { ChevronLeft, Inbox, Clock, AlertCircle } from "lucide-react-native";

/**
 * Tela "Suas candidaturas" — RECEIVER counterpart de /my-offers.
 *
 * Lista swaps onde o usuário logado se candidatou (to_user_id = me).
 * É passiva por design: per spec docs/product/escala-ux.md §6, depois
 * que B aceita, só A (o dono) aprova ou rejeita. B não retracta.
 *
 * Fluxo do usuário:
 *   - Acessa via Perfil → "Suas candidaturas".
 *   - "Aguardando aprovação do dono": status=ACCEPTED, esperando A.
 *   - "Histórico recente": APPROVED (entrou no plantão), EXPIRED, etc.
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
  ACCEPTED: "Aguardando aprovação do dono",
  APPROVED: "Aprovada — você assumiu o plantão",
  REJECTED_BY_PEER: "Recusada",
  REJECTED_BY_MANAGER: "Recusada pelo gestor",
  CANCELLED: "Cancelada pelo ofertante",
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

export default function MyApplicationsScreen() {
  const { user, isLoading: authLoading } = useAuth();
  const router = useRouter();

  const { data, isLoading } = trpc.swaps.list.useQuery(
    { role: "RECEIVER" },
    { enabled: !!user?.id },
  );

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
            Faça login para ver suas candidaturas
          </Text>
        </View>
      </ScreenGradient>
    );
  }

  const applications = (data ?? []) as any[];
  const awaitingOwner = applications.filter((a) => a.status === "ACCEPTED");
  const others = applications.filter((a) => a.status !== "ACCEPTED");

  return (
    <ScreenGradient>
      <ScrollView contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 20, paddingBottom: 40 }}>
        {/* Header */}
        <View className="flex-row items-center gap-3 mb-6">
          <TouchableOpacity
            onPress={handleBack}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel="Voltar"
          >
            <ChevronLeft size={28} color={theme.colors.textPrimary} />
          </TouchableOpacity>
          <Text className="text-3xl font-bold" style={{ color: theme.colors.textPrimary }}>
            Suas candidaturas
          </Text>
        </View>

        {isLoading ? (
          <View className="items-center py-20">
            <ActivityIndicator size="large" color={theme.colors.primary} />
            <Text className="mt-4 text-base" style={{ color: theme.colors.textMuted }}>
              Carregando candidaturas...
            </Text>
          </View>
        ) : applications.length === 0 ? (
          <View className="items-center justify-center py-20">
            <Inbox size={64} color={theme.colors.textMuted} />
            <Text
              className="mt-4 text-lg font-semibold text-center"
              style={{ color: theme.colors.textPrimary }}
            >
              Você ainda não se candidatou a nenhuma cessão
            </Text>
            <Text className="mt-2 text-sm text-center px-6" style={{ color: theme.colors.textMuted }}>
              Veja as ofertas em &ldquo;Solicitações&rdquo; e candidate-se ao plantão que quiser assumir.
            </Text>
          </View>
        ) : (
          <View className="gap-6">
            {awaitingOwner.length > 0 && (
              <View className="gap-3">
                <Text className="text-lg font-semibold" style={{ color: theme.colors.textPrimary }}>
                  Aguardando aprovação do dono
                </Text>
                {awaitingOwner.map((a) => (
                  <ApplicationCard key={a.id} application={a} highlighted />
                ))}
              </View>
            )}

            {others.length > 0 && (
              <View className="gap-3">
                <Text className="text-lg font-semibold" style={{ color: theme.colors.textPrimary }}>
                  Histórico recente
                </Text>
                {others.map((a) => (
                  <ApplicationCard key={a.id} application={a} highlighted={false} />
                ))}
              </View>
            )}
          </View>
        )}
      </ScrollView>
    </ScreenGradient>
  );
}

function ApplicationCard({
  application,
  highlighted,
}: {
  application: any;
  highlighted: boolean;
}) {
  const type = (application.type ?? "TRANSFER") as SwapType;
  const status = (application.status ?? "PENDING") as SwapStatus;
  const fromStart = application.fromShift?.startAt ? new Date(application.fromShift.startAt) : null;
  const fromEnd = application.fromShift?.endAt ? new Date(application.fromShift.endAt) : null;
  const toStart = application.toShift?.startAt ? new Date(application.toShift.startAt) : null;
  const toEnd = application.toShift?.endAt ? new Date(application.toShift.endAt) : null;
  const expiresAt = application.expiresAt ? new Date(application.expiresAt) : null;
  const offererName = application.fromProfessional?.name as string | undefined;

  return (
    <View
      className="rounded-2xl border p-4 gap-3"
      style={{
        backgroundColor: highlighted ? theme.colors.primarySoft : theme.colors.surface,
        borderColor: highlighted ? theme.colors.primary : theme.colors.border,
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

      {/* Plantão de origem (que eu vou assumir se A aprovar) */}
      {application.fromShift && (
        <View>
          <Text className="text-base font-semibold" style={{ color: theme.colors.textPrimary }}>
            {application.fromShift.label}
          </Text>
          <Text className="text-sm" style={{ color: theme.colors.textSecondary }}>
            {fromStart ? formatDate(fromStart) : "—"}
            {fromStart && fromEnd ? ` · ${formatTimeRange(fromStart, fromEnd)}` : ""}
          </Text>
          {application.fromShift.hospitalName || application.fromShift.sectorName ? (
            <Text className="text-xs mt-1" style={{ color: theme.colors.textMuted }}>
              {[application.fromShift.hospitalName, application.fromShift.sectorName]
                .filter(Boolean)
                .join(" · ")}
            </Text>
          ) : null}
        </View>
      )}

      {/* SWAP: shift que eu vou ceder em troca */}
      {type === "SWAP" && application.toShift && (
        <View
          className="rounded-xl p-3"
          style={{
            backgroundColor: theme.colors.surfaceAlt,
            borderWidth: 1,
            borderColor: theme.colors.border,
          }}
        >
          <Text className="text-xs mb-1" style={{ color: theme.colors.textMuted }}>
            ↔ Você cede
          </Text>
          <Text className="text-base font-semibold" style={{ color: theme.colors.textPrimary }}>
            {application.toShift.label}
          </Text>
          <Text className="text-sm" style={{ color: theme.colors.textSecondary }}>
            {toStart ? formatDate(toStart) : "—"}
            {toStart && toEnd ? ` · ${formatTimeRange(toStart, toEnd)}` : ""}
          </Text>
        </View>
      )}

      {/* Ofertante (quem propôs a cessão) */}
      {offererName && (
        <View className="flex-row items-center gap-2">
          <Text className="text-sm" style={{ color: theme.colors.textMuted }}>
            Ofertado por:
          </Text>
          <Text className="text-sm font-semibold" style={{ color: theme.colors.textPrimary }}>
            {offererName}
          </Text>
        </View>
      )}

      {/* Expira em (apenas enquanto aguardando) */}
      {expiresAt && status === "ACCEPTED" && (
        <View className="flex-row items-center gap-1">
          <Clock size={14} color={theme.colors.textMuted} />
          <Text className="text-xs" style={{ color: theme.colors.textMuted }}>
            Expira em {formatDate(expiresAt)}
          </Text>
        </View>
      )}

      {/* Aviso explicativo no card destacado */}
      {highlighted && (
        <Text className="text-xs italic" style={{ color: theme.colors.textMuted }}>
          O ofertante precisa aprovar sua candidatura para a cessão se efetivar.
        </Text>
      )}
    </View>
  );
}

// components/swaps/AvailableSwapsList.tsx — ofertas de troca/repasse que
// o usuário pode aceitar. Usado na aba Trocas (médico) e em Solicitações
// (gestor) — antes vivia inline em pending.tsx, invisível para o médico.
//
// Aceitar/recusar muda a escala de duas pessoas: sempre confirma antes,
// em web e nativo; resultado vira toast (use-action-feedback).

import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { ArrowRightLeft, Check, X } from "lucide-react-native";
import { trpc } from "@/lib/trpc";
import { theme } from "@/lib/theme";
import { useAuth } from "@/hooks/use-auth";
import { useActionFeedback } from "@/hooks/use-action-feedback";
import { QueryErrorState } from "@/components/ui/QueryErrorState";
import { formatHospitalTimeRange } from "@/lib/hospital-time";
import { listedSwapIsActionable } from "@/lib/swap-offer-actions";
import { resolveOperationalListState } from "@/lib/operational-screen-state";

export interface AvailableSwap {
  id: number;
  type: "SWAP" | "TRANSFER" | "CESSAO";
  reason: string | null;
  expiresAt: Date | string | null;
  createdAt: Date | string;
  fromProfessional: { name: string; role: string };
  fromShift: {
    id: number;
    label: string;
    startAt: Date | string;
    endAt: Date | string;
    hospitalName: string;
    sectorName: string;
  };
  toShift: {
    id: number;
    label: string;
    startAt: Date | string;
    endAt: Date | string;
    hospitalName: string;
    sectorName: string;
  } | null;
  toProfessionalId?: number | null;
  toUserId?: number | null;
  canRespond?: boolean;
}

interface Props {
  /** Mostra um estado vazio em vez de sumir quando não há ofertas. */
  showEmpty?: boolean;
  title?: string;
  showHeader?: boolean;
  /** Publica somente contagens confirmadas, nunca cache stale em erro. */
  onCountChange?: (count: number) => void;
}

const fmtDate = (value: Date | string) =>
  new Date(value).toLocaleDateString("pt-BR", { weekday: "short", day: "2-digit", month: "short" });

const fmtTime = (s: Date | string, e: Date | string) => formatHospitalTimeRange(s, e);

export function AvailableSwapsList({
  showEmpty = false,
  title = "Trocas disponíveis",
  showHeader = true,
  onCountChange,
}: Props) {
  const { user } = useAuth();
  const utils = trpc.useUtils();
  const feedback = useActionFeedback();
  const [acting, setActing] = useState<{ id: number; action: "accept" | "reject" } | null>(null);

  const {
    data,
    isLoading,
    isPending,
    isError,
    error,
    refetch,
  } = trpc.swaps.listAvailable.useQuery(
    {},
    { enabled: !!user?.id },
  );
  const swaps = (data ?? []) as AvailableSwap[];
  const actionableSwapCount = swaps.filter(listedSwapIsActionable).length;
  const contentState = resolveOperationalListState({
    isLoading,
    isPending,
    isError,
    hasResolvedData: data !== undefined,
    itemCount: swaps.length,
    error,
  });

  useEffect(() => {
    if (contentState === "READY" || contentState === "EMPTY") {
      onCountChange?.(actionableSwapCount);
    }
  }, [actionableSwapCount, contentState, onCountChange]);

  const invalidateSwapQueries = () =>
    Promise.all([
      utils.swaps.listAvailable.invalidate(),
      utils.swaps.countActionable.invalidate(),
      utils.swaps.list.invalidate(),
    ]);
  const invalidateAcceptedSwapQueries = () =>
    Promise.all([
      invalidateSwapQueries(),
      utils.shifts.listAgenda.invalidate(),
      utils.shifts.getNextShift.invalidate(),
      utils.shifts.listByPeriod.invalidate(),
      utils.shifts.get.invalidate(),
      utils.confirmations.getPending.invalidate(),
    ]);

  const acceptSwap = trpc.swaps.accept.useMutation({
    onSuccess: async () => {
      feedback.success("Plantão assumido. A escala já foi atualizada.");
      await invalidateAcceptedSwapQueries();
    },
    onError: (error) => feedback.error(error.message || "Não foi possível aceitar a oferta."),
    onSettled: () => setActing(null),
  });
  const rejectSwap = trpc.swaps.reject.useMutation({
    onSuccess: async () => {
      feedback.success("Oferta recusada.");
      await invalidateSwapQueries();
    },
    onError: (error) => feedback.error(error.message || "Não foi possível recusar a oferta."),
    onSettled: () => setActing(null),
  });
  const busy = acceptSwap.isPending || rejectSwap.isPending;

  async function handle(swap: AvailableSwap, action: "accept" | "reject") {
    if (busy) return;
    const isSwap = swap.type === "SWAP";
    const confirmed = await feedback.confirmDestructive(
      action === "accept" ? "Aceitar esta oferta?" : "Recusar esta oferta?",
      action === "accept"
        ? isSwap
          ? `Você fica com o plantão de ${swap.fromProfessional.name} e ele fica com o seu.`
          : `Você assume o plantão de ${swap.fromProfessional.name} agora.`
        : "A oferta some da sua lista.",
      action === "accept" ? "Aceitar" : "Recusar",
    );
    if (!confirmed) return;
    setActing({ id: swap.id, action });
    const input = { swapRequestId: swap.id };
    if (action === "accept") acceptSwap.mutate(input);
    else rejectSwap.mutate(input);
  }

  // Dados já confirmados continuam disponíveis em refresh falho; zero stale
  // nunca vira "Nenhuma oferta" sem uma consulta atual bem-sucedida.
  if (contentState === "ERROR") {
    return (
      <QueryErrorState
        title="Não foi possível carregar as ofertas"
        error={error}
        onRetry={() => refetch()}
      />
    );
  }
  if (contentState === "LOADING") {
    return (
      <View style={{ paddingVertical: theme.space[6], alignItems: "center" }}>
        <ActivityIndicator color={theme.colors.primary} />
      </View>
    );
  }
  if (contentState === "UNRESOLVED") {
    return (
      <QueryErrorState
        title="Ainda estamos aguardando as ofertas"
        description="A lista ainda não foi confirmada pelo sistema. Tente novamente para atualizar."
        onRetry={() => refetch()}
      />
    );
  }
  if (contentState === "EMPTY") {
    if (!showEmpty) return null;
    return (
      <View
        style={{
          paddingVertical: theme.space[8],
          paddingHorizontal: theme.space[4],
          alignItems: "center",
          gap: theme.space[2],
          backgroundColor: theme.colors.surfaceAlt,
          borderRadius: theme.radius.lg,
        }}
      >
        <ArrowRightLeft size={28} color={theme.colors.textMuted} />
        <Text style={{ ...theme.text.bodyLg, fontWeight: theme.weight.semibold, color: theme.colors.textPrimary }}>
          Nenhuma oferta no momento
        </Text>
        <Text style={{ ...theme.text.body, color: theme.colors.textMuted, textAlign: "center" }}>
          Quando um colega oferecer um plantão que você pode assumir, ele aparece aqui.
        </Text>
      </View>
    );
  }

  return (
    <View style={{ gap: theme.space[3] }}>
      {showHeader ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: theme.space[2] }}>
          <ArrowRightLeft size={22} color={theme.colors.brand} />
          <Text style={{ ...theme.text.titleLg, fontWeight: theme.weight.bold, color: theme.colors.textPrimary }}>
            {title}
          </Text>
          <View
            style={{
              backgroundColor: theme.colors.brand,
              borderRadius: theme.radius.full,
              minWidth: theme.space[6],
              height: theme.space[6],
              alignItems: "center",
              justifyContent: "center",
              paddingHorizontal: theme.space[2],
            }}
          >
            <Text style={{ ...theme.text.caption, fontWeight: theme.weight.bold, color: theme.colors.onDark.text }}>
              {actionableSwapCount}
            </Text>
          </View>
        </View>
      ) : null}

      {swaps.map((sw) => {
        const isSwap = sw.type === "SWAP";
        const mine = acting?.id === sw.id;
        return (
          <View
            key={sw.id}
            style={{
              backgroundColor: theme.colors.surface,
              borderRadius: theme.radius.lg,
              borderWidth: 1,
              borderColor: theme.colors.borderStrong,
              borderLeftWidth: 4,
              borderLeftColor: theme.colors.brand,
              padding: theme.space[4],
              gap: theme.space[2],
              ...theme.shadow.sm,
            }}
          >
            <View style={{ flexDirection: "row", alignItems: "center", gap: theme.space[2] }}>
              <View
                style={{
                  paddingHorizontal: theme.space[2],
                  height: theme.space[5],
                  justifyContent: "center",
                  borderRadius: theme.radius.full,
                  backgroundColor: theme.colors.surfaceAlt,
                  borderWidth: 1,
                  borderColor: theme.colors.borderStrong,
                }}
              >
                <Text
                  style={{
                    ...theme.text.caption,
                    fontWeight: theme.weight.semibold,
                    color: theme.colors.textSecondary,
                  }}
                >
                  {isSwap ? "Troca" : "Repasse"}
                </Text>
              </View>
              <Text style={{ ...theme.text.body, fontWeight: theme.weight.semibold, color: theme.colors.textPrimary, flex: 1 }} numberOfLines={1}>
                {sw.fromProfessional.name}
                <Text style={{ color: theme.colors.textSecondary, fontWeight: theme.weight.regular }}>
                  {" "}· {sw.fromProfessional.role}
                </Text>
              </Text>
            </View>

            <Text style={{ ...theme.text.body, color: theme.colors.textPrimary }}>
              {sw.fromShift.label} — {fmtDate(sw.fromShift.startAt)} · {fmtTime(sw.fromShift.startAt, sw.fromShift.endAt)}
            </Text>
            <Text style={{ ...theme.text.caption, color: theme.colors.textMuted }}>
              {sw.fromShift.hospitalName} / {sw.fromShift.sectorName}
            </Text>

            {sw.toShift ? (
              <View style={{ paddingLeft: theme.space[3], borderLeftWidth: 2, borderLeftColor: theme.colors.warning, gap: theme.space[1] }}>
                <Text style={{ ...theme.text.caption, color: theme.colors.textSecondary }}>Quer em troca:</Text>
                <Text style={{ ...theme.text.body, color: theme.colors.textPrimary }}>
                  {sw.toShift.label} — {fmtDate(sw.toShift.startAt)} · {fmtTime(sw.toShift.startAt, sw.toShift.endAt)}
                </Text>
              </View>
            ) : null}

            {sw.reason ? (
              <Text style={{ ...theme.text.caption, color: theme.colors.textSecondary, fontStyle: "italic" }}>
                {`"${sw.reason}"`}
              </Text>
            ) : null}

            {!listedSwapIsActionable(sw) ? (
              <Text style={{ ...theme.text.caption, color: theme.colors.textSecondary }}>
                Oferta direcionada a outro profissional. Aguardando a resposta.
              </Text>
            ) : (
              <View style={{ flexDirection: "row", gap: theme.space[3], marginTop: theme.space[1] }}>
                <ActionButton
                  label="Aceitar"
                  icon={<Check size={18} color={theme.colors.onDark.text} />}
                  tone="primary"
                  loading={mine && acting?.action === "accept"}
                  disabled={busy}
                  onPress={() => handle(sw, "accept")}
                />
                <ActionButton
                  label="Recusar"
                  icon={<X size={18} color={theme.colors.textPrimary} />}
                  tone="neutral"
                  loading={mine && acting?.action === "reject"}
                  disabled={busy}
                  onPress={() => handle(sw, "reject")}
                />
              </View>
            )}
          </View>
        );
      })}
    </View>
  );
}

function ActionButton({
  label,
  icon,
  tone,
  loading,
  disabled,
  onPress,
}: {
  label: string;
  icon: React.ReactNode;
  tone: "primary" | "neutral";
  loading: boolean;
  disabled: boolean;
  onPress: () => void;
}) {
  const isPrimary = tone === "primary";
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled, busy: loading }}
      style={({ pressed }) => ({
        flex: 1,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: theme.space[2],
        minHeight: theme.space[10] + theme.space[1],
        borderRadius: theme.radius.md,
        backgroundColor: isPrimary ? theme.colors.brand : theme.colors.surface,
        borderWidth: 1,
        borderColor: isPrimary ? theme.colors.brand : theme.colors.borderStrong,
        opacity: disabled ? 0.6 : pressed ? 0.85 : 1,
      })}
    >
      {loading ? (
        <ActivityIndicator size="small" color={isPrimary ? theme.colors.onDark.text : theme.colors.textPrimary} />
      ) : (
        <>
          {icon}
          <Text
            style={{
              ...theme.text.body,
              fontWeight: theme.weight.semibold,
              color: isPrimary ? theme.colors.onDark.text : theme.colors.textPrimary,
            }}
          >
            {label}
          </Text>
        </>
      )}
    </Pressable>
  );
}

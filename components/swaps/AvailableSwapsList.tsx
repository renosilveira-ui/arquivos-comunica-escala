// components/swaps/AvailableSwapsList.tsx — ofertas de troca/repasse que
// o usuário pode aceitar. Usado na aba Trocas (médico) e em Solicitações
// (gestor) — antes vivia inline em pending.tsx, invisível para o médico.
//
// Aceitar/recusar muda a escala de duas pessoas: sempre confirma antes,
// em web e nativo; resultado vira toast (use-action-feedback).

import { useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { ArrowRightLeft, Check, X } from "lucide-react-native";
import { trpc } from "@/lib/trpc";
import { theme } from "@/lib/theme";
import { useAuth } from "@/hooks/use-auth";
import { useActionFeedback } from "@/hooks/use-action-feedback";
import { QueryErrorState } from "@/components/ui/QueryErrorState";
import { formatHospitalTimeRange } from "@/lib/hospital-time";

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
  canRespond?: boolean;
}

interface Props {
  /** Mostra um estado vazio em vez de sumir quando não há ofertas. */
  showEmpty?: boolean;
  title?: string;
}

const fmtDate = (value: Date | string) =>
  new Date(value).toLocaleDateString("pt-BR", { weekday: "short", day: "2-digit", month: "short" });

const fmtTime = (s: Date | string, e: Date | string) => formatHospitalTimeRange(s, e);

export function AvailableSwapsList({ showEmpty = false, title = "Trocas disponíveis" }: Props) {
  const { user } = useAuth();
  const utils = trpc.useUtils();
  const feedback = useActionFeedback();
  const [acting, setActing] = useState<{ id: number; action: "accept" | "reject" } | null>(null);

  const { data, isLoading, isError, refetch } = trpc.swaps.listAvailable.useQuery(
    {},
    { enabled: !!user?.id },
  );
  const swaps = (data ?? []) as AvailableSwap[];

  const invalidate = () =>
    Promise.all([utils.swaps.listAvailable.invalidate(), utils.swaps.list.invalidate()]);

  const acceptSwap = trpc.swaps.accept.useMutation({
    onSuccess: async () => {
      await invalidate();
      feedback.success("Oferta aceita. O dono do plantão ainda precisa aprovar.");
    },
    onError: (error) => feedback.error(error.message || "Não foi possível aceitar a oferta."),
    onSettled: () => setActing(null),
  });
  const rejectSwap = trpc.swaps.reject.useMutation({
    onSuccess: async () => {
      await invalidate();
      feedback.success("Oferta recusada.");
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
          ? `Você fica com o plantão de ${swap.fromProfessional.name} e ele fica com o seu, assim que ele aprovar.`
          : `Você assume o plantão de ${swap.fromProfessional.name} assim que ele aprovar.`
        : "A oferta some da sua lista.",
      action === "accept" ? "Aceitar" : "Recusar",
    );
    if (!confirmed) return;
    setActing({ id: swap.id, action });
    const input = { swapRequestId: swap.id };
    if (action === "accept") acceptSwap.mutate(input);
    else rejectSwap.mutate(input);
  }

  // Erro com dados em cache (cold start do servidor) mantém a lista.
  if (isError && !data) {
    return <QueryErrorState title="Não foi possível carregar as ofertas" onRetry={() => refetch()} />;
  }
  if (isLoading) {
    return (
      <View style={{ paddingVertical: theme.space[6], alignItems: "center" }}>
        <ActivityIndicator color={theme.colors.primary} />
      </View>
    );
  }
  if (swaps.length === 0) {
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
      <View style={{ flexDirection: "row", alignItems: "center", gap: theme.space[2] }}>
        <ArrowRightLeft size={22} color={theme.colors.primary} />
        <Text style={{ ...theme.text.titleLg, fontWeight: theme.weight.bold, color: theme.colors.textPrimary }}>
          {title}
        </Text>
        <View
          style={{
            backgroundColor: theme.colors.primary,
            borderRadius: theme.radius.full,
            minWidth: theme.space[6],
            height: theme.space[6],
            alignItems: "center",
            justifyContent: "center",
            paddingHorizontal: theme.space[2],
          }}
        >
          <Text style={{ ...theme.text.caption, fontWeight: theme.weight.bold, color: theme.colors.onDark.text }}>
            {swaps.length}
          </Text>
        </View>
      </View>

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
              borderColor: theme.colors.border,
              padding: theme.space[4],
              gap: theme.space[2],
            }}
          >
            <View style={{ flexDirection: "row", alignItems: "center", gap: theme.space[2] }}>
              <View
                style={{
                  paddingHorizontal: theme.space[2],
                  height: theme.space[5],
                  justifyContent: "center",
                  borderRadius: theme.radius.full,
                  backgroundColor: isSwap ? theme.colors.primarySoft : theme.colors.warningSoft,
                }}
              >
                <Text
                  style={{
                    ...theme.text.caption,
                    fontWeight: theme.weight.semibold,
                    color: isSwap ? theme.palette.primary[700] : theme.palette.warning[700],
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

            {sw.canRespond === false ? (
              <Text style={{ ...theme.text.caption, color: theme.colors.textSecondary }}>
                Oferta direcionada a outro profissional. Aguardando a resposta.
              </Text>
            ) : (
              <View style={{ flexDirection: "row", gap: theme.space[3], marginTop: theme.space[1] }}>
                <ActionButton
                  label="Aceitar"
                  icon={<Check size={18} color={theme.colors.onDark.text} />}
                  tone="success"
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
  tone: "success" | "neutral";
  loading: boolean;
  disabled: boolean;
  onPress: () => void;
}) {
  const isSuccess = tone === "success";
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
        backgroundColor: isSuccess ? theme.colors.success : theme.colors.surface,
        borderWidth: isSuccess ? 0 : 1,
        borderColor: theme.colors.border,
        opacity: disabled ? 0.6 : pressed ? 0.85 : 1,
      })}
    >
      {loading ? (
        <ActivityIndicator size="small" color={isSuccess ? theme.colors.onDark.text : theme.colors.textPrimary} />
      ) : (
        <>
          {icon}
          <Text
            style={{
              ...theme.text.body,
              fontWeight: theme.weight.semibold,
              color: isSuccess ? theme.colors.onDark.text : theme.colors.textPrimary,
            }}
          >
            {label}
          </Text>
        </>
      )}
    </Pressable>
  );
}

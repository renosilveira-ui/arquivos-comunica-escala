import { View, Text, ScrollView, ActivityIndicator } from "react-native";
import { useMemo } from "react";
import { Calendar, AlertCircle, Clock, CheckCircle } from "lucide-react-native";
import { useAuth } from "@/hooks/use-auth";
import { trpc } from "@/lib/trpc";
import { theme } from "@/lib/theme";
import { QueryErrorState } from "@/components/ui/QueryErrorState";
import { formatDateBR } from "@/lib/datetime";
import { Surface } from "@/components/ui/Surface";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { SkeletonList } from "@/components/ui/Skeleton";
import { ShiftStatusBadge } from "@/components/ui/ShiftStatusBadge";

export default function DashboardScreen() {
  const { user, isLoading: authLoading } = useAuth();

  const todayISO = new Date().toISOString();
  const nextWeekISO = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  const { data: shiftsData, isLoading: shiftsLoading, isError: shiftsError, refetch: refetchShifts } = trpc.shifts.listByPeriod.useQuery(
    { startDate: todayISO, endDate: nextWeekISO },
    { enabled: !!user }
  );

  const shifts = useMemo(() => shiftsData ?? [], [shiftsData]);

  const stats = useMemo(() => ({
    total: shifts.length,
    vago: shifts.filter(s => s.status === "VAGO").length,
    pendente: shifts.filter(s => s.status === "PENDENTE").length,
    ocupado: shifts.filter(s => s.status === "OCUPADO").length,
  }), [shifts]);

  if (authLoading) {
    return (
      <View style={{ flex: 1, backgroundColor: theme.colors.background, justifyContent: "center", alignItems: "center" }}>
        <ActivityIndicator size="large" color={theme.colors.primary} />
      </View>
    );
  }

  const metricCards = [
    { label: "Total", value: stats.total, color: theme.colors.primary, icon: Calendar },
    { label: "Vagos", value: stats.vago, color: theme.colors.textSecondary, icon: AlertCircle },
    { label: "Pendentes", value: stats.pendente, color: theme.colors.statusPendente, icon: Clock },
    { label: "Ocupados", value: stats.ocupado, color: theme.colors.statusOcupado, icon: CheckCircle },
  ];

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: theme.spacing.screenPadding, paddingBottom: 32 }} showsVerticalScrollIndicator={false}>
        <SectionHeader size="page" title="Painel" subtitle="Resumo dos próximos 7 dias" style={{ marginBottom: theme.space[5] }} />

        {/* Métricas 2x2 */}
        {shiftsError ? (
          // Erro não pode virar métricas zeradas "reais" no dashboard.
          <QueryErrorState
            title="Não foi possível carregar o resumo da semana"
            onRetry={() => refetchShifts()}
          />
        ) : shiftsLoading ? (
          <SkeletonList count={2} />
        ) : (
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: theme.space[3] }}>
            {metricCards.map(card => {
              const Icon = card.icon;
              return (
                <Surface key={card.label} level="card" style={{ flex: 1, minWidth: "45%" }}>
                  <Icon size={20} color={card.color} />
                  <Text
                    style={{
                      ...theme.text.display,
                      fontWeight: theme.weight.bold,
                      color: theme.colors.textPrimary,
                      marginTop: theme.space[2],
                      fontVariant: ["tabular-nums"],
                    }}
                  >
                    {card.value}
                  </Text>
                  <Text style={{ ...theme.text.caption, color: theme.colors.textSecondary, marginTop: theme.space[1] }}>
                    {card.label}
                  </Text>
                </Surface>
              );
            })}
          </View>
        )}

        <SectionHeader
          title="Plantões da semana"
          subtitle={shiftsLoading ? undefined : `${Math.min(shifts.length, 20)} de ${shifts.length}`}
          style={{ marginTop: theme.space[6], marginBottom: theme.space[3] }}
        />

        {shiftsError ? null : shiftsLoading ? (
          <SkeletonList count={3} />
        ) : shifts.length > 0 ? (
          <View style={{ gap: theme.space[3] }}>
            {shifts.slice(0, 20).map(shift => (
              <Surface key={shift.id} level="card">
                <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: theme.space[2], marginBottom: theme.space[1] }}>
                  <Text style={{ flex: 1, ...theme.text.titleSm, fontWeight: theme.weight.semibold, color: theme.colors.textPrimary }} numberOfLines={1}>
                    {shift.label}
                  </Text>
                  <ShiftStatusBadge status={shift.status} context="listing" size="sm" />
                </View>
                <Text style={{ ...theme.text.body, color: theme.colors.textSecondary, fontVariant: ["tabular-nums"] }}>
                  {formatDateBR(shift.startAt)}{" · "}
                  {new Date(shift.startAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}
                  {" – "}
                  {new Date(shift.endAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}
                </Text>
              </Surface>
            ))}
          </View>
        ) : (
          <Surface level="card" tone="muted" style={{ alignItems: "center", gap: theme.space[2], paddingVertical: theme.space[6] }}>
            <Calendar size={28} color={theme.colors.textMuted} />
            <Text style={{ ...theme.text.body, color: theme.colors.textSecondary, textAlign: "center" }}>
              Nenhum plantão nos próximos 7 dias.
            </Text>
          </Surface>
        )}
      </ScrollView>
    </View>
  );
}
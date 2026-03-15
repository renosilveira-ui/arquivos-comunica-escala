import { View, Text, ScrollView, ActivityIndicator } from "react-native";
import { useMemo } from "react";
import { Calendar, AlertCircle, Clock, CheckCircle } from "lucide-react-native";
import { useAuth } from "@/hooks/use-auth";
import { trpc } from "@/lib/trpc";
import { theme } from "@/lib/theme";
import { formatDateBR } from "@/lib/datetime";

const statusColor: Record<string, string> = {
  VAGO: theme.colors.statusVago,
  PENDENTE: theme.colors.statusPendente,
  OCUPADO: theme.colors.statusOcupado,
};

export default function DashboardScreen() {
  const { user, isLoading: authLoading } = useAuth();

  const todayISO = new Date().toISOString();
  const nextWeekISO = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  const { data: shiftsData, isLoading: shiftsLoading } = trpc.shifts.listByPeriod.useQuery(
    { startDate: todayISO, endDate: nextWeekISO },
    { enabled: !!user }
  );

  const shifts = shiftsData || [];

  const stats = useMemo(() => ({
    total: shifts.length,
    vago: shifts.filter(s => s.status === "VAGO").length,
    pendente: shifts.filter(s => s.status === "PENDENTE").length,
    ocupado: shifts.filter(s => s.status === "OCUPADO").length,
  }), [shifts]);

  if (authLoading) {
    return (
      <View style={{ flex: 1, backgroundColor: theme.colors.screenBg, justifyContent: "center", alignItems: "center" }}>
        <ActivityIndicator size="large" color={theme.colors.primary} />
      </View>
    );
  }

  const metricCards = [
    { label: "Total", value: stats.total, color: theme.colors.primary, icon: Calendar },
    { label: "Vagos", value: stats.vago, color: theme.colors.statusVago, icon: AlertCircle },
    { label: "Pendentes", value: stats.pendente, color: theme.colors.statusPendente, icon: Clock },
    { label: "Ocupados", value: stats.ocupado, color: theme.colors.statusOcupado, icon: CheckCircle },
  ];

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.screenBg }}>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: theme.spacing.screenPadding, paddingBottom: 32 }} showsVerticalScrollIndicator={false}>
        {/* Header */}
        <Text style={{ fontSize: 24, fontWeight: "700", color: theme.colors.textPrimary, marginBottom: 4 }}>
          Dashboard
        </Text>
        <Text style={{ fontSize: 14, color: theme.colors.textSecondary, marginBottom: 20 }}>
          Resumo das escalas da semana
        </Text>

        {/* Métricas 2x2 */}
        {shiftsLoading ? (
          <ActivityIndicator size="large" color={theme.colors.primary} style={{ marginTop: 40 }} />
        ) : (
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: theme.spacing.gap }}>
            {metricCards.map(card => {
              const Icon = card.icon;
              return (
                <View
                  key={card.label}
                  style={{
                    flex: 1,
                    minWidth: "45%",
                    backgroundColor: theme.colors.cardBg,
                    borderRadius: theme.borderRadius.card,
                    borderWidth: 1,
                    borderColor: theme.colors.cardBorder,
                    padding: theme.spacing.cardPadding,
                  }}
                >
                  <Icon size={20} color={card.color} />
                  <Text style={{ fontSize: 28, fontWeight: "700", color: theme.colors.textPrimary, marginTop: 8 }}>
                    {card.value}
                  </Text>
                  <Text style={{ fontSize: 12, color: theme.colors.textSecondary, marginTop: 2 }}>
                    {card.label}
                  </Text>
                </View>
              );
            })}
          </View>
        )}

        {/* Turnos da Semana */}
        <Text style={{ fontSize: 20, fontWeight: "700", color: theme.colors.textPrimary, marginTop: 24, marginBottom: 12 }}>
          Turnos da Semana
        </Text>

        {shiftsLoading ? (
          <ActivityIndicator color={theme.colors.primary} />
        ) : shifts.length > 0 ? (
          <View style={{ gap: theme.spacing.gap }}>
            {shifts.slice(0, 20).map(shift => (
              <View
                key={shift.id}
                style={{
                  backgroundColor: theme.colors.cardBg,
                  borderRadius: theme.borderRadius.card,
                  borderWidth: 1,
                  borderColor: theme.colors.cardBorder,
                  padding: theme.spacing.cardPadding,
                }}
              >
                <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                  <Text style={{ fontSize: 16, fontWeight: "600", color: theme.colors.textPrimary }}>
                    {shift.label}
                  </Text>
                  <View style={{
                    backgroundColor: `${statusColor[shift.status] ?? theme.colors.textMuted}22`,
                    borderRadius: 8,
                    paddingHorizontal: 10,
                    paddingVertical: 3,
                  }}>
                    <Text style={{ fontSize: 11, fontWeight: "700", color: statusColor[shift.status] ?? theme.colors.textMuted }}>
                      {shift.status}
                    </Text>
                  </View>
                </View>
                <Text style={{ fontSize: 13, color: theme.colors.textSecondary }}>
                  {formatDateBR(shift.startAt)}{" · "}
                  {new Date(shift.startAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}
                  {" – "}
                  {new Date(shift.endAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}
                </Text>
              </View>
            ))}
          </View>
        ) : (
          <View style={{
            backgroundColor: theme.colors.cardBg,
            borderRadius: theme.borderRadius.card,
            borderWidth: 1,
            borderColor: theme.colors.cardBorder,
            padding: 24,
            alignItems: "center",
          }}>
            <Calendar size={32} color={theme.colors.textMuted} />
            <Text style={{ fontSize: 15, color: theme.colors.textSecondary, marginTop: 8, textAlign: "center" }}>
              Nenhum turno na semana
            </Text>
          </View>
        )}
      </ScrollView>
    </View>
  );
}
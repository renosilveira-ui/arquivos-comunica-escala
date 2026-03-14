import { View, Text, ScrollView, ActivityIndicator, RefreshControl } from "react-native";
import { useAuth } from "@/hooks/use-auth";
import { usePermissions } from "@/hooks/use-permissions";
import { trpc } from "@/lib/trpc";
import { useState, useMemo } from "react";
import { useRouter } from "expo-router";
import * as Haptics from "expo-haptics";
import Animated, { FadeIn, SlideInUp } from "react-native-reanimated";
import { 
  Clock, 
  Calendar, 
  Activity,
  Plus,
  RefreshCw,
} from "lucide-react-native";

// Componentes UI Premium
import { ScreenGradient } from "@/components/ui/ScreenGradient";
import { TintedGlassCard } from "@/components/ui/TintedGlassCard";
import { Badge } from "@/components/ui/Badge";
import { PrimaryButton } from "@/components/ui/PrimaryButton";
import { Typography } from "@/constants/typography";
import { formatDateBR } from "@/lib/datetime";

/**
 * Tela Home - Painel Premium iOS-Like
 * Layout clean com ScreenGradient, TintedGlassCards, texto branco
 */
export default function HomeScreen() {
  const { user } = useAuth();
  const { can, isManager } = usePermissions();
  const [refreshing, setRefreshing] = useState(false);
  const router = useRouter();
  const utils = trpc.useUtils();

  // Buscar escala ativa
  const { data: activeShift, isLoading: loadingActive } = trpc.shifts.getActiveShift.useQuery(
    undefined,
    { enabled: !!user }
  );

  // Buscar próximas escalas (1 semana)
  const todayISO = new Date().toISOString();
  const nextWeekISO = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const { data: upcomingData, isLoading: loadingUpcoming } = trpc.shifts.listByPeriod.useQuery(
    { startDate: todayISO, endDate: nextWeekISO },
    { enabled: !!user }
  );
  const upcomingShifts = upcomingData || [];

  // Resumo para admin/manager
  const weekStats = useMemo(() => ({
    total: upcomingShifts.length,
    vago: upcomingShifts.filter(s => s.status === "VAGO").length,
    pendente: upcomingShifts.filter(s => s.status === "PENDENTE").length,
    ocupado: upcomingShifts.filter(s => s.status === "OCUPADO").length,
  }), [upcomingShifts]);

  const handleViewCalendar = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    router.push("/calendar");
  };

  const onRefresh = async () => {
    setRefreshing(true);
    await Promise.all([
      utils.shifts.getActiveShift.invalidate(),
      utils.shifts.listByPeriod.invalidate(),
    ]);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setRefreshing(false);
  };

  // Tela de boas-vindas (sem login)
  if (!user) {
    return (
      <ScreenGradient>
        <View style={{ flex: 1, justifyContent: "center", alignItems: "center", paddingHorizontal: 24 }}>
          <Activity size={64} color="#4DA3FF" strokeWidth={1.5} />
          <Text style={{ fontSize: 30, fontWeight: "800", lineHeight: 36, color: "#FFFFFF", marginTop: 24, textAlign: "center" }}>
            Escalas Hospitalares
          </Text>
          <Text style={{ fontSize: 18, lineHeight: 24, color: "rgba(242,246,255,0.70)", marginTop: 16, textAlign: "center" }}>
            Gerencie plantões, sincronize com HospitalAlert e receba notificações de mudanças
          </Text>
        </View>
      </ScreenGradient>
    );
  }

  return (
    <ScreenGradient 
      scrollable
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={onRefresh}
          tintColor="#4DA3FF"
          colors={["#4DA3FF"]}
        />
      }
    >
      <View style={{ gap: 16 }}>
        {/* Header */}
        <Animated.View entering={FadeIn.duration(400)} style={{ marginTop: 16, gap: 12 }}>
          <Text style={{ fontSize: 30, fontWeight: "800", lineHeight: 36, color: "#FFFFFF" }}>
            Minha Escala
          </Text>
        </Animated.View>

        {/* 1. Card "Escala ativa agora" */}
        <Animated.View entering={SlideInUp.duration(400).delay(100)}>
        {loadingActive ? (
          <TintedGlassCard>
            <ActivityIndicator color="#4DA3FF" />
          </TintedGlassCard>
        ) : activeShift ? (
          <TintedGlassCard>
            <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
              <Text style={{ fontSize: 24, fontWeight: "700", lineHeight: 28, color: "#FFFFFF" }}>
                Plantão Ativo
              </Text>
              <Badge variant="success" label="Ativo agora" />
            </View>
            
            <Text style={{ fontSize: 18, lineHeight: 24, color: "#FFFFFF", fontWeight: "600", marginBottom: 8 }}>
              {activeShift.label}
            </Text>
            
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Clock size={18} color="rgba(242,246,255,0.70)" />
              <Text style={{ fontSize: 16, lineHeight: 20, color: "rgba(242,246,255,0.70)" }}>
                {new Date(activeShift.startAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
                {' - '}
                {new Date(activeShift.endAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
              </Text>
            </View>
          </TintedGlassCard>
        ) : (
          <TintedGlassCard>
            <View style={{ alignItems: "center", paddingVertical: 8, gap: 12 }}>
              <Clock size={32} color="rgba(242,246,255,0.25)" strokeWidth={1.5} />
              <View style={{ alignItems: "center", gap: 4 }}>
                <Text style={{ fontSize: 16, fontWeight: "600", color: "rgba(242,246,255,0.55)", textAlign: "center" }}>
                  Nenhum plantão ativo agora
                </Text>
                <Text style={{ fontSize: 13, color: "rgba(242,246,255,0.35)", textAlign: "center" }}>
                  Você não tem turnos atribuídos para este momento
                </Text>
              </View>
            </View>
          </TintedGlassCard>
        )}
        </Animated.View>

        {/* 2. Próximas escalas / Semana em resumo */}
        <Animated.View entering={SlideInUp.duration(400).delay(200)}>
          <Text style={{ fontSize: 24, fontWeight: "700", lineHeight: 28, color: "#FFFFFF", marginBottom: 12 }}>
            {isManager ? "Semana em Resumo" : "Próximas Escalas"}
          </Text>

          {loadingUpcoming ? (
            <TintedGlassCard>
              <ActivityIndicator color="#4DA3FF" />
            </TintedGlassCard>
          ) : isManager ? (
            <TintedGlassCard>
              <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
                {[
                  { label: "Total", value: weekStats.total, color: "#FFFFFF" },
                  { label: "Vagos", value: weekStats.vago, color: "#F87171" },
                  { label: "Pendentes", value: weekStats.pendente, color: "#FBBF24" },
                  { label: "Ocupados", value: weekStats.ocupado, color: "#34D399" },
                ].map(item => (
                  <View key={item.label} style={{ alignItems: "center", flex: 1 }}>
                    <Text style={{ fontSize: 28, fontWeight: "800", color: item.color, lineHeight: 34 }}>
                      {item.value}
                    </Text>
                    <Text style={{ fontSize: 12, color: "rgba(242,246,255,0.50)", marginTop: 2 }}>
                      {item.label}
                    </Text>
                  </View>
                ))}
              </View>
            </TintedGlassCard>
          ) : upcomingShifts.length > 0 ? (
            <View style={{ gap: 12 }}>
              {upcomingShifts.slice(0, 3).map((shift, index) => (
                <TintedGlassCard 
                  key={shift.id ?? index}
                  onPress={() => {
                    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                    router.push({ pathname: "/edit-shift", params: { id: shift.id } });
                  }}
                >
                  <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                    <Text style={{ fontSize: 18, lineHeight: 24, color: "#FFFFFF", fontWeight: "600" }}>
                      {shift.label}
                    </Text>
                    <Badge variant="warning" label={shift.status} />
                  </View>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                    <Calendar size={16} color="rgba(242,246,255,0.70)" />
                    <Text style={{ fontSize: 16, lineHeight: 20, color: "rgba(242,246,255,0.70)" }}>
                      {formatDateBR(new Date(shift.startAt).toISOString().split('T')[0])}
                    </Text>
                  </View>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginTop: 4 }}>
                    <Clock size={16} color="rgba(242,246,255,0.70)" />
                    <Text style={{ fontSize: 16, lineHeight: 20, color: "rgba(242,246,255,0.70)" }}>
                      {new Date(shift.startAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
                      {' - '}
                      {new Date(shift.endAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
                    </Text>
                  </View>
                </TintedGlassCard>
              ))}
            </View>
          ) : (
            <TintedGlassCard>
              <View style={{ alignItems: "center", paddingVertical: 8, gap: 8 }}>
                <Calendar size={28} color="rgba(242,246,255,0.25)" strokeWidth={1.5} />
                <Text style={{ fontSize: 15, color: "rgba(242,246,255,0.55)", textAlign: "center" }}>
                  Nenhuma escala agendada próxima semana
                </Text>
              </View>
            </TintedGlassCard>
          )}
        </Animated.View>

        {/* Botão Ver Calendário */}
        <Animated.View entering={SlideInUp.duration(400).delay(300)}>
        <PrimaryButton
          label="Ver Calendário Completo"
          icon={<Calendar size={20} color="#FFFFFF" />}
          onPress={handleViewCalendar}
        />
        </Animated.View>

        {/* Ações de Gestão — visível apenas para admin/manager */}
        {isManager && (
          <Animated.View entering={SlideInUp.duration(400).delay(400)}>
            <Text style={{ fontSize: 24, fontWeight: "700", lineHeight: 28, color: "#FFFFFF", marginBottom: 12 }}>
              Gerenciar
            </Text>
            <View style={{ flexDirection: "row", gap: 12 }}>
              {can("create:shift") && (
                <TintedGlassCard
                  style={{ flex: 1, backgroundColor: "rgba(77,163,255,0.12)", borderColor: "rgba(77,163,255,0.30)" }}
                  onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); router.push("/create-shift"); }}
                >
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 6 }}>
                    <Plus size={18} color="#4DA3FF" />
                    <Text style={{ fontSize: 15, fontWeight: "700", color: "#FFFFFF" }}>Criar Plantão</Text>
                  </View>
                  <Text style={{ fontSize: 13, color: "rgba(242,246,255,0.55)" }}>Escala nova</Text>
                </TintedGlassCard>
              )}
              {can("approve:swaps") && (
                <TintedGlassCard
                  style={{ flex: 1, backgroundColor: "rgba(251,191,36,0.10)", borderColor: "rgba(251,191,36,0.25)" }}
                  onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); router.push("/approve-swaps"); }}
                >
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 6 }}>
                    <RefreshCw size={18} color="#FBBF24" />
                    <Text style={{ fontSize: 15, fontWeight: "700", color: "#FFFFFF" }}>Trocas</Text>
                  </View>
                  <Text style={{ fontSize: 13, color: "rgba(242,246,255,0.55)" }}>Aprovar trocas</Text>
                </TintedGlassCard>
              )}
            </View>
          </Animated.View>
        )}
      </View>
    </ScreenGradient>
  );
}

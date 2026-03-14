import { View, Text, ScrollView, ActivityIndicator, RefreshControl } from "react-native";
import { useAuth } from "@/hooks/use-auth";
import { usePermissions } from "@/hooks/use-permissions";
import { trpc } from "@/lib/trpc";
import { useState } from "react";
import { useRouter } from "expo-router";
import * as Haptics from "expo-haptics";
import Animated, { FadeIn, SlideInUp } from "react-native-reanimated";
import { 
  Clock, 
  Calendar, 
  Activity,
  ExternalLink
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

  const handleViewCalendar = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    router.push("/calendar");
  };

  const handleOpenHospitalAlert = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    // TODO: Implementar deep link para HospitalAlert
    alert("Abrindo HospitalAlert...");
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
            <Text style={{ fontSize: 18, lineHeight: 24, color: "rgba(242,246,255,0.70)", textAlign: "center" }}>
              Nenhum plantão ativo no momento
            </Text>
          </TintedGlassCard>
        )}
        </Animated.View>

        {/* 2. Card "Integração HospitalAlert" */}
        <Animated.View entering={SlideInUp.duration(400).delay(200)}>
        <TintedGlassCard>
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
            <Text style={{ fontSize: 24, fontWeight: "700", lineHeight: 28, color: "#FFFFFF" }}>
              Integração HospitalAlert
            </Text>
            <Badge variant="success" label="Conectado" />
          </View>
          
          <Text style={{ fontSize: 16, lineHeight: 20, color: "rgba(242,246,255,0.70)", marginBottom: 16 }}>
            Sincronizado automaticamente
          </Text>
          
          <PrimaryButton
            label="Abrir HospitalAlert"
            icon={<ExternalLink size={20} color="#FFFFFF" />}
            onPress={handleOpenHospitalAlert}
          />
        </TintedGlassCard>
        </Animated.View>

        {/* 3. Card "Próximas escalas" (3 itens) */}
        <Animated.View entering={SlideInUp.duration(400).delay(300)}>
          <Text style={{ fontSize: 24, fontWeight: "700", lineHeight: 28, color: "#FFFFFF", marginBottom: 12 }}>
            Próximas Escalas
          </Text>

          {loadingUpcoming ? (
            <TintedGlassCard>
              <ActivityIndicator color="#4DA3FF" />
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
              <Text style={{ fontSize: 18, lineHeight: 24, color: "rgba(242,246,255,0.70)", textAlign: "center" }}>
                Nenhuma escala agendada
              </Text>
            </TintedGlassCard>
          )}
        </Animated.View>

        {/* Botão Ver Calendário */}
        <Animated.View entering={SlideInUp.duration(400).delay(400)}>
        <PrimaryButton
          label="Ver Calendário Completo"
          icon={<Calendar size={20} color="#FFFFFF" />}
          onPress={handleViewCalendar}
        />
        </Animated.View>

        {/* Ações de Gestão — visível apenas para admin/manager */}
        {isManager && (
          <Animated.View entering={SlideInUp.duration(400).delay(500)}>
            <Text style={{ fontSize: 24, fontWeight: "700", lineHeight: 28, color: "#FFFFFF", marginBottom: 12 }}>
              Gerenciar
            </Text>
            <View style={{ flexDirection: "row", gap: 12 }}>
              {can("create:shift") && (
                <TintedGlassCard
                  style={{ flex: 1 }}
                  onPress={() => { router.push("/create-shift"); }}
                >
                  <Text style={{ fontSize: 15, fontWeight: "700", color: "#FFFFFF", marginBottom: 4 }}>+ Criar Plantão</Text>
                  <Text style={{ fontSize: 13, color: "rgba(242,246,255,0.55)" }}>Escala nova</Text>
                </TintedGlassCard>
              )}
              {can("approve:swaps") && (
                <TintedGlassCard
                  style={{ flex: 1 }}
                  onPress={() => { router.push("/approve-swaps"); }}
                >
                  <Text style={{ fontSize: 15, fontWeight: "700", color: "#FFFFFF", marginBottom: 4 }}>Trocas</Text>
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

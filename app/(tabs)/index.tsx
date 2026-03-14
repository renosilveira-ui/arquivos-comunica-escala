import { View, Text, ScrollView, ActivityIndicator, RefreshControl } from "react-native";
import { useAuth } from "@/hooks/use-auth";
import { usePermissions } from "@/hooks/use-permissions";
import { trpc } from "@/lib/trpc";
import { isDemoMode, enableDemoMode, DEMO_USER, DEMO_SHIFTS, getSelectedService, DEMO_SERVICES } from "@/lib/demo-mode";
import { useState, useEffect } from "react";
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
  const [demoMode, setDemoMode] = useState(false);
  const [demoUser, setDemoUser] = useState<typeof DEMO_USER | null>(null);
  const [selectedServiceId, setSelectedServiceId] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const router = useRouter();

  // Verificar modo demo (sem redirecionamento para service-selection)
  useEffect(() => {
    async function checkDemo() {
      const isDemo = await isDemoMode();
      setDemoMode(isDemo);
      
      // Carregar serviço selecionado se existir (mas não redirecionar se não tiver)
      if (isDemo || user) {
        const selectedService = await getSelectedService();
        setSelectedServiceId(selectedService);
      }
    }
    checkDemo();
  }, [user]);

  // Ativar modo demo
  const handleEnableDemoMode = async () => {
    await enableDemoMode();
    setDemoMode(true);
    setDemoUser(DEMO_USER);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  };

  const currentUser = demoMode ? demoUser : user;

  // Buscar escala ativa (ou usar dados demo)
  const { data: activeShift, isLoading: loadingActive } = trpc.shifts.getActiveShift.useQuery(
    { userId: currentUser?.id || 0 },
    { enabled: !demoMode && !!currentUser }
  );

  // Buscar próximas escalas (ou usar dados demo)
  const upcomingShifts: any = null;
  const loadingUpcoming = false;

  const currentActiveShift: any = demoMode ? DEMO_SHIFTS[0] : activeShift;
  const currentUpcomingShifts: any = demoMode ? DEMO_SHIFTS : upcomingShifts;

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
    // Simular atualização de dados (aguarda 1s)
    await new Promise(resolve => setTimeout(resolve, 1000));
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setRefreshing(false);
  };

  // Tela de boas-vindas (sem login e sem demo)
  if (!currentUser) {
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
          <View style={{ marginTop: 32, width: "100%" }}>
            <PrimaryButton 
              label="Explorar em Modo Demo" 
              onPress={handleEnableDemoMode}
            />
          </View>
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
          {selectedServiceId && (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <View style={{ 
                paddingHorizontal: 12, 
                paddingVertical: 6, 
                borderRadius: 12, 
                backgroundColor: "rgba(77,163,255,0.2)",
                borderWidth: 1,
                borderColor: "rgba(77,163,255,0.4)"
              }}>
                <Text style={{ fontSize: 14, fontWeight: "600", color: "#4DA3FF" }}>
                  {DEMO_SERVICES.find(s => s.id === selectedServiceId)?.name || "Serviço"}
                </Text>
              </View>
            </View>
          )}
        </Animated.View>

        {/* 1. Card "Escala ativa agora" */}
        <Animated.View entering={SlideInUp.duration(400).delay(100)}>
        {loadingActive ? (
          <TintedGlassCard>
            <ActivityIndicator color="#4DA3FF" />
          </TintedGlassCard>
        ) : currentActiveShift ? (
          <TintedGlassCard>
            <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
              <Text style={{ fontSize: 24, fontWeight: "700", lineHeight: 28, color: "#FFFFFF" }}>
                Plantão Ativo
              </Text>
              <Badge variant="success" label="Ativo agora" />
            </View>
            
            <Text style={{ fontSize: 18, lineHeight: 24, color: "#FFFFFF", fontWeight: "600", marginBottom: 8 }}>
              {currentActiveShift.sector?.name || "Setor não definido"}
            </Text>
            
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Clock size={18} color="rgba(242,246,255,0.70)" />
              <Text style={{ fontSize: 16, lineHeight: 20, color: "rgba(242,246,255,0.70)" }}>
                {typeof currentActiveShift.startTime === 'string' ? currentActiveShift.startTime : new Date(currentActiveShift.startTime).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
                {' - '}
                {typeof currentActiveShift.endTime === 'string' ? currentActiveShift.endTime : new Date(currentActiveShift.endTime).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
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
          ) : currentUpcomingShifts && currentUpcomingShifts.length > 0 ? (
            <View style={{ gap: 12 }}>
              {currentUpcomingShifts.slice(0, 3).map((shift: any, index: number) => (
                <TintedGlassCard 
                  key={index}
                  onPress={() => {
                    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                    // TODO: Navegar para detalhes
                  }}
                >
                  <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                    <Text style={{ fontSize: 18, lineHeight: 24, color: "#FFFFFF", fontWeight: "600" }}>
                      {shift.sector?.name || "Setor não definido"}
                    </Text>
                    <Badge variant="warning" label={shift.status || "Pendente"} />
                  </View>
                  
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                    <Calendar size={16} color="rgba(242,246,255,0.70)" />
                    <Text style={{ fontSize: 16, lineHeight: 20, color: "rgba(242,246,255,0.70)" }}>
                      {shift.date || formatDateBR(shift.shift?.startTime || Date.now())}
                    </Text>
                  </View>
                  
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginTop: 4 }}>
                    <Clock size={16} color="rgba(242,246,255,0.70)" />
                    <Text style={{ fontSize: 16, lineHeight: 20, color: "rgba(242,246,255,0.70)" }}>
                      {shift.startTime || new Date(shift.shift?.startTime || Date.now()).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
                      {' - '}
                      {shift.endTime || new Date(shift.shift?.endTime || Date.now()).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
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

import { ScrollView, Text, View, TouchableOpacity, Switch, ActivityIndicator } from "react-native";
import { ScreenGradient } from "@/components/ui/ScreenGradient";
import { TintedGlassCard } from "@/components/ui/TintedGlassCard";
import { Badge } from "@/components/ui/Badge";
import { useAuth } from "@/hooks/use-auth";
import * as Haptics from "expo-haptics";
import { trpc } from "@/lib/trpc";
import { useHospitalAlertSync } from "@/hooks/use-hospital-alert-sync";
import { useState, useEffect } from "react";
import { User, Bell, Link2, LogOut, Briefcase, Activity, CheckCircle, XCircle } from "lucide-react-native";
import { useRouter } from "expo-router";
import { clearSelectedService } from "@/lib/demo-mode";
import { theme } from "@/lib/theme";
import { 
  requestNotificationPermissions, 
  notifyNewShift, 
  notifyShiftChange, 
  notifyShiftCancellation 
} from "@/lib/notifications";

/**
 * Tela de Perfil
 * Exibe informações do usuário e configurações de notificações
 */
export default function ProfileScreen() {
  const { user, logout } = useAuth();
  const utils = trpc.useUtils();

  // TODO: Buscar configurações de notificação quando API estiver disponível
  const settings = {
    enableShiftChanges: true,
    enableReminders: true,
    enableHospitalAlertNotifications: true,
  };

  // Estados locais para switches
  const [enableShiftChanges, setEnableShiftChanges] = useState(true);
  const [enableReminders, setEnableReminders] = useState(true);
  const [enableHospitalAlert, setEnableHospitalAlert] = useState(true);

  // Status da integração HospitalAlert (API real)
  // Hook de sincronização HospitalAlert
  const hospitalAlert = useHospitalAlertSync();

  const handleSyncNow = async () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    
    try {
      await hospitalAlert.actions.syncNow();
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (error) {
      console.error("[Profile] Erro ao sincronizar:", error);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    }
  };

  // Atualizar estados quando settings carrega
  useEffect(() => {
    if (settings) {
      setEnableShiftChanges(settings.enableShiftChanges);
      setEnableReminders(settings.enableReminders);
      setEnableHospitalAlert(settings.enableHospitalAlertNotifications);
    }
  }, [settings]);

  // TODO: Mutation para atualizar configurações quando API estiver disponível
  const updateSettings = {
    mutate: (data: any) => {
      console.log("Atualizar configurações:", data);
    },
  };

  const handleToggleShiftChanges = (value: boolean) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setEnableShiftChanges(value);
    updateSettings.mutate({
      userId: user?.id ?? 0,
      enableShiftChanges: value,
    });
  };

  const handleToggleReminders = (value: boolean) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setEnableReminders(value);
    updateSettings.mutate({
      userId: user?.id ?? 0,
      enableReminders: value,
    });
  };

  const handleToggleHospitalAlert = (value: boolean) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setEnableHospitalAlert(value);
    updateSettings.mutate({
      userId: user?.id ?? 0,
      enableHospitalAlertNotifications: value,
    });
  };

  const router = useRouter();

  const handleChangeService = async () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    await clearSelectedService();
    router.replace("/service-selection");
  };

  const handleLogout = () => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    logout();
  };

  if (!user) {
    return (
      <ScreenGradient scrollable={false}>
        <View className="flex-1 justify-center items-center">
          <Text className="text-lg text-white/70">Faça login para continuar</Text>
        </View>
      </ScreenGradient>
    );
  }

  return (
    <ScreenGradient scrollable>
      <View className="gap-6">
        {/* Header */}
        <View className="flex-row items-center gap-3">
          <User size={28} color="#FFFFFF" />
          <Text className="text-3xl font-bold text-white">Perfil</Text>
        </View>

        {/* Informações do Usuário */}
        <TintedGlassCard>
          <View className="items-center py-4">
            <View
              className="w-24 h-24 rounded-full items-center justify-center mb-4"
              style={{ backgroundColor: "rgba(59,130,246,0.3)" }}
            >
              <Text className="text-4xl font-bold text-white">
                {user.name?.charAt(0).toUpperCase() || "U"}
              </Text>
            </View>
            <Text className="text-2xl font-bold text-white">{user.name || "Usuário"}</Text>
            <Text className="text-base text-white/70 mt-2">{user.email}</Text>
          </View>
        </TintedGlassCard>

        {/* Status HospitalAlert */}
        <View className="gap-4">
          <View className="flex-row items-center gap-2">
            <Activity size={20} color="#FFFFFF" />
            <Text className="text-2xl font-bold text-white">Status HospitalAlert</Text>
          </View>
          <TintedGlassCard>
            <View className="gap-4">
              {/* Conectado */}
              {hospitalAlert.meta.isLoading ? (
                <View className="py-8 items-center">
                  <ActivityIndicator color={theme.colors.primary} />
                </View>
              ) : hospitalAlert.status ? (
                <>
                  {/* Conectado */}
                  <View className="flex-row items-center justify-between py-3" style={{ borderBottomWidth: 1, borderBottomColor: "rgba(255,255,255,0.08)" }}>
                    <View className="flex-row items-center gap-3">
                      {hospitalAlert.status.connected ? (
                        <CheckCircle size={24} color="#34D399" />
                      ) : (
                        <XCircle size={24} color="#F87171" />
                      )}
                      <Text className="text-lg font-medium text-white">Conectado ao HospitalAlert</Text>
                    </View>
                    <Badge 
                      variant={hospitalAlert.status.connected ? "success" : "critical"} 
                      label={hospitalAlert.status.connected ? "Sim" : "Não"} 
                    />
                  </View>

                  {/* Plantão ativo no HospitalAlert */}
                  <View className="flex-row items-center justify-between py-3" style={{ borderBottomWidth: 1, borderBottomColor: "rgba(255,255,255,0.08)" }}>
                    <Text className="text-lg font-medium text-white">Plantão ativo no HospitalAlert</Text>
                    <Badge 
                      variant={hospitalAlert.status.shiftActive ? "success" : "neutral"} 
                      label={hospitalAlert.status.shiftActive ? "Sim" : "Não"} 
                    />
                  </View>

                  {/* Última Sincronização */}
                  <View className="flex-row items-center justify-between py-3" style={{ borderBottomWidth: 1, borderBottomColor: "rgba(255,255,255,0.08)" }}>
                    <Text className="text-lg font-medium text-white">Última sincronização</Text>
                    <Text className="text-base font-semibold text-white/70">
                      {hospitalAlert.status.lastSyncAt
                        ? new Date(hospitalAlert.status.lastSyncAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
                        : "Nunca"}
                    </Text>
                  </View>

                  {/* Botão Sincronizar Agora */}
                  <View className="pt-2">
                    <TouchableOpacity
                      onPress={handleSyncNow}
                      disabled={hospitalAlert.meta.isSyncing}
                      className="bg-[#4DA3FF] rounded-xl h-12 items-center justify-center flex-row gap-2"
                      activeOpacity={0.7}
                    >
                      {hospitalAlert.meta.isSyncing ? (
                        <ActivityIndicator size="small" color="#FFFFFF" />
                      ) : (
                        <>
                          <Link2 size={20} color="#FFFFFF" />
                          <Text className="text-base font-semibold text-white">Sincronizar Agora</Text>
                        </>
                      )}
                    </TouchableOpacity>
                  </View>
                </>
              ) : (
                <Text className="text-base text-white/70 text-center py-4">
                  Erro ao carregar status
                </Text>
              )}
            </View>
          </TintedGlassCard>
        </View>

        {/* Estatísticas do Mês */}
        <View className="gap-4">
          <View className="flex-row items-center gap-2">
            <Briefcase size={20} color="#FFFFFF" />
            <Text className="text-2xl font-bold text-white">Estatísticas do Mês</Text>
          </View>
          <View className="flex-row gap-4">
            {/* Total de Horas */}
            <View className="flex-1">
              <TintedGlassCard>
                <View className="items-center py-4">
                  <Text className="text-4xl font-bold text-white">120</Text>
                  <Text className="text-base text-white/70 mt-2">Horas Trabalhadas</Text>
                </View>
              </TintedGlassCard>
            </View>
            {/* Total de Plantões */}
            <View className="flex-1">
              <TintedGlassCard>
                <View className="items-center py-4">
                  <Text className="text-4xl font-bold text-white">15</Text>
                  <Text className="text-base text-white/70 mt-2">Plantões</Text>
                </View>
              </TintedGlassCard>
            </View>
          </View>
          {/* Distribuição de Turnos */}
          <TintedGlassCard>
            <Text className="text-lg font-semibold text-white mb-4">Distribuição de Turnos</Text>
            <View className="gap-3">
              <View className="flex-row items-center justify-between">
                <Text className="text-base text-white/70">Manhã (7h-13h)</Text>
                <Text className="text-lg font-bold text-white">5 plantões</Text>
              </View>
              <View className="flex-row items-center justify-between">
                <Text className="text-base text-white/70">Tarde (13h-19h)</Text>
                <Text className="text-lg font-bold text-white">4 plantões</Text>
              </View>
              <View className="flex-row items-center justify-between">
                <Text className="text-base text-white/70">Noite (19h-7h)</Text>
                <Text className="text-lg font-bold text-white">6 plantões</Text>
              </View>
            </View>
          </TintedGlassCard>
        </View>

        {/* Configurações de Notificações */}
        <View className="gap-4">
          <View className="flex-row items-center gap-2">
            <Bell size={20} color="#FFFFFF" />
            <Text className="text-2xl font-bold text-white">Notificações</Text>
          </View>
          <TintedGlassCard>
            {/* Mudanças de Escala */}
            <View className="py-4" style={{ borderBottomWidth: 1, borderBottomColor: "rgba(255,255,255,0.08)" }}>
              <View className="flex-row items-center justify-between">
                <View className="flex-1 pr-4">
                  <Text className="text-lg font-semibold text-white">Mudanças de Escala</Text>
                  <Text className="text-base text-white/70 mt-1">
                    Receber notificações quando uma escala for alterada ou cancelada
                  </Text>
                </View>
                <Switch
                  value={enableShiftChanges}
                  onValueChange={handleToggleShiftChanges}
                  trackColor={{ false: "rgba(255,255,255,0.2)", true: theme.colors.primary }}
                  thumbColor="#FFFFFF"
                />
              </View>
            </View>

            {/* Lembretes */}
            <View className="py-4" style={{ borderBottomWidth: 1, borderBottomColor: "rgba(255,255,255,0.08)" }}>
              <View className="flex-row items-center justify-between">
                <View className="flex-1 pr-4">
                  <Text className="text-lg font-semibold text-white">Lembretes de Plantão</Text>
                  <Text className="text-base text-white/70 mt-1">
                    Receber lembrete 30 minutos antes do início do plantão
                  </Text>
                </View>
                <Switch
                  value={enableReminders}
                  onValueChange={handleToggleReminders}
                  trackColor={{ false: "rgba(255,255,255,0.2)", true: theme.colors.primary }}
                  thumbColor="#FFFFFF"
                />
              </View>
            </View>

            {/* Notificações do HospitalAlert */}
            <View className="py-4">
              <View className="flex-row items-center justify-between">
                <View className="flex-1 pr-4">
                  <Text className="text-lg font-semibold text-white">Integração HospitalAlert</Text>
                  <Text className="text-base text-white/70 mt-1">
                    Receber notificações do sistema HospitalAlert
                  </Text>
                </View>
                <Switch
                  value={enableHospitalAlert}
                  onValueChange={handleToggleHospitalAlert}
                  trackColor={{ false: "rgba(255,255,255,0.2)", true: theme.colors.primary }}
                  thumbColor="#FFFFFF" />
              </View>
            </View>
          </TintedGlassCard>
        </View>

        {/* Status de Integração */}
        <View className="gap-4">
          <View className="flex-row items-center gap-2">
            <Link2 size={20} color="#FFFFFF" />
            <Text className="text-2xl font-bold text-white">Integração</Text>
          </View>
          <TintedGlassCard>
            <View className="flex-row items-center justify-between">
              <View className="flex-row items-center gap-3">
                <View className="w-12 h-12 rounded-full items-center justify-center" style={{ backgroundColor: "rgba(59,130,246,0.3)" }}>
                  <Link2 size={24} color="#FFFFFF" />
                </View>
                <View>
                  <Text className="text-lg font-semibold text-white">HospitalAlert</Text>
                  <Text className="text-base text-white/70">Sistema de alertas hospitalares</Text>
                </View>
              </View>
              <Badge variant="success">Conectado</Badge>
            </View>
          </TintedGlassCard>
        </View>

        {/* Teste de Notificações (Modo Demo) */}
        <View className="gap-4">
          <View className="flex-row items-center gap-2">
            <Bell size={20} color="#FFFFFF" />
            <Text className="text-2xl font-bold text-white">Testar Notificações</Text>
          </View>
          <TintedGlassCard>
            <View className="gap-3">
              <TouchableOpacity
                onPress={async () => {
                  const granted = await requestNotificationPermissions();
                  if (granted) {
                    await notifyNewShift("UTI", new Date(), "Manhã 7h-13h");
                    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                  }
                }}
                className="rounded-xl p-4 items-center flex-row justify-between"
                style={{ backgroundColor: "rgba(34,197,94,0.1)", borderWidth: 1, borderColor: "rgba(34,197,94,0.3)" }}
                activeOpacity={0.7}
              >
                <Text className="text-base font-semibold text-white">🏥 Nova Escala</Text>
              </TouchableOpacity>

              <TouchableOpacity
                onPress={async () => {
                  const granted = await requestNotificationPermissions();
                  if (granted) {
                    await notifyShiftChange("Emergência", new Date(), new Date(Date.now() + 7 * 24 * 60 * 60 * 1000));
                    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                  }
                }}
                className="rounded-xl p-4 items-center flex-row justify-between"
                style={{ backgroundColor: "rgba(59,130,246,0.1)", borderWidth: 1, borderColor: "rgba(59,130,246,0.3)" }}
                activeOpacity={0.7}
              >
                <Text className="text-base font-semibold text-white">🔄 Troca de Plantão</Text>
              </TouchableOpacity>

              <TouchableOpacity
                onPress={async () => {
                  const granted = await requestNotificationPermissions();
                  if (granted) {
                    await notifyShiftCancellation("Cirurgia", new Date(), "Falta de profissionais");
                    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                  }
                }}
                className="rounded-xl p-4 items-center flex-row justify-between"
                style={{ backgroundColor: "rgba(239,68,68,0.1)", borderWidth: 1, borderColor: "rgba(239,68,68,0.3)" }}
                activeOpacity={0.7}
              >
                <Text className="text-base font-semibold text-white">❌ Cancelamento</Text>
              </TouchableOpacity>
            </View>
          </TintedGlassCard>
        </View>

        {/* Botão Trocar Serviço */}
        <TouchableOpacity
          onPress={handleChangeService}
          className="rounded-2xl p-5 items-center flex-row justify-center gap-3"
          style={{ backgroundColor: "rgba(77,163,255,0.2)", borderWidth: 1, borderColor: "rgba(77,163,255,0.5)" }}
          activeOpacity={0.7}
        >
          <Briefcase size={20} color="#FFFFFF" />
          <Text className="text-lg font-semibold text-white">Trocar Serviço</Text>
        </TouchableOpacity>

        {/* Botão de Logout */}
        <TouchableOpacity
          onPress={handleLogout}
          className="rounded-2xl p-5 items-center flex-row justify-center gap-3"
          style={{ backgroundColor: "rgba(239,68,68,0.2)", borderWidth: 1, borderColor: "rgba(239,68,68,0.5)" }}
          activeOpacity={0.7}
        >
          <LogOut size={20} color="#FFFFFF" />
          <Text className="text-lg font-semibold text-white">Sair</Text>
        </TouchableOpacity>

        {/* Espaçamento inferior */}
        <View className="h-8" />
      </View>
    </ScreenGradient>
  );
}

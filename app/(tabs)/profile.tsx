import { ScrollView, Text, View, TouchableOpacity, Switch, ActivityIndicator } from "react-native";
import { ScreenGradient } from "@/components/ui/ScreenGradient";
import { TintedGlassCard } from "@/components/ui/TintedGlassCard";
import { Badge } from "@/components/ui/Badge";
import { useAuth } from "@/hooks/use-auth";
import * as Haptics from "expo-haptics";
import { trpc } from "@/lib/trpc";
import { useState, useEffect, useMemo } from "react";
import { User, Bell, Link2, LogOut, Briefcase } from "lucide-react-native";
import { theme } from "@/lib/theme";
import { 
  requestNotificationPermissions, 
  notifyNewShift, 
  notifyShiftChange, 
  notifyShiftCancellation 
} from "@/lib/notifications";

function toDateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/**
 * Tela de Perfil
 * Exibe informações do usuário e configurações de notificações
 */
export default function ProfileScreen() {
  const { user, logout } = useAuth();
  const utils = trpc.useUtils();

  // ── Estatísticas do mês atual ──────────────────────────────────────────
  const now = new Date();
  const monthStartDate = new Date(now.getFullYear(), now.getMonth(), 1);
  const monthEndDateExclusive = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const monthStart = toDateKey(monthStartDate);
  const monthEnd = toDateKey(monthEndDateExclusive);

  const { data: professional } = trpc.professionals.getByUserId.useQuery(
    { userId: user?.id ?? 0 },
    { enabled: !!user?.id },
  );

  const { data: monthShifts } = trpc.shifts.listByPeriod.useQuery(
    { startDate: monthStart, endDate: monthEnd },
    { enabled: !!user?.id }
  );

  const monthStats = useMemo(() => {
    const empty = { totalHours: 0, totalShifts: 0, manha: 0, tarde: 0, noite: 0 };
    if (!monthShifts) return empty;

    const isManager =
      professional?.role === "GESTOR_MEDICO" ||
      professional?.role === "GESTOR_PLUS";

    const relevant = (monthShifts as any[]).filter((shift) => {
      if (isManager) return true;
      return (shift.assignments as any[]).some(
        (a: any) => a.professionalId === professional?.id && a.isActive
      );
    });

    let totalHours = 0;
    let manha = 0;
    let tarde = 0;
    let noite = 0;

    for (const shift of relevant) {
      const start = new Date(shift.startAt);
      const end = new Date(shift.endAt);
      totalHours += (end.getTime() - start.getTime()) / (1000 * 60 * 60);
      const label: string = shift.label ?? "";
      if (label === "Manhã") manha++;
      else if (label === "Tarde") tarde++;
      else if (label === "Noite") noite++;
    }

    return {
      totalHours: Math.round(totalHours),
      totalShifts: relevant.length,
      manha,
      tarde,
      noite,
    };
  }, [monthShifts, professional]);


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
  // Atualizar estados quando settings carrega
  useEffect(() => {
    if (settings) {
      setEnableShiftChanges(settings.enableShiftChanges);
      setEnableReminders(settings.enableReminders);
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
    setEnableHospitalAlert(value);
  };

  const handleLogout = () => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    logout();
  };

  if (!user) {
    return (
      <ScreenGradient scrollable={false}>
        <View className="flex-1 justify-center items-center">
          <Text className="text-lg" style={{ color: "#475569" }}>Faça login para continuar</Text>
        </View>
      </ScreenGradient>
    );
  }

  return (
    <ScreenGradient scrollable>
      <View className="gap-6">
        {/* Header */}
        <View className="flex-row items-center gap-3">
          <User size={28} color="#0F172A" />
          <Text className="text-3xl font-bold" style={{ color: "#0F172A" }}>Perfil</Text>
        </View>

        {/* Informações do Usuário */}
        <TintedGlassCard>
          <View className="items-center py-4">
            <View
              className="w-24 h-24 rounded-full items-center justify-center mb-4"
              style={{ backgroundColor: "rgba(59,130,246,0.3)" }}
            >
              <Text className="text-4xl font-bold" style={{ color: "#0F172A" }}>
                {user.name?.charAt(0).toUpperCase() || "U"}
              </Text>
            </View>
            <Text className="text-2xl font-bold" style={{ color: "#0F172A" }}>{user.name || "Usuário"}</Text>
            <Text className="text-base mt-2" style={{ color: "#475569" }}>{user.email}</Text>
          </View>
        </TintedGlassCard>


        {/* Estatísticas do Mês */}
        <View className="gap-4">
          <View className="flex-row items-center gap-2">
            <Briefcase size={20} color="#0F172A" />
            <Text className="text-2xl font-bold" style={{ color: "#0F172A" }}>Estatísticas do Mês</Text>
          </View>
          <View className="flex-row gap-4">
            {/* Total de Horas */}
            <View className="flex-1">
              <TintedGlassCard>
                <View className="items-center py-4">
                  <Text className="text-4xl font-bold" style={{ color: "#0F172A" }}>{monthStats.totalHours}</Text>
                  <Text className="text-base mt-2" style={{ color: "#475569" }}>Horas Trabalhadas</Text>
                </View>
              </TintedGlassCard>
            </View>
            {/* Total de Plantões */}
            <View className="flex-1">
              <TintedGlassCard>
                <View className="items-center py-4">
                  <Text className="text-4xl font-bold" style={{ color: "#0F172A" }}>{monthStats.totalShifts}</Text>
                  <Text className="text-base mt-2" style={{ color: "#475569" }}>Plantões</Text>
                </View>
              </TintedGlassCard>
            </View>
          </View>
          {/* Distribuição de Turnos */}
          <TintedGlassCard>
            <Text className="text-lg font-semibold mb-4" style={{ color: "#0F172A" }}>Distribuição de Turnos</Text>
            <View className="gap-3">
              <View className="flex-row items-center justify-between">
                <Text className="text-base" style={{ color: "#475569" }}>Manhã (7h-13h)</Text>
                <Text className="text-lg font-bold" style={{ color: "#0F172A" }}>{monthStats.manha} plantão{monthStats.manha !== 1 ? "ões" : ""}</Text>
              </View>
              <View className="flex-row items-center justify-between">
                <Text className="text-base" style={{ color: "#475569" }}>Tarde (13h-19h)</Text>
                <Text className="text-lg font-bold" style={{ color: "#0F172A" }}>{monthStats.tarde} plantão{monthStats.tarde !== 1 ? "ões" : ""}</Text>
              </View>
              <View className="flex-row items-center justify-between">
                <Text className="text-base" style={{ color: "#475569" }}>Noite (19h-7h)</Text>
                <Text className="text-lg font-bold" style={{ color: "#0F172A" }}>{monthStats.noite} plantão{monthStats.noite !== 1 ? "ões" : ""}</Text>
              </View>
            </View>
          </TintedGlassCard>
        </View>

        {/* Configurações de Notificações */}
        <View className="gap-4">
          <View className="flex-row items-center gap-2">
            <Bell size={20} color="#0F172A" />
            <Text className="text-2xl font-bold" style={{ color: "#0F172A" }}>Notificações</Text>
          </View>
          <TintedGlassCard>
            {/* Mudanças de Escala */}
            <View className="py-4" style={{ borderBottomWidth: 1, borderBottomColor: "#E2E8F0" }}>
              <View className="flex-row items-center justify-between">
                <View className="flex-1 pr-4">
                  <Text className="text-lg font-semibold" style={{ color: "#0F172A" }}>Mudanças de Escala</Text>
                  <Text className="text-base mt-1" style={{ color: "#475569" }}>
                    Receber notificações quando uma escala for alterada ou cancelada
                  </Text>
                </View>
                <Switch
                  value={enableShiftChanges}
                  onValueChange={handleToggleShiftChanges}
                  trackColor={{ false: "#CBD5E1", true: theme.colors.primary }}
                  thumbColor="#0F172A"
                />
              </View>
            </View>

            {/* Lembretes */}
            <View className="py-4" style={{ borderBottomWidth: 1, borderBottomColor: "#E2E8F0" }}>
              <View className="flex-row items-center justify-between">
                <View className="flex-1 pr-4">
                  <Text className="text-lg font-semibold" style={{ color: "#0F172A" }}>Lembretes de Plantão</Text>
                  <Text className="text-base mt-1" style={{ color: "#475569" }}>
                    Receber lembrete 30 minutos antes do início do plantão
                  </Text>
                </View>
                <Switch
                  value={enableReminders}
                  onValueChange={handleToggleReminders}
                  trackColor={{ false: "#CBD5E1", true: theme.colors.primary }}
                  thumbColor="#0F172A"
                />
              </View>
            </View>

            {/* Notificações do HospitalAlert */}
            <View className="py-4">
              <View className="flex-row items-center justify-between">
                <View className="flex-1 pr-4">
                  <Text className="text-lg font-semibold" style={{ color: "#0F172A" }}>Integração HospitalAlert</Text>
                  <Text className="text-base mt-1" style={{ color: "#475569" }}>
                    Receber notificações do sistema HospitalAlert
                  </Text>
                </View>
                <Switch
                  value={enableHospitalAlert}
                  onValueChange={handleToggleHospitalAlert}
                  trackColor={{ false: "#CBD5E1", true: theme.colors.primary }}
                  thumbColor="#0F172A" />
              </View>
            </View>
          </TintedGlassCard>
        </View>

        {/* Status de Integração */}
        <View className="gap-4">
          <View className="flex-row items-center gap-2">
            <Link2 size={20} color="#0F172A" />
            <Text className="text-2xl font-bold" style={{ color: "#0F172A" }}>Integração</Text>
          </View>
          <TintedGlassCard>
            <View className="flex-row items-center justify-between">
              <View className="flex-row items-center gap-3">
                <View className="w-12 h-12 rounded-full items-center justify-center" style={{ backgroundColor: "rgba(59,130,246,0.3)" }}>
                  <Link2 size={24} color="#0F172A" />
                </View>
                <View>
                  <Text className="text-lg font-semibold" style={{ color: "#0F172A" }}>HospitalAlert</Text>
                  <Text className="text-base" style={{ color: "#475569" }}>Sistema de alertas hospitalares</Text>
                </View>
              </View>
              <Badge variant="success">Conectado</Badge>
            </View>
          </TintedGlassCard>
        </View>

        {/* Teste de Notificações (Modo Demo) */}
        <View className="gap-4">
          <View className="flex-row items-center gap-2">
            <Bell size={20} color="#0F172A" />
            <Text className="text-2xl font-bold" style={{ color: "#0F172A" }}>Testar Notificações</Text>
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
                <Text className="text-base font-semibold" style={{ color: "#0F172A" }}>🏥 Nova Escala</Text>
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
                <Text className="text-base font-semibold" style={{ color: "#0F172A" }}>🔄 Troca de Plantão</Text>
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
                <Text className="text-base font-semibold" style={{ color: "#0F172A" }}>❌ Cancelamento</Text>
              </TouchableOpacity>
            </View>
          </TintedGlassCard>
        </View>
                {/* Botão de Logout */}
        <TouchableOpacity
          onPress={handleLogout}
          className="rounded-2xl p-5 items-center flex-row justify-center gap-3"
          style={{ backgroundColor: "rgba(239,68,68,0.2)", borderWidth: 1, borderColor: "rgba(239,68,68,0.5)" }}
          activeOpacity={0.7}
        >
          <LogOut size={20} color="#0F172A" />
          <Text className="text-lg font-semibold" style={{ color: "#0F172A" }}>Sair</Text>
        </TouchableOpacity>

        {/* Espaçamento inferior */}
        <View className="h-8" />
      </View>
    </ScreenGradient>
  );
}

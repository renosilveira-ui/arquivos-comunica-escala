import { Text, View, TouchableOpacity, Switch } from "react-native";
import { ScreenGradient } from "@/components/ui/ScreenGradient";
import { TintedGlassCard } from "@/components/ui/TintedGlassCard";
import { Badge } from "@/components/ui/Badge";
import { useAuth, type User as AuthUser } from "@/hooks/use-auth";
import * as Haptics from "expo-haptics";
import Constants from "expo-constants";
import { trpc } from "@/lib/trpc";
import { useState, useEffect, useMemo } from "react";
import { User, Bell, Link2, LogOut, Briefcase, ArrowRightLeft, History, KeyRound } from "lucide-react-native";
import { theme } from "@/lib/theme";
import { useRouter } from "expo-router";
import { useTenantState } from "@/lib/tenant-state";
import { ScreenContainer } from "@/components/ui/ScreenContainer";
import { confirmAction } from "@/lib/ui/confirm";
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
 * Mapeia o role do usuário para um label legível em PT-BR.
 */
function roleLabel(role: AuthUser["role"] | null | undefined): string {
  switch (role) {
    case "admin":
      return "Administrador";
    case "manager":
      return "Gestor";
    case "doctor":
      return "Médico";
    case "nurse":
      return "Enfermagem";
    case "tech":
      return "Técnico";
    default:
      return "";
  }
}

/**
 * Tela de Perfil
 * Exibe informações do usuário e configurações de notificações
 */
export default function ProfileScreen() {
  const { user, logout } = useAuth();
  const router = useRouter();
  const { clearInstitutionSelection } = useTenantState();
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
      professional?.userRole === "GESTOR_MEDICO" ||
      professional?.userRole === "GESTOR_PLUS";

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

  const handleLogout = async () => {
    const confirmed = await confirmAction(
      "Sair da conta?\n\nVocê precisará fazer login novamente para acessar o app."
    );
    if (!confirmed) return;
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    try {
      await logout();
    } catch (err) {
      console.warn("[Profile] logout failed", err);
    }
  };

  const handleSwitchInstitution = async () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    await clearInstitutionSelection();
    await utils.invalidate();
    router.replace("/select-institution" as any);
  };

  if (!user) {
    return (
      <ScreenGradient scrollable={false} variant="light">
        <View className="flex-1 justify-center items-center">
          <Text className="text-lg" style={{ color: theme.colors.textSecondary }}>Faça login para continuar</Text>
        </View>
      </ScreenGradient>
    );
  }

  return (
    <ScreenGradient scrollable variant="light">
      <ScreenContainer>
      <View className="gap-7">
        {/* Header */}
        <View style={{ gap: 6 }}>
          <View className="flex-row items-center gap-3">
            <User size={28} color={theme.colors.textPrimary} />
            <Text className="text-3xl font-bold" style={{ color: theme.colors.textPrimary }}>Perfil</Text>
          </View>
          <Text style={{ color: theme.colors.textSecondary, fontSize: 15 }}>
            Dados da conta, notificações e preferências.
          </Text>
        </View>

        {/* Informações do Usuário */}
        <TintedGlassCard variant="light">
          <View className="items-center py-4">
            <View
              className="w-24 h-24 rounded-full items-center justify-center mb-4"
              style={{ backgroundColor: theme.colors.primary }}
            >
              <Text className="text-4xl font-bold" style={{ color: theme.colors.surface }}>
                {(user.name?.charAt(0) || user.email?.charAt(0) || "U").toUpperCase()}
              </Text>
            </View>
            <Text className="text-2xl font-bold" style={{ color: theme.colors.textPrimary }}>{user.name || "Usuário"}</Text>
            {user.email ? (
              <Text className="text-base mt-2" style={{ color: theme.colors.textSecondary }}>{user.email}</Text>
            ) : null}
            {roleLabel(user.role) ? (
              <Text className="text-sm mt-1" style={{ color: theme.colors.textMuted }}>{roleLabel(user.role)}</Text>
            ) : null}
          </View>
        </TintedGlassCard>


        {/* Estatísticas do Mês */}
        <View className="gap-4">
          <View className="flex-row items-center gap-2">
            <Briefcase size={20} color={theme.colors.textPrimary} />
            <Text className="text-2xl font-bold" style={{ color: theme.colors.textPrimary }}>Estatísticas do Mês</Text>
          </View>
          <View className="flex-row gap-4">
            {/* Total de Horas */}
            <View className="flex-1">
              <TintedGlassCard variant="light">
                <View className="items-center py-4">
                  <Text className="text-4xl font-bold" style={{ color: theme.colors.textPrimary }}>{monthStats.totalHours}</Text>
                  <Text className="text-base mt-2" style={{ color: theme.colors.textSecondary }}>Horas Trabalhadas</Text>
                </View>
              </TintedGlassCard>
            </View>
            {/* Total de Plantões */}
            <View className="flex-1">
              <TintedGlassCard variant="light">
                <View className="items-center py-4">
                  <Text className="text-4xl font-bold" style={{ color: theme.colors.textPrimary }}>{monthStats.totalShifts}</Text>
                  <Text className="text-base mt-2" style={{ color: theme.colors.textSecondary }}>Plantões</Text>
                </View>
              </TintedGlassCard>
            </View>
          </View>
          {/* Distribuição de Turnos */}
          <TintedGlassCard variant="light">
            <Text className="text-lg font-semibold mb-4" style={{ color: theme.colors.textPrimary }}>Distribuição de Turnos</Text>
            <View className="gap-3">
              <View className="flex-row items-center justify-between">
                <Text className="text-base" style={{ color: theme.colors.textSecondary }}>Manhã (7h-13h)</Text>
                <Text className="text-lg font-bold" style={{ color: theme.colors.textPrimary }}>{monthStats.manha} plantão{monthStats.manha !== 1 ? "ões" : ""}</Text>
              </View>
              <View className="flex-row items-center justify-between">
                <Text className="text-base" style={{ color: theme.colors.textSecondary }}>Tarde (13h-19h)</Text>
                <Text className="text-lg font-bold" style={{ color: theme.colors.textPrimary }}>{monthStats.tarde} plantão{monthStats.tarde !== 1 ? "ões" : ""}</Text>
              </View>
              <View className="flex-row items-center justify-between">
                <Text className="text-base" style={{ color: theme.colors.textSecondary }}>Noite (19h-7h)</Text>
                <Text className="text-lg font-bold" style={{ color: theme.colors.textPrimary }}>{monthStats.noite} plantão{monthStats.noite !== 1 ? "ões" : ""}</Text>
              </View>
            </View>
          </TintedGlassCard>
        </View>

        {/* Configurações de Notificações */}
        <View className="gap-4">
          <View className="flex-row items-center gap-2">
            <Bell size={20} color={theme.colors.textPrimary} />
            <Text className="text-2xl font-bold" style={{ color: theme.colors.textPrimary }}>Notificações</Text>
          </View>
          <TintedGlassCard variant="light">
            {/* Mudanças de Escala */}
            <View className="rounded-2xl p-4 mb-3" style={{ backgroundColor: theme.colors.background, borderWidth: 1, borderColor: theme.colors.border }}>
              <View className="flex-row items-center justify-between">
                <View className="flex-1 pr-4">
                  <Text className="text-lg font-semibold" style={{ color: theme.colors.textPrimary }}>Mudanças de Escala</Text>
                  <Text className="text-base mt-1" style={{ color: theme.colors.textSecondary }}>
                    Receber notificações quando uma escala for alterada ou cancelada
                  </Text>
                </View>
                <Switch
                  value={enableShiftChanges}
                  onValueChange={handleToggleShiftChanges}
                  trackColor={{ false: theme.colors.borderStrong, true: theme.colors.primary }}
                  thumbColor={theme.colors.surface}
                />
              </View>
            </View>

            {/* Lembretes */}
            <View className="rounded-2xl p-4 mb-3" style={{ backgroundColor: theme.colors.background, borderWidth: 1, borderColor: theme.colors.border }}>
              <View className="flex-row items-center justify-between">
                <View className="flex-1 pr-4">
                  <Text className="text-lg font-semibold" style={{ color: theme.colors.textPrimary }}>Lembretes de Plantão</Text>
                  <Text className="text-base mt-1" style={{ color: theme.colors.textSecondary }}>
                    Receber lembrete 30 minutos antes do início do plantão
                  </Text>
                </View>
                <Switch
                  value={enableReminders}
                  onValueChange={handleToggleReminders}
                  trackColor={{ false: theme.colors.borderStrong, true: theme.colors.primary }}
                  thumbColor={theme.colors.surface}
                />
              </View>
            </View>

            {/* Notificações do HospitalAlert */}
            <View className="rounded-2xl p-4" style={{ backgroundColor: theme.colors.background, borderWidth: 1, borderColor: theme.colors.border }}>
              <View className="flex-row items-center justify-between">
                <View className="flex-1 pr-4">
                  <Text className="text-lg font-semibold" style={{ color: theme.colors.textPrimary }}>Integração HospitalAlert</Text>
                  <Text className="text-base mt-1" style={{ color: theme.colors.textSecondary }}>
                    Receber notificações do sistema HospitalAlert
                  </Text>
                </View>
                <Switch
                  value={enableHospitalAlert}
                  onValueChange={handleToggleHospitalAlert}
                  trackColor={{ false: theme.colors.borderStrong, true: theme.colors.primary }}
                  thumbColor={theme.colors.surface} />
              </View>
            </View>
          </TintedGlassCard>
        </View>

        {/* Status de Integração */}
        <View className="gap-4">
          <View className="flex-row items-center gap-2">
            <Link2 size={20} color={theme.colors.textPrimary} />
            <Text className="text-2xl font-bold" style={{ color: theme.colors.textPrimary }}>Integração</Text>
          </View>
          <TintedGlassCard variant="light">
            <View className="flex-row items-center justify-between">
              <View className="flex-row items-center gap-3">
                <View className="w-12 h-12 rounded-full items-center justify-center" style={{ backgroundColor: theme.colors.primarySoft }}>
                  <Link2 size={24} color={theme.palette.primary[700]} />
                </View>
                <View>
                  <Text className="text-lg font-semibold" style={{ color: theme.colors.textPrimary }}>HospitalAlert</Text>
                  <Text className="text-base" style={{ color: theme.colors.textSecondary }}>Sistema de alertas hospitalares</Text>
                </View>
              </View>
              <Badge variant="success">Conectado</Badge>
            </View>
          </TintedGlassCard>
        </View>

        {/* Tenant / Instituição ativa */}
        <View className="gap-4">
          <View className="flex-row items-center gap-2">
            <Briefcase size={20} color={theme.colors.textPrimary} />
            <Text className="text-2xl font-bold" style={{ color: theme.colors.textPrimary }}>Instituição</Text>
          </View>
          <TintedGlassCard variant="light">
            <TouchableOpacity
              onPress={handleSwitchInstitution}
              className="rounded-xl p-4 items-center flex-row justify-between"
              style={{ backgroundColor: theme.colors.primarySoft, borderWidth: 1, borderColor: theme.palette.primary[200] }}
              activeOpacity={0.75}
            >
              <Text className="text-base font-semibold" style={{ color: theme.colors.textPrimary }}>Trocar instituição ativa</Text>
              <Text style={{ color: theme.palette.primary[700], fontWeight: "700" }}>Alterar</Text>
            </TouchableOpacity>
          </TintedGlassCard>
        </View>

        {/* Cessões e trocas — minhas ofertas + minhas candidaturas */}
        <View className="gap-4">
          <View className="flex-row items-center gap-2">
            <ArrowRightLeft size={20} color={theme.colors.textPrimary} />
            <Text className="text-2xl font-bold" style={{ color: theme.colors.textPrimary }}>Cessões e trocas</Text>
          </View>
          <TintedGlassCard variant="light">
            <View className="gap-3">
              <TouchableOpacity
                onPress={() => {
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  router.push("/my-offers");
                }}
                className="rounded-xl p-4 flex-row items-center justify-between"
                style={{ backgroundColor: theme.colors.background, borderWidth: 1, borderColor: theme.colors.border }}
                activeOpacity={0.75}
                accessibilityRole="button"
                accessibilityLabel="Ver minhas ofertas de cessão e troca"
              >
                <View className="flex-1 pr-4">
                  <Text className="text-base font-semibold" style={{ color: theme.colors.textPrimary }}>
                    Minhas ofertas
                  </Text>
                  <Text className="text-sm mt-1" style={{ color: theme.colors.textMuted }}>
                    Plantões que você ofereceu — aprove candidaturas aqui
                  </Text>
                </View>
                <Text style={{ color: theme.colors.primary, fontWeight: "700" }}>Abrir</Text>
              </TouchableOpacity>

              <TouchableOpacity
                onPress={() => {
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  router.push("/my-applications");
                }}
                className="rounded-xl p-4 flex-row items-center justify-between"
                style={{ backgroundColor: theme.colors.background, borderWidth: 1, borderColor: theme.colors.border }}
                activeOpacity={0.75}
                accessibilityRole="button"
                accessibilityLabel="Ver suas candidaturas a cessões e trocas"
              >
                <View className="flex-1 pr-4">
                  <Text className="text-base font-semibold" style={{ color: theme.colors.textPrimary }}>
                    Suas candidaturas
                  </Text>
                  <Text className="text-sm mt-1" style={{ color: theme.colors.textMuted }}>
                    Plantões a que você se candidatou — aguardando aprovação do dono
                  </Text>
                </View>
                <Text style={{ color: theme.colors.primary, fontWeight: "700" }}>Abrir</Text>
              </TouchableOpacity>
            </View>
          </TintedGlassCard>
        </View>

        {/* Segurança da conta */}
        <View className="gap-4">
          <View className="flex-row items-center gap-2">
            <KeyRound size={20} color={theme.colors.textPrimary} />
            <Text className="text-2xl font-bold" style={{ color: theme.colors.textPrimary }}>Segurança</Text>
          </View>
          <TintedGlassCard variant="light">
            <TouchableOpacity
              onPress={() => {
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                router.push("/change-password");
              }}
              className="rounded-xl p-4 flex-row items-center justify-between"
              style={{ backgroundColor: theme.colors.background, borderWidth: 1, borderColor: theme.colors.border }}
              activeOpacity={0.75}
              accessibilityRole="button"
              accessibilityLabel="Alterar minha senha"
            >
              <View className="flex-1 pr-4">
                <Text className="text-base font-semibold" style={{ color: theme.colors.textPrimary }}>
                  Alterar senha
                </Text>
                <Text className="text-sm mt-1" style={{ color: theme.colors.textMuted }}>
                  Trocar a senha de acesso da sua conta
                </Text>
              </View>
              <Text style={{ color: theme.colors.primary, fontWeight: "700" }}>Abrir</Text>
            </TouchableOpacity>
          </TintedGlassCard>
        </View>

        {/* Auditoria de movimentações (PR #77 backend, esta tela frontend) */}
        <View className="gap-4">
          <View className="flex-row items-center gap-2">
            <History size={20} color={theme.colors.textPrimary} />
            <Text className="text-2xl font-bold" style={{ color: theme.colors.textPrimary }}>Auditoria</Text>
          </View>
          <TintedGlassCard variant="light">
            <TouchableOpacity
              onPress={() => {
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                router.push("/audit-log");
              }}
              className="rounded-xl p-4 flex-row items-center justify-between"
              style={{ backgroundColor: theme.colors.background, borderWidth: 1, borderColor: theme.colors.border }}
              activeOpacity={0.75}
              accessibilityRole="button"
              accessibilityLabel="Ver auditoria de movimentações de plantão"
            >
              <View className="flex-1 pr-4">
                <Text className="text-base font-semibold" style={{ color: theme.colors.textPrimary }}>
                  Movimentações de plantão
                </Text>
                <Text className="text-sm mt-1" style={{ color: theme.colors.textMuted }}>
                  Quem alterou, quem foi alterado e quando — últimos 30 dias
                </Text>
              </View>
              <Text style={{ color: theme.colors.primary, fontWeight: "700" }}>Abrir</Text>
            </TouchableOpacity>
          </TintedGlassCard>
        </View>

        {/* Teste de Notificações (Modo Demo) */}
        <View className="gap-4">
          <View className="flex-row items-center gap-2">
            <Bell size={20} color={theme.colors.textPrimary} />
            <Text className="text-2xl font-bold" style={{ color: theme.colors.textPrimary }}>Testar Notificações</Text>
          </View>
          <TintedGlassCard variant="light">
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
                style={{ backgroundColor: theme.colors.successSoft, borderWidth: 1, borderColor: theme.colors.success }}
                activeOpacity={0.7}
              >
                <Text className="text-base font-semibold" style={{ color: theme.palette.success[700] }}>🏥 Nova Escala</Text>
                <Text style={{ color: theme.palette.success[700], fontWeight: "700" }}>Enviar</Text>
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
                style={{ backgroundColor: theme.colors.primarySoft, borderWidth: 1, borderColor: theme.colors.primary }}
                activeOpacity={0.7}
              >
                <Text className="text-base font-semibold" style={{ color: theme.palette.primary[900] }}>🔄 Troca de Plantão</Text>
                <Text style={{ color: theme.palette.primary[900], fontWeight: "700" }}>Enviar</Text>
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
                style={{ backgroundColor: theme.colors.dangerSoft, borderWidth: 1, borderColor: theme.colors.danger }}
                activeOpacity={0.7}
              >
                <Text className="text-base font-semibold" style={{ color: theme.palette.danger[900] }}>❌ Cancelamento</Text>
                <Text style={{ color: theme.palette.danger[900], fontWeight: "700" }}>Enviar</Text>
              </TouchableOpacity>
            </View>
          </TintedGlassCard>
        </View>
        {/* Botão de Logout */}
        <TouchableOpacity
          onPress={handleLogout}
          accessibilityRole="button"
          accessibilityLabel="Sair da conta"
          className="rounded-2xl p-5 items-center flex-row justify-center gap-3"
          style={{ backgroundColor: "transparent", borderWidth: 1, borderColor: theme.colors.danger }}
          activeOpacity={0.7}
        >
          <LogOut size={20} color={theme.colors.danger} />
          <Text className="text-lg font-semibold" style={{ color: theme.colors.danger }}>Sair</Text>
        </TouchableOpacity>

        {/* Versão do app */}
        {Constants.expoConfig?.version ? (
          <Text
            className="text-center text-xs"
            style={{ color: theme.colors.textMuted }}
          >
            v{Constants.expoConfig.version}
          </Text>
        ) : null}

        {/* Espaçamento inferior */}
        <View className="h-8" />
      </View>
      </ScreenContainer>
    </ScreenGradient>
  );
}

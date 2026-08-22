import { Text, View, TouchableOpacity, Switch, Share, Modal, TextInput, ActivityIndicator, Platform, KeyboardAvoidingView, useWindowDimensions } from "react-native";
import { ScreenGradient } from "@/components/ui/ScreenGradient";
import { TintedGlassCard } from "@/components/ui/TintedGlassCard";
import { Badge } from "@/components/ui/Badge";
import { useAuth, type User as AuthUser } from "@/hooks/use-auth";
import * as Haptics from "expo-haptics";
import Constants from "expo-constants";
import { trpc } from "@/lib/trpc";
import { useState, useMemo } from "react";
import { User, Bell, Link2, LogOut, Briefcase, ArrowRightLeft, History, KeyRound, AlertTriangle, Trash2, X, LayoutDashboard, Inbox, ShieldCheck } from "lucide-react-native";
import { theme } from "@/lib/theme";
import { useRouter } from "expo-router";
import { useTenantState } from "@/lib/tenant-state";
import { usePermissions } from "@/hooks/use-permissions";
import { ScreenContainer } from "@/components/ui/ScreenContainer";
import { confirmAction } from "@/lib/ui/confirm";
import { uiAlert, uiConfirmDestructive } from "@/lib/ui/alert";
import { authApi } from "@/lib/_core/api";
import { getLastCrash } from "@/components/AppErrorBoundary";
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
  // Gestão no celular: Painel/Solicitações/Admin saíram da barra inferior
  // (decisão do PO, 2026-08-22) e passam a ser alcançados daqui. No
  // desktop a sidebar já os lista — a seção não se repete.
  const { can, isManager } = usePermissions();
  const { width } = useWindowDimensions();
  const isDesktopWeb = Platform.OS === "web" && width >= 1024;
  const managementLinks = useMemo(
    () =>
      [
        can("view:dashboard")
          ? { key: "dashboard", title: "Painel", subtitle: "Resumo dos próximos 7 dias: vagos, pendentes e ocupados", Icon: LayoutDashboard, href: "/(tabs)/dashboard" }
          : null,
        isManager
          ? { key: "pending", title: "Solicitações", subtitle: "Trocas e cessões aguardando sua aprovação", Icon: Inbox, href: "/(tabs)/pending" }
          : null,
        can("view:admin")
          ? { key: "admin", title: "Admin", subtitle: "Usuários, cadastros pendentes e senhas", Icon: ShieldCheck, href: "/(tabs)/admin" }
          : null,
      ].filter((l): l is NonNullable<typeof l> => l !== null),
    // `can` é recriada a cada render do hook; o que muda de fato é o papel.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [isManager, user?.role],
  );
  const showManagement = !isDesktopWeb && managementLinks.length > 0;

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


  // TODO: Buscar configurações de notificação quando API estiver disponível.
  // Enquanto não há API, os valores iniciais são fixos — sem efeito de
  // sincronização (o objeto literal mudava a cada render).
  const settings = useMemo(
    () => ({
      enableShiftChanges: true,
      enableReminders: true,
      enableHospitalAlertNotifications: true,
    }),
    [],
  );

  // Estados locais para switches
  const [enableShiftChanges, setEnableShiftChanges] = useState(settings.enableShiftChanges);
  const [enableReminders, setEnableReminders] = useState(settings.enableReminders);
  const [enableHospitalAlert, setEnableHospitalAlert] = useState(settings.enableHospitalAlertNotifications);

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

  // ── Exclusão de conta (Apple 5.1.1(v)) ────────────────────────────────
  // Confirmação destrutiva → modal com senha → DELETE /api/auth/me → logout.
  const [deleteModalVisible, setDeleteModalVisible] = useState(false);
  const [deletePassword, setDeletePassword] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const handleDeleteAccountPress = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    uiConfirmDestructive(
      "Excluir minha conta?",
      "Seus dados pessoais serão removidos e você perderá o acesso ao Escala+. Esta ação não pode ser desfeita.\n\nSe você tiver plantões futuros alocados, peça ao gestor para realocá-los antes.",
      "Continuar",
      () => {
        setDeletePassword("");
        setDeleteError(null);
        setDeleteModalVisible(true);
      },
    );
  };

  const handleConfirmDeleteAccount = async () => {
    if (!deletePassword) {
      setDeleteError("Digite sua senha para confirmar.");
      return;
    }
    setDeleting(true);
    setDeleteError(null);
    try {
      const result = await authApi.deleteAccount(deletePassword);
      if (!result.ok) {
        setDeleteError(result.error ?? "Não foi possível excluir a conta.");
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        return;
      }
      setDeleteModalVisible(false);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      uiAlert("Conta excluída", "Sua conta foi removida. Sentiremos sua falta.");
      await logout();
    } catch (err) {
      console.warn("[Profile] deleteAccount failed", err);
      setDeleteError("Falha de conexão. Tente novamente.");
    } finally {
      setDeleting(false);
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
      <View style={{ gap: theme.space[6] }}>
        {/* Header */}
        <View style={{ gap: 6 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: theme.space[3] }}>
            <User size={28} color={theme.colors.textPrimary} />
            <Text style={{ ...theme.text.titleLg, fontWeight: theme.weight.bold, color: theme.colors.textPrimary }}>Perfil</Text>
          </View>
          <Text style={{ ...theme.text.body, color: theme.colors.textSecondary }}>
            Dados da conta, notificações e preferências.
          </Text>
        </View>

        {/* Informações do Usuário */}
        <TintedGlassCard variant="light">
          <View style={{ alignItems: "center", paddingVertical: theme.space[4] }}>
            <View
              style={{
                width: 96,
                height: 96,
                borderRadius: 48,
                alignItems: "center",
                justifyContent: "center",
                marginBottom: theme.space[4],
                backgroundColor: theme.colors.primary,
              }}
            >
              <Text style={{ fontSize: 34, lineHeight: 40, fontWeight: theme.weight.bold, color: theme.colors.surface }}>
                {(user.name?.charAt(0) || user.email?.charAt(0) || "U").toUpperCase()}
              </Text>
            </View>
            <Text style={{ ...theme.text.titleLg, fontWeight: theme.weight.bold, color: theme.colors.textPrimary }}>{user.name || "Usuário"}</Text>
            {user.email ? (
              <Text style={{ ...theme.text.bodyLg, color: theme.colors.textSecondary, marginTop: theme.space[2] }}>{user.email}</Text>
            ) : null}
            {roleLabel(user.role) ? (
              <Text style={{ ...theme.text.body, color: theme.colors.textMuted, marginTop: theme.space[1] }}>{roleLabel(user.role)}</Text>
            ) : null}
          </View>
        </TintedGlassCard>


        {/* Estatísticas do Mês */}
        <View style={{ gap: theme.space[4] }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: theme.space[2] }}>
            <Briefcase size={20} color={theme.colors.textPrimary} />
            <Text style={{ ...theme.text.title, fontWeight: theme.weight.bold, color: theme.colors.textPrimary }}>Estatísticas do Mês</Text>
          </View>
          <View style={{ flexDirection: "row", gap: theme.space[4] }}>
            {/* Total de Horas */}
            <View style={{ flex: 1 }}>
              <TintedGlassCard variant="light">
                <View style={{ alignItems: "center", paddingVertical: theme.space[4] }}>
                  <Text style={{ ...theme.text.display, fontWeight: theme.weight.bold, color: theme.colors.textPrimary }}>{monthStats.totalHours}</Text>
                  <Text style={{ ...theme.text.body, color: theme.colors.textSecondary, marginTop: theme.space[2] }}>Horas Trabalhadas</Text>
                </View>
              </TintedGlassCard>
            </View>
            {/* Total de Plantões */}
            <View style={{ flex: 1 }}>
              <TintedGlassCard variant="light">
                <View style={{ alignItems: "center", paddingVertical: theme.space[4] }}>
                  <Text style={{ ...theme.text.display, fontWeight: theme.weight.bold, color: theme.colors.textPrimary }}>{monthStats.totalShifts}</Text>
                  <Text style={{ ...theme.text.body, color: theme.colors.textSecondary, marginTop: theme.space[2] }}>Plantões</Text>
                </View>
              </TintedGlassCard>
            </View>
          </View>
          {/* Distribuição de Turnos */}
          <TintedGlassCard variant="light">
            <Text style={{ ...theme.text.title, fontWeight: theme.weight.semibold, color: theme.colors.textPrimary, marginBottom: theme.space[4] }}>Distribuição de Turnos</Text>
            <View style={{ gap: theme.space[3] }}>
              <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
                <Text style={{ ...theme.text.bodyLg, color: theme.colors.textSecondary }}>Manhã (7h-13h)</Text>
                <Text style={{ ...theme.text.title, fontWeight: theme.weight.bold, color: theme.colors.textPrimary }}>{monthStats.manha} plantão{monthStats.manha !== 1 ? "ões" : ""}</Text>
              </View>
              <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
                <Text style={{ ...theme.text.bodyLg, color: theme.colors.textSecondary }}>Tarde (13h-19h)</Text>
                <Text style={{ ...theme.text.title, fontWeight: theme.weight.bold, color: theme.colors.textPrimary }}>{monthStats.tarde} plantão{monthStats.tarde !== 1 ? "ões" : ""}</Text>
              </View>
              <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
                <Text style={{ ...theme.text.bodyLg, color: theme.colors.textSecondary }}>Noite (19h-7h)</Text>
                <Text style={{ ...theme.text.title, fontWeight: theme.weight.bold, color: theme.colors.textPrimary }}>{monthStats.noite} plantão{monthStats.noite !== 1 ? "ões" : ""}</Text>
              </View>
            </View>
          </TintedGlassCard>
        </View>

        {/* Configurações de Notificações */}
        <View style={{ gap: theme.space[4] }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: theme.space[2] }}>
            <Bell size={20} color={theme.colors.textPrimary} />
            <Text style={{ ...theme.text.title, fontWeight: theme.weight.bold, color: theme.colors.textPrimary }}>Notificações</Text>
          </View>
          <TintedGlassCard variant="light">
            {/* Mudanças de Escala */}
            <View style={profileRowCardStyle}>
              <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
                <View style={{ flex: 1, paddingRight: theme.space[4] }}>
                  <Text style={{ ...theme.text.title, fontWeight: theme.weight.semibold, color: theme.colors.textPrimary }}>Mudanças de Escala</Text>
                  <Text style={{ ...theme.text.body, color: theme.colors.textSecondary, marginTop: theme.space[1] }}>
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
            <View style={profileRowCardStyle}>
              <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
                <View style={{ flex: 1, paddingRight: theme.space[4] }}>
                  <Text style={{ ...theme.text.title, fontWeight: theme.weight.semibold, color: theme.colors.textPrimary }}>Lembretes de Plantão</Text>
                  <Text style={{ ...theme.text.body, color: theme.colors.textSecondary, marginTop: theme.space[1] }}>
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
            <View style={[profileRowCardStyle, { marginBottom: 0 }]}>
              <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
                <View style={{ flex: 1, paddingRight: theme.space[4] }}>
                  <Text style={{ ...theme.text.title, fontWeight: theme.weight.semibold, color: theme.colors.textPrimary }}>Integração HospitalAlert</Text>
                  <Text style={{ ...theme.text.body, color: theme.colors.textSecondary, marginTop: theme.space[1] }}>
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
        <View style={{ gap: theme.space[4] }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: theme.space[2] }}>
            <Link2 size={20} color={theme.colors.textPrimary} />
            <Text style={{ ...theme.text.title, fontWeight: theme.weight.bold, color: theme.colors.textPrimary }}>Integração</Text>
          </View>
          <TintedGlassCard variant="light">
            <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: theme.space[3] }}>
                <View style={{ width: 48, height: 48, borderRadius: 24, alignItems: "center", justifyContent: "center", backgroundColor: theme.colors.primarySoft }}>
                  <Link2 size={24} color={theme.palette.primary[700]} />
                </View>
                <View>
                  <Text style={{ ...theme.text.title, fontWeight: theme.weight.semibold, color: theme.colors.textPrimary }}>HospitalAlert</Text>
                  <Text style={{ ...theme.text.body, color: theme.colors.textSecondary }}>Sistema de alertas hospitalares</Text>
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

        {/* Gestão (só celular, só gestor/admin) — ver _layout.tsx */}
        {showManagement ? (
          <View className="gap-4">
            <View className="flex-row items-center gap-2">
              <LayoutDashboard size={20} color={theme.colors.textPrimary} />
              <Text className="text-2xl font-bold" style={{ color: theme.colors.textPrimary }}>Gestão</Text>
            </View>
            <TintedGlassCard variant="light">
              <View className="gap-3">
                {managementLinks.map((link) => (
                  <TouchableOpacity
                    key={link.key}
                    onPress={() => {
                      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                      router.push(link.href as any);
                    }}
                    className="rounded-xl p-4 flex-row items-center justify-between"
                    style={{ backgroundColor: theme.colors.background, borderWidth: 1, borderColor: theme.colors.border }}
                    activeOpacity={0.75}
                    accessibilityRole="button"
                    accessibilityLabel={`Abrir ${link.title}`}
                  >
                    <View className="flex-row items-center gap-3 flex-1 pr-4">
                      <link.Icon size={20} color={theme.colors.primary} />
                      <View className="flex-1">
                        <Text className="text-base font-semibold" style={{ color: theme.colors.textPrimary }}>
                          {link.title}
                        </Text>
                        <Text className="text-sm mt-1" style={{ color: theme.colors.textMuted }}>
                          {link.subtitle}
                        </Text>
                      </View>
                    </View>
                    <Text style={{ color: theme.colors.primary, fontWeight: "700" }}>Abrir</Text>
                  </TouchableOpacity>
                ))}
              </View>
            </TintedGlassCard>
          </View>
        ) : null}

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

        {/* Diagnóstico — último erro registrado no aparelho.
            Instrumentação de estabilidade (2026-08-18): o AppErrorBoundary
            e o handler global persistem o último crash; aqui o usuário
            consegue ver e compartilhar o registro para suporte. */}
        <View className="gap-4">
          <View className="flex-row items-center gap-2">
            <AlertTriangle size={20} color={theme.colors.textPrimary} />
            <Text className="text-2xl font-bold" style={{ color: theme.colors.textPrimary }}>Diagnóstico</Text>
          </View>
          <TintedGlassCard variant="light">
            <TouchableOpacity
              onPress={async () => {
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                const crash = await getLastCrash();
                if (!crash) {
                  uiAlert("Diagnóstico", "Nenhum erro registrado neste aparelho. 👍");
                  return;
                }
                try {
                  await Share.share({ message: `Escala+ diagnóstico:\n${crash}` });
                } catch {
                  uiAlert("Último erro registrado", crash.slice(0, 1200));
                }
              }}
              className="rounded-xl p-4 flex-row items-center justify-between"
              style={{ backgroundColor: theme.colors.background, borderWidth: 1, borderColor: theme.colors.border }}
              activeOpacity={0.75}
              accessibilityRole="button"
              accessibilityLabel="Ver e compartilhar o último erro registrado"
            >
              <View className="flex-1 pr-4">
                <Text className="text-base font-semibold" style={{ color: theme.colors.textPrimary }}>
                  Último erro registrado
                </Text>
                <Text className="text-sm mt-1" style={{ color: theme.colors.textMuted }}>
                  Se o app fechou sozinho, toque aqui e compartilhe o registro com o suporte
                </Text>
              </View>
              <Text style={{ color: theme.colors.primary, fontWeight: "700" }}>Ver</Text>
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
        {/* Conta — exclusão (Apple 5.1.1(v)) */}
        <View style={{ gap: theme.space[4] }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: theme.space[2] }}>
            <Trash2 size={20} color={theme.colors.textPrimary} />
            <Text style={{ ...theme.text.titleLg, fontWeight: theme.weight.bold, color: theme.colors.textPrimary }}>
              Conta
            </Text>
          </View>
          <TintedGlassCard variant="light">
            <TouchableOpacity
              onPress={handleDeleteAccountPress}
              activeOpacity={0.75}
              accessibilityRole="button"
              accessibilityLabel="Excluir minha conta"
              style={{
                borderRadius: theme.radius.lg,
                padding: theme.space[4],
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "space-between",
                backgroundColor: theme.colors.dangerSoft,
                borderWidth: 1,
                borderColor: theme.colors.danger,
              }}
            >
              <View style={{ flex: 1, paddingRight: theme.space[4] }}>
                <Text style={{ ...theme.text.bodyLg, fontWeight: theme.weight.semibold, color: theme.palette.danger[900] }}>
                  Excluir minha conta
                </Text>
                <Text style={{ ...theme.text.body, marginTop: theme.space[1], color: theme.palette.danger[900] }}>
                  Remove seus dados pessoais e encerra o acesso. Não pode ser desfeito.
                </Text>
              </View>
              <Text style={{ color: theme.palette.danger[900], fontWeight: theme.weight.bold }}>Excluir</Text>
            </TouchableOpacity>
          </TintedGlassCard>
        </View>

        {/* Modal: confirmar exclusão com senha */}
        <Modal
          visible={deleteModalVisible}
          transparent
          animationType="fade"
          onRequestClose={() => !deleting && setDeleteModalVisible(false)}
        >
          <KeyboardAvoidingView
            behavior={Platform.OS === "ios" ? "padding" : undefined}
            style={{
              flex: 1,
              justifyContent: "center",
              alignItems: "center",
              backgroundColor: theme.colors.overlay,
              padding: theme.space[4],
            }}
          >
            <View
              style={{
                width: "100%",
                maxWidth: 420,
                backgroundColor: theme.colors.surface,
                borderRadius: theme.radius.xl,
                padding: theme.space[6],
                gap: theme.space[4],
              }}
            >
              <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
                <Text style={{ ...theme.text.title, fontWeight: theme.weight.bold, color: theme.colors.textPrimary }}>
                  Confirme com sua senha
                </Text>
                <TouchableOpacity
                  onPress={() => setDeleteModalVisible(false)}
                  disabled={deleting}
                  hitSlop={12}
                  accessibilityRole="button"
                  accessibilityLabel="Fechar"
                >
                  <X size={22} color={theme.colors.textSecondary} />
                </TouchableOpacity>
              </View>
              <Text style={{ ...theme.text.body, color: theme.colors.textSecondary }}>
                Para excluir a conta de {user.email ?? "usuário"}, digite sua senha atual.
              </Text>
              <TextInput
                value={deletePassword}
                onChangeText={setDeletePassword}
                secureTextEntry
                autoComplete="current-password"
                autoFocus
                returnKeyType="done"
                onSubmitEditing={handleConfirmDeleteAccount}
                placeholder="Sua senha"
                placeholderTextColor={theme.colors.textMuted}
                accessibilityLabel="Senha atual"
                style={{
                  backgroundColor: theme.colors.surface,
                  color: theme.colors.textPrimary,
                  borderRadius: theme.radius.md,
                  borderWidth: 1.5,
                  borderColor: deleteError ? theme.colors.danger : theme.colors.border,
                  paddingHorizontal: theme.space[4],
                  paddingVertical: theme.space[3],
                  ...theme.text.bodyLg,
                }}
              />
              {deleteError ? (
                <View
                  style={{
                    backgroundColor: theme.colors.dangerSoft,
                    borderRadius: theme.radius.md,
                    padding: theme.space[3],
                    flexDirection: "row",
                    alignItems: "center",
                    gap: theme.space[2],
                  }}
                >
                  <AlertTriangle size={18} color={theme.palette.danger[600]} />
                  <Text style={{ ...theme.text.body, color: theme.palette.danger[600], flex: 1 }}>
                    {deleteError}
                  </Text>
                </View>
              ) : null}
              <TouchableOpacity
                onPress={handleConfirmDeleteAccount}
                disabled={deleting}
                activeOpacity={0.85}
                accessibilityRole="button"
                accessibilityLabel="Excluir conta definitivamente"
                style={{
                  backgroundColor: theme.colors.danger,
                  borderRadius: theme.radius.md,
                  padding: theme.space[4],
                  alignItems: "center",
                  flexDirection: "row",
                  justifyContent: "center",
                  gap: theme.space[2],
                  opacity: deleting ? 0.7 : 1,
                }}
              >
                {deleting ? (
                  <ActivityIndicator color={theme.colors.surface} />
                ) : (
                  <>
                    <Trash2 size={18} color={theme.colors.surface} />
                    <Text style={{ ...theme.text.bodyLg, fontWeight: theme.weight.bold, color: theme.colors.surface }}>
                      Excluir conta
                    </Text>
                  </>
                )}
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => setDeleteModalVisible(false)}
                disabled={deleting}
                activeOpacity={0.7}
                accessibilityRole="button"
                style={{ alignItems: "center", padding: theme.space[2] }}
              >
                <Text style={{ ...theme.text.body, fontWeight: theme.weight.semibold, color: theme.colors.textSecondary }}>
                  Cancelar
                </Text>
              </TouchableOpacity>
            </View>
          </KeyboardAvoidingView>
        </Modal>

        {/* Botão de Logout */}
        <TouchableOpacity
          onPress={handleLogout}
          accessibilityRole="button"
          accessibilityLabel="Sair da conta"
          style={{
            borderRadius: theme.radius.lg,
            padding: theme.space[5],
            alignItems: "center",
            flexDirection: "row",
            justifyContent: "center",
            gap: theme.space[3],
            backgroundColor: "transparent",
            borderWidth: 1,
            borderColor: theme.colors.danger,
          }}
          activeOpacity={0.7}
        >
          <LogOut size={20} color={theme.colors.danger} />
          <Text style={{ ...theme.text.title, fontWeight: theme.weight.semibold, color: theme.colors.danger }}>Sair</Text>
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

const profileRowCardStyle = {
  backgroundColor: theme.colors.background,
  borderWidth: 1,
  borderColor: theme.colors.border,
  borderRadius: theme.radius.lg,
  padding: theme.space[4],
  marginBottom: theme.space[3],
};

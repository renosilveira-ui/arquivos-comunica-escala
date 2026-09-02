// app/(tabs)/profile.tsx — Perfil.
//
// Redesign 23/08 (proposta de design, Claude Design). O que mudou e por quê:
//
// 1. Onze pares "cabeçalho 24px + TintedGlassCard" viraram QUATRO grupos com
//    um padrão único de linha (ListRow): Gestão · Sua atividade ·
//    Notificações · Conta e app, mais a zona de risco no fim. Onze títulos
//    do mesmo peso na mesma tela é uma lista de configurações sem hierarquia.
// 2. Gestão subiu para o topo. Painel/Solicitações/Admin saíram da barra
//    inferior (PO, 2026-08-22), então é a razão pela qual um gestor abre esta
//    tela — estava em sexto lugar.
// 3. O avatar de 96px centralizado (com nome, e-mail e papel empilhados)
//    consumia quase metade da primeira tela. Em 56px na horizontal, o mesmo
//    card ainda carrega as horas do mês e a distribuição de turnos acima dos
//    812pt.
// 4. TintedGlassCard → Surface. Blur é iOS-only; Android já caía para o
//    fallback opaco, então a mesma tela tinha duas aparências.
// 5. "Integração" e "Diagnóstico" deixaram de ser seções com cabeçalho para
//    carregar uma linha cada: viraram linhas em Notificações e Conta e app.
// 6. "Testar Notificações" removido (PR #232) — disparava push falso em build
//    de produção.
// 7. Estados: skeleton com a forma do conteúdo, e erro LOCAL ao bloco do mês
//    (listByPeriod falhar não derruba identidade nem as rotas de gestão).

import { useMemo, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Share,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  useWindowDimensions,
} from "react-native";
import {
  AlertTriangle,
  Bell,
  Building2,
  CalendarDays,
  History,
  Inbox,
  KeyRound,
  LayoutDashboard,
  Link2,
  LogOut,
  MessageCircle,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react-native";
import Constants from "expo-constants";
import * as Haptics from "expo-haptics";
import { useRouter } from "expo-router";

import { ScreenGradient } from "@/components/ui/ScreenGradient";
import { ScreenContainer } from "@/components/ui/ScreenContainer";
import { Surface } from "@/components/ui/Surface";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { ListRow } from "@/components/ui/ListRow";
import { Badge } from "@/components/ui/Badge";
import { Skeleton } from "@/components/ui/Skeleton";
import { AppButton } from "@/components/ui/AppButton";
import { getLastCrash } from "@/components/AppErrorBoundary";
import { useAuth } from "@/hooks/use-auth";
import { useLogoutAction } from "@/hooks/use-logout-action";
import { usePermissions } from "@/hooks/use-permissions";
import { theme } from "@/lib/theme";
import { trpc } from "@/lib/trpc";
import { useTenantState } from "@/lib/tenant-state";
import { isAccountDeletionLocalCleanupError } from "@/lib/session-cleanup";
import { uiAlert, uiConfirmDestructive } from "@/lib/ui/alert";
import {
  canManageScheduleInvites,
  profileRoleBadgeLabel,
  SCHEDULE_INVITE_SUBTITLE,
} from "@/lib/institution-roles";
import {
  actionableBadgeAccessibilityLabel,
  actionableBadgeValue,
  combineActionableBadgeStates,
  deriveActionableBadgeState,
} from "@/lib/actionable-badge";

function toDateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

const MONTH_LABELS = [
  "janeiro", "fevereiro", "março", "abril", "maio", "junho",
  "julho", "agosto", "setembro", "outubro", "novembro", "dezembro",
];

export default function ProfileScreen() {
  const { user, deleteAccount } = useAuth();
  const { isLoggingOut, requestLogout } = useLogoutAction({
    scope: "Profile",
    confirmMessage:
      "Sair da conta?\n\nVocê precisará fazer login novamente para acessar o app.",
  });
  const router = useRouter();
  const { clearInstitutionSelection } = useTenantState();
  const utils = trpc.useUtils();
  const { can, isManager, canApproveAssignments, isGlobalAdmin, roleInInstitution } =
    usePermissions();
  const { width } = useWindowDimensions();
  const isDesktopWeb = Platform.OS === "web" && width >= 1024;

  const profileRoleLabel = profileRoleBadgeLabel({
    isGlobalAdmin,
    roleInInstitution,
    legacyGlobalRole: user?.role,
  });
  const showScheduleInvites = canManageScheduleInvites({
    isGlobalAdmin,
    roleInInstitution,
  });
  const { data: whatsappContact } = trpc.profile.getWhatsAppContact.useQuery(
    undefined,
    { staleTime: 30_000 },
  );

  const managementLinks = useMemo(
    () =>
      [
        can("view:dashboard")
          ? {
              key: "dashboard",
              title: "Painel",
              subtitle: "Próximos 7 dias: vagos, pendentes e ocupados",
              Icon: LayoutDashboard,
              tone: "brand" as const,
              href: "/(tabs)/dashboard",
            }
          : null,
        canApproveAssignments
          ? {
              key: "pending",
              title: "Solicitações",
              subtitle: "Trocas e cessões aguardando sua aprovação",
              Icon: Inbox,
              tone: "warning" as const,
              href: "/(tabs)/pending",
            }
          : null,
        can("view:admin")
          ? {
              key: "admin",
              title: "Admin",
              subtitle: "Usuários, cadastros pendentes e senhas",
              Icon: ShieldCheck,
              tone: "default" as const,
              href: "/(tabs)/admin",
            }
          : null,
        showScheduleInvites
          ? {
              key: "invites",
              title: "Convites da escala",
              subtitle: SCHEDULE_INVITE_SUBTITLE,
              Icon: Link2,
              tone: "default" as const,
              href: "/schedule-invites",
            }
          : null,
      ].filter((l): l is NonNullable<typeof l> => l !== null),
    [can, canApproveAssignments, showScheduleInvites],
  );
  const showManagement = !isDesktopWeb && managementLinks.length > 0;

  // Fila de aprovação do gestor — mesma procedure da tela Solicitações.
  // `listPending` já aplica papel e jurisdição no servidor (gestor de hospital
  // vê só o próprio manager_scope). A admissão é a capability granular da
  // própria ação; um sinal amplo de "gestor" não substitui essa prova.
  // Para USER a query responde FORBIDDEN e viraria toast de erro. No desktop web o
  // grupo Gestão não existe (vai para a sidebar), então nem consulta. NÃO usar
  // filters.summaryCounts.pendingByHospital — aquele é filtrado por "hoje" e
  // não representa a fila inteira.
  const {
    data: pendingAssignments,
    isError: pendingAssignmentsHasError,
  } = trpc.shiftAssignments.listPending.useQuery(
    {},
    {
      enabled: !!user?.id && canApproveAssignments && !isDesktopWeb,
      staleTime: 60_000,
    },
  );
  const assignmentBadgeState = deriveActionableBadgeState({
    count: pendingAssignments?.length,
    hasError: pendingAssignmentsHasError,
  });
  const {
    data: actionableSwapCount,
    isError: actionableSwapCountHasError,
  } = trpc.swaps.countActionable.useQuery(undefined, {
    enabled: !!user?.id && canApproveAssignments && !isDesktopWeb,
    staleTime: 15_000,
  });
  const swapBadgeState = deriveActionableBadgeState({
    count: actionableSwapCount?.swapOffers,
    hasError: actionableSwapCountHasError,
  });
  const pendingBadgeState = combineActionableBadgeStates([
    assignmentBadgeState,
    swapBadgeState,
  ]);
  const pendingBadge = actionableBadgeValue(pendingBadgeState, 99);

  // ── Estatísticas do mês atual ──────────────────────────────────────────
  const now = new Date();
  const monthStart = toDateKey(new Date(now.getFullYear(), now.getMonth(), 1));
  const monthEnd = toDateKey(new Date(now.getFullYear(), now.getMonth() + 1, 1));
  const monthName = MONTH_LABELS[now.getMonth()];

  const { data: professional } = trpc.professionals.getByUserId.useQuery(
    { userId: user?.id ?? 0 },
    { enabled: !!user?.id },
  );

  const monthQuery = trpc.shifts.listByPeriod.useQuery(
    { startDate: monthStart, endDate: monthEnd },
    { enabled: !!user?.id },
  );

  const monthStats = useMemo(() => {
    const empty = { totalHours: 0, totalShifts: 0, manha: 0, tarde: 0, noite: 0 };
    if (!monthQuery.data) return empty;

    const relevant = (monthQuery.data as any[]).filter((shift) => {
      if (isManager) return true;
      return (shift.assignments as any[]).some(
        (a: any) => a.professionalId === professional?.id && a.isActive,
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

    return { totalHours: Math.round(totalHours), totalShifts: relevant.length, manha, tarde, noite };
  }, [isManager, monthQuery.data, professional]);

  // ── Notificações ───────────────────────────────────────────────────────
  // TODO: sem API ainda — valores iniciais fixos, sem efeito de sincronização.
  const [enableShiftChanges, setEnableShiftChanges] = useState(true);
  const [enableReminders, setEnableReminders] = useState(true);
  const [enableHospitalAlert, setEnableHospitalAlert] = useState(true);

  const updateSettings = (data: Record<string, unknown>) => {
    // TODO: mutation quando a API existir.
    console.log("Atualizar configurações:", data);
  };

  const toggleWithHaptic = (setter: (v: boolean) => void, key: string) => (value: boolean) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setter(value);
    updateSettings({ userId: user?.id ?? 0, [key]: value });
  };

  const go = (href: string) => () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    router.push(href as any);
  };

  const handleSwitchInstitution = async () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    await clearInstitutionSelection();
    await utils.invalidate();
    router.replace("/select-institution" as any);
  };

  const handleShowCrash = async () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const crash = await getLastCrash();
    if (!crash) {
      uiAlert("Diagnóstico", "Nenhum erro registrado neste aparelho.");
      return;
    }
    try {
      await Share.share({ message: `Escala+ diagnóstico:\n${crash}` });
    } catch {
      uiAlert("Último erro registrado", crash.slice(0, 1200));
    }
  };

  // ── Exclusão de conta (Apple 5.1.1(v)) ────────────────────────────────
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
      const result = await deleteAccount(deletePassword);
      if (!result.ok) {
        setDeleteError(result.error ?? "Não foi possível excluir a conta.");
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        return;
      }
      setDeleteModalVisible(false);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      uiAlert("Conta excluída", "Sua conta foi removida. Sentiremos sua falta.");
    } catch (err) {
      console.warn("[Profile] deleteAccount failed", err);
      if (isAccountDeletionLocalCleanupError(err)) {
        setDeleteModalVisible(false);
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
        uiAlert(
          "Conta excluída",
          "Sua conta foi removida, mas a limpeza deste aparelho ficou incompleta. Feche e reabra o app antes de entrar com outra conta.",
        );
        return;
      }
      setDeleteError("Falha de conexão. Tente novamente.");
    } finally {
      setDeleting(false);
    }
  };

  if (!user) {
    return (
      <ScreenGradient scrollable={false} variant="light">
        <View style={{ flex: 1, justifyContent: "center", alignItems: "center" }}>
          <Text style={{ ...theme.text.bodyLg, color: theme.colors.textSecondary }}>
            Faça login para continuar
          </Text>
        </View>
      </ScreenGradient>
    );
  }

  const initial = (user.name?.charAt(0) || user.email?.charAt(0) || "U").toUpperCase();

  return (
    <ScreenGradient scrollable variant="light">
      <ScreenContainer>
        <View style={{ gap: theme.space[5] }}>
          {/* ── Identidade + mês (raised: é o único bloco que sobe) ── */}
          <Surface level="raised" padded={false}>
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: theme.space[3],
                padding: theme.space[4],
                borderBottomWidth: 1,
                borderBottomColor: theme.colors.border,
              }}
            >
              <View
                style={{
                  width: 56,
                  height: 56,
                  borderRadius: theme.radius.lg,
                  backgroundColor: theme.colors.brand,
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <Text
                  style={{
                    ...theme.text.titleLg,
                    fontWeight: theme.weight.bold,
                    color: theme.colors.surface,
                  }}
                >
                  {initial}
                </Text>
              </View>
              <View style={{ flex: 1, gap: theme.space[1] }}>
                <Text
                  numberOfLines={1}
                  style={{ ...theme.text.title, fontWeight: theme.weight.bold, color: theme.colors.textPrimary }}
                >
                  {user.name || "Usuário"}
                </Text>
                {user.email ? (
                  <Text numberOfLines={1} style={{ ...theme.text.caption, color: theme.colors.textSecondary }}>
                    {user.email}
                  </Text>
                ) : null}
                {profileRoleLabel ? (
                  <View style={{ alignSelf: "flex-start", marginTop: theme.space[1] }}>
                    <Badge variant="info" label={profileRoleLabel} />
                  </View>
                ) : null}
              </View>
            </View>

            {/* Mês: skeleton → erro local → dados. Erro NUNCA vira zero. */}
            <View style={{ padding: theme.space[4], gap: theme.space[3] }}>
              {monthQuery.isLoading ? (
                <View style={{ gap: theme.space[3] }}>
                  <View style={{ flexDirection: "row", gap: theme.space[4] }}>
                    <View style={{ flex: 1, gap: theme.space[2] }}>
                      <Skeleton width="70%" height={theme.space[3]} />
                      <Skeleton width="45%" height={theme.space[6]} />
                    </View>
                    <View style={{ flex: 1, gap: theme.space[2] }}>
                      <Skeleton width="60%" height={theme.space[3]} />
                      <Skeleton width="40%" height={theme.space[6]} />
                    </View>
                  </View>
                  <View style={{ flexDirection: "row", gap: theme.space[2] }}>
                    {[0, 1, 2].map((i) => (
                      <Skeleton key={i} height={theme.space[10]} radius={theme.radius.md} />
                    ))}
                  </View>
                </View>
              ) : monthQuery.isError && !monthQuery.data ? (
                <View
                  style={{
                    backgroundColor: theme.colors.warningSoft,
                    borderWidth: 1,
                    borderColor: theme.palette.warning[100],
                    borderLeftWidth: 4,
                    borderLeftColor: theme.palette.warning[700],
                    borderRadius: theme.radius.lg,
                    padding: theme.space[4],
                    gap: theme.space[3],
                  }}
                >
                  <Text
                    style={{
                      ...theme.text.titleSm,
                      fontWeight: theme.weight.semibold,
                      color: theme.palette.warning[900],
                    }}
                  >
                    Não foi possível carregar suas horas de {monthName}
                  </Text>
                  <Text style={{ ...theme.text.caption, color: theme.palette.warning[900] }}>
                    Seus dados de conta continuam disponíveis. Só o resumo do mês falhou.
                  </Text>
                  <AppButton
                    title="Tentar novamente"
                    onPress={() => monthQuery.refetch()}
                    size="md"
                    fullWidth={false}
                    style={{ alignSelf: "flex-start", backgroundColor: theme.colors.brand }}
                  />
                </View>
              ) : (
                <>
                  <View style={{ flexDirection: "row", gap: theme.space[4] }}>
                    <StatBlock label={`Horas em ${monthName}`} value={monthStats.totalHours} unit="h" />
                    <StatBlock label="Plantões" value={monthStats.totalShifts} unit="no mês" />
                  </View>
                  <View style={{ flexDirection: "row", gap: theme.space[2] }}>
                    <TurnBlock label="Manhã" hours="7–13" value={monthStats.manha} />
                    <TurnBlock label="Tarde" hours="13–19" value={monthStats.tarde} />
                    <TurnBlock label="Noite" hours="19–7" value={monthStats.noite} />
                  </View>
                </>
              )}
            </View>
          </Surface>

          {/* ── Gestão (só celular, só gestor/admin) ── */}
          {showManagement ? (
            <View style={{ gap: theme.space[2] }}>
              <SectionHeader
                title="Gestão"
                eyebrow="Sua equipe"
                action={<Badge variant="info" label="Só gestor" />}
              />
              <Surface padded={false}>
                {managementLinks.map((link, i) => (
                  <ListRow
                    key={link.key}
                    title={link.title}
                    subtitle={
                      link.key === "pending" && pendingBadgeState.status === "UNAVAILABLE"
                        ? "Não foi possível atualizar a contagem; abra para verificar"
                        : link.key === "pending" && pendingBadgeState.status === "STALE"
                          ? "Contagem desatualizada; abra para conferir"
                          : link.subtitle
                    }
                    Icon={link.Icon}
                    tone={link.tone}
                    divided={i > 0}
                    // Solicitações agrega trocas acionáveis + alocações;
                    // zero confirmado some e fonte indisponível vira "!".
                    value={link.key === "pending" && pendingBadge !== undefined ? String(pendingBadge) : undefined}
                    valueTone="count"
                    onPress={go(link.href)}
                    accessibilityLabel={
                      link.key === "pending"
                        ? actionableBadgeAccessibilityLabel(
                            "Abrir Solicitações",
                            pendingBadgeState,
                          )
                        : `Abrir ${link.title}`
                    }
                  />
                ))}
              </Surface>
              <Text style={{ ...theme.text.caption, color: theme.colors.textMuted }}>
                No desktop a sidebar já lista estes — a seção não se repete.
              </Text>
            </View>
          ) : null}

          {/* Trocas e candidaturas vivem na aba Trocas; Perfil mantém só auditoria. */}
          <View style={{ gap: theme.space[2] }}>
            <SectionHeader title="Sua atividade" eyebrow="Rastreabilidade" />
            <Surface padded={false}>
              <ListRow
                title="Movimentações de plantão"
                subtitle="Quem alterou, quem foi alterado e quando — últimos 30 dias"
                Icon={History}
                divided={false}
                onPress={go("/audit-log")}
                accessibilityLabel="Ver auditoria de movimentações de plantão"
              />
            </Surface>
          </View>

          {/* ── Notificações (Integração virou a terceira linha) ── */}
          <View style={{ gap: theme.space[2] }}>
            <SectionHeader title="Notificações" eyebrow="Avisos" />
            <Surface padded={false}>
              <ListRow
                title="Mudanças de escala"
                subtitle="Quando uma escala for alterada ou cancelada"
                Icon={CalendarDays}
                divided={false}
                toggle={{
                  value: enableShiftChanges,
                  onValueChange: toggleWithHaptic(setEnableShiftChanges, "enableShiftChanges"),
                }}
              />
              <ListRow
                title="Lembrete de plantão"
                subtitle="30 minutos antes do início"
                Icon={Bell}
                toggle={{
                  value: enableReminders,
                  onValueChange: toggleWithHaptic(setEnableReminders, "enableReminders"),
                }}
              />
              <ListRow
                title="Comunica+"
                subtitle="Alertas do sistema hospitalar"
                Icon={Link2}
                tone="success"
                toggle={{ value: enableHospitalAlert, onValueChange: setEnableHospitalAlert }}
              />
            </Surface>
          </View>

          {/* ── Conta e app (Instituição, Segurança e Diagnóstico juntos) ── */}
          <View style={{ gap: theme.space[2] }}>
            <SectionHeader title="Conta e app" eyebrow="Preferências" />
            <Surface padded={false}>
              {isDesktopWeb && showScheduleInvites ? (
                <ListRow
                  title="Convites da escala"
                  subtitle={SCHEDULE_INVITE_SUBTITLE}
                  Icon={Link2}
                  divided={false}
                  onPress={go("/schedule-invites")}
                  accessibilityLabel="Enviar convites da escala"
                />
              ) : null}
              <ListRow
                title="Entrar em outra escala"
                subtitle="Use o convite de 24 horas que o gestor enviou por e-mail."
                Icon={KeyRound}
                divided={isDesktopWeb && showScheduleInvites}
                onPress={go("/join-schedule")}
                accessibilityLabel="Entrar em outra escala com um convite"
              />
              <ListRow
                title="Instituição ativa"
                subtitle="Trocar a instituição em uso neste aparelho"
                Icon={Building2}
                value="Alterar"
                valueTone="action"
                onPress={handleSwitchInstitution}
                accessibilityLabel="Trocar instituição ativa"
              />
              <ListRow
                title="Alterar senha"
                Icon={KeyRound}
                onPress={go("/change-password")}
                accessibilityLabel="Alterar minha senha"
              />
              <ListRow
                title="WhatsApp"
                subtitle={
                  whatsappContact?.status === "verified"
                    ? `Verificado · ${whatsappContact.maskedAddress}`
                    : whatsappContact?.status === "unverified"
                      ? `Não verificado · ${whatsappContact.maskedAddress}`
                      : "Cadastrar número para troca/cessão"
                }
                Icon={MessageCircle}
                value={
                  whatsappContact?.status === "missing" || !whatsappContact
                    ? "Cadastrar"
                    : "Abrir"
                }
                valueTone="action"
                onPress={go("/whatsapp-contact")}
                accessibilityLabel="Gerenciar WhatsApp da conta"
              />
              <ListRow
                title="Último erro registrado"
                subtitle="Se o app fechou sozinho, compartilhe o registro com o suporte"
                Icon={AlertTriangle}
                onPress={handleShowCrash}
                accessibilityLabel="Ver e compartilhar o último erro registrado"
              />
            </Surface>
          </View>

          {/* Sair é reversível; excluir é destrutivo e permanece visível (Apple 5.1.1(v)). */}
          <View style={{ gap: theme.space[2] }}>
            <SectionHeader title="Conta" eyebrow="Sessão e privacidade" />
            <Surface padded={false}>
              <ListRow
                title={isLoggingOut ? "Saindo…" : "Sair da conta"}
                Icon={LogOut}
                divided={false}
                onPress={isLoggingOut ? undefined : requestLogout}
                accessibilityLabel="Sair da conta"
                trailing={
                  isLoggingOut ? (
                    <ActivityIndicator
                      size="small"
                      color={theme.colors.textSecondary}
                    />
                  ) : undefined
                }
              />
            </Surface>
            <Surface
              padded={false}
              tone="danger"
              style={{ borderColor: theme.palette.danger[200] }}
            >
              <ListRow
                title="Excluir minha conta"
                subtitle="Remove seus dados e encerra o acesso. Não pode ser desfeito."
                Icon={Trash2}
                tone="danger"
                divided={false}
                onPress={handleDeleteAccountPress}
                accessibilityLabel="Excluir minha conta"
              />
            </Surface>
          </View>

          {Constants.expoConfig?.version ? (
            <Text
              style={{
                ...theme.text.caption,
                fontFamily: theme.fontFamily.mono,
                color: theme.colors.textMuted,
                textAlign: "center",
              }}
            >
              Escala+ v{Constants.expoConfig.version}
            </Text>
          ) : null}

          <View style={{ height: theme.space[8] }} />
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
                ...theme.surface.floating,
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
                  borderColor: deleteError ? theme.colors.danger : theme.colors.borderStrong,
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
                  <Text style={{ ...theme.text.body, color: theme.palette.danger[600], flex: 1 }}>{deleteError}</Text>
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
                    <Text
                      style={{ ...theme.text.bodyLg, fontWeight: theme.weight.bold, color: theme.colors.surface }}
                    >
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
                <Text
                  style={{ ...theme.text.body, fontWeight: theme.weight.semibold, color: theme.colors.textSecondary }}
                >
                  Cancelar
                </Text>
              </TouchableOpacity>
            </View>
          </KeyboardAvoidingView>
        </Modal>
      </ScreenContainer>
    </ScreenGradient>
  );
}

/** Número grande do mês. Numeral sempre em fontFamily.mono (tabular). */
function StatBlock({ label, value, unit }: { label: string; value: number; unit: string }) {
  return (
    <View style={{ flex: 1, gap: theme.space[1] }}>
      <Text
        style={{
          ...theme.text.eyebrow,
          fontWeight: theme.weight.bold,
          textTransform: "uppercase",
          color: theme.colors.textSecondary,
        }}
      >
        {label}
      </Text>
      <View style={{ flexDirection: "row", alignItems: "baseline", gap: theme.space[1] }}>
        <Text
          style={{
            ...theme.text.display,
            fontFamily: theme.fontFamily.mono,
            fontWeight: theme.weight.bold,
            color: theme.colors.textPrimary,
          }}
        >
          {value}
        </Text>
        <Text style={{ ...theme.text.caption, color: theme.colors.textSecondary }}>{unit}</Text>
      </View>
    </View>
  );
}

/** Distribuição de turnos — três blocos em linha, não três linhas. */
function TurnBlock({ label, hours, value }: { label: string; hours: string; value: number }) {
  return (
    <View
      style={{
        flex: 1,
        backgroundColor: theme.colors.surfaceAlt,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: theme.radius.md,
        paddingHorizontal: theme.space[2],
        paddingVertical: theme.space[2],
        gap: 1,
      }}
    >
      <Text
        style={{
          ...theme.text.titleSm,
          fontFamily: theme.fontFamily.mono,
          fontWeight: theme.weight.bold,
          color: theme.colors.brand,
        }}
      >
        {value}
      </Text>
      <Text style={{ ...theme.text.caption, fontWeight: theme.weight.semibold, color: theme.colors.textPrimary }}>
        {label}
      </Text>
      <Text style={{ ...theme.text.caption, fontFamily: theme.fontFamily.mono, color: theme.colors.textMuted }}>
        {hours}
      </Text>
    </View>
  );
}

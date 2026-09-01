import {
  Text,
  View,
  TouchableOpacity,
  RefreshControl,
  useWindowDimensions,
  Platform,
} from "react-native";
import { useState, useMemo, useEffect, type ReactNode } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Plus,
  Building2,
  ChevronDown,
  CalendarDays,
  LayoutGrid,
  ListChecks,
  type LucideIcon,
} from "lucide-react-native";
import { useRouter } from "expo-router";
import * as Haptics from "expo-haptics";
import { MonthAgenda, type DayOffer } from "@/components/agenda/MonthAgenda";
import { ScreenGradient } from "@/components/ui/ScreenGradient";
import { ScreenContainer } from "@/components/ui/ScreenContainer";
import { useAuth } from "@/hooks/use-auth";
import { usePermissions } from "@/hooks/use-permissions";
import { trpc } from "@/lib/trpc";
import { theme } from "@/lib/theme";
import { ManagerActionsMenu } from "@/components/agenda/ManagerActionsMenu";
import { OpenMonthShiftsButton } from "@/components/agenda/OpenMonthShiftsButton";
import { CreateHospitalButton } from "@/components/agenda/CreateHospitalButton";
import { CreateSectorScaleButton } from "@/components/agenda/CreateSectorScaleButton";
import { MobileDayList } from "@/components/agenda/MobileDayList";
import { NextShiftCard } from "@/components/agenda/NextShiftCard";
import { PanoramicAgenda } from "@/components/agenda/PanoramicAgenda";
import { DayNumeral, numeral } from "@/components/agenda/CalendarSheet";
import { SkeletonList } from "@/components/ui/Skeleton";
import { useTenantState } from "@/lib/tenant-state";
import { useSsoHandoff } from "@/hooks/use-sso-handoff";
import { useActionFeedback } from "@/hooks/use-action-feedback";
import { ScheduleContextSelector } from "@/components/ScheduleContextSelector";
import { useScheduleContext } from "@/hooks/use-schedule-context";
import {
  agendaScheduleContextId,
  type ScheduleContextOption,
} from "@/lib/schedule-context-selection";
import { formatHospitalTimeRange } from "@/lib/hospital-time";
import { formatTimeRange } from "@/components/agenda/ShiftRowCard";
import { AppButton } from "@/components/ui/AppButton";
import { QueryErrorState } from "@/components/ui/QueryErrorState";
import {
  buildAgendaMonthPickerOptions,
  countShiftsInMonth,
  monthKeyOf,
} from "@/lib/agenda-month-navigation";
import { openMonthShiftsDescription } from "@/lib/open-month-shifts";
import {
  canCreateInstitutionHospital,
  createHospitalEmptyDescription,
  createHospitalEmptyTitle,
} from "@/lib/create-hospital";
import {
  createSectorScaleDoctorHint,
  createSectorScaleEmptyDescription,
  createSectorScaleEmptyTitle,
  createSectorScaleNoHospitalDescription,
  createSectorScaleNoHospitalTitle,
  createSectorScaleNoJurisdictionDescription,
  createSectorScaleNoJurisdictionTitle,
} from "@/lib/create-sector-scale";

/**
 * Agenda — tela unificada (substitui as antigas /calendar e /weekly).
 *
 * Fonte de dados: shifts.listAgenda (server-side group por
 * semana → dia → hospital+setor). Esta tela só renderiza.
 *
 * Layouts:
 *   - Desktop (≥1024 px): grid 7-col estilo PegaPlantão. Cada coluna é
 *     um dia da semana; em cada célula, grupos colapsáveis por
 *     hospital+setor com a lista de plantões. Scroll vertical avança
 *     semanas.
 *   - Mobile/tablet: visão dia-a-dia com mini-strip de seleção. Cada
 *     dia mostra grupos hospital+setor em sequência. Mantida do design
 *     anterior pra não regredir UX mobile (refator focado em desktop
 *     conforme escopo do PO).
 *
 * Sub-modos no header (segmented):
 *   - "Geral": todos plantonistas do tenant (default).
 *   - "Minha": filtra para plantões onde o usuário logado está alocado.
 */

type AgendaScope = "geral" | "minha";
// Lista = dia-a-dia; Calendário = folha de mês; Panorama = hospital × dia.
// No celular a grade hospital × dia não cabe (47 pt por coluna), então o
// Panorama mobile É a folha de mês e "Calendário" não é oferecido.
type AgendaViewMode = "lista" | "calendario" | "panorama";

const DAY_LABELS = ["DOM", "SEG", "TER", "QUA", "QUI", "SEX", "SÁB"] as const;
const MOBILE_BREAKPOINT = 1024;

function startOfWeekMon(d: Date): Date {
  const c = new Date(d);
  c.setHours(0, 0, 0, 0);
  const dow = c.getDay();
  const diff = dow === 0 ? -6 : 1 - dow;
  c.setDate(c.getDate() + diff);
  return c;
}

function toDateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function formatMonthTitle(monthKey: string): string {
  const [y, m] = monthKey.split("-").map(Number);
  const months = [
    "Jan",
    "Fev",
    "Mar",
    "Abr",
    "Mai",
    "Jun",
    "Jul",
    "Ago",
    "Set",
    "Out",
    "Nov",
    "Dez",
  ];
  return `${months[m - 1]} ${y}`;
}

function formatMonthRange(weekStart: string, weekCount: number): string {
  const start = new Date(`${weekStart}T00:00:00`);
  const end = new Date(start);
  end.setDate(end.getDate() + weekCount * 7 - 1);
  const months = [
    "Jan",
    "Fev",
    "Mar",
    "Abr",
    "Mai",
    "Jun",
    "Jul",
    "Ago",
    "Set",
    "Out",
    "Nov",
    "Dez",
  ];
  const sm = months[start.getMonth()];
  const em = months[end.getMonth()];
  if (sm === em && start.getFullYear() === end.getFullYear()) {
    return `${sm} ${start.getFullYear()}`;
  }
  return `${sm}/${start.getFullYear()} – ${em}/${end.getFullYear()}`;
}

function buildEmptyAgendaWeeks(
  weekStart: string,
  weekCount: number,
): AgendaWeek[] {
  const baseMon = startOfWeekMon(new Date(`${weekStart}T00:00:00`));

  return Array.from({ length: weekCount }, (_, weekIndex) => {
    const wkStart = new Date(baseMon);
    wkStart.setDate(baseMon.getDate() + weekIndex * 7);

    const days = Array.from({ length: 7 }, (_, dayIndex) => {
      const dayDate = new Date(wkStart);
      dayDate.setDate(wkStart.getDate() + dayIndex);

      return {
        date: toDateKey(dayDate),
        dow: dayDate.getDay(),
        groups: [],
      };
    });

    return {
      weekStart: toDateKey(wkStart),
      days,
    };
  });
}

// ─── Borda do shift segundo o status (T3 do audit) ─────────────────────
function shiftBorderColor(status: string): string {
  if (status === "OCUPADO") return theme.colors.success;
  if (status === "PENDENTE") return theme.colors.warning;
  return theme.colors.border; // VAGO neutro
}

// ─── Componente principal ────────────────────────────────────────────
export default function AgendaScreen() {
  const { user } = useAuth();
  const { can, isGlobalAdmin, roleInInstitution } = usePermissions();
  const { activeInstitutionId, clearInstitutionSelection } = useTenantState();
  const { data: myInstitutions } =
    trpc.professionals.listMyInstitutions.useQuery(undefined, {
      enabled: !!user,
      staleTime: 60_000,
    });
  const canCreateShift = can("create:shift");
  const canCreateHospital = canCreateInstitutionHospital({
    isGlobalAdmin,
    roleInInstitution,
  });
  const router = useRouter();
  const { width } = useWindowDimensions();
  const isDesktop = Platform.OS === "web" && width >= MOBILE_BREAKPOINT;

  const [scope, setScope] = useState<AgendaScope>("geral");
  const [viewMode, setViewMode] = useState<AgendaViewMode>("lista");
  const [refreshing, setRefreshing] = useState(false);
  const [anchorWeekStart, setAnchorWeekStart] = useState(() =>
    toDateKey(startOfWeekMon(new Date())),
  );
  const todayKey = useMemo(() => toDateKey(new Date()), []);
  const weeksCount = isDesktop ? 4 : 2;

  // Panorama: âncora por MÊS (grade completa). Calendário: por semanas.
  const [anchorMonthKey, setAnchorMonthKey] = useState(() =>
    monthKeyOf(new Date()),
  );
  // Folha de mês: "Calendário" no desktop, "Panorama" no celular.
  const isMonthSheet = isDesktop
    ? viewMode === "calendario"
    : viewMode === "panorama";
  // Grade hospital × dia (semanas): só no desktop.
  const isHospitalGrid = isDesktop && viewMode === "panorama";
  const panoramaStart = useMemo(() => {
    const [y, m] = anchorMonthKey.split("-").map(Number);
    return toDateKey(startOfWeekMon(new Date(y, m - 1, 1)));
  }, [anchorMonthKey]);
  const queryStartDate = isMonthSheet ? panoramaStart : anchorWeekStart;
  const queryWeeks = isMonthSheet ? 6 : weeksCount;
  const scheduleContext = useScheduleContext({
    userId: user?.id,
    institutionId: activeInstitutionId,
    visibility: "roster",
  });
  // "Minha" sempre agrega as alocações do médico em todos os setores. O
  // seletor limita somente a visão Geral.
  const selectedAgendaContextId = agendaScheduleContextId(
    scope,
    scheduleContext.selectedContextId,
  );

  // Card "Próximo plantão": em andamento ou o próximo futuro.
  const { data: nextShift } = trpc.shifts.getNextShift.useQuery(undefined, {
    enabled: !!user?.id,
    refetchInterval: 60_000,
  });
  const { data: pendingConfirmation } = trpc.confirmations.getPending.useQuery(
    undefined,
    {
      enabled: !!user?.id,
    },
  );
  // Erro do SSO vira toast (o card não tem área de erro própria).
  const {
    launch: ssoLaunch,
    error: ssoError,
    clearError: clearSsoError,
  } = useSsoHandoff(activeInstitutionId);
  const feedback = useActionFeedback();
  useEffect(() => {
    if (!ssoError) return;
    feedback.error(ssoError);
    clearSsoError();
  }, [ssoError, clearSsoError, feedback]);

  const { data, isLoading, isError, refetch } = trpc.shifts.listAgenda.useQuery(
    {
      startDate: queryStartDate,
      weeks: queryWeeks,
      scope,
      scheduleContextId: selectedAgendaContextId,
    },
    {
      enabled: !!user?.id,
      // Cold start / oscilação de rede não pode virar tela vazia:
      // retries seguram a maioria; o resto cai no estado de erro abaixo.
      retry: 2,
      retryDelay: (attempt) => Math.min(2000 * 2 ** attempt, 10000),
      // Mantém a grade ao navegar datas, mas nunca conserva dados de outro
      // contexto sob o rótulo recém-selecionado.
      placeholderData: (previousData, previousQuery) => {
        const previousMeta = previousQuery?.queryKey?.[1] as
          | {
              input?: {
                scope?: AgendaScope;
                scheduleContextId?: number;
              };
            }
          | undefined;
        return previousMeta?.input?.scope === scope &&
          previousMeta.input.scheduleContextId === selectedAgendaContextId
          ? previousData
          : undefined;
      },
    },
  );

  const weeksForRender = useMemo(() => {
    if (data?.weeks && data.weeks.length > 0) return data.weeks;
    return buildEmptyAgendaWeeks(queryStartDate, queryWeeks);
  }, [queryStartDate, data?.weeks, queryWeeks]);

  const { data: availableSwaps } = trpc.swaps.listAvailable.useQuery(
    { scheduleContextId: selectedAgendaContextId },
    {
      enabled:
        !!user?.id &&
        isMonthSheet &&
        (scope === "minha" || !scheduleContext.isSelectionHydrating),
      staleTime: 60_000,
    },
  );
  const dayOffers = useMemo<DayOffer[]>(() => {
    return ((availableSwaps ?? []) as any[]).map((sw) => {
      const start = new Date(sw.fromShift?.startAt ?? 0);
      const end = new Date(sw.fromShift?.endAt ?? 0);
      return {
        id: sw.id,
        fromProfessionalName: sw.fromProfessional?.name ?? "Colega",
        shiftLabel: sw.fromShift?.label ?? "Plantão",
        date: toDateKey(start),
        timeRange: formatHospitalTimeRange(start, end),
      };
    });
  }, [availableSwaps]);

  const activeInstitutionName = useMemo(
    () =>
      myInstitutions?.find((i) => i.id === activeInstitutionId)?.name ?? null,
    [myInstitutions, activeInstitutionId],
  );

  const visibleMonthKey = isMonthSheet
    ? anchorMonthKey
    : monthKeyOf(new Date(`${anchorWeekStart}T00:00:00`));
  const selectedMonthShiftCount = useMemo(
    () => countShiftsInMonth(data?.weeks ?? [], visibleMonthKey),
    [data?.weeks, visibleMonthKey],
  );
  const selectedManagerContext =
    scope === "geral" && scheduleContext.selectedContext?.canManage
      ? scheduleContext.selectedContext
      : null;
  const monthPickerKeys = useMemo(
    () => buildAgendaMonthPickerOptions(new Date(), [visibleMonthKey]),
    [visibleMonthKey],
  );

  const selectMonth = (monthKey: string) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const [year, month] = monthKey.split("-").map(Number);
    setAnchorMonthKey(monthKey);
    setAnchorWeekStart(toDateKey(startOfWeekMon(new Date(year, month - 1, 1))));
    setViewMode(isDesktop ? "calendario" : "panorama");
  };

  const handleSwitchInstitution = async () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    await clearInstitutionSelection();
    router.replace("/select-institution" as any);
  };

  const onRefresh = async () => {
    setRefreshing(true);
    await Promise.all([refetch(), scheduleContext.refetch()]);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setRefreshing(false);
  };

  const stepMonth = (delta: number) => {
    const [y, m] = anchorMonthKey.split("-").map(Number);
    setAnchorMonthKey(monthKeyOf(new Date(y, m - 1 + delta, 1)));
  };
  const goPrev = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    if (isMonthSheet) return stepMonth(-1);
    const d = new Date(`${anchorWeekStart}T00:00:00`);
    d.setDate(d.getDate() - weeksCount * 7);
    setAnchorWeekStart(toDateKey(d));
  };
  const goNext = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    if (isMonthSheet) return stepMonth(1);
    const d = new Date(`${anchorWeekStart}T00:00:00`);
    d.setDate(d.getDate() + weeksCount * 7);
    setAnchorWeekStart(toDateKey(d));
  };
  const goToday = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setAnchorWeekStart(toDateKey(startOfWeekMon(new Date())));
    setAnchorMonthKey(monthKeyOf(new Date()));
  };

  return (
    <ScreenGradient variant="light">
      {/* Lista no celular: frame + lista interna com flex. Panorama e
          desktop: página rolável — a folha de mês não pode ser um
          ScrollView flex:1 sem altura (some no iPhone). */}
      <ScreenContainer
        flex={!isDesktop && !isMonthSheet}
        scrollPage={isDesktop || isMonthSheet}
        refreshControl={
          isMonthSheet && !isDesktop ? (
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={theme.colors.primary}
            />
          ) : undefined
        }
      >
        {/* Cabeçalho único das três vistas (proposta de design 23/08):
            título + navegação de período, "Hoje" e voz; instituição +
            Geral/Minha; trocador de vista de largura cheia; e, só para
            gestor, a faixa com o status da escala e o botão Ações. */}
        <View style={{ gap: theme.space[2] + 1, marginBottom: theme.space[3] }}>
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: theme.space[2],
            }}
          >
            <Text
              style={{
                ...theme.text.titleLg,
                fontSize: 22,
                fontWeight: theme.weight.semibold,
                color: theme.colors.textPrimary,
              }}
            >
              Agenda
            </Text>
            <View
              style={{
                marginLeft: "auto",
                flexDirection: "row",
                alignItems: "center",
                gap: 3,
              }}
            >
              <TouchableOpacity
                onPress={goPrev}
                style={navBtnStyle}
                hitSlop={8}
                accessibilityLabel="Período anterior"
              >
                <ChevronLeft size={16} color={theme.colors.brand} />
              </TouchableOpacity>
              <Text
                numberOfLines={1}
                style={{
                  ...numeral,
                  minWidth: 74,
                  textAlign: "center",
                  fontSize: 13.5,
                  fontWeight: theme.weight.bold,
                  color: theme.colors.textPrimary,
                }}
              >
                {isMonthSheet
                  ? formatMonthTitle(anchorMonthKey)
                  : formatMonthRange(anchorWeekStart, weeksCount)}
              </Text>
              <TouchableOpacity
                onPress={goNext}
                style={navBtnStyle}
                hitSlop={8}
                accessibilityLabel="Próximo período"
              >
                <ChevronRight size={16} color={theme.colors.brand} />
              </TouchableOpacity>
              <TouchableOpacity
                onPress={goToday}
                style={todayBtnStyle}
                hitSlop={6}
                accessibilityLabel="Ir para hoje"
              >
                <Text
                  style={{
                    ...theme.text.caption,
                    fontSize: 12.5,
                    fontWeight: theme.weight.bold,
                    color: theme.colors.onDark.text,
                  }}
                >
                  Hoje
                </Text>
              </TouchableOpacity>
            </View>
          </View>

          {/* Instituição ativa — SEMPRE visível e tocável para trocar: a
              agenda é por instituição; sem isso o usuário via a grade vazia
              da instituição errada sem nenhuma pista do motivo. */}
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: theme.space[2] - 1,
            }}
          >
            <TouchableOpacity
              onPress={handleSwitchInstitution}
              activeOpacity={0.7}
              accessibilityLabel={`Instituição ativa: ${activeInstitutionName ?? "nenhuma"}. Toque para trocar`}
              style={{
                flex: 1,
                minWidth: 0,
                flexDirection: "row",
                alignItems: "center",
                gap: theme.space[2] - 1,
                height: 34,
                paddingHorizontal: theme.space[2] + 2,
                borderRadius: theme.radius.md + 1,
                backgroundColor: theme.colors.surfaceAlt,
                borderWidth: 1,
                borderColor: theme.colors.borderStrong,
              }}
            >
              <Building2 size={15} color={theme.colors.brand} />
              <Text
                numberOfLines={1}
                style={{
                  flex: 1,
                  minWidth: 0,
                  ...theme.text.body,
                  fontSize: 13.5,
                  fontWeight: theme.weight.semibold,
                  color: theme.colors.textPrimary,
                }}
              >
                {activeInstitutionName ?? "Selecionar instituição"}
              </Text>
              <ChevronDown size={13} color={theme.colors.textSecondary} />
            </TouchableOpacity>
            <Segmented>
              <SegButton
                label="Geral"
                active={scope === "geral"}
                onPress={() => setScope("geral")}
              />
              <SegButton
                label="Minha"
                active={scope === "minha"}
                onPress={() => setScope("minha")}
              />
            </Segmented>
          </View>

          {scope === "geral" ? (
            <View style={{ gap: theme.space[2] }}>
              <ScheduleContextSelector
                contexts={scheduleContext.contexts}
                selectedContextId={scheduleContext.selectedContextId}
                onSelect={scheduleContext.selectContext}
                loading={scheduleContext.isSelectionHydrating}
                disabled={scheduleContext.isError}
                allContextsLabel="Todos os setores"
                allContextsSubtitle="Quem está de plantão em toda a instituição"
              />
              {scheduleContext.isError ? (
                <View
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: theme.space[2],
                    paddingHorizontal: theme.space[1],
                  }}
                >
                  <Text
                    style={{
                      ...theme.text.caption,
                      flex: 1,
                      color: theme.colors.danger,
                    }}
                  >
                    Não foi possível listar os setores. Os plantões do mês
                    continuam visíveis abaixo.
                  </Text>
                  <TouchableOpacity
                    onPress={() => scheduleContext.refetch()}
                    accessibilityRole="button"
                    accessibilityLabel="Tentar carregar setores novamente"
                  >
                    <Text
                      style={{
                        ...theme.text.caption,
                        color: theme.colors.primary,
                        fontWeight: theme.weight.bold,
                      }}
                    >
                      Tentar novamente
                    </Text>
                  </TouchableOpacity>
                </View>
              ) : null}
            </View>
          ) : null}

          <Segmented stretch>
            <SegButton
              label="Lista"
              Icon={ListChecks}
              active={viewMode === "lista"}
              onPress={() => setViewMode("lista")}
              stretch
              subtle
            />
            {isDesktop ? (
              <SegButton
                label="Calendário"
                Icon={CalendarDays}
                active={viewMode === "calendario"}
                onPress={() => setViewMode("calendario")}
                stretch
                subtle
              />
            ) : null}
            <SegButton
              label="Panorama"
              Icon={isDesktop ? LayoutGrid : CalendarDays}
              active={viewMode === "panorama"}
              onPress={() => setViewMode("panorama")}
              stretch
              subtle
            />
          </Segmented>

          <MonthPickerChips
            monthKeys={monthPickerKeys}
            selectedMonthKey={visibleMonthKey}
            onSelect={selectMonth}
          />

          {canCreateShift && selectedManagerContext ? (
            selectedMonthShiftCount > 0 ? (
              isMonthSheet && !isDesktop ? (
                // No celular o cartão com 4 botões comia a folha de mês
                // (ScrollView filho com flex:1 e altura 0). Ações ficam
                // na faixa; Editar/Abrir/Criar continuam na Lista.
                <ManagerActionsMenu
                  variant="strip"
                  institutionId={activeInstitutionId ?? null}
                  period={{ kind: "month", monthKey: visibleMonthKey }}
                  selectedScheduleContext={selectedManagerContext}
                  onChanged={() => {
                    refetch();
                  }}
                />
              ) : (
              <ManagerMonthActions
                monthKey={visibleMonthKey}
                onEdit={() => selectMonth(visibleMonthKey)}
              >
                <OpenMonthShiftsButton
                  monthKey={visibleMonthKey}
                  monthName={monthNamePt(visibleMonthKey)}
                  selectedContext={{
                    hospitalId: selectedManagerContext.hospitalId,
                    sectorId: selectedManagerContext.sectorId,
                    scheduleContextId: selectedManagerContext.id,
                  }}
                  onChanged={() => {
                    refetch();
                  }}
                />
                <CreateSectorScaleButton
                  onCreated={({ scheduleContextId }) => {
                    scheduleContext.selectContext(scheduleContextId);
                    void scheduleContext.refetch();
                    refetch();
                  }}
                />
                {canCreateHospital ? (
                  <CreateHospitalButton
                    onCreated={() => {
                      void scheduleContext.refetch();
                      refetch();
                    }}
                  />
                ) : null}
                <ManagerActionsMenu
                  variant="strip"
                  institutionId={activeInstitutionId ?? null}
                  period={{ kind: "month", monthKey: visibleMonthKey }}
                  selectedScheduleContext={selectedManagerContext}
                  onChanged={() => {
                    refetch();
                  }}
                />
              </ManagerMonthActions>
              )
            ) : null
          ) : canCreateShift ? (
            <View style={{ gap: theme.space[3] }}>
              {scope === "geral" && scheduleContext.contexts.length > 0 ? (
                <View style={{ gap: theme.space[3] }}>
                  <CreateSectorScaleButton
                    onCreated={({ scheduleContextId }) => {
                      scheduleContext.selectContext(scheduleContextId);
                      void scheduleContext.refetch();
                      refetch();
                    }}
                  />
                  {canCreateHospital ? (
                    <CreateHospitalButton
                      onCreated={() => {
                        void scheduleContext.refetch();
                        refetch();
                      }}
                    />
                  ) : null}
                </View>
              ) : null}
              <ManagerActionsMenu
                variant="strip"
                institutionId={activeInstitutionId ?? null}
                period={
                  isMonthSheet
                    ? { kind: "month", monthKey: anchorMonthKey }
                    : { kind: "week", weekStart: anchorWeekStart }
                }
                selectedScheduleContext={
                  scope === "geral" ? scheduleContext.selectedContext : null
                }
                onChanged={() => {
                  refetch();
                }}
              />
            </View>
          ) : null}
        </View>

        {/* Próximo plantão: na Lista. No Panorama do celular a folha de
            mês é a pergunta — o card aqui empurrava a escala para altura 0. */}
        {isMonthSheet && !isDesktop ? null : (
        <View style={{ marginBottom: theme.space[3] }}>
          <NextShiftCard
            shift={nextShift ?? null}
            needsConfirmation={
              !!nextShift &&
              pendingConfirmation?.shiftInstanceId === nextShift.id
            }
            onConfirm={
              pendingConfirmation
                ? () =>
                    router.push({
                      pathname: "/confirm-duty" as any,
                      params: { token: pendingConfirmation.confirmationToken },
                    })
                : undefined
            }
            onSwap={
              nextShift && !nextShift.inProgress
                ? () =>
                    router.push({
                      pathname: "/request-swap" as any,
                      params: { fromShiftId: String(nextShift.id) },
                    })
                : undefined
            }
            onOpenComunica={
              nextShift?.inProgress && activeInstitutionId !== null
                ? () => {
                    if (Platform.OS !== "web")
                      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                    ssoLaunch();
                  }
                : undefined
            }
            onPress={
              nextShift
                ? () =>
                    router.push({
                      pathname: "/shift-details",
                      params: { id: String(nextShift.id) },
                    })
                : undefined
            }
          />
        </View>
        )}

        {/* Conteúdo */}
        {isLoading && !data ? (
          <SkeletonList count={3} />
        ) : isError && !data ? (
          // Falha na consulta NÃO pode renderizar a grade vazia como se
          // não houvesse plantões ("nada aparece" sem explicação) — era
          // exatamente o sintoma reportado no primeiro teste com dados
          // reais. Mostra o erro e oferece retry.
          <View
            style={{
              alignItems: "center",
              paddingVertical: theme.space[10],
              gap: theme.space[4],
            }}
          >
            <Text
              style={{
                fontSize: 15,
                fontWeight: "600",
                color: theme.colors.textPrimary,
                textAlign: "center",
              }}
            >
              Não foi possível carregar a agenda
            </Text>
            <Text
              style={{
                fontSize: 13,
                color: theme.colors.textSecondary,
                textAlign: "center",
              }}
            >
              Verifique sua conexão e tente novamente.
            </Text>
            <TouchableOpacity
              onPress={() => refetch()}
              activeOpacity={0.8}
              style={{
                paddingHorizontal: theme.space[5],
                paddingVertical: theme.space[3],
                borderRadius: theme.radius.md,
                backgroundColor: theme.colors.primary,
              }}
            >
              <Text style={{ color: theme.colors.surface, fontWeight: "600" }}>
                Tentar novamente
              </Text>
            </TouchableOpacity>
          </View>
        ) : scope === "geral" &&
          !scheduleContext.isSelectionHydrating &&
          !scheduleContext.isError &&
          scheduleContext.contexts.length === 0 ? (
          <EmptyInstitutionScaleState
            canCreateShift={canCreateShift}
            canCreateHospital={canCreateHospital}
            onCreated={({ scheduleContextId }) => {
              scheduleContext.selectContext(scheduleContextId);
              void scheduleContext.refetch();
              refetch();
            }}
          />
        ) : data && selectedMonthShiftCount === 0 && !isMonthSheet ? (
          // Período genuinamente sem plantões: dizer com todas as letras
          // (e lembrar QUAL instituição está sendo consultada) em vez de
          // renderizar uma grade vazia muda.
          <View
            style={{
              alignItems: "center",
              paddingVertical: theme.space[10],
              paddingHorizontal: theme.space[6],
              gap: theme.space[3],
            }}
          >
            <Building2 size={40} color={theme.colors.textDisabled} />
            <Text
              style={{
                fontSize: 15,
                fontWeight: "600",
                color: theme.colors.textPrimary,
                textAlign: "center",
              }}
            >
              {scope === "minha"
                ? "Você não está alocado em nenhum plantão neste período"
                : "Nenhum plantão neste período"}
              {activeInstitutionName ? ` em ${activeInstitutionName}` : ""}
            </Text>
            <Text
              style={{
                fontSize: 13,
                color: theme.colors.textSecondary,
                textAlign: "center",
                lineHeight: 19,
              }}
            >
              {scope === "minha"
                ? "Toque em Geral para ver todos os plantões da instituição."
                : "Se a escala que você procura é de outra instituição, toque no nome da instituição acima para trocar."}
            </Text>
            {canCreateShift && selectedManagerContext ? (
              <EmptyMonthCalendarAction
                monthKey={visibleMonthKey}
                selectedContext={selectedManagerContext}
                onChanged={() => {
                  refetch();
                }}
              />
            ) : null}
          </View>
        ) : isMonthSheet ? (
          <View
            style={{
              gap: theme.space[3],
              paddingBottom: isDesktop ? undefined : theme.space[20],
            }}
          >
            {canCreateShift &&
            selectedManagerContext &&
            selectedMonthShiftCount === 0 &&
            !isLoading ? (
              <EmptyMonthCalendarAction
                monthKey={visibleMonthKey}
                selectedContext={selectedManagerContext}
                onChanged={() => {
                  refetch();
                }}
              />
            ) : null}
          <MonthAgenda
            weeks={weeksForRender}
            monthKey={anchorMonthKey}
            todayKey={todayKey}
            embedInPage
            offers={dayOffers}
            refreshControl={
              <RefreshControl
                refreshing={refreshing}
                onRefresh={onRefresh}
                tintColor={theme.colors.primary}
              />
            }
            onShiftPress={(id) =>
              router.push({
                pathname: "/shift-details",
                params: { id: String(id) },
              })
            }
            onOfferPress={() => router.push("/(tabs)/pending" as any)}
          />
          </View>
        ) : isHospitalGrid ? (
          <PanoramicAgenda
            weeks={weeksForRender}
            todayKey={todayKey}
            isDesktop={isDesktop}
            refreshControl={
              <RefreshControl
                refreshing={refreshing}
                onRefresh={onRefresh}
                tintColor={theme.colors.primary}
              />
            }
            onShiftPress={(id) =>
              router.push({
                pathname: "/shift-details",
                params: { id: String(id) },
              })
            }
          />
        ) : isDesktop ? (
          <DesktopGrid
            weeks={weeksForRender}
            todayKey={todayKey}
            onShiftPress={(id) =>
              router.push({
                pathname: "/shift-details",
                params: { id: String(id) },
              })
            }
          />
        ) : (
          <MobileDayList
            weeks={weeksForRender}
            todayKey={todayKey}
            refreshControl={
              <RefreshControl
                refreshing={refreshing}
                onRefresh={onRefresh}
                tintColor={theme.colors.primary}
              />
            }
            onShiftPress={(id) =>
              router.push({
                pathname: "/shift-details",
                params: { id: String(id) },
              })
            }
          />
        )}
      </ScreenContainer>

      {/* FAB criar plantão: navy da marca, sobre o papel, acima da barra
          de abas — a lista reserva 76pt no fim para nada ficar na pegada. */}
      {canCreateShift ? (
        <TouchableOpacity
          onPress={() => {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
            router.push("/create-shift");
          }}
          activeOpacity={0.85}
          accessibilityLabel="Criar plantão"
          style={{
            position: "absolute",
            bottom: theme.space[20] + theme.space[2],
            right: theme.space[4],
            width: 52,
            height: 52,
            borderRadius: 26,
            backgroundColor: theme.colors.brand,
            alignItems: "center",
            justifyContent: "center",
            ...theme.shadow.lg,
          }}
        >
          <Plus size={26} color={theme.colors.onDark.text} strokeWidth={3} />
        </TouchableOpacity>
      ) : null}
    </ScreenGradient>
  );
}

function monthNamePt(monthKey: string): string {
  const months = [
    "janeiro",
    "fevereiro",
    "março",
    "abril",
    "maio",
    "junho",
    "julho",
    "agosto",
    "setembro",
    "outubro",
    "novembro",
    "dezembro",
  ];
  const month = Number(monthKey.slice(5, 7));
  return months[month - 1] ?? monthKey;
}

function MonthPickerChips({
  monthKeys,
  selectedMonthKey,
  onSelect,
}: {
  monthKeys: string[];
  selectedMonthKey: string;
  onSelect: (monthKey: string) => void;
}) {
  return (
    <View
      style={{
        flexDirection: "row",
        flexWrap: "wrap",
        gap: theme.space[2],
      }}
    >
      {monthKeys.map((key) => {
        const selected = key === selectedMonthKey;
        return (
          <TouchableOpacity
            key={key}
            onPress={() => onSelect(key)}
            accessibilityRole="button"
            accessibilityState={{ selected }}
            accessibilityLabel={`Ver ${formatMonthTitle(key)}`}
            style={{
              minHeight: theme.space[10] + theme.space[1],
              justifyContent: "center",
              paddingHorizontal: theme.space[3],
              borderRadius: theme.radius.full,
              borderWidth: 1,
              borderColor: selected
                ? theme.colors.primary
                : theme.colors.border,
              backgroundColor: selected
                ? theme.colors.primarySoft
                : theme.colors.surface,
            }}
          >
            <Text
              style={{
                ...theme.text.body,
                fontWeight: theme.weight.semibold,
                color: selected
                  ? theme.colors.primary
                  : theme.colors.textPrimary,
              }}
            >
              {formatMonthTitle(key)}
            </Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

function ManagerMonthActions({
  monthKey,
  onEdit,
  children,
}: {
  monthKey: string;
  onEdit: () => void;
  children: ReactNode;
}) {
  const month = monthNamePt(monthKey);
  return (
    <View
      style={{
        gap: theme.space[3],
        padding: theme.space[3],
        borderRadius: theme.radius.lg,
        borderWidth: 1,
        borderColor: theme.colors.primary,
        backgroundColor: theme.colors.primarySoft,
      }}
    >
      <Text
        style={{
          ...theme.text.body,
          color: theme.colors.textSecondary,
        }}
      >
        Toque em um plantão vago para alocar profissionais em {month}.
      </Text>
      <AppButton
        title={`Editar e alocar em ${month}`}
        onPress={onEdit}
        fullWidth
      />
      {children}
    </View>
  );
}

function EmptyInstitutionScaleState({
  canCreateShift,
  canCreateHospital,
  onCreated,
}: {
  canCreateShift: boolean;
  canCreateHospital: boolean;
  onCreated: (result: { scheduleContextId: number }) => void;
}) {
  const topology = trpc.scheduleContexts.listManageableTopology.useQuery(undefined, {
    enabled: canCreateShift,
  });
  const hospitals = topology.data?.hospitals ?? [];
  const hasHospital = hospitals.length > 0;
  const missingJurisdiction =
    !topology.isLoading &&
    !hasHospital &&
    (topology.data?.institutionHasHospitals ?? false);

  return (
    <View
      style={{
        alignItems: "center",
        paddingVertical: theme.space[10],
        paddingHorizontal: theme.space[6],
        gap: theme.space[3],
        alignSelf: "stretch",
      }}
    >
      <Building2 size={40} color={theme.colors.textDisabled} />
      {canCreateShift && topology.isError ? (
        <QueryErrorState
          title="Não foi possível carregar hospitais e setores"
          onRetry={() => {
            void topology.refetch();
          }}
        />
      ) : (
        <>
          <Text
            style={{
              ...theme.text.bodyLg,
              fontWeight: theme.weight.semibold,
              color: theme.colors.textPrimary,
              textAlign: "center",
            }}
          >
            {canCreateShift
              ? missingJurisdiction
                ? createSectorScaleNoJurisdictionTitle()
                : !topology.isLoading && !hasHospital
                  ? canCreateHospital
                    ? createHospitalEmptyTitle()
                    : createSectorScaleNoHospitalTitle()
                  : createSectorScaleEmptyTitle()
              : "Nenhuma escala configurada para você"}
          </Text>
          <Text
            style={{
              ...theme.text.body,
              color: theme.colors.textSecondary,
              textAlign: "center",
            }}
          >
            {canCreateShift
              ? missingJurisdiction
                ? createSectorScaleNoJurisdictionDescription()
                : !topology.isLoading && !hasHospital
                  ? canCreateHospital
                    ? createHospitalEmptyDescription()
                    : createSectorScaleNoHospitalDescription()
                  : createSectorScaleEmptyDescription()
              : createSectorScaleDoctorHint()}
          </Text>
          {canCreateHospital && !topology.isLoading && !missingJurisdiction ? (
            <View style={{ alignSelf: "stretch" }}>
              <CreateHospitalButton />
            </View>
          ) : null}
          {canCreateShift && (hasHospital || topology.isLoading) ? (
            <View style={{ alignSelf: "stretch" }}>
              <CreateSectorScaleButton onCreated={onCreated} />
            </View>
          ) : null}
        </>
      )}
    </View>
  );
}

function EmptyMonthCalendarAction({
  monthKey,
  selectedContext,
  onChanged,
}: {
  monthKey: string;
  selectedContext: ScheduleContextOption;
  onChanged: () => void;
}) {
  const month = monthNamePt(monthKey);
  return (
    <View
      style={{
        gap: theme.space[3],
        padding: theme.space[3],
        borderRadius: theme.radius.lg,
        borderWidth: 1,
        borderColor: theme.colors.primary,
        backgroundColor: theme.colors.primarySoft,
        alignSelf: "stretch",
      }}
    >
      <Text
        style={{
          ...theme.text.bodyLg,
          fontWeight: theme.weight.bold,
          color: theme.colors.textPrimary,
        }}
      >
        Ainda não há plantões em {month}
      </Text>
      <Text style={{ ...theme.text.body, color: theme.colors.textSecondary }}>
        {openMonthShiftsDescription()}
      </Text>
      <OpenMonthShiftsButton
        monthKey={monthKey}
        monthName={month}
        selectedContext={{
          hospitalId: selectedContext.hospitalId,
          sectorId: selectedContext.sectorId,
          scheduleContextId: selectedContext.id,
        }}
        onChanged={onChanged}
      />
    </View>
  );
}

// ─── Segmented control ───────────────────────────────────────────────
// Geral/Minha (ativo = navy sólido) e o trocador de vista (ativo = branco
// com texto navy, "subtle"): o mesmo recipiente, dois pesos.
function Segmented({
  children,
  stretch = false,
}: {
  children: React.ReactNode;
  stretch?: boolean;
}) {
  return (
    <View
      style={{
        flexDirection: "row",
        padding: 2,
        backgroundColor: theme.colors.surfaceAlt,
        borderWidth: 1,
        borderColor: theme.colors.borderStrong,
        borderRadius: theme.radius.md + 1,
        alignSelf: stretch ? "stretch" : "flex-start",
      }}
    >
      {children}
    </View>
  );
}

function SegButton({
  label,
  Icon,
  active,
  onPress,
  stretch = false,
  subtle = false,
}: {
  label: string;
  Icon?: LucideIcon;
  active: boolean;
  onPress: () => void;
  stretch?: boolean;
  subtle?: boolean;
}) {
  const bg = active
    ? subtle
      ? theme.colors.surface
      : theme.colors.brand
    : "transparent";
  const fg = active
    ? subtle
      ? theme.colors.brand
      : theme.colors.onDark.text
    : subtle
      ? theme.colors.textMuted
      : theme.colors.textSecondary;
  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.8}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      style={{
        flex: stretch ? 1 : undefined,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: theme.space[1] + 1,
        minHeight: 30,
        paddingHorizontal: theme.space[2] + 3,
        borderRadius: theme.radius.md - 1,
        backgroundColor: bg,
      }}
    >
      {Icon ? <Icon size={15} color={fg} /> : null}
      <Text
        style={{
          ...theme.text.body,
          fontSize: 13,
          fontWeight: active
            ? theme.weight.bold
            : subtle
              ? theme.weight.medium
              : theme.weight.semibold,
          color: fg,
        }}
      >
        {label}
      </Text>
    </TouchableOpacity>
  );
}

// ─── Desktop grid 7-col estilo PegaPlantão ──────────────────────────
// Tipo do payload do endpoint shifts.listAgenda. Replicado aqui em vez
// de inferido via tRPC porque o type-checker não resolve a inferência
// circular entre o router e o client num primeiro build limpo.
type AgendaShift = {
  id: number;
  label: string;
  startAt: string | Date;
  endAt: string | Date;
  status: string;
  modality: string;
  coverageType: string | null;
  professionalNames: string[];
  isMine: boolean;
};
type AgendaGroupRow = {
  hospitalId: number;
  hospitalName: string;
  sectorId: number;
  sectorName: string;
  scheduleContextId: number | null;
  qualificationName: string;
  shifts: AgendaShift[];
};
type AgendaDay = {
  date: string;
  dow: number;
  groups: AgendaGroupRow[];
};
type AgendaWeek = {
  weekStart: string;
  days: AgendaDay[];
};

function DesktopGrid({
  weeks,
  todayKey,
  onShiftPress,
}: {
  weeks: AgendaWeek[];
  todayKey: string;
  onShiftPress: (id: number) => void;
}) {
  // Desktop rola a PÁGINA inteira (ScreenContainer scrollPage); este
  // componente só cresce naturalmente — sem ScrollView aninhado.
  return (
    <View style={{ paddingBottom: theme.space[10] }}>
      {weeks.map((week) => (
        <View key={week.weekStart} style={{ marginBottom: theme.space[4] }}>
          {/* Header da semana */}
          <View style={{ flexDirection: "row" }}>
            {week.days.map((day) => {
              const isToday = day.date === todayKey;
              return (
                <View
                  key={day.date}
                  style={{
                    flex: 1,
                    paddingVertical: theme.space[2],
                    paddingHorizontal: theme.space[2],
                    backgroundColor: isToday
                      ? theme.colors.paperSelected
                      : theme.colors.surfaceAlt,
                    borderTopWidth: 2,
                    borderTopColor: isToday
                      ? theme.colors.brand
                      : theme.colors.borderStrong,
                    borderRightWidth: 1,
                    borderRightColor: theme.colors.border,
                  }}
                >
                  <View
                    style={{
                      flexDirection: "row",
                      alignItems: "center",
                      gap: theme.space[2],
                    }}
                  >
                    <DayNumeral
                      day={parseInt(day.date.slice(8, 10), 10)}
                      size={26}
                      emphasis={isToday ? "today" : "default"}
                    />
                    <Text
                      style={{
                        ...theme.text.eyebrow,
                        fontWeight: theme.weight.bold,
                        color: isToday
                          ? theme.colors.brand
                          : theme.colors.textSecondary,
                      }}
                    >
                      {DAY_LABELS[day.dow]}
                    </Text>
                  </View>
                </View>
              );
            })}
          </View>

          {/* Corpo da semana — 7 colunas */}
          <View
            style={{
              flexDirection: "row",
              backgroundColor: theme.colors.surface,
              borderWidth: 1,
              borderTopWidth: 0,
              borderColor: theme.colors.border,
            }}
          >
            {week.days.map((day) => (
              <View
                key={day.date}
                style={{
                  flex: 1,
                  borderRightWidth: 1,
                  borderRightColor: theme.colors.border,
                  padding: theme.space[1],
                  gap: theme.space[2],
                }}
              >
                {day.groups.length === 0 ? (
                  <View style={{ paddingVertical: theme.space[3] }}>
                    <Text
                      style={{
                        fontSize: 11,
                        color: theme.colors.textDisabled,
                        textAlign: "center",
                      }}
                    >
                      —
                    </Text>
                  </View>
                ) : (
                  day.groups.map((group) => (
                    <DesktopGroupBlock
                      key={`${group.hospitalId}-${group.sectorId}-${group.scheduleContextId ?? "legacy"}`}
                      group={group}
                      onShiftPress={onShiftPress}
                    />
                  ))
                )}
              </View>
            ))}
          </View>
        </View>
      ))}
    </View>
  );
}

function DesktopGroupBlock({
  group,
  onShiftPress,
}: {
  group: AgendaGroupRow;
  onShiftPress: (id: number) => void;
}) {
  return (
    <View>
      {/* Hospital e setor identificam uma escala distinta; o rótulo clínico é informativo. */}
      <View
        style={{
          backgroundColor: theme.colors.primarySoft,
          paddingHorizontal: theme.space[2],
          paddingVertical: theme.space[1],
          borderRadius: theme.radius.sm,
          marginBottom: theme.space[1],
        }}
      >
        <Text
          numberOfLines={2}
          style={{
            fontSize: 10,
            fontWeight: "700",
            color: theme.palette.primary[900],
            textTransform: "uppercase",
            letterSpacing: 0.3,
          }}
        >
          {group.hospitalName} – {group.sectorName}
          {group.qualificationName ? `\n${group.qualificationName}` : ""}
        </Text>
      </View>

      {/* Lista de shifts */}
      {group.shifts.map((shift) => {
        const names =
          shift.professionalNames.length > 0
            ? shift.professionalNames.join(", ")
            : "VAGO";
        return (
          <TouchableOpacity
            key={shift.id}
            onPress={() => onShiftPress(shift.id)}
            activeOpacity={0.7}
            style={{
              borderLeftWidth: 3,
              borderLeftColor: shiftBorderColor(shift.status),
              paddingLeft: theme.space[2],
              paddingVertical: theme.space[1],
              marginBottom: 4,
              backgroundColor: shift.isMine
                ? theme.colors.primarySoft
                : "transparent",
              borderRadius: theme.radius.sm,
            }}
          >
            <Text
              numberOfLines={2}
              style={{
                fontSize: 11,
                fontWeight: "600",
                color: theme.colors.textPrimary,
              }}
            >
              {names}
            </Text>
            <Text
              style={{
                fontSize: 10,
                color: theme.colors.textMuted,
                marginTop: 1,
              }}
            >
              {formatTimeRange(shift.startAt, shift.endAt)}
            </Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

// ─── Estilos compartilhados ─────────────────────────────────────────
const navBtnStyle = {
  width: 32,
  height: 32,
  borderRadius: theme.radius.md,
  backgroundColor: theme.colors.surface,
  borderWidth: 1,
  borderColor: theme.colors.borderStrong,
  alignItems: "center" as const,
  justifyContent: "center" as const,
};

// "Hoje" é o único botão preenchido do cabeçalho: navy da marca.
const todayBtnStyle = {
  height: 32,
  paddingHorizontal: theme.space[2] + 2,
  marginLeft: 2,
  borderRadius: theme.radius.md,
  backgroundColor: theme.colors.brand,
  alignItems: "center" as const,
  justifyContent: "center" as const,
};

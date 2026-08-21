import {
  Text,
  View,
  ScrollView,
  TouchableOpacity,
  RefreshControl,
  ActivityIndicator,
  useWindowDimensions,
  Platform,
} from "react-native";
import { useState, useMemo } from "react";
import { ChevronLeft, ChevronRight, Plus, Building2, ChevronDown } from "lucide-react-native";
import { useRouter } from "expo-router";
import * as Haptics from "expo-haptics";
import { MonthAgenda, type DayOffer } from "@/components/agenda/MonthAgenda";
import { ScreenGradient } from "@/components/ui/ScreenGradient";
import { ScreenContainer } from "@/components/ui/ScreenContainer";
import { useAuth } from "@/hooks/use-auth";
import { usePermissions } from "@/hooks/use-permissions";
import { trpc } from "@/lib/trpc";
import { theme } from "@/lib/theme";
import { useTenantState } from "@/lib/tenant-state";
import { SsoLaunchButton } from "@/components/SsoLaunchButton";
import { VoiceCommandButton } from "@/components/VoiceCommandButton";

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
type AgendaViewMode = "calendario" | "panorama";

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

function monthKeyOf(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function formatMonthTitle(monthKey: string): string {
  const [y, m] = monthKey.split("-").map(Number);
  const months = ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"];
  return `${months[m - 1]} ${y}`;
}

function formatDayHeader(date: string, dow: number): string {
  // "26 DOM"
  const day = parseInt(date.slice(8, 10), 10);
  return `${String(day).padStart(2, "0")} ${DAY_LABELS[dow]}`;
}

function formatTimeRange(startAt: Date | string, endAt: Date | string): string {
  const s = new Date(startAt);
  const e = new Date(endAt);
  const f = (n: number) => String(n).padStart(2, "0");
  return `${f(s.getHours())}:${f(s.getMinutes())}–${f(e.getHours())}:${f(e.getMinutes())}`;
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
  const { can } = usePermissions();
  const { activeInstitutionId, clearInstitutionSelection } = useTenantState();
  const { data: myInstitutions } = trpc.professionals.listMyInstitutions.useQuery(undefined, {
    enabled: !!user,
    staleTime: 60_000,
  });
  const canCreateShift = can("create:shift");
  const router = useRouter();
  const { width } = useWindowDimensions();
  const isDesktop = Platform.OS === "web" && width >= MOBILE_BREAKPOINT;

  const [scope, setScope] = useState<AgendaScope>("geral");
  const [viewMode, setViewMode] = useState<AgendaViewMode>("calendario");
  const [refreshing, setRefreshing] = useState(false);
  const [anchorWeekStart, setAnchorWeekStart] = useState(() =>
    toDateKey(startOfWeekMon(new Date())),
  );
  const todayKey = useMemo(() => toDateKey(new Date()), []);
  const weeksCount = isDesktop ? 4 : 2;

  // Panorama: âncora por MÊS (grade completa). Calendário: por semanas.
  const [anchorMonthKey, setAnchorMonthKey] = useState(() => monthKeyOf(new Date()));
  const isPanorama = viewMode === "panorama";
  const panoramaStart = useMemo(() => {
    const [y, m] = anchorMonthKey.split("-").map(Number);
    return toDateKey(startOfWeekMon(new Date(y, m - 1, 1)));
  }, [anchorMonthKey]);
  const queryStartDate = isPanorama ? panoramaStart : anchorWeekStart;
  const queryWeeks = isPanorama ? 6 : weeksCount;

  const { data: activeShift, isLoading: loadingActive } =
    trpc.shifts.getActiveShift.useQuery(undefined, { enabled: !!user?.id });

  const { data, isLoading, isError, refetch } = trpc.shifts.listAgenda.useQuery(
    {
      startDate: queryStartDate,
      weeks: queryWeeks,
      scope,
    },
    {
      enabled: !!user?.id,
      // Cold start / oscilação de rede não pode virar tela vazia:
      // retries seguram a maioria; o resto cai no estado de erro abaixo.
      retry: 2,
      retryDelay: (attempt) => Math.min(2000 * 2 ** attempt, 10000),
    },
  );

  const weeksForRender = useMemo(() => {
    if (data?.weeks && data.weeks.length > 0) return data.weeks;
    return buildEmptyAgendaWeeks(queryStartDate, queryWeeks);
  }, [queryStartDate, data?.weeks, queryWeeks]);

  const { data: availableSwaps } = trpc.swaps.listAvailable.useQuery(
    {},
    { enabled: !!user?.id && isPanorama, staleTime: 60_000 },
  );
  const dayOffers = useMemo<DayOffer[]>(() => {
    return ((availableSwaps ?? []) as any[]).map((sw) => {
      const start = new Date(sw.fromShift?.startAt ?? 0);
      const end = new Date(sw.fromShift?.endAt ?? 0);
      const f = (n: number) => String(n).padStart(2, "0");
      return {
        id: sw.id,
        fromProfessionalName: sw.fromProfessional?.name ?? "Colega",
        shiftLabel: sw.fromShift?.label ?? "Plantão",
        date: toDateKey(start),
        timeRange: `${f(start.getHours())}:${f(start.getMinutes())}–${f(end.getHours())}:${f(end.getMinutes())}`,
      };
    });
  }, [availableSwaps]);

  const activeInstitutionName = useMemo(
    () => myInstitutions?.find((i) => i.id === activeInstitutionId)?.name ?? null,
    [myInstitutions, activeInstitutionId],
  );

  // Total de plantões da janela consultada — distingue "período
  // realmente vazio" (mensagem explícita) de dados carregados.
  const totalShifts = useMemo(
    () =>
      (data?.weeks ?? []).reduce(
        (acc, w) =>
          acc +
          w.days.reduce(
            (dAcc, d) => dAcc + d.groups.reduce((gAcc, g) => gAcc + g.shifts.length, 0),
            0,
          ),
        0,
      ),
    [data?.weeks],
  );

  const handleSwitchInstitution = async () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    await clearInstitutionSelection();
    router.replace("/select-institution" as any);
  };

  const onRefresh = async () => {
    setRefreshing(true);
    await refetch();
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setRefreshing(false);
  };

  const stepMonth = (delta: number) => {
    const [y, m] = anchorMonthKey.split("-").map(Number);
    setAnchorMonthKey(monthKeyOf(new Date(y, m - 1 + delta, 1)));
  };
  const goPrev = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    if (isPanorama) return stepMonth(-1);
    const d = new Date(`${anchorWeekStart}T00:00:00`);
    d.setDate(d.getDate() - weeksCount * 7);
    setAnchorWeekStart(toDateKey(d));
  };
  const goNext = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    if (isPanorama) return stepMonth(1);
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
      {/* Nativo/mobile: frame com rolagem interna (flex evita o colapso de
          altura zero no iOS). Desktop web: página inteira rolável. */}
      <ScreenContainer flex={!isDesktop} scrollPage={isDesktop}>
        {/* Header: título + nav mês + toggle Geral/Minha */}
        <View style={{ marginBottom: theme.space[4] }}>
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: theme.space[3],
            }}
          >
            <Text
              style={{
                fontSize: 28,
                fontWeight: "800",
                color: theme.colors.textPrimary,
              }}
            >
              Agenda
            </Text>
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: theme.space[2],
              }}
            >
              <TouchableOpacity onPress={goPrev} style={navBtnStyle}>
                <ChevronLeft size={20} color={theme.colors.textPrimary} />
              </TouchableOpacity>
              <TouchableOpacity onPress={goToday} style={navTextBtnStyle}>
                <Text
                  style={{
                    color: theme.colors.primary,
                    fontWeight: "600",
                    fontSize: 13,
                  }}
                >
                  Hoje
                </Text>
              </TouchableOpacity>
              <Text
                style={{
                  fontSize: 15,
                  fontWeight: "700",
                  color: theme.colors.textPrimary,
                  minWidth: 100,
                  textAlign: "center",
                }}
              >
                {isPanorama ? formatMonthTitle(anchorMonthKey) : formatMonthRange(anchorWeekStart, weeksCount)}
              </Text>
              <TouchableOpacity onPress={goNext} style={navBtnStyle}>
                <ChevronRight size={20} color={theme.colors.textPrimary} />
              </TouchableOpacity>
            </View>
          </View>

          {/* Instituição ativa — SEMPRE visível e tocável para trocar.
              A agenda é por instituição; sem isso o usuário via a grade
              vazia da instituição errada sem nenhuma pista do motivo. */}
          <TouchableOpacity
            onPress={handleSwitchInstitution}
            activeOpacity={0.7}
            style={{
              flexDirection: "row",
              alignItems: "center",
              alignSelf: "flex-start",
              gap: 6,
              backgroundColor: theme.colors.primarySoft,
              borderRadius: theme.radius.md,
              paddingHorizontal: theme.space[3],
              paddingVertical: 6,
              marginBottom: theme.space[3],
            }}
          >
            <Building2 size={14} color={theme.colors.primary} />
            <Text
              style={{
                fontSize: 13,
                fontWeight: "600",
                color: theme.colors.primary,
              }}
              numberOfLines={1}
            >
              {activeInstitutionName ?? "Selecionar instituição"}
            </Text>
            <ChevronDown size={14} color={theme.colors.primary} />
          </TouchableOpacity>

          <View
            style={{
              flexDirection: "row",
              gap: theme.space[3],
              flexWrap: "wrap",
            }}
          >
            <SegmentedGroup>
              <ScopePill
                label="Geral"
                active={scope === "geral"}
                onPress={() => setScope("geral")}
              />
              <ScopePill
                label="Minha"
                active={scope === "minha"}
                onPress={() => setScope("minha")}
              />
            </SegmentedGroup>
            <SegmentedGroup>
              <ScopePill
                label="Calendário"
                active={viewMode === "calendario"}
                onPress={() => setViewMode("calendario")}
              />
              <ScopePill
                label="Panorama"
                active={viewMode === "panorama"}
                onPress={() => setViewMode("panorama")}
              />
            </SegmentedGroup>
          </View>
        </View>

        {/* SSO Comunica+ — contextual ao plantão ativo */}
        <View style={{ marginBottom: theme.space[3] }}>
          <SsoLaunchButton
            activeShift={activeShift}
            isLoading={loadingActive}
          />
        </View>

        {/* Conteúdo */}
        {isLoading && !data ? (
          <View
            style={{ alignItems: "center", paddingVertical: theme.space[10] }}
          >
            <ActivityIndicator size="large" color={theme.colors.primary} />
          </View>
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
        ) : data && totalShifts === 0 ? (
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
              Nenhum plantão neste período
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
              Se a escala que você procura é de outra instituição, toque no
              nome da instituição acima para trocar.
            </Text>
          </View>
        ) : viewMode === "panorama" ? (
          <MonthAgenda
            weeks={weeksForRender}
            monthKey={anchorMonthKey}
            todayKey={todayKey}
            embedInPage={isDesktop}
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

      {/* Comando de voz: mic flutuante (canto inferior esquerdo) */}
      {Platform.OS !== "web" && <VoiceCommandButton />}


      {/* FAB criar plantão */}
      {canCreateShift ? (
        <TouchableOpacity
          onPress={() => {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
            router.push("/create-shift");
          }}
          activeOpacity={0.85}
          style={{
            position: "absolute",
            bottom: 100,
            right: 20,
            width: 60,
            height: 60,
            borderRadius: 30,
            backgroundColor: theme.colors.primary,
            alignItems: "center",
            justifyContent: "center",
            ...theme.shadow.lg,
          }}
        >
          <Plus size={28} color={theme.colors.surface} strokeWidth={3} />
        </TouchableOpacity>
      ) : null}
    </ScreenGradient>
  );
}

// ─── Segmented control ───────────────────────────────────────────────
function SegmentedGroup({ children }: { children: React.ReactNode }) {
  return (
    <View
      style={{
        flexDirection: "row",
        gap: 4,
        padding: 4,
        backgroundColor: theme.colors.surfaceAlt,
        borderRadius: theme.radius.lg,
        alignSelf: "flex-start",
      }}
    >
      {children}
    </View>
  );
}

function ScopePill({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.8}
      style={{
        paddingHorizontal: theme.space[4],
        paddingVertical: theme.space[2],
        borderRadius: theme.radius.md,
        backgroundColor: active ? theme.colors.surface : "transparent",
      }}
    >
      <Text
        style={{
          color: active ? theme.colors.primary : theme.colors.textSecondary,
          fontWeight: active ? "700" : "500",
          fontSize: 14,
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
                      ? theme.colors.primarySoft
                      : theme.colors.surfaceAlt,
                    borderTopWidth: isToday ? 2 : 0,
                    borderTopColor: theme.colors.primary,
                    borderRightWidth: 1,
                    borderRightColor: theme.colors.border,
                  }}
                >
                  <Text
                    style={{
                      fontSize: 12,
                      fontWeight: "700",
                      color: isToday
                        ? theme.colors.primary
                        : theme.colors.textSecondary,
                      letterSpacing: 0.5,
                    }}
                  >
                    {formatDayHeader(day.date, day.dow)}
                  </Text>
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
                      key={`${group.hospitalId}-${group.sectorId}`}
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
      {/* Header colorido com hospital - setor */}
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

// ─── Mobile day list ────────────────────────────────────────────────
function MobileDayList({
  weeks,
  todayKey,
  refreshControl,
  onShiftPress,
}: {
  weeks: AgendaWeek[];
  todayKey: string;
  refreshControl: React.ReactElement<
    import("react-native").RefreshControlProps
  >;
  onShiftPress: (id: number) => void;
}) {
  // Linealiza dias com pelo menos 1 grupo, em ordem cronológica
  const flatDays = useMemo(
    () => weeks.flatMap((w) => w.days.filter((d) => d.groups.length > 0)),
    [weeks],
  );

  return (
    <ScrollView
      style={{ flex: 1 }}
      refreshControl={refreshControl}
      contentContainerStyle={{ paddingBottom: theme.space[10] }}
      showsVerticalScrollIndicator={false}
    >
      {flatDays.length === 0 ? (
        <View
          style={{ paddingVertical: theme.space[10], alignItems: "center" }}
        >
          <Text style={{ color: theme.colors.textMuted }}>
            Nenhum plantão neste período.
          </Text>
        </View>
      ) : (
        flatDays.map((day) => {
          const isToday = day.date === todayKey;
          return (
            <View key={day.date} style={{ marginBottom: theme.space[5] }}>
              {/* Header do dia */}
              <View
                style={{
                  paddingVertical: theme.space[2],
                  paddingHorizontal: theme.space[3],
                  backgroundColor: isToday
                    ? theme.colors.primarySoft
                    : theme.colors.surfaceAlt,
                  borderRadius: theme.radius.md,
                  borderLeftWidth: isToday ? 3 : 0,
                  borderLeftColor: theme.colors.primary,
                  marginBottom: theme.space[2],
                }}
              >
                <Text
                  style={{
                    fontSize: 14,
                    fontWeight: "700",
                    color: isToday
                      ? theme.colors.primary
                      : theme.colors.textPrimary,
                    letterSpacing: 0.3,
                  }}
                >
                  {formatDayHeader(day.date, day.dow)}
                </Text>
              </View>
              {/* Grupos hospital+setor */}
              {day.groups.map((group) => (
                <View
                  key={`${group.hospitalId}-${group.sectorId}`}
                  style={{ marginBottom: theme.space[3] }}
                >
                  <View
                    style={{
                      backgroundColor: theme.colors.primarySoft,
                      paddingHorizontal: theme.space[3],
                      paddingVertical: theme.space[2],
                      borderRadius: theme.radius.sm,
                      marginBottom: theme.space[1],
                    }}
                  >
                    <Text
                      style={{
                        fontSize: 12,
                        fontWeight: "700",
                        color: theme.palette.primary[900],
                        textTransform: "uppercase",
                        letterSpacing: 0.3,
                      }}
                    >
                      {group.hospitalName} – {group.sectorName}
                    </Text>
                  </View>
                  {group.shifts.map((shift) => (
                    <TouchableOpacity
                      key={shift.id}
                      onPress={() => onShiftPress(shift.id)}
                      activeOpacity={0.75}
                      style={{
                        borderLeftWidth: 3,
                        borderLeftColor: shiftBorderColor(shift.status),
                        paddingLeft: theme.space[3],
                        paddingVertical: theme.space[2],
                        marginBottom: 4,
                        backgroundColor: shift.isMine
                          ? theme.colors.primarySoft
                          : "transparent",
                        borderRadius: theme.radius.sm,
                      }}
                    >
                      <Text
                        style={{
                          fontSize: 14,
                          fontWeight: "600",
                          color: theme.colors.textPrimary,
                        }}
                      >
                        {shift.professionalNames.length > 0
                          ? shift.professionalNames.join(", ")
                          : "VAGO"}
                      </Text>
                      <Text
                        style={{
                          fontSize: 12,
                          color: theme.colors.textMuted,
                          marginTop: 2,
                        }}
                      >
                        {formatTimeRange(shift.startAt, shift.endAt)} •{" "}
                        {shift.label}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
              ))}
            </View>
          );
        })
      )}
    </ScrollView>
  );
}

// ─── Estilos compartilhados ─────────────────────────────────────────
const navBtnStyle = {
  width: 32,
  height: 32,
  borderRadius: 16,
  backgroundColor: theme.colors.surface,
  borderWidth: 1,
  borderColor: theme.colors.border,
  alignItems: "center" as const,
  justifyContent: "center" as const,
};

const navTextBtnStyle = {
  paddingHorizontal: theme.space[3],
  paddingVertical: theme.space[2],
  borderRadius: theme.radius.md,
  backgroundColor: theme.colors.primarySoft,
};

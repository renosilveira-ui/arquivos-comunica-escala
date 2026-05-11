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
import { ChevronLeft, ChevronRight, Plus, Rows3 } from "lucide-react-native";
import { useRouter } from "expo-router";
import * as Haptics from "expo-haptics";
import { ScreenGradient } from "@/components/ui/ScreenGradient";
import { ScreenContainer } from "@/components/ui/ScreenContainer";
import { useAuth } from "@/hooks/use-auth";
import { usePermissions } from "@/hooks/use-permissions";
import { trpc } from "@/lib/trpc";
import { theme } from "@/lib/theme";

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
  const months = ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"];
  const sm = months[start.getMonth()];
  const em = months[end.getMonth()];
  if (sm === em && start.getFullYear() === end.getFullYear()) {
    return `${sm} ${start.getFullYear()}`;
  }
  return `${sm}/${start.getFullYear()} – ${em}/${end.getFullYear()}`;
}

function buildEmptyAgendaWeeks(weekStart: string, weekCount: number): AgendaWeek[] {
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

  const { data, isLoading, refetch } = trpc.shifts.listAgenda.useQuery(
    {
      startDate: anchorWeekStart,
      weeks: weeksCount,
      scope,
    },
    { enabled: !!user?.id },
  );

  const weeksForRender = useMemo(() => {
    if (data?.weeks && data.weeks.length > 0) return data.weeks;
    return buildEmptyAgendaWeeks(anchorWeekStart, weeksCount);
  }, [anchorWeekStart, data?.weeks, weeksCount]);

  const onRefresh = async () => {
    setRefreshing(true);
    await refetch();
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setRefreshing(false);
  };

  const goPrev = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const d = new Date(`${anchorWeekStart}T00:00:00`);
    d.setDate(d.getDate() - weeksCount * 7);
    setAnchorWeekStart(toDateKey(d));
  };
  const goNext = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const d = new Date(`${anchorWeekStart}T00:00:00`);
    d.setDate(d.getDate() + weeksCount * 7);
    setAnchorWeekStart(toDateKey(d));
  };
  const goToday = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setAnchorWeekStart(toDateKey(startOfWeekMon(new Date())));
  };

  return (
    <ScreenGradient variant="light">
      <ScreenContainer>
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
            <View style={{ flexDirection: "row", alignItems: "center", gap: theme.space[2] }}>
              <TouchableOpacity onPress={goPrev} style={navBtnStyle}>
                <ChevronLeft size={20} color={theme.colors.textPrimary} />
              </TouchableOpacity>
              <TouchableOpacity onPress={goToday} style={navTextBtnStyle}>
                <Text style={{ color: theme.colors.primary, fontWeight: "600", fontSize: 13 }}>Hoje</Text>
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
                {formatMonthRange(anchorWeekStart, weeksCount)}
              </Text>
              <TouchableOpacity onPress={goNext} style={navBtnStyle}>
                <ChevronRight size={20} color={theme.colors.textPrimary} />
              </TouchableOpacity>
            </View>
          </View>

          <View style={{ flexDirection: "row", gap: theme.space[3], flexWrap: "wrap" }}>
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

        {/* Conteúdo */}
        {isLoading && !data ? (
          <View style={{ alignItems: "center", paddingVertical: theme.space[10] }}>
            <ActivityIndicator size="large" color={theme.colors.primary} />
          </View>
        ) : viewMode === "panorama" ? (
          <PanoramicAgenda
            weeks={weeksForRender}
            todayKey={todayKey}
            isDesktop={isDesktop}
            refreshControl={
              <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.colors.primary} />
            }
            onShiftPress={(id) =>
              router.push({ pathname: "/shift-details", params: { id: String(id) } })
            }
          />
        ) : isDesktop ? (
          <DesktopGrid
            weeks={weeksForRender}
            todayKey={todayKey}
            refreshControl={
              <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.colors.primary} />
            }
            onShiftPress={(id) =>
              router.push({ pathname: "/shift-details", params: { id: String(id) } })
            }
          />
        ) : (
          <MobileDayList
            weeks={weeksForRender}
            todayKey={todayKey}
            refreshControl={
              <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.colors.primary} />
            }
            onShiftPress={(id) =>
              router.push({ pathname: "/shift-details", params: { id: String(id) } })
            }
          />
        )}
      </ScreenContainer>

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

function ScopePill({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
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

type PanoramaRow = {
  key: string;
  hospitalName: string;
  sectorName: string;
  days: Record<string, AgendaShift[]>;
};

function buildPanoramaRows(week: AgendaWeek): PanoramaRow[] {
  const rows = new Map<string, PanoramaRow>();

  for (const day of week.days) {
    for (const group of day.groups) {
      const key = `${group.hospitalId}-${group.sectorId}`;
      const row =
        rows.get(key) ??
        {
          key,
          hospitalName: group.hospitalName,
          sectorName: group.sectorName,
          days: {},
        };
      row.days[day.date] = group.shifts;
      rows.set(key, row);
    }
  }

  return Array.from(rows.values()).sort((a, b) => {
    const hospital = a.hospitalName.localeCompare(b.hospitalName, "pt-BR");
    if (hospital !== 0) return hospital;
    return a.sectorName.localeCompare(b.sectorName, "pt-BR");
  });
}

function summarizeWeeks(weeks: AgendaWeek[]) {
  let shifts = 0;
  let open = 0;
  let pending = 0;
  let mine = 0;

  for (const week of weeks) {
    for (const day of week.days) {
      for (const group of day.groups) {
        for (const shift of group.shifts) {
          shifts += 1;
          if (shift.status === "VAGO") open += 1;
          if (shift.status === "PENDENTE") pending += 1;
          if (shift.isMine) mine += 1;
        }
      }
    }
  }

  return { shifts, open, pending, mine };
}

function PanoramicAgenda({
  weeks,
  todayKey,
  isDesktop,
  refreshControl,
  onShiftPress,
}: {
  weeks: AgendaWeek[];
  todayKey: string;
  isDesktop: boolean;
  refreshControl: React.ReactElement<import("react-native").RefreshControlProps>;
  onShiftPress: (id: number) => void;
}) {
  const summary = useMemo(() => summarizeWeeks(weeks), [weeks]);

  if (!isDesktop) {
    return (
      <MobilePanorama
        weeks={weeks}
        todayKey={todayKey}
        refreshControl={refreshControl}
        onShiftPress={onShiftPress}
      />
    );
  }

  return (
    <View style={{ flexDirection: "row", gap: theme.space[4], alignItems: "flex-start" }}>
      <ScrollView
        style={{ flex: 1 }}
        refreshControl={refreshControl}
        contentContainerStyle={{ paddingBottom: theme.space[10] }}
        showsVerticalScrollIndicator={false}
      >
        <View style={{ gap: theme.space[4] }}>
          {weeks.map((week) => {
            const rows = buildPanoramaRows(week);
            return (
              <View
                key={week.weekStart}
                style={{
                  borderWidth: 1,
                  borderColor: theme.colors.border,
                  borderRadius: theme.radius.lg,
                  overflow: "hidden",
                  backgroundColor: theme.colors.surface,
                }}
              >
                <View
                  style={{
                    flexDirection: "row",
                    backgroundColor: theme.colors.surfaceAlt,
                    borderBottomWidth: 1,
                    borderBottomColor: theme.colors.border,
                  }}
                >
                  <View style={{ width: 220, padding: theme.space[3], justifyContent: "center" }}>
                    <View style={{ flexDirection: "row", alignItems: "center", gap: theme.space[2] }}>
                      <Rows3 size={16} color={theme.colors.primary} />
                      <Text style={{ ...theme.text.caption, color: theme.colors.textSecondary, fontWeight: theme.weight.bold, textTransform: "uppercase" }}>
                        Hospital / setor
                      </Text>
                    </View>
                  </View>
                  {week.days.map((day) => {
                    const isToday = day.date === todayKey;
                    return (
                      <View
                        key={day.date}
                        style={{
                          flex: 1,
                          minWidth: 104,
                          padding: theme.space[3],
                          borderLeftWidth: 1,
                          borderLeftColor: theme.colors.border,
                          backgroundColor: isToday ? theme.colors.primarySoft : theme.colors.surfaceAlt,
                        }}
                      >
                        <Text
                          style={{
                            ...theme.text.caption,
                            color: isToday ? theme.colors.primary : theme.colors.textSecondary,
                            fontWeight: theme.weight.bold,
                          }}
                        >
                          {formatDayHeader(day.date, day.dow)}
                        </Text>
                      </View>
                    );
                  })}
                </View>

                {rows.length === 0 ? (
                  <View style={{ padding: theme.space[6], alignItems: "center" }}>
                    <Text style={{ ...theme.text.body, color: theme.colors.textMuted }}>
                      Sem plantões nesta semana.
                    </Text>
                  </View>
                ) : (
                  rows.map((row) => (
                    <View
                      key={row.key}
                      style={{
                        flexDirection: "row",
                        borderBottomWidth: 1,
                        borderBottomColor: theme.colors.border,
                      }}
                    >
                      <View style={{ width: 220, padding: theme.space[3] }}>
                        <Text numberOfLines={1} style={{ ...theme.text.body, color: theme.colors.textPrimary, fontWeight: theme.weight.semibold }}>
                          {row.hospitalName}
                        </Text>
                        <Text numberOfLines={1} style={{ ...theme.text.caption, color: theme.colors.textMuted, marginTop: theme.space[1] }}>
                          {row.sectorName}
                        </Text>
                      </View>
                      {week.days.map((day) => {
                        const shifts = row.days[day.date] ?? [];
                        return (
                          <View
                            key={day.date}
                            style={{
                              flex: 1,
                              minWidth: 104,
                              padding: theme.space[2],
                              borderLeftWidth: 1,
                              borderLeftColor: theme.colors.border,
                              gap: theme.space[1],
                            }}
                          >
                            {shifts.length === 0 ? (
                              <Text style={{ ...theme.text.caption, color: theme.colors.textDisabled, textAlign: "center" }}>—</Text>
                            ) : (
                              shifts.slice(0, 3).map((shift) => (
                                <TouchableOpacity
                                  key={shift.id}
                                  onPress={() => onShiftPress(shift.id)}
                                  activeOpacity={0.75}
                                  style={{
                                    borderLeftWidth: 3,
                                    borderLeftColor: shiftBorderColor(shift.status),
                                    backgroundColor: shift.isMine ? theme.colors.primarySoft : theme.colors.surfaceAlt,
                                    borderRadius: theme.radius.sm,
                                    paddingHorizontal: theme.space[2],
                                    paddingVertical: theme.space[1],
                                  }}
                                >
                                  <Text numberOfLines={1} style={{ ...theme.text.caption, color: theme.colors.textPrimary, fontWeight: theme.weight.semibold }}>
                                    {formatTimeRange(shift.startAt, shift.endAt)}
                                  </Text>
                                  <Text numberOfLines={1} style={{ fontSize: 10, lineHeight: 14, color: theme.colors.textMuted }}>
                                    {shift.professionalNames[0] ?? shift.status}
                                  </Text>
                                </TouchableOpacity>
                              ))
                            )}
                            {shifts.length > 3 ? (
                              <Text style={{ ...theme.text.caption, color: theme.colors.textMuted }}>
                                +{shifts.length - 3}
                              </Text>
                            ) : null}
                          </View>
                        );
                      })}
                    </View>
                  ))
                )}
              </View>
            );
          })}
        </View>
      </ScrollView>

      <View
        style={{
          width: 260,
          borderWidth: 1,
          borderColor: theme.colors.border,
          borderRadius: theme.radius.lg,
          backgroundColor: theme.colors.surface,
          padding: theme.space[4],
          gap: theme.space[3],
        }}
      >
        <Text style={{ ...theme.text.title, fontWeight: theme.weight.bold, color: theme.colors.textPrimary }}>
          Resumo do período
        </Text>
        <SummaryLine label="Plantões" value={summary.shifts} />
        <SummaryLine label="Em aberto" value={summary.open} accent="warning" />
        <SummaryLine label="Pendentes" value={summary.pending} accent="warning" />
        <SummaryLine label="Meus plantões" value={summary.mine} accent="primary" />
        <View style={{ height: 1, backgroundColor: theme.colors.border, marginVertical: theme.space[1] }} />
        <Text style={{ ...theme.text.caption, color: theme.colors.textMuted }}>
          Use esta visão para localizar rapidamente hospitais e setores que concentram demanda.
        </Text>
      </View>
    </View>
  );
}

function MobilePanorama({
  weeks,
  todayKey,
  refreshControl,
  onShiftPress,
}: {
  weeks: AgendaWeek[];
  todayKey: string;
  refreshControl: React.ReactElement<import("react-native").RefreshControlProps>;
  onShiftPress: (id: number) => void;
}) {
  const flatDays = useMemo(() => weeks.flatMap((week) => week.days), [weeks]);
  const summary = useMemo(() => summarizeWeeks(weeks), [weeks]);

  return (
    <ScrollView
      style={{ flex: 1 }}
      refreshControl={refreshControl}
      contentContainerStyle={{ paddingBottom: theme.space[10], gap: theme.space[4] }}
      showsVerticalScrollIndicator={false}
    >
      <View
        style={{
          borderWidth: 1,
          borderColor: theme.colors.border,
          borderRadius: theme.radius.lg,
          backgroundColor: theme.colors.surface,
          padding: theme.space[4],
          gap: theme.space[3],
        }}
      >
        <Text style={{ ...theme.text.title, fontWeight: theme.weight.bold, color: theme.colors.textPrimary }}>
          Seu panorama
        </Text>
        <View style={{ flexDirection: "row", gap: theme.space[3], flexWrap: "wrap" }}>
          <SummaryPill label="Meus" value={summary.mine} />
          <SummaryPill label="Abertos" value={summary.open} />
          <SummaryPill label="Pendentes" value={summary.pending} />
        </View>
      </View>

      {flatDays.map((day) => {
        const isToday = day.date === todayKey;
        const total = day.groups.reduce((acc, group) => acc + group.shifts.length, 0);
        return (
          <View
            key={day.date}
            style={{
              borderWidth: 1,
              borderColor: isToday ? theme.colors.primary : theme.colors.border,
              borderRadius: theme.radius.lg,
              backgroundColor: theme.colors.surface,
              padding: theme.space[4],
              gap: theme.space[3],
            }}
          >
            <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
              <Text style={{ ...theme.text.title, color: isToday ? theme.colors.primary : theme.colors.textPrimary, fontWeight: theme.weight.bold }}>
                {formatDayHeader(day.date, day.dow)}
              </Text>
              <Text style={{ ...theme.text.caption, color: theme.colors.textMuted }}>
                {total} plantões
              </Text>
            </View>
            {day.groups.length === 0 ? (
              <Text style={{ ...theme.text.body, color: theme.colors.textMuted }}>
                Nenhum plantão listado.
              </Text>
            ) : (
              day.groups.map((group) => (
                <View key={`${group.hospitalId}-${group.sectorId}`} style={{ gap: theme.space[2] }}>
                  <Text style={{ ...theme.text.body, color: theme.colors.textPrimary, fontWeight: theme.weight.semibold }}>
                    {group.hospitalName} / {group.sectorName}
                  </Text>
                  {group.shifts.map((shift) => (
                    <TouchableOpacity
                      key={shift.id}
                      onPress={() => onShiftPress(shift.id)}
                      style={{
                        borderLeftWidth: 3,
                        borderLeftColor: shiftBorderColor(shift.status),
                        backgroundColor: shift.isMine ? theme.colors.primarySoft : theme.colors.surfaceAlt,
                        borderRadius: theme.radius.md,
                        padding: theme.space[3],
                      }}
                    >
                      <Text style={{ ...theme.text.body, color: theme.colors.textPrimary, fontWeight: theme.weight.semibold }}>
                        {formatTimeRange(shift.startAt, shift.endAt)} · {shift.label}
                      </Text>
                      <Text style={{ ...theme.text.caption, color: theme.colors.textMuted, marginTop: theme.space[1] }}>
                        {shift.professionalNames.join(", ") || shift.status}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
              ))
            )}
          </View>
        );
      })}
    </ScrollView>
  );
}

function SummaryLine({
  label,
  value,
  accent,
}: {
  label: string;
  value: number;
  accent?: "primary" | "warning";
}) {
  const color = accent === "primary" ? theme.colors.primary : accent === "warning" ? theme.palette.warning[700] : theme.colors.textPrimary;
  return (
    <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
      <Text style={{ ...theme.text.body, color: theme.colors.textSecondary }}>{label}</Text>
      <Text style={{ ...theme.text.title, color, fontWeight: theme.weight.bold }}>{value}</Text>
    </View>
  );
}

function SummaryPill({ label, value }: { label: string; value: number }) {
  return (
    <View
      style={{
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: theme.radius.full,
        backgroundColor: theme.colors.surfaceAlt,
        paddingHorizontal: theme.space[3],
        paddingVertical: theme.space[2],
      }}
    >
      <Text style={{ ...theme.text.caption, color: theme.colors.textSecondary, fontWeight: theme.weight.semibold }}>
        {label}: {value}
      </Text>
    </View>
  );
}

function DesktopGrid({
  weeks,
  todayKey,
  refreshControl,
  onShiftPress,
}: {
  weeks: AgendaWeek[];
  todayKey: string;
  refreshControl: React.ReactElement<import("react-native").RefreshControlProps>;
  onShiftPress: (id: number) => void;
}) {
  return (
    <ScrollView
      style={{ flex: 1 }}
      refreshControl={refreshControl}
      contentContainerStyle={{ paddingBottom: theme.space[10] }}
      showsVerticalScrollIndicator={false}
    >
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
                    backgroundColor: isToday ? theme.colors.primarySoft : theme.colors.surfaceAlt,
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
                      color: isToday ? theme.colors.primary : theme.colors.textSecondary,
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
                    <Text style={{ fontSize: 11, color: theme.colors.textDisabled, textAlign: "center" }}>
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
    </ScrollView>
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
        const names = shift.professionalNames.length > 0
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
              backgroundColor: shift.isMine ? theme.colors.primarySoft : "transparent",
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
            <Text style={{ fontSize: 10, color: theme.colors.textMuted, marginTop: 1 }}>
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
  refreshControl: React.ReactElement<import("react-native").RefreshControlProps>;
  onShiftPress: (id: number) => void;
}) {
  // Linealiza dias com pelo menos 1 grupo, em ordem cronológica
  const flatDays = useMemo(
    () =>
      weeks.flatMap((w) =>
        w.days.filter((d) => d.groups.length > 0),
      ),
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
        <View style={{ paddingVertical: theme.space[10], alignItems: "center" }}>
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
                  backgroundColor: isToday ? theme.colors.primarySoft : theme.colors.surfaceAlt,
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
                    color: isToday ? theme.colors.primary : theme.colors.textPrimary,
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
                        backgroundColor: shift.isMine ? theme.colors.primarySoft : "transparent",
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
                      <Text style={{ fontSize: 12, color: theme.colors.textMuted, marginTop: 2 }}>
                        {formatTimeRange(shift.startAt, shift.endAt)} • {shift.label}
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

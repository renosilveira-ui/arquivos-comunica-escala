// components/agenda/MobileDayList.tsx — lista dia-a-dia da Agenda (celular).
//
// Princípios (revisão de UI):
//   - começa em HOJE; dias anteriores ficam atrás de "Ver dias anteriores";
//   - dia sem plantão aparece como linha fina "Sem plantões" — o médico
//     precisa VER que hoje está vazio, não adivinhar;
//   - status com texto + ícone (ShiftStatusBadge), cor só como reforço;
//   - carregando = skeleton com a forma do conteúdo, não spinner.

import { useMemo, useState, type ReactElement } from "react";
import { Pressable, ScrollView, Text, View, type RefreshControlProps } from "react-native";
import { ChevronDown, ChevronUp } from "lucide-react-native";
import { theme } from "@/lib/theme";
import { ShiftStatusBadge } from "@/components/ui/ShiftStatusBadge";
import { SkeletonList } from "@/components/ui/Skeleton";
import { shiftStatusMeta } from "@/lib/shift-status";

export type MobileAgendaShift = {
  id: number;
  label: string;
  startAt: Date | string;
  endAt: Date | string;
  status: string;
  professionalNames: string[];
  isMine: boolean;
};
export type MobileAgendaGroup = {
  hospitalId: number;
  hospitalName: string;
  sectorId: number;
  sectorName: string;
  shifts: MobileAgendaShift[];
};
export type MobileAgendaDay = { date: string; dow: number; groups: MobileAgendaGroup[] };
export type MobileAgendaWeek = { weekStart: string; days: MobileAgendaDay[] };

const DAY_LABELS = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"] as const;
const MONTHS_SHORT = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"] as const;

function formatDayHeader(date: string, dow: number): string {
  const day = parseInt(date.slice(8, 10), 10);
  const month = parseInt(date.slice(5, 7), 10);
  return `${DAY_LABELS[dow]}, ${String(day).padStart(2, "0")} ${MONTHS_SHORT[month - 1]}`;
}

function formatTimeRange(startAt: Date | string, endAt: Date | string): string {
  const s = new Date(startAt);
  const e = new Date(endAt);
  const f = (n: number) => String(n).padStart(2, "0");
  return `${f(s.getHours())}:${f(s.getMinutes())}–${f(e.getHours())}:${f(e.getMinutes())}`;
}

function statusTone(status: string): string {
  const tone = shiftStatusMeta(status, { context: "actionable" }).tone;
  return tone === "success"
    ? theme.colors.success
    : tone === "warning"
      ? theme.colors.warning
      : tone === "danger"
        ? theme.colors.danger
        : theme.colors.border;
}

interface Props {
  weeks: MobileAgendaWeek[];
  todayKey: string;
  loading?: boolean;
  refreshControl: ReactElement<RefreshControlProps>;
  onShiftPress: (id: number) => void;
  /** Conteúdo fixo acima da lista (ex.: card "Próximo plantão"). */
  header?: ReactElement | null;
}

export function MobileDayList({ weeks, todayKey, loading = false, refreshControl, onShiftPress, header }: Props) {
  const [showPast, setShowPast] = useState(false);

  const { past, upcoming } = useMemo(() => {
    const all = weeks.flatMap((w) => w.days);
    return {
      // Passado só interessa quando tem plantão.
      past: all.filter((d) => d.date < todayKey && d.groups.length > 0),
      upcoming: all.filter((d) => d.date >= todayKey),
    };
  }, [weeks, todayKey]);

  return (
    <ScrollView
      style={{ flex: 1 }}
      refreshControl={refreshControl}
      contentContainerStyle={{ paddingBottom: theme.space[20], gap: theme.space[4] }}
      showsVerticalScrollIndicator={false}
    >
      {header}

      {loading ? (
        <SkeletonList count={3} />
      ) : (
        <>
          {past.length > 0 ? (
            <Pressable
              onPress={() => setShowPast((v) => !v)}
              accessibilityRole="button"
              accessibilityState={{ expanded: showPast }}
              style={{
                minHeight: theme.space[10] + theme.space[1],
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "center",
                gap: theme.space[1],
              }}
            >
              {showPast ? <ChevronUp size={16} color={theme.colors.textSecondary} /> : <ChevronDown size={16} color={theme.colors.textSecondary} />}
              <Text style={{ ...theme.text.body, fontWeight: theme.weight.semibold, color: theme.colors.textSecondary }}>
                {showPast ? "Ocultar dias anteriores" : `Ver ${past.length} dia${past.length === 1 ? "" : "s"} anterior${past.length === 1 ? "" : "es"}`}
              </Text>
            </Pressable>
          ) : null}

          {showPast ? past.map((day) => <DayBlock key={day.date} day={day} isToday={false} onShiftPress={onShiftPress} />) : null}

          {upcoming.length === 0 ? (
            <Text style={{ ...theme.text.body, color: theme.colors.textMuted, textAlign: "center", paddingVertical: theme.space[8] }}>
              Nenhum dia neste período.
            </Text>
          ) : (
            upcoming.map((day) => <DayBlock key={day.date} day={day} isToday={day.date === todayKey} onShiftPress={onShiftPress} />)
          )}
        </>
      )}
    </ScrollView>
  );
}

function DayBlock({ day, isToday, onShiftPress }: { day: MobileAgendaDay; isToday: boolean; onShiftPress: (id: number) => void }) {
  const empty = day.groups.length === 0;

  if (empty && !isToday) {
    // Linha fina: o dia existe, só não tem plantão.
    return (
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          paddingHorizontal: theme.space[3],
          minHeight: theme.space[8],
          borderBottomWidth: 1,
          borderBottomColor: theme.colors.border,
        }}
      >
        <Text style={{ ...theme.text.caption, fontWeight: theme.weight.semibold, color: theme.colors.textMuted, textTransform: "capitalize" }}>
          {formatDayHeader(day.date, day.dow)}
        </Text>
        <Text style={{ ...theme.text.caption, color: theme.colors.textDisabled }}>Sem plantões</Text>
      </View>
    );
  }

  return (
    <View style={{ gap: theme.space[2] }}>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          paddingVertical: theme.space[2],
          paddingHorizontal: theme.space[3],
          backgroundColor: isToday ? theme.colors.primarySoft : theme.colors.surfaceAlt,
          borderRadius: theme.radius.md,
          borderLeftWidth: isToday ? 3 : 0,
          borderLeftColor: theme.colors.primary,
        }}
      >
        <Text
          style={{
            ...theme.text.body,
            fontWeight: theme.weight.bold,
            color: isToday ? theme.palette.primary[900] : theme.colors.textPrimary,
            textTransform: "capitalize",
          }}
        >
          {formatDayHeader(day.date, day.dow)}
        </Text>
        {isToday ? (
          <Text style={{ ...theme.text.eyebrow, fontWeight: theme.weight.bold, textTransform: "uppercase", color: theme.colors.primary }}>
            Hoje
          </Text>
        ) : null}
      </View>

      {empty ? (
        <Text style={{ ...theme.text.body, color: theme.colors.textMuted, paddingHorizontal: theme.space[3], paddingVertical: theme.space[2] }}>
          Sem plantões hoje.
        </Text>
      ) : (
        day.groups.map((group) => (
          <View key={`${group.hospitalId}-${group.sectorId}`} style={{ gap: theme.space[1] }}>
            <Text
              style={{
                ...theme.text.eyebrow,
                fontWeight: theme.weight.bold,
                textTransform: "uppercase",
                color: theme.colors.textSecondary,
                paddingHorizontal: theme.space[3],
                paddingTop: theme.space[1],
              }}
              numberOfLines={1}
            >
              {group.hospitalName} · {group.sectorName}
            </Text>
            {group.shifts.map((shift) => (
              <Pressable
                key={shift.id}
                onPress={() => onShiftPress(shift.id)}
                accessibilityRole="button"
                accessibilityLabel={`${shift.label}, ${formatTimeRange(shift.startAt, shift.endAt)}, ${shiftStatusMeta(shift.status).label}`}
                style={({ pressed }) => ({
                  ...theme.surface.card,
                  borderLeftWidth: 3,
                  borderLeftColor: statusTone(shift.status),
                  paddingVertical: theme.space[3],
                  paddingHorizontal: theme.space[3],
                  backgroundColor: shift.isMine ? theme.colors.primarySoft : theme.colors.surface,
                  opacity: pressed ? 0.9 : 1,
                  gap: theme.space[1],
                })}
              >
                <View style={{ flexDirection: "row", alignItems: "center", gap: theme.space[2] }}>
                  <Text
                    numberOfLines={2}
                    style={{ flex: 1, ...theme.text.titleSm, fontWeight: theme.weight.semibold, color: theme.colors.textPrimary }}
                  >
                    {shift.professionalNames.length > 0 ? shift.professionalNames.join(", ") : "Sem profissional"}
                  </Text>
                  <ShiftStatusBadge status={shift.status} context="actionable" size="sm" />
                </View>
                <Text style={{ ...theme.text.body, color: theme.colors.textSecondary, fontVariant: ["tabular-nums"] }}>
                  {formatTimeRange(shift.startAt, shift.endAt)} · {shift.label}
                  {shift.isMine ? " · você" : ""}
                </Text>
              </Pressable>
            ))}
          </View>
        ))
      )}
    </View>
  );
}

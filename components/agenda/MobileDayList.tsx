// components/agenda/MobileDayList.tsx — lista dia-a-dia da Agenda (celular).
//
// Princípios (revisão de UI + proposta "Escala+ Personalidade", 23/08):
//   - começa em HOJE; dias anteriores ficam atrás de "Ver dias anteriores";
//   - dia sem plantão aparece como linha fina "Sem plantões" — o médico
//     precisa VER que quinta está vazia, não deduzir pela ausência;
//   - a régua do dia usa o MESMO numeral circulado do panorama: hoje é
//     navy sólido com anel branco; os outros dias, papel com anel cinza —
//     trocar de Lista para Panorama não parece trocar de app;
//   - o plantão veste o traje de lib/shift-visual.ts (barra de 4 px + fundo
//     tinted); status sempre texto + ícone, cor só como reforço;
//   - carregando = skeleton com a forma do conteúdo, não spinner.

import { useMemo, useState, type ReactElement } from "react";
import { Pressable, ScrollView, Text, View, type RefreshControlProps } from "react-native";
import { ChevronDown, ChevronUp } from "lucide-react-native";
import { theme } from "@/lib/theme";
import { SkeletonList } from "@/components/ui/Skeleton";
import { DayRule } from "./CalendarSheet";
import { ShiftRowCard } from "./ShiftRowCard";

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

/** "ter, 18 ago" */
function formatDayHeader(date: string, dow: number): string {
  const day = parseInt(date.slice(8, 10), 10);
  const month = parseInt(date.slice(5, 7), 10);
  return `${DAY_LABELS[dow]}, ${day} ${MONTHS_SHORT[month - 1]}`;
}

interface Props {
  weeks: MobileAgendaWeek[];
  todayKey: string;
  loading?: boolean;
  refreshControl: ReactElement<RefreshControlProps>;
  onShiftPress: (id: number) => void;
  /** Conteúdo fixo acima da lista (ex.: faixa "Próximo plantão"). */
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
      // 76pt de respiro no fim: o botão "+" fica sobre o papel, entre o
      // conteúdo e a barra de abas — nenhum plantão na pegada do botão.
      contentContainerStyle={{ paddingBottom: theme.space[20], gap: theme.space[3] + 1 }}
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
                minHeight: theme.space[10],
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "center",
                gap: theme.space[1] + 2,
              }}
            >
              {showPast ? <ChevronUp size={15} color={theme.colors.textSecondary} /> : <ChevronDown size={15} color={theme.colors.textSecondary} />}
              <Text style={{ ...theme.text.body, fontSize: 13.5, fontWeight: theme.weight.semibold, color: theme.colors.textSecondary }}>
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
  const dayNumber = parseInt(day.date.slice(8, 10), 10);

  if (empty && !isToday) {
    // Linha fina de 36pt: o dia existe, só não tem plantão.
    return (
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          paddingHorizontal: theme.space[3] - 1,
          minHeight: 36,
          borderBottomWidth: 1,
          borderBottomColor: theme.colors.borderStrong,
        }}
      >
        <Text style={{ ...theme.text.caption, fontWeight: theme.weight.semibold, color: theme.colors.textSecondary }}>
          {formatDayHeader(day.date, day.dow)}
        </Text>
        <Text style={{ ...theme.text.caption, color: theme.colors.textDisabled }}>Sem plantões</Text>
      </View>
    );
  }

  return (
    <View style={{ gap: theme.space[2] }}>
      <DayRule day={dayNumber} title={formatDayHeader(day.date, day.dow)} isToday={isToday} />

      {empty ? (
        <Text style={{ ...theme.text.body, color: theme.colors.textMuted, paddingHorizontal: theme.space[3], paddingVertical: theme.space[2] }}>
          Sem plantões hoje.
        </Text>
      ) : (
        day.groups.map((group) => (
          <View key={`${group.hospitalId}-${group.sectorId}`} style={{ gap: theme.space[1] + 2 }}>
            <Text
              style={{
                ...theme.text.eyebrow,
                fontSize: 10.5,
                fontWeight: theme.weight.bold,
                textTransform: "uppercase",
                color: theme.colors.textSecondary,
                paddingHorizontal: theme.space[3] - 1,
                paddingTop: 2,
              }}
              numberOfLines={1}
            >
              {group.hospitalName} · {group.sectorName}
            </Text>
            {group.shifts.map((shift) => (
              <ShiftRowCard key={shift.id} shift={shift} context="actionable" onPress={() => onShiftPress(shift.id)} />
            ))}
          </View>
        ))
      )}
    </View>
  );
}

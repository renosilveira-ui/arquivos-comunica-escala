import { useEffect, useMemo, useState } from "react";
import { Pressable, View } from "react-native";
import { Text } from "@/components/ui/Text";
import { Plus } from "lucide-react-native";

import {
  CalendarFrame,
  CalendarLegend,
  DayNumeral,
  numeral,
} from "@/components/agenda/CalendarSheet";
import {
  WEEKDAY_HEADERS,
  formatSelectedDay,
} from "@/components/agenda/MonthAgenda";
import { OccurrenceRow } from "@/components/agenda/PersonalCalendarDaySection";
import { ShiftRowCard } from "@/components/agenda/ShiftRowCard";
import { QueryErrorState } from "@/components/ui/QueryErrorState";
import { SkeletonList } from "@/components/ui/Skeleton";
import type { MobileAgendaWeek } from "@/lib/agenda-mobile-day";
import { MAX_AGENDA_DAY_TICKS } from "@/lib/agenda-overflow";
import {
  groupOccurrencesByDay,
  type PersonalCalendarOccurrenceLike,
} from "@/lib/personal-calendar-view";
import { shiftTickColor } from "@/lib/shift-visual";
import { theme } from "@/lib/theme";
import { trpc } from "@/lib/trpc";

/**
 * "Compromissos": o calendário que centraliza tudo — em FORMATO DE CALENDÁRIO.
 *
 * Decisão do PO (11/09/2026): o Escala+ é o centro da gestão de tempo do
 * médico. E, em 12/09: "prefiro em formato de calendário". Então esta vista
 * é a mesma folha de mês do Panorama (moldura, furos, réguas, legenda na
 * faixa navy), só que a folha é da PESSOA: por dia, feriado, plantões dela,
 * compromissos criados aqui e os que vieram do Google.
 *
 * ## O que a folha mostra em cada dia
 *
 * Traços, como no Panorama — presença e quantidade de relance:
 *   - navy: plantão meu (mesma cor que "Meu" na escala);
 *   - azul: compromisso (daqui ou do Google);
 *   - âmbar: feriado.
 * Até três traços; daí "+n". Tocar no dia abre o detalhe embaixo.
 *
 * ## O que este componente NÃO faz
 *
 * Não busca a escala: recebe as semanas que a aba Agenda já carregou, porque
 * duas consultas iguais na mesma tela é o que faz o celular parecer lento.
 * Não mostra plantão de terceiros: "Geral" é assunto de Lista e Panorama.
 */

type Props = {
  monthKey: string;
  todayKey: string;
  timeZone: string;
  weeks: readonly MobileAgendaWeek[];
  onShiftPress: (id: number) => void;
  onOccurrencePress: (occurrence: PersonalCalendarOccurrenceLike) => void;
  onCreate: (dayKey: string) => void;
};

type DayShift = MobileAgendaWeek["days"][number]["groups"][number]["shifts"][number];

const LEGEND = [
  {
    label: "Plantão",
    color: theme.colors.brand,
    backdropColor: theme.colors.onDark.text,
  },
  { label: "Compromisso", color: theme.colors.info },
  { label: "Feriado", color: theme.colors.warning },
] as const;

function monthWindow(monthKey: string): { fromDate: string; toDate: string } {
  const [y, m] = monthKey.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return {
    fromDate: `${monthKey}-01`,
    toDate: `${monthKey}-${String(last).padStart(2, "0")}`,
  };
}

function gridWindow(weeks: readonly MobileAgendaWeek[]): {
  fromDate: string;
  toDate: string;
} | null {
  const first = weeks[0]?.days[0]?.date;
  const lastWeek = weeks[weeks.length - 1];
  const last = lastWeek?.days[lastWeek.days.length - 1]?.date;
  return first && last ? { fromDate: first, toDate: last } : null;
}

export function UnifiedCalendar({
  monthKey,
  todayKey,
  timeZone,
  weeks,
  onShiftPress,
  onOccurrencePress,
  onCreate,
}: Props) {
  // A janela de compromissos cobre a GRADE (6 semanas), não só o mês: os
  // dias esmaecidos de borda também mostram o que há neles, como no Panorama.
  const window = useMemo(
    () => gridWindow(weeks) ?? monthWindow(monthKey),
    [weeks, monthKey],
  );

  const listQuery = trpc.personalCalendar.listWindow.useQuery(window, {
    staleTime: 30_000,
  });
  const holidaysQuery = trpc.calendarAuxiliary.listHolidays.useQuery(
    { year: Number(monthKey.slice(0, 4)), countryCode: "BR", stateCode: "CE" },
    { staleTime: 24 * 60 * 60 * 1000 },
  );

  const myShiftsByDay = useMemo(() => {
    const map = new Map<string, DayShift[]>();
    for (const week of weeks) {
      for (const day of week.days) {
        const mine = day.groups.flatMap((group) =>
          group.shifts.filter((shift) => shift.isMine),
        );
        if (mine.length) map.set(day.date, mine);
      }
    }
    return map;
  }, [weeks]);

  const groupByDay = useMemo(() => {
    if (!listQuery.data) return null;
    const groups = groupOccurrencesByDay({
      fromDate: window.fromDate,
      toDate: window.toDate,
      occurrences: listQuery.data
        .occurrences as unknown as PersonalCalendarOccurrenceLike[],
      holidays: holidaysQuery.data?.holidays,
      timeZone,
      includeEmptyDays: true,
    });
    return new Map(groups.map((group) => [group.dayKey, group]));
  }, [
    listQuery.data,
    holidaysQuery.data,
    window.fromDate,
    window.toDate,
    timeZone,
  ]);

  // Dia selecionado: hoje quando pertence ao mês, senão dia 1 — igual ao
  // Panorama, para o polegar não precisar reaprender.
  const [selected, setSelected] = useState<string>(() =>
    todayKey.startsWith(monthKey) ? todayKey : `${monthKey}-01`,
  );
  useEffect(() => {
    setSelected(todayKey.startsWith(monthKey) ? todayKey : `${monthKey}-01`);
  }, [monthKey, todayKey]);

  if (listQuery.isError) {
    return (
      <QueryErrorState
        title="Não foi possível carregar seus compromissos"
        error={listQuery.error}
        onRetry={() => {
          void listQuery.refetch();
        }}
      />
    );
  }
  if (!groupByDay) return <SkeletonList count={4} />;

  const selectedShifts = myShiftsByDay.get(selected) ?? [];
  const selectedGroup = groupByDay.get(selected);
  const selectedOccurrences = selectedGroup?.occurrences ?? [];
  const selectedHoliday = selectedGroup?.holidayName ?? null;
  const selectedEmpty =
    selectedShifts.length === 0 && selectedOccurrences.length === 0;

  return (
    <View style={{ paddingBottom: theme.space[10] }}>
      <CalendarFrame>
        <CalendarLegend items={[...LEGEND]} />

        <View
          style={{ flexDirection: "row", backgroundColor: theme.colors.brand }}
        >
          {WEEKDAY_HEADERS.map((h, i) => (
            <View
              key={h}
              style={{
                flex: 1,
                paddingVertical: theme.space[1] + 2,
                alignItems: "center",
                borderLeftWidth: i === 0 ? 0 : 1,
                borderLeftColor: theme.colors.onDark.divider,
              }}
            >
              <Text
                style={{
                  ...theme.text.eyebrow,
                  fontSize: 10,
                  letterSpacing: 1,
                  fontWeight: theme.weight.bold,
                  color: theme.colors.onDark.textMuted,
                }}
              >
                {h}
              </Text>
            </View>
          ))}
        </View>

        {weeks.map((week) => (
          <View key={week.weekStart} style={{ flexDirection: "row" }}>
            {week.days.map((day, i) => {
              const inMonth = day.date.startsWith(monthKey);
              const isToday = day.date === todayKey;
              const isSelected = day.date === selected;
              const isWeekend = day.dow === 0 || day.dow === 6;
              const shifts = myShiftsByDay.get(day.date) ?? [];
              const group = groupByDay.get(day.date);
              const occurrences = group?.occurrences ?? [];
              const holiday = group?.holidayName ?? null;

              const ticks = shifts.map((s) => shiftTickColor(s.status, true));
              for (let k = 0; k < occurrences.length; k += 1) {
                ticks.push(theme.colors.info);
              }
              if (holiday) ticks.push(theme.colors.warning);
              const extra = ticks.length - MAX_AGENDA_DAY_TICKS;
              const dayNum = parseInt(day.date.slice(8, 10), 10);

              const parts: string[] = [];
              if (shifts.length) {
                parts.push(
                  `${shifts.length} ${shifts.length === 1 ? "plantão" : "plantões"}`,
                );
              }
              if (occurrences.length) {
                parts.push(
                  `${occurrences.length} ${occurrences.length === 1 ? "compromisso" : "compromissos"}`,
                );
              }
              if (holiday) parts.push(`feriado, ${holiday}`);

              return (
                <Pressable
                  key={day.date}
                  onPress={() => setSelected(day.date)}
                  accessibilityRole="button"
                  accessibilityState={{ selected: isSelected }}
                  accessibilityLabel={`${formatSelectedDay(day.date)}${isToday ? ", hoje" : ""}, ${parts.length ? parts.join(", ") : "nada marcado"}`}
                  style={({ pressed }) => ({
                    flex: 1,
                    minHeight: 52,
                    paddingTop: 5,
                    paddingBottom: 4,
                    paddingHorizontal: 3,
                    borderTopWidth: 1,
                    borderTopColor: theme.colors.gridLine,
                    borderLeftWidth: i === 0 ? 0 : 1,
                    borderLeftColor: theme.colors.gridLine,
                    backgroundColor: isSelected
                      ? theme.colors.paperSelected
                      : isWeekend && inMonth
                        ? theme.colors.paperWeekend
                        : "transparent",
                    alignItems: "center",
                    gap: 4,
                    opacity: pressed ? 0.8 : 1,
                  })}
                >
                  <DayNumeral
                    day={dayNum}
                    size={24}
                    emphasis={
                      !inMonth
                        ? "muted"
                        : isToday
                          ? "today"
                          : shifts.length
                            ? "mine"
                            : "plain"
                    }
                  />
                  <View style={{ alignItems: "center", gap: 2 }}>
                    {ticks.slice(0, MAX_AGENDA_DAY_TICKS).map((color, t) => (
                      <View
                        key={t}
                        style={{
                          width: 16,
                          height: 3,
                          borderRadius: 2,
                          backgroundColor: inMonth
                            ? color
                            : theme.colors.border,
                        }}
                      />
                    ))}
                    {extra > 0 ? (
                      <Text
                        style={{
                          ...numeral,
                          fontSize: 11,
                          lineHeight: 12,
                          fontWeight: theme.weight.bold,
                          color: theme.colors.textSecondary,
                        }}
                      >
                        +{extra} itens
                      </Text>
                    ) : null}
                  </View>
                </Pressable>
              );
            })}
          </View>
        ))}
      </CalendarFrame>

      {/* Detalhe do dia selecionado */}
      <View style={{ marginTop: theme.space[3] + 1, gap: theme.space[2] + 1 }}>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: theme.space[2],
            paddingHorizontal: 2,
            minHeight: 44,
          }}
        >
          <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
            <View
              style={{
                flexDirection: "row",
                alignItems: "baseline",
                gap: theme.space[2],
              }}
            >
              <Text
                style={{
                  ...theme.text.titleSm,
                  fontWeight: theme.weight.bold,
                  color: theme.colors.textPrimary,
                }}
              >
                {formatSelectedDay(selected)}
              </Text>
              {selected === todayKey ? (
                <Text
                  style={{
                    ...theme.text.eyebrow,
                    fontSize: 10,
                    fontWeight: theme.weight.bold,
                    textTransform: "uppercase",
                    color: theme.colors.brand,
                  }}
                >
                  Hoje
                </Text>
              ) : null}
            </View>
            {selectedHoliday ? (
              <Text
                style={{
                  ...theme.text.caption,
                  color: theme.colors.textSecondary,
                }}
              >
                Feriado · {selectedHoliday}
              </Text>
            ) : null}
          </View>
          <Pressable
            onPress={() => onCreate(selected)}
            accessibilityRole="button"
            accessibilityLabel={`Novo compromisso em ${formatSelectedDay(selected)}`}
            style={({ pressed }) => ({
              flexDirection: "row",
              alignItems: "center",
              gap: theme.space[1],
              minHeight: 44,
              paddingHorizontal: theme.space[3],
              borderRadius: theme.radius.md + 2,
              borderWidth: 1,
              borderColor: theme.colors.border,
              backgroundColor: theme.colors.surface,
              opacity: pressed ? 0.8 : 1,
            })}
          >
            <Plus size={16} color={theme.colors.brand} />
            <Text
              style={{
                ...theme.text.body,
                fontSize: 13.5,
                fontWeight: theme.weight.semibold,
                color: theme.colors.brand,
              }}
            >
              Novo
            </Text>
          </Pressable>
        </View>

        {selectedShifts.map((shift) => (
          <ShiftRowCard
            key={`shift-${shift.id}`}
            shift={shift}
            context="actionable"
            onPress={() => onShiftPress(shift.id)}
          />
        ))}

        {selectedOccurrences.map((occurrence) => (
          <OccurrenceRow
            key={`${occurrence.itemId}:${occurrence.occurrenceKey}`}
            occurrence={occurrence}
            timeZone={timeZone}
            onPress={onOccurrencePress}
          />
        ))}

        {selectedEmpty ? (
          <View
            style={{
              paddingVertical: theme.space[6],
              alignItems: "center",
              backgroundColor: theme.colors.surfaceAlt,
              borderWidth: 1,
              borderColor: theme.colors.border,
              borderRadius: theme.radius.md + 2,
            }}
          >
            <Text style={{ ...theme.text.body, color: theme.colors.textMuted }}>
              {selectedHoliday
                ? "Feriado. Nada marcado neste dia."
                : "Nada marcado neste dia."}
            </Text>
          </View>
        ) : null}
      </View>
    </View>
  );
}

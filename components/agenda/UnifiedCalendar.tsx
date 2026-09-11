import { useMemo } from "react";
import { Text, TouchableOpacity, View } from "react-native";
import { Plus } from "lucide-react-native";

import { OccurrenceRow } from "@/components/agenda/PersonalCalendarDaySection";
import { ShiftRowCard } from "@/components/agenda/ShiftRowCard";
import { QueryErrorState } from "@/components/ui/QueryErrorState";
import { SkeletonList } from "@/components/ui/Skeleton";
import type { MobileAgendaWeek } from "@/lib/agenda-mobile-day";
import {
  groupOccurrencesByDay,
  type PersonalCalendarOccurrenceLike,
} from "@/lib/personal-calendar-view";
import { theme } from "@/lib/theme";
import { trpc } from "@/lib/trpc";

/**
 * "Compromissos": o calendário que centraliza tudo.
 *
 * Decisão do PO em 11/09/2026: o Escala+ é o centro da gestão de tempo do
 * médico. Num único lugar, por dia: feriado, plantões, compromissos (os
 * criados aqui e os que vieram do Google), lembretes e aniversários.
 *
 * ## Por que é uma terceira vista, e não um filtro da escala
 *
 * Lista e Panorama são duas apresentações do MESMO dado — a escala do
 * tenant. Compromisso pessoal é outro domínio, privado da conta. Misturar os
 * dois como "filtro" sugeriria que compromisso é um tipo de plantão. Aqui
 * eles convivem no mesmo dia, mas cada um com a sua cara: plantão usa o
 * cartão da escala; compromisso usa a linha da agenda pessoal.
 *
 * ## O que este componente NÃO faz
 *
 * Não busca a escala: recebe as semanas que a aba Agenda já carregou, porque
 * duas consultas iguais na mesma tela é o que faz o celular parecer lento.
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

function monthWindow(monthKey: string): { fromDate: string; toDate: string } {
  const [y, m] = monthKey.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return {
    fromDate: `${monthKey}-01`,
    toDate: `${monthKey}-${String(last).padStart(2, "0")}`,
  };
}

function dayLabel(dayKey: string, timeZone: string): string {
  try {
    const [y, m, d] = dayKey.split("-").map(Number);
    return new Intl.DateTimeFormat("pt-BR", {
      timeZone,
      weekday: "short",
      day: "2-digit",
      month: "short",
    }).format(new Date(Date.UTC(y, m - 1, d, 12)));
  } catch {
    return dayKey;
  }
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
  const window = useMemo(() => monthWindow(monthKey), [monthKey]);

  const listQuery = trpc.personalCalendar.listWindow.useQuery(window, {
    staleTime: 30_000,
  });
  const holidaysQuery = trpc.calendarAuxiliary.listHolidays.useQuery(
    { year: Number(monthKey.slice(0, 4)), countryCode: "BR", stateCode: "CE" },
    { staleTime: 24 * 60 * 60 * 1000 },
  );

  // Plantões do mês, por dia, só os meus: a vista é da PESSOA. "Geral"
  // continua sendo assunto de Lista e Panorama.
  const shiftsByDay = useMemo(() => {
    const map = new Map<string, MobileAgendaWeek["days"][number]["groups"]>();
    for (const week of weeks) {
      for (const day of week.days) {
        if (day.date < window.fromDate || day.date > window.toDate) continue;
        const mine = day.groups
          .map((group) => ({
            ...group,
            shifts: group.shifts.filter((shift) => shift.isMine),
          }))
          .filter((group) => group.shifts.length > 0);
        if (mine.length) map.set(day.date, mine);
      }
    }
    return map;
  }, [weeks, window.fromDate, window.toDate]);

  const groups = useMemo(() => {
    if (!listQuery.data) return null;
    const base = groupOccurrencesByDay({
      fromDate: window.fromDate,
      toDate: window.toDate,
      occurrences: listQuery.data
        .occurrences as unknown as PersonalCalendarOccurrenceLike[],
      holidays: holidaysQuery.data?.holidays,
      timeZone,
      includeEmptyDays: true,
    });
    // Dia sem nada de nenhum tipo sai da lista: no mês, o vazio é ruído.
    return base.filter(
      (group) =>
        group.occurrences.length > 0 ||
        group.holidayName !== null ||
        shiftsByDay.has(group.dayKey) ||
        group.dayKey === todayKey,
    );
  }, [
    listQuery.data,
    holidaysQuery.data,
    window.fromDate,
    window.toDate,
    timeZone,
    shiftsByDay,
    todayKey,
  ]);

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
  if (!groups) return <SkeletonList count={4} />;

  return (
    <View style={{ gap: theme.space[3], paddingBottom: theme.space[20] }}>
      {groups.map((group) => {
        const shiftGroups = shiftsByDay.get(group.dayKey) ?? [];
        const isToday = group.dayKey === todayKey;
        const empty = shiftGroups.length === 0 && group.occurrences.length === 0;
        return (
          <View key={group.dayKey} style={{ gap: theme.space[2] }}>
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "space-between",
                minHeight: 44,
              }}
            >
              <View style={{ gap: 2, flex: 1 }}>
                <Text
                  style={{
                    fontSize: theme.text.titleSm.fontSize,
                    fontWeight: "700",
                    color: isToday
                      ? theme.colors.primary
                      : theme.colors.textPrimary,
                    textTransform: "capitalize",
                  }}
                >
                  {dayLabel(group.dayKey, timeZone)}
                  {isToday ? " · hoje" : ""}
                </Text>
                {group.holidayName ? (
                  <Text
                    style={{
                      fontSize: theme.text.caption.fontSize,
                      color: theme.colors.textSecondary,
                    }}
                  >
                    Feriado · {group.holidayName}
                  </Text>
                ) : null}
              </View>
              <TouchableOpacity
                onPress={() => onCreate(group.dayKey)}
                accessibilityRole="button"
                accessibilityLabel={`Novo compromisso em ${dayLabel(group.dayKey, timeZone)}`}
                style={{
                  width: 44,
                  height: 44,
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <Plus size={18} color={theme.colors.textSecondary} />
              </TouchableOpacity>
            </View>

            {shiftGroups.map((groupOfShifts) =>
              groupOfShifts.shifts.map((shift) => (
                <ShiftRowCard
                  key={`shift-${shift.id}`}
                  shift={shift}
                  onPress={() => onShiftPress(shift.id)}
                />
              )),
            )}

            {group.occurrences.map((occurrence) => (
              <OccurrenceRow
                key={`${occurrence.itemId}:${occurrence.occurrenceKey}`}
                occurrence={occurrence}
                timeZone={timeZone}
                onPress={onOccurrencePress}
              />
            ))}

            {empty ? (
              <Text
                style={{
                  fontSize: theme.text.caption.fontSize,
                  color: theme.colors.textMuted,
                }}
              >
                Nada marcado.
              </Text>
            ) : null}
          </View>
        );
      })}
      {groups.length === 0 ? (
        <Text
          style={{
            fontSize: theme.text.body.fontSize,
            color: theme.colors.textSecondary,
            textAlign: "center",
            paddingVertical: theme.space[8],
          }}
        >
          Nenhum plantão, compromisso ou feriado neste mês.
        </Text>
      ) : null}
    </View>
  );
}

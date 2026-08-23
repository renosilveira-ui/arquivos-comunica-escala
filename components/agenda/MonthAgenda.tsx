// components/agenda/MonthAgenda.tsx — a FOLHA DE MÊS da Agenda (Panorama
// no celular; "Calendário" no desktop).
//
// Pedido do PO (2026-08-19): "ver o calendário inteiro, pra poder
// selecionar o dia e ver o detalhe do dia (plantonistas, ofertas, vagas)".
//
// Proposta "Escala+ Personalidade" (23/08): a folha de mês É a logo. As 42
// células deixam de ser cartõezinhos com borda própria e viram uma folha
// só — moldura navy de 2 px, os dois furos de pendurar, réguas de 1 px em
// navy a 14% e cabeçalho navy com as iniciais dos dias. Dentro:
//   - hoje é CIRCULADO (anel navy), não pintado; o dia selecionado é papel
//     tingido — os dois se acumulam em vez de um vencer o outro, e os
//     traços coloridos sobrevivem ao toque (antes, selecionar apagava o
//     próprio status do dia);
//   - traços: um por plantão até três, e daí "+n" — presença E quantidade;
//   - fim de semana é papel levemente rebaixado: "o fim de semana está
//     descoberto" vira varredura, não contagem;
//   - a legenda vive DENTRO da moldura, na faixa navy do topo — nada a
//     cobre (antes ficava entre a grade e o detalhe, sob a barra de abas).

import { useMemo, useState, useEffect, type ReactElement } from "react";
import { Pressable, ScrollView, Text, View, type RefreshControlProps } from "react-native";
import { ArrowRightLeft } from "lucide-react-native";
import { theme } from "@/lib/theme";
import { shiftTickColor } from "@/lib/shift-visual";
import { CalendarFrame, CalendarLegend, DayNumeral, numeral } from "./CalendarSheet";
import { ShiftRowCard } from "./ShiftRowCard";

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

export type DayOffer = {
  id: number;
  fromProfessionalName: string;
  shiftLabel: string;
  date: string; // YYYY-MM-DD do turno ofertado
  timeRange: string;
};

const WEEKDAY_HEADERS = ["SEG", "TER", "QUA", "QUI", "SEX", "SÁB", "DOM"] as const;
const MONTHS_PT = [
  "janeiro", "fevereiro", "março", "abril", "maio", "junho",
  "julho", "agosto", "setembro", "outubro", "novembro", "dezembro",
] as const;
const WEEKDAYS_PT = [
  "domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado",
] as const;

const MAX_TICKS = 3;

function formatSelectedDay(dateKey: string): string {
  const d = new Date(`${dateKey}T12:00:00`);
  const weekday = WEEKDAYS_PT[d.getDay()];
  return `${weekday.charAt(0).toUpperCase()}${weekday.slice(1)}, ${d.getDate()} de ${MONTHS_PT[d.getMonth()]}`;
}

export function MonthAgenda({
  weeks,
  monthKey,
  todayKey,
  offers,
  refreshControl,
  embedInPage = false,
  onShiftPress,
  onOfferPress,
}: {
  weeks: AgendaWeek[];
  /** "YYYY-MM" do mês exibido — dias fora dele ficam esmaecidos. */
  monthKey: string;
  todayKey: string;
  offers: DayOffer[];
  refreshControl: ReactElement<RefreshControlProps>;
  /** Desktop: a página rola por inteiro — sem ScrollView interno aqui. */
  embedInPage?: boolean;
  onShiftPress: (id: number) => void;
  onOfferPress: () => void;
}) {
  const dayByKey = useMemo(() => {
    const map = new Map<string, AgendaDay>();
    for (const w of weeks) for (const d of w.days) map.set(d.date, d);
    return map;
  }, [weeks]);

  // Dia selecionado: hoje quando pertence ao mês, senão dia 1.
  const [selected, setSelected] = useState<string>(() =>
    todayKey.startsWith(monthKey) ? todayKey : `${monthKey}-01`,
  );
  useEffect(() => {
    setSelected(todayKey.startsWith(monthKey) ? todayKey : `${monthKey}-01`);
  }, [monthKey, todayKey]);

  const selectedDay = dayByKey.get(selected);
  const selectedOffers = useMemo(() => offers.filter((o) => o.date === selected), [offers, selected]);

  const legend = [
    { label: "Ocupado", color: theme.colors.statusOcupado },
    { label: "Pendente", color: theme.colors.statusPendente },
    { label: "Vago", color: theme.colors.statusVagoActionable },
    { label: "Oferta", color: theme.colors.info },
    { label: "Meu", color: theme.colors.onDark.text },
  ];

  const inner = (
    <>
      <CalendarFrame>
        <CalendarLegend items={legend} />

        {/* Iniciais dos dias, sobre navy */}
        <View style={{ flexDirection: "row", backgroundColor: theme.colors.brand }}>
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
              <Text style={{ ...theme.text.eyebrow, fontSize: 10, letterSpacing: 1, fontWeight: theme.weight.bold, color: theme.colors.onDark.textMuted }}>
                {h}
              </Text>
            </View>
          ))}
        </View>

        {/* A grade: réguas de 1px em navy a 14% (a malha do ícone) */}
        {weeks.map((week) => (
          <View key={week.weekStart} style={{ flexDirection: "row" }}>
            {week.days.map((day, i) => {
              const inMonth = day.date.startsWith(monthKey);
              const isToday = day.date === todayKey;
              const isSelected = day.date === selected;
              const isWeekend = day.dow === 0 || day.dow === 6;
              const shifts = day.groups.flatMap((g) => g.shifts);
              const isMineDay = shifts.some((s) => s.isMine);
              const ticks = shifts.map((s) => shiftTickColor(s.status, s.isMine));
              if (offers.some((o) => o.date === day.date)) ticks.push(theme.colors.info);
              const extra = ticks.length - MAX_TICKS;
              const dayNum = parseInt(day.date.slice(8, 10), 10);

              return (
                <Pressable
                  key={day.date}
                  onPress={() => setSelected(day.date)}
                  accessibilityRole="button"
                  accessibilityState={{ selected: isSelected }}
                  accessibilityLabel={`${formatSelectedDay(day.date)}${isToday ? ", hoje" : ""}, ${shifts.length} plantão${shifts.length === 1 ? "" : "ões"}`}
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
                    emphasis={!inMonth ? "muted" : isToday ? "today" : isMineDay ? "mine" : "plain"}
                  />
                  <View style={{ alignItems: "center", gap: 2 }}>
                    {ticks.slice(0, MAX_TICKS).map((color, t) => (
                      <View key={t} style={{ width: 16, height: 3, borderRadius: 2, backgroundColor: inMonth ? color : theme.colors.border }} />
                    ))}
                    {extra > 0 ? (
                      <Text style={{ ...numeral, fontSize: 11, lineHeight: 12, fontWeight: theme.weight.bold, color: theme.colors.textSecondary }}>+{extra}</Text>
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
        <View style={{ flexDirection: "row", alignItems: "baseline", gap: theme.space[2], paddingHorizontal: 2 }}>
          <Text style={{ ...theme.text.titleSm, fontWeight: theme.weight.bold, color: theme.colors.textPrimary }}>{formatSelectedDay(selected)}</Text>
          {selected === todayKey ? (
            <Text style={{ ...theme.text.eyebrow, fontSize: 10, fontWeight: theme.weight.bold, textTransform: "uppercase", color: theme.colors.brand }}>
              Hoje
            </Text>
          ) : null}
        </View>

        {selectedOffers.map((offer) => (
          <Pressable
            key={offer.id}
            onPress={onOfferPress}
            accessibilityRole="button"
            accessibilityLabel={`Oferta de troca, ${offer.shiftLabel}, ${offer.fromProfessionalName}, ${offer.timeRange}. Toque para responder`}
            style={({ pressed }) => ({
              flexDirection: "row",
              alignItems: "center",
              gap: theme.space[2] + 2,
              paddingVertical: theme.space[2] + 2,
              paddingHorizontal: theme.space[3] - 1,
              backgroundColor: theme.palette.primary[50],
              borderWidth: 1,
              borderColor: theme.palette.primary[200],
              borderLeftWidth: 4,
              borderLeftColor: theme.colors.brand,
              borderRadius: theme.radius.md + 2,
              opacity: pressed ? 0.9 : 1,
            })}
          >
            <ArrowRightLeft size={17} color={theme.colors.brand} />
            <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
              <Text style={{ ...theme.text.body, fontSize: 13.5, fontWeight: theme.weight.bold, color: theme.colors.brand }}>
                Oferta de troca — {offer.shiftLabel}
              </Text>
              <Text style={{ ...theme.text.caption, color: theme.colors.textSecondary }}>
                {offer.fromProfessionalName} · {offer.timeRange} · toque para responder
              </Text>
            </View>
          </Pressable>
        ))}

        {!selectedDay || selectedDay.groups.length === 0 ? (
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
            <Text style={{ ...theme.text.body, color: theme.colors.textMuted }}>Nenhum plantão neste dia.</Text>
          </View>
        ) : (
          selectedDay.groups.map((group) => (
            <View key={`${group.hospitalId}-${group.sectorId}`} style={{ gap: theme.space[1] + 1 }}>
              <Text
                numberOfLines={1}
                style={{
                  ...theme.text.eyebrow,
                  fontSize: 10.5,
                  fontWeight: theme.weight.bold,
                  textTransform: "uppercase",
                  color: theme.colors.textSecondary,
                  paddingHorizontal: 2,
                }}
              >
                {group.hospitalName} – {group.sectorName}
              </Text>
              {group.shifts.map((shift) => (
                <ShiftRowCard key={shift.id} shift={shift} context="actionable" onPress={() => onShiftPress(shift.id)} />
              ))}
            </View>
          ))
        )}
      </View>
    </>
  );

  if (embedInPage) {
    return <View style={{ paddingBottom: theme.space[10] }}>{inner}</View>;
  }
  return (
    <ScrollView
      style={{ flex: 1 }}
      refreshControl={refreshControl}
      // 76pt de respiro para o botão "+" não cobrir o fim do mês.
      contentContainerStyle={{ paddingBottom: theme.space[20] }}
      showsVerticalScrollIndicator={false}
    >
      {inner}
    </ScrollView>
  );
}

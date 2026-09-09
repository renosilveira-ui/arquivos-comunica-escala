// components/agenda/MonthAgenda.tsx — a FOLHA DE MÊS da Agenda (Panorama
// no celular; "Calendário" no desktop).
//
// Pedido do PO (2026-08-19): "ver o calendário inteiro, pra poder
// selecionar o dia e ver o detalhe do dia (plantonistas, ofertas, vagas)".
//
// Proposta "Escala+ Personalidade": a folha de mês É a logo. As 42 células
// formam uma única folha, com moldura navy, furos e malha leve. Dentro:
//   - hoje/seleção continuam identificáveis por anel, inclusive em dia
//     vermelho;
//   - três traços têm posição fixa (manhã, tarde e noite): preto indica
//     plantão/compromisso e azul-real indica oferta, com precedência;
//   - domingo e feriado são vermelhos com numeral branco; sábado usa cinza;
//   - ponto, laço e bolo distinguem compromisso, lembrete e aniversário sem
//     depender apenas de cor;
//   - a legenda vive dentro da faixa navy e o detalhe abaixo é do dia
//     selecionado, compartilhado com a vista Lista.

import { useMemo, type ReactElement } from "react";
import {
  Pressable,
  ScrollView,
  Text,
  View,
  type RefreshControlProps,
} from "react-native";
import {
  ArrowRightLeft,
  Bell,
  CakeSlice,
  CalendarClock,
  MapPin,
  Plus,
  Ribbon,
  TriangleAlert,
} from "lucide-react-native";
import { theme } from "@/lib/theme";
import {
  agendaDaySurface,
  buildAgendaDayPresentation,
  greetingForHour,
  personalOccurrenceTimeLabel,
  personalOccurrencesOnDay,
  type PersonalAgendaOccurrence,
} from "@/lib/personal-agenda-presentation";
import { CalendarFrame, CalendarLegend, DayNumeral } from "./CalendarSheet";
import { ShiftRowCard } from "./ShiftRowCard";

type AgendaShift = {
  requiredCapacity?: number | null;
  activeCount?: number;
  remainingCapacity?: number;
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
  scheduleContextId?: number | null;
  qualificationName?: string;
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
  startAt: string | Date;
  timeRange: string;
};

export type AgendaHoliday = {
  date: string;
  name: string;
  scope: "NATIONAL" | "STATE";
};

type AgendaDataState = "LOADING" | "ERROR" | "READY";

const WEEKDAY_HEADERS = [
  "SEG",
  "TER",
  "QUA",
  "QUI",
  "SEX",
  "SÁB",
  "DOM",
] as const;
const MONTHS_PT = [
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
] as const;
const WEEKDAYS_PT = [
  "domingo",
  "segunda",
  "terça",
  "quarta",
  "quinta",
  "sexta",
  "sábado",
] as const;

export const MONTH_AGENDA_LEGEND = [
  {
    label: "Plantão / compromisso",
    color: theme.palette.neutral[900],
    backdropColor: theme.colors.onDark.text,
  },
  { label: "Oferta", color: theme.palette.primary[700] },
  {
    label: "Compromisso",
    color: theme.palette.neutral[900],
    backdropColor: theme.colors.onDark.text,
    marker: "dot" as const,
  },
  { label: "Lembrete", color: theme.colors.onDark.text, Icon: Ribbon },
  { label: "Aniversário", color: theme.colors.onDark.text, Icon: CakeSlice },
] as const;

function formatSelectedDay(dateKey: string): string {
  const d = new Date(`${dateKey}T12:00:00`);
  const weekday = WEEKDAYS_PT[d.getDay()];
  return `${weekday.charAt(0).toUpperCase()}${weekday.slice(1)}, ${d.getDate()} de ${MONTHS_PT[d.getMonth()]}`;
}

export function MonthAgenda({
  weeks,
  monthKey,
  todayKey,
  selectedDayKey,
  offers,
  holidays,
  personalOccurrences,
  scheduleState,
  personalState,
  refreshControl,
  embedInPage = false,
  onSelectDay,
  onAddPersonalItem,
  onPersonalItemPress,
  onShiftPress,
  onOfferPress,
}: {
  weeks: AgendaWeek[];
  /** "YYYY-MM" do mês exibido — dias fora dele ficam esmaecidos. */
  monthKey: string;
  todayKey: string;
  selectedDayKey: string;
  offers: DayOffer[];
  holidays: AgendaHoliday[];
  personalOccurrences: PersonalAgendaOccurrence[];
  scheduleState: AgendaDataState;
  personalState: AgendaDataState;
  refreshControl: ReactElement<RefreshControlProps>;
  /** Desktop: a página rola por inteiro — sem ScrollView interno aqui. */
  embedInPage?: boolean;
  onSelectDay: (dateKey: string) => void;
  onAddPersonalItem: (dateKey: string) => void;
  onPersonalItemPress: (itemId: number) => void;
  onShiftPress: (id: number) => void;
  onOfferPress: () => void;
}) {
  const dayByKey = useMemo(() => {
    const map = new Map<string, AgendaDay>();
    for (const w of weeks) for (const d of w.days) map.set(d.date, d);
    return map;
  }, [weeks]);

  const offersByDay = useMemo(() => {
    const map = new Map<string, DayOffer[]>();
    for (const offer of offers) {
      const current = map.get(offer.date) ?? [];
      current.push(offer);
      map.set(offer.date, current);
    }
    return map;
  }, [offers]);

  const holidaysByDay = useMemo(() => {
    const map = new Map<string, AgendaHoliday[]>();
    for (const holiday of holidays) {
      const current = map.get(holiday.date) ?? [];
      current.push(holiday);
      map.set(holiday.date, current);
    }
    return map;
  }, [holidays]);

  const personalByDay = useMemo(() => {
    const map = new Map<string, PersonalAgendaOccurrence[]>();
    for (const occurrence of personalOccurrences) {
      for (const dateKey of occurrence.localDateKeys) {
        const current = map.get(dateKey) ?? [];
        current.push(occurrence);
        map.set(dateKey, current);
      }
    }
    for (const [dateKey, occurrences] of map) {
      map.set(dateKey, personalOccurrencesOnDay(occurrences, dateKey));
    }
    return map;
  }, [personalOccurrences]);

  const selectedDay = dayByKey.get(selectedDayKey);
  const selectedOffers = offersByDay.get(selectedDayKey) ?? [];
  const selectedPersonalOccurrences = personalByDay.get(selectedDayKey) ?? [];
  const selectedHolidays = holidaysByDay.get(selectedDayKey) ?? [];

  const inner = (
    <>
      <CalendarFrame style={{ marginHorizontal: -theme.space[2] }}>
        <CalendarLegend items={[...MONTH_AGENDA_LEGEND]} />

        {/* Iniciais dos dias, sobre navy */}
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

        {/* A grade: réguas de 1px em navy a 14% (a malha do ícone) */}
        {weeks.map((week) => (
          <View key={week.weekStart} style={{ flexDirection: "row" }}>
            {week.days.map((day, i) => {
              const inMonth = day.date.startsWith(monthKey);
              const isToday = day.date === todayKey;
              const isSelected = day.date === selectedDayKey;
              const isSunday = day.dow === 0;
              const isSaturday = day.dow === 6;
              const dayHolidays = holidaysByDay.get(day.date) ?? [];
              const isHoliday = dayHolidays.length > 0;
              const surface = agendaDaySurface({
                inMonth,
                isSunday,
                isSaturday,
                isHoliday,
                isSelected,
              });
              const isRedDay = surface === "SUNDAY_OR_HOLIDAY";
              const shifts = day.groups.flatMap((g) => g.shifts);
              const dayOffers = offersByDay.get(day.date) ?? [];
              const dayPersonalOccurrences = personalByDay.get(day.date) ?? [];
              const presentation = buildAgendaDayPresentation({
                dateKey: day.date,
                shifts,
                offers: dayOffers,
                personalOccurrences: dayPersonalOccurrences,
              });
              const dayNum = parseInt(day.date.slice(8, 10), 10);
              const iconColor = isRedDay
                ? theme.colors.onDark.text
                : theme.palette.neutral[900];

              return (
                <Pressable
                  key={day.date}
                  onPress={() => onSelectDay(day.date)}
                  accessibilityRole="button"
                  accessibilityState={{ selected: isSelected }}
                  accessibilityLabel={`${formatSelectedDay(day.date)}${isToday ? ", hoje" : ""}${dayHolidays.length ? `, ${dayHolidays.map((holiday) => holiday.name).join(" e ")}` : ""}, ${shifts.length} ${shifts.length === 1 ? "plantão" : "plantões"}${dayOffers.length ? ", oferta disponível" : ""}${presentation.hasAppointment ? ", compromisso" : ""}${presentation.hasReminder ? ", lembrete" : ""}${presentation.hasBirthday ? ", aniversário" : ""}`}
                  style={({ pressed }) => ({
                    flex: 1,
                    minHeight: 64,
                    paddingTop: 6,
                    paddingBottom: 5,
                    paddingHorizontal: 3,
                    borderTopWidth: 1,
                    borderTopColor: theme.colors.gridLine,
                    borderLeftWidth: i === 0 ? 0 : 1,
                    borderLeftColor: theme.colors.gridLine,
                    backgroundColor:
                      surface === "SUNDAY_OR_HOLIDAY"
                        ? theme.palette.danger[600]
                        : surface === "SELECTED"
                          ? theme.colors.paperSelected
                          : surface === "SATURDAY"
                            ? theme.palette.neutral[100]
                            : "transparent",
                    alignItems: "center",
                    gap: 3,
                    opacity: pressed ? 0.8 : 1,
                  })}
                >
                  <View
                    style={{
                      flexDirection: "row",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    <DayNumeral
                      day={dayNum}
                      size={24}
                      emphasis={
                        !inMonth
                          ? "muted"
                          : isRedDay
                            ? isToday || isSelected
                              ? "todayOnDark"
                              : "onDark"
                            : isToday
                              ? "today"
                              : "plain"
                      }
                    />
                    {presentation.hasAppointment && inMonth ? (
                      <View
                        style={{
                          width: 5,
                          height: 5,
                          marginLeft: 1,
                          borderRadius: 3,
                          backgroundColor: iconColor,
                        }}
                      />
                    ) : null}
                  </View>
                  <View style={{ alignItems: "center", gap: 2 }}>
                    {presentation.periods.map((signal, periodIndex) => (
                      <View
                        key={periodIndex}
                        style={{
                          width: 20,
                          height: 3,
                          borderRadius: 2,
                          borderWidth: isRedDay && signal !== "EMPTY" ? 0.5 : 0,
                          borderColor: theme.colors.onDark.text,
                          backgroundColor:
                            !inMonth || signal === "EMPTY"
                              ? "transparent"
                              : signal === "OFFER"
                                ? theme.palette.primary[700]
                                : theme.palette.neutral[900],
                        }}
                      />
                    ))}
                  </View>
                  {inMonth &&
                  (presentation.hasReminder || presentation.hasBirthday) ? (
                    <View
                      style={{
                        minHeight: 11,
                        flexDirection: "row",
                        alignItems: "center",
                        justifyContent: "center",
                        gap: 2,
                      }}
                    >
                      {presentation.hasReminder ? (
                        <Ribbon size={10} color={iconColor} strokeWidth={2.5} />
                      ) : null}
                      {presentation.hasBirthday ? (
                        <CakeSlice
                          size={10}
                          color={iconColor}
                          strokeWidth={2.5}
                        />
                      ) : null}
                    </View>
                  ) : null}
                </Pressable>
              );
            })}
          </View>
        ))}
      </CalendarFrame>

      <View
        style={{
          marginTop: theme.space[2],
          flexDirection: "row",
          justifyContent: "flex-end",
        }}
      >
        <Pressable
          onPress={() => onAddPersonalItem(selectedDayKey)}
          accessibilityRole="button"
          accessibilityLabel={`Adicionar compromisso, lembrete ou aniversário em ${formatSelectedDay(selectedDayKey)}`}
          style={({ pressed }) => ({
            width: 46,
            height: 46,
            borderRadius: theme.radius.md + 2,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: theme.colors.success,
            opacity: pressed ? 0.82 : 1,
            ...theme.shadow.sm,
          })}
        >
          <Plus size={25} color={theme.colors.onDark.text} strokeWidth={3} />
        </Pressable>
      </View>

      {/* Detalhe do dia selecionado */}
      <View style={{ marginTop: theme.space[3] + 1, gap: theme.space[2] + 1 }}>
        <PersonalAgendaDaySummary
          dateKey={selectedDayKey}
          todayKey={todayKey}
          holidays={selectedHolidays}
          personalOccurrences={selectedPersonalOccurrences}
          personalState={personalState}
        />

        {selectedPersonalOccurrences.map((occurrence) => (
          <PersonalAgendaOccurrenceCard
            key={`${occurrence.itemId}:${occurrence.occurrenceKey}`}
            occurrence={occurrence}
            onPress={() => onPersonalItemPress(occurrence.itemId)}
          />
        ))}

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
              <Text
                style={{
                  ...theme.text.body,
                  fontSize: 13.5,
                  fontWeight: theme.weight.bold,
                  color: theme.colors.brand,
                }}
              >
                Oferta de troca — {offer.shiftLabel}
              </Text>
              <Text
                style={{
                  ...theme.text.caption,
                  color: theme.colors.textSecondary,
                }}
              >
                {offer.fromProfessionalName} · {offer.timeRange} · toque para
                responder
              </Text>
            </View>
          </Pressable>
        ))}

        {scheduleState !== "READY" ? (
          <View
            style={{
              paddingVertical: theme.space[5],
              alignItems: "center",
              backgroundColor: theme.colors.surfaceAlt,
              borderWidth: 1,
              borderColor: theme.colors.border,
              borderRadius: theme.radius.md + 2,
            }}
          >
            <Text style={{ ...theme.text.body, color: theme.colors.textMuted }}>
              {scheduleState === "LOADING"
                ? "Carregando plantões…"
                : "Plantões indisponíveis nesta consulta."}
            </Text>
          </View>
        ) : !selectedDay || selectedDay.groups.length === 0 ? (
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
              Nenhum plantão neste dia.
            </Text>
          </View>
        ) : (
          selectedDay.groups.map((group) => (
            <View
              key={`${group.hospitalId}-${group.sectorId}-${group.scheduleContextId ?? "legacy"}`}
              style={{ gap: theme.space[1] + 1 }}
            >
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
                {group.qualificationName ? ` – ${group.qualificationName}` : ""}
              </Text>
              {group.shifts.map((shift) => (
                <ShiftRowCard
                  key={shift.id}
                  shift={shift}
                  context="actionable"
                  onPress={() => onShiftPress(shift.id)}
                />
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

function countLabel(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

export function PersonalAgendaDaySummary({
  dateKey,
  todayKey,
  holidays,
  personalOccurrences,
  personalState = "READY",
}: {
  dateKey: string;
  todayKey: string;
  holidays: readonly AgendaHoliday[];
  personalOccurrences: readonly PersonalAgendaOccurrence[];
  personalState?: AgendaDataState;
}) {
  const isToday = dateKey === todayKey;
  const appointments = personalOccurrences.filter(
    (occurrence) => occurrence.kind === "APPOINTMENT",
  );
  const reminders = personalOccurrences.filter(
    (occurrence) => occurrence.kind === "REMINDER",
  );
  const birthdays = personalOccurrences.filter(
    (occurrence) => occurrence.kind === "BIRTHDAY",
  );
  const personalParts = [
    appointments.length
      ? countLabel(appointments.length, "compromisso", "compromissos")
      : null,
    reminders.length
      ? countLabel(reminders.length, "lembrete", "lembretes")
      : null,
  ].filter(Boolean);

  return (
    <View
      style={{
        gap: theme.space[2],
        paddingHorizontal: theme.space[3],
        paddingVertical: theme.space[3],
        borderRadius: theme.radius.lg,
        borderWidth: 1,
        borderColor: theme.colors.borderStrong,
        backgroundColor: theme.colors.surface,
      }}
    >
      <Text
        style={{
          ...theme.text.titleSm,
          fontWeight: theme.weight.bold,
          color: theme.colors.textPrimary,
        }}
      >
        {isToday
          ? `${greetingForHour(new Date().getHours())}. Hoje é ${formatSelectedDay(dateKey).toLocaleLowerCase("pt-BR")}.`
          : formatSelectedDay(dateKey)}
      </Text>

      {holidays.map((holiday) => (
        <View
          key={`${holiday.scope}:${holiday.name}`}
          style={{ flexDirection: "row", alignItems: "center", gap: 6 }}
        >
          <View
            style={{
              width: 8,
              height: 8,
              borderRadius: 4,
              backgroundColor: theme.palette.danger[600],
            }}
          />
          <Text
            style={{
              ...theme.text.body,
              color: theme.palette.danger[900],
              fontWeight: theme.weight.semibold,
            }}
          >
            {holiday.name}
          </Text>
        </View>
      ))}

      <Text style={{ ...theme.text.body, color: theme.colors.textSecondary }}>
        {personalState === "LOADING"
          ? "Carregando seus itens privados…"
          : personalState === "ERROR"
            ? "Seus itens privados estão indisponíveis no momento."
            : personalParts.length > 0
              ? `${isToday ? "Hoje você tem" : "Você tem"} ${personalParts.join(" e ")}.`
              : `${isToday ? "Hoje você não tem" : "Você não tem"} compromissos pessoais nem lembretes.`}
      </Text>

      {birthdays.length > 0 ? (
        <Text style={{ ...theme.text.body, color: theme.colors.textSecondary }}>
          {birthdays
            .map((birthday) => `Aniversário de ${birthday.title}`)
            .join(" · ")}
        </Text>
      ) : null}
    </View>
  );
}

export function PersonalAgendaOccurrenceCard({
  occurrence,
  onPress,
}: {
  occurrence: PersonalAgendaOccurrence;
  onPress: () => void;
}) {
  const visual =
    occurrence.kind === "APPOINTMENT"
      ? {
          Icon: CalendarClock,
          label: "Compromisso",
          color: theme.palette.neutral[900],
        }
      : occurrence.kind === "REMINDER"
        ? { Icon: Ribbon, label: "Lembrete", color: theme.colors.brand }
        : {
            Icon: CakeSlice,
            label: "Aniversário",
            color: theme.palette.warning[700],
          };
  const Icon = visual.Icon;

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${visual.label}: ${occurrence.title}, ${personalOccurrenceTimeLabel(occurrence)}. Toque para editar`}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "flex-start",
        gap: theme.space[2] + 2,
        paddingVertical: theme.space[3],
        paddingHorizontal: theme.space[3],
        borderWidth: 1,
        borderLeftWidth: 4,
        borderColor: theme.colors.borderStrong,
        borderLeftColor: visual.color,
        borderRadius: theme.radius.lg,
        backgroundColor: theme.colors.surface,
        opacity: pressed ? 0.84 : 1,
      })}
    >
      <Icon size={18} color={visual.color} strokeWidth={2.3} />
      <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
        <Text
          style={{
            ...theme.text.body,
            color: theme.colors.textPrimary,
            fontWeight: theme.weight.bold,
          }}
          numberOfLines={2}
        >
          {occurrence.title}
        </Text>
        <Text
          style={{ ...theme.text.caption, color: theme.colors.textSecondary }}
        >
          {visual.label} · {personalOccurrenceTimeLabel(occurrence)}
        </Text>
        {occurrence.locationLabel ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
            <MapPin size={12} color={theme.colors.textMuted} />
            <Text
              numberOfLines={1}
              style={{
                ...theme.text.caption,
                flex: 1,
                color: theme.colors.textMuted,
              }}
            >
              {occurrence.locationLabel}
            </Text>
          </View>
        ) : null}
        {occurrence.alertOffsets.length > 0 ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
            <Bell size={12} color={theme.colors.textMuted} />
            <Text
              style={{ ...theme.text.caption, color: theme.colors.textMuted }}
            >
              {countLabel(
                occurrence.alertOffsets.length,
                "aviso configurado",
                "avisos configurados",
              )}
            </Text>
          </View>
        ) : null}
        {occurrence.kind === "APPOINTMENT" &&
        occurrence.conflict.hasConflict ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
            <TriangleAlert size={13} color={theme.colors.danger} />
            <Text
              style={{
                ...theme.text.caption,
                color: theme.palette.danger[900],
                fontWeight: theme.weight.semibold,
              }}
            >
              Conflito de horário detectado
            </Text>
          </View>
        ) : null}
      </View>
    </Pressable>
  );
}

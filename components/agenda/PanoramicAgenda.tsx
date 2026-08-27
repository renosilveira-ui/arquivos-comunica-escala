// components/agenda/PanoramicAgenda.tsx — o Panorama hospital × dia
// (desktop): a grade grande como FOLHA DE CALENDÁRIO da marca.
//
// Proposta "Escala+ Personalidade" (23/08): a estrutura aprovada continua
// — hospital/setor nas linhas, os sete dias nas colunas. O que muda é o
// traje: moldura navy de 2 px com os dois furos de pendurar, malha de 1 px
// em navy a 14% em toda célula, cabeçalho navy sólido com o numeral do dia
// circulado (hoje = anel branco, em vez de coluna pintada), fim de semana
// em papel rebaixado, hospital escrito UMA vez (os setores indentam abaixo)
// e o resumo do período na própria moldura.
//
// A grade não sobrevive a 375 pt (47 pt por coluna): no celular a Agenda
// usa a folha de mês (MonthAgenda). Aqui, fora do desktop, ela rola na
// horizontal como último recurso.

import { useMemo, type ReactElement } from "react";
import {
  ScrollView,
  Text,
  Pressable,
  View,
  type RefreshControlProps,
} from "react-native";
import {
  CheckCircle2,
  CircleDashed,
  Clock,
  Rows3,
  UserCircle2,
} from "lucide-react-native";
import { theme } from "@/lib/theme";
import { shiftVisualFor } from "@/lib/shift-visual";
import { CalendarFrame, DayNumeral, numeral } from "./CalendarSheet";
import { formatTimeRange } from "./ShiftRowCard";
import { formatHospitalTime } from "@/lib/hospital-time";

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

type PanoramaRow = {
  key: string;
  hospitalName: string;
  sectorName: string;
  qualificationName: string;
  /** Primeira linha do hospital: o nome aparece aqui, só aqui. */
  firstOfHospital: boolean;
  days: Record<string, AgendaShift[]>;
};

const DAY_LABELS = ["DOM", "SEG", "TER", "QUA", "QUI", "SEX", "SÁB"] as const;
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
const LABEL_COL = 214;
const MAX_CHIPS = 3;

function buildPanoramaRows(week: AgendaWeek): PanoramaRow[] {
  const rows = new Map<string, PanoramaRow>();
  for (const day of week.days) {
    for (const group of day.groups) {
      const key = `${group.hospitalId}-${group.sectorId}-${group.scheduleContextId ?? "legacy"}`;
      const row = rows.get(key) ?? {
        key,
        hospitalName: group.hospitalName,
        sectorName: group.sectorName,
        qualificationName: group.qualificationName ?? "Escala não classificada",
        firstOfHospital: false,
        days: {},
      };
      row.days[day.date] = group.shifts;
      rows.set(key, row);
    }
  }
  const sorted = Array.from(rows.values()).sort((a, b) => {
    const hospital = a.hospitalName.localeCompare(b.hospitalName, "pt-BR");
    if (hospital !== 0) return hospital;
    const sector = a.sectorName.localeCompare(b.sectorName, "pt-BR");
    if (sector !== 0) return sector;
    return a.qualificationName.localeCompare(b.qualificationName, "pt-BR");
  });
  let last: string | null = null;
  for (const row of sorted) {
    row.firstOfHospital = row.hospitalName !== last;
    last = row.hospitalName;
  }
  return sorted;
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

function weekTitle(week: AgendaWeek): { eyebrow: string; title: string } {
  const first = new Date(`${week.days[0]?.date ?? week.weekStart}T12:00:00`);
  const last = new Date(
    `${week.days[week.days.length - 1]?.date ?? week.weekStart}T12:00:00`,
  );
  const month = MONTHS_PT[first.getMonth()];
  const eyebrow = `${month.charAt(0).toUpperCase()}${month.slice(1)} ${first.getFullYear()}`;
  const title =
    first.getMonth() === last.getMonth()
      ? `Semana ${first.getDate()} – ${last.getDate()}`
      : `Semana ${first.getDate()}/${String(first.getMonth() + 1).padStart(2, "0")} – ${last.getDate()}/${String(last.getMonth() + 1).padStart(2, "0")}`;
  return { eyebrow, title };
}

const pad2 = (n: number) => String(n).padStart(2, "0");

export function PanoramicAgenda({
  weeks,
  todayKey,
  isDesktop,
  refreshControl,
  onShiftPress,
}: {
  weeks: AgendaWeek[];
  todayKey: string;
  isDesktop: boolean;
  refreshControl: ReactElement<RefreshControlProps>;
  onShiftPress: (id: number) => void;
}) {
  const summary = useMemo(() => summarizeWeeks(weeks), [weeks]);

  const sheets = (
    <View
      style={{ gap: theme.space[6], minWidth: isDesktop ? undefined : 760 }}
    >
      {weeks.map((week, index) => {
        const rows = buildPanoramaRows(week);
        const { eyebrow, title } = weekTitle(week);
        return (
          <CalendarFrame key={week.weekStart}>
            {/* Cabeçalho da folha: período + resumo do período (na 1ª folha) */}
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                flexWrap: "wrap",
                gap: theme.space[4],
                paddingVertical: theme.space[3] + 1,
                paddingHorizontal: theme.space[5],
                borderBottomWidth: 2,
                borderBottomColor: theme.colors.brand,
              }}
            >
              <View style={{ gap: 1 }}>
                <Text
                  style={{
                    ...theme.text.eyebrow,
                    fontSize: 10.5,
                    fontWeight: theme.weight.bold,
                    textTransform: "uppercase",
                    color: theme.colors.textSecondary,
                  }}
                >
                  {eyebrow}
                </Text>
                <Text
                  style={{
                    ...theme.text.title,
                    fontSize: 21,
                    fontWeight: theme.weight.semibold,
                    color: theme.colors.textPrimary,
                  }}
                >
                  {title}
                </Text>
              </View>
              {/* Legenda dos estados — no cabeçalho da folha, como no canvas */}
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: theme.space[3] + 3,
                  flexWrap: "wrap",
                }}
              >
                {[
                  {
                    label: "Vago",
                    Icon: CircleDashed,
                    color: theme.colors.textSecondary,
                  },
                  {
                    label: "Pendente",
                    Icon: Clock,
                    color: theme.palette.warning[700],
                  },
                  {
                    label: "Ocupado",
                    Icon: CheckCircle2,
                    color: theme.palette.success[700],
                  },
                  {
                    label: "Meu",
                    Icon: UserCircle2,
                    color: theme.colors.brand,
                  },
                ].map(({ label, Icon, color }) => (
                  <View
                    key={label}
                    style={{
                      flexDirection: "row",
                      alignItems: "center",
                      gap: theme.space[1] + 2,
                    }}
                  >
                    <Icon size={15} color={color} />
                    <Text
                      style={{
                        ...theme.text.caption,
                        fontSize: 12.5,
                        fontWeight: theme.weight.semibold,
                        color: theme.colors.textSecondary,
                      }}
                    >
                      {label}
                    </Text>
                  </View>
                ))}
              </View>
              {index === 0 ? (
                <View style={{ marginLeft: "auto", flexDirection: "row" }}>
                  <SummaryCell
                    label="Plantões"
                    value={summary.shifts}
                    color={theme.colors.textPrimary}
                  />
                  <SummaryCell
                    label="Em aberto"
                    value={summary.open}
                    color={theme.palette.warning[700]}
                  />
                  <SummaryCell
                    label="Pendentes"
                    value={summary.pending}
                    color={theme.palette.warning[700]}
                  />
                  <SummaryCell
                    label="Meus"
                    value={summary.mine}
                    color={theme.colors.brand}
                  />
                </View>
              ) : null}
            </View>

            {/* Linha de cabeçalho navy: Hospital / setor + os sete dias */}
            <View
              style={{
                flexDirection: "row",
                backgroundColor: theme.colors.brand,
              }}
            >
              <View
                style={{
                  width: LABEL_COL,
                  flexDirection: "row",
                  alignItems: "center",
                  gap: theme.space[2],
                  paddingVertical: theme.space[3] - 1,
                  paddingHorizontal: theme.space[3] + 2,
                }}
              >
                <Rows3 size={15} color={theme.colors.onDark.textMuted} />
                <Text
                  style={{
                    ...theme.text.eyebrow,
                    fontSize: 10.5,
                    fontWeight: theme.weight.bold,
                    textTransform: "uppercase",
                    color: theme.colors.onDark.textSoft,
                  }}
                >
                  Hospital / setor / qualificação
                </Text>
              </View>
              {week.days.map((day) => {
                const isToday = day.date === todayKey;
                return (
                  <View
                    key={day.date}
                    style={{
                      flex: 1,
                      minWidth: 78,
                      alignItems: "center",
                      gap: 3,
                      paddingVertical: theme.space[2] + 1,
                      paddingHorizontal: theme.space[2],
                      borderLeftWidth: 1,
                      borderLeftColor: theme.colors.onDark.surface,
                    }}
                  >
                    <Text
                      style={{
                        ...theme.text.eyebrow,
                        fontSize: 10.5,
                        fontWeight: theme.weight.bold,
                        color: theme.colors.onDark.textMuted,
                      }}
                    >
                      {DAY_LABELS[day.dow]}
                    </Text>
                    <DayNumeral
                      day={parseInt(day.date.slice(8, 10), 10)}
                      size={30}
                      emphasis={isToday ? "todayOnDark" : "onDark"}
                    />
                  </View>
                );
              })}
            </View>

            {rows.length === 0 ? (
              <View style={{ padding: theme.space[6], alignItems: "center" }}>
                <Text
                  style={{ ...theme.text.body, color: theme.colors.textMuted }}
                >
                  Sem plantões nesta semana.
                </Text>
              </View>
            ) : (
              rows.map((row) => (
                <View key={row.key} style={{ flexDirection: "row" }}>
                  <View
                    style={{
                      width: LABEL_COL,
                      justifyContent: "center",
                      gap: 1,
                      paddingVertical: theme.space[2] + 1,
                      paddingHorizontal: theme.space[3] + 2,
                      borderBottomWidth: 1,
                      borderBottomColor: theme.colors.gridLine,
                      borderRightWidth: 2,
                      borderRightColor: theme.colors.brand,
                      backgroundColor: row.firstOfHospital
                        ? theme.colors.surfaceAlt
                        : theme.colors.surface,
                    }}
                  >
                    {row.firstOfHospital ? (
                      <Text
                        numberOfLines={1}
                        style={{
                          ...theme.text.body,
                          fontSize: 13.5,
                          fontWeight: theme.weight.bold,
                          color: theme.colors.brand,
                        }}
                      >
                        {row.hospitalName}
                      </Text>
                    ) : null}
                    <Text
                      numberOfLines={1}
                      style={{
                        ...theme.text.body,
                        fontSize: 13,
                        color: theme.colors.textSecondary,
                      }}
                    >
                      {row.sectorName}
                    </Text>
                    <Text
                      numberOfLines={1}
                      style={{
                        ...theme.text.caption,
                        fontSize: 11,
                        color: theme.colors.textMuted,
                      }}
                    >
                      {row.qualificationName}
                    </Text>
                  </View>
                  {week.days.map((day) => {
                    const shifts = row.days[day.date] ?? [];
                    const isWeekend = day.dow === 0 || day.dow === 6;
                    return (
                      <View
                        key={day.date}
                        style={{
                          flex: 1,
                          minWidth: 78,
                          minHeight: 66,
                          padding: 5,
                          gap: 4,
                          borderBottomWidth: 1,
                          borderBottomColor: theme.colors.gridLine,
                          borderLeftWidth: 1,
                          borderLeftColor: theme.colors.gridLine,
                          backgroundColor: isWeekend
                            ? theme.colors.paperWeekend
                            : theme.colors.surface,
                        }}
                      >
                        {shifts.length === 0 ? (
                          <View
                            style={{
                              flex: 1,
                              alignItems: "center",
                              justifyContent: "center",
                            }}
                          >
                            <Text
                              style={{
                                ...numeral,
                                fontSize: 13,
                                color: theme.colors.textDisabled,
                              }}
                            >
                              ·
                            </Text>
                          </View>
                        ) : (
                          shifts
                            .slice(0, MAX_CHIPS)
                            .map((shift) => (
                              <GridChip
                                key={shift.id}
                                shift={shift}
                                onPress={() => onShiftPress(shift.id)}
                              />
                            ))
                        )}
                        {shifts.length > MAX_CHIPS ? (
                          <Text
                            style={{
                              ...numeral,
                              fontSize: 11,
                              fontWeight: theme.weight.bold,
                              color: theme.colors.textSecondary,
                              paddingLeft: 2,
                            }}
                          >
                            +{shifts.length - MAX_CHIPS}
                          </Text>
                        ) : null}
                      </View>
                    );
                  })}
                </View>
              ))
            )}
          </CalendarFrame>
        );
      })}
    </View>
  );

  if (isDesktop) {
    // Desktop rola a PÁGINA inteira (ScreenContainer scrollPage).
    return <View style={{ paddingBottom: theme.space[10] }}>{sheets}</View>;
  }
  return (
    <ScrollView
      style={{ flex: 1 }}
      refreshControl={refreshControl}
      contentContainerStyle={{ paddingBottom: theme.space[20] }}
      showsVerticalScrollIndicator={false}
    >
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ alignItems: "flex-start", paddingTop: 2 }}
      >
        {sheets}
      </ScrollView>
    </ScrollView>
  );
}

/** Chip de plantão na célula: barra de 4 px + hora tabular + nome. */
function GridChip({
  shift,
  onPress,
}: {
  shift: AgendaShift;
  onPress: () => void;
}) {
  // O panorama geral é listagem: VAGO neutro. Quem quer agir abre o detalhe.
  const v = shiftVisualFor(shift.status, {
    isMine: shift.isMine,
    context: "listing",
  });
  const Icon = v.Icon;
  const name = shift.isMine
    ? "Você"
    : (shift.professionalNames[0] ??
      (shift.status === "VAGO"
        ? "Sem escalado"
        : shift.status === "PENDENTE"
          ? "Sem confirmar"
          : v.label));
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${shift.label}, ${formatTimeRange(shift.startAt, shift.endAt)}, ${name}, ${v.label}`}
      style={({ pressed }) => ({
        gap: 1,
        paddingVertical: 5,
        paddingHorizontal: 7,
        borderRadius: theme.radius.md - 2,
        backgroundColor: v.bg,
        borderWidth: 1,
        borderColor: v.border,
        borderLeftWidth: 4,
        borderLeftColor: v.bar,
        opacity: pressed ? 0.85 : 1,
      })}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
        <Icon size={11} color={v.iconFg} />
        <Text
          style={{
            ...numeral,
            fontSize: 11.5,
            lineHeight: 14,
            fontWeight: theme.weight.bold,
            letterSpacing: -0.2,
            color: v.timeFg,
          }}
        >
          {formatHospitalTime(shift.startAt)}-{formatHospitalTime(shift.endAt)}
        </Text>
      </View>
      <Text
        numberOfLines={1}
        style={{
          fontSize: 11,
          lineHeight: 14,
          fontWeight: v.nameWeight,
          color: v.nameFg,
        }}
      >
        {name}
      </Text>
    </Pressable>
  );
}

function SummaryCell({
  label,
  value,
  color,
}: {
  label: string;
  value: number;
  color: string;
}) {
  return (
    <View
      style={{
        alignItems: "flex-end",
        paddingHorizontal: theme.space[3] + 1,
        borderLeftWidth: 1,
        borderLeftColor: theme.colors.borderStrong,
      }}
    >
      <Text
        style={{
          ...numeral,
          fontSize: 20,
          lineHeight: 24,
          fontWeight: theme.weight.bold,
          letterSpacing: -0.4,
          color,
        }}
      >
        {pad2(value)}
      </Text>
      <Text
        style={{
          ...theme.text.eyebrow,
          fontSize: 10.5,
          letterSpacing: 1.2,
          fontWeight: theme.weight.bold,
          textTransform: "uppercase",
          color: theme.colors.textSecondary,
        }}
      >
        {label}
      </Text>
    </View>
  );
}

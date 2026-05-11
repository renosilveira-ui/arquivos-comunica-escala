import { useMemo, type ReactElement } from "react";
import {
  ScrollView,
  Text,
  TouchableOpacity,
  View,
  type RefreshControlProps,
} from "react-native";
import { Rows3 } from "lucide-react-native";
import { theme } from "@/lib/theme";

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

const DAY_LABELS = ["DOM", "SEG", "TER", "QUA", "QUI", "SEX", "SÁB"] as const;

function formatDayHeader(date: string, dow: number): string {
  const day = parseInt(date.slice(8, 10), 10);
  return `${String(day).padStart(2, "0")} ${DAY_LABELS[dow]}`;
}

function formatTimeRange(startAt: Date | string, endAt: Date | string): string {
  const s = new Date(startAt);
  const e = new Date(endAt);
  const f = (n: number) => String(n).padStart(2, "0");
  return `${f(s.getHours())}:${f(s.getMinutes())}-${f(e.getHours())}:${f(e.getMinutes())}`;
}

function shiftBorderColor(status: string): string {
  if (status === "OCUPADO") return theme.colors.success;
  if (status === "PENDENTE") return theme.colors.warning;
  return theme.colors.border;
}

function buildPanoramaRows(week: AgendaWeek): PanoramaRow[] {
  const rows = new Map<string, PanoramaRow>();

  for (const day of week.days) {
    for (const group of day.groups) {
      const key = `${group.hospitalId}-${group.sectorId}`;
      const row = rows.get(key) ?? {
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
    <View
      style={{
        flexDirection: "row",
        gap: theme.space[4],
        alignItems: "flex-start",
      }}
    >
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
                  <View
                    style={{
                      width: 220,
                      padding: theme.space[3],
                      justifyContent: "center",
                    }}
                  >
                    <View
                      style={{
                        flexDirection: "row",
                        alignItems: "center",
                        gap: theme.space[2],
                      }}
                    >
                      <Rows3 size={16} color={theme.colors.primary} />
                      <Text
                        style={{
                          ...theme.text.caption,
                          color: theme.colors.textSecondary,
                          fontWeight: theme.weight.bold,
                          textTransform: "uppercase",
                        }}
                      >
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
                          backgroundColor: isToday
                            ? theme.colors.primarySoft
                            : theme.colors.surfaceAlt,
                        }}
                      >
                        <Text
                          style={{
                            ...theme.text.caption,
                            color: isToday
                              ? theme.colors.primary
                              : theme.colors.textSecondary,
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
                  <View
                    style={{ padding: theme.space[6], alignItems: "center" }}
                  >
                    <Text
                      style={{
                        ...theme.text.body,
                        color: theme.colors.textMuted,
                      }}
                    >
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
                        <Text
                          numberOfLines={1}
                          style={{
                            ...theme.text.body,
                            color: theme.colors.textPrimary,
                            fontWeight: theme.weight.semibold,
                          }}
                        >
                          {row.hospitalName}
                        </Text>
                        <Text
                          numberOfLines={1}
                          style={{
                            ...theme.text.caption,
                            color: theme.colors.textMuted,
                            marginTop: theme.space[1],
                          }}
                        >
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
                              <Text
                                style={{
                                  ...theme.text.caption,
                                  color: theme.colors.textDisabled,
                                  textAlign: "center",
                                }}
                              >
                                -
                              </Text>
                            ) : (
                              shifts.slice(0, 3).map((shift) => (
                                <TouchableOpacity
                                  key={shift.id}
                                  onPress={() => onShiftPress(shift.id)}
                                  activeOpacity={0.75}
                                  style={{
                                    borderLeftWidth: 3,
                                    borderLeftColor: shiftBorderColor(
                                      shift.status,
                                    ),
                                    backgroundColor: shift.isMine
                                      ? theme.colors.primarySoft
                                      : theme.colors.surfaceAlt,
                                    borderRadius: theme.radius.sm,
                                    paddingHorizontal: theme.space[2],
                                    paddingVertical: theme.space[1],
                                  }}
                                >
                                  <Text
                                    numberOfLines={1}
                                    style={{
                                      ...theme.text.caption,
                                      color: theme.colors.textPrimary,
                                      fontWeight: theme.weight.semibold,
                                    }}
                                  >
                                    {formatTimeRange(
                                      shift.startAt,
                                      shift.endAt,
                                    )}
                                  </Text>
                                  <Text
                                    numberOfLines={1}
                                    style={{
                                      fontSize: 10,
                                      lineHeight: 14,
                                      color: theme.colors.textMuted,
                                    }}
                                  >
                                    {shift.professionalNames[0] ?? shift.status}
                                  </Text>
                                </TouchableOpacity>
                              ))
                            )}
                            {shifts.length > 3 ? (
                              <Text
                                style={{
                                  ...theme.text.caption,
                                  color: theme.colors.textMuted,
                                }}
                              >
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
        <Text
          style={{
            ...theme.text.title,
            fontWeight: theme.weight.bold,
            color: theme.colors.textPrimary,
          }}
        >
          Resumo do período
        </Text>
        <SummaryLine label="Plantões" value={summary.shifts} />
        <SummaryLine label="Em aberto" value={summary.open} accent="warning" />
        <SummaryLine
          label="Pendentes"
          value={summary.pending}
          accent="warning"
        />
        <SummaryLine
          label="Meus plantões"
          value={summary.mine}
          accent="primary"
        />
        <View
          style={{
            height: 1,
            backgroundColor: theme.colors.border,
            marginVertical: theme.space[1],
          }}
        />
        <Text style={{ ...theme.text.caption, color: theme.colors.textMuted }}>
          Use esta visão para localizar rapidamente hospitais e setores que
          concentram demanda.
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
  refreshControl: ReactElement<RefreshControlProps>;
  onShiftPress: (id: number) => void;
}) {
  const flatDays = useMemo(() => weeks.flatMap((week) => week.days), [weeks]);
  const summary = useMemo(() => summarizeWeeks(weeks), [weeks]);

  return (
    <ScrollView
      style={{ flex: 1 }}
      refreshControl={refreshControl}
      contentContainerStyle={{
        paddingBottom: theme.space[10],
        gap: theme.space[4],
      }}
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
        <Text
          style={{
            ...theme.text.title,
            fontWeight: theme.weight.bold,
            color: theme.colors.textPrimary,
          }}
        >
          Seu panorama
        </Text>
        <View
          style={{
            flexDirection: "row",
            gap: theme.space[3],
            flexWrap: "wrap",
          }}
        >
          <SummaryPill label="Meus" value={summary.mine} />
          <SummaryPill label="Abertos" value={summary.open} />
          <SummaryPill label="Pendentes" value={summary.pending} />
        </View>
      </View>

      {flatDays.map((day) => {
        const isToday = day.date === todayKey;
        const total = day.groups.reduce(
          (acc, group) => acc + group.shifts.length,
          0,
        );
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
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "space-between",
              }}
            >
              <Text
                style={{
                  ...theme.text.title,
                  color: isToday
                    ? theme.colors.primary
                    : theme.colors.textPrimary,
                  fontWeight: theme.weight.bold,
                }}
              >
                {formatDayHeader(day.date, day.dow)}
              </Text>
              <Text
                style={{ ...theme.text.caption, color: theme.colors.textMuted }}
              >
                {total} plantões
              </Text>
            </View>
            {day.groups.length === 0 ? (
              <Text
                style={{ ...theme.text.body, color: theme.colors.textMuted }}
              >
                Nenhum plantão listado.
              </Text>
            ) : (
              day.groups.map((group) => (
                <View
                  key={`${group.hospitalId}-${group.sectorId}`}
                  style={{ gap: theme.space[2] }}
                >
                  <Text
                    style={{
                      ...theme.text.body,
                      color: theme.colors.textPrimary,
                      fontWeight: theme.weight.semibold,
                    }}
                  >
                    {group.hospitalName} / {group.sectorName}
                  </Text>
                  {group.shifts.map((shift) => (
                    <TouchableOpacity
                      key={shift.id}
                      onPress={() => onShiftPress(shift.id)}
                      style={{
                        borderLeftWidth: 3,
                        borderLeftColor: shiftBorderColor(shift.status),
                        backgroundColor: shift.isMine
                          ? theme.colors.primarySoft
                          : theme.colors.surfaceAlt,
                        borderRadius: theme.radius.md,
                        padding: theme.space[3],
                      }}
                    >
                      <Text
                        style={{
                          ...theme.text.body,
                          color: theme.colors.textPrimary,
                          fontWeight: theme.weight.semibold,
                        }}
                      >
                        {formatTimeRange(shift.startAt, shift.endAt)} -{" "}
                        {shift.label}
                      </Text>
                      <Text
                        style={{
                          ...theme.text.caption,
                          color: theme.colors.textMuted,
                          marginTop: theme.space[1],
                        }}
                      >
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
  const color =
    accent === "primary"
      ? theme.colors.primary
      : accent === "warning"
        ? theme.palette.warning[700]
        : theme.colors.textPrimary;
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
      }}
    >
      <Text style={{ ...theme.text.body, color: theme.colors.textSecondary }}>
        {label}
      </Text>
      <Text
        style={{ ...theme.text.title, color, fontWeight: theme.weight.bold }}
      >
        {value}
      </Text>
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
      <Text
        style={{
          ...theme.text.caption,
          color: theme.colors.textSecondary,
          fontWeight: theme.weight.semibold,
        }}
      >
        {label}: {value}
      </Text>
    </View>
  );
}

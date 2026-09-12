// components/agenda/MobileDayList.tsx — censo diário da Agenda (celular).
//
// Princípios:
//   - mostra exclusivamente o dia selecionado no cabeçalho da Agenda;
//   - reúne todos os grupos hospital + setor devolvidos pela consulta;
//   - o plantão veste o traje de lib/shift-visual.ts (barra de 4 px + fundo
//     tinted); status sempre texto + ícone, cor só como reforço;
//   - carregando = skeleton com a forma do conteúdo, não spinner.

import { useMemo, type ReactElement } from "react";
import { ScrollView, View, type RefreshControlProps } from "react-native";
import { Text } from "@/components/ui/Text";
import { theme } from "@/lib/theme";
import {
  findMobileAgendaDay,
  type MobileAgendaDay,
  type MobileAgendaWeek,
} from "@/lib/agenda-mobile-day";
import { SkeletonList } from "@/components/ui/Skeleton";
import { ShiftRowCard } from "./ShiftRowCard";

interface Props {
  weeks: MobileAgendaWeek[];
  selectedDayKey: string;
  loading?: boolean;
  refreshControl: ReactElement<RefreshControlProps>;
  onShiftPress: (id: number) => void;
  /** Conteúdo fixo acima da lista (ex.: faixa "Próximo plantão"). */
  header?: ReactElement | null;
}

export function MobileDayList({
  weeks,
  selectedDayKey,
  loading = false,
  refreshControl,
  onShiftPress,
  header,
}: Props) {
  const selectedDay = useMemo(
    () => findMobileAgendaDay(weeks, selectedDayKey),
    [weeks, selectedDayKey],
  );

  return (
    <ScrollView
      style={{ flex: 1 }}
      refreshControl={refreshControl}
      // 76pt de respiro no fim: o botão "+" fica sobre o papel, entre o
      // conteúdo e a barra de abas — nenhum plantão na pegada do botão.
      contentContainerStyle={{
        paddingBottom: theme.space[20],
        gap: theme.space[3] + 1,
      }}
      showsVerticalScrollIndicator={false}
    >
      {header}

      {loading ? (
        <SkeletonList count={3} />
      ) : selectedDay ? (
        <DayBlock day={selectedDay} onShiftPress={onShiftPress} />
      ) : (
        <Text
          style={{
            ...theme.text.body,
            color: theme.colors.textMuted,
            textAlign: "center",
            paddingVertical: theme.space[8],
          }}
        >
          Não foi possível localizar este dia.
        </Text>
      )}
    </ScrollView>
  );
}

function DayBlock({
  day,
  onShiftPress,
}: {
  day: MobileAgendaDay;
  onShiftPress: (id: number) => void;
}) {
  const empty = day.groups.length === 0;

  if (empty) {
    return (
      <Text
        style={{
          ...theme.text.body,
          color: theme.colors.textMuted,
          textAlign: "center",
          paddingVertical: theme.space[8],
        }}
      >
        Nenhum plantão neste dia.
      </Text>
    );
  }

  return (
    <View style={{ gap: theme.space[2] }}>
      {day.groups.map((group) => (
        <View
          key={`${group.hospitalId}-${group.sectorId}-${group.scheduleContextId ?? "legacy"}`}
          style={{ gap: theme.space[1] + 2 }}
        >
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
            {group.qualificationName ? ` · ${group.qualificationName}` : ""}
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
      ))}
    </View>
  );
}

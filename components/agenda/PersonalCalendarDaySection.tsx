import { Text, TouchableOpacity, View } from "react-native";
import {
  AlarmClock,
  Bell,
  Cake,
  CalendarClock,
  Repeat,
} from "lucide-react-native";

import { theme } from "@/lib/theme";
import {
  PERSONAL_CALENDAR_KIND_LABELS,
  accessibilityLabelForOccurrence,
  availabilityLabel,
  blocksTime,
  conflictSummaryText,
  formatDayHeading,
  formatOccurrenceTime,
  type PersonalCalendarDayGroup,
  type PersonalCalendarOccurrenceLike,
} from "@/lib/personal-calendar-view";

/**
 * Uma seção de dia da Agenda pessoal.
 *
 * Compromisso pessoal tem tratamento visual próprio, separado do plantão
 * institucional: ícone por tipo, tom neutro e nenhuma insígnia de escala. O
 * plantão aparece aqui só como *conflito* — informação, nunca item editável
 * por esta tela.
 */

const KIND_ICON = {
  APPOINTMENT: CalendarClock,
  REMINDER: Bell,
  BIRTHDAY: Cake,
} as const;

export function OccurrenceRow({
  occurrence,
  timeZone,
  onPress,
}: {
  occurrence: PersonalCalendarOccurrenceLike;
  timeZone: string;
  onPress: (occurrence: PersonalCalendarOccurrenceLike) => void;
}) {
  const Icon = KIND_ICON[occurrence.kind];
  const conflict = conflictSummaryText(occurrence.conflict);
  const occupies = blocksTime(occurrence);
  const hasAlerts = (occurrence.alertOffsets?.length ?? 0) > 0;

  return (
    <TouchableOpacity
      onPress={() => onPress(occurrence)}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabelForOccurrence(occurrence, timeZone)}
      activeOpacity={0.7}
      style={{
        flexDirection: "row",
        alignItems: "flex-start",
        gap: theme.space[3],
        // 44pt é o alvo mínimo de toque; o conteúdo pode crescer além disso.
        minHeight: 44,
        paddingVertical: theme.space[3],
        paddingHorizontal: theme.space[4],
        backgroundColor: theme.colors.surface,
        borderRadius: theme.radius.lg,
        borderWidth: 1,
        borderColor: conflict ? theme.colors.warning : theme.colors.border,
      }}
    >
      <View
        style={{
          width: 32,
          height: 32,
          borderRadius: theme.radius.md,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: occupies
            ? theme.colors.primarySoft
            : theme.colors.surfaceAlt,
        }}
      >
        <Icon
          size={18}
          color={occupies ? theme.colors.primary : theme.colors.textSecondary}
        />
      </View>

      <View style={{ flex: 1, gap: 2 }}>
        <Text
          numberOfLines={2}
          style={{
            fontSize: theme.text.titleSm.fontSize,
            lineHeight: theme.text.titleSm.lineHeight,
            fontWeight: "600",
            color: theme.colors.textPrimary,
          }}
        >
          {occurrence.title}
        </Text>
        {occurrence.source === "GOOGLE" ? (
          <Text
            style={{
              fontSize: theme.text.caption.fontSize,
              color: theme.colors.textMuted,
            }}
          >
            Do seu Google Agenda · edite lá
          </Text>
        ) : null}

        <View
          style={{
            flexDirection: "row",
            flexWrap: "wrap",
            alignItems: "center",
            gap: theme.space[2],
          }}
        >
          <Text
            style={{
              fontSize: theme.text.body.fontSize,
              color: theme.colors.textSecondary,
            }}
          >
            {formatOccurrenceTime(occurrence, timeZone)}
          </Text>
          <Text
            style={{
              fontSize: theme.text.caption.fontSize,
              color: theme.colors.textMuted,
            }}
          >
            · {PERSONAL_CALENDAR_KIND_LABELS[occurrence.kind]}
          </Text>
          {occupies ? (
            <Text
              style={{
                fontSize: theme.text.caption.fontSize,
                color: theme.colors.textMuted,
              }}
            >
              · {availabilityLabel(occurrence)}
            </Text>
          ) : null}
          {hasAlerts ? (
            <AlarmClock size={13} color={theme.colors.textMuted} />
          ) : null}
          {occurrence.occurrenceKey.includes(":") ? (
            <Repeat size={13} color={theme.colors.textMuted} />
          ) : null}
        </View>

        {occurrence.locationLabel ? (
          <Text
            numberOfLines={1}
            style={{
              fontSize: theme.text.caption.fontSize,
              color: theme.colors.textMuted,
            }}
          >
            {occurrence.locationLabel}
          </Text>
        ) : null}

        {conflict ? (
          <Text
            style={{
              fontSize: theme.text.caption.fontSize,
              // tom [700] sobre fundo claro mantém contraste ≥ 4,5:1
              color: theme.colors.warning,
              fontWeight: "600",
            }}
          >
            {conflict}
          </Text>
        ) : null}
      </View>
    </TouchableOpacity>
  );
}

export function PersonalCalendarDaySection({
  group,
  timeZone,
  isToday,
  onSelectOccurrence,
}: {
  group: PersonalCalendarDayGroup;
  timeZone: string;
  isToday: boolean;
  onSelectOccurrence: (occurrence: PersonalCalendarOccurrenceLike) => void;
}) {
  return (
    <View style={{ gap: theme.space[2] }}>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: theme.space[2],
          paddingHorizontal: theme.space[1],
        }}
      >
        <Text
          style={{
            fontSize: theme.text.caption.fontSize,
            fontWeight: "700",
            letterSpacing: 0.4,
            color: isToday ? theme.colors.primary : theme.colors.textSecondary,
            textTransform: "capitalize",
          }}
        >
          {formatDayHeading(group.dayKey)}
        </Text>
        {isToday ? (
          <View
            style={{
              paddingHorizontal: theme.space[2],
              paddingVertical: 1,
              borderRadius: theme.radius.full,
              backgroundColor: theme.colors.primarySoft,
            }}
          >
            <Text
              style={{
                fontSize: 10,
                fontWeight: "700",
                color: theme.colors.primary,
              }}
            >
              HOJE
            </Text>
          </View>
        ) : null}
        {group.holidayName ? (
          <Text
            numberOfLines={1}
            style={{
              flex: 1,
              fontSize: theme.text.caption.fontSize,
              color: theme.colors.danger,
              fontWeight: "600",
            }}
          >
            {group.holidayName}
          </Text>
        ) : null}
      </View>

      {group.occurrences.length === 0 ? (
        <Text
          style={{
            fontSize: theme.text.caption.fontSize,
            color: theme.colors.textDisabled,
            paddingHorizontal: theme.space[4],
            paddingVertical: theme.space[2],
          }}
        >
          Sem compromissos
        </Text>
      ) : (
        group.occurrences.map((occurrence) => (
          <OccurrenceRow
            key={`${occurrence.itemId}:${occurrence.occurrenceKey}`}
            occurrence={occurrence}
            timeZone={timeZone}
            onPress={onSelectOccurrence}
          />
        ))
      )}
    </View>
  );
}

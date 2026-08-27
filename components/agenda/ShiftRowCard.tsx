// components/agenda/ShiftRowCard.tsx — o cartão de UM plantão na lista
// dia-a-dia e no detalhe do dia (proposta "Escala+ Personalidade", 23/08).
//
// Barra de 4 px à esquerda + fundo tinted pelo traje (lib/shift-visual.ts),
// nome do(s) profissional(is), chip de estado com TEXTO + ícone e a linha
// de horário em numeral tabular. Alvo de 58 pt: a lista é operada com uma
// mão, no corredor.

import { Pressable, Text, View } from "react-native";
import { theme } from "@/lib/theme";
import { formatHospitalTimeRange } from "@/lib/hospital-time";
import { shiftVisualFor } from "@/lib/shift-visual";
import type { ShiftStatusContext } from "@/lib/shift-status";
import { numeral } from "./CalendarSheet";

export interface ShiftRowShift {
  id: number;
  label: string;
  startAt: Date | string;
  endAt: Date | string;
  status: string;
  professionalNames: string[];
  isMine: boolean;
}

export function formatTimeRange(startAt: Date | string, endAt: Date | string): string {
  return formatHospitalTimeRange(startAt, endAt);
}

export function ShiftRowCard({
  shift,
  context = "actionable",
  onPress,
}: {
  shift: ShiftRowShift;
  /** "actionable" = dá para agir aqui (VAGO vermelho); "listing" = neutro. */
  context?: ShiftStatusContext;
  onPress?: () => void;
}) {
  const v = shiftVisualFor(shift.status, { isMine: shift.isMine, context });
  const Icon = v.Icon;
  const names =
    shift.isMine && shift.professionalNames.length <= 1
      ? "Você"
      : shift.professionalNames.length > 0
        ? shift.professionalNames.join(", ")
        : shift.status.toUpperCase() === "VAGO"
          ? "Sem profissional"
          : "— sem plantonista —";
  const meta = `${formatTimeRange(shift.startAt, shift.endAt)} · ${shift.label}${shift.isMine ? " · você" : ""}`;

  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      accessibilityRole={onPress ? "button" : undefined}
      accessibilityLabel={`${shift.label}, ${formatTimeRange(shift.startAt, shift.endAt)}, ${v.label}${shift.isMine ? ", seu plantão" : ""}`}
      style={({ pressed }) => ({
        minHeight: 58,
        backgroundColor: v.bg,
        borderWidth: 1,
        borderColor: v.border,
        borderLeftWidth: 4,
        borderLeftColor: v.bar,
        borderRadius: theme.radius.md + 2,
        paddingVertical: theme.space[3] - 1,
        paddingHorizontal: theme.space[3],
        gap: theme.space[1],
        opacity: pressed ? 0.9 : 1,
      })}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: theme.space[2] + 1 }}>
        <Text
          numberOfLines={1}
          style={{ flex: 1, minWidth: 0, ...theme.text.titleSm, fontSize: 15, fontWeight: v.nameWeight, color: v.nameFg }}
        >
          {names}
        </Text>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: theme.space[1],
            paddingHorizontal: theme.space[2],
            paddingVertical: theme.space[1],
            borderRadius: theme.radius.sm + 1,
            backgroundColor: v.badgeBg,
            borderWidth: 1,
            borderColor: v.badgeBorder,
          }}
        >
          <Icon size={12} color={v.badgeFg} />
          <Text style={{ ...theme.text.eyebrow, fontSize: 10, letterSpacing: 0.9, fontWeight: theme.weight.bold, textTransform: "uppercase", color: v.badgeFg }}>
            {v.label}
          </Text>
        </View>
      </View>
      <Text style={{ ...theme.text.caption, fontSize: 13, lineHeight: 18, ...numeral, color: shift.isMine ? v.timeFg : theme.colors.textSecondary }}>
        {meta}
      </Text>
    </Pressable>
  );
}

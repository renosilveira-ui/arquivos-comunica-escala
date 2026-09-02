// components/agenda/CalendarSheet.tsx — a folha de calendário da marca.
//
// O ícone do app É um calendário de parede: moldura navy de cantos
// arredondados, dois furos de pendurar, malha de planta baixa por dentro.
// Estas peças trazem esse vocabulário para a Agenda (proposta "Escala+
// Personalidade", 23/08), em vez de 42 cartõezinhos genéricos:
//
//   CalendarFrame   moldura navy 2 px + os dois furos acima
//   CalendarLegend  faixa navy com a legenda dos traços (dentro da moldura,
//                   onde nenhuma barra de abas a cobre)
//   DayNumeral      o numeral do dia dentro do círculo — hoje é CIRCULADO,
//                   não pintado; o mesmo componente vale para o cabeçalho
//                   da grade grande, a folha de mês e a lista dia-a-dia
//   numeral         estilo de texto tabular (hora, contagem, dia)

import type { ReactNode } from "react";
import { Text, View, type StyleProp, type TextStyle, type ViewStyle } from "react-native";
import { theme } from "@/lib/theme";

/** Numeral tabular: hora, duração, contagem, dia do mês. */
export const numeral: TextStyle = {
  fontFamily: theme.fontFamily.mono,
  fontVariant: ["tabular-nums"],
};

export const FRAME_RADIUS = theme.radius.xl;

/** Dois furos de pendurar, centrados, encostando no topo da moldura. */
export function HangingHoles({ size = "md" }: { size?: "sm" | "md" }) {
  const w = size === "sm" ? 8 : 9;
  const h = size === "sm" ? 17 : 20;
  return (
    <View
      pointerEvents="none"
      style={{ flexDirection: "row", justifyContent: "center", gap: size === "sm" ? 9 : 10, marginBottom: -(h / 2) + 1, zIndex: 1 }}
    >
      <View style={{ width: w, height: h, borderRadius: w / 2, backgroundColor: theme.colors.brand }} />
      <View style={{ width: w, height: h, borderRadius: w / 2, backgroundColor: theme.colors.brand }} />
    </View>
  );
}

export function CalendarFrame({
  children,
  holes = true,
  style,
}: {
  children: ReactNode;
  /** Os dois furos acima da moldura. */
  holes?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View style={style}>
      {holes ? <HangingHoles /> : null}
      <View
        style={{
          backgroundColor: theme.colors.surface,
          borderWidth: 2,
          borderColor: theme.colors.brand,
          borderRadius: FRAME_RADIUS,
          overflow: "hidden",
        }}
      >
        {children}
      </View>
    </View>
  );
}

export interface LegendItem {
  label: string;
  color: string;
  /** Contraste externo quando a própria cor coincide com a faixa navy. */
  backdropColor?: string;
}

/** Faixa navy com a legenda — vive DENTRO da moldura, no topo. */
export function CalendarLegend({ items, trailing }: { items: LegendItem[]; trailing?: ReactNode }) {
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        flexWrap: "wrap",
        gap: theme.space[2],
        paddingHorizontal: theme.space[3],
        paddingVertical: theme.space[2],
        backgroundColor: theme.colors.brand,
      }}
    >
      {items.map((item) => (
        <View key={item.label} style={{ flexDirection: "row", alignItems: "center", gap: theme.space[1] }}>
          <View
            style={{
              width: item.backdropColor ? 13 : 9,
              height: item.backdropColor ? 8 : 4,
              padding: item.backdropColor ? 2 : 0,
              borderRadius: 4,
              backgroundColor: item.backdropColor ?? item.color,
            }}
          >
            {item.backdropColor ? (
              <View
                style={{
                  flex: 1,
                  borderRadius: 2,
                  backgroundColor: item.color,
                }}
              />
            ) : null}
          </View>
          <Text style={{ ...theme.text.eyebrow, letterSpacing: 0.5, fontWeight: theme.weight.semibold, color: theme.colors.onDark.textSoft }}>
            {item.label}
          </Text>
        </View>
      ))}
      {trailing ? <View style={{ marginLeft: "auto" }}>{trailing}</View> : null}
    </View>
  );
}

export type DayNumeralEmphasis =
  /** Hoje sobre navy (cabeçalho da grade, régua de hoje): anel branco. */
  | "todayOnDark"
  /** Hoje sobre papel/branco: anel navy de 2 px. */
  | "today"
  /** Dia comum sobre branco: anel cinza de 1 px. */
  | "default"
  /** Dia com plantão meu na folha de mês: numeral navy em negrito. */
  | "mine"
  /** Dia comum na folha de mês: sem anel, texto primário, peso médio. */
  | "plain"
  /** Dia fora do mês: apagado, sem anel. */
  | "muted"
  /** Dia comum sobre navy (cabeçalho da grade): sem anel, branco. */
  | "onDark";

export function DayNumeral({
  day,
  emphasis = "default",
  size = 30,
  style,
}: {
  day: number | string;
  emphasis?: DayNumeralEmphasis;
  size?: number;
  style?: StyleProp<ViewStyle>;
}) {
  const fontSize = size >= 30 ? 15 : size >= 26 ? 14 : 13.5;
  let borderWidth = 1;
  let borderColor: string = theme.colors.borderStrong;
  let backgroundColor: string = theme.colors.surface;
  let color: string = theme.colors.brand;
  let fontWeight: TextStyle["fontWeight"] = theme.weight.bold;

  switch (emphasis) {
    case "todayOnDark":
      borderWidth = 2;
      borderColor = theme.colors.onDark.ring;
      backgroundColor = "transparent";
      color = theme.colors.onDark.text;
      break;
    case "onDark":
      borderWidth = 2;
      borderColor = "transparent";
      backgroundColor = "transparent";
      color = theme.colors.onDark.text;
      break;
    case "today":
      borderWidth = 2;
      borderColor = theme.colors.brand;
      backgroundColor = "transparent";
      color = theme.colors.brand;
      break;
    case "mine":
      borderWidth = 1;
      borderColor = "transparent";
      backgroundColor = "transparent";
      color = theme.colors.brand;
      break;
    case "plain":
      borderWidth = 1;
      borderColor = "transparent";
      backgroundColor = "transparent";
      color = theme.colors.textPrimary;
      fontWeight = theme.weight.medium;
      break;
    case "muted":
      borderWidth = 1;
      borderColor = "transparent";
      backgroundColor = "transparent";
      color = theme.colors.textDisabled;
      fontWeight = theme.weight.regular;
      break;
    default:
      break;
  }

  return (
    <View
      style={[
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          borderWidth,
          borderColor,
          backgroundColor,
          alignItems: "center",
          justifyContent: "center",
        },
        style,
      ]}
    >
      <Text style={{ ...numeral, fontSize, lineHeight: fontSize + 2, fontWeight, color, letterSpacing: -0.3 }}>{day}</Text>
    </View>
  );
}

/** Régua de um dia na lista: hoje = navy sólido; outros = papel com borda. */
export function DayRule({
  day,
  title,
  isToday,
  trailing,
}: {
  day: number | string;
  title: string;
  isToday: boolean;
  trailing?: ReactNode;
}) {
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: theme.space[2] + 2,
        paddingVertical: theme.space[2] - 1,
        paddingHorizontal: theme.space[3] - 1,
        borderRadius: theme.radius.md + 2,
        backgroundColor: isToday ? theme.colors.brand : theme.colors.surfaceAlt,
        borderWidth: 1,
        borderColor: isToday ? theme.colors.brand : theme.colors.borderStrong,
      }}
    >
      <DayNumeral day={day} emphasis={isToday ? "todayOnDark" : "default"} size={30} />
      <Text
        numberOfLines={1}
        style={{
          flex: 1,
          ...theme.text.body,
          fontSize: 14.5,
          fontWeight: theme.weight.bold,
          color: isToday ? theme.colors.onDark.text : theme.colors.textPrimary,
        }}
      >
        {title}
      </Text>
      {isToday ? (
        <Text style={{ ...theme.text.eyebrow, fontSize: 10, fontWeight: theme.weight.bold, textTransform: "uppercase", color: theme.colors.onDark.textSoft }}>
          Hoje
        </Text>
      ) : (
        trailing ?? null
      )}
    </View>
  );
}

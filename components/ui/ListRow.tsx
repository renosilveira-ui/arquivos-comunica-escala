// components/ui/ListRow.tsx — a linha de lista tocável.
//
// Por que existe: o padrão "ícone + título + subtítulo + terminador" aparece
// 12 vezes só no Perfil, e mais em Solicitações, Vagas e Admin. Cada tela
// remontava a mão (TouchableOpacity + View + dois Text + "Abrir" em bold),
// com padding e cor de chevron diferentes. Mesma API de Surface/SectionHeader:
// tone controla a cor, o resto é conteúdo.
//
// Nasce de Surface: a linha NÃO desenha superfície própria — ela vive dentro
// de <Surface padded={false}> e desenha só o divisor de topo.

import type { ReactNode } from "react";
import { Pressable, Switch, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { ChevronRight, type LucideIcon } from "lucide-react-native";
import { theme } from "@/lib/theme";

export type ListRowTone = "default" | "brand" | "warning" | "success" | "danger";

export interface ListRowProps {
  title: string;
  subtitle?: string;
  Icon?: LucideIcon;
  tone?: ListRowTone;
  /** Texto curto à direita (contagem, "Alterar", "2 abertas"). */
  value?: string;
  /**
   * Cor do `value`. "muted" (padrão) para informação; "action" (primary) quando
   * o valor É a ação ("Alterar"); "count" desenha pílula âmbar preenchida —
   * fila que exige ação (só renderizar quando > 0: um "0" é ruído).
   */
  valueTone?: "muted" | "action" | "count";
  /** Switch à direita. Quando definido, a linha não mostra chevron. */
  toggle?: { value: boolean; onValueChange: (v: boolean) => void; accessibilityLabel?: string };
  /** Substitui o terminador padrão (badge, botão). */
  trailing?: ReactNode;
  /** Divisor no topo. Falso na primeira linha do grupo. */
  divided?: boolean;
  onPress?: () => void;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
}

function toneColors(tone: ListRowTone): { icon: string; iconBg: string; title: string } {
  switch (tone) {
    case "brand":
      return { icon: theme.colors.brand, iconBg: theme.colors.brandSoft, title: theme.colors.textPrimary };
    case "warning":
      return { icon: theme.palette.warning[700], iconBg: theme.colors.warningSoft, title: theme.colors.textPrimary };
    case "success":
      return { icon: theme.palette.success[700], iconBg: theme.colors.successSoft, title: theme.colors.textPrimary };
    case "danger":
      return { icon: theme.palette.danger[600], iconBg: theme.colors.dangerSoft, title: theme.palette.danger[900] };
    default:
      return { icon: theme.colors.textSecondary, iconBg: theme.colors.surfaceAlt, title: theme.colors.textPrimary };
  }
}

export function ListRow({
  title,
  subtitle,
  Icon,
  tone = "default",
  value,
  valueTone = "muted",
  toggle,
  trailing,
  divided = true,
  onPress,
  accessibilityLabel,
  style,
}: ListRowProps) {
  const c = toneColors(tone);

  const body = (
    <>
      {Icon ? (
        <View
          style={{
            width: 32,
            height: 32,
            borderRadius: theme.radius.md,
            backgroundColor: c.iconBg,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Icon size={16} color={c.icon} />
        </View>
      ) : null}

      <View style={{ flex: 1, gap: 1 }}>
        <Text style={{ ...theme.text.titleSm, fontWeight: theme.weight.semibold, color: c.title }}>{title}</Text>
        {subtitle ? (
          <Text style={{ ...theme.text.caption, color: theme.colors.textSecondary }}>{subtitle}</Text>
        ) : null}
      </View>

      {trailing ?? null}

      {!trailing && toggle ? (
        <Switch
          value={toggle.value}
          onValueChange={toggle.onValueChange}
          accessibilityLabel={toggle.accessibilityLabel ?? title}
          trackColor={{ false: theme.colors.borderStrong, true: theme.colors.brand }}
          thumbColor={theme.colors.surface}
        />
      ) : null}

      {!trailing && !toggle && value ? (
        valueTone === "count" ? (
          <View
            style={{
              minWidth: 24,
              paddingHorizontal: theme.space[2],
              paddingVertical: 2,
              borderRadius: theme.radius.full,
              backgroundColor: theme.palette.warning[700],
              alignItems: "center",
            }}
          >
            <Text
              style={{
                ...theme.text.caption,
                fontFamily: theme.fontFamily.mono,
                fontWeight: theme.weight.bold,
                color: theme.colors.surface,
              }}
            >
              {value}
            </Text>
          </View>
        ) : (
          <Text
            style={{
              ...theme.text.caption,
              fontWeight: theme.weight.semibold,
              color: valueTone === "action" ? theme.colors.primary : theme.colors.textSecondary,
            }}
          >
            {value}
          </Text>
        )
      ) : null}

      {!trailing && !toggle && onPress ? <ChevronRight size={16} color={theme.colors.textDisabled} /> : null}
    </>
  );

  const base: ViewStyle = {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.space[3],
    // 56 > 44pt: a lista é operada com uma mão, no corredor.
    minHeight: 56,
    paddingHorizontal: theme.space[3],
    paddingVertical: theme.space[3],
    borderTopWidth: divided ? 1 : 0,
    borderTopColor: theme.colors.border,
  };

  if (!onPress) return <View style={[base, style]}>{body}</View>;

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? title}
      style={({ pressed }) => [base, { backgroundColor: pressed ? theme.colors.surfaceAlt : "transparent" }, style]}
    >
      {body}
    </Pressable>
  );
}

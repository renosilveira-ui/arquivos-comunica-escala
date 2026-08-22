// components/ui/SectionHeader.tsx — cabeçalho de seção padronizado.
//
// Eyebrow (opcional) + título + subtítulo + ação à direita. Toda seção de
// tela usa isto: ritmo vertical e hierarquia iguais em todas as telas.

import type { ReactNode } from "react";
import { Text, View, type StyleProp, type ViewStyle } from "react-native";
import { theme } from "@/lib/theme";

export interface SectionHeaderProps {
  title: string;
  eyebrow?: string;
  subtitle?: string;
  /** Elemento à direita (botão, badge, contagem). */
  action?: ReactNode;
  /** Tamanho do título: "page" (titleLg) ou "section" (title). */
  size?: "page" | "section";
  style?: StyleProp<ViewStyle>;
}

export function SectionHeader({ title, eyebrow, subtitle, action, size = "section", style }: SectionHeaderProps) {
  return (
    <View
      style={[
        {
          flexDirection: "row",
          alignItems: subtitle ? "flex-start" : "center",
          justifyContent: "space-between",
          gap: theme.space[3],
        },
        style,
      ]}
    >
      <View style={{ flex: 1, gap: theme.space[1] }}>
        {eyebrow ? (
          <Text
            style={{
              ...theme.text.eyebrow,
              fontWeight: theme.weight.bold,
              textTransform: "uppercase",
              color: theme.colors.textMuted,
            }}
          >
            {eyebrow}
          </Text>
        ) : null}
        <Text
          style={{
            ...(size === "page" ? theme.text.titleLg : theme.text.title),
            fontWeight: theme.weight.bold,
            color: theme.colors.textPrimary,
          }}
        >
          {title}
        </Text>
        {subtitle ? (
          <Text style={{ ...theme.text.body, color: theme.colors.textSecondary }}>{subtitle}</Text>
        ) : null}
      </View>
      {action ? <View style={{ flexShrink: 0 }}>{action}</View> : null}
    </View>
  );
}

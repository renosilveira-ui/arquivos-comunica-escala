import { StyleSheet, Text, TextInput, View } from "react-native";
import { theme } from "@/lib/theme";
import type { MonthlyRosterStatus } from "@/hooks/use-published-month-roster";
import { requiresPublishedMonthReason } from "@/hooks/use-published-month-roster";

export function PublishedMonthReasonField({
  value,
  onChangeText,
  rosterStatus,
}: {
  value: string;
  onChangeText: (text: string) => void;
  rosterStatus: MonthlyRosterStatus | undefined;
}) {
  if (!requiresPublishedMonthReason(rosterStatus)) return null;

  const statusLabel = rosterStatus === "PUBLISHED" ? "publicada" : "bloqueada";

  return (
    <View style={styles.stack}>
      <Text style={styles.label}>Motivo da edição *</Text>
      <Text style={styles.helper}>
        A escala deste mês está {statusLabel}. O motivo fica registrado na
        auditoria.
      </Text>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder="Ex.: cobertura extra aprovada"
        placeholderTextColor={theme.colors.textMuted}
        multiline
        numberOfLines={3}
        textAlignVertical="top"
        style={[styles.input, styles.notesInput]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  stack: {
    gap: theme.space[2],
  },
  label: {
    ...theme.text.caption,
    color: theme.colors.textMuted,
    fontWeight: theme.weight.semibold,
  },
  helper: {
    ...theme.text.body,
    color: theme.colors.textMuted,
  },
  input: {
    minHeight: theme.space[14],
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.surfaceAlt,
    borderWidth: 1,
    borderColor: theme.colors.border,
    paddingHorizontal: theme.space[4],
    paddingVertical: theme.space[3],
    ...theme.text.bodyLg,
    color: theme.colors.textPrimary,
  },
  notesInput: {
    minHeight: theme.space[20],
  },
});

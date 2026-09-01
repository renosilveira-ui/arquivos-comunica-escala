import { useMemo, useState } from "react";
import { FlatList, Modal, Text, TouchableOpacity, View } from "react-native";
import { Check, ChevronDown, X } from "lucide-react-native";
import { theme } from "@/lib/theme";
import {
  availableScheduleContextOptions,
  scheduleContextClinicalReference,
  type ScheduleContextAccessOption,
} from "./ScheduleContextAccessPicker.logic";

export {
  availableScheduleContextOptions,
  isScheduleContextAvailableForAcl,
  scheduleContextClinicalReference,
  type ScheduleContextAccessOption,
} from "./ScheduleContextAccessPicker.logic";

export function ScheduleContextAccessPicker({
  contexts,
  selectedIds,
  onChange,
  required = false,
  tone = "light",
}: {
  contexts: ScheduleContextAccessOption[];
  selectedIds: number[];
  onChange: (ids: number[]) => void;
  required?: boolean;
  tone?: "light" | "dark";
}) {
  const [visible, setVisible] = useState(false);
  const options = useMemo(
    () => availableScheduleContextOptions(contexts),
    [contexts],
  );
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const disabled = options.length === 0;
  const fieldBackground =
    tone === "dark" ? theme.palette.neutral[900] : theme.colors.surface;
  const fieldText =
    tone === "dark" ? theme.palette.neutral[50] : theme.colors.textPrimary;
  const fieldBorder =
    tone === "dark" ? theme.palette.neutral[400] : theme.colors.border;

  const toggle = (id: number) => {
    onChange(
      selectedSet.has(id)
        ? selectedIds.filter((candidate) => candidate !== id)
        : [...selectedIds, id],
    );
  };

  return (
    <>
      <Text
        style={{
          color:
            tone === "dark"
              ? theme.colors.textDisabled
              : theme.colors.textSecondary,
          fontSize: tone === "dark" ? 11 : 14,
          fontWeight: "600",
          letterSpacing: tone === "dark" ? 1.5 : 0,
          textTransform: tone === "dark" ? "uppercase" : "none",
          marginBottom: 6,
        }}
      >
        Escalas e setores{required ? " *" : ""}
      </Text>
      <TouchableOpacity
        accessibilityRole="button"
        accessibilityLabel={`Escalas e setores: ${selectedIds.length} selecionados`}
        disabled={disabled}
        onPress={() => setVisible(true)}
        style={{
          minHeight: 50,
          paddingHorizontal: 14,
          paddingVertical: 12,
          borderRadius: theme.borderRadius.input,
          borderWidth: 1.5,
          borderColor:
            selectedIds.length > 0 ? theme.colors.primary : fieldBorder,
          backgroundColor: fieldBackground,
          opacity: disabled ? 0.6 : 1,
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
        }}
      >
        <Text
          style={{
            flex: 1,
            color: selectedIds.length ? fieldText : theme.colors.textMuted,
          }}
        >
          {selectedIds.length > 0
            ? `${selectedIds.length} escala(s) selecionada(s)`
            : options.length > 0
              ? "Selecionar escalas"
              : "Nenhuma escala ativa disponível"}
        </Text>
        <ChevronDown size={18} color={theme.colors.textMuted} />
      </TouchableOpacity>

      <Modal
        visible={visible}
        transparent
        animationType="fade"
        onRequestClose={() => setVisible(false)}
      >
        <View
          style={{
            flex: 1,
            justifyContent: "center",
            alignItems: "center",
            padding: 16,
            backgroundColor: theme.colors.overlay,
          }}
        >
          <View
            style={{
              width: "100%",
              maxWidth: 560,
              maxHeight: "82%",
              backgroundColor: theme.colors.surface,
              borderRadius: 18,
              overflow: "hidden",
            }}
          >
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "space-between",
                padding: 18,
              }}
            >
              <View style={{ flex: 1, paddingRight: 12 }}>
                <Text
                  style={{
                    color: theme.colors.textPrimary,
                    fontSize: 20,
                    fontWeight: "700",
                  }}
                >
                  Onde poderá atuar
                </Text>
                <Text
                  style={{
                    color: theme.colors.textSecondary,
                    fontSize: 13,
                    marginTop: 4,
                  }}
                >
                  Escolha explicitamente por hospital e setor. A referência
                  clínica abaixo é somente informativa e não altera o acesso.
                </Text>
              </View>
              <TouchableOpacity onPress={() => setVisible(false)} hitSlop={12}>
                <X size={22} color={theme.colors.textSecondary} />
              </TouchableOpacity>
            </View>

            <FlatList
              data={options}
              keyExtractor={(item) => String(item.id)}
              contentContainerStyle={{
                paddingHorizontal: 18,
                paddingBottom: 18,
                gap: 8,
              }}
              ListEmptyComponent={
                <Text
                  style={{
                    color: theme.colors.textSecondary,
                    paddingVertical: 18,
                  }}
                >
                  Nenhuma escala ativa está disponível nesta instituição.
                </Text>
              }
              renderItem={({ item }) => {
                const selected = selectedSet.has(item.id);
                return (
                  <TouchableOpacity
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: selected }}
                    onPress={() => toggle(item.id)}
                    style={{
                      flexDirection: "row",
                      alignItems: "center",
                      gap: 12,
                      padding: 14,
                      borderRadius: 12,
                      borderWidth: 1,
                      borderColor: selected
                        ? theme.colors.primary
                        : theme.colors.border,
                      backgroundColor: selected
                        ? theme.colors.primarySoft
                        : theme.colors.surface,
                    }}
                  >
                    <View
                      style={{
                        width: 22,
                        height: 22,
                        borderRadius: 6,
                        alignItems: "center",
                        justifyContent: "center",
                        borderWidth: 1.5,
                        borderColor: selected
                          ? theme.colors.primary
                          : theme.colors.border,
                        backgroundColor: selected
                          ? theme.colors.primary
                          : "transparent",
                      }}
                    >
                      {selected ? (
                        <Check size={15} color={theme.colors.onDark.text} />
                      ) : null}
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text
                        style={{
                          color: theme.colors.textPrimary,
                          fontSize: 15,
                          fontWeight: "700",
                        }}
                      >
                        {item.sectorName}
                      </Text>
                      <Text
                        style={{
                          color: theme.colors.textSecondary,
                          fontSize: 13,
                          marginTop: 2,
                        }}
                      >
                        {item.hospitalName} · Referência clínica:{" "}
                        {scheduleContextClinicalReference(item)}
                      </Text>
                    </View>
                  </TouchableOpacity>
                );
              }}
            />

            <TouchableOpacity
              onPress={() => setVisible(false)}
              style={{
                margin: 18,
                marginTop: 0,
                padding: 13,
                alignItems: "center",
                borderRadius: theme.borderRadius.button,
                backgroundColor: theme.colors.primary,
              }}
            >
              <Text
                style={{ color: theme.colors.onDark.text, fontWeight: "700" }}
              >
                Concluir ({selectedIds.length})
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </>
  );
}

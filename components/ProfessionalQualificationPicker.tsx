import { useMemo, useState } from "react";
import {
  FlatList,
  Modal,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { Check, ChevronDown, Search, X } from "lucide-react-native";
import {
  MEDICAL_SPECIALTIES,
  OPERATIONAL_PROFILES,
  getMedicalSpecialtyByCode,
  getOperationalProfileByCode,
  type MedicalSpecialtyCode,
  type OperationalProfileCode,
} from "@/lib/medical-specialties";
import { theme } from "@/lib/theme";

export type ProfessionalQualificationSelection =
  | { kind: "MEDICAL_SPECIALTY"; code: MedicalSpecialtyCode }
  | { kind: "OPERATIONAL_PROFILE"; code: OperationalProfileCode };

type QualificationOption = ProfessionalQualificationSelection & {
  name: string;
  group: "Especialidade reconhecida pelo CFM" | "Perfil profissional";
};

const OPTIONS: QualificationOption[] = [
  ...OPERATIONAL_PROFILES.map((profile) => ({
    kind: "OPERATIONAL_PROFILE" as const,
    code: profile.code,
    name: profile.name,
    group: "Perfil profissional" as const,
  })),
  ...MEDICAL_SPECIALTIES.map((specialty) => ({
    kind: "MEDICAL_SPECIALTY" as const,
    code: specialty.code,
    name: specialty.name,
    group: "Especialidade reconhecida pelo CFM" as const,
  })),
];

function normalizeSearch(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();
}

export function getQualificationLabel(
  value: ProfessionalQualificationSelection | null,
): string | null {
  if (!value) return null;
  return value.kind === "MEDICAL_SPECIALTY"
    ? (getMedicalSpecialtyByCode(value.code)?.name ?? null)
    : (getOperationalProfileByCode(value.code)?.name ?? null);
}

export function qualificationPayload(
  value: ProfessionalQualificationSelection | null,
): {
  medicalSpecialtyCode: MedicalSpecialtyCode | null;
  operationalProfileCode: OperationalProfileCode | null;
} {
  return {
    medicalSpecialtyCode:
      value?.kind === "MEDICAL_SPECIALTY" ? value.code : null,
    operationalProfileCode:
      value?.kind === "OPERATIONAL_PROFILE" ? value.code : null,
  };
}

export function ProfessionalQualificationPicker({
  value,
  onChange,
  label = "Qualificação médica",
  required = false,
  disabled = false,
  tone = "light",
}: {
  value: ProfessionalQualificationSelection | null;
  onChange: (value: ProfessionalQualificationSelection) => void;
  label?: string;
  required?: boolean;
  disabled?: boolean;
  tone?: "light" | "dark";
}) {
  const [visible, setVisible] = useState(false);
  const [search, setSearch] = useState("");
  const selectedLabel = getQualificationLabel(value);
  const query = normalizeSearch(search);
  const filtered = useMemo(
    () =>
      query
        ? OPTIONS.filter((option) =>
            normalizeSearch(`${option.name} ${option.code}`).includes(query),
          )
        : OPTIONS,
    [query],
  );
  const fieldBackground =
    tone === "dark" ? theme.palette.neutral[900] : theme.colors.surface;
  const fieldText =
    tone === "dark" ? theme.palette.neutral[50] : theme.colors.textPrimary;
  const fieldBorder =
    tone === "dark" ? theme.palette.neutral[400] : theme.colors.border;

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
        {label}
        {required ? " *" : ""}
      </Text>
      <TouchableOpacity
        accessibilityRole="button"
        accessibilityLabel={`${label}: ${selectedLabel ?? "não selecionada"}`}
        activeOpacity={0.8}
        disabled={disabled}
        onPress={() => {
          setSearch("");
          setVisible(true);
        }}
        style={{
          minHeight: 50,
          paddingHorizontal: 14,
          paddingVertical: 12,
          borderRadius: theme.borderRadius.input,
          borderWidth: 1.5,
          borderColor: selectedLabel ? theme.colors.primary : fieldBorder,
          backgroundColor: fieldBackground,
          opacity: disabled ? 0.6 : 1,
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
        }}
      >
        <Text
          numberOfLines={2}
          style={{
            flex: 1,
            color: selectedLabel ? fieldText : theme.colors.textMuted,
            fontSize: 15,
            fontWeight: selectedLabel ? "600" : "400",
          }}
        >
          {selectedLabel ?? "Selecionar no catálogo"}
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
              height: "82%",
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
                paddingHorizontal: 18,
                paddingTop: 18,
                paddingBottom: 12,
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
                  Qualificação médica
                </Text>
                <Text
                  style={{
                    color: theme.colors.textSecondary,
                    fontSize: 12,
                    marginTop: 4,
                  }}
                >
                  Especialidades seguem o catálogo CFM. Médico generalista é um
                  perfil profissional separado.
                </Text>
              </View>
              <TouchableOpacity onPress={() => setVisible(false)} hitSlop={12}>
                <X size={22} color={theme.colors.textSecondary} />
              </TouchableOpacity>
            </View>

            <View
              style={{
                marginHorizontal: 18,
                marginBottom: 10,
                flexDirection: "row",
                alignItems: "center",
                borderWidth: 1,
                borderColor: theme.colors.border,
                borderRadius: theme.borderRadius.input,
                paddingHorizontal: 12,
                backgroundColor: theme.palette.neutral[50],
              }}
            >
              <Search size={18} color={theme.colors.textMuted} />
              <TextInput
                value={search}
                onChangeText={setSearch}
                autoCapitalize="none"
                autoCorrect={false}
                placeholder="Buscar especialidade"
                placeholderTextColor={theme.colors.textMuted}
                style={{
                  flex: 1,
                  paddingHorizontal: 10,
                  paddingVertical: 12,
                  color: theme.colors.textPrimary,
                  fontSize: 15,
                }}
              />
            </View>

            <FlatList
              data={filtered}
              keyExtractor={(item) => `${item.kind}:${item.code}`}
              keyboardShouldPersistTaps="handled"
              contentContainerStyle={{
                paddingHorizontal: 18,
                paddingBottom: 18,
              }}
              ListEmptyComponent={
                <Text
                  style={{
                    color: theme.colors.textMuted,
                    textAlign: "center",
                    paddingVertical: 28,
                  }}
                >
                  Nenhuma qualificação encontrada.
                </Text>
              }
              renderItem={({ item, index }) => {
                const previous = filtered[index - 1];
                const showGroup = !previous || previous.group !== item.group;
                const selected =
                  value?.kind === item.kind && value.code === item.code;
                return (
                  <View>
                    {showGroup ? (
                      <Text
                        style={{
                          color: theme.colors.textMuted,
                          fontSize: 11,
                          fontWeight: "700",
                          letterSpacing: 1,
                          textTransform: "uppercase",
                          paddingTop: index === 0 ? 8 : 18,
                          paddingBottom: 6,
                        }}
                      >
                        {item.group}
                      </Text>
                    ) : null}
                    <TouchableOpacity
                      activeOpacity={0.8}
                      onPress={() => {
                        onChange({
                          kind: item.kind,
                          code: item.code,
                        } as ProfessionalQualificationSelection);
                        setVisible(false);
                      }}
                      style={{
                        minHeight: 48,
                        flexDirection: "row",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: 12,
                        paddingHorizontal: 12,
                        paddingVertical: 10,
                        marginBottom: 4,
                        borderRadius: 10,
                        backgroundColor: selected
                          ? theme.colors.primarySoft
                          : theme.colors.surface,
                      }}
                    >
                      <Text
                        style={{
                          flex: 1,
                          color: selected
                            ? theme.colors.primary
                            : theme.colors.textPrimary,
                          fontSize: 15,
                          fontWeight: selected ? "700" : "500",
                        }}
                      >
                        {item.name}
                      </Text>
                      {selected ? (
                        <Check size={18} color={theme.colors.primary} />
                      ) : null}
                    </TouchableOpacity>
                  </View>
                );
              }}
            />
          </View>
        </View>
      </Modal>
    </>
  );
}

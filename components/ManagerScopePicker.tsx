import { useMemo } from "react";
import { Text, TouchableOpacity, View } from "react-native";
import { Check } from "lucide-react-native";
import { theme } from "@/lib/theme";
import {
  managerScopeHospitalWideLabel,
  managerScopePickerHint,
  managerScopePickerTitle,
  managerScopeSectorLabel,
  scopeKey,
  type ManagerScopeDraft,
} from "@/lib/manager-scope-admin";

export type ManagerScopeHospitalOption = { id: number; name: string };
export type ManagerScopeSectorOption = {
  id: number;
  name: string;
  hospitalId: number;
};

export function ManagerScopePicker({
  hospitals,
  sectors,
  value,
  onChange,
  required = false,
}: {
  hospitals: ManagerScopeHospitalOption[];
  sectors: ManagerScopeSectorOption[];
  value: ManagerScopeDraft[];
  onChange: (next: ManagerScopeDraft[]) => void;
  required?: boolean;
}) {
  const selected = useMemo(() => new Set(value.map(scopeKey)), [value]);
  const options = useMemo(() => {
    const rows: { key: string; label: string; draft: ManagerScopeDraft }[] = [];
    for (const hospital of hospitals) {
      rows.push({
        key: scopeKey({ hospitalId: hospital.id, sectorId: null }),
        label: managerScopeHospitalWideLabel(hospital.name),
        draft: { hospitalId: hospital.id, sectorId: null },
      });
      for (const sector of sectors.filter((item) => item.hospitalId === hospital.id)) {
        rows.push({
          key: scopeKey({ hospitalId: hospital.id, sectorId: sector.id }),
          label: managerScopeSectorLabel(hospital.name, sector.name),
          draft: { hospitalId: hospital.id, sectorId: sector.id },
        });
      }
    }
    return rows;
  }, [hospitals, sectors]);

  const toggle = (draft: ManagerScopeDraft) => {
    const key = scopeKey(draft);
    if (selected.has(key)) {
      onChange(value.filter((item) => scopeKey(item) !== key));
      return;
    }
    if (draft.sectorId == null) {
      onChange([
        ...value.filter((item) => item.hospitalId !== draft.hospitalId),
        draft,
      ]);
      return;
    }
    onChange([
      ...value.filter(
        (item) =>
          !(item.hospitalId === draft.hospitalId && item.sectorId == null),
      ),
      draft,
    ]);
  };

  return (
    <View>
      <Text
        style={{
          color: theme.colors.textSecondary,
          ...theme.text.body,
          marginBottom: theme.space[1],
        }}
      >
        {managerScopePickerTitle()}
        {required ? " *" : ""}
      </Text>
      <Text
        style={{
          color: theme.colors.textMuted,
          ...theme.text.caption,
          marginBottom: theme.space[2],
        }}
      >
        {managerScopePickerHint()}
      </Text>
      {options.length === 0 ? (
        <Text
          style={{
            color: theme.colors.textMuted,
            ...theme.text.body,
          }}
        >
          Cadastre um hospital nesta instituição antes de definir o gestor da
          escala.
        </Text>
      ) : (
        <View style={{ gap: theme.space[2] }}>
          {options.map((option) => {
            const active = selected.has(option.key);
            return (
              <TouchableOpacity
                key={option.key}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: active }}
                onPress={() => toggle(option.draft)}
                style={{
                  minHeight: 44,
                  borderRadius: theme.borderRadius.input,
                  borderWidth: 1,
                  borderColor: active
                    ? theme.colors.primary
                    : theme.colors.border,
                  backgroundColor: active
                    ? theme.colors.primarySoft
                    : theme.colors.surface,
                  paddingHorizontal: theme.space[3],
                  paddingVertical: theme.space[2],
                  flexDirection: "row",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: theme.space[2],
                }}
              >
                <Text
                  style={{
                    flex: 1,
                    color: theme.colors.textPrimary,
                    ...theme.text.body,
                    fontWeight: theme.weight.semibold,
                  }}
                >
                  {option.label}
                </Text>
                {active ? (
                  <Check size={18} color={theme.colors.primary} />
                ) : null}
              </TouchableOpacity>
            );
          })}
        </View>
      )}
    </View>
  );
}

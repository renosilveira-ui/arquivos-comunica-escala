import React, { useState, useEffect, useMemo } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  Platform,
  useWindowDimensions,
} from "react-native";
import DateTimePicker from "@react-native-community/datetimepicker";
import * as Haptics from "expo-haptics";
import { theme } from "@/lib/theme";
import { tenantFilterStorageKey } from "@/lib/tenant-filter-storage";

export type ShiftFilterValues = {
  hospitalId: number | null; // null = "Todos" (só GESTOR_PLUS)
  sectorId: number | null; // null = "Todos"
  date: Date; // default: hoje
  shiftLabel: string | null; // "MANHA" | "TARDE" | "NOITE" | null (Todos)
};

type Hospital = { id: number; name: string };
type Sector = { id: number; name: string; hospitalId: number };

export type ShiftFiltersProps = {
  hospitals: Hospital[];
  sectors: Sector[];
  allowAllHospitals: boolean; // true para GESTOR_PLUS, false para GESTOR_MEDICO
  /** Persistência web é uma preferência do tenant atual, não da conta inteira. */
  persistenceInstitutionId?: number | null;
  /** Quando presente, a tela controla a seleção e a troca de tenant é síncrona. */
  value?: ShiftFilterValues;
  initialValues?: Partial<ShiftFilterValues>;
  onChange: (filters: ShiftFilterValues) => void;
  counts?: {
    vacanciesByHospital: Record<number, number>;
    vacanciesBySector: Record<number, number>;
  };
};

export function ShiftFilters({
  hospitals,
  sectors,
  allowAllHospitals,
  persistenceInstitutionId = null,
  value,
  initialValues,
  onChange,
  counts,
}: ShiftFiltersProps) {
  const { width } = useWindowDimensions();
  const isCompact = width < 760;
  const isControlled = value !== undefined;
  const [uncontrolledValues, setUncontrolledValues] =
    useState<ShiftFilterValues>(() => ({
      hospitalId: initialValues?.hospitalId ?? null,
      sectorId: initialValues?.sectorId ?? null,
      date: initialValues?.date ?? new Date(),
      shiftLabel: initialValues?.shiftLabel ?? null,
    }));
  const currentValues = value ?? uncontrolledValues;
  const { hospitalId, sectorId, date, shiftLabel } = currentValues;
  const initialDate = initialValues?.date;

  // O modo legado continua aceitando defaults. No caminho controlado, a tela
  // fornece o valor já identificado pelo tenant e não recebe uma reemissão.
  useEffect(() => {
    if (isControlled) return;
    setUncontrolledValues((current) => {
      const next: ShiftFilterValues = {
        hospitalId:
          initialValues?.hospitalId === undefined
            ? current.hospitalId
            : initialValues.hospitalId,
        sectorId:
          initialValues?.sectorId === undefined
            ? current.sectorId
            : initialValues.sectorId,
        date: initialDate ?? current.date,
        shiftLabel:
          initialValues?.shiftLabel === undefined
            ? current.shiftLabel
            : initialValues.shiftLabel,
      };
      return next.hospitalId === current.hospitalId &&
        next.sectorId === current.sectorId &&
        next.date === current.date &&
        next.shiftLabel === current.shiftLabel
        ? current
        : next;
    });
  }, [
    initialDate,
    initialValues?.hospitalId,
    initialValues?.sectorId,
    initialValues?.shiftLabel,
    isControlled,
  ]);
  const [showDatePicker, setShowDatePicker] = useState(false);

  // Setor dependente: só mostra setores do hospital selecionado
  const availableSectors = useMemo(
    () =>
      hospitalId ? sectors.filter((s) => s.hospitalId === hospitalId) : [],
    [hospitalId, sectors],
  );

  // Auto-selecionar setor se só houver 1 no modo legado. No modo controlado,
  // os defaults já foram calculados pelo tenant e só os handlers publicam.
  useEffect(() => {
    if (isControlled || availableSectors.length !== 1 || sectorId !== null) {
      return;
    }
    setUncontrolledValues((current) =>
      current.sectorId === null
        ? { ...current, sectorId: availableSectors[0].id }
        : current,
    );
  }, [availableSectors, isControlled, sectorId]);

  // O modo não-controlado mantém o contrato antigo. O modo controlado chama
  // onChange somente por handlers explícitos, sem reemitir estado stale.
  useEffect(() => {
    if (!isControlled) onChange(uncontrolledValues);
  }, [isControlled, onChange, uncontrolledValues]);

  const emitChange = (next: ShiftFilterValues) => {
    if (isControlled) {
      onChange(next);
      return;
    }
    setUncontrolledValues(next);
  };

  const handleHospitalChange = (id: number | null) => {
    if (Platform.OS !== "web")
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    emitChange({ ...currentValues, hospitalId: id, sectorId: null });

    // Persistir em localStorage somente no namespace institucional atual.
    if (Platform.OS === "web") {
      const hospitalKey = tenantFilterStorageKey(
        persistenceInstitutionId,
        "hospital",
      );
      const sectorKey = tenantFilterStorageKey(
        persistenceInstitutionId,
        "sector",
      );
      try {
        if (hospitalKey !== null) {
          if (id !== null) {
            globalThis.localStorage?.setItem(hospitalKey, id.toString());
          } else {
            globalThis.localStorage?.removeItem(hospitalKey);
          }
        }
        if (sectorKey !== null) {
          globalThis.localStorage?.removeItem(sectorKey);
        }
      } catch {
        // Preferência visual não pode interromper a troca de filtro.
      }
    }
  };

  const handleSectorChange = (id: number | null) => {
    if (Platform.OS !== "web")
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    emitChange({ ...currentValues, sectorId: id });

    // Persistir em localStorage somente no namespace institucional atual.
    if (Platform.OS === "web") {
      const sectorKey = tenantFilterStorageKey(
        persistenceInstitutionId,
        "sector",
      );
      try {
        if (sectorKey !== null) {
          if (id !== null) {
            globalThis.localStorage?.setItem(sectorKey, id.toString());
          } else {
            globalThis.localStorage?.removeItem(sectorKey);
          }
        }
      } catch {
        // Preferência visual não pode interromper a troca de filtro.
      }
    }
  };

  const handleDateChange = (selectedDate?: Date) => {
    if (Platform.OS !== "web")
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setShowDatePicker(false);
    if (selectedDate) emitChange({ ...currentValues, date: selectedDate });
  };

  const handleShiftLabelChange = (label: string | null) => {
    if (Platform.OS !== "web")
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    emitChange({ ...currentValues, shiftLabel: label });
  };

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  const isToday = date.toDateString() === today.toDateString();
  const isTomorrow = date.toDateString() === tomorrow.toDateString();

  const renderOption = (
    label: string,
    selected: boolean,
    onPress: () => void,
  ) => (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.78}
      style={{
        minHeight: 40,
        paddingHorizontal: theme.space[3],
        paddingVertical: theme.space[2],
        borderRadius: theme.radius.md,
        borderWidth: 1,
        borderColor: selected ? theme.colors.primary : theme.colors.border,
        backgroundColor: selected ? theme.colors.primary : theme.colors.surface,
        justifyContent: "center",
      }}
    >
      <Text
        numberOfLines={1}
        style={{
          ...theme.text.body,
          color: selected ? theme.colors.surface : theme.colors.textSecondary,
          fontWeight: theme.weight.semibold,
        }}
      >
        {label}
      </Text>
    </TouchableOpacity>
  );

  const groupStyle = {
    flex: isCompact ? undefined : 1,
    minWidth: isCompact ? "100%" : 240,
  } as const;

  return (
    <View
      style={{
        borderRadius: theme.radius.lg,
        backgroundColor: theme.colors.surfaceAlt,
        padding: theme.space[4],
        gap: theme.space[4],
      }}
    >
      <View
        style={{
          flexDirection: isCompact ? "column" : "row",
          gap: theme.space[4],
        }}
      >
        <View style={groupStyle}>
          <Text style={filterLabelStyle}>Hospital</Text>
          <View style={optionWrapStyle}>
            {allowAllHospitals &&
              renderOption("Todos", hospitalId === null, () =>
                handleHospitalChange(null),
              )}
            {hospitals.map((h) => {
              const count = counts?.vacanciesByHospital[h.id] || 0;
              return (
                <React.Fragment key={h.id}>
                  {renderOption(
                    `${h.name}${count > 0 ? ` (${count})` : ""}`,
                    hospitalId === h.id,
                    () => handleHospitalChange(h.id),
                  )}
                </React.Fragment>
              );
            })}
          </View>
        </View>

        <View style={groupStyle}>
          <Text style={filterLabelStyle}>Setor</Text>
          {hospitalId === null && !allowAllHospitals ? (
            <Text
              style={{
                ...theme.text.body,
                color: theme.colors.textMuted,
                fontStyle: "italic",
              }}
            >
              Selecione hospital
            </Text>
          ) : (
            <View style={optionWrapStyle}>
              {renderOption("Todos", sectorId === null, () =>
                handleSectorChange(null),
              )}
              {availableSectors.map((s) => {
                const count = counts?.vacanciesBySector[s.id] || 0;
                return (
                  <React.Fragment key={s.id}>
                    {renderOption(
                      `${s.name}${count > 0 ? ` (${count})` : ""}`,
                      sectorId === s.id,
                      () => handleSectorChange(s.id),
                    )}
                  </React.Fragment>
                );
              })}
            </View>
          )}
        </View>
      </View>

      <View
        style={{
          flexDirection: isCompact ? "column" : "row",
          gap: theme.space[4],
        }}
      >
        <View style={groupStyle}>
          <Text style={filterLabelStyle}>Data</Text>
          <View style={optionWrapStyle}>
            {renderOption("Hoje", isToday, () => {
              emitChange({ ...currentValues, date: today });
              if (Platform.OS !== "web")
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            })}
            {renderOption("Amanhã", isTomorrow, () => {
              emitChange({ ...currentValues, date: tomorrow });
              if (Platform.OS !== "web")
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            })}
            {renderOption(
              !isToday && !isTomorrow
                ? date.toLocaleDateString("pt-BR")
                : "Escolher",
              !isToday && !isTomorrow,
              () => setShowDatePicker(true),
            )}
          </View>
          {showDatePicker && (
            <DateTimePicker
              value={date}
              mode="date"
              display="default"
              onChange={(event, selectedDate) => handleDateChange(selectedDate)}
            />
          )}
        </View>

        <View style={groupStyle}>
          <Text style={filterLabelStyle}>Turno</Text>
          <View style={optionWrapStyle}>
            {renderOption("Todos", shiftLabel === null, () =>
              handleShiftLabelChange(null),
            )}
            {renderOption("Manhã", shiftLabel === "MANHA", () =>
              handleShiftLabelChange("MANHA"),
            )}
            {renderOption("Tarde", shiftLabel === "TARDE", () =>
              handleShiftLabelChange("TARDE"),
            )}
            {renderOption("Noite", shiftLabel === "NOITE", () =>
              handleShiftLabelChange("NOITE"),
            )}
          </View>
        </View>
      </View>
    </View>
  );
}

const filterLabelStyle = {
  ...theme.text.caption,
  color: theme.colors.textSecondary,
  fontWeight: theme.weight.semibold,
  marginBottom: theme.space[2],
  textTransform: "uppercase" as const,
};

const optionWrapStyle = {
  flexDirection: "row" as const,
  flexWrap: "wrap" as const,
  gap: theme.space[2],
};

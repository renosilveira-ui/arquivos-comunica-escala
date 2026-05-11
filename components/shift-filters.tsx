import React, { useState, useEffect, useMemo } from "react";
import { View, Text, TouchableOpacity, Platform, useWindowDimensions } from "react-native";
import DateTimePicker from "@react-native-community/datetimepicker";
import * as Haptics from "expo-haptics";
import { theme } from "@/lib/theme";

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
  initialValues?: Partial<ShiftFilterValues>;
  onChange: (filters: ShiftFilterValues) => void;
  counts?: {
    vacanciesByHospital: Record<number, number>;
    pendingByHospital: Record<number, number>;
    vacanciesBySector: Record<number, number>;
    pendingBySector: Record<number, number>;
  };
};

export function ShiftFilters({
  hospitals,
  sectors,
  allowAllHospitals,
  initialValues,
  onChange,
  counts,
}: ShiftFiltersProps) {
  const { width } = useWindowDimensions();
  const isCompact = width < 760;
  const [hospitalId, setHospitalId] = useState<number | null>(initialValues?.hospitalId ?? null);
  const [sectorId, setSectorId] = useState<number | null>(initialValues?.sectorId ?? null);
  const [date, setDate] = useState<Date>(initialValues?.date ?? new Date());
  const [shiftLabel, setShiftLabel] = useState<string | null>(initialValues?.shiftLabel ?? null);

  // Aplicar initialValues quando mudam (defaults inteligentes)
  useEffect(() => {
    if (initialValues?.hospitalId !== undefined) {
      setHospitalId(initialValues.hospitalId);
    }
    if (initialValues?.sectorId !== undefined) {
      setSectorId(initialValues.sectorId);
    }
    if (initialValues?.date) {
      setDate(initialValues.date);
    }
    if (initialValues?.shiftLabel !== undefined) {
      setShiftLabel(initialValues.shiftLabel);
    }
  }, [initialValues]);
  const [showDatePicker, setShowDatePicker] = useState(false);

  // Setor dependente: só mostra setores do hospital selecionado
  const availableSectors = useMemo(
    () => (hospitalId ? sectors.filter((s) => s.hospitalId === hospitalId) : []),
    [hospitalId, sectors],
  );

  // Auto-selecionar setor se só houver 1
  useEffect(() => {
    if (availableSectors.length === 1 && sectorId === null) {
      setSectorId(availableSectors[0].id);
    }
  }, [availableSectors, sectorId]);

  // Notificar mudanças
  useEffect(() => {
    onChange({ hospitalId, sectorId, date, shiftLabel });
  }, [hospitalId, sectorId, date, shiftLabel, onChange]);

  const handleHospitalChange = (id: number | null) => {
    if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setHospitalId(id);
    setSectorId(null); // reset setor ao mudar hospital
    
    // Persistir em localStorage
    if (Platform.OS === "web") {
      if (id !== null) {
        localStorage.setItem("lastHospitalId", id.toString());
      } else {
        localStorage.removeItem("lastHospitalId");
      }
      localStorage.removeItem("lastSectorId"); // reset setor
    }
  };

  const handleSectorChange = (id: number | null) => {
    if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setSectorId(id);
    
    // Persistir em localStorage
    if (Platform.OS === "web") {
      if (id !== null) {
        localStorage.setItem("lastSectorId", id.toString());
      } else {
        localStorage.removeItem("lastSectorId");
      }
    }
  };

  const handleDateChange = (selectedDate?: Date) => {
    if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setShowDatePicker(false);
    if (selectedDate) setDate(selectedDate);
  };

  const handleShiftLabelChange = (label: string | null) => {
    if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setShiftLabel(label);
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
        minHeight: 36,
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
            {allowAllHospitals && (
              renderOption("Todos", hospitalId === null, () => handleHospitalChange(null))
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
            <Text style={{ ...theme.text.body, color: theme.colors.textMuted, fontStyle: "italic" }}>
              Selecione hospital
            </Text>
          ) : (
            <View style={optionWrapStyle}>
              {renderOption("Todos", sectorId === null, () => handleSectorChange(null))}
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
              setDate(today);
              if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            })}
            {renderOption("Amanhã", isTomorrow, () => {
              setDate(tomorrow);
              if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            })}
            {renderOption(
              !isToday && !isTomorrow ? date.toLocaleDateString("pt-BR") : "Escolher",
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
            {renderOption("Todos", shiftLabel === null, () => handleShiftLabelChange(null))}
            {renderOption("Manhã", shiftLabel === "MANHA", () => handleShiftLabelChange("MANHA"))}
            {renderOption("Tarde", shiftLabel === "TARDE", () => handleShiftLabelChange("TARDE"))}
            {renderOption("Noite", shiftLabel === "NOITE", () => handleShiftLabelChange("NOITE"))}
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

import React, { useState, useEffect } from "react";
import { View, Text, TouchableOpacity, Platform } from "react-native";
import DateTimePicker from "@react-native-community/datetimepicker";
import * as Haptics from "expo-haptics";

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
  const availableSectors = hospitalId
    ? sectors.filter((s) => s.hospitalId === hospitalId)
    : [];

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

  return (
    <View className="bg-white/10 rounded-xl p-4 space-y-3">
      {/* Linha 1: Hospital + Setor */}
      <View className="flex-row gap-3">
        {/* Hospital Dropdown */}
        <View className="flex-1">
          <Text className="text-white/60 text-sm font-medium mb-2">Hospital</Text>
          <View className="flex-row flex-wrap gap-2">
            {allowAllHospitals && (
              <TouchableOpacity
                onPress={() => handleHospitalChange(null)}
                className={`px-4 py-2 rounded-lg ${
                  hospitalId === null ? "bg-primary" : "bg-white/10"
                }`}
              >
                <Text className={`font-semibold ${hospitalId === null ? "text-white" : "text-white/70"}`}>
                  Todos
                </Text>
              </TouchableOpacity>
            )}
            {hospitals.map((h) => {
              const count = counts?.vacanciesByHospital[h.id] || 0;
              return (
                <TouchableOpacity
                  key={h.id}
                  onPress={() => handleHospitalChange(h.id)}
                  className={`px-4 py-2 rounded-lg ${
                    hospitalId === h.id ? "bg-primary" : "bg-white/10"
                  }`}
                >
                  <Text className={`font-semibold ${hospitalId === h.id ? "text-white" : "text-white/70"}`}>
                    {h.name} {count > 0 && `(${count})`}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>

        {/* Setor Dropdown (dependente) */}
        <View className="flex-1">
          <Text className="text-white/60 text-sm font-medium mb-2">Setor</Text>
          {hospitalId === null && !allowAllHospitals ? (
            <Text className="text-white/40 text-sm italic">Selecione hospital</Text>
          ) : (
            <View className="flex-row flex-wrap gap-2">
              <TouchableOpacity
                onPress={() => handleSectorChange(null)}
                className={`px-4 py-2 rounded-lg ${
                  sectorId === null ? "bg-primary" : "bg-white/10"
                }`}
              >
                <Text className={`font-semibold ${sectorId === null ? "text-white" : "text-white/70"}`}>
                  Todos
                </Text>
              </TouchableOpacity>
              {availableSectors.map((s) => {
                const count = counts?.vacanciesBySector[s.id] || 0;
                return (
                  <TouchableOpacity
                    key={s.id}
                    onPress={() => handleSectorChange(s.id)}
                    className={`px-4 py-2 rounded-lg ${
                      sectorId === s.id ? "bg-primary" : "bg-white/10"
                    }`}
                  >
                    <Text className={`font-semibold ${sectorId === s.id ? "text-white" : "text-white/70"}`}>
                      {s.name} {count > 0 && `(${count})`}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          )}
        </View>
      </View>

      {/* Linha 2: Data + Turno */}
      <View className="flex-row gap-3">
        {/* Data */}
        <View className="flex-1">
          <Text className="text-white/60 text-sm font-medium mb-2">Data</Text>
          <View className="flex-row gap-2">
            <TouchableOpacity
              onPress={() => {
                setDate(today);
                if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              }}
              className={`px-4 py-2 rounded-lg ${isToday ? "bg-primary" : "bg-white/10"}`}
            >
              <Text className={`font-semibold ${isToday ? "text-white" : "text-white/70"}`}>Hoje</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => {
                setDate(tomorrow);
                if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              }}
              className={`px-4 py-2 rounded-lg ${isTomorrow ? "bg-primary" : "bg-white/10"}`}
            >
              <Text className={`font-semibold ${isTomorrow ? "text-white" : "text-white/70"}`}>Amanhã</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => setShowDatePicker(true)}
              className="px-4 py-2 rounded-lg bg-white/10"
            >
              <Text className="font-semibold text-white/70">
                {!isToday && !isTomorrow ? date.toLocaleDateString("pt-BR") : "Escolher"}
              </Text>
            </TouchableOpacity>
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

        {/* Turno */}
        <View className="flex-1">
          <Text className="text-white/60 text-sm font-medium mb-2">Turno</Text>
          <View className="flex-row gap-2">
            <TouchableOpacity
              onPress={() => handleShiftLabelChange(null)}
              className={`px-4 py-2 rounded-lg ${shiftLabel === null ? "bg-primary" : "bg-white/10"}`}
            >
              <Text className={`font-semibold ${shiftLabel === null ? "text-white" : "text-white/70"}`}>
                Todos
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => handleShiftLabelChange("MANHA")}
              className={`px-4 py-2 rounded-lg ${shiftLabel === "MANHA" ? "bg-primary" : "bg-white/10"}`}
            >
              <Text className={`font-semibold ${shiftLabel === "MANHA" ? "text-white" : "text-white/70"}`}>
                Manhã
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => handleShiftLabelChange("TARDE")}
              className={`px-4 py-2 rounded-lg ${shiftLabel === "TARDE" ? "bg-primary" : "bg-white/10"}`}
            >
              <Text className={`font-semibold ${shiftLabel === "TARDE" ? "text-white" : "text-white/70"}`}>
                Tarde
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => handleShiftLabelChange("NOITE")}
              className={`px-4 py-2 rounded-lg ${shiftLabel === "NOITE" ? "bg-primary" : "bg-white/10"}`}
            >
              <Text className={`font-semibold ${shiftLabel === "NOITE" ? "text-white" : "text-white/70"}`}>
                Noite
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </View>
  );
}

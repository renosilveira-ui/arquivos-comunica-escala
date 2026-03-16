import { useState, useEffect } from "react";
import { Text, View, TouchableOpacity, TextInput, ActivityIndicator, Switch, ScrollView, Platform, Modal, Pressable, Keyboard } from "react-native";
import { ScreenGradient } from "@/components/ui/ScreenGradient";
import { TintedGlassCard } from "@/components/ui/TintedGlassCard";
import { useAuth } from "@/hooks/use-auth";
import { usePermissions } from "@/hooks/use-permissions";
import { trpc } from "@/lib/trpc";
import { useRouter, useLocalSearchParams } from "expo-router";
import * as Haptics from "expo-haptics";
import { ChevronLeft, Calendar, Clock, Repeat } from "lucide-react-native";
import { scheduleShiftReminder } from "@/lib/notifications";
import DateTimePicker from "@react-native-community/datetimepicker";
import { formatDateBR, toISODateString } from "@/lib/datetime";
import { normalizeToNoon, toLocalISODateString } from "@/lib/datetime-utils";

type ShiftType = "Manhã" | "Tarde" | "Noite";

const SHIFT_TIMES: Record<ShiftType, { start: string; end: string }> = {
  "Manhã": { start: "07:00", end: "13:00" },
  "Tarde": { start: "13:00", end: "19:00" },
  "Noite": { start: "19:00", end: "07:00" },
};

/**
 * Tela de Criação de Escala
 * Formulário avançado com 3 profissionais por turno e repetição automática
 */
export default function CreateShiftScreen() {
  const { user } = useAuth();
  const { can } = usePermissions();
  const router = useRouter();
  const params = useLocalSearchParams();
  const utils = trpc.useUtils();

  // Guard: somente admin/manager podem criar escalas
  useEffect(() => {
    if (!can("create:shift")) router.back();
  }, []);

  // Estados do formulário
  const [selectedSectorId, setSelectedSectorId] = useState<number | undefined>(undefined);
  const [selectedDate, setSelectedDate] = useState(params.date as string || "");
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [tempDate, setTempDate] = useState<Date | null>(null);
  const [selectedShift, setSelectedShift] = useState<ShiftType | undefined>(
    params.shift as ShiftType || undefined
  );
  
  // 3 profissionais por turno (A, B, C) — kept for compile compatibility
  const [professionalA, setProfessionalA] = useState<number | undefined>(undefined);
  const [professionalB, setProfessionalB] = useState<number | undefined>(undefined);
  const [professionalC, setProfessionalC] = useState<number | undefined>(undefined);
  
  // Repetição automática
  const [enableRepeat, setEnableRepeat] = useState(false);
  const [repeatWeeks, setRepeatWeeks] = useState("1");
  const [repeatEndDate, setRepeatEndDate] = useState("");

  const [notes, setNotes] = useState("");

  // Buscar setores e templates
  const { data: sectors, isLoading: loadingSectors } = trpc.sectors.list.useQuery();
  const { data: templates } = trpc.shifts.listTemplates.useQuery();

  // Mutation para criar escala
  const createShift = trpc.shifts.create.useMutation({
    onSuccess: async () => {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      
      // Agendar lembrete 30 min antes
      if (selectedSectorId && selectedDate && selectedShift) {
        const sector = sectors?.find(s => s.id === selectedSectorId);
        const shiftTimes = SHIFT_TIMES[selectedShift];
        const startDateTime = new Date(`${selectedDate}T${shiftTimes.start}:00`);
        
        if (sector) {
          await scheduleShiftReminder(
            sector.name,
            startDateTime,
            `${selectedShift} (${shiftTimes.start} - ${shiftTimes.end})`
          );
        }
      }
      
      utils.shifts.listByPeriod.invalidate();
      router.back();
    },
    onError: (error) => {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      console.error("Erro ao criar escala:", error);
    },
  });

  const handleSelectSector = (sectorId: number) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setSelectedSectorId(sectorId);
  };

  const handleSelectShift = (shift: ShiftType) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setSelectedShift(shift);
  };

  const handleCreateShift = () => {
    if (!selectedDate || !selectedShift) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      return;
    }

    // Encontrar template correspondente ao turno selecionado
    const template = templates?.find(t => t.name === selectedShift);
    if (!template) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      return;
    }

    // Validar data de término de repetição
    if (enableRepeat && repeatEndDate) {
      const startDate = new Date(selectedDate);
      const endDate = new Date(repeatEndDate);
      if (endDate <= startDate) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        return;
      }
    }

    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

    createShift.mutate({
      date: selectedDate,
      shiftTemplateId: template.id,
      sectorId: selectedSectorId,
    });
  };

  const handleBack = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    router.back();
  };

  // Gerar data de hoje no formato YYYY-MM-DD (para backend)
  const today = toLocalISODateString(new Date());
  
  // Handler para DateTimePicker (apenas atualiza tempDate durante rolagem)
  const handleDateChange = (event: any, date?: Date) => {
    if (Platform.OS === "android" && event.type === "dismissed") {
      setShowDatePicker(false);
      setTempDate(null);
      return;
    }
    
    if (Platform.OS === "android" && date) {
      // Android: confirmar imediatamente
      const normalized = normalizeToNoon(date);
      setSelectedDate(toLocalISODateString(normalized));
      setShowDatePicker(false);
      setTempDate(null);
    } else if (date) {
      // iOS: apenas atualizar preview
      setTempDate(date);
    }
  };
  
  // Confirmar seleção de data (iOS)
  const handleConfirmDate = () => {
    if (tempDate) {
      const normalized = normalizeToNoon(tempDate);
      setSelectedDate(toLocalISODateString(normalized));
    }
    setShowDatePicker(false);
    setTempDate(null);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  };
  
  // Cancelar seleção de data (iOS)
  const handleCancelDate = () => {
    setShowDatePicker(false);
    setTempDate(null);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  };
  
  // Handler para abrir DateTimePicker ao tocar no ícone
  const handleCalendarPress = () => {
    Keyboard.dismiss(); // Fechar teclado antes de abrir modal
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setTempDate(selectedDate ? new Date(selectedDate) : new Date()); // Inicializar tempDate
    setShowDatePicker(true);
  };

  if (!user) {
    return (
      <ScreenGradient scrollable={false}>
        <View className="flex-1 justify-center items-center">
          <Text className="text-lg" style={{ color: 'rgba(255,255,255,0.7)' }}>Faça login para continuar</Text>
        </View>
      </ScreenGradient>
    );
  }

  return (
    <ScreenGradient scrollable>
      <View className="gap-6 pb-8">
        {/* Header com botão voltar */}
        <View className="flex-row items-center gap-4">
          <TouchableOpacity
            onPress={handleBack}
            activeOpacity={0.7}
            className="w-10 h-10 items-center justify-center"
          >
            <ChevronLeft size={28} color="#FFFFFF" />
          </TouchableOpacity>
          <View className="flex-1">
            <Text className="text-3xl font-bold" style={{ color: '#FFFFFF' }}>Nova Escala</Text>
            <Text className="text-base mt-1" style={{ color: 'rgba(255,255,255,0.5)' }}>Alocar profissionais no turno</Text>
          </View>
        </View>

        {/* Seleção de Setor */}
        <TintedGlassCard className="gap-4">
          <View className="flex-row items-center gap-3">
            <Calendar size={24} color="#FFFFFF" />
            <Text className="text-lg font-semibold" style={{ color: '#FFFFFF' }}>Setor *</Text>
          </View>

          {loadingSectors ? (
            <View className="items-center py-6">
              <ActivityIndicator size="small" color="#4DA3FF" />
            </View>
          ) : (
            <View className="flex-row flex-wrap gap-3">
              {sectors?.map((sector) => (
                <TouchableOpacity
                  key={sector.id}
                  onPress={() => handleSelectSector(sector.id)}
                  className="px-5 py-3 rounded-2xl"
                  style={{
                    backgroundColor:
                      selectedSectorId === sector.id
                        ? "#4DA3FF"
                        : "rgba(255,255,255,0.05)",
                    borderWidth: 1,
                    borderColor:
                      selectedSectorId === sector.id
                        ? "#4DA3FF"
                        : "rgba(255,255,255,0.12)",
                  }}
                  activeOpacity={0.7}
                >
                  <Text
                    className="text-base font-semibold" style={{ color: '#FFFFFF' }}
                  >
                    {sector.name}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          )}
        </TintedGlassCard>

        {/* Data */}
        <TintedGlassCard className="gap-4">
          <View className="flex-row items-center gap-3">
            <TouchableOpacity onPress={handleCalendarPress} activeOpacity={0.7}>
              <Calendar size={24} color="#FFFFFF" />
            </TouchableOpacity>
            <Text className="text-lg font-semibold" style={{ color: '#FFFFFF' }}>Data *</Text>
          </View>

          <TouchableOpacity
            onPress={handleCalendarPress}
            activeOpacity={0.7}
            className="rounded-2xl px-4 h-12 justify-center"
            style={{
              backgroundColor: "rgba(255,255,255,0.05)",
              borderWidth: 1,
              borderColor: "rgba(255,255,255,0.12)",
            }}
          >
            <Text className="text-base" style={{ color: '#FFFFFF' }}>
              {formatDateBR(selectedDate || today)}
            </Text>
          </TouchableOpacity>
          

          
          {showDatePicker && Platform.OS === "android" && (
            <DateTimePicker
              value={selectedDate ? new Date(selectedDate) : new Date()}
              mode="date"
              display="default"
              onChange={handleDateChange}
              locale="pt-BR"
              minimumDate={new Date()}
            />
          )}
        </TintedGlassCard>

        {/* Seleção de Turno */}
        <TintedGlassCard className="gap-4">
          <View className="flex-row items-center gap-3">
            <Clock size={24} color="#FFFFFF" />
            <Text className="text-lg font-semibold" style={{ color: '#FFFFFF' }}>Turno *</Text>
          </View>

          <View className="gap-3">
            {(Object.keys(SHIFT_TIMES) as ShiftType[]).map((shift) => (
              <TouchableOpacity
                key={shift}
                onPress={() => handleSelectShift(shift)}
                className="px-5 py-4 rounded-2xl"
                style={{
                  backgroundColor:
                    selectedShift === shift
                      ? "#4DA3FF"
                      : "rgba(255,255,255,0.05)",
                  borderWidth: 1,
                  borderColor:
                    selectedShift === shift
                      ? "#4DA3FF"
                      : "rgba(255,255,255,0.12)",
                }}
                activeOpacity={0.7}
              >
                <Text className="text-base font-semibold" style={{ color: '#FFFFFF' }}>
                  {shift}
                </Text>
                <Text className="text-sm mt-1" style={{ color: 'rgba(255,255,255,0.5)' }}>
                  {SHIFT_TIMES[shift].start} - {SHIFT_TIMES[shift].end}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </TintedGlassCard>

        {/* Repetição Automática */}
        <TintedGlassCard className="gap-4">
          <View className="flex-row items-center justify-between">
            <View className="flex-row items-center gap-3 flex-1">
              <Repeat size={24} color="#FFFFFF" />
              <Text className="text-lg font-semibold" style={{ color: '#FFFFFF' }}>Repetir Escala</Text>
            </View>
            <Switch
              value={enableRepeat}
              onValueChange={(value) => {
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                setEnableRepeat(value);
              }}
              trackColor={{ false: "rgba(255,255,255,0.2)", true: "#4DA3FF" }}
              thumbColor="#FFFFFF"
            />
          </View>

          {enableRepeat && (
            <View className="gap-4">
              <View>
                <Text className="text-sm mb-2" style={{ color: 'rgba(255,255,255,0.5)' }}>Repetir a cada (semanas)</Text>
                <TextInput
                  value={repeatWeeks}
                  onChangeText={setRepeatWeeks}
                  placeholder="1"
                  keyboardType="number-pad"
                  placeholderTextColor="rgba(255,255,255,0.3)"
                  className="rounded-2xl px-4 h-12 text-base"
                  style={{
                    backgroundColor: "rgba(255,255,255,0.05)",
                    borderWidth: 1,
                    borderColor: "rgba(255,255,255,0.12)",
                  }}
                />
              </View>

              <View>
                <Text className="text-sm mb-2" style={{ color: 'rgba(255,255,255,0.5)' }}>Data limite</Text>
                <TextInput
                  value={repeatEndDate}
                  onChangeText={setRepeatEndDate}
                  placeholder="YYYY-MM-DD"
                  placeholderTextColor="rgba(255,255,255,0.3)"
                  className="rounded-2xl px-4 h-12 text-base"
                  style={{
                    backgroundColor: "rgba(255,255,255,0.05)",
                    borderWidth: 1,
                    borderColor: "rgba(255,255,255,0.12)",
                  }}
                />
              </View>
            </View>
          )}
        </TintedGlassCard>

        {/* Observações */}
        <TintedGlassCard className="gap-4">
          <Text className="text-lg font-semibold" style={{ color: '#FFFFFF' }}>Observações</Text>
          <TextInput
            value={notes}
            onChangeText={setNotes}
            placeholder="Informações adicionais..."
            placeholderTextColor="rgba(255,255,255,0.3)"
            multiline
            numberOfLines={4}
            textAlignVertical="top"
            className="rounded-2xl px-4 py-3 text-base"
            style={{
              backgroundColor: "rgba(255,255,255,0.05)",
              borderWidth: 1,
              borderColor: "rgba(255,255,255,0.12)",
              minHeight: 100,
              color: "#FFFFFF",
            }}
          />
        </TintedGlassCard>

        {/* Botão Criar */}
        <TouchableOpacity
          onPress={handleCreateShift}
          disabled={createShift.isPending}
          className="bg-[#4DA3FF] rounded-2xl h-14 items-center justify-center"
          activeOpacity={0.7}
        >
          {createShift.isPending ? (
            <ActivityIndicator size="small" color="#FFFFFF" />
          ) : (
            <Text className="text-lg font-semibold" style={{ color: '#FFFFFF' }}>Criar Escala</Text>
          )}
        </TouchableOpacity>
      </View>
      
      {/* Modal de Seleção de Data (iOS) */}
      <Modal
        visible={showDatePicker && Platform.OS === "ios"}
        transparent
        animationType="fade"
        onRequestClose={handleCancelDate}
      >
        <Pressable
          style={{
            flex: 1,
            backgroundColor: "rgba(0,0,0,0.7)",
            justifyContent: "flex-end",
          }}
          onPress={handleCancelDate}
        >
          <Pressable
            style={{
              backgroundColor: "rgba(20,25,30,0.98)",
              borderTopLeftRadius: 24,
              borderTopRightRadius: 24,
              padding: 24,
              paddingBottom: 40,
            }}
            onPress={(e) => e.stopPropagation()}
          >
            <Text style={{ color: "#FFFFFF", fontSize: 18, fontWeight: "700", marginBottom: 8, textAlign: "center" }}>
              Selecionar data
            </Text>
            <Text style={{ color: "rgba(255,255,255,0.6)", fontSize: 14, marginBottom: 20, textAlign: "center" }}>
              Data selecionada: {tempDate ? formatDateBR(toLocalISODateString(normalizeToNoon(tempDate))) : formatDateBR(selectedDate || today)}
            </Text>
            
            <DateTimePicker
              value={tempDate || (selectedDate ? new Date(selectedDate) : new Date())}
              mode="date"
              display="spinner"
              onChange={handleDateChange}
              locale="pt-BR"
              minimumDate={new Date()}
              textColor="#FFFFFF"
            />
            
            <View style={{ flexDirection: "row", gap: 12, marginTop: 24 }}>
              <TouchableOpacity
                onPress={handleCancelDate}
                style={{
                  flex: 1,
                  backgroundColor: "rgba(255,255,255,0.1)",
                  borderRadius: 12,
                  padding: 16,
                  alignItems: "center",
                }}
                activeOpacity={0.7}
              >
                <Text style={{ color: "#FFFFFF", fontSize: 16, fontWeight: "600" }}>Cancelar</Text>
              </TouchableOpacity>
              
              <TouchableOpacity
                onPress={handleConfirmDate}
                style={{
                  flex: 1,
                  backgroundColor: "#4DA3FF",
                  borderRadius: 12,
                  padding: 16,
                  alignItems: "center",
                }}
                activeOpacity={0.7}
              >
                <Text style={{ color: "#FFFFFF", fontSize: 16, fontWeight: "600" }}>Confirmar</Text>
              </TouchableOpacity>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </ScreenGradient>
  );
}

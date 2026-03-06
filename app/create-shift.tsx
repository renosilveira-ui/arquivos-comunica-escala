import { useState, useEffect } from "react";
import { Text, View, TouchableOpacity, TextInput, ActivityIndicator, Switch, ScrollView, Platform, Modal, Pressable, Keyboard } from "react-native";
import { ScreenGradient } from "@/components/ui/ScreenGradient";
import { TintedGlassCard } from "@/components/ui/TintedGlassCard";
import { useAuth } from "@/hooks/use-auth";
import { trpc } from "@/lib/trpc";
import { useRouter, useLocalSearchParams } from "expo-router";
import * as Haptics from "expo-haptics";
import { ChevronLeft, Calendar, Clock, Users, Repeat, AlertTriangle } from "lucide-react-native";
import { isDemoMode, DEMO_SECTORS, DEMO_USER, DEMO_SHIFTS } from "@/lib/demo-mode";
import { scheduleShiftReminder } from "@/lib/notifications";
import { checkMultipleProfessionalsConflicts } from "@/lib/shift-validation";
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
  const router = useRouter();
  const params = useLocalSearchParams();
  const utils = trpc.useUtils();
  const [isDemo, setIsDemo] = useState(false);

  // Verificar modo demo
  useEffect(() => {
    isDemoMode().then(setIsDemo);
  }, []);

  // Estados do formulário
  const [selectedSectorId, setSelectedSectorId] = useState<number | undefined>(undefined);
  const [selectedDate, setSelectedDate] = useState(params.date as string || "");
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [tempDate, setTempDate] = useState<Date | null>(null);
  const [selectedShift, setSelectedShift] = useState<ShiftType | undefined>(
    params.shift as ShiftType || undefined
  );
  
  // 3 profissionais por turno (A, B, C)
  const [professionalA, setProfessionalA] = useState<number | undefined>(undefined);
  const [professionalB, setProfessionalB] = useState<number | undefined>(undefined);
  const [professionalC, setProfessionalC] = useState<number | undefined>(undefined);
  
  // Repetição automática
  const [enableRepeat, setEnableRepeat] = useState(false);
  const [repeatWeeks, setRepeatWeeks] = useState("1");
  const [repeatEndDate, setRepeatEndDate] = useState("");
  
  const [notes, setNotes] = useState("");
  const [conflictWarning, setConflictWarning] = useState<string | null>(null);

  // Buscar setores (API ou demo)
  const { data: apiSectors, isLoading: loadingSectors } = trpc.sectors.list.useQuery(undefined, {
    enabled: !isDemo,
  });
  const sectors = isDemo ? DEMO_SECTORS : apiSectors;

  // Lista de profissionais demo (API não disponível)
  const loadingUsers = false;
  const professionals = isDemo ? [
    { id: 1, name: "Dr. Ana Silva" },
    { id: 2, name: "Dr. Carlos Santos" },
    { id: 3, name: "Dra. Maria Oliveira" },
    { id: 4, name: "Dr. Pedro Costa" },
  ] : [];

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
    if (!selectedSectorId || !selectedDate || !selectedShift) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      return;
    }

    // Pelo menos 1 profissional deve ser selecionado
    if (!professionalA && !professionalB && !professionalC) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      return;
    }

    // Validar data de término de repetição
    if (enableRepeat && repeatEndDate) {
      const startDate = new Date(selectedDate);
      const endDate = new Date(repeatEndDate);
      
      if (endDate <= startDate) {
        setConflictWarning("Data de término da repetição deve ser posterior à data inicial da escala");
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        return;
      }
    }

    const shiftTimes = SHIFT_TIMES[selectedShift];
    const startDateTime = new Date(`${selectedDate}T${shiftTimes.start}:00`);
    let endDateTime = new Date(`${selectedDate}T${shiftTimes.end}:00`);
    
    // Se termina antes do início (turno noite), adiciona 1 dia
    if (endDateTime <= startDateTime) {
      endDateTime.setDate(endDateTime.getDate() + 1);
    }

    // Validar conflitos de horários
    const selectedProfessionals = [professionalA, professionalB, professionalC].filter(
      (id): id is number => id !== undefined
    );

    if (selectedProfessionals.length > 0) {
      // Buscar escalas existentes (demo ou API)
      const allShifts = isDemo
        ? DEMO_SHIFTS.flatMap((demoShift) =>
            demoShift.assignments.map((assignment) => ({
              id: demoShift.shift.id,
              userId: assignment.professionalId,
              sectorName: demoShift.sector.name,
              startTime: demoShift.shift.startTime,
              endTime: demoShift.shift.endTime,
              position: "A", // Demo não tem posições A/B/C
            }))
          )
        : [];

      const conflicts = checkMultipleProfessionalsConflicts(
        selectedProfessionals,
        startDateTime,
        endDateTime,
        allShifts
      );

      if (conflicts.size > 0) {
        // Mostrar aviso de conflito
        const conflictMessages = Array.from(conflicts.entries())
          .map(([userId, conflict]) => {
            const professional = professionals.find((p) => p.id === userId);
            return `${professional?.name}: ${conflict.message}`;
          })
          .join("\n");

        setConflictWarning(conflictMessages);
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
        return;
      }
    }

    // Limpar aviso de conflito
    setConflictWarning(null);

    if (isDemo) {
      // Modo demo: agendar lembrete e feedback visual
      const sector = sectors?.find(s => s.id === selectedSectorId);
      const shiftTimes = SHIFT_TIMES[selectedShift];
      const startDateTime = new Date(`${selectedDate}T${shiftTimes.start}:00`);
      
      if (sector) {
        scheduleShiftReminder(
          sector.name,
          startDateTime,
          `${selectedShift} (${shiftTimes.start} - ${shiftTimes.end})`
        );
      }
      
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      router.back();
      return;
    }

    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

    // Coletar IDs dos profissionais selecionados
    const userIds = [professionalA, professionalB, professionalC].filter((id): id is number => id !== undefined);

    createShift.mutate({
      sectorId: selectedSectorId,
      startTime: startDateTime,
      endTime: endDateTime,
      userIds,
      notes: notes.trim() || undefined,
      createdBy: user?.id || DEMO_USER.id,
      // repeatFrequencyWeeks e repeatEndDate serão adicionados à API posteriormente
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

  if (!user && !isDemo) {
    return (
      <ScreenGradient scrollable={false}>
        <View className="flex-1 justify-center items-center">
          <Text className="text-lg text-white/70">Faça login para continuar</Text>
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
            <Text className="text-3xl font-bold text-white">Nova Escala</Text>
            <Text className="text-base text-white/50 mt-1">Alocar profissionais no turno</Text>
          </View>
        </View>

        {/* Seleção de Setor */}
        <TintedGlassCard className="gap-4">
          <View className="flex-row items-center gap-3">
            <Calendar size={24} color="#FFFFFF" />
            <Text className="text-lg font-semibold text-white">Setor *</Text>
          </View>

          {loadingSectors && !isDemo ? (
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
                    className="text-base font-semibold text-white"
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
            <Text className="text-lg font-semibold text-white">Data *</Text>
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
            <Text className="text-base text-white">
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
            <Text className="text-lg font-semibold text-white">Turno *</Text>
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
                <Text className="text-base font-semibold text-white">
                  {shift}
                </Text>
                <Text className="text-sm text-white/50 mt-1">
                  {SHIFT_TIMES[shift].start} - {SHIFT_TIMES[shift].end}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </TintedGlassCard>

        {/* Profissionais (A, B, C) */}
        <TintedGlassCard className="gap-4">
          <View className="flex-row items-center gap-3">
            <Users size={24} color="#FFFFFF" />
            <Text className="text-lg font-semibold text-white">Profissionais *</Text>
          </View>
          <Text className="text-sm text-white/50">Selecione até 3 profissionais para o turno</Text>

          {loadingUsers && !isDemo ? (
            <View className="items-center py-6">
              <ActivityIndicator size="small" color="#4DA3FF" />
            </View>
          ) : (
            <View className="gap-4">
              {/* Profissional A */}
              <View>
                <Text className="text-sm text-white/70 mb-2">Profissional A (Principal)</Text>
                <View className="flex-row flex-wrap gap-2">
                  {professionals?.map((prof: any) => (
                    <TouchableOpacity
                      key={`a-${prof.id}`}
                      onPress={() => {
                        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                        setProfessionalA(prof.id === professionalA ? undefined : prof.id);
                      }}
                      className="px-4 py-2 rounded-xl"
                      style={{
                        backgroundColor:
                          professionalA === prof.id
                            ? "#4DA3FF"
                            : "rgba(255,255,255,0.05)",
                        borderWidth: 1,
                        borderColor:
                          professionalA === prof.id
                            ? "#4DA3FF"
                            : "rgba(255,255,255,0.12)",
                      }}
                      activeOpacity={0.7}
                    >
                      <Text className="text-sm font-medium text-white">{prof.name}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </View>

              {/* Profissional B */}
              <View>
                <Text className="text-sm text-white/70 mb-2">Profissional B (Secundário)</Text>
                <View className="flex-row flex-wrap gap-2">
                  {professionals?.map((prof: any) => (
                    <TouchableOpacity
                      key={`b-${prof.id}`}
                      onPress={() => {
                        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                        setProfessionalB(prof.id === professionalB ? undefined : prof.id);
                      }}
                      className="px-4 py-2 rounded-xl"
                      style={{
                        backgroundColor:
                          professionalB === prof.id
                            ? "#4DA3FF"
                            : "rgba(255,255,255,0.05)",
                        borderWidth: 1,
                        borderColor:
                          professionalB === prof.id
                            ? "#4DA3FF"
                            : "rgba(255,255,255,0.12)",
                      }}
                      activeOpacity={0.7}
                    >
                      <Text className="text-sm font-medium text-white">{prof.name}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </View>

              {/* Profissional C */}
              <View>
                <Text className="text-sm text-white/70 mb-2">Profissional C (Terciário)</Text>
                <View className="flex-row flex-wrap gap-2">
                  {professionals?.map((prof: any) => (
                    <TouchableOpacity
                      key={`c-${prof.id}`}
                      onPress={() => {
                        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                        setProfessionalC(prof.id === professionalC ? undefined : prof.id);
                      }}
                      className="px-4 py-2 rounded-xl"
                      style={{
                        backgroundColor:
                          professionalC === prof.id
                            ? "#4DA3FF"
                            : "rgba(255,255,255,0.05)",
                        borderWidth: 1,
                        borderColor:
                          professionalC === prof.id
                            ? "#4DA3FF"
                            : "rgba(255,255,255,0.12)",
                      }}
                      activeOpacity={0.7}
                    >
                      <Text className="text-sm font-medium text-white">{prof.name}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </View>
            </View>
          )}
        </TintedGlassCard>

        {/* Repetição Automática */}
        <TintedGlassCard className="gap-4">
          <View className="flex-row items-center justify-between">
            <View className="flex-row items-center gap-3 flex-1">
              <Repeat size={24} color="#FFFFFF" />
              <Text className="text-lg font-semibold text-white">Repetir Escala</Text>
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
                <Text className="text-sm text-white/50 mb-2">Repetir a cada (semanas)</Text>
                <TextInput
                  value={repeatWeeks}
                  onChangeText={setRepeatWeeks}
                  placeholder="1"
                  keyboardType="number-pad"
                  placeholderTextColor="rgba(255,255,255,0.3)"
                  className="rounded-2xl px-4 h-12 text-base text-white"
                  style={{
                    backgroundColor: "rgba(255,255,255,0.05)",
                    borderWidth: 1,
                    borderColor: "rgba(255,255,255,0.12)",
                  }}
                />
              </View>

              <View>
                <Text className="text-sm text-white/50 mb-2">Data limite</Text>
                <TextInput
                  value={repeatEndDate}
                  onChangeText={setRepeatEndDate}
                  placeholder="YYYY-MM-DD"
                  placeholderTextColor="rgba(255,255,255,0.3)"
                  className="rounded-2xl px-4 h-12 text-base text-white"
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
          <Text className="text-lg font-semibold text-white">Observações</Text>
          <TextInput
            value={notes}
            onChangeText={setNotes}
            placeholder="Informações adicionais..."
            placeholderTextColor="rgba(255,255,255,0.3)"
            multiline
            numberOfLines={4}
            textAlignVertical="top"
            className="rounded-2xl px-4 py-3 text-base text-white"
            style={{
              backgroundColor: "rgba(255,255,255,0.05)",
              borderWidth: 1,
              borderColor: "rgba(255,255,255,0.12)",
              minHeight: 100,
            }}
          />
        </TintedGlassCard>

        {/* Aviso de Conflito */}
        {conflictWarning && (
          <TintedGlassCard 
            className="gap-3"
            style={{
              backgroundColor: "rgba(239,68,68,0.12)",
              borderColor: "rgba(239,68,68,0.4)",
            }}
          >
            <View className="flex-row items-start gap-3">
              <AlertTriangle size={24} color="#F87171" />
              <View className="flex-1">
                <Text className="text-base font-semibold text-[#F87171] mb-2">
                  Conflito de Horários
                </Text>
                <Text className="text-sm text-white/90 leading-relaxed">
                  {conflictWarning}
                </Text>
              </View>
            </View>
          </TintedGlassCard>
        )}

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
            <Text className="text-lg font-semibold text-white">Criar Escala</Text>
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

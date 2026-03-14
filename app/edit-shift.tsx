import { useState, useEffect } from "react";
import {
  ScrollView,
  Text,
  View,
  TouchableOpacity,
  TextInput,
  ActivityIndicator,
  Alert,
  Platform,
  Modal,
  Pressable,
  Keyboard,
} from "react-native";
import { ScreenGradient } from "@/components/ui/ScreenGradient";
import { TintedGlassCard } from "@/components/ui/TintedGlassCard";
import { useAuth } from "@/hooks/use-auth";
import { usePermissions } from "@/hooks/use-permissions";
import { trpc } from "@/lib/trpc";
import { useRouter, useLocalSearchParams } from "expo-router";
import * as Haptics from "expo-haptics";
import { ChevronLeft, Save, Calendar, Clock } from "lucide-react-native";
import { isDemoMode, DEMO_SHIFTS, DEMO_SECTORS } from "@/lib/demo-mode";
import DateTimePicker from "@react-native-community/datetimepicker";
import { formatDateBR, formatTimeBR, toISODateString } from "@/lib/datetime";
import { normalizeToNoon, toLocalISODateString } from "@/lib/datetime-utils";

/**
 * Tela de Edição de Escala
 * Permite alterar dados de uma escala existente
 * Suporte a modo demo
 */
export default function EditShiftScreen() {
  const { user } = useAuth();
  const { can } = usePermissions();
  const router = useRouter();
  const params = useLocalSearchParams();
  const shiftId = Number(params.id);
  const [isDemo, setIsDemo] = useState(false);

  // Guard: somente admin/manager podem editar escalas
  useEffect(() => {
    if (!can("edit:shift")) router.back();
  }, []);

  // Estados do formulário
  const [selectedSectorId, setSelectedSectorId] = useState<number | undefined>();
  const [startDate, setStartDate] = useState("");
  const [startTime, setStartTime] = useState("");
  const [endDate, setEndDate] = useState("");
  const [endTime, setEndTime] = useState("");
  const [notes, setNotes] = useState("");
  
  // Estados do DateTimePicker
  const [showStartDatePicker, setShowStartDatePicker] = useState(false);
  const [showStartTimePicker, setShowStartTimePicker] = useState(false);
  const [showEndDatePicker, setShowEndDatePicker] = useState(false);
  const [showEndTimePicker, setShowEndTimePicker] = useState(false);
  
  // Estados temporários para preview (iOS)
  const [tempStartDate, setTempStartDate] = useState<Date | null>(null);
  const [tempEndDate, setTempEndDate] = useState<Date | null>(null);

  // Verificar modo demo
  useEffect(() => {
    async function checkDemo() {
      const demo = await isDemoMode();
      setIsDemo(demo);
    }
    checkDemo();
  }, []);

  // Buscar setores (API ou demo)
  const { data: sectors } = trpc.sectors.list.useQuery(undefined, { enabled: !isDemo });
  const demoSectors = isDemo ? DEMO_SECTORS : [];
  const availableSectors = isDemo ? demoSectors : (sectors || []);

  // Buscar detalhes da escala (API ou demo)
  const { data: shiftData, isLoading: loadingShift } = trpc.shifts.get.useQuery(
    { id: shiftId },
    { enabled: !isDemo }
  );
  const demoShift = isDemo ? DEMO_SHIFTS.find(s => s.shift.id === shiftId) : null;
  const utils = trpc.useUtils();

  // Mutation para atualizar escala
  const updateShift = trpc.shifts.update.useMutation({
    onSuccess: () => {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      utils.shifts.get.invalidate({ id: shiftId });
      router.back();
    },
    onError: (error) => {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Alert.alert("Erro", error.message || "Erro ao atualizar escala");
    },
  });

  // Carregar dados da escala no formulário
  useEffect(() => {
    if (isDemo && demoShift) {
      setSelectedSectorId(demoShift.shift.sectorId);
      setNotes(demoShift.shift.notes || "");
      
      const start = new Date(demoShift.shift.startTime);
      const end = new Date(demoShift.shift.endTime);
      
      setStartDate(toISODateString(start));
      setStartTime(formatTimeBR(start));
      setEndDate(toISODateString(end));
      setEndTime(formatTimeBR(end));
    } else if (shiftData?.shift) {
      const shift = shiftData.shift;
      setSelectedSectorId(shift.sectorId);
      setNotes(shift.notes || "");

      const start = new Date(shift.startTime);
      const end = new Date(shift.endTime);

      setStartDate(toISODateString(start));
      setStartTime(formatTimeBR(start));
      setEndDate(toISODateString(end));
      setEndTime(formatTimeBR(end));
    }
  }, [shiftData, demoShift, isDemo]);

  // Handlers para DateTimePicker
  const handleStartDateChange = (event: any, date?: Date) => {
    if (Platform.OS === "android" && event.type === "dismissed") {
      setShowStartDatePicker(false);
      setTempStartDate(null);
      return;
    }
    
    if (Platform.OS === "android" && date) {
      const normalized = normalizeToNoon(date);
      setStartDate(toLocalISODateString(normalized));
      setShowStartDatePicker(false);
      setTempStartDate(null);
    } else if (date) {
      setTempStartDate(date);
    }
  };
  
  const handleConfirmStartDate = () => {
    if (tempStartDate) {
      const normalized = normalizeToNoon(tempStartDate);
      setStartDate(toLocalISODateString(normalized));
    }
    setShowStartDatePicker(false);
    setTempStartDate(null);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  };
  
  const handleCancelStartDate = () => {
    setShowStartDatePicker(false);
    setTempStartDate(null);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  };
  
  const handleStartTimeChange = (event: any, date?: Date) => {
    setShowStartTimePicker(Platform.OS === "ios");
    if (date) {
      setStartTime(formatTimeBR(date));
    }
  };
  
  const handleEndDateChange = (event: any, date?: Date) => {
    if (Platform.OS === "android" && event.type === "dismissed") {
      setShowEndDatePicker(false);
      setTempEndDate(null);
      return;
    }
    
    if (Platform.OS === "android" && date) {
      const normalized = normalizeToNoon(date);
      setEndDate(toLocalISODateString(normalized));
      setShowEndDatePicker(false);
      setTempEndDate(null);
    } else if (date) {
      setTempEndDate(date);
    }
  };
  
  const handleConfirmEndDate = () => {
    if (tempEndDate) {
      const normalized = normalizeToNoon(tempEndDate);
      setEndDate(toLocalISODateString(normalized));
    }
    setShowEndDatePicker(false);
    setTempEndDate(null);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  };
  
  const handleCancelEndDate = () => {
    setShowEndDatePicker(false);
    setTempEndDate(null);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  };
  
  const handleEndTimeChange = (event: any, date?: Date) => {
    setShowEndTimePicker(Platform.OS === "ios");
    if (date) {
      setEndTime(formatTimeBR(date));
    }
  };

  const handleBack = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    router.back();
  };

  const handleSelectSector = (sectorId: number) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setSelectedSectorId(sectorId);
  };

  const handleSave = () => {
    if (!selectedSectorId || !startDate || !startTime || !endDate || !endTime) {
      Alert.alert("Erro", "Preencha todos os campos obrigatórios");
      return;
    }

    // Converter strings para Date
    const [startHour, startMinute] = startTime.split(":");
    const [endHour, endMinute] = endTime.split(":");

    const startDateTime = new Date(startDate);
    startDateTime.setHours(Number(startHour), Number(startMinute), 0, 0);

    const endDateTime = new Date(endDate);
    endDateTime.setHours(Number(endHour), Number(endMinute), 0, 0);

    // Validar datas
    if (endDateTime <= startDateTime) {
      Alert.alert("Erro", "A data/hora de término deve ser posterior à de início");
      return;
    }

    if (isDemo) {
      // Em modo demo, apenas simular sucesso
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      Alert.alert("Sucesso", "Escala atualizada (modo demo)");
      router.back();
    } else {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      updateShift.mutate({
        id: shiftId,
        sectorId: selectedSectorId,
        startTime: startDateTime,
        endTime: endDateTime,
        notes: notes || undefined,
      });
    }
  };

  if (!user && !isDemo) {
    return (
      <ScreenGradient>
        <View style={{ flex: 1, justifyContent: "center", alignItems: "center", paddingHorizontal: 24 }}>
          <Text style={{ fontSize: 18, color: "rgba(255,255,255,0.7)" }}>
            Faça login para continuar
          </Text>
        </View>
      </ScreenGradient>
    );
  }

  if (loadingShift && !isDemo) {
    return (
      <ScreenGradient>
        <View style={{ flex: 1, justifyContent: "center", alignItems: "center", paddingHorizontal: 24 }}>
          <ActivityIndicator size="large" color="#4DA3FF" />
          <Text style={{ fontSize: 16, color: "rgba(255,255,255,0.7)", marginTop: 16 }}>
            Carregando...
          </Text>
        </View>
      </ScreenGradient>
    );
  }

  return (
    <ScreenGradient>
      <ScrollView contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 20, paddingBottom: 100 }}>
        <View style={{ gap: 24 }}>
          {/* Header */}
          <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
            <TouchableOpacity onPress={handleBack} activeOpacity={0.7}>
              <ChevronLeft size={28} color="#4DA3FF" />
            </TouchableOpacity>
            <Text style={{ fontSize: 28, fontWeight: "700", color: "#FFFFFF", flex: 1 }}>
              Editar Escala
            </Text>
          </View>

          {/* Seleção de Setor */}
          <TintedGlassCard>
            <Text style={{ fontSize: 18, fontWeight: "600", color: "#FFFFFF", marginBottom: 16 }}>
              Setor *
            </Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              <View style={{ flexDirection: "row", gap: 12 }}>
                {availableSectors.map((sector) => (
                  <TouchableOpacity
                    key={sector.id}
                    onPress={() => handleSelectSector(sector.id)}
                    style={{
                      paddingHorizontal: 20,
                      paddingVertical: 12,
                      borderRadius: 16,
                      backgroundColor:
                        selectedSectorId === sector.id
                          ? "rgba(77,163,255,0.3)"
                          : "rgba(255,255,255,0.05)",
                      borderWidth: 2,
                      borderColor:
                        selectedSectorId === sector.id
                          ? "#4DA3FF"
                          : "rgba(255,255,255,0.1)",
                    }}
                    activeOpacity={0.7}
                  >
                    <Text
                      style={{
                        fontSize: 16,
                        fontWeight: "600",
                        color: selectedSectorId === sector.id ? "#4DA3FF" : "#FFFFFF",
                      }}
                    >
                      {sector.name}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            </ScrollView>
          </TintedGlassCard>

          {/* Data e Hora de Início */}
          <TintedGlassCard>
            <Text style={{ fontSize: 18, fontWeight: "600", color: "#FFFFFF", marginBottom: 16 }}>
              Início *
            </Text>
            <View style={{ flexDirection: "row", gap: 12 }}>
              <View style={{ flex: 1 }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 8 }}>
                  <TouchableOpacity onPress={() => { Keyboard.dismiss(); setTempStartDate(startDate ? new Date(startDate) : new Date()); setShowStartDatePicker(true); }} activeOpacity={0.7}>
                    <Calendar size={18} color="rgba(255,255,255,0.6)" />
                  </TouchableOpacity>
                  <Text style={{ fontSize: 14, color: "rgba(255,255,255,0.6)" }}>
                    Data
                  </Text>
                </View>
                <TouchableOpacity
                  onPress={() => { Keyboard.dismiss(); setTempStartDate(startDate ? new Date(startDate) : new Date()); setShowStartDatePicker(true); }}
                  activeOpacity={0.7}
                  style={{
                    backgroundColor: "rgba(255,255,255,0.05)",
                    borderRadius: 12,
                    padding: 12,
                    borderWidth: 1,
                    borderColor: "rgba(255,255,255,0.1)",
                  }}
                >
                  <Text style={{ fontSize: 16, color: "#FFFFFF" }}>
                    {formatDateBR(startDate) || "DD/MM/AAAA"}
                  </Text>
                </TouchableOpacity>
                {showStartDatePicker && (
                  <DateTimePicker
                    value={startDate ? new Date(startDate) : new Date()}
                    mode="date"
                    display={Platform.OS === "ios" ? "spinner" : "default"}
                    onChange={handleStartDateChange}
                    locale="pt-BR"
                  />
                )}
              </View>
              <View style={{ flex: 1 }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 8 }}>
                  <TouchableOpacity onPress={() => setShowStartTimePicker(true)} activeOpacity={0.7}>
                    <Clock size={18} color="rgba(255,255,255,0.6)" />
                  </TouchableOpacity>
                  <Text style={{ fontSize: 14, color: "rgba(255,255,255,0.6)" }}>
                    Hora
                  </Text>
                </View>
                <TouchableOpacity
                  onPress={() => setShowStartTimePicker(true)}
                  activeOpacity={0.7}
                  style={{
                    backgroundColor: "rgba(255,255,255,0.05)",
                    borderRadius: 12,
                    padding: 12,
                    borderWidth: 1,
                    borderColor: "rgba(255,255,255,0.1)",
                  }}
                >
                  <Text style={{ fontSize: 16, color: "#FFFFFF" }}>
                    {startTime || "HH:MM"}
                  </Text>
                </TouchableOpacity>
                {showStartTimePicker && (
                  <DateTimePicker
                    value={startTime ? new Date(`2000-01-01T${startTime}`) : new Date()}
                    mode="time"
                    display={Platform.OS === "ios" ? "spinner" : "default"}
                    onChange={handleStartTimeChange}
                    locale="pt-BR"
                    is24Hour
                  />
                )}
              </View>
            </View>
          </TintedGlassCard>

          {/* Data e Hora de Término */}
          <TintedGlassCard>
            <Text style={{ fontSize: 18, fontWeight: "600", color: "#FFFFFF", marginBottom: 16 }}>
              Término *
            </Text>
            <View style={{ flexDirection: "row", gap: 12 }}>
              <View style={{ flex: 1 }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 8 }}>
                  <TouchableOpacity onPress={() => { Keyboard.dismiss(); setTempEndDate(endDate ? new Date(endDate) : new Date()); setShowEndDatePicker(true); }} activeOpacity={0.7}>
                    <Calendar size={18} color="rgba(255,255,255,0.6)" />
                  </TouchableOpacity>
                  <Text style={{ fontSize: 14, color: "rgba(255,255,255,0.6)" }}>
                    Data
                  </Text>
                </View>
                <TouchableOpacity
                  onPress={() => { Keyboard.dismiss(); setTempEndDate(endDate ? new Date(endDate) : new Date()); setShowEndDatePicker(true); }}
                  activeOpacity={0.7}
                  style={{
                    backgroundColor: "rgba(255,255,255,0.05)",
                    borderRadius: 12,
                    padding: 12,
                    borderWidth: 1,
                    borderColor: "rgba(255,255,255,0.1)",
                  }}
                >
                  <Text style={{ fontSize: 16, color: "#FFFFFF" }}>
                    {formatDateBR(endDate) || "DD/MM/AAAA"}
                  </Text>
                </TouchableOpacity>
                {showEndDatePicker && (
                  <DateTimePicker
                    value={endDate ? new Date(endDate) : new Date()}
                    mode="date"
                    display={Platform.OS === "ios" ? "spinner" : "default"}
                    onChange={handleEndDateChange}
                    locale="pt-BR"
                  />
                )}
              </View>
              <View style={{ flex: 1 }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 8 }}>
                  <TouchableOpacity onPress={() => setShowEndTimePicker(true)} activeOpacity={0.7}>
                    <Clock size={18} color="rgba(255,255,255,0.6)" />
                  </TouchableOpacity>
                  <Text style={{ fontSize: 14, color: "rgba(255,255,255,0.6)" }}>
                    Hora
                  </Text>
                </View>
                <TouchableOpacity
                  onPress={() => setShowEndTimePicker(true)}
                  activeOpacity={0.7}
                  style={{
                    backgroundColor: "rgba(255,255,255,0.05)",
                    borderRadius: 12,
                    padding: 12,
                    borderWidth: 1,
                    borderColor: "rgba(255,255,255,0.1)",
                  }}
                >
                  <Text style={{ fontSize: 16, color: "#FFFFFF" }}>
                    {endTime || "HH:MM"}
                  </Text>
                </TouchableOpacity>
                {showEndTimePicker && (
                  <DateTimePicker
                    value={endTime ? new Date(`2000-01-01T${endTime}`) : new Date()}
                    mode="time"
                    display={Platform.OS === "ios" ? "spinner" : "default"}
                    onChange={handleEndTimeChange}
                    locale="pt-BR"
                    is24Hour
                  />
                )}
              </View>
            </View>
          </TintedGlassCard>

          {/* Observações */}
          <TintedGlassCard>
            <Text style={{ fontSize: 18, fontWeight: "600", color: "#FFFFFF", marginBottom: 16 }}>
              Observações
            </Text>
            <TextInput
              value={notes}
              onChangeText={setNotes}
              placeholder="Adicione observações sobre a escala..."
              placeholderTextColor="rgba(255,255,255,0.4)"
              multiline
              numberOfLines={4}
              textAlignVertical="top"
              style={{
                backgroundColor: "rgba(255,255,255,0.05)",
                borderRadius: 12,
                padding: 12,
                fontSize: 16,
                color: "#FFFFFF",
                borderWidth: 1,
                borderColor: "rgba(255,255,255,0.1)",
                minHeight: 100,
              }}
            />
          </TintedGlassCard>

          {/* Botões de Ação */}
          <View style={{ flexDirection: "row", gap: 12 }}>
            <TouchableOpacity
              onPress={handleBack}
              style={{
                flex: 1,
                backgroundColor: "rgba(255,255,255,0.1)",
                borderRadius: 16,
                padding: 16,
                alignItems: "center",
                borderWidth: 1,
                borderColor: "rgba(255,255,255,0.2)",
              }}
              activeOpacity={0.7}
            >
              <Text style={{ fontSize: 16, fontWeight: "600", color: "#FFFFFF" }}>
                Cancelar
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={handleSave}
              style={{
                flex: 1,
                backgroundColor: "#4DA3FF",
                borderRadius: 16,
                padding: 16,
                alignItems: "center",
                flexDirection: "row",
                justifyContent: "center",
                gap: 8,
              }}
              activeOpacity={0.7}
            >
              <Save size={20} color="#FFFFFF" />
              <Text style={{ fontSize: 16, fontWeight: "600", color: "#FFFFFF" }}>
                Salvar
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      </ScrollView>
      
      {/* Modal de Seleção de Data Início (iOS) */}
      <Modal
        visible={showStartDatePicker && Platform.OS === "ios"}
        transparent
        animationType="fade"
        onRequestClose={handleCancelStartDate}
      >
        <Pressable
          style={{
            flex: 1,
            backgroundColor: "rgba(0,0,0,0.7)",
            justifyContent: "flex-end",
          }}
          onPress={handleCancelStartDate}
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
              Selecionar data de início
            </Text>
            <Text style={{ color: "rgba(255,255,255,0.6)", fontSize: 14, marginBottom: 20, textAlign: "center" }}>
              Data selecionada: {tempStartDate ? formatDateBR(toLocalISODateString(normalizeToNoon(tempStartDate))) : formatDateBR(startDate || toLocalISODateString(new Date()))}
            </Text>
            
            <DateTimePicker
              value={tempStartDate || (startDate ? new Date(startDate) : new Date())}
              mode="date"
              display="spinner"
              onChange={handleStartDateChange}
              locale="pt-BR"
              textColor="#FFFFFF"
            />
            
            <View style={{ flexDirection: "row", gap: 12, marginTop: 24 }}>
              <TouchableOpacity
                onPress={handleCancelStartDate}
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
                onPress={handleConfirmStartDate}
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
      
      {/* Modal de Seleção de Data Término (iOS) */}
      <Modal
        visible={showEndDatePicker && Platform.OS === "ios"}
        transparent
        animationType="fade"
        onRequestClose={handleCancelEndDate}
      >
        <Pressable
          style={{
            flex: 1,
            backgroundColor: "rgba(0,0,0,0.7)",
            justifyContent: "flex-end",
          }}
          onPress={handleCancelEndDate}
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
              Selecionar data de término
            </Text>
            <Text style={{ color: "rgba(255,255,255,0.6)", fontSize: 14, marginBottom: 20, textAlign: "center" }}>
              Data selecionada: {tempEndDate ? formatDateBR(toLocalISODateString(normalizeToNoon(tempEndDate))) : formatDateBR(endDate || toLocalISODateString(new Date()))}
            </Text>
            
            <DateTimePicker
              value={tempEndDate || (endDate ? new Date(endDate) : new Date())}
              mode="date"
              display="spinner"
              onChange={handleEndDateChange}
              locale="pt-BR"
              textColor="#FFFFFF"
            />
            
            <View style={{ flexDirection: "row", gap: 12, marginTop: 24 }}>
              <TouchableOpacity
                onPress={handleCancelEndDate}
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
                onPress={handleConfirmEndDate}
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

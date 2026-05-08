import { useState, useEffect } from "react";
import { Text, View, TouchableOpacity, TextInput, ActivityIndicator, Switch, ScrollView, Platform, Modal, Pressable, Keyboard, Alert } from "react-native";
import { ScreenGradient } from "@/components/ui/ScreenGradient";
import { TintedGlassCard } from "@/components/ui/TintedGlassCard";
import { theme } from "@/lib/theme";
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

// Modalidade — opções estruturadas adicionadas pelo PR #61 do backend.
type Modality = "PLANTAO" | "SOBREAVISO";
type CoverageType = "URGENCIA_EMERGENCIA" | "ELETIVAS";
type PaymentModel =
  | "FIXO"
  | "FIXO_PRODUTIVIDADE_TETO"
  | "FIXO_PRODUTIVIDADE_SEM_TETO"
  | "PRODUTIVIDADE_PURA";

const MODALITY_OPTIONS: { value: Modality; label: string }[] = [
  { value: "PLANTAO", label: "Plantão" },
  { value: "SOBREAVISO", label: "Sobreaviso" },
];

const COVERAGE_OPTIONS: { value: CoverageType; label: string }[] = [
  { value: "URGENCIA_EMERGENCIA", label: "Urgência / Emergência" },
  { value: "ELETIVAS", label: "Eletivas" },
];

const PAYMENT_MODEL_OPTIONS: { value: PaymentModel; label: string }[] = [
  { value: "FIXO", label: "Fixo" },
  { value: "FIXO_PRODUTIVIDADE_TETO", label: "Fixo + produtividade (com teto)" },
  { value: "FIXO_PRODUTIVIDADE_SEM_TETO", label: "Fixo + produtividade (sem teto)" },
  { value: "PRODUTIVIDADE_PURA", label: "Produtividade pura" },
];

const PRODUCTIVITY_CAP_REGEX = /^\d+(\.\d{1,2})?$/;

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

  // Modalidade (PR #61): defaults pareiam com os defaults do DB.
  const [modality, setModality] = useState<Modality>("PLANTAO");
  const [coverageType, setCoverageType] = useState<CoverageType | undefined>(undefined);
  const [paymentModel, setPaymentModel] = useState<PaymentModel>("FIXO");
  const [productivityCapBrl, setProductivityCapBrl] = useState("");

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

    // Validações de modalidade (light-touch — server enforça as regras duras).
    if (modality === "PLANTAO" && !coverageType) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Alert.alert("Atenção", "Selecione a cobertura do plantão.");
      return;
    }
    if (paymentModel === "FIXO_PRODUTIVIDADE_TETO" && !productivityCapBrl) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Alert.alert("Atenção", "Informe o teto de produtividade ou troque o modelo.");
      return;
    }
    if (productivityCapBrl && !PRODUCTIVITY_CAP_REGEX.test(productivityCapBrl)) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Alert.alert("Atenção", "Teto deve ser BRL no formato 1500.00 (ponto, não vírgula).");
      return;
    }

    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

    createShift.mutate({
      date: selectedDate,
      shiftTemplateId: template.id,
      sectorId: selectedSectorId,
      modality,
      coverageType: modality === "PLANTAO" ? coverageType : null,
      paymentModel,
      productivityCapBrl:
        paymentModel === "FIXO_PRODUTIVIDADE_TETO" && productivityCapBrl
          ? productivityCapBrl
          : null,
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
          <Text className="text-lg" style={{ color: theme.colors.textMuted }}>Faça login para continuar</Text>
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
            <ChevronLeft size={28} color={theme.colors.textPrimary} />
          </TouchableOpacity>
          <View className="flex-1">
            <Text className="text-3xl font-bold" style={{ color: theme.colors.textPrimary }}>Nova Escala</Text>
            <Text className="text-base mt-1" style={{ color: theme.colors.textMuted }}>Alocar profissionais no turno</Text>
          </View>
        </View>

        {/* Seleção de Setor */}
        <TintedGlassCard className="gap-4">
          <View className="flex-row items-center gap-3">
            <Calendar size={24} color={theme.colors.textPrimary} />
            <Text className="text-lg font-semibold" style={{ color: theme.colors.textPrimary }}>Setor *</Text>
          </View>

          {loadingSectors ? (
            <View className="items-center py-6">
              <ActivityIndicator size="small" color={theme.colors.primary} />
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
                        ? theme.colors.primary
                        : theme.colors.surfaceAlt,
                    borderWidth: 1,
                    borderColor:
                      selectedSectorId === sector.id
                        ? theme.colors.primary
                        : theme.colors.border,
                  }}
                  activeOpacity={0.7}
                >
                  <Text
                    className="text-base font-semibold"
                    style={{
                      color:
                        selectedSectorId === sector.id
                          ? theme.colors.surface
                          : theme.colors.textPrimary,
                    }}
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
              <Calendar size={24} color={theme.colors.textPrimary} />
            </TouchableOpacity>
            <Text className="text-lg font-semibold" style={{ color: theme.colors.textPrimary }}>Data *</Text>
          </View>

          <TouchableOpacity
            onPress={handleCalendarPress}
            activeOpacity={0.7}
            className="rounded-2xl px-4 h-12 justify-center"
            style={{
              backgroundColor: theme.colors.surfaceAlt,
              borderWidth: 1,
              borderColor: theme.colors.border,
            }}
          >
            <Text className="text-base" style={{ color: theme.colors.textPrimary }}>
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
            <Clock size={24} color={theme.colors.textPrimary} />
            <Text className="text-lg font-semibold" style={{ color: theme.colors.textPrimary }}>Turno *</Text>
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
                      ? theme.colors.primary
                      : theme.colors.surfaceAlt,
                  borderWidth: 1,
                  borderColor:
                    selectedShift === shift
                      ? theme.colors.primary
                      : theme.colors.border,
                }}
                activeOpacity={0.7}
              >
                <Text
                  className="text-base font-semibold"
                  style={{
                    color:
                      selectedShift === shift
                        ? theme.colors.surface
                        : theme.colors.textPrimary,
                  }}
                >
                  {shift}
                </Text>
                <Text
                  className="text-sm mt-1"
                  style={{
                    color:
                      selectedShift === shift
                        ? theme.colors.onDark.text
                        : theme.colors.textMuted,
                  }}
                >
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
              <Repeat size={24} color={theme.colors.textPrimary} />
              <Text className="text-lg font-semibold" style={{ color: theme.colors.textPrimary }}>Repetir Escala</Text>
            </View>
            <Switch
              value={enableRepeat}
              onValueChange={(value) => {
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                setEnableRepeat(value);
              }}
              trackColor={{ false: theme.colors.border, true: theme.colors.primary }}
              thumbColor={theme.colors.surface}
            />
          </View>

          {enableRepeat && (
            <View className="gap-4">
              <View>
                <Text className="text-sm mb-2" style={{ color: theme.colors.textMuted }}>Repetir a cada (semanas)</Text>
                <TextInput
                  value={repeatWeeks}
                  onChangeText={setRepeatWeeks}
                  placeholder="1"
                  keyboardType="number-pad"
                  placeholderTextColor={theme.colors.textMuted}
                  className="rounded-2xl px-4 h-12 text-base"
                  style={{
                    backgroundColor: theme.colors.surfaceAlt,
                    borderWidth: 1,
                    borderColor: theme.colors.border,
                  }}
                />
              </View>

              <View>
                <Text className="text-sm mb-2" style={{ color: theme.colors.textMuted }}>Data limite</Text>
                <TextInput
                  value={repeatEndDate}
                  onChangeText={setRepeatEndDate}
                  placeholder="YYYY-MM-DD"
                  placeholderTextColor={theme.colors.textMuted}
                  className="rounded-2xl px-4 h-12 text-base"
                  style={{
                    backgroundColor: theme.colors.surfaceAlt,
                    borderWidth: 1,
                    borderColor: theme.colors.border,
                  }}
                />
              </View>
            </View>
          )}
        </TintedGlassCard>

        {/* Modalidade */}
        <TintedGlassCard className="gap-4">
          <Text className="text-lg font-semibold" style={{ color: theme.colors.textPrimary }}>Modalidade</Text>

          {/* Modalidade — PLANTAO / SOBREAVISO */}
          <View className="gap-2">
            <Text className="text-sm" style={{ color: theme.colors.textMuted }}>Modalidade *</Text>
            <View className="flex-row gap-3">
              {MODALITY_OPTIONS.map((option) => {
                const isSelected = modality === option.value;
                return (
                  <TouchableOpacity
                    key={option.value}
                    onPress={() => {
                      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                      setModality(option.value);
                      // Trocar para SOBREAVISO limpa cobertura previamente escolhida.
                      if (option.value === "SOBREAVISO") {
                        setCoverageType(undefined);
                      }
                    }}
                    className="flex-1 px-5 py-3 rounded-2xl"
                    style={{
                      backgroundColor: isSelected ? theme.colors.primary : theme.colors.surfaceAlt,
                      borderWidth: 1,
                      borderColor: isSelected ? theme.colors.primary : theme.colors.border,
                    }}
                    activeOpacity={0.7}
                  >
                    <Text
                      className="text-base font-semibold text-center"
                      style={{ color: isSelected ? theme.colors.surface : theme.colors.textPrimary }}
                    >
                      {option.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>

          {/* Cobertura — apenas para PLANTAO */}
          {modality === "PLANTAO" && (
            <View className="gap-2">
              <Text className="text-sm" style={{ color: theme.colors.textMuted }}>Cobertura</Text>
              <View className="flex-row gap-3">
                {COVERAGE_OPTIONS.map((option) => {
                  const isSelected = coverageType === option.value;
                  return (
                    <TouchableOpacity
                      key={option.value}
                      onPress={() => {
                        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                        setCoverageType(option.value);
                      }}
                      className="flex-1 px-5 py-3 rounded-2xl"
                      style={{
                        backgroundColor: isSelected ? theme.colors.primary : theme.colors.surfaceAlt,
                        borderWidth: 1,
                        borderColor: isSelected ? theme.colors.primary : theme.colors.border,
                      }}
                      activeOpacity={0.7}
                    >
                      <Text
                        className="text-base font-semibold text-center"
                        style={{ color: isSelected ? theme.colors.surface : theme.colors.textPrimary }}
                      >
                        {option.label}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </View>
          )}

          {/* Modelo de pagamento — lista vertical */}
          <View className="gap-2">
            <Text className="text-sm" style={{ color: theme.colors.textMuted }}>Modelo de pagamento *</Text>
            <View className="gap-3">
              {PAYMENT_MODEL_OPTIONS.map((option) => {
                const isSelected = paymentModel === option.value;
                return (
                  <TouchableOpacity
                    key={option.value}
                    onPress={() => {
                      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                      setPaymentModel(option.value);
                      // Trocar para um modelo sem teto limpa o valor previamente digitado.
                      if (option.value !== "FIXO_PRODUTIVIDADE_TETO") {
                        setProductivityCapBrl("");
                      }
                    }}
                    className="px-5 py-4 rounded-2xl"
                    style={{
                      backgroundColor: isSelected ? theme.colors.primary : theme.colors.surfaceAlt,
                      borderWidth: 1,
                      borderColor: isSelected ? theme.colors.primary : theme.colors.border,
                    }}
                    activeOpacity={0.7}
                  >
                    <Text
                      className="text-base font-semibold"
                      style={{ color: isSelected ? theme.colors.surface : theme.colors.textPrimary }}
                    >
                      {option.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>

          {/* Teto da produtividade — apenas para FIXO_PRODUTIVIDADE_TETO */}
          {paymentModel === "FIXO_PRODUTIVIDADE_TETO" && (
            <View className="gap-2">
              <Text className="text-sm" style={{ color: theme.colors.textMuted }}>Teto da produtividade (BRL)</Text>
              <TextInput
                value={productivityCapBrl}
                onChangeText={setProductivityCapBrl}
                placeholder="Ex: 1500.00"
                placeholderTextColor={theme.colors.textMuted}
                keyboardType="decimal-pad"
                className="rounded-2xl px-4 h-12 text-base"
                style={{
                  backgroundColor: theme.colors.surfaceAlt,
                  borderWidth: 1,
                  borderColor: theme.colors.border,
                  color: theme.colors.textPrimary,
                }}
              />
            </View>
          )}
        </TintedGlassCard>

        {/* Observações */}
        <TintedGlassCard className="gap-4">
          <Text className="text-lg font-semibold" style={{ color: theme.colors.textPrimary }}>Observações</Text>
          <TextInput
            value={notes}
            onChangeText={setNotes}
            placeholder="Informações adicionais..."
            placeholderTextColor={theme.colors.textMuted}
            multiline
            numberOfLines={4}
            textAlignVertical="top"
            className="rounded-2xl px-4 py-3 text-base"
            style={{
              backgroundColor: theme.colors.surfaceAlt,
              borderWidth: 1,
              borderColor: theme.colors.border,
              minHeight: 100,
              color: theme.colors.textPrimary,
            }}
          />
        </TintedGlassCard>

        {/* Botão Criar */}
        <TouchableOpacity
          onPress={handleCreateShift}
          disabled={createShift.isPending}
          className="rounded-2xl h-14 items-center justify-center" style={{ backgroundColor: theme.colors.primary }}
          activeOpacity={0.7}
        >
          {createShift.isPending ? (
            <ActivityIndicator size="small" color={theme.colors.surface} />
          ) : (
            <Text className="text-lg font-semibold" style={{ color: theme.colors.surface }}>Criar Escala</Text>
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
            backgroundColor: theme.colors.overlay,
            justifyContent: "flex-end",
          }}
          onPress={handleCancelDate}
        >
          <Pressable
            style={{
              backgroundColor: theme.palette.neutral[900],
              borderTopLeftRadius: 24,
              borderTopRightRadius: 24,
              padding: 24,
              paddingBottom: 40,
            }}
            onPress={(e) => e.stopPropagation()}
          >
            <Text style={{ color: theme.colors.surface, fontSize: 18, fontWeight: "700", marginBottom: 8, textAlign: "center" }}>
              Selecionar data
            </Text>
            <Text style={{ color: theme.colors.onDark.textMuted, fontSize: 14, marginBottom: 20, textAlign: "center" }}>
              Data selecionada: {tempDate ? formatDateBR(toLocalISODateString(normalizeToNoon(tempDate))) : formatDateBR(selectedDate || today)}
            </Text>
            
            <DateTimePicker
              value={tempDate || (selectedDate ? new Date(selectedDate) : new Date())}
              mode="date"
              display="spinner"
              onChange={handleDateChange}
              locale="pt-BR"
              minimumDate={new Date()}
              textColor={theme.colors.surface}
            />
            
            <View style={{ flexDirection: "row", gap: 12, marginTop: 24 }}>
              <TouchableOpacity
                onPress={handleCancelDate}
                style={{
                  flex: 1,
                  backgroundColor: theme.colors.onDark.surface,
                  borderRadius: 12,
                  padding: 16,
                  alignItems: "center",
                }}
                activeOpacity={0.7}
              >
                <Text style={{ color: theme.colors.surface, fontSize: 16, fontWeight: "600" }}>Cancelar</Text>
              </TouchableOpacity>
              
              <TouchableOpacity
                onPress={handleConfirmDate}
                style={{
                  flex: 1,
                  backgroundColor: theme.colors.primary,
                  borderRadius: 12,
                  padding: 16,
                  alignItems: "center",
                }}
                activeOpacity={0.7}
              >
                <Text style={{ color: theme.colors.surface, fontSize: 16, fontWeight: "600" }}>Confirmar</Text>
              </TouchableOpacity>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </ScreenGradient>
  );
}

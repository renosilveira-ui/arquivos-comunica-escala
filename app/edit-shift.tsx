import { useState, useEffect, useRef } from "react";
import {
  ScrollView,
  Text,
  View,
  TouchableOpacity,
  TextInput,
  ActivityIndicator,
  Platform,
  Modal,
  Pressable,
  Keyboard,
} from "react-native";
import { ScreenGradient } from "@/components/ui/ScreenGradient";
import { TintedGlassCard } from "@/components/ui/TintedGlassCard";
import { theme } from "@/lib/theme";
import { MAX_SHIFT_CAPACITY } from "@/lib/shift-capacity";
import { useAuth } from "@/hooks/use-auth";
import { usePermissions } from "@/hooks/use-permissions";
import { useScreenActionLease } from "@/hooks/use-screen-action-lease";
import { trpc } from "@/lib/trpc";
import { useTenantState } from "@/lib/tenant-state";
import type { ScreenActionLease } from "@/lib/screen-action-lease";
import { useRouter, useLocalSearchParams } from "expo-router";
import * as Haptics from "expo-haptics";
import { uiAlert } from "@/lib/ui/alert";
import { ChevronLeft, Save, Calendar, Clock } from "lucide-react-native";
import DateTimePicker from "@react-native-community/datetimepicker";
import { formatTimeBR } from "@/lib/datetime";
import {
  formatLocalISODateBR,
  fromLocalISODateString,
  normalizeToNoon,
  toLocalISODateString,
} from "@/lib/datetime-utils";
import {
  canLoadEditShift,
  resolveEditShiftPermissionState,
} from "@/lib/permission-screen-state";
import { PublishedMonthReasonField } from "@/components/shifts/PublishedMonthReasonField";
import {
  requiresPublishedMonthReason,
  usePublishedMonthRoster,
  validatePublishedMonthReason,
} from "@/hooks/use-published-month-roster";
import { invalidateOfficialScaleAndVacancyQueries } from "@/lib/official-scale-vacancy-query-refresh";

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
  {
    value: "FIXO_PRODUTIVIDADE_TETO",
    label: "Fixo + produtividade (com teto)",
  },
  {
    value: "FIXO_PRODUTIVIDADE_SEM_TETO",
    label: "Fixo + produtividade (sem teto)",
  },
  { value: "PRODUTIVIDADE_PURA", label: "Produtividade pura" },
];

const PRODUCTIVITY_CAP_REGEX = /^\d+(\.\d{1,2})?$/;

/**
 * Tela de Edição de Escala
 * Permite alterar dados de uma escala existente
 * Suporte a modo demo
 */
export default function EditShiftScreen() {
  const { user, isLoading: authLoading } = useAuth();
  const { can, isLoading: permissionsLoading } = usePermissions();
  const { activeInstitutionId } = useTenantState();
  const router = useRouter();
  const params = useLocalSearchParams();
  const shiftId = Number(params.id);

  // Guard: somente admin/manager podem editar escalas. `can` muda de
  // identidade a cada render; o efeito depende do RESULTADO, não da função.
  const canEditShift = can("edit:shift");
  const permissionState = resolveEditShiftPermissionState({
    authLoading,
    hasUser: user !== null && user !== undefined,
    permissionsLoading,
    canEditShift,
  });
  useEffect(() => {
    if (permissionState === "DENIED") router.back();
  }, [permissionState, router]);

  // Estados do formulário
  const [startDate, setStartDate] = useState("");
  const [startTime, setStartTime] = useState("");
  const [endDate, setEndDate] = useState("");
  const [endTime, setEndTime] = useState("");
  const [requiredCapacity, setRequiredCapacity] = useState("");
  const [editReason, setEditReason] = useState("");

  // Modalidade (PR #61): defaults pareiam com os defaults do DB.
  const [modality, setModality] = useState<Modality>("PLANTAO");
  const [coverageType, setCoverageType] = useState<CoverageType | undefined>(
    undefined,
  );
  const [paymentModel, setPaymentModel] = useState<PaymentModel>("FIXO");
  const [productivityCapBrl, setProductivityCapBrl] = useState("");

  // Estados do DateTimePicker
  const [showStartDatePicker, setShowStartDatePicker] = useState(false);
  const [showStartTimePicker, setShowStartTimePicker] = useState(false);
  const [showEndDatePicker, setShowEndDatePicker] = useState(false);
  const [showEndTimePicker, setShowEndTimePicker] = useState(false);

  // Estados temporários para preview (iOS)
  const [tempStartDate, setTempStartDate] = useState<Date | null>(null);
  const [tempEndDate, setTempEndDate] = useState<Date | null>(null);

  // Buscar detalhes da escala
  const { data: shiftData, isLoading: loadingShift } = trpc.shifts.get.useQuery(
    { id: shiftId },
    { enabled: canLoadEditShift(permissionState, !!shiftId) },
  );
  const { data: monthRoster, hasShifts: monthHasShifts } =
    usePublishedMonthRoster(shiftData?.hospitalId, startDate || undefined);
  const utils = trpc.useUtils();
  const actionLease = useScreenActionLease({
    userId: user?.id,
    contextKey:
      activeInstitutionId != null && shiftData != null
        ? `${activeInstitutionId}:${shiftData.hospitalId}:${shiftData.sectorId}:${shiftId}`
        : null,
  });
  const updateLeaseRef = useRef<ScreenActionLease | null>(null);

  // Mutation para atualizar escala. O retorno só pode atuar na mesma conta,
  // instituição, topologia e tela que iniciaram o envio.
  const updateShift = trpc.shifts.update.useMutation();

  useEffect(() => {
    setEditReason("");
  }, [shiftId, startDate, shiftData?.hospitalId]);

  // Carregar dados da escala no formulário
  useEffect(() => {
    if (shiftData) {
      setRequiredCapacity(
        shiftData.requiredCapacity == null
          ? ""
          : String(shiftData.requiredCapacity),
      );
      const start = new Date(shiftData.startAt);
      const end = new Date(shiftData.endAt);
      setStartDate(toLocalISODateString(start));
      setStartTime(formatTimeBR(start));
      setEndDate(toLocalISODateString(end));
      setEndTime(formatTimeBR(end));

      // Hidratar modalidade vinda do backend (PR #61).
      const data = shiftData as typeof shiftData & {
        modality?: Modality | null;
        coverageType?: CoverageType | null;
        paymentModel?: PaymentModel | null;
        productivityCapBrl?: string | null;
      };
      if (data.modality) setModality(data.modality);
      setCoverageType(data.coverageType ?? undefined);
      if (data.paymentModel) setPaymentModel(data.paymentModel);
      setProductivityCapBrl(data.productivityCapBrl ?? "");
    }
  }, [shiftData]);

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

  const handleSave = () => {
    if (
      updateShift.isPending ||
      actionLease.isCurrent(updateLeaseRef.current)
    ) {
      return;
    }
    if (!startDate || !startTime || !endDate || !endTime) {
      uiAlert("Erro", "Preencha todos os campos obrigatórios");
      return;
    }

    // Converter strings para Date
    const [startHour, startMinute] = startTime.split(":");
    const [endHour, endMinute] = endTime.split(":");

    // "AAAA-MM-DD" em `new Date()` é meia-noite UTC (21h do dia anterior no
    // Brasil): o setHours caía no dia errado e cada salvamento recuava o
    // plantão um dia. fromLocalISODateString ancora no meio-dia LOCAL.
    const startDateTime = fromLocalISODateString(startDate);
    startDateTime.setHours(Number(startHour), Number(startMinute), 0, 0);

    const endDateTime = fromLocalISODateString(endDate);
    endDateTime.setHours(Number(endHour), Number(endMinute), 0, 0);

    // Validar datas
    if (endDateTime <= startDateTime) {
      uiAlert("Erro", "A data/hora de término deve ser posterior à de início");
      return;
    }

    // Validações de modalidade (light-touch — server enforça as regras duras).
    if (modality === "PLANTAO" && !coverageType) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      uiAlert("Atenção", "Selecione a cobertura do plantão.");
      return;
    }
    if (paymentModel === "FIXO_PRODUTIVIDADE_TETO" && !productivityCapBrl) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      uiAlert("Atenção", "Informe o teto de produtividade ou troque o modelo.");
      return;
    }
    if (
      productivityCapBrl &&
      !PRODUCTIVITY_CAP_REGEX.test(productivityCapBrl)
    ) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      uiAlert(
        "Atenção",
        "Teto deve ser BRL no formato 1500.00 (ponto, não vírgula).",
      );
      return;
    }

    const reasonError = validatePublishedMonthReason(
      monthRoster?.status,
      editReason,
      monthHasShifts,
    );
    if (reasonError) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      uiAlert("Atenção", reasonError);
      return;
    }

    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    const trimmedReason = editReason.trim();
    if (
      requiredCapacity !== "" &&
      (!Number.isSafeInteger(Number(requiredCapacity)) ||
        Number(requiredCapacity) < 1 ||
        Number(requiredCapacity) > MAX_SHIFT_CAPACITY)
    ) {
      uiAlert("Atenção", `Informe de 1 a ${MAX_SHIFT_CAPACITY} profissionais.`);
      return;
    }
    const lease = actionLease.capture();
    if (!lease) {
      uiAlert(
        "Atenção",
        "Sua sessão mudou antes do envio. Confira a instituição ativa e tente novamente.",
      );
      return;
    }
    updateLeaseRef.current = lease;
    updateShift.mutate(
      {
        id: shiftId,
        ...(requiredCapacity !== ""
          ? { requiredCapacity: Number(requiredCapacity) }
          : {}),
        startAt: startDateTime.toISOString(),
        endAt: endDateTime.toISOString(),
        modality,
        coverageType: modality === "PLANTAO" ? coverageType : null,
        paymentModel,
        productivityCapBrl:
          paymentModel === "FIXO_PRODUTIVIDADE_TETO" && productivityCapBrl
            ? productivityCapBrl
            : null,
        ...(trimmedReason ? { reason: trimmedReason } : {}),
      },
      {
        onSuccess: async () => {
          if (
            updateLeaseRef.current !== lease ||
            !actionLease.isCurrent(lease)
          ) {
            return;
          }
          void Haptics.notificationAsync(
            Haptics.NotificationFeedbackType.Success,
          );
          await Promise.allSettled([
            utils.shifts.get.invalidate({ id: shiftId }),
            invalidateOfficialScaleAndVacancyQueries(utils),
          ]);
          if (
            updateLeaseRef.current !== lease ||
            !actionLease.isCurrent(lease)
          ) {
            return;
          }
          updateLeaseRef.current = null;
          router.back();
        },
        onError: (error) => {
          if (
            updateLeaseRef.current !== lease ||
            !actionLease.isCurrent(lease)
          ) {
            return;
          }
          updateLeaseRef.current = null;
          void Haptics.notificationAsync(
            Haptics.NotificationFeedbackType.Error,
          );
          uiAlert("Erro", error.message || "Erro ao atualizar escala");
        },
      },
    );
  };

  if (permissionState === "LOADING") {
    return (
      <ScreenGradient>
        <View
          style={{
            flex: 1,
            justifyContent: "center",
            alignItems: "center",
            paddingHorizontal: 24,
          }}
        >
          <ActivityIndicator size="large" color={theme.colors.primary} />
          <Text
            style={{
              fontSize: 16,
              color: theme.colors.textMuted,
              marginTop: 16,
            }}
          >
            Carregando...
          </Text>
        </View>
      </ScreenGradient>
    );
  }

  if (permissionState === "UNAUTHENTICATED") {
    return (
      <ScreenGradient>
        <View
          style={{
            flex: 1,
            justifyContent: "center",
            alignItems: "center",
            paddingHorizontal: 24,
          }}
        >
          <Text style={{ fontSize: 18, color: theme.colors.textMuted }}>
            Faça login para continuar
          </Text>
        </View>
      </ScreenGradient>
    );
  }

  if (loadingShift) {
    return (
      <ScreenGradient>
        <View
          style={{
            flex: 1,
            justifyContent: "center",
            alignItems: "center",
            paddingHorizontal: 24,
          }}
        >
          <ActivityIndicator size="large" color={theme.colors.primary} />
          <Text
            style={{
              fontSize: 16,
              color: theme.colors.textMuted,
              marginTop: 16,
            }}
          >
            Carregando...
          </Text>
        </View>
      </ScreenGradient>
    );
  }

  if (permissionState === "DENIED") {
    return (
      <ScreenGradient>
        <View
          style={{
            flex: 1,
            justifyContent: "center",
            alignItems: "center",
            paddingHorizontal: 24,
          }}
        >
          <Text style={{ fontSize: 16, color: theme.colors.textMuted }}>
            Acesso não autorizado
          </Text>
        </View>
      </ScreenGradient>
    );
  }

  return (
    <ScreenGradient>
      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: 20,
          paddingTop: 20,
          paddingBottom: 100,
        }}
      >
        <View style={{ gap: 24 }}>
          {/* Header */}
          <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
            <TouchableOpacity onPress={handleBack} activeOpacity={0.7}>
              <ChevronLeft size={28} color={theme.colors.textPrimary} />
            </TouchableOpacity>
            <Text
              style={{
                fontSize: 28,
                fontWeight: "700",
                color: theme.colors.textPrimary,
                flex: 1,
              }}
            >
              Editar Escala
            </Text>
          </View>

          {/* Contexto canônico. Mover um turno de contexto exige recriação
              explícita para não transportar alocações entre escalas. */}
          <TintedGlassCard variant="light">
            <Text
              style={{
                fontSize: 18,
                fontWeight: "600",
                color: theme.colors.textPrimary,
                marginBottom: 16,
              }}
            >
              Escala
            </Text>
            <Text
              style={{
                fontSize: 16,
                fontWeight: "700",
                color: theme.colors.textPrimary,
              }}
            >
              {shiftData?.sectorName ?? "Setor não identificado"}
            </Text>
            <Text
              style={{
                fontSize: 14,
                color: theme.colors.textMuted,
                marginTop: 4,
              }}
            >
              {shiftData?.hospitalName ?? "Hospital não identificado"}
              {shiftData?.specialty ? ` · ${shiftData.specialty}` : ""}
            </Text>
            <Text
              style={{
                fontSize: 13,
                color: theme.colors.textMuted,
                marginTop: 10,
              }}
            >
              Para mudar hospital ou setor, crie o turno na escala correta. A
              referência clínica é informativa e não altera o acesso.
            </Text>
          </TintedGlassCard>

          {/* Data e Hora de Início */}
          <TintedGlassCard variant="light">
            <Text
              style={{
                fontSize: 18,
                fontWeight: "600",
                color: theme.colors.textPrimary,
                marginBottom: 16,
              }}
            >
              Início *
            </Text>
            <View style={{ flexDirection: "row", gap: 12 }}>
              <View style={{ flex: 1 }}>
                <View
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 8,
                    marginBottom: 8,
                  }}
                >
                  <TouchableOpacity
                    onPress={() => {
                      Keyboard.dismiss();
                      setTempStartDate(
                        startDate
                          ? fromLocalISODateString(startDate)
                          : new Date(),
                      );
                      setShowStartDatePicker(true);
                    }}
                    activeOpacity={0.7}
                  >
                    <Calendar size={18} color={theme.colors.textMuted} />
                  </TouchableOpacity>
                  <Text style={{ fontSize: 14, color: theme.colors.textMuted }}>
                    Data
                  </Text>
                </View>
                <TouchableOpacity
                  onPress={() => {
                    Keyboard.dismiss();
                    setTempStartDate(
                      startDate
                        ? fromLocalISODateString(startDate)
                        : new Date(),
                    );
                    setShowStartDatePicker(true);
                  }}
                  activeOpacity={0.7}
                  style={{
                    backgroundColor: theme.colors.surfaceAlt,
                    borderRadius: 12,
                    padding: 12,
                    borderWidth: 1,
                    borderColor: theme.colors.border,
                  }}
                >
                  <Text
                    style={{ fontSize: 16, color: theme.colors.textPrimary }}
                  >
                    {formatLocalISODateBR(startDate) || "DD/MM/AAAA"}
                  </Text>
                </TouchableOpacity>
                {showStartDatePicker && (
                  <DateTimePicker
                    value={
                      startDate ? fromLocalISODateString(startDate) : new Date()
                    }
                    mode="date"
                    display={Platform.OS === "ios" ? "spinner" : "default"}
                    onChange={handleStartDateChange}
                    locale="pt-BR"
                  />
                )}
              </View>
              <View style={{ flex: 1 }}>
                <View
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 8,
                    marginBottom: 8,
                  }}
                >
                  <TouchableOpacity
                    onPress={() => setShowStartTimePicker(true)}
                    activeOpacity={0.7}
                  >
                    <Clock size={18} color={theme.colors.textMuted} />
                  </TouchableOpacity>
                  <Text style={{ fontSize: 14, color: theme.colors.textMuted }}>
                    Hora
                  </Text>
                </View>
                <TouchableOpacity
                  onPress={() => setShowStartTimePicker(true)}
                  activeOpacity={0.7}
                  style={{
                    backgroundColor: theme.colors.surfaceAlt,
                    borderRadius: 12,
                    padding: 12,
                    borderWidth: 1,
                    borderColor: theme.colors.border,
                  }}
                >
                  <Text
                    style={{ fontSize: 16, color: theme.colors.textPrimary }}
                  >
                    {startTime || "HH:MM"}
                  </Text>
                </TouchableOpacity>
                {showStartTimePicker && (
                  <DateTimePicker
                    value={
                      startTime
                        ? new Date(`2000-01-01T${startTime}`)
                        : new Date()
                    }
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
          <TintedGlassCard variant="light">
            <Text
              style={{
                fontSize: 18,
                fontWeight: "600",
                color: theme.colors.textPrimary,
                marginBottom: 16,
              }}
            >
              Término *
            </Text>
            <View style={{ flexDirection: "row", gap: 12 }}>
              <View style={{ flex: 1 }}>
                <View
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 8,
                    marginBottom: 8,
                  }}
                >
                  <TouchableOpacity
                    onPress={() => {
                      Keyboard.dismiss();
                      setTempEndDate(
                        endDate ? fromLocalISODateString(endDate) : new Date(),
                      );
                      setShowEndDatePicker(true);
                    }}
                    activeOpacity={0.7}
                  >
                    <Calendar size={18} color={theme.colors.textMuted} />
                  </TouchableOpacity>
                  <Text style={{ fontSize: 14, color: theme.colors.textMuted }}>
                    Data
                  </Text>
                </View>
                <TouchableOpacity
                  onPress={() => {
                    Keyboard.dismiss();
                    setTempEndDate(
                      endDate ? fromLocalISODateString(endDate) : new Date(),
                    );
                    setShowEndDatePicker(true);
                  }}
                  activeOpacity={0.7}
                  style={{
                    backgroundColor: theme.colors.surfaceAlt,
                    borderRadius: 12,
                    padding: 12,
                    borderWidth: 1,
                    borderColor: theme.colors.border,
                  }}
                >
                  <Text
                    style={{ fontSize: 16, color: theme.colors.textPrimary }}
                  >
                    {formatLocalISODateBR(endDate) || "DD/MM/AAAA"}
                  </Text>
                </TouchableOpacity>
                {showEndDatePicker && (
                  <DateTimePicker
                    value={
                      endDate ? fromLocalISODateString(endDate) : new Date()
                    }
                    mode="date"
                    display={Platform.OS === "ios" ? "spinner" : "default"}
                    onChange={handleEndDateChange}
                    locale="pt-BR"
                  />
                )}
              </View>
              <View style={{ flex: 1 }}>
                <View
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 8,
                    marginBottom: 8,
                  }}
                >
                  <TouchableOpacity
                    onPress={() => setShowEndTimePicker(true)}
                    activeOpacity={0.7}
                  >
                    <Clock size={18} color={theme.colors.textMuted} />
                  </TouchableOpacity>
                  <Text style={{ fontSize: 14, color: theme.colors.textMuted }}>
                    Hora
                  </Text>
                </View>
                <TouchableOpacity
                  onPress={() => setShowEndTimePicker(true)}
                  activeOpacity={0.7}
                  style={{
                    backgroundColor: theme.colors.surfaceAlt,
                    borderRadius: 12,
                    padding: 12,
                    borderWidth: 1,
                    borderColor: theme.colors.border,
                  }}
                >
                  <Text
                    style={{ fontSize: 16, color: theme.colors.textPrimary }}
                  >
                    {endTime || "HH:MM"}
                  </Text>
                </TouchableOpacity>
                {showEndTimePicker && (
                  <DateTimePicker
                    value={
                      endTime ? new Date(`2000-01-01T${endTime}`) : new Date()
                    }
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

          <TintedGlassCard variant="light" style={{ padding: 20, gap: 12 }}>
            <Text
              style={{ color: theme.colors.textPrimary, fontWeight: "600" }}
            >
              Profissionais necessários
            </Text>
            <TextInput
              accessibilityLabel="Capacidade do turno"
              keyboardType="number-pad"
              value={requiredCapacity}
              onChangeText={setRequiredCapacity}
              placeholder="Manter configuração histórica"
              style={{
                padding: 12,
                borderWidth: 1,
                borderColor: theme.colors.border,
                color: theme.colors.textPrimary,
                borderRadius: 8,
              }}
            />
            <Text style={{ color: theme.colors.textSecondary }}>
              A capacidade não pode ser menor que o número de alocações ativas,
              incluindo candidaturas pendentes.
            </Text>
          </TintedGlassCard>

          {/* Modalidade */}
          <TintedGlassCard variant="light">
            <Text
              style={{
                fontSize: 18,
                fontWeight: "600",
                color: theme.colors.textPrimary,
                marginBottom: 16,
              }}
            >
              Modalidade
            </Text>

            {/* Modalidade — PLANTAO / SOBREAVISO */}
            <View style={{ gap: 8, marginBottom: 16 }}>
              <Text style={{ fontSize: 14, color: theme.colors.textMuted }}>
                Modalidade *
              </Text>
              <View style={{ flexDirection: "row", gap: 12 }}>
                {MODALITY_OPTIONS.map((option) => {
                  const isSelected = modality === option.value;
                  return (
                    <TouchableOpacity
                      key={option.value}
                      onPress={() => {
                        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                        setModality(option.value);
                        if (option.value === "SOBREAVISO") {
                          setCoverageType(undefined);
                        }
                      }}
                      style={{
                        flex: 1,
                        paddingHorizontal: 20,
                        paddingVertical: 12,
                        borderRadius: 16,
                        backgroundColor: isSelected
                          ? theme.colors.primary
                          : theme.colors.surfaceAlt,
                        borderWidth: 1,
                        borderColor: isSelected
                          ? theme.colors.primary
                          : theme.colors.border,
                      }}
                      activeOpacity={0.7}
                    >
                      <Text
                        style={{
                          fontSize: 16,
                          fontWeight: "600",
                          textAlign: "center",
                          color: isSelected
                            ? theme.colors.surface
                            : theme.colors.textPrimary,
                        }}
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
              <View style={{ gap: 8, marginBottom: 16 }}>
                <Text style={{ fontSize: 14, color: theme.colors.textMuted }}>
                  Cobertura
                </Text>
                <View style={{ flexDirection: "row", gap: 12 }}>
                  {COVERAGE_OPTIONS.map((option) => {
                    const isSelected = coverageType === option.value;
                    return (
                      <TouchableOpacity
                        key={option.value}
                        onPress={() => {
                          Haptics.impactAsync(
                            Haptics.ImpactFeedbackStyle.Light,
                          );
                          setCoverageType(option.value);
                        }}
                        style={{
                          flex: 1,
                          paddingHorizontal: 20,
                          paddingVertical: 12,
                          borderRadius: 16,
                          backgroundColor: isSelected
                            ? theme.colors.primary
                            : theme.colors.surfaceAlt,
                          borderWidth: 1,
                          borderColor: isSelected
                            ? theme.colors.primary
                            : theme.colors.border,
                        }}
                        activeOpacity={0.7}
                      >
                        <Text
                          style={{
                            fontSize: 16,
                            fontWeight: "600",
                            textAlign: "center",
                            color: isSelected
                              ? theme.colors.surface
                              : theme.colors.textPrimary,
                          }}
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
            <View style={{ gap: 8, marginBottom: 16 }}>
              <Text style={{ fontSize: 14, color: theme.colors.textMuted }}>
                Modelo de pagamento *
              </Text>
              <View style={{ gap: 12 }}>
                {PAYMENT_MODEL_OPTIONS.map((option) => {
                  const isSelected = paymentModel === option.value;
                  return (
                    <TouchableOpacity
                      key={option.value}
                      onPress={() => {
                        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                        setPaymentModel(option.value);
                        if (option.value !== "FIXO_PRODUTIVIDADE_TETO") {
                          setProductivityCapBrl("");
                        }
                      }}
                      style={{
                        paddingHorizontal: 20,
                        paddingVertical: 16,
                        borderRadius: 16,
                        backgroundColor: isSelected
                          ? theme.colors.primary
                          : theme.colors.surfaceAlt,
                        borderWidth: 1,
                        borderColor: isSelected
                          ? theme.colors.primary
                          : theme.colors.border,
                      }}
                      activeOpacity={0.7}
                    >
                      <Text
                        style={{
                          fontSize: 16,
                          fontWeight: "600",
                          color: isSelected
                            ? theme.colors.surface
                            : theme.colors.textPrimary,
                        }}
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
              <View style={{ gap: 8 }}>
                <Text style={{ fontSize: 14, color: theme.colors.textMuted }}>
                  Teto da produtividade (BRL)
                </Text>
                <TextInput
                  value={productivityCapBrl}
                  onChangeText={setProductivityCapBrl}
                  placeholder="Ex: 1500.00"
                  placeholderTextColor={theme.colors.textMuted}
                  keyboardType="decimal-pad"
                  style={{
                    backgroundColor: theme.colors.surfaceAlt,
                    borderRadius: 12,
                    padding: 12,
                    fontSize: 16,
                    color: theme.colors.textPrimary,
                    borderWidth: 1,
                    borderColor: theme.colors.border,
                  }}
                />
              </View>
            )}
          </TintedGlassCard>

          <TintedGlassCard variant="light">
            <Text
              style={{
                fontSize: 18,
                fontWeight: "600",
                color: theme.colors.textPrimary,
                marginBottom: 16,
              }}
            >
              Sobre esta edição
            </Text>
            <Text
              style={{
                fontSize: 14,
                lineHeight: 20,
                color: theme.colors.textSecondary,
              }}
            >
              Esta tela altera apenas os campos salvos pela escala oficial.
              Observações não ficam editáveis até que o sistema possa
              persistir esse conteúdo com segurança.
            </Text>
          </TintedGlassCard>

          {requiresPublishedMonthReason(monthRoster?.status, monthHasShifts) ? (
            <TintedGlassCard variant="light">
              <Text
                style={{
                  fontSize: 18,
                  fontWeight: "600",
                  color: theme.colors.textPrimary,
                  marginBottom: 16,
                }}
              >
                Escala publicada
              </Text>
              <PublishedMonthReasonField
                value={editReason}
                onChangeText={setEditReason}
                rosterStatus={monthRoster?.status}
                hasShifts={monthHasShifts}
              />
            </TintedGlassCard>
          ) : null}

          {/* Botões de Ação */}
          <View style={{ flexDirection: "row", gap: 12 }}>
            <TouchableOpacity
              onPress={handleBack}
              style={{
                flex: 1,
                backgroundColor: theme.colors.surfaceAlt,
                borderRadius: 16,
                padding: 16,
                alignItems: "center",
                borderWidth: 1,
                borderColor: theme.colors.border,
              }}
              activeOpacity={0.7}
            >
              <Text
                style={{
                  fontSize: 16,
                  fontWeight: "600",
                  color: theme.colors.textPrimary,
                }}
              >
                Cancelar
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={handleSave}
              style={{
                flex: 1,
                backgroundColor: theme.colors.primary,
                borderRadius: 16,
                padding: 16,
                alignItems: "center",
                flexDirection: "row",
                justifyContent: "center",
                gap: 8,
              }}
              activeOpacity={0.7}
            >
              <Save size={20} color={theme.colors.surface} />
              <Text
                style={{
                  fontSize: 16,
                  fontWeight: "600",
                  color: theme.colors.surface,
                }}
              >
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
            backgroundColor: theme.colors.overlay,
            justifyContent: "flex-end",
          }}
          onPress={handleCancelStartDate}
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
            <Text
              style={{
                color: theme.colors.surface,
                fontSize: 18,
                fontWeight: "700",
                marginBottom: 8,
                textAlign: "center",
              }}
            >
              Selecionar data de início
            </Text>
            <Text
              style={{
                color: theme.colors.onDark.textMuted,
                fontSize: 14,
                marginBottom: 20,
                textAlign: "center",
              }}
            >
              Data selecionada:{" "}
              {tempStartDate
                ? formatLocalISODateBR(
                    toLocalISODateString(normalizeToNoon(tempStartDate)),
                  )
                : formatLocalISODateBR(
                    startDate || toLocalISODateString(new Date()),
                  )}
            </Text>

            <DateTimePicker
              value={
                tempStartDate ||
                (startDate ? fromLocalISODateString(startDate) : new Date())
              }
              mode="date"
              display="spinner"
              onChange={handleStartDateChange}
              locale="pt-BR"
              textColor={theme.colors.surface}
            />

            <View style={{ flexDirection: "row", gap: 12, marginTop: 24 }}>
              <TouchableOpacity
                onPress={handleCancelStartDate}
                style={{
                  flex: 1,
                  backgroundColor: theme.colors.onDark.surface,
                  borderRadius: 12,
                  padding: 16,
                  alignItems: "center",
                }}
                activeOpacity={0.7}
              >
                <Text
                  style={{
                    color: theme.colors.surface,
                    fontSize: 16,
                    fontWeight: "600",
                  }}
                >
                  Cancelar
                </Text>
              </TouchableOpacity>

              <TouchableOpacity
                onPress={handleConfirmStartDate}
                style={{
                  flex: 1,
                  backgroundColor: theme.colors.primary,
                  borderRadius: 12,
                  padding: 16,
                  alignItems: "center",
                }}
                activeOpacity={0.7}
              >
                <Text
                  style={{
                    color: theme.colors.surface,
                    fontSize: 16,
                    fontWeight: "600",
                  }}
                >
                  Confirmar
                </Text>
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
            backgroundColor: theme.colors.overlay,
            justifyContent: "flex-end",
          }}
          onPress={handleCancelEndDate}
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
            <Text
              style={{
                color: theme.colors.surface,
                fontSize: 18,
                fontWeight: "700",
                marginBottom: 8,
                textAlign: "center",
              }}
            >
              Selecionar data de término
            </Text>
            <Text
              style={{
                color: theme.colors.onDark.textMuted,
                fontSize: 14,
                marginBottom: 20,
                textAlign: "center",
              }}
            >
              Data selecionada:{" "}
              {tempEndDate
                ? formatLocalISODateBR(
                    toLocalISODateString(normalizeToNoon(tempEndDate)),
                  )
                : formatLocalISODateBR(
                    endDate || toLocalISODateString(new Date()),
                  )}
            </Text>

            <DateTimePicker
              value={
                tempEndDate ||
                (endDate ? fromLocalISODateString(endDate) : new Date())
              }
              mode="date"
              display="spinner"
              onChange={handleEndDateChange}
              locale="pt-BR"
              textColor={theme.colors.surface}
            />

            <View style={{ flexDirection: "row", gap: 12, marginTop: 24 }}>
              <TouchableOpacity
                onPress={handleCancelEndDate}
                style={{
                  flex: 1,
                  backgroundColor: theme.colors.onDark.surface,
                  borderRadius: 12,
                  padding: 16,
                  alignItems: "center",
                }}
                activeOpacity={0.7}
              >
                <Text
                  style={{
                    color: theme.colors.surface,
                    fontSize: 16,
                    fontWeight: "600",
                  }}
                >
                  Cancelar
                </Text>
              </TouchableOpacity>

              <TouchableOpacity
                onPress={handleConfirmEndDate}
                style={{
                  flex: 1,
                  backgroundColor: theme.colors.primary,
                  borderRadius: 12,
                  padding: 16,
                  alignItems: "center",
                }}
                activeOpacity={0.7}
              >
                <Text
                  style={{
                    color: theme.colors.surface,
                    fontSize: 16,
                    fontWeight: "600",
                  }}
                >
                  Confirmar
                </Text>
              </TouchableOpacity>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </ScreenGradient>
  );
}

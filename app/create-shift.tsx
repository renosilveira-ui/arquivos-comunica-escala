import { useState, useEffect, useMemo, type ReactNode } from "react";
import {
  Text,
  View,
  TouchableOpacity,
  TextInput,
  ActivityIndicator,
  Switch,
  Platform,
  Modal,
  Pressable,
  Keyboard,
  StyleSheet,
  useWindowDimensions,
} from "react-native";
import { useActionFeedback } from "@/hooks/use-action-feedback";
import { ScreenGradient } from "@/components/ui/ScreenGradient";
import { TintedGlassCard } from "@/components/ui/TintedGlassCard";
import { theme } from "@/lib/theme";
import { useAuth } from "@/hooks/use-auth";
import { usePermissions } from "@/hooks/use-permissions";
import { trpc } from "@/lib/trpc";
import { useRouter, useLocalSearchParams } from "expo-router";
import * as Haptics from "expo-haptics";
import {
  ChevronLeft,
  ChevronRight,
  Calendar,
  Clock,
  Repeat,
  CheckCircle2,
  Building2,
  MapPin,
  Stethoscope,
} from "lucide-react-native";
import { scheduleShiftReminder } from "@/lib/notifications";
import DateTimePicker from "@react-native-community/datetimepicker";
import { formatDateBR } from "@/lib/datetime";
import {
  fromLocalISODateString,
  normalizeToNoon,
  toLocalISODateString,
} from "@/lib/datetime-utils";
import {
  formatShiftTemplateTimeRange,
  getShiftTemplatesForSector,
} from "@/lib/shift-template-options";
import { useTenantState } from "@/lib/tenant-state";
import { useScheduleContext } from "@/hooks/use-schedule-context";
import {
  groupScheduleContexts,
  scheduleContextMutationFields,
} from "@/lib/schedule-context-selection";

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
const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const PRIMARY_COLUMN_MIN_WIDTH = theme.spacing.contentMaxWidth / 2;
const SECONDARY_COLUMN_MIN_WIDTH = theme.spacing.contentMaxWidth / 3;
const OPTION_MIN_WIDTH = theme.spacing.contentMaxWidth / 6;
const ACTION_MIN_WIDTH = theme.spacing.contentMaxWidth / 5;
const CALENDAR_DAY_NAMES = ["D", "S", "T", "Q", "Q", "S", "S"];
const CALENDAR_COLUMNS = 7;

function getSafeDateParam(
  value: string | string[] | undefined,
): string | undefined {
  if (typeof value !== "string") return undefined;
  return DATE_REGEX.test(value) ? value : undefined;
}

function formatLocalDateBR(dateKey: string): string {
  return formatDateBR(fromLocalISODateString(dateKey));
}

function getMonthLabel(month: Date): string {
  const label = month.toLocaleDateString("pt-BR", {
    month: "long",
    year: "numeric",
  });
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function getMonthGrid(
  month: Date,
): { dateKey: string; isCurrentMonth: boolean }[] {
  const firstDay = new Date(month.getFullYear(), month.getMonth(), 1, 12);
  const gridStart = new Date(firstDay);
  gridStart.setDate(firstDay.getDate() - firstDay.getDay());

  return Array.from({ length: CALENDAR_COLUMNS * 6 }, (_, index) => {
    const day = new Date(gridStart);
    day.setDate(gridStart.getDate() + index);
    return {
      dateKey: toLocalISODateString(day),
      isCurrentMonth: day.getMonth() === month.getMonth(),
    };
  });
}

function addCalendarMonths(month: Date, amount: number): Date {
  return new Date(month.getFullYear(), month.getMonth() + amount, 1, 12);
}

/**
 * Tela de Criação de Escala
 * Formulário avançado com 3 profissionais por turno e repetição automática
 */
export default function CreateShiftScreen() {
  const feedback = useActionFeedback();
  const { user, isLoading: authLoading } = useAuth();
  const { can, isLoading: permissionsLoading } = usePermissions();
  const router = useRouter();
  const params = useLocalSearchParams();
  const utils = trpc.useUtils();
  const { activeInstitutionId } = useTenantState();
  const { width } = useWindowDimensions();
  const initialDate =
    getSafeDateParam(params.date) ?? toLocalISODateString(new Date());

  // Guard: somente admin/manager podem criar escalas
  useEffect(() => {
    if (authLoading || permissionsLoading) return;
    if (!user) return;
    if (!can("create:shift")) router.back();
  }, [authLoading, can, permissionsLoading, router, user]);

  // Estados do formulário
  const [selectedHospitalId, setSelectedHospitalId] = useState<
    number | undefined
  >(undefined);
  const [selectedSectorId, setSelectedSectorId] = useState<number | undefined>(
    undefined,
  );
  const [selectedDate, setSelectedDate] = useState(initialDate);
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [tempDate, setTempDate] = useState<Date | null>(null);
  const [calendarMonth, setCalendarMonth] = useState(() =>
    fromLocalISODateString(initialDate),
  );
  const [selectedTemplateId, setSelectedTemplateId] = useState<
    number | undefined
  >(undefined);
  const [formError, setFormError] = useState<string | null>(null);

  // Repetição automática
  const [enableRepeat, setEnableRepeat] = useState(false);
  const [repeatWeeks, setRepeatWeeks] = useState("1");
  const [repeatEndDate, setRepeatEndDate] = useState("");

  const [notes, setNotes] = useState("");

  // Modalidade (PR #61): defaults pareiam com os defaults do DB.
  const [modality, setModality] = useState<Modality>("PLANTAO");
  const [coverageType, setCoverageType] = useState<CoverageType | undefined>(
    "URGENCIA_EMERGENCIA",
  );
  const [paymentModel, setPaymentModel] = useState<PaymentModel>("FIXO");
  const [productivityCapBrl, setProductivityCapBrl] = useState("");

  // O destino deixa de ser uma lista plana de setores: um contexto combina
  // hospital + setor + qualificação profissional autorizada.
  const scheduleContext = useScheduleContext({
    userId: user?.id,
    institutionId: activeInstitutionId,
  });
  const selectScheduleContext = scheduleContext.selectContext;
  const clearCurrentScheduleContext = scheduleContext.clearCurrentSelection;
  const manageableContexts = useMemo(
    () => scheduleContext.contexts.filter((context) => context.canManage),
    [scheduleContext.contexts],
  );
  const contextHierarchy = useMemo(
    () => groupScheduleContexts(manageableContexts),
    [manageableContexts],
  );
  const selectedScheduleContext = manageableContexts.find(
    (context) => context.id === scheduleContext.selectedContextId,
  );
  const selectedHospital = contextHierarchy.find(
    (hospital) => hospital.hospitalId === selectedHospitalId,
  );
  const selectedSector = selectedHospital?.sectors.find(
    (sector) => sector.sectorId === selectedSectorId,
  );
  const templateSectors = useMemo(
    () =>
      contextHierarchy.flatMap((hospital) =>
        hospital.sectors.map((sector) => ({
          id: sector.sectorId,
          hospitalId: hospital.hospitalId,
        })),
      ),
    [contextHierarchy],
  );
  const { data: templates } = trpc.shifts.listTemplates.useQuery();
  const availableTemplates = useMemo(
    () =>
      getShiftTemplatesForSector(
        templates,
        templateSectors,
        selectedScheduleContext?.sectorId,
      ),
    [selectedScheduleContext?.sectorId, templates, templateSectors],
  );
  const selectedTemplate = availableTemplates.find(
    (template) => template.id === selectedTemplateId,
  );

  useEffect(() => {
    if (!selectedScheduleContext) return;
    setSelectedHospitalId(selectedScheduleContext.hospitalId);
    setSelectedSectorId(selectedScheduleContext.sectorId);
  }, [selectedScheduleContext]);

  useEffect(() => {
    setSelectedHospitalId((current) => {
      if (
        contextHierarchy.some((hospital) => hospital.hospitalId === current)
      ) {
        return current;
      }
      return contextHierarchy.length === 1
        ? contextHierarchy[0].hospitalId
        : undefined;
    });
  }, [contextHierarchy]);

  useEffect(() => {
    const sectors = selectedHospital?.sectors ?? [];
    setSelectedSectorId((current) => {
      if (sectors.some((sector) => sector.sectorId === current)) return current;
      return sectors.length === 1 ? sectors[0].sectorId : undefined;
    });
  }, [selectedHospital]);

  useEffect(() => {
    const options = selectedSector?.contexts ?? [];
    if (
      selectedScheduleContext &&
      options.some((context) => context.id === selectedScheduleContext.id)
    ) {
      return;
    }
    if (options.length === 1) {
      selectScheduleContext(options[0].id);
    }
  }, [selectScheduleContext, selectedScheduleContext, selectedSector]);

  useEffect(() => {
    if (!availableTemplates.length) {
      setSelectedTemplateId(undefined);
      return;
    }

    if (
      selectedTemplateId &&
      availableTemplates.some((template) => template.id === selectedTemplateId)
    ) {
      return;
    }

    const requestedShift =
      typeof params.shift === "string" ? params.shift : undefined;
    const preferredTemplate = requestedShift
      ? availableTemplates.find((template) => template.name === requestedShift)
      : undefined;
    setSelectedTemplateId((preferredTemplate ?? availableTemplates[0]).id);
  }, [availableTemplates, params.shift, selectedTemplateId]);

  // Mutation para criar escala
  const createShift = trpc.shifts.create.useMutation({
    onSuccess: async () => {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

      // Agendar lembrete 30 min antes em dispositivos nativos.
      if (
        Platform.OS !== "web" &&
        selectedScheduleContext &&
        selectedDate &&
        selectedTemplate
      ) {
        const startDateTime = new Date(
          `${selectedDate}T${selectedTemplate.startTime}`,
        );

        try {
          await scheduleShiftReminder(
            selectedScheduleContext.sectorName,
            startDateTime,
            `${selectedTemplate.name} (${formatShiftTemplateTimeRange(selectedTemplate)})`,
          );
        } catch (error) {
          console.warn("Não foi possível agendar lembrete local:", error);
        }
      }

      utils.shifts.listByPeriod.invalidate();
      utils.shifts.listAgenda.invalidate();
      router.back();
    },
    onError: (error) => {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      console.error("Erro ao criar escala:", error);
      const message = error.message || "Tente novamente em instantes.";
      setFormError(message);
      feedback.error(message);
    },
  });

  const handleSelectHospital = (hospitalId: number) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setFormError(null);
    setSelectedHospitalId(hospitalId);
    setSelectedSectorId(undefined);
    clearCurrentScheduleContext();
  };

  const handleSelectSector = (sectorId: number) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setFormError(null);
    setSelectedSectorId(sectorId);
    clearCurrentScheduleContext();
  };

  const handleSelectQualification = (contextId: number) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setFormError(null);
    selectScheduleContext(contextId);
  };

  const handleSelectTemplate = (templateId: number) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setFormError(null);
    setSelectedTemplateId(templateId);
  };

  const showFormError = (message: string) => {
    setFormError(message);
    feedback.error(message);
  };

  const handleCreateShift = () => {
    if (createShift.isPending) return;
    setFormError(null);

    if (!selectedScheduleContext || !selectedDate) {
      showFormError("Selecione hospital, setor, qualificação e data.");
      return;
    }

    if (!selectedTemplate) {
      showFormError("Selecione um turno disponível para este setor.");
      return;
    }

    // Validar data de término de repetição
    if (enableRepeat && repeatEndDate) {
      const startDate = fromLocalISODateString(selectedDate);
      const endDate = fromLocalISODateString(repeatEndDate);
      if (endDate <= startDate) {
        showFormError("A data limite precisa ser posterior à data inicial.");
        return;
      }
    }

    // Validações de modalidade (light-touch — server enforça as regras duras).
    if (modality === "PLANTAO" && !coverageType) {
      showFormError("Selecione a cobertura do plantão.");
      return;
    }
    if (paymentModel === "FIXO_PRODUTIVIDADE_TETO" && !productivityCapBrl) {
      showFormError("Informe o teto de produtividade ou troque o modelo.");
      return;
    }
    if (
      productivityCapBrl &&
      !PRODUCTIVITY_CAP_REGEX.test(productivityCapBrl)
    ) {
      showFormError(
        "Teto deve ser BRL no formato 1500.00 (ponto, não vírgula).",
      );
      return;
    }

    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

    createShift.mutate({
      date: selectedDate,
      shiftTemplateId: selectedTemplate.id,
      ...scheduleContextMutationFields(selectedScheduleContext),
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
      const nextDate = toLocalISODateString(normalized);
      setSelectedDate(nextDate);
      setCalendarMonth(fromLocalISODateString(nextDate));
      setFormError(null);
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
      const nextDate = toLocalISODateString(normalized);
      setSelectedDate(nextDate);
      setCalendarMonth(fromLocalISODateString(nextDate));
      setFormError(null);
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
    const currentDate = selectedDate || today;
    const localDate = fromLocalISODateString(currentDate);
    setTempDate(localDate); // Inicializar tempDate
    setCalendarMonth(localDate);
    setShowDatePicker(true);
  };

  const handleSelectWebDate = (dateKey: string) => {
    setSelectedDate(dateKey);
    setCalendarMonth(fromLocalISODateString(dateKey));
    setFormError(null);
    setShowDatePicker(false);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  };

  if (authLoading || permissionsLoading) {
    return (
      <ScreenGradient scrollable={false}>
        <View className="flex-1 justify-center items-center">
          <ActivityIndicator size="large" color={theme.colors.primary} />
        </View>
      </ScreenGradient>
    );
  }

  if (!user) {
    return (
      <ScreenGradient scrollable={false}>
        <View className="flex-1 justify-center items-center">
          <Text className="text-lg" style={{ color: theme.colors.textMuted }}>
            Faça login para continuar
          </Text>
        </View>
      </ScreenGradient>
    );
  }

  const isWide = width >= theme.spacing.contentMaxWidth;
  const selectedDateValue = selectedDate || today;
  const primaryActionDisabled = createShift.isPending;
  const createShiftErrorMessage = formError ?? createShift.error?.message;

  return (
    <ScreenGradient scrollable>
      <View style={styles.shell}>
        <View style={styles.header}>
          <TouchableOpacity
            onPress={handleBack}
            activeOpacity={0.7}
            style={styles.backButton}
          >
            <ChevronLeft size={28} color={theme.colors.textPrimary} />
          </TouchableOpacity>
          <View style={styles.headerText}>
            <Text style={styles.eyebrow}>Plantão</Text>
            <Text style={styles.title}>Nova Escala</Text>
            <Text style={styles.subtitle}>
              Crie um turno para depois vincular o profissional.
            </Text>
          </View>
        </View>

        <View style={styles.contentGrid}>
          <View style={styles.primaryColumn}>
            <FormSection
              title="Destino da escala"
              icon={<Building2 size={22} color={theme.colors.textPrimary} />}
              required
            >
              {scheduleContext.isSelectionHydrating ? (
                <View style={styles.loadingBox}>
                  <ActivityIndicator
                    size="small"
                    color={theme.colors.primary}
                  />
                </View>
              ) : scheduleContext.isError ? (
                <View style={styles.fieldStack}>
                  <Text style={styles.errorText}>
                    Não foi possível carregar os contextos de escala
                    autorizados.
                  </Text>
                  <TouchableOpacity
                    onPress={() => scheduleContext.refetch()}
                    activeOpacity={0.78}
                    style={styles.retryButton}
                  >
                    <Text style={styles.retryButtonLabel}>
                      Tentar novamente
                    </Text>
                  </TouchableOpacity>
                </View>
              ) : contextHierarchy.length === 0 ? (
                <Text style={styles.helperText}>
                  Você não possui hospital, setor e qualificação liberados para
                  criar escalas nesta instituição.
                </Text>
              ) : (
                <View style={styles.contextSteps}>
                  <View>
                    <View style={styles.contextStepLabelRow}>
                      <Building2 size={16} color={theme.colors.brand} />
                      <Text style={[styles.label, styles.contextStepLabel]}>
                        1. Hospital
                      </Text>
                    </View>
                    <View style={styles.optionGrid}>
                      {contextHierarchy.map((hospital) => (
                        <OptionButton
                          key={hospital.hospitalId}
                          label={hospital.hospitalName}
                          selected={selectedHospitalId === hospital.hospitalId}
                          onPress={() =>
                            handleSelectHospital(hospital.hospitalId)
                          }
                        />
                      ))}
                    </View>
                  </View>

                  <View>
                    <View style={styles.contextStepLabelRow}>
                      <MapPin size={16} color={theme.colors.brand} />
                      <Text style={[styles.label, styles.contextStepLabel]}>
                        2. Setor
                      </Text>
                    </View>
                    {selectedHospital ? (
                      <View style={styles.optionGrid}>
                        {selectedHospital.sectors.map((sector) => (
                          <OptionButton
                            key={sector.sectorId}
                            label={sector.sectorName}
                            selected={selectedSectorId === sector.sectorId}
                            onPress={() => handleSelectSector(sector.sectorId)}
                          />
                        ))}
                      </View>
                    ) : (
                      <Text style={styles.helperText}>
                        Selecione o hospital primeiro.
                      </Text>
                    )}
                  </View>

                  <View>
                    <View style={styles.contextStepLabelRow}>
                      <Stethoscope size={16} color={theme.colors.brand} />
                      <Text style={[styles.label, styles.contextStepLabel]}>
                        3. Qualificação
                      </Text>
                    </View>
                    {selectedSector ? (
                      <View style={styles.optionGrid}>
                        {selectedSector.contexts.map((context) => (
                          <OptionButton
                            key={context.id}
                            label={context.qualificationName}
                            description={context.qualificationCode}
                            selected={
                              selectedScheduleContext?.id === context.id
                            }
                            onPress={() =>
                              handleSelectQualification(context.id)
                            }
                          />
                        ))}
                      </View>
                    ) : (
                      <Text style={styles.helperText}>
                        Selecione o setor primeiro.
                      </Text>
                    )}
                  </View>
                </View>
              )}
            </FormSection>

            <FormSection
              title="Data"
              icon={<Calendar size={22} color={theme.colors.textPrimary} />}
              required
            >
              <TouchableOpacity
                onPress={handleCalendarPress}
                activeOpacity={0.78}
                style={styles.dateButton}
              >
                <View>
                  <Text style={styles.label}>Data selecionada</Text>
                  <Text style={styles.dateValue}>
                    {formatLocalDateBR(selectedDateValue)}
                  </Text>
                </View>
                <Text style={styles.dateAction}>Alterar</Text>
              </TouchableOpacity>

              {showDatePicker && Platform.OS === "android" && (
                <DateTimePicker
                  value={
                    selectedDate
                      ? fromLocalISODateString(selectedDate)
                      : new Date()
                  }
                  mode="date"
                  display="default"
                  onChange={handleDateChange}
                  locale="pt-BR"
                  minimumDate={new Date()}
                />
              )}
            </FormSection>

            <FormSection
              title="Turno"
              icon={<Clock size={22} color={theme.colors.textPrimary} />}
              required
            >
              <View style={styles.optionGrid}>
                {availableTemplates.map((template) => (
                  <OptionButton
                    key={template.id}
                    label={template.name}
                    description={formatShiftTemplateTimeRange(template)}
                    selected={selectedTemplateId === template.id}
                    onPress={() => handleSelectTemplate(template.id)}
                  />
                ))}
              </View>
              {!availableTemplates.length ? (
                <Text style={styles.helperText}>
                  {selectedScheduleContext
                    ? "Nenhum turno ativo para este setor."
                    : "Selecione hospital, setor e qualificação para ver os turnos."}
                </Text>
              ) : null}
            </FormSection>

            <FormSection title="Modalidade">
              <View style={styles.fieldStack}>
                <View>
                  <Text style={styles.label}>Modalidade *</Text>
                  <View style={styles.optionGrid}>
                    {MODALITY_OPTIONS.map((option) => (
                      <OptionButton
                        key={option.value}
                        label={option.label}
                        selected={modality === option.value}
                        onPress={() => {
                          Haptics.impactAsync(
                            Haptics.ImpactFeedbackStyle.Light,
                          );
                          setModality(option.value);
                          if (option.value === "SOBREAVISO") {
                            setCoverageType(undefined);
                          } else {
                            setCoverageType(
                              (current) => current ?? "URGENCIA_EMERGENCIA",
                            );
                          }
                        }}
                      />
                    ))}
                  </View>
                </View>

                {modality === "PLANTAO" ? (
                  <View>
                    <Text style={styles.label}>Cobertura *</Text>
                    <View style={styles.optionGrid}>
                      {COVERAGE_OPTIONS.map((option) => (
                        <OptionButton
                          key={option.value}
                          label={option.label}
                          selected={coverageType === option.value}
                          onPress={() => {
                            Haptics.impactAsync(
                              Haptics.ImpactFeedbackStyle.Light,
                            );
                            setCoverageType(option.value);
                          }}
                        />
                      ))}
                    </View>
                  </View>
                ) : null}

                <View>
                  <Text style={styles.label}>Modelo de pagamento *</Text>
                  <View style={styles.optionList}>
                    {PAYMENT_MODEL_OPTIONS.map((option) => (
                      <OptionButton
                        key={option.value}
                        label={option.label}
                        selected={paymentModel === option.value}
                        onPress={() => {
                          Haptics.impactAsync(
                            Haptics.ImpactFeedbackStyle.Light,
                          );
                          setPaymentModel(option.value);
                          if (option.value !== "FIXO_PRODUTIVIDADE_TETO") {
                            setProductivityCapBrl("");
                          }
                        }}
                      />
                    ))}
                  </View>
                </View>

                {paymentModel === "FIXO_PRODUTIVIDADE_TETO" ? (
                  <View>
                    <Text style={styles.label}>
                      Teto da produtividade (BRL)
                    </Text>
                    <TextInput
                      value={productivityCapBrl}
                      onChangeText={setProductivityCapBrl}
                      placeholder="Ex: 1500.00"
                      placeholderTextColor={theme.colors.textMuted}
                      keyboardType="decimal-pad"
                      style={styles.textInput}
                    />
                  </View>
                ) : null}
              </View>
            </FormSection>
          </View>

          <View
            style={[
              styles.secondaryColumn,
              isWide ? styles.secondaryColumnWide : null,
            ]}
          >
            <FormSection title="Resumo">
              <View style={styles.summaryStack}>
                <SummaryLine
                  label="Hospital"
                  value={
                    selectedScheduleContext?.hospitalName ??
                    selectedHospital?.hospitalName ??
                    "Selecione um hospital"
                  }
                />
                <SummaryLine
                  label="Setor"
                  value={
                    selectedScheduleContext?.sectorName ??
                    selectedSector?.sectorName ??
                    "Selecione um setor"
                  }
                />
                <SummaryLine
                  label="Qualificação"
                  value={
                    selectedScheduleContext?.qualificationName ??
                    "Selecione uma qualificação"
                  }
                />
                <SummaryLine
                  label="Data"
                  value={formatLocalDateBR(selectedDateValue)}
                />
                <SummaryLine
                  label="Turno"
                  value={
                    selectedTemplate
                      ? `${selectedTemplate.name} · ${formatShiftTemplateTimeRange(selectedTemplate)}`
                      : "Selecione um turno"
                  }
                />
                <SummaryLine
                  label="Modalidade"
                  value={modality === "PLANTAO" ? "Plantão" : "Sobreaviso"}
                />
                {modality === "PLANTAO" ? (
                  <SummaryLine
                    label="Cobertura"
                    value={
                      COVERAGE_OPTIONS.find(
                        (option) => option.value === coverageType,
                      )?.label ?? "Selecione a cobertura"
                    }
                  />
                ) : null}
                <SummaryLine
                  label="Pagamento"
                  value={
                    PAYMENT_MODEL_OPTIONS.find(
                      (option) => option.value === paymentModel,
                    )?.label ?? "Fixo"
                  }
                />
              </View>
            </FormSection>

            <FormSection
              title="Repetição"
              icon={<Repeat size={22} color={theme.colors.textPrimary} />}
            >
              <View style={styles.switchRow}>
                <View style={styles.switchText}>
                  <Text style={styles.bodyStrong}>Repetir Escala</Text>
                  <Text style={styles.bodyMuted}>
                    Cria novas escalas em semanas futuras.
                  </Text>
                </View>
                <Switch
                  value={enableRepeat}
                  onValueChange={(value) => {
                    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                    setEnableRepeat(value);
                  }}
                  trackColor={{
                    false: theme.colors.border,
                    true: theme.colors.primary,
                  }}
                  thumbColor={theme.colors.surface}
                />
              </View>

              {enableRepeat ? (
                <View style={styles.fieldStack}>
                  <View>
                    <Text style={styles.label}>Repetir a cada (semanas)</Text>
                    <TextInput
                      value={repeatWeeks}
                      onChangeText={setRepeatWeeks}
                      placeholder="1"
                      keyboardType="number-pad"
                      placeholderTextColor={theme.colors.textMuted}
                      style={styles.textInput}
                    />
                  </View>
                  <View>
                    <Text style={styles.label}>Data limite</Text>
                    <TextInput
                      value={repeatEndDate}
                      onChangeText={setRepeatEndDate}
                      placeholder="AAAA-MM-DD"
                      placeholderTextColor={theme.colors.textMuted}
                      style={styles.textInput}
                    />
                  </View>
                </View>
              ) : null}
            </FormSection>

            <FormSection title="Observações">
              <TextInput
                value={notes}
                onChangeText={setNotes}
                placeholder="Informações adicionais..."
                placeholderTextColor={theme.colors.textMuted}
                multiline
                numberOfLines={4}
                textAlignVertical="top"
                style={[styles.textInput, styles.notesInput]}
              />
            </FormSection>

            <TouchableOpacity
              onPress={handleCreateShift}
              disabled={primaryActionDisabled}
              style={[
                styles.submitButton,
                primaryActionDisabled ? styles.disabledButton : null,
              ]}
              activeOpacity={0.78}
              accessibilityRole="button"
              accessibilityLabel="Criar Escala"
              accessibilityState={{ disabled: primaryActionDisabled }}
            >
              {createShift.isPending ? (
                <ActivityIndicator size="small" color={theme.colors.surface} />
              ) : (
                <View style={styles.submitContent}>
                  <CheckCircle2 size={20} color={theme.colors.surface} />
                  <Text style={styles.submitLabel}>Criar Escala</Text>
                </View>
              )}
            </TouchableOpacity>

            {createShiftErrorMessage ? (
              <Text style={styles.errorText}>{createShiftErrorMessage}</Text>
            ) : null}
          </View>
        </View>
      </View>

      {showDatePicker && Platform.OS === "web" ? (
        <WebCalendarModal
          selectedDate={selectedDateValue}
          visibleMonth={calendarMonth}
          onPreviousMonth={() =>
            setCalendarMonth((current) => addCalendarMonths(current, -1))
          }
          onNextMonth={() =>
            setCalendarMonth((current) => addCalendarMonths(current, 1))
          }
          onSelectDate={handleSelectWebDate}
          onCancel={handleCancelDate}
        />
      ) : null}

      {/* Modal de Seleção de Data (iOS) */}
      <Modal
        visible={showDatePicker && Platform.OS === "ios"}
        transparent
        animationType="fade"
        onRequestClose={handleCancelDate}
      >
        <Pressable style={styles.modalOverlay} onPress={handleCancelDate}>
          <Pressable
            style={styles.dateSheet}
            onPress={(e) => e.stopPropagation()}
          >
            <Text style={styles.sheetTitle}>Selecionar data</Text>
            <Text style={styles.sheetSubtitle}>
              Data selecionada:{" "}
              {tempDate
                ? formatLocalDateBR(
                    toLocalISODateString(normalizeToNoon(tempDate)),
                  )
                : formatLocalDateBR(selectedDate || today)}
            </Text>

            <DateTimePicker
              value={
                tempDate ||
                (selectedDate
                  ? fromLocalISODateString(selectedDate)
                  : new Date())
              }
              mode="date"
              display="spinner"
              onChange={handleDateChange}
              locale="pt-BR"
              minimumDate={new Date()}
              textColor={theme.colors.surface}
            />

            <View style={styles.sheetActions}>
              <SheetButton
                label="Cancelar"
                onPress={handleCancelDate}
                variant="secondary"
              />
              <SheetButton
                label="Confirmar"
                onPress={handleConfirmDate}
                variant="primary"
              />
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </ScreenGradient>
  );
}

function FormSection({
  title,
  icon,
  required,
  children,
}: {
  title: string;
  icon?: ReactNode;
  required?: boolean;
  children: ReactNode;
}) {
  return (
    <TintedGlassCard variant="light" style={styles.sectionCard}>
      <View style={styles.sectionHeader}>
        {icon}
        <Text style={styles.sectionTitle}>
          {title}
          {required ? " *" : ""}
        </Text>
      </View>
      {children}
    </TintedGlassCard>
  );
}

function OptionButton({
  label,
  description,
  selected,
  onPress,
}: {
  label: string;
  description?: string;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.78}
      style={[
        styles.optionButton,
        selected ? styles.optionButtonSelected : null,
      ]}
    >
      <Text
        style={[
          styles.optionLabel,
          selected ? styles.optionLabelSelected : null,
        ]}
      >
        {label}
      </Text>
      {description ? (
        <Text
          style={[
            styles.optionDescription,
            selected ? styles.optionDescriptionSelected : null,
          ]}
        >
          {description}
        </Text>
      ) : null}
    </TouchableOpacity>
  );
}

function SummaryLine({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.summaryLine}>
      <Text style={styles.label}>{label}</Text>
      <Text style={styles.summaryValue}>{value}</Text>
    </View>
  );
}

function WebCalendarModal({
  selectedDate,
  visibleMonth,
  onPreviousMonth,
  onNextMonth,
  onSelectDate,
  onCancel,
}: {
  selectedDate: string;
  visibleMonth: Date;
  onPreviousMonth: () => void;
  onNextMonth: () => void;
  onSelectDate: (dateKey: string) => void;
  onCancel: () => void;
}) {
  const calendarDays = getMonthGrid(visibleMonth);
  const todayKey = toLocalISODateString(new Date());

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onCancel}>
      <Pressable style={styles.modalOverlay} onPress={onCancel}>
        <Pressable
          style={styles.webDateDialog}
          onPress={(e) => e.stopPropagation()}
        >
          <View style={styles.calendarHeader}>
            <TouchableOpacity
              onPress={onPreviousMonth}
              activeOpacity={0.78}
              style={styles.calendarNavButton}
            >
              <ChevronLeft size={20} color={theme.colors.textPrimary} />
            </TouchableOpacity>
            <View style={styles.calendarTitleBlock}>
              <Text style={styles.dialogTitle}>Selecionar data</Text>
              <Text style={styles.dialogSubtitle}>
                {getMonthLabel(visibleMonth)}
              </Text>
            </View>
            <TouchableOpacity
              onPress={onNextMonth}
              activeOpacity={0.78}
              style={styles.calendarNavButton}
            >
              <ChevronRight size={20} color={theme.colors.textPrimary} />
            </TouchableOpacity>
          </View>

          <View style={styles.calendarWeekRow}>
            {CALENDAR_DAY_NAMES.map((dayName, index) => (
              <Text
                key={`${dayName}-${index}`}
                style={styles.calendarWeekLabel}
              >
                {dayName}
              </Text>
            ))}
          </View>

          <View style={styles.calendarGrid}>
            {calendarDays.map((day) => {
              const isSelected = day.dateKey === selectedDate;
              const isToday = day.dateKey === todayKey;
              const isPast = day.dateKey < todayKey;
              const dayNumber = fromLocalISODateString(day.dateKey).getDate();

              return (
                <TouchableOpacity
                  key={day.dateKey}
                  onPress={() => onSelectDate(day.dateKey)}
                  disabled={isPast}
                  activeOpacity={0.78}
                  style={[
                    styles.calendarDayButton,
                    !day.isCurrentMonth ? styles.calendarDayMuted : null,
                    isToday ? styles.calendarDayToday : null,
                    isSelected ? styles.calendarDaySelected : null,
                    isPast ? styles.calendarDayDisabled : null,
                  ]}
                >
                  <Text
                    style={[
                      styles.calendarDayText,
                      !day.isCurrentMonth ? styles.calendarDayTextMuted : null,
                      isSelected ? styles.calendarDayTextSelected : null,
                      isPast ? styles.calendarDayTextDisabled : null,
                    ]}
                  >
                    {dayNumber}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>

          <View style={styles.calendarFooter}>
            <Text style={styles.dialogSubtitle}>
              Data selecionada: {formatLocalDateBR(selectedDate)}
            </Text>
            <SheetButton
              label="Cancelar"
              onPress={onCancel}
              variant="secondary"
            />
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function SheetButton({
  label,
  onPress,
  variant,
}: {
  label: string;
  onPress: () => void;
  variant: "primary" | "secondary";
}) {
  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.78}
      style={[
        styles.sheetButton,
        variant === "primary"
          ? styles.sheetButtonPrimary
          : styles.sheetButtonSecondary,
      ]}
    >
      <Text
        style={[
          styles.sheetButtonLabel,
          variant === "primary" ? styles.sheetButtonLabelPrimary : null,
        ]}
      >
        {label}
      </Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  shell: {
    width: "100%",
    maxWidth: theme.spacing.contentMaxWidth,
    alignSelf: "center",
    gap: theme.space[6],
    paddingBottom: theme.space[8],
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.space[3],
  },
  backButton: {
    width: theme.space[10],
    height: theme.space[10],
    borderRadius: theme.radius.full,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  headerText: {
    flex: 1,
  },
  eyebrow: {
    ...theme.text.caption,
    color: theme.colors.textMuted,
    fontWeight: theme.weight.semibold,
    textTransform: "uppercase",
  },
  title: {
    ...theme.text.titleLg,
    color: theme.colors.textPrimary,
    fontWeight: theme.weight.bold,
  },
  subtitle: {
    ...theme.text.body,
    color: theme.colors.textMuted,
  },
  contentGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.space[6],
    alignItems: "flex-start",
  },
  primaryColumn: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: PRIMARY_COLUMN_MIN_WIDTH,
    minWidth: theme.space[0],
    gap: theme.space[5],
  },
  secondaryColumn: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: SECONDARY_COLUMN_MIN_WIDTH,
    minWidth: theme.space[0],
    gap: theme.space[5],
  },
  secondaryColumnWide: {
    maxWidth: SECONDARY_COLUMN_MIN_WIDTH + theme.space[20],
  },
  sectionCard: {
    gap: theme.space[4],
  },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.space[2],
  },
  sectionTitle: {
    ...theme.text.title,
    color: theme.colors.textPrimary,
    fontWeight: theme.weight.bold,
  },
  loadingBox: {
    minHeight: theme.space[14],
    alignItems: "center",
    justifyContent: "center",
  },
  contextSteps: {
    gap: theme.space[5],
  },
  contextStepLabelRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.space[2],
    marginBottom: theme.space[2],
  },
  contextStepLabel: {
    marginBottom: theme.space[0],
    color: theme.colors.textPrimary,
  },
  optionGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.space[3],
  },
  optionList: {
    gap: theme.space[3],
  },
  optionButton: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: OPTION_MIN_WIDTH,
    minWidth: theme.space[0],
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceAlt,
    paddingHorizontal: theme.space[4],
    paddingVertical: theme.space[3],
  },
  optionButtonSelected: {
    backgroundColor: theme.colors.primary,
    borderColor: theme.colors.primary,
  },
  optionLabel: {
    ...theme.text.bodyLg,
    color: theme.colors.textPrimary,
    fontWeight: theme.weight.semibold,
  },
  optionLabelSelected: {
    color: theme.colors.surface,
  },
  optionDescription: {
    ...theme.text.body,
    color: theme.colors.textSecondary,
    marginTop: theme.space[1],
  },
  optionDescriptionSelected: {
    color: theme.colors.onDark.text,
  },
  dateButton: {
    minHeight: theme.space[14],
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceAlt,
    paddingHorizontal: theme.space[4],
    paddingVertical: theme.space[3],
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.space[3],
  },
  dateValue: {
    ...theme.text.title,
    color: theme.colors.textPrimary,
    fontWeight: theme.weight.bold,
  },
  dateAction: {
    ...theme.text.body,
    color: theme.colors.primary,
    fontWeight: theme.weight.semibold,
  },
  fieldStack: {
    gap: theme.space[4],
  },
  label: {
    ...theme.text.caption,
    color: theme.colors.textMuted,
    fontWeight: theme.weight.semibold,
    marginBottom: theme.space[2],
  },
  textInput: {
    minHeight: theme.space[14],
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.surfaceAlt,
    borderWidth: 1,
    borderColor: theme.colors.border,
    paddingHorizontal: theme.space[4],
    paddingVertical: theme.space[3],
    ...theme.text.bodyLg,
    color: theme.colors.textPrimary,
  },
  notesInput: {
    minHeight: theme.space[20] + theme.space[6],
  },
  summaryStack: {
    gap: theme.space[3],
  },
  summaryLine: {
    paddingBottom: theme.space[3],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  summaryValue: {
    ...theme.text.bodyLg,
    color: theme.colors.textPrimary,
    fontWeight: theme.weight.semibold,
  },
  switchRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.space[4],
  },
  switchText: {
    flex: 1,
  },
  bodyStrong: {
    ...theme.text.bodyLg,
    color: theme.colors.textPrimary,
    fontWeight: theme.weight.semibold,
  },
  bodyMuted: {
    ...theme.text.body,
    color: theme.colors.textMuted,
  },
  helperText: {
    ...theme.text.body,
    color: theme.colors.textMuted,
    marginTop: theme.space[3],
  },
  retryButton: {
    minHeight: theme.space[10],
    alignSelf: "flex-start",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: theme.space[4],
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.primary,
    backgroundColor: theme.colors.surface,
  },
  retryButtonLabel: {
    ...theme.text.body,
    color: theme.colors.primary,
    fontWeight: theme.weight.bold,
  },
  errorText: {
    ...theme.text.body,
    color: theme.colors.danger,
    fontWeight: theme.weight.semibold,
  },
  submitButton: {
    minHeight: theme.space[14],
    minWidth: ACTION_MIN_WIDTH,
    borderRadius: theme.radius.lg,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.primary,
    paddingHorizontal: theme.space[4],
    paddingVertical: theme.space[3],
  },
  disabledButton: {
    opacity: 0.65,
  },
  submitContent: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.space[2],
  },
  submitLabel: {
    ...theme.text.bodyLg,
    color: theme.colors.surface,
    fontWeight: theme.weight.bold,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: theme.colors.overlay,
    justifyContent: "flex-end",
  },
  webDateDialog: {
    width: "100%",
    maxWidth: SECONDARY_COLUMN_MIN_WIDTH,
    alignSelf: "center",
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.xl,
    padding: theme.space[6],
    margin: theme.space[5],
    gap: theme.space[4],
  },
  calendarHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.space[3],
  },
  calendarTitleBlock: {
    flex: 1,
    alignItems: "center",
  },
  calendarNavButton: {
    width: theme.space[10],
    height: theme.space[10],
    borderRadius: theme.radius.full,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.surfaceAlt,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  calendarWeekRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: theme.space[1],
  },
  calendarWeekLabel: {
    width: theme.space[10],
    textAlign: "center",
    ...theme.text.caption,
    color: theme.colors.textMuted,
    fontWeight: theme.weight.semibold,
  },
  calendarGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "space-between",
    rowGap: theme.space[2],
  },
  calendarDayButton: {
    width: theme.space[10],
    height: theme.space[10],
    borderRadius: theme.radius.lg,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  calendarDayMuted: {
    backgroundColor: theme.colors.surfaceAlt,
  },
  calendarDayToday: {
    borderColor: theme.colors.primary,
  },
  calendarDaySelected: {
    backgroundColor: theme.colors.primary,
    borderColor: theme.colors.primary,
  },
  calendarDayDisabled: {
    opacity: 0.42,
  },
  calendarDayText: {
    ...theme.text.body,
    color: theme.colors.textPrimary,
    fontWeight: theme.weight.semibold,
  },
  calendarDayTextMuted: {
    color: theme.colors.textMuted,
  },
  calendarDayTextSelected: {
    color: theme.colors.surface,
  },
  calendarDayTextDisabled: {
    color: theme.colors.textMuted,
  },
  calendarFooter: {
    gap: theme.space[3],
  },
  dateSheet: {
    backgroundColor: theme.palette.neutral[900],
    borderTopLeftRadius: theme.radius["2xl"],
    borderTopRightRadius: theme.radius["2xl"],
    padding: theme.space[6],
    paddingBottom: theme.space[10],
    gap: theme.space[4],
  },
  dialogTitle: {
    ...theme.text.title,
    color: theme.colors.textPrimary,
    fontWeight: theme.weight.bold,
    textAlign: "center",
  },
  dialogSubtitle: {
    ...theme.text.body,
    color: theme.colors.textMuted,
    textAlign: "center",
  },
  sheetTitle: {
    ...theme.text.title,
    color: theme.colors.surface,
    fontWeight: theme.weight.bold,
    textAlign: "center",
  },
  sheetSubtitle: {
    ...theme.text.body,
    color: theme.colors.onDark.textMuted,
    textAlign: "center",
  },
  sheetActions: {
    flexDirection: "row",
    gap: theme.space[3],
  },
  sheetButton: {
    flex: 1,
    minHeight: theme.space[14],
    borderRadius: theme.radius.lg,
    alignItems: "center",
    justifyContent: "center",
    padding: theme.space[4],
  },
  sheetButtonPrimary: {
    backgroundColor: theme.colors.primary,
  },
  sheetButtonSecondary: {
    backgroundColor: theme.colors.surfaceAlt,
  },
  sheetButtonLabel: {
    ...theme.text.bodyLg,
    color: theme.colors.textPrimary,
    fontWeight: theme.weight.semibold,
  },
  sheetButtonLabelPrimary: {
    color: theme.colors.surface,
  },
});

import { useMemo, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Text,
  View,
} from "react-native";
import { useRouter } from "expo-router";
import * as Haptics from "expo-haptics";
import { X } from "lucide-react-native";
import { trpc } from "@/lib/trpc";
import { theme } from "@/lib/theme";
import { useTenantState } from "@/lib/tenant-state";
import { invalidateOfficialScaleAndVacancyQueries } from "@/lib/official-scale-vacancy-query-refresh";
import { useActionFeedback } from "@/hooks/use-action-feedback";
import { AppButton } from "@/components/ui/AppButton";
import {
  OPEN_MONTH_SHIFT_MODES,
  OPEN_MONTH_SHIFT_TEMPLATE_NAMES,
  openMonthShiftTemplateChipLabel,
  openMonthShiftsButtonTitle,
  openMonthShiftsConfirmTitle,
  openMonthShiftsModalTitle,
  openMonthShiftsModeHint,
  openMonthShiftsModeLabel,
  openMonthShiftsPreviewCount,
  openMonthShiftsToast,
  planOpenMonthShifts,
  type OpenMonthShiftTemplateName,
  type OpenMonthShiftsMode,
} from "@/lib/open-month-shifts";

interface Props {
  monthKey: string;
  monthName: string;
  selectedContext: {
    hospitalId: number;
    sectorId: number;
    scheduleContextId: number;
  };
  onChanged?: () => void;
}

export function OpenMonthShiftsButton({
  monthKey,
  monthName,
  selectedContext,
  onChanged,
}: Props) {
  const router = useRouter();
  const { activeInstitutionId } = useTenantState();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<OpenMonthShiftsMode>("all-applicable");
  const [customNames, setCustomNames] = useState<OpenMonthShiftTemplateName[]>([
    "Manhã",
    "Tarde",
    "Noite",
  ]);
  const feedback = useActionFeedback();
  const utils = trpc.useUtils();
  const openMonthShifts = trpc.shifts.openMonthShifts.useMutation();
  const capacityRules = trpc.scheduleCapacity.capacityRules.useQuery(
    {
      scheduleContextId: selectedContext.scheduleContextId,
      expectedInstitutionId: activeInstitutionId ?? undefined,
    },
    {
      enabled: open && activeInstitutionId != null,
    },
  );

  const planned = useMemo(() => {
    try {
      return planOpenMonthShifts({
        yearMonth: monthKey,
        mode,
        templateNames: mode === "custom" ? customNames : undefined,
      });
    } catch {
      return [];
    }
  }, [monthKey, mode, customNames]);
  const plannedCount = planned.length;
  const plannedTemplateNames = useMemo(
    () => new Set<string>(planned.map((slot) => slot.template.name)),
    [planned],
  );
  const visibleCapacityRules = useMemo(
    () =>
      (capacityRules.data ?? []).filter((rule) =>
        plannedTemplateNames.has(rule.name),
      ),
    [capacityRules.data, plannedTemplateNames],
  );
  const capacityReady =
    activeInstitutionId != null && capacityRules.isSuccess;

  function close() {
    setOpen(false);
    setMode("all-applicable");
    setCustomNames(["Manhã", "Tarde", "Noite"]);
  }

  function openModal() {
    if (Platform.OS !== "web") {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    }
    setOpen(true);
  }

  function configureCapacity() {
    close();
    router.push({
      pathname: "/schedule-capacity" as any,
      params: {
        scheduleContextId: String(selectedContext.scheduleContextId),
      },
    });
  }

  function toggleCustomName(name: OpenMonthShiftTemplateName) {
    setCustomNames((current) =>
      current.includes(name)
        ? current.filter((item) => item !== name)
        : [...current, name],
    );
  }

  async function confirm() {
    try {
      const result = await openMonthShifts.mutateAsync({
        hospitalId: selectedContext.hospitalId,
        sectorId: selectedContext.sectorId,
        scheduleContextId: selectedContext.scheduleContextId,
        yearMonth: monthKey,
        mode,
        templateNames: mode === "custom" ? customNames : undefined,
      });
      await Promise.all([
        invalidateOfficialScaleAndVacancyQueries(utils),
        utils.shifts.hasMonthShifts.invalidate(),
        utils.filters.hasMonthShifts.invalidate(),
        utils.shifts.rosterStatus.invalidate(),
      ]);
      onChanged?.();
      feedback.success(openMonthShiftsToast(result.created, result.skipped));
      close();
    } catch (err) {
      feedback.error((err as Error).message);
    }
  }

  return (
    <>
      <AppButton
        title={openMonthShiftsButtonTitle(monthName)}
        onPress={openModal}
        fullWidth
      />

      <Modal visible={open} transparent animationType="fade" onRequestClose={close}>
        <Pressable
          onPress={close}
          accessibilityLabel="Fechar"
          style={{
            flex: 1,
            backgroundColor: theme.colors.overlay,
            justifyContent: "flex-end",
          }}
        >
          <Pressable
            onPress={() => {}}
            style={{
              backgroundColor: theme.colors.surface,
              borderTopLeftRadius: theme.radius["2xl"],
              borderTopRightRadius: theme.radius["2xl"],
              padding: theme.space[6],
              paddingBottom: theme.space[10],
              gap: theme.space[4],
              maxHeight: "85%",
              width: "100%",
              maxWidth: theme.spacing.contentMaxWidth / 2,
              alignSelf: "center",
            }}
          >
            <View
              style={{
                flexDirection: "row",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <Text
                style={{
                  ...theme.text.title,
                  fontWeight: theme.weight.bold,
                  color: theme.colors.textPrimary,
                }}
              >
                {openMonthShiftsModalTitle()}
              </Text>
              <Pressable onPress={close} hitSlop={12} accessibilityLabel="Fechar">
                <X size={22} color={theme.colors.textSecondary} />
              </Pressable>
            </View>

            <ScrollView
              style={{ flexShrink: 1 }}
              contentContainerStyle={{ gap: theme.space[4] }}
              showsVerticalScrollIndicator
            >
              <Text style={{ ...theme.text.body, color: theme.colors.textSecondary }}>
                {openMonthShiftsModeHint(mode)}
              </Text>

              <View style={{ gap: theme.space[2] }}>
                {OPEN_MONTH_SHIFT_MODES.map((option) => {
                  const selected = mode === option;
                  return (
                    <Pressable
                      key={option}
                      onPress={() => setMode(option)}
                      accessibilityRole="button"
                      accessibilityState={{ selected }}
                      style={{
                        minHeight: theme.space[10] + theme.space[1],
                        justifyContent: "center",
                        paddingHorizontal: theme.space[3],
                        paddingVertical: theme.space[2],
                        borderRadius: theme.radius.lg,
                        borderWidth: 1,
                        borderColor: selected
                          ? theme.colors.primary
                          : theme.colors.border,
                        backgroundColor: selected
                          ? theme.colors.primarySoft
                          : theme.colors.surface,
                      }}
                    >
                      <Text
                        style={{
                          ...theme.text.bodyLg,
                          fontWeight: theme.weight.semibold,
                          color: selected
                            ? theme.colors.primary
                            : theme.colors.textPrimary,
                        }}
                      >
                        {openMonthShiftsModeLabel(option)}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>

              {mode === "custom" ? (
                <View style={{ gap: theme.space[2] }}>
                  {OPEN_MONTH_SHIFT_TEMPLATE_NAMES.map((name) => {
                    const selected = customNames.includes(name);
                    return (
                      <Pressable
                        key={name}
                        onPress={() => toggleCustomName(name)}
                        accessibilityRole="button"
                        accessibilityState={{ selected }}
                        style={{
                          minHeight: theme.space[10] + theme.space[1],
                          justifyContent: "center",
                          paddingHorizontal: theme.space[3],
                          borderRadius: theme.radius.md,
                          borderWidth: 1,
                          borderColor: selected
                            ? theme.colors.primary
                            : theme.colors.border,
                          backgroundColor: selected
                            ? theme.colors.primarySoft
                            : theme.colors.surface,
                        }}
                      >
                        <Text
                          style={{
                            ...theme.text.body,
                            fontWeight: theme.weight.semibold,
                            color: selected
                              ? theme.colors.primary
                              : theme.colors.textPrimary,
                          }}
                        >
                          {selected ? "✓ " : ""}
                          {openMonthShiftTemplateChipLabel(name)}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              ) : null}

              <View
                style={{
                  gap: theme.space[2],
                  padding: theme.space[3],
                  borderWidth: 1,
                  borderColor: theme.colors.border,
                  borderRadius: theme.radius.lg,
                  backgroundColor: theme.colors.surfaceAlt,
                }}
              >
                <Text
                  style={{
                    ...theme.text.bodyLg,
                    fontWeight: theme.weight.semibold,
                    color: theme.colors.textPrimary,
                  }}
                >
                  Profissionais necessários por turno
                </Text>
                <Text style={{ ...theme.text.body, color: theme.colors.textSecondary }}>
                  Confira a capacidade antes de abrir o mês. O padrão é 1 e a
                  configuração respeita cada dia da semana.
                </Text>
                {capacityRules.isLoading || capacityRules.isFetching ? (
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                    <ActivityIndicator size="small" color={theme.colors.primary} />
                    <Text style={{ ...theme.text.body, color: theme.colors.textSecondary }}>
                      Consultando capacidade…
                    </Text>
                  </View>
                ) : null}
                {capacityRules.error ? (
                  <View style={{ gap: theme.space[2] }}>
                    <Text accessibilityRole="alert" style={{ color: theme.colors.danger }}>
                      Não foi possível conferir a capacidade desta escala.
                    </Text>
                    <AppButton
                      title="Tentar novamente"
                      variant="secondary"
                      size="sm"
                      onPress={() => {
                        void capacityRules.refetch();
                      }}
                    />
                  </View>
                ) : null}
                {capacityRules.isSuccess
                  ? visibleCapacityRules.map((rule) => {
                      const min = Math.min(...rule.capacities);
                      const max = Math.max(...rule.capacities);
                      const detail =
                        min === max
                          ? `${min} ${min === 1 ? "profissional" : "profissionais"}`
                          : `${min}–${max} profissionais, conforme o dia`;
                      return (
                        <Text
                          key={rule.id}
                          style={{ ...theme.text.body, color: theme.colors.textPrimary }}
                        >
                          {rule.name}: {detail}
                        </Text>
                      );
                    })
                  : null}
                <AppButton
                  title="Configurar capacidade"
                  variant="secondary"
                  size="sm"
                  onPress={configureCapacity}
                />
              </View>

              <Text style={{ ...theme.text.body, color: theme.colors.textPrimary }}>
                {openMonthShiftsPreviewCount(plannedCount)}
              </Text>
            </ScrollView>

            {openMonthShifts.isPending ? (
              <View
                style={{
                  alignItems: "center",
                  paddingVertical: theme.space[4],
                  gap: theme.space[3],
                }}
              >
                <ActivityIndicator size="large" color={theme.colors.primary} />
                <Text style={{ ...theme.text.body, color: theme.colors.textSecondary }}>
                  Criando plantões vagos…
                </Text>
              </View>
            ) : (
              <AppButton
                title={openMonthShiftsConfirmTitle(plannedCount)}
                onPress={() => {
                  void confirm();
                }}
                disabled={
                  plannedCount === 0 ||
                  openMonthShifts.isPending ||
                  !capacityReady
                }
                fullWidth
              />
            )}
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

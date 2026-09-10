import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import { useRouter } from "expo-router";
import * as Haptics from "expo-haptics";
import { X } from "lucide-react-native";
import { trpc } from "@/lib/trpc";
import { theme } from "@/lib/theme";
import { useAuth } from "@/hooks/use-auth";
import { useTenantState } from "@/lib/tenant-state";
import { useScreenActionLease } from "@/hooks/use-screen-action-lease";
import type { ScreenActionLease } from "@/lib/screen-action-lease";
import { MAX_SHIFT_CAPACITY } from "@/lib/shift-capacity";
import {
  openMonthCapacityScopeKey,
  openMonthCapacitySnapshotKey,
  resolveOpenMonthCapacityState,
} from "@/lib/open-month-capacity-state";
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

const WEEKDAY_SHORT_LABELS = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];

function emptyCapacityValues(): Record<OpenMonthShiftTemplateName, string> {
  return { Manhã: "1", Tarde: "1", Noite: "1" };
}

export function OpenMonthShiftsButton({
  monthKey,
  monthName,
  selectedContext,
  onChanged,
}: Props) {
  const router = useRouter();
  const { user } = useAuth();
  const { activeInstitutionId } = useTenantState();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<OpenMonthShiftsMode>("all-applicable");
  const [customNames, setCustomNames] = useState<OpenMonthShiftTemplateName[]>([
    "Manhã",
    "Tarde",
    "Noite",
  ]);
  const [capacityValues, setCapacityValues] = useState(emptyCapacityValues);
  const [capacityHydration, setCapacityHydration] = useState<{
    scopeKey: string;
    snapshotKey: string;
  } | null>(null);
  const [capacityDirty, setCapacityDirty] = useState(false);
  const feedback = useActionFeedback();
  const utils = trpc.useUtils();
  const openMonthShifts = trpc.shifts.openMonthShifts.useMutation();
  const actionLease = useScreenActionLease({
    userId: user?.id,
    contextKey:
      open && activeInstitutionId != null
        ? `${activeInstitutionId}:${selectedContext.hospitalId}:${selectedContext.sectorId}:${selectedContext.scheduleContextId}:${monthKey}`
        : null,
  });
  const openMonthLeaseRef = useRef<ScreenActionLease | null>(null);
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
  const visibleCapacityNames = useMemo(
    () =>
      OPEN_MONTH_SHIFT_TEMPLATE_NAMES.filter((name) =>
        plannedTemplateNames.has(name),
      ),
    [plannedTemplateNames],
  );
  const invalidCapacity = visibleCapacityNames.some((name) => {
    const raw = capacityValues[name].trim();
    if (raw === "") return false;
    const value = Number(raw);
    return (
      !Number.isSafeInteger(value) ||
      value < 1 ||
      value > MAX_SHIFT_CAPACITY
    );
  });
  const capacityScopeKey = openMonthCapacityScopeKey(
    activeInstitutionId,
    selectedContext.scheduleContextId,
  );
  const capacitySnapshotKey = openMonthCapacitySnapshotKey(
    capacityScopeKey,
    capacityRules.dataUpdatedAt,
  );
  const capacityState = resolveOpenMonthCapacityState({
    currentSnapshotKey: capacitySnapshotKey,
    hydratedSnapshotKey: capacityHydration?.snapshotKey ?? null,
    querySucceeded: capacityRules.isSuccess,
    queryFetchStatus: capacityRules.fetchStatus,
    hasResolvedData: capacityRules.data !== undefined,
    queryFailed: capacityRules.isError,
    invalidCapacity,
  });
  const capacityReady = capacityState === "ready";

  useEffect(() => {
    if (
      !open ||
      capacityScopeKey == null ||
      capacitySnapshotKey == null ||
      !capacityRules.isSuccess ||
      capacityRules.data === undefined ||
      capacityRules.fetchStatus !== "idle" ||
      capacityHydration?.snapshotKey === capacitySnapshotKey
    ) {
      return;
    }
    const sameScope = capacityHydration?.scopeKey === capacityScopeKey;
    if (!sameScope || !capacityDirty) {
      const next = emptyCapacityValues();
      for (const name of OPEN_MONTH_SHIFT_TEMPLATE_NAMES) {
        const rule = capacityRules.data.find((item) => item.name === name);
        if (!rule) continue;
        const unique = new Set(rule.capacities);
        next[name] = unique.size === 1 ? String(rule.capacities[0]) : "";
      }
      setCapacityValues(next);
      setCapacityDirty(false);
    }
    setCapacityHydration({
      scopeKey: capacityScopeKey,
      snapshotKey: capacitySnapshotKey,
    });
  }, [
    capacityDirty,
    capacityHydration,
    capacityRules.data,
    capacityRules.fetchStatus,
    capacityRules.isSuccess,
    capacityScopeKey,
    capacitySnapshotKey,
    open,
  ]);

  function close() {
    setOpen(false);
    setMode("all-applicable");
    setCustomNames(["Manhã", "Tarde", "Noite"]);
    setCapacityValues(emptyCapacityValues());
    setCapacityHydration(null);
    setCapacityDirty(false);
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
      pathname: "/schedule-capacity",
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
    if (
      !capacityReady ||
      plannedCount === 0 ||
      openMonthShifts.isPending ||
      actionLease.isCurrent(openMonthLeaseRef.current)
    ) {
      return;
    }
    const lease = actionLease.capture();
    if (!lease) {
      feedback.error(
        "Sua sessão mudou antes do envio. Confira a instituição ativa e tente novamente.",
      );
      return;
    }
    openMonthLeaseRef.current = lease;
    try {
      const result = await openMonthShifts.mutateAsync({
        hospitalId: selectedContext.hospitalId,
        sectorId: selectedContext.sectorId,
        scheduleContextId: selectedContext.scheduleContextId,
        yearMonth: monthKey,
        mode,
        templateNames: mode === "custom" ? customNames : undefined,
        capacityOverrides: visibleCapacityNames.flatMap((templateName) => {
          const raw = capacityValues[templateName].trim();
          return raw === ""
            ? []
            : [{ templateName, requiredCapacity: Number(raw) }];
        }),
      });
      if (
        openMonthLeaseRef.current !== lease ||
        !actionLease.isCurrent(lease)
      ) {
        return;
      }
      await Promise.allSettled([
        invalidateOfficialScaleAndVacancyQueries(utils),
        utils.shifts.hasMonthShifts.invalidate(),
        utils.filters.hasMonthShifts.invalidate(),
        utils.shifts.rosterStatus.invalidate(),
      ]);
      if (
        openMonthLeaseRef.current !== lease ||
        !actionLease.isCurrent(lease)
      ) {
        return;
      }
      openMonthLeaseRef.current = null;
      onChanged?.();
      feedback.success(openMonthShiftsToast(result.created, result.skipped));
      close();
    } catch (err) {
      if (
        openMonthLeaseRef.current !== lease ||
        !actionLease.isCurrent(lease)
      ) {
        return;
      }
      openMonthLeaseRef.current = null;
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
              keyboardShouldPersistTaps="handled"
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
                  Informe quantos profissionais cada turno deste mês precisa.
                  O padrão é 1. Deixe vazio para manter uma regra semanal já
                  configurada.
                </Text>
                {capacityState === "loading" ? (
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                    <ActivityIndicator size="small" color={theme.colors.primary} />
                    <Text style={{ ...theme.text.body, color: theme.colors.textSecondary }}>
                      Consultando capacidade…
                    </Text>
                  </View>
                ) : null}
                {capacityState === "error" || capacityState === "unresolved" ? (
                  <View style={{ gap: theme.space[2] }}>
                    <Text accessibilityRole="alert" style={{ color: theme.colors.danger }}>
                      {capacityState === "unresolved"
                        ? "A capacidade ainda não foi confirmada. Reconecte e tente novamente."
                        : "Não foi possível conferir a capacidade desta escala."}
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
                {capacityRules.isSuccess &&
                capacityHydration?.snapshotKey === capacitySnapshotKey
                  ? visibleCapacityNames.map((name) => {
                      const rule = capacityRules.data.find(
                        (item) => item.name === name,
                      );
                      const weeklyDetail = rule
                        ? rule.capacities
                            .map(
                              (capacity, weekday) =>
                                `${WEEKDAY_SHORT_LABELS[weekday]} ${capacity}`,
                            )
                            .join(" · ")
                        : "Sem regra anterior · padrão 1";
                      return (
                        <View
                          key={name}
                          style={{
                            flexDirection: "row",
                            alignItems: "center",
                            justifyContent: "space-between",
                            gap: theme.space[3],
                          }}
                        >
                          <View style={{ flex: 1 }}>
                            <Text
                              style={{
                                ...theme.text.body,
                                fontWeight: theme.weight.semibold,
                                color: theme.colors.textPrimary,
                              }}
                            >
                              {name}
                            </Text>
                            <Text
                              style={{
                                ...theme.text.caption,
                                color: theme.colors.textSecondary,
                              }}
                            >
                              {weeklyDetail}
                            </Text>
                          </View>
                          <TextInput
                            accessibilityLabel={`${name}: profissionais necessários neste mês`}
                            editable={
                              (capacityState === "ready" || capacityState === "invalid") &&
                              !openMonthShifts.isPending
                            }
                            keyboardType="number-pad"
                            value={capacityValues[name]}
                            placeholder="Regra"
                            onChangeText={(value) => {
                              setCapacityDirty(true);
                              setCapacityValues((current) => ({
                                ...current,
                                [name]: value,
                              }));
                            }}
                            style={{
                              width: 72,
                              minHeight: 44,
                              paddingHorizontal: theme.space[3],
                              borderWidth: 1,
                              borderColor: theme.colors.borderStrong,
                              borderRadius: theme.radius.md,
                              backgroundColor: theme.colors.surface,
                              color: theme.colors.textPrimary,
                              textAlign: "center",
                            }}
                          />
                        </View>
                      );
                    })
                  : null}
                {capacityState === "invalid" ? (
                  <Text accessibilityRole="alert" style={{ color: theme.colors.danger }}>
                    Informe de 1 a {MAX_SHIFT_CAPACITY} profissionais por turno.
                  </Text>
                ) : null}
                <AppButton
                  title="Configurar por dia da semana"
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

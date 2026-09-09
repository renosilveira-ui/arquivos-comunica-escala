import DateTimePicker from "@react-native-community/datetimepicker";
import { skipToken } from "@tanstack/react-query";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import {
  CalendarClock,
  CakeSlice,
  LockKeyhole,
  Plus,
  Ribbon,
  Trash2,
  X,
  type LucideIcon,
} from "lucide-react-native";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { useAuth } from "@/hooks/use-auth";
import { trpc } from "@/lib/trpc";
import { theme } from "@/lib/theme";
import { stepDayKey } from "@/lib/agenda-month-navigation";
import {
  awaitPersonalAgendaEditorStep,
  capturePersonalAgendaEditorAuthority,
  createPersonalAgendaEditorOperationController,
  createPersonalAgendaEditorSnapshot,
  isPersonalAgendaEditorAuthorityCurrent,
  personalAgendaEditorTargetKey,
  personalAgendaEditorVersionState,
  personalAgendaExpectedVersion,
  reconcilePersonalAgendaEditorCache,
  selectPersonalAgendaMutationRecord,
  selectPersonalAgendaEditorRecord,
  settlePersonalAgendaRefreshes,
  type PersonalAgendaEditorOperation,
  type PersonalAgendaEditorOperationController,
  type PersonalAgendaEditorSnapshot,
  type PersonalAgendaEditorTarget,
} from "@/lib/personal-agenda-editor-state";

type EditorTarget = PersonalAgendaEditorTarget | null;
type ItemKind = "APPOINTMENT" | "REMINDER" | "BIRTHDAY";
type Frequency = "NONE" | "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";
type Termination = "NEVER" | "UNTIL" | "COUNT";

const ALERT_PRESETS = [
  { minutes: 10_080, label: "1 semana" },
  { minutes: 4_320, label: "3 dias" },
  { minutes: 1_440, label: "1 dia" },
  { minutes: 240, label: "4 horas" },
  { minutes: 60, label: "1 hora" },
  { minutes: 30, label: "30 min" },
] as const;
const PRESET_ALERTS = new Set<number>(
  ALERT_PRESETS.map((preset) => preset.minutes),
);
const WEEKDAYS = [
  { bit: 1, label: "D" },
  { bit: 2, label: "S" },
  { bit: 4, label: "T" },
  { bit: 8, label: "Q" },
  { bit: 16, label: "Q" },
  { bit: 32, label: "S" },
  { bit: 64, label: "S" },
] as const;

function deviceTimeZone(): string {
  try {
    return (
      Intl.DateTimeFormat().resolvedOptions().timeZone || "America/Fortaleza"
    );
  } catch {
    return "America/Fortaleza";
  }
}

function makeClientMutationId(): string {
  return `agenda:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 12)}`;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  return "Não foi possível salvar o item da Agenda.";
}

function numberOrNull(value: string): number | null {
  const normalized = value.trim();
  if (!normalized) return null;
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function alertLabel(minutes: number): string {
  const preset = ALERT_PRESETS.find(
    (candidate) => candidate.minutes === minutes,
  );
  if (preset) return preset.label;
  if (minutes % 1_440 === 0) return `${minutes / 1_440} dias`;
  if (minutes % 60 === 0) return `${minutes / 60} horas`;
  return `${minutes} min`;
}

export function PersonalAgendaEditor({
  target,
  onClose,
}: {
  target: EditorTarget;
  onClose: (sessionId: string) => void;
}) {
  if (!target) return null;
  const sessionId = personalAgendaEditorTargetKey(target);
  return (
    <PersonalAgendaEditorOpen
      key={sessionId}
      target={target}
      onClose={() => onClose(sessionId)}
    />
  );
}

function PersonalAgendaEditorOpen({
  target,
  onClose,
}: {
  target: PersonalAgendaEditorTarget;
  onClose: () => void;
}) {
  const { user } = useAuth();
  const utils = trpc.useUtils();
  const itemQuery = trpc.personalCalendar.getItem.useQuery(
    target.itemId === undefined ? skipToken : { itemId: target.itemId },
    { retry: 1 },
  );
  const createItem = trpc.personalCalendar.createItem.useMutation();
  const updateItem = trpc.personalCalendar.updateItem.useMutation();
  const deleteItem = trpc.personalCalendar.deleteItem.useMutation();
  const checkConflicts = trpc.personalCalendar.checkConflicts.useMutation();

  type CreateInput = Parameters<typeof createItem.mutateAsync>[0];
  type ItemInput = CreateInput["item"];
  type RecurrenceInput = CreateInput["recurrence"];

  const [kind, setKind] = useState<ItemKind>("APPOINTMENT");
  const [title, setTitle] = useState("");
  const [locationLabel, setLocationLabel] = useState("");
  const [notes, setNotes] = useState("");
  const [allDay, setAllDay] = useState(false);
  const [startDate, setStartDate] = useState(target.dateKey);
  const [startTime, setStartTime] = useState("09:00");
  const [endDate, setEndDate] = useState(target.dateKey);
  const [endTime, setEndTime] = useState("10:00");
  const [birthdayYear, setBirthdayYear] = useState("");
  const [timeZone, setTimeZone] = useState(deviceTimeZone);
  const [frequency, setFrequency] = useState<Frequency>("NONE");
  const [interval, setInterval] = useState("1");
  const [weekdaysMask, setWeekdaysMask] = useState(
    () => 1 << new Date(`${target.dateKey}T12:00:00`).getDay(),
  );
  const [termination, setTermination] = useState<Termination>("NEVER");
  const [untilDate, setUntilDate] = useState(() =>
    stepDayKey(target.dateKey, 90),
  );
  const [occurrenceCount, setOccurrenceCount] = useState("12");
  const [alertOffsets, setAlertOffsets] = useState<Set<number>>(new Set());
  const [customAlert, setCustomAlert] = useState("");
  const [clientMutationId] = useState(makeClientMutationId);
  const [preservedLocation, setPreservedLocation] = useState<{
    label: string | null;
    provider: string | null;
    externalId: string | null;
    latitude: number | null;
    longitude: number | null;
  }>({
    label: null,
    provider: null,
    externalId: null,
    latitude: null,
    longitude: null,
  });
  const [error, setError] = useState<string | null>(null);
  const [conflictWarning, setConflictWarning] = useState<{
    key: string;
    total: number;
  } | null>(null);
  const [formSnapshot, setFormSnapshot] =
    useState<PersonalAgendaEditorSnapshot | null>(() =>
      createPersonalAgendaEditorSnapshot(target, null),
    );
  const [deleteConfirmationOpen, setDeleteConfirmationOpen] = useState(false);
  const [activeOperation, setActiveOperation] =
    useState<PersonalAgendaEditorOperation | null>(null);
  const sessionActiveRef = useRef(true);
  const currentUserIdRef = useRef<number | null>(user?.id ?? null);
  currentUserIdRef.current = user?.id ?? null;
  const authorityRef = useRef(
    user?.id ? capturePersonalAgendaEditorAuthority(user.id) : null,
  );
  const isEditorAuthorityCurrent = () =>
    sessionActiveRef.current &&
    isPersonalAgendaEditorAuthorityCurrent(
      authorityRef.current,
      currentUserIdRef.current,
    );
  const operationControllerRef =
    useRef<PersonalAgendaEditorOperationController | null>(null);
  if (!operationControllerRef.current) {
    operationControllerRef.current =
      createPersonalAgendaEditorOperationController({
        isSessionActive: isEditorAuthorityCurrent,
        onChange: setActiveOperation,
      });
  }
  const operationController = operationControllerRef.current;

  useEffect(() => {
    sessionActiveRef.current = true;
    return () => {
      sessionActiveRef.current = false;
    };
  }, []);

  const isEditing = target.itemId !== undefined;
  const loaded = selectPersonalAgendaEditorRecord(target, itemQuery.data);
  const versionState = personalAgendaEditorVersionState(
    target,
    formSnapshot,
    loaded,
  );
  const remoteVersionChanged = versionState === "REMOTE_CHANGED";

  useEffect(() => {
    if (!isEditing || formSnapshot || !loaded) return;
    const stored = loaded.item;
    const initialDate =
      stored.kind !== "BIRTHDAY" ? stored.startLocalDate : target.dateKey;
    setKind(stored.kind);
    setTitle(stored.title);
    setLocationLabel(stored.locationLabel ?? "");
    setNotes(stored.notes ?? "");
    setAllDay(stored.allDay);
    setStartDate(initialDate);
    setStartTime(
      stored.kind !== "BIRTHDAY" && !stored.allDay
        ? stored.startLocalTime.slice(0, 5)
        : "09:00",
    );
    setEndDate(
      stored.kind === "APPOINTMENT"
        ? stored.endLocalDate
        : stepDayKey(initialDate, 1),
    );
    setEndTime(
      stored.kind === "APPOINTMENT" && !stored.allDay
        ? stored.endLocalTime.slice(0, 5)
        : "10:00",
    );
    setBirthdayYear(
      stored.kind === "BIRTHDAY" && stored.birthdayYear !== null
        ? String(stored.birthdayYear)
        : "",
    );
    setTimeZone(stored.timeZone);
    const recurrence = loaded.recurrence;
    setFrequency(recurrence?.frequency ?? "NONE");
    setInterval(String(recurrence?.interval ?? 1));
    setWeekdaysMask(
      recurrence?.weekdaysMask ??
        1 << new Date(`${initialDate}T12:00:00`).getDay(),
    );
    setTermination(recurrence?.termination ?? "NEVER");
    setUntilDate(recurrence?.untilLocalDate ?? stepDayKey(initialDate, 90));
    setOccurrenceCount(String(recurrence?.occurrenceCount ?? 12));
    setAlertOffsets(new Set(loaded.alertOffsets));
    setCustomAlert("");
    setPreservedLocation({
      label: stored.locationLabel,
      provider: stored.locationProvider,
      externalId: stored.locationExternalId,
      latitude: stored.latitude,
      longitude: stored.longitude,
    });
    setFormSnapshot(createPersonalAgendaEditorSnapshot(target, loaded));
    setError(null);
    setConflictWarning(null);
  }, [formSnapshot, isEditing, loaded, target]);

  const customOffsets = useMemo(
    () => [...alertOffsets].filter((offset) => !PRESET_ALERTS.has(offset)),
    [alertOffsets],
  );
  const busy =
    activeOperation !== null ||
    createItem.isPending ||
    updateItem.isPending ||
    deleteItem.isPending ||
    checkConflicts.isPending;
  const editorInteractionBlocked = busy || deleteConfirmationOpen;

  const requestEditorClose = () => {
    if (operationController.current() !== null || deleteConfirmationOpen)
      return;
    onClose();
  };

  const toggleAlert = (minutes: number) => {
    setAlertOffsets((current) => {
      const next = new Set(current);
      if (next.has(minutes)) next.delete(minutes);
      else if (next.size < 8) next.add(minutes);
      return next;
    });
    setConflictWarning(null);
  };

  const addCustomAlert = () => {
    const minutes = numberOrNull(customAlert);
    if (minutes === null || minutes < 0 || minutes > 525_600) {
      setError("Informe um aviso customizado entre 0 e 525.600 minutos.");
      return;
    }
    if (alertOffsets.size >= 8 && !alertOffsets.has(minutes)) {
      setError("Cada item pode ter no máximo oito avisos.");
      return;
    }
    setAlertOffsets((current) => new Set(current).add(minutes));
    setCustomAlert("");
    setError(null);
  };

  const buildRecurrence = (): RecurrenceInput => {
    if (frequency === "NONE" || kind === "BIRTHDAY") return null;
    const parsedInterval = numberOrNull(interval);
    if (parsedInterval === null || parsedInterval < 1 || parsedInterval > 100) {
      throw new Error("O intervalo da repetição deve ficar entre 1 e 100.");
    }
    if (frequency === "WEEKLY" && weekdaysMask === 0) {
      throw new Error("Escolha ao menos um dia da semana.");
    }
    const parsedCount = numberOrNull(occurrenceCount);
    if (
      termination === "COUNT" &&
      (parsedCount === null || parsedCount < 1 || parsedCount > 10_000)
    ) {
      throw new Error("Informe entre 1 e 10.000 repetições.");
    }
    if (termination === "UNTIL" && !/^\d{4}-\d{2}-\d{2}$/.test(untilDate)) {
      throw new Error("Informe a data final da repetição.");
    }
    return {
      frequency,
      interval: parsedInterval,
      weekdaysMask: frequency === "WEEKLY" ? weekdaysMask : null,
      invalidDatePolicy: "CLAMP_LAST_DAY",
      termination,
      untilLocalDate: termination === "UNTIL" ? untilDate : null,
      occurrenceCount: termination === "COUNT" ? parsedCount : null,
    };
  };

  const commonItem = () => {
    const normalizedLocation =
      kind === "APPOINTMENT" ? locationLabel.trim() || null : null;
    const locationWasPreserved = normalizedLocation === preservedLocation.label;
    return {
      title: title.trim(),
      locationLabel: normalizedLocation,
      locationProvider: locationWasPreserved
        ? preservedLocation.provider
        : null,
      locationExternalId: locationWasPreserved
        ? preservedLocation.externalId
        : null,
      latitude: locationWasPreserved ? preservedLocation.latitude : null,
      longitude: locationWasPreserved ? preservedLocation.longitude : null,
      notes: notes.trim() || null,
      timeZone,
    };
  };

  const buildItem = (): ItemInput => {
    if (!title.trim()) throw new Error("Informe o título.");
    if (kind === "BIRTHDAY") {
      const [, month, day] = startDate.split("-").map(Number);
      const explicitYear = birthdayYear.trim()
        ? numberOrNull(birthdayYear)
        : null;
      if (
        !/^\d{4}-\d{2}-\d{2}$/.test(startDate) ||
        !month ||
        !day ||
        (birthdayYear.trim() &&
          (explicitYear === null || explicitYear < 1800 || explicitYear > 2200))
      ) {
        throw new Error("Informe uma data de aniversário válida.");
      }
      return {
        ...commonItem(),
        kind: "BIRTHDAY",
        allDay: true,
        availability: "FREE",
        birthdayMonth: month,
        birthdayDay: day,
        birthdayYear: explicitYear,
      };
    }
    if (kind === "REMINDER") {
      return allDay
        ? {
            ...commonItem(),
            kind: "REMINDER",
            allDay: true,
            availability: "FREE",
            startLocalDate: startDate,
          }
        : {
            ...commonItem(),
            kind: "REMINDER",
            allDay: false,
            availability: "FREE",
            startLocalDate: startDate,
            startLocalTime: startTime,
          };
    }
    return allDay
      ? {
          ...commonItem(),
          kind: "APPOINTMENT",
          allDay: true,
          availability: "BUSY",
          startLocalDate: startDate,
          endLocalDate: endDate,
        }
      : {
          ...commonItem(),
          kind: "APPOINTMENT",
          allDay: false,
          availability: "BUSY",
          startLocalDate: startDate,
          startLocalTime: startTime,
          endLocalDate: endDate,
          endLocalTime: endTime,
        };
  };

  const save = async () => {
    if (!isEditorAuthorityCurrent()) return;
    if (isEditing && (!loaded || versionState !== "READY")) {
      setError(
        remoteVersionChanged
          ? "Este item mudou em outro aparelho. Carregue a versão mais recente antes de salvar."
          : "A versão atual do item ainda não está disponível.",
      );
      return;
    }
    try {
      await operationController.run("SAVE", async () => {
        if (!isEditorAuthorityCurrent()) return;
        setError(null);
        const item = buildItem();
        const recurrence = buildRecurrence();
        if (item.kind === "APPOINTMENT") {
          const conflictItem = item.allDay
            ? {
                kind: "APPOINTMENT" as const,
                allDay: true as const,
                availability: item.availability,
                startLocalDate: item.startLocalDate,
                endLocalDate: item.endLocalDate,
                timeZone: item.timeZone,
              }
            : {
                kind: "APPOINTMENT" as const,
                allDay: false as const,
                availability: item.availability,
                startLocalDate: item.startLocalDate,
                startLocalTime: item.startLocalTime,
                endLocalDate: item.endLocalDate,
                endLocalTime: item.endLocalTime,
                timeZone: item.timeZone,
              };
          const previewResult = await awaitPersonalAgendaEditorStep(
            checkConflicts.mutateAsync({
              item: conflictItem,
              recurrence,
              window: {
                fromDate: item.startLocalDate,
                toDate: stepDayKey(item.startLocalDate, 365),
              },
              excludeItemId: target.itemId,
            }),
            isEditorAuthorityCurrent,
          );
          if (!previewResult.current) return;
          const preview = previewResult.value;
          const conflicts = preview.occurrences.filter(
            (occurrence) => occurrence.conflict.hasConflict,
          );
          const conflictKey = conflicts
            .map(
              (occurrence) =>
                `${occurrence.occurrenceKey}:${occurrence.conflict.fingerprint}`,
            )
            .join("|");
          const total = conflicts.reduce(
            (sum, occurrence) => sum + occurrence.conflict.total,
            0,
          );
          if (total > 0 && conflictWarning?.key !== conflictKey) {
            setConflictWarning({ key: conflictKey, total });
            return;
          }
        }

        const alertValues = [...alertOffsets].sort(
          (left, right) => right - left,
        );
        if (isEditing && loaded) {
          const expectedVersion = personalAgendaExpectedVersion(
            target,
            formSnapshot,
            loaded,
          );
          const preMutationCancel = await awaitPersonalAgendaEditorStep(
            utils.personalCalendar.getItem.cancel({ itemId: loaded.id }),
            isEditorAuthorityCurrent,
          );
          if (!preMutationCancel.current) return;
          const updateResult = await awaitPersonalAgendaEditorStep(
            updateItem.mutateAsync({
              itemId: loaded.id,
              expectedVersion,
              item,
              recurrence,
              alertOffsets: alertValues,
            }),
            isEditorAuthorityCurrent,
          );
          if (!updateResult.current) return;
          const updated = updateResult.value;
          const exactRecord = selectPersonalAgendaMutationRecord(
            loaded.id,
            updated,
          );
          if (!exactRecord) {
            throw new Error(
              "O servidor retornou outro item após a atualização.",
            );
          }
          const reconciled = await reconcilePersonalAgendaEditorCache({
            cancelInFlight: () =>
              utils.personalCalendar.getItem.cancel({ itemId: loaded.id }),
            isCurrent: isEditorAuthorityCurrent,
            apply: () =>
              utils.personalCalendar.getItem.setData(
                { itemId: loaded.id },
                exactRecord,
              ),
          });
          if (!reconciled) return;
        } else {
          const createResult = await awaitPersonalAgendaEditorStep(
            createItem.mutateAsync({
              clientMutationId,
              item,
              recurrence,
              alertOffsets: alertValues,
            }),
            isEditorAuthorityCurrent,
          );
          if (!createResult.current) return;
          const created = createResult.value;
          const reconciled = await reconcilePersonalAgendaEditorCache({
            cancelInFlight: () =>
              utils.personalCalendar.getItem.cancel({
                itemId: created.item.id,
              }),
            isCurrent: isEditorAuthorityCurrent,
            apply: () =>
              utils.personalCalendar.getItem.setData(
                { itemId: created.item.id },
                created.item,
              ),
          });
          if (!reconciled) return;
        }
        if (!isEditorAuthorityCurrent()) return;
        await settlePersonalAgendaRefreshes([
          utils.personalCalendar.listWindow.invalidate(),
        ]);
        if (isEditorAuthorityCurrent()) onClose();
      });
    } catch (caught) {
      if (isEditorAuthorityCurrent()) setError(errorMessage(caught));
    }
  };

  const requestDelete = () => {
    if (operationController.current() !== null) return;
    if (!loaded || versionState !== "READY") {
      setError(
        remoteVersionChanged
          ? "Este item mudou em outro aparelho. Carregue a versão mais recente antes de excluir."
          : "A versão atual do item ainda não está disponível.",
      );
      return;
    }
    setDeleteConfirmationOpen(true);
  };

  const performDelete = async () => {
    if (!isEditorAuthorityCurrent()) return;
    if (!loaded || versionState !== "READY") {
      setDeleteConfirmationOpen(false);
      setError(
        remoteVersionChanged
          ? "Este item mudou em outro aparelho. Carregue a versão mais recente antes de excluir."
          : "A versão atual do item ainda não está disponível.",
      );
      return;
    }
    try {
      await operationController.run("DELETE", async () => {
        if (!isEditorAuthorityCurrent()) return;
        setError(null);
        const expectedVersion = personalAgendaExpectedVersion(
          target,
          formSnapshot,
          loaded,
        );
        const preMutationCancel = await awaitPersonalAgendaEditorStep(
          utils.personalCalendar.getItem.cancel({ itemId: loaded.id }),
          isEditorAuthorityCurrent,
        );
        if (!preMutationCancel.current) return;
        const deleteResult = await awaitPersonalAgendaEditorStep(
          deleteItem.mutateAsync({
            itemId: loaded.id,
            expectedVersion,
          }),
          isEditorAuthorityCurrent,
        );
        if (!deleteResult.current) return;
        const deleted = deleteResult.value;
        if (deleted.id !== loaded.id) {
          throw new Error("O servidor retornou outro item após a exclusão.");
        }
        const postMutationCancel = await awaitPersonalAgendaEditorStep(
          utils.personalCalendar.getItem.cancel({ itemId: deleted.id }),
          isEditorAuthorityCurrent,
        );
        if (!postMutationCancel.current) return;
        await settlePersonalAgendaRefreshes([
          utils.personalCalendar.getItem.invalidate({ itemId: deleted.id }),
          utils.personalCalendar.listWindow.invalidate(),
        ]);
        if (isEditorAuthorityCurrent()) onClose();
      });
    } catch (caught) {
      if (isEditorAuthorityCurrent()) {
        setDeleteConfirmationOpen(false);
        setError(errorMessage(caught));
      }
    }
  };

  return (
    <Modal
      visible
      transparent
      animationType="slide"
      onRequestClose={editorInteractionBlocked ? undefined : requestEditorClose}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={{ flex: 1, justifyContent: "flex-end" }}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Fechar editor da Agenda"
          onPress={editorInteractionBlocked ? undefined : requestEditorClose}
          style={{ flex: 1, backgroundColor: theme.colors.overlay }}
        />
        <View
          style={{
            maxHeight: "92%",
            backgroundColor: theme.colors.surface,
            borderTopLeftRadius: theme.radius["2xl"],
            borderTopRightRadius: theme.radius["2xl"],
            ...theme.shadow.lg,
          }}
        >
          <View
            style={{
              minHeight: 56,
              flexDirection: "row",
              alignItems: "center",
              paddingHorizontal: theme.space[4],
              borderBottomWidth: 1,
              borderBottomColor: theme.colors.border,
            }}
          >
            <View style={{ flex: 1 }}>
              <Text
                style={{
                  ...theme.text.titleSm,
                  color: theme.colors.textPrimary,
                  fontWeight: theme.weight.bold,
                }}
              >
                {isEditing ? "Editar item" : "Adicionar à Agenda"}
              </Text>
              <View
                style={{ flexDirection: "row", alignItems: "center", gap: 4 }}
              >
                <LockKeyhole size={11} color={theme.colors.textMuted} />
                <Text
                  style={{
                    ...theme.text.caption,
                    color: theme.colors.textMuted,
                  }}
                >
                  Privado — somente você pode ver
                </Text>
              </View>
            </View>
            <Pressable
              onPress={
                editorInteractionBlocked ? undefined : requestEditorClose
              }
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel="Fechar"
              style={{ padding: theme.space[2] }}
            >
              <X size={22} color={theme.colors.textSecondary} />
            </Pressable>
          </View>

          {isEditing && itemQuery.isError ? (
            <View
              style={{
                minHeight: 240,
                padding: theme.space[6],
                alignItems: "center",
                justifyContent: "center",
                gap: theme.space[3],
              }}
            >
              <Text
                style={{
                  ...theme.text.body,
                  color: theme.colors.danger,
                  textAlign: "center",
                }}
              >
                {errorMessage(itemQuery.error)}
              </Text>
              <EditorButton
                title="Tentar novamente"
                onPress={() => void itemQuery.refetch()}
              />
            </View>
          ) : isEditing && (!loaded || !formSnapshot) ? (
            <View
              style={{
                minHeight: 240,
                alignItems: "center",
                justifyContent: "center",
                gap: theme.space[3],
              }}
            >
              <ActivityIndicator color={theme.colors.primary} />
              <Text
                style={{ ...theme.text.body, color: theme.colors.textMuted }}
              >
                Abrindo item privado…
              </Text>
            </View>
          ) : (
            <ScrollView
              keyboardShouldPersistTaps="handled"
              contentContainerStyle={{
                padding: theme.space[4],
                paddingBottom: theme.space[10],
                gap: theme.space[4],
              }}
              showsVerticalScrollIndicator={false}
            >
              <ChoiceRow
                value={kind}
                options={[
                  {
                    value: "APPOINTMENT",
                    label: "Compromisso",
                    Icon: CalendarClock,
                  },
                  { value: "REMINDER", label: "Lembrete", Icon: Ribbon },
                  {
                    value: "BIRTHDAY",
                    label: "Aniversário",
                    Icon: CakeSlice,
                  },
                ]}
                onChange={(value) => {
                  setKind(value);
                  if (value === "BIRTHDAY") {
                    setAllDay(true);
                    setFrequency("NONE");
                  }
                  setConflictWarning(null);
                }}
              />

              <EditorField label={kind === "BIRTHDAY" ? "Nome" : "Título"}>
                <TextInput
                  value={title}
                  onChangeText={(value) => {
                    setTitle(value);
                    setConflictWarning(null);
                  }}
                  placeholder={
                    kind === "BIRTHDAY"
                      ? "Pessoa aniversariante"
                      : kind === "REMINDER"
                        ? "O que lembrar"
                        : "Nome do compromisso"
                  }
                  placeholderTextColor={theme.colors.textDisabled}
                  maxLength={160}
                  style={inputStyle}
                />
              </EditorField>

              {kind !== "BIRTHDAY" ? (
                <View
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
                        color: theme.colors.textPrimary,
                        fontWeight: theme.weight.semibold,
                      }}
                    >
                      Dia inteiro
                    </Text>
                    <Text
                      style={{
                        ...theme.text.caption,
                        color: theme.colors.textMuted,
                      }}
                    >
                      Sem horário específico
                    </Text>
                  </View>
                  <Switch
                    value={allDay}
                    onValueChange={(value) => {
                      setAllDay(value);
                      if (
                        kind === "APPOINTMENT" &&
                        value &&
                        endDate <= startDate
                      ) {
                        setEndDate(stepDayKey(startDate, 1));
                      }
                      setConflictWarning(null);
                    }}
                    trackColor={{
                      false: theme.colors.borderStrong,
                      true: theme.colors.primary,
                    }}
                  />
                </View>
              ) : null}

              <View style={{ flexDirection: "row", gap: theme.space[3] }}>
                <View style={{ flex: 1 }}>
                  <EditorField label={kind === "BIRTHDAY" ? "Data" : "Início"}>
                    <DateControl
                      value={startDate}
                      onChange={(value) => {
                        setStartDate(value);
                        if (kind === "APPOINTMENT" && endDate < value) {
                          setEndDate(allDay ? stepDayKey(value, 1) : value);
                        }
                        setConflictWarning(null);
                      }}
                    />
                  </EditorField>
                </View>
                {kind !== "BIRTHDAY" && !allDay ? (
                  <View style={{ width: 116 }}>
                    <EditorField label="Hora">
                      <TimeControl
                        value={startTime}
                        onChange={(value) => {
                          setStartTime(value);
                          setConflictWarning(null);
                        }}
                      />
                    </EditorField>
                  </View>
                ) : null}
              </View>

              {kind === "APPOINTMENT" ? (
                <View style={{ flexDirection: "row", gap: theme.space[3] }}>
                  <View style={{ flex: 1 }}>
                    <EditorField label={allDay ? "Fim (não incluído)" : "Fim"}>
                      <DateControl
                        value={endDate}
                        onChange={(value) => {
                          setEndDate(value);
                          setConflictWarning(null);
                        }}
                      />
                    </EditorField>
                  </View>
                  {!allDay ? (
                    <View style={{ width: 116 }}>
                      <EditorField label="Hora">
                        <TimeControl
                          value={endTime}
                          onChange={(value) => {
                            setEndTime(value);
                            setConflictWarning(null);
                          }}
                        />
                      </EditorField>
                    </View>
                  ) : null}
                </View>
              ) : null}

              {kind === "BIRTHDAY" ? (
                <EditorField label="Ano de nascimento (opcional)">
                  <TextInput
                    value={birthdayYear}
                    onChangeText={setBirthdayYear}
                    keyboardType="number-pad"
                    inputMode="numeric"
                    placeholder="Ex.: 1985"
                    placeholderTextColor={theme.colors.textDisabled}
                    maxLength={4}
                    style={inputStyle}
                  />
                </EditorField>
              ) : null}

              {kind === "APPOINTMENT" ? (
                <EditorField label="Local">
                  <TextInput
                    value={locationLabel}
                    onChangeText={setLocationLabel}
                    placeholder="Ex.: consultório, endereço ou hospital"
                    placeholderTextColor={theme.colors.textDisabled}
                    maxLength={255}
                    style={inputStyle}
                  />
                  <Text
                    style={{
                      ...theme.text.caption,
                      color: theme.colors.textMuted,
                    }}
                  >
                    O campo já está preparado para futura busca pelo Google
                    Maps.
                  </Text>
                </EditorField>
              ) : null}

              {kind !== "BIRTHDAY" ? (
                <EditorField label="Repetição">
                  <ChoiceRow
                    value={frequency}
                    compact
                    options={[
                      { value: "NONE", label: "Não repete" },
                      { value: "DAILY", label: "Diária" },
                      { value: "WEEKLY", label: "Semanal" },
                      { value: "MONTHLY", label: "Mensal" },
                      { value: "YEARLY", label: "Anual" },
                    ]}
                    onChange={(value) => {
                      setFrequency(value);
                      setConflictWarning(null);
                    }}
                  />
                </EditorField>
              ) : null}

              {frequency !== "NONE" && kind !== "BIRTHDAY" ? (
                <View style={subsectionStyle}>
                  <EditorField label="Intervalo">
                    <View
                      style={{
                        flexDirection: "row",
                        alignItems: "center",
                        gap: 8,
                      }}
                    >
                      <Text
                        style={{
                          ...theme.text.body,
                          color: theme.colors.textSecondary,
                        }}
                      >
                        A cada
                      </Text>
                      <TextInput
                        value={interval}
                        onChangeText={(value) => {
                          setInterval(value);
                          setConflictWarning(null);
                        }}
                        keyboardType="number-pad"
                        inputMode="numeric"
                        maxLength={3}
                        style={[inputStyle, { width: 64, textAlign: "center" }]}
                      />
                      <Text
                        style={{
                          ...theme.text.body,
                          color: theme.colors.textSecondary,
                        }}
                      >
                        {frequency === "DAILY"
                          ? "dia(s)"
                          : frequency === "WEEKLY"
                            ? "semana(s)"
                            : frequency === "MONTHLY"
                              ? "mês(es)"
                              : "ano(s)"}
                      </Text>
                    </View>
                  </EditorField>

                  {frequency === "WEEKLY" ? (
                    <EditorField label="Dias da semana">
                      <View
                        style={{
                          flexDirection: "row",
                          justifyContent: "space-between",
                          gap: 5,
                        }}
                      >
                        {WEEKDAYS.map((weekday, index) => {
                          const selected = (weekdaysMask & weekday.bit) !== 0;
                          return (
                            <Pressable
                              key={weekday.bit}
                              onPress={() => {
                                setWeekdaysMask((current) =>
                                  selected
                                    ? current & ~weekday.bit
                                    : current | weekday.bit,
                                );
                                setConflictWarning(null);
                              }}
                              accessibilityRole="checkbox"
                              accessibilityState={{ checked: selected }}
                              accessibilityLabel={
                                [
                                  "Domingo",
                                  "Segunda-feira",
                                  "Terça-feira",
                                  "Quarta-feira",
                                  "Quinta-feira",
                                  "Sexta-feira",
                                  "Sábado",
                                ][index]
                              }
                              style={{
                                width: 38,
                                height: 38,
                                borderRadius: 19,
                                alignItems: "center",
                                justifyContent: "center",
                                borderWidth: 1,
                                borderColor: selected
                                  ? theme.colors.primary
                                  : theme.colors.borderStrong,
                                backgroundColor: selected
                                  ? theme.colors.primary
                                  : theme.colors.surface,
                              }}
                            >
                              <Text
                                style={{
                                  ...theme.text.body,
                                  color: selected
                                    ? theme.colors.onDark.text
                                    : theme.colors.textSecondary,
                                  fontWeight: theme.weight.bold,
                                }}
                              >
                                {weekday.label}
                              </Text>
                            </Pressable>
                          );
                        })}
                      </View>
                    </EditorField>
                  ) : null}

                  <EditorField label="Termina">
                    <ChoiceRow
                      value={termination}
                      compact
                      options={[
                        { value: "NEVER", label: "Sem data" },
                        { value: "UNTIL", label: "Em uma data" },
                        { value: "COUNT", label: "Após repetições" },
                      ]}
                      onChange={(value) => {
                        setTermination(value);
                        setConflictWarning(null);
                      }}
                    />
                  </EditorField>
                  {termination === "UNTIL" ? (
                    <DateControl
                      value={untilDate}
                      onChange={(value) => {
                        setUntilDate(value);
                        setConflictWarning(null);
                      }}
                    />
                  ) : termination === "COUNT" ? (
                    <TextInput
                      value={occurrenceCount}
                      onChangeText={(value) => {
                        setOccurrenceCount(value);
                        setConflictWarning(null);
                      }}
                      keyboardType="number-pad"
                      inputMode="numeric"
                      placeholder="Quantidade de ocorrências"
                      placeholderTextColor={theme.colors.textDisabled}
                      style={inputStyle}
                    />
                  ) : null}
                </View>
              ) : null}

              <EditorField label="Avisar antes">
                <View
                  style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}
                >
                  {ALERT_PRESETS.map((preset) => (
                    <ToggleChip
                      key={preset.minutes}
                      label={preset.label}
                      selected={alertOffsets.has(preset.minutes)}
                      onPress={() => toggleAlert(preset.minutes)}
                    />
                  ))}
                  {customOffsets.map((minutes) => (
                    <ToggleChip
                      key={minutes}
                      label={`${alertLabel(minutes)} ×`}
                      selected
                      onPress={() => toggleAlert(minutes)}
                    />
                  ))}
                </View>
                <View style={{ flexDirection: "row", gap: 8 }}>
                  <TextInput
                    value={customAlert}
                    onChangeText={setCustomAlert}
                    keyboardType="number-pad"
                    inputMode="numeric"
                    placeholder="Minutos customizados"
                    placeholderTextColor={theme.colors.textDisabled}
                    style={[inputStyle, { flex: 1 }]}
                  />
                  <Pressable
                    onPress={addCustomAlert}
                    accessibilityRole="button"
                    accessibilityLabel="Adicionar aviso customizado"
                    style={({ pressed }) => ({
                      width: 44,
                      height: 44,
                      borderRadius: theme.radius.md,
                      alignItems: "center",
                      justifyContent: "center",
                      backgroundColor: theme.colors.brand,
                      opacity: pressed ? 0.84 : 1,
                    })}
                  >
                    <Plus size={20} color={theme.colors.onDark.text} />
                  </Pressable>
                </View>
              </EditorField>

              <EditorField label="Anotações">
                <TextInput
                  value={notes}
                  onChangeText={setNotes}
                  placeholder="Informações privadas para você"
                  placeholderTextColor={theme.colors.textDisabled}
                  multiline
                  maxLength={10_000}
                  textAlignVertical="top"
                  style={[inputStyle, { minHeight: 96, paddingTop: 12 }]}
                />
              </EditorField>

              {remoteVersionChanged ? (
                <View
                  accessibilityRole="alert"
                  style={{
                    padding: theme.space[3],
                    gap: theme.space[2],
                    borderRadius: theme.radius.md,
                    borderWidth: 1,
                    borderColor: theme.palette.warning[200],
                    backgroundColor: theme.palette.warning[50],
                  }}
                >
                  <Text
                    style={{
                      ...theme.text.body,
                      color: theme.palette.warning[900],
                      fontWeight: theme.weight.bold,
                    }}
                  >
                    Este item foi alterado em outro aparelho
                  </Text>
                  <Text
                    style={{
                      ...theme.text.caption,
                      color: theme.palette.warning[900],
                    }}
                  >
                    Para não perder a alteração mais recente, recarregue o item
                    antes de salvar ou excluir.
                  </Text>
                  <EditorButton
                    title="Carregar versão mais recente"
                    onPress={() => {
                      setFormSnapshot(null);
                      setConflictWarning(null);
                      setError(null);
                    }}
                  />
                </View>
              ) : null}

              {conflictWarning ? (
                <View
                  accessibilityRole="alert"
                  style={{
                    padding: theme.space[3],
                    gap: 4,
                    borderRadius: theme.radius.md,
                    borderWidth: 1,
                    borderColor: theme.palette.warning[200],
                    backgroundColor: theme.palette.warning[50],
                  }}
                >
                  <Text
                    style={{
                      ...theme.text.body,
                      color: theme.palette.warning[900],
                      fontWeight: theme.weight.bold,
                    }}
                  >
                    Conflito de horário encontrado
                  </Text>
                  <Text
                    style={{
                      ...theme.text.caption,
                      color: theme.palette.warning[900],
                    }}
                  >
                    {countLabel(
                      conflictWarning.total,
                      "sobreposição foi identificada",
                      "sobreposições foram identificadas",
                    )}{" "}
                    nos próximos 12 meses. Revise os horários ou confirme o
                    salvamento.
                  </Text>
                </View>
              ) : null}

              {error ? (
                <Text
                  accessibilityRole="alert"
                  style={{ ...theme.text.body, color: theme.colors.danger }}
                >
                  {error}
                </Text>
              ) : null}

              <View style={{ gap: theme.space[2] }}>
                <EditorButton
                  title={
                    busy
                      ? "Salvando…"
                      : conflictWarning
                        ? "Salvar mesmo assim"
                        : "Salvar"
                  }
                  onPress={() => void save()}
                  disabled={busy || remoteVersionChanged}
                  primary
                />
                {isEditing ? (
                  <EditorButton
                    title="Excluir item"
                    onPress={requestDelete}
                    disabled={busy || remoteVersionChanged}
                    destructive
                    Icon={Trash2}
                  />
                ) : null}
              </View>
            </ScrollView>
          )}
        </View>
        <DeleteConfirmation
          visible={deleteConfirmationOpen}
          busy={activeOperation === "DELETE"}
          onCancel={() => setDeleteConfirmationOpen(false)}
          onConfirm={() => void performDelete()}
        />
      </KeyboardAvoidingView>
    </Modal>
  );
}

function DeleteConfirmation({
  visible,
  busy,
  onCancel,
  onConfirm,
}: {
  visible: boolean;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  if (!visible) return null;
  return (
    <View
      accessibilityViewIsModal
      style={{
        position: "absolute",
        top: 0,
        right: 0,
        bottom: 0,
        left: 0,
        justifyContent: "center",
        backgroundColor: theme.colors.overlay,
        padding: theme.space[5],
      }}
    >
      <View
        style={{
          width: "100%",
          maxWidth: 440,
          alignSelf: "center",
          gap: theme.space[4],
          padding: theme.space[5],
          borderRadius: theme.radius.xl,
          backgroundColor: theme.colors.surface,
          ...theme.shadow.lg,
        }}
      >
        <View style={{ gap: theme.space[2] }}>
          <Text
            accessibilityRole="header"
            style={{
              ...theme.text.title,
              color: theme.colors.textPrimary,
            }}
          >
            Excluir da Agenda?
          </Text>
          <Text
            style={{ ...theme.text.body, color: theme.colors.textSecondary }}
          >
            O item deixará de aparecer em todas as datas da série.
          </Text>
        </View>
        <View style={{ gap: theme.space[2] }}>
          <EditorButton
            title="Cancelar"
            onPress={onCancel}
            disabled={busy}
            accessibilityLabel="Cancelar exclusão"
          />
          <EditorButton
            title={busy ? "Excluindo…" : "Excluir item"}
            onPress={onConfirm}
            disabled={busy}
            destructive
            Icon={Trash2}
            accessibilityLabel="Confirmar exclusão"
          />
        </View>
      </View>
    </View>
  );
}

function countLabel(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function EditorField({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <View style={{ gap: 7 }}>
      <Text
        style={{
          ...theme.text.body,
          color: theme.colors.textPrimary,
          fontWeight: theme.weight.semibold,
        }}
      >
        {label}
      </Text>
      {children}
    </View>
  );
}

function ChoiceRow<T extends string>({
  value,
  options,
  onChange,
  compact = false,
}: {
  value: T;
  options: readonly { value: T; label: string; Icon?: LucideIcon }[];
  onChange: (value: T) => void;
  compact?: boolean;
}) {
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
      {options.map((option) => {
        const selected = option.value === value;
        const Icon = option.Icon;
        return (
          <Pressable
            key={option.value}
            onPress={() => onChange(option.value)}
            accessibilityRole="radio"
            accessibilityState={{ selected }}
            style={({ pressed }) => ({
              minHeight: compact ? 38 : 44,
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "center",
              gap: 6,
              paddingHorizontal: compact ? 10 : 12,
              borderRadius: theme.radius.full,
              borderWidth: 1,
              borderColor: selected
                ? theme.colors.primary
                : theme.colors.borderStrong,
              backgroundColor: selected
                ? theme.colors.primarySoft
                : theme.colors.surface,
              opacity: pressed ? 0.82 : 1,
            })}
          >
            {Icon ? (
              <Icon
                size={15}
                color={selected ? theme.colors.primary : theme.colors.textMuted}
              />
            ) : null}
            <Text
              style={{
                ...theme.text.caption,
                color: selected
                  ? theme.colors.primary
                  : theme.colors.textSecondary,
                fontWeight: selected
                  ? theme.weight.bold
                  : theme.weight.semibold,
              }}
            >
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function ToggleChip({
  label,
  selected,
  onPress,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: selected }}
      style={({ pressed }) => ({
        minHeight: 38,
        justifyContent: "center",
        paddingHorizontal: 11,
        borderRadius: theme.radius.full,
        borderWidth: 1,
        borderColor: selected
          ? theme.colors.primary
          : theme.colors.borderStrong,
        backgroundColor: selected
          ? theme.colors.primarySoft
          : theme.colors.surface,
        opacity: pressed ? 0.82 : 1,
      })}
    >
      <Text
        style={{
          ...theme.text.caption,
          color: selected ? theme.colors.primary : theme.colors.textSecondary,
          fontWeight: theme.weight.semibold,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

function DateControl({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const [showPicker, setShowPicker] = useState(false);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? new Date(`${value}T12:00:00`)
    : new Date();
  return (
    <View style={{ gap: 6 }}>
      <Pressable
        onPress={() => setShowPicker(true)}
        accessibilityRole="button"
        accessibilityLabel={`Escolher data. Atual: ${value}`}
      >
        <View pointerEvents={Platform.OS === "web" ? "auto" : "none"}>
          <TextInput
            value={value}
            onChangeText={onChange}
            editable={Platform.OS === "web"}
            placeholder="AAAA-MM-DD"
            placeholderTextColor={theme.colors.textDisabled}
            maxLength={10}
            style={inputStyle}
          />
        </View>
      </Pressable>
      {showPicker && Platform.OS !== "web" ? (
        <DateTimePicker
          value={date}
          mode="date"
          display={Platform.OS === "ios" ? "inline" : "default"}
          onChange={(event, selected) => {
            setShowPicker(false);
            if (!selected || event.type === "dismissed") return;
            onChange(
              `${selected.getFullYear()}-${String(selected.getMonth() + 1).padStart(2, "0")}-${String(selected.getDate()).padStart(2, "0")}`,
            );
          }}
        />
      ) : null}
    </View>
  );
}

function TimeControl({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const [showPicker, setShowPicker] = useState(false);
  const [hour, minute] = value.split(":").map(Number);
  const date = new Date();
  date.setHours(
    Number.isFinite(hour) ? hour : 9,
    Number.isFinite(minute) ? minute : 0,
    0,
    0,
  );
  return (
    <View style={{ gap: 6 }}>
      <Pressable
        onPress={() => setShowPicker(true)}
        accessibilityRole="button"
        accessibilityLabel={`Escolher horário. Atual: ${value}`}
      >
        <View pointerEvents={Platform.OS === "web" ? "auto" : "none"}>
          <TextInput
            value={value}
            onChangeText={onChange}
            editable={Platform.OS === "web"}
            placeholder="HH:MM"
            placeholderTextColor={theme.colors.textDisabled}
            maxLength={5}
            style={inputStyle}
          />
        </View>
      </Pressable>
      {showPicker && Platform.OS !== "web" ? (
        <DateTimePicker
          value={date}
          mode="time"
          is24Hour
          display={Platform.OS === "ios" ? "spinner" : "default"}
          onChange={(event, selected) => {
            setShowPicker(false);
            if (!selected || event.type === "dismissed") return;
            onChange(
              `${String(selected.getHours()).padStart(2, "0")}:${String(selected.getMinutes()).padStart(2, "0")}`,
            );
          }}
        />
      ) : null}
    </View>
  );
}

function EditorButton({
  title,
  onPress,
  accessibilityLabel,
  disabled = false,
  primary = false,
  destructive = false,
  Icon,
}: {
  title: string;
  onPress: () => void;
  accessibilityLabel?: string;
  disabled?: boolean;
  primary?: boolean;
  destructive?: boolean;
  Icon?: LucideIcon;
}) {
  const backgroundColor = primary
    ? theme.colors.brand
    : destructive
      ? theme.palette.danger[50]
      : theme.colors.surface;
  const color = primary
    ? theme.colors.onDark.text
    : destructive
      ? theme.colors.danger
      : theme.colors.textPrimary;
  return (
    <Pressable
      onPress={disabled ? undefined : onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? title}
      accessibilityState={{ disabled, busy: disabled }}
      style={({ pressed }) => ({
        minHeight: 46,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: 7,
        paddingHorizontal: theme.space[4],
        borderRadius: theme.radius.md,
        borderWidth: primary ? 0 : 1,
        borderColor: destructive
          ? theme.palette.danger[200]
          : theme.colors.borderStrong,
        backgroundColor,
        opacity: disabled ? 0.5 : pressed ? 0.84 : 1,
      })}
    >
      {Icon ? <Icon size={17} color={color} /> : null}
      <Text
        style={{
          ...theme.text.body,
          color,
          fontWeight: theme.weight.bold,
        }}
      >
        {title}
      </Text>
    </Pressable>
  );
}

const inputStyle = {
  minHeight: 44,
  paddingHorizontal: theme.space[3],
  paddingVertical: theme.space[2],
  borderRadius: theme.radius.md,
  borderWidth: 1,
  borderColor: theme.colors.borderStrong,
  backgroundColor: theme.colors.surface,
  color: theme.colors.textPrimary,
  fontSize: theme.text.body.fontSize,
} as const;

const subsectionStyle = {
  gap: theme.space[3],
  padding: theme.space[3],
  borderRadius: theme.radius.lg,
  borderWidth: 1,
  borderColor: theme.colors.border,
  backgroundColor: theme.colors.surfaceAlt,
} as const;

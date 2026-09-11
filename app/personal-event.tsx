import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Platform,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Trash2 } from "lucide-react-native";

import { ScreenContainer } from "@/components/ui/ScreenContainer";
import { ScreenGradient } from "@/components/ui/ScreenGradient";
import { QueryErrorState } from "@/components/ui/QueryErrorState";
import { SkeletonList } from "@/components/ui/Skeleton";
import { AppButton } from "@/components/ui/AppButton";
import { useActionFeedback } from "@/hooks/use-action-feedback";
import { theme } from "@/lib/theme";
import { trpc } from "@/lib/trpc";
import {
  ALERT_OFFSET_OPTIONS,
  PERSONAL_CALENDAR_KIND_LABELS,
  WEEKDAY_SHORT_LABELS,
  conflictSummaryText,
  dayKeyInTimeZone,
  recurrenceSummary,
  weekdayIndexForDayKey,
  weekdayIndexesFromMask,
  weekdaysMaskFromIndexes,
  type PersonalCalendarKind,
} from "@/lib/personal-calendar-view";

/**
 * Criar, ver, editar e excluir um compromisso pessoal.
 *
 * Recurso da CONTA: nenhum campo aqui recebe instituição, hospital ou setor,
 * e nenhum papel institucional autoriza abrir esta tela para outra pessoa. A
 * autoridade é a sessão.
 *
 * A prévia de conflito consulta os plantões PRÓPRIOS do usuário em todas as
 * instituições dele — é informação para ele decidir, e nunca altera escala.
 */

const KIND_OPTIONS: PersonalCalendarKind[] = [
  "APPOINTMENT",
  "REMINDER",
  "BIRTHDAY",
];

function deviceTimeZone(): string {
  try {
    return (
      Intl.DateTimeFormat().resolvedOptions().timeZone || "America/Sao_Paulo"
    );
  } catch {
    return "America/Sao_Paulo";
  }
}

function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <View style={{ gap: theme.space[1] }}>
      <Text
        style={{
          fontSize: theme.text.caption.fontSize,
          fontWeight: "600",
          color: theme.colors.textSecondary,
        }}
      >
        {label}
      </Text>
      {children}
      {hint ? (
        <Text
          style={{
            fontSize: theme.text.caption.fontSize,
            color: theme.colors.textMuted,
          }}
        >
          {hint}
        </Text>
      ) : null}
    </View>
  );
}

function Input({
  value,
  onChangeText,
  placeholder,
  accessibilityLabel,
  keyboardType,
  maxLength,
  multiline,
}: {
  value: string;
  onChangeText: (next: string) => void;
  placeholder?: string;
  accessibilityLabel: string;
  keyboardType?: "default" | "numeric";
  maxLength?: number;
  multiline?: boolean;
}) {
  return (
    <TextInput
      value={value}
      onChangeText={onChangeText}
      placeholder={placeholder}
      placeholderTextColor={theme.colors.textDisabled}
      accessibilityLabel={accessibilityLabel}
      keyboardType={keyboardType}
      maxLength={maxLength}
      multiline={multiline}
      style={{
        minHeight: multiline ? 88 : 44,
        paddingHorizontal: theme.space[3],
        paddingVertical: theme.space[2],
        borderRadius: theme.radius.md,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface,
        color: theme.colors.textPrimary,
        fontSize: theme.text.body.fontSize,
        textAlignVertical: multiline ? "top" : "center",
      }}
    />
  );
}

function Chip({
  label,
  selected,
  onPress,
  accessibilityLabel,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
  accessibilityLabel?: string;
}) {
  return (
    <TouchableOpacity
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={accessibilityLabel ?? label}
      style={{
        minHeight: 36,
        paddingHorizontal: theme.space[3],
        justifyContent: "center",
        borderRadius: theme.radius.full,
        borderWidth: 1,
        borderColor: selected ? theme.colors.primary : theme.colors.border,
        backgroundColor: selected
          ? theme.colors.primarySoft
          : theme.colors.surface,
      }}
    >
      <Text
        style={{
          fontSize: theme.text.body.fontSize,
          fontWeight: selected ? "600" : "500",
          color: selected ? theme.colors.primary : theme.colors.textSecondary,
        }}
      >
        {label}
      </Text>
    </TouchableOpacity>
  );
}

export default function PersonalEventScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ itemId?: string; dayKey?: string }>();
  const feedback = useActionFeedback();
  const utils = trpc.useUtils();
  const timeZone = useMemo(deviceTimeZone, []);
  const itemId = params.itemId ? Number(params.itemId) : null;
  const isEditing = Number.isInteger(itemId) && (itemId ?? 0) > 0;

  const defaultDay = params.dayKey || dayKeyInTimeZone(new Date(), timeZone);

  const [kind, setKind] = useState<PersonalCalendarKind>("APPOINTMENT");
  const [title, setTitle] = useState("");
  const [locationLabel, setLocationLabel] = useState("");
  const [notes, setNotes] = useState("");
  const [allDay, setAllDay] = useState(false);
  const [busy, setBusy] = useState(true);
  const [startDate, setStartDate] = useState(defaultDay);
  const [startTime, setStartTime] = useState("08:00");
  const [endDate, setEndDate] = useState(defaultDay);
  const [endTime, setEndTime] = useState("09:00");
  const [birthdayDay, setBirthdayDay] = useState("1");
  const [birthdayMonth, setBirthdayMonth] = useState("1");
  const [birthdayYear, setBirthdayYear] = useState("");
  const [alertOffsets, setAlertOffsets] = useState<number[]>([]);
  const [repeats, setRepeats] = useState(false);
  const [frequency, setFrequency] = useState<
    "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY"
  >("WEEKLY");
  const [interval, setIntervalValue] = useState("1");
  const [weekdays, setWeekdays] = useState<number[]>([
    weekdayIndexForDayKey(defaultDay),
  ]);
  const [expectedVersion, setExpectedVersion] = useState<number | null>(null);
  const [loadedFor, setLoadedFor] = useState<number | null>(null);

  const itemQuery = trpc.personalCalendar.getItem.useQuery(
    { itemId: itemId ?? 0 },
    { enabled: isEditing },
  );

  // Hidrata o formulário uma vez por item carregado. Reexecutar a cada
  // render descartaria o que o usuário já digitou.
  useEffect(() => {
    const data = itemQuery.data;
    if (!data || loadedFor === data.id) return;
    const item = data.item as Record<string, unknown>;
    setLoadedFor(data.id);
    setExpectedVersion(data.version);
    setKind(item.kind as PersonalCalendarKind);
    setTitle(String(item.title ?? ""));
    setLocationLabel(String(item.locationLabel ?? ""));
    setNotes(String(item.notes ?? ""));
    setAllDay(Boolean(item.allDay));
    setBusy(item.availability === "BUSY");
    if (item.kind === "BIRTHDAY") {
      setBirthdayDay(String(item.birthdayDay ?? 1));
      setBirthdayMonth(String(item.birthdayMonth ?? 1));
      setBirthdayYear(item.birthdayYear ? String(item.birthdayYear) : "");
    } else {
      setStartDate(String(item.startLocalDate ?? defaultDay));
      setStartTime(String(item.startLocalTime ?? "08:00").slice(0, 5));
      setEndDate(
        String(item.endLocalDate ?? item.startLocalDate ?? defaultDay),
      );
      setEndTime(String(item.endLocalTime ?? "09:00").slice(0, 5));
    }
    setAlertOffsets(
      Array.isArray(data.alertOffsets) ? (data.alertOffsets as number[]) : [],
    );
    const recurrence = data.recurrence as Record<string, unknown> | null;
    if (recurrence) {
      setRepeats(true);
      setFrequency(recurrence.frequency as typeof frequency);
      setIntervalValue(String(recurrence.interval ?? 1));
      if (recurrence.weekdaysMask) {
        setWeekdays(weekdayIndexesFromMask(Number(recurrence.weekdaysMask)));
      }
    }
  }, [itemQuery.data, loadedFor, defaultDay]);

  const clientMutationId = useMemo(
    () =>
      `pc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    [],
  );

  const buildItem = useCallback(() => {
    const base = {
      title: title.trim(),
      locationLabel: locationLabel.trim() || null,
      notes: notes.trim() || null,
      timeZone,
      locationProvider: null,
      locationExternalId: null,
      latitude: null,
      longitude: null,
    };
    if (kind === "BIRTHDAY") {
      return {
        ...base,
        kind: "BIRTHDAY" as const,
        allDay: true as const,
        availability: "FREE" as const,
        birthdayDay: Number(birthdayDay) || 1,
        birthdayMonth: Number(birthdayMonth) || 1,
        birthdayYear: birthdayYear ? Number(birthdayYear) : null,
      };
    }
    if (kind === "REMINDER") {
      return allDay
        ? {
            ...base,
            kind: "REMINDER" as const,
            allDay: true as const,
            availability: "FREE" as const,
            startLocalDate: startDate,
          }
        : {
            ...base,
            kind: "REMINDER" as const,
            allDay: false as const,
            availability: "FREE" as const,
            startLocalDate: startDate,
            startLocalTime: startTime,
          };
    }
    return allDay
      ? {
          ...base,
          kind: "APPOINTMENT" as const,
          allDay: true as const,
          availability: busy ? ("BUSY" as const) : ("FREE" as const),
          startLocalDate: startDate,
          // Dia inteiro tem fim exclusivo: o domínio exige ao menos 1 dia.
          endLocalDate: endDate > startDate ? endDate : addOneDay(startDate),
        }
      : {
          ...base,
          kind: "APPOINTMENT" as const,
          allDay: false as const,
          availability: busy ? ("BUSY" as const) : ("FREE" as const),
          startLocalDate: startDate,
          startLocalTime: startTime,
          endLocalDate: endDate,
          endLocalTime: endTime,
        };
  }, [
    kind,
    title,
    locationLabel,
    notes,
    timeZone,
    allDay,
    busy,
    startDate,
    startTime,
    endDate,
    endTime,
    birthdayDay,
    birthdayMonth,
    birthdayYear,
  ]);

  const buildRecurrence = useCallback(() => {
    if (!repeats || kind === "BIRTHDAY") return null;
    return {
      frequency,
      interval: Math.max(1, Number(interval) || 1),
      weekdaysMask:
        frequency === "WEEKLY"
          ? weekdaysMaskFromIndexes(weekdays.length ? weekdays : [0])
          : null,
      invalidDatePolicy: "SKIP" as const,
      termination: "NEVER" as const,
      untilLocalDate: null,
      occurrenceCount: null,
    };
  }, [repeats, kind, frequency, interval, weekdays]);

  const conflictPreview = trpc.personalCalendar.checkConflicts.useMutation();
  const [conflictText, setConflictText] = useState<string | null>(null);

  // Só compromisso com horário ocupa agenda: lembrete e aniversário nunca
  // conflitam, e pedir prévia para eles gastaria requisição à toa.
  const canPreviewConflict = kind === "APPOINTMENT" && !allDay && busy;

  useEffect(() => {
    if (!canPreviewConflict || !title.trim()) {
      setConflictText(null);
      return;
    }
    let cancelled = false;
    const handle = setTimeout(() => {
      conflictPreview
        .mutateAsync({
          item: {
            kind: "APPOINTMENT",
            allDay: false,
            availability: "BUSY",
            startLocalDate: startDate,
            startLocalTime: startTime,
            endLocalDate: endDate,
            endLocalTime: endTime,
            timeZone,
          },
          recurrence: null,
          window: { fromDate: startDate, toDate: endDate },
          ...(isEditing && itemId ? { excludeItemId: itemId } : {}),
        })
        .then((result) => {
          if (cancelled) return;
          const withConflict = result.occurrences.find(
            (occurrence) => occurrence.conflict?.hasConflict,
          );
          setConflictText(
            withConflict
              ? conflictSummaryText(withConflict.conflict as never)
              : null,
          );
        })
        .catch(() => {
          // Prévia é auxiliar: falha dela não pode bloquear o salvamento.
          if (!cancelled) setConflictText(null);
        });
    }, 500);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    canPreviewConflict,
    title,
    startDate,
    startTime,
    endDate,
    endTime,
    timeZone,
    isEditing,
    itemId,
  ]);

  const invalidate = useCallback(() => {
    utils.personalCalendar.listWindow.invalidate();
    if (itemId) utils.personalCalendar.getItem.invalidate({ itemId });
  }, [utils, itemId]);

  const createMutation = trpc.personalCalendar.createItem.useMutation({
    onSuccess: () => {
      invalidate();
      feedback.success("Compromisso criado.");
      router.back();
    },
    onError: (error) => feedback.error(error.message),
  });

  const updateMutation = trpc.personalCalendar.updateItem.useMutation({
    onSuccess: () => {
      invalidate();
      feedback.success("Compromisso atualizado.");
      router.back();
    },
    onError: (error) => feedback.error(error.message),
  });

  const deleteMutation = trpc.personalCalendar.deleteItem.useMutation({
    onSuccess: () => {
      invalidate();
      feedback.success("Compromisso excluído.");
      router.back();
    },
    onError: (error) => feedback.error(error.message),
  });

  const saving =
    createMutation.isPending ||
    updateMutation.isPending ||
    deleteMutation.isPending;

  const external = itemQuery.data?.external ?? null;

  const submit = useCallback(() => {
    if (external) {
      feedback.error(
        "Este compromisso vem do seu Google Agenda. Edite ou apague lá; o Escala+ acompanha na próxima sincronização.",
      );
      return;
    }
    if (!title.trim()) {
      feedback.error("Informe um título para o compromisso.");
      return;
    }
    const item = buildItem();
    const recurrence = buildRecurrence();
    if (isEditing && itemId && expectedVersion !== null) {
      updateMutation.mutate({
        itemId,
        expectedVersion,
        item: item as never,
        recurrence: recurrence as never,
        alertOffsets,
      });
      return;
    }
    createMutation.mutate({
      clientMutationId,
      item: item as never,
      recurrence: recurrence as never,
      alertOffsets,
    });
  }, [
    external,
    title,
    buildItem,
    buildRecurrence,
    isEditing,
    itemId,
    expectedVersion,
    alertOffsets,
    clientMutationId,
    createMutation,
    updateMutation,
    feedback,
  ]);

  const remove = useCallback(async () => {
    if (!itemId || expectedVersion === null) return;
    const confirmed = await feedback.confirmDestructive(
      "Excluir compromisso",
      "Esta ação não pode ser desfeita.",
      "Excluir",
    );
    if (!confirmed) return;
    deleteMutation.mutate({ itemId, expectedVersion });
  }, [itemId, expectedVersion, feedback, deleteMutation]);

  if (isEditing && itemQuery.isLoading) {
    return (
      <ScreenGradient>
        <ScreenContainer>
          <SkeletonList count={5} />
        </ScreenContainer>
      </ScreenGradient>
    );
  }

  if (isEditing && itemQuery.isError) {
    return (
      <ScreenGradient>
        <ScreenContainer>
          <QueryErrorState
            title="Não foi possível carregar o compromisso"
            error={itemQuery.error}
            onRetry={() => {
              itemQuery.refetch();
            }}
          />
        </ScreenContainer>
      </ScreenGradient>
    );
  }

  return (
    <ScreenGradient>
      <ScreenContainer>
        <View style={{ gap: theme.space[4], paddingBottom: theme.space[10] }}>
          <Text
            style={{
              fontSize: theme.text.titleLg.fontSize,
              fontWeight: "700",
              color: theme.colors.textPrimary,
            }}
          >
            {isEditing ? "Editar compromisso" : "Novo compromisso"}
          </Text>
          {external ? (
            <Text
              style={{
                fontSize: theme.text.body.fontSize,
                lineHeight: theme.text.body.lineHeight,
                color: theme.colors.textSecondary,
              }}
            >
              Este compromisso vem do seu Google Agenda. Para editar ou apagar,
              use o Google — o Escala+ acompanha na próxima sincronização.
            </Text>
          ) : null}

          <Field label="Tipo">
            <View style={{ flexDirection: "row", gap: theme.space[2] }}>
              {KIND_OPTIONS.map((option) => (
                <Chip
                  key={option}
                  label={PERSONAL_CALENDAR_KIND_LABELS[option]}
                  selected={kind === option}
                  onPress={() => {
                    setKind(option);
                    if (option === "BIRTHDAY") setRepeats(false);
                  }}
                />
              ))}
            </View>
          </Field>

          <Field label="Título">
            <Input
              value={title}
              onChangeText={setTitle}
              placeholder="Consulta, reunião, aniversário…"
              accessibilityLabel="Título do compromisso"
              maxLength={160}
            />
          </Field>

          {kind === "BIRTHDAY" ? (
            <View style={{ flexDirection: "row", gap: theme.space[3] }}>
              <View style={{ flex: 1 }}>
                <Field label="Dia">
                  <Input
                    value={birthdayDay}
                    onChangeText={setBirthdayDay}
                    accessibilityLabel="Dia do aniversário"
                    keyboardType="numeric"
                    maxLength={2}
                  />
                </Field>
              </View>
              <View style={{ flex: 1 }}>
                <Field label="Mês">
                  <Input
                    value={birthdayMonth}
                    onChangeText={setBirthdayMonth}
                    accessibilityLabel="Mês do aniversário"
                    keyboardType="numeric"
                    maxLength={2}
                  />
                </Field>
              </View>
              <View style={{ flex: 1 }}>
                <Field label="Ano" hint="opcional">
                  <Input
                    value={birthdayYear}
                    onChangeText={setBirthdayYear}
                    accessibilityLabel="Ano de nascimento (opcional)"
                    keyboardType="numeric"
                    maxLength={4}
                  />
                </Field>
              </View>
            </View>
          ) : (
            <>
              <View style={{ flexDirection: "row", gap: theme.space[2] }}>
                <Chip
                  label={allDay ? "Dia inteiro" : "Com horário"}
                  selected
                  onPress={() => setAllDay((previous) => !previous)}
                  accessibilityLabel={
                    allDay
                      ? "Dia inteiro. Toque para definir horário."
                      : "Com horário. Toque para marcar dia inteiro."
                  }
                />
                {kind === "APPOINTMENT" ? (
                  <Chip
                    label={busy ? "Ocupa horário" : "Não ocupa"}
                    selected={busy}
                    onPress={() => setBusy((previous) => !previous)}
                  />
                ) : null}
              </View>

              <View style={{ flexDirection: "row", gap: theme.space[3] }}>
                <View style={{ flex: 2 }}>
                  <Field label="Início" hint="AAAA-MM-DD">
                    <Input
                      value={startDate}
                      onChangeText={setStartDate}
                      accessibilityLabel="Data de início"
                      maxLength={10}
                    />
                  </Field>
                </View>
                {!allDay ? (
                  <View style={{ flex: 1 }}>
                    <Field label="Hora" hint="HH:MM">
                      <Input
                        value={startTime}
                        onChangeText={setStartTime}
                        accessibilityLabel="Hora de início"
                        maxLength={5}
                      />
                    </Field>
                  </View>
                ) : null}
              </View>

              {kind === "APPOINTMENT" ? (
                <View style={{ flexDirection: "row", gap: theme.space[3] }}>
                  <View style={{ flex: 2 }}>
                    <Field label="Fim" hint="AAAA-MM-DD">
                      <Input
                        value={endDate}
                        onChangeText={setEndDate}
                        accessibilityLabel="Data de término"
                        maxLength={10}
                      />
                    </Field>
                  </View>
                  {!allDay ? (
                    <View style={{ flex: 1 }}>
                      <Field label="Hora" hint="HH:MM">
                        <Input
                          value={endTime}
                          onChangeText={setEndTime}
                          accessibilityLabel="Hora de término"
                          maxLength={5}
                        />
                      </Field>
                    </View>
                  ) : null}
                </View>
              ) : null}
            </>
          )}

          {conflictText ? (
            <View
              style={{
                padding: theme.space[3],
                borderRadius: theme.radius.md,
                backgroundColor: theme.colors.warningSoft,
                borderWidth: 1,
                borderColor: theme.colors.warning,
              }}
            >
              <Text
                style={{
                  fontSize: theme.text.body.fontSize,
                  color: theme.colors.textPrimary,
                  fontWeight: "600",
                }}
              >
                {conflictText}
              </Text>
              <Text
                style={{
                  fontSize: theme.text.caption.fontSize,
                  color: theme.colors.textSecondary,
                  marginTop: 2,
                }}
              >
                Você pode salvar mesmo assim. Isto não altera sua escala.
              </Text>
            </View>
          ) : null}

          <Field label="Local" hint="opcional">
            <Input
              value={locationLabel}
              onChangeText={setLocationLabel}
              placeholder="Clínica, endereço, sala…"
              accessibilityLabel="Local do compromisso"
              maxLength={255}
            />
          </Field>

          <Field label="Alertas">
            <View
              style={{
                flexDirection: "row",
                flexWrap: "wrap",
                gap: theme.space[2],
              }}
            >
              {ALERT_OFFSET_OPTIONS.map((option) => (
                <Chip
                  key={option.minutes}
                  label={option.label}
                  selected={alertOffsets.includes(option.minutes)}
                  onPress={() =>
                    setAlertOffsets((previous) =>
                      previous.includes(option.minutes)
                        ? previous.filter((value) => value !== option.minutes)
                        : [...previous, option.minutes].slice(0, 8),
                    )
                  }
                />
              ))}
            </View>
          </Field>

          {kind !== "BIRTHDAY" ? (
            <Field
              label="Repetição"
              hint={recurrenceSummary(
                repeats
                  ? {
                      frequency,
                      interval: Number(interval) || 1,
                      weekdaysMask:
                        frequency === "WEEKLY"
                          ? weekdaysMaskFromIndexes(weekdays)
                          : null,
                      termination: "NEVER",
                      untilLocalDate: null,
                      occurrenceCount: null,
                    }
                  : null,
              )}
            >
              <View
                style={{
                  flexDirection: "row",
                  flexWrap: "wrap",
                  gap: theme.space[2],
                }}
              >
                <Chip
                  label="Não repete"
                  selected={!repeats}
                  onPress={() => setRepeats(false)}
                />
                {(
                  [
                    ["DAILY", "Diária"],
                    ["WEEKLY", "Semanal"],
                    ["MONTHLY", "Mensal"],
                    ["YEARLY", "Anual"],
                  ] as const
                ).map(([value, label]) => (
                  <Chip
                    key={value}
                    label={label}
                    selected={repeats && frequency === value}
                    onPress={() => {
                      setRepeats(true);
                      setFrequency(value);
                    }}
                  />
                ))}
              </View>
              {repeats && frequency === "WEEKLY" ? (
                <View
                  style={{
                    flexDirection: "row",
                    flexWrap: "wrap",
                    gap: theme.space[2],
                    marginTop: theme.space[2],
                  }}
                >
                  {WEEKDAY_SHORT_LABELS.map((label, index) => (
                    <Chip
                      key={label}
                      label={label}
                      selected={weekdays.includes(index)}
                      onPress={() =>
                        setWeekdays((previous) =>
                          previous.includes(index)
                            ? previous.filter((value) => value !== index)
                            : [...previous, index],
                        )
                      }
                    />
                  ))}
                </View>
              ) : null}
            </Field>
          ) : null}

          <Field label="Anotações" hint="Visível só para você">
            <Input
              value={notes}
              onChangeText={setNotes}
              placeholder="Detalhes que só você precisa ver"
              accessibilityLabel="Anotações privadas"
              maxLength={10_000}
              multiline
            />
          </Field>

          <AppButton
            title={saving ? "Salvando…" : "Salvar"}
            onPress={submit}
            variant="primary"
            fullWidth
            disabled={saving || Boolean(external)}
          />

          {isEditing ? (
            <TouchableOpacity
              onPress={remove}
              disabled={saving || Boolean(external)}
              accessibilityRole="button"
              accessibilityLabel="Excluir compromisso"
              style={{
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "center",
                gap: theme.space[2],
                minHeight: 44,
              }}
            >
              <Trash2 size={18} color={theme.colors.danger} />
              <Text
                style={{
                  fontSize: theme.text.body.fontSize,
                  fontWeight: "600",
                  color: theme.colors.danger,
                }}
              >
                Excluir
              </Text>
            </TouchableOpacity>
          ) : null}
        </View>
      </ScreenContainer>
    </ScreenGradient>
  );
}

function addOneDay(dayKey: string): string {
  const [year, month, day] = dayKey.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + 1))
    .toISOString()
    .slice(0, 10);
}

// Platform é importado para manter paridade de comportamento futura entre
// web e nativo no seletor de data; nenhuma API web-only é usada aqui.
void Platform;

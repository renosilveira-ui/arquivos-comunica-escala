// components/agenda/ManagerActionsMenu.tsx — ações do gestor na Agenda.
//
// Replicar semana/mês, publicar e bloquear o mês já existiam no servidor
// (shifts.replicateRange / publish / lock) sem nenhum botão na tela.
// Aqui: um único menu, contextual ao período que o gestor está vendo.
//
// Replicar faz um dryRun primeiro e mostra "12 novos · 3 já existem"
// antes de confirmar; o resultado vira toast e a Agenda recarrega.

import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Modal, Platform, Pressable, ScrollView, Switch, Text, TextInput, View } from "react-native";
import * as Haptics from "expo-haptics";
import { CalendarRange, CopyPlus, Lock, Send, Settings2, X } from "lucide-react-native";
import { trpc } from "@/lib/trpc";
import { theme } from "@/lib/theme";
import { MEDICAL_SPECIALTIES } from "@/lib/medical-specialties";
import { useActionFeedback } from "@/hooks/use-action-feedback";
import { AppButton } from "@/components/ui/AppButton";
import { toLocalISODateString } from "@/lib/datetime-utils";
import {
  calendarOpenBaseHint,
  calendarOpenConfirmTitle,
  calendarOpenOriginFromPreviousMonth,
  calendarOpenPreviewTitle,
  nextMonthKey,
  sourceMonthForCalendarTarget,
  type CalendarOpenOrigin,
} from "@/lib/agenda-month-navigation";

export type ManagerPeriod =
  | { kind: "week"; weekStart: string } // YYYY-MM-DD (segunda)
  | { kind: "month"; monthKey: string }; // YYYY-MM

interface Props {
  institutionId: number | null;
  period: ManagerPeriod;
  /** Destino explícito ao abrir um mês ainda sem plantões. */
  calendarTargetMonth?: string;
  selectedScheduleContext?: {
    hospitalId: number;
    sectorId: number;
    scheduleContextId?: number;
    id?: number;
  } | null;
  onChanged?: () => void;
  /**
   * "button" (padrão): só o botão "Ações".
   * "strip": faixa de largura cheia com o STATUS da escala do mês
   * ("Agosto · rascunho") e o botão ao lado — o estado que decide se
   * publicar/bloquear está disponível passa a ser lido antes do toque
   * (proposta de design 23/08), como a contagem de Solicitações no Perfil.
   * "empty-state": ação primária "Abrir calendário de [mês]", visível
   * fora do menu overflow.
   */
  variant?: "button" | "strip" | "empty-state";
}

type Step = "menu" | "replicate" | "specialties" | "busy";

const MONTHS_PT = [
  "janeiro", "fevereiro", "março", "abril", "maio", "junho",
  "julho", "agosto", "setembro", "outubro", "novembro", "dezembro",
];

function addDaysKey(dateKey: string, days: number): string {
  const d = new Date(`${dateKey}T12:00:00`);
  d.setDate(d.getDate() + days);
  return toLocalISODateString(d);
}

function monthLabel(monthKey: string): string {
  const [y, m] = monthKey.split("-").map(Number);
  return `${MONTHS_PT[m - 1]} de ${y}`;
}

function weekLabel(weekStart: string): string {
  const s = new Date(`${weekStart}T12:00:00`);
  const e = new Date(`${addDaysKey(weekStart, 6)}T12:00:00`);
  const f = (d: Date) => `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}`;
  return `${f(s)} – ${f(e)}`;
}

const ROSTER_LABEL: Record<string, string> = {
  DRAFT: "Rascunho",
  PUBLISHED: "Publicada",
  LOCKED: "Bloqueada",
};

export function ManagerActionsMenu({
  institutionId,
  period,
  calendarTargetMonth: requestedCalendarTargetMonth,
  selectedScheduleContext = null,
  onChanged,
  variant = "button",
}: Props) {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<Step>("menu");
  const [hospitalId, setHospitalId] = useState<number | null>(
    selectedScheduleContext?.hospitalId ?? null,
  );
  const [includeAssignments, setIncludeAssignments] = useState(false);
  const [targetMonth, setTargetMonth] = useState<string | null>(null);
  const [calendarRule, setCalendarRule] = useState<"FULL" | "REMOVE_WEEKENDS" | "REMOVE_NIGHTS" | "REMOVE_DAYS" | "CUSTOM">("FULL");
  const [selectedShiftIds, setSelectedShiftIds] = useState<number[]>([]);
  const [preview, setPreview] = useState<{ created: number; skipped?: number; outOfRange?: number; origin?: CalendarOpenOrigin; candidates?: { sourceShiftId: number; label: string; startAt: string }[] } | null>(null);
  const [selectedServiceSpecialtyCodes, setSelectedServiceSpecialtyCodes] = useState<string[]>([]);
  const [specialtySearch, setSpecialtySearch] = useState("");
  const [serviceSpecialtiesInitializedFor, setServiceSpecialtiesInitializedFor] = useState<string | null>(null);
  const feedback = useActionFeedback();
  const utils = trpc.useUtils();

  // Na faixa (variant "strip") o status da escala precisa existir ANTES do
  // toque, então hospitais e rosterStatus carregam com a tela, não só com
  // o menu aberto.
  const wantsStatus = open || variant === "strip" || variant === "empty-state";
  const { data: hospitals } = trpc.hospitals.list.useQuery(undefined, { enabled: wantsStatus, staleTime: 60_000 });
  useEffect(() => {
    if (selectedScheduleContext) {
      setHospitalId(selectedScheduleContext.hospitalId);
    } else if (!hospitalId && hospitals?.length) {
      setHospitalId(hospitals[0].id);
    }
  }, [hospitals, hospitalId, selectedScheduleContext]);

  const monthKey = period.kind === "month" ? period.monthKey : period.weekStart.slice(0, 7);
  const sourceMonth = requestedCalendarTargetMonth
    ? sourceMonthForCalendarTarget(requestedCalendarTargetMonth)
    : monthKey;
  const { data: roster } = trpc.shifts.rosterStatus.useQuery(
    { hospitalId: hospitalId ?? 0, yearMonth: monthKey },
    { enabled: wantsStatus && !!hospitalId, staleTime: 60_000 },
  );
  const { data: previousMonthShifts } = trpc.shifts.hasMonthShifts.useQuery(
    {
      hospitalId: selectedScheduleContext?.hospitalId ?? 0,
      sectorId: selectedScheduleContext?.sectorId ?? 0,
      yearMonth: sourceMonth,
    },
    {
      enabled:
        wantsStatus &&
        !!selectedScheduleContext &&
        period.kind === "month" &&
        !!requestedCalendarTargetMonth,
      staleTime: 60_000,
    },
  );
  const calendarOrigin = calendarOpenOriginFromPreviousMonth(
    previousMonthShifts?.hasShifts,
  );

  const replicate = trpc.shifts.replicateRange.useMutation();
  const replicateMonthCalendar = trpc.shifts.replicateMonthCalendar.useMutation();
  const publish = trpc.shifts.publish.useMutation();
  const lock = trpc.shifts.lock.useMutation();
  const sectorServiceSpecialties = trpc.scheduleContexts.getSectorServiceSpecialties.useQuery(
    {
      hospitalId: selectedScheduleContext?.hospitalId ?? 0,
      sectorId: selectedScheduleContext?.sectorId ?? 0,
    },
    {
      enabled: open && step === "specialties" && selectedScheduleContext !== null,
      staleTime: 0,
    },
  );
  const replaceSectorServiceSpecialties =
    trpc.scheduleContexts.replaceSectorServiceSpecialties.useMutation();
  const busy =
    replicate.isPending ||
    replicateMonthCalendar.isPending ||
    publish.isPending ||
    lock.isPending ||
    replaceSectorServiceSpecialties.isPending;

  const serviceSpecialtyScopeKey = selectedScheduleContext
    ? `${selectedScheduleContext.hospitalId}:${selectedScheduleContext.sectorId}`
    : null;
  const filteredServiceSpecialties = useMemo(() => {
    const query = specialtySearch.trim().toLocaleLowerCase("pt-BR");
    if (!query) return MEDICAL_SPECIALTIES;
    return MEDICAL_SPECIALTIES.filter((specialty) =>
      `${specialty.name} ${specialty.code}`
        .toLocaleLowerCase("pt-BR")
        .includes(query),
    );
  }, [specialtySearch]);

  const resolvedHospitalId = selectedScheduleContext?.hospitalId ?? hospitalId;
  const replicateInput = useMemo(() => {
    if (!resolvedHospitalId) return null;
    return period.kind === "week"
      ? {
          hospitalId: resolvedHospitalId,
          from: { start: period.weekStart, granularity: "week" as const },
          to: { start: addDaysKey(period.weekStart, 7) },
        }
      : {
          hospitalId: resolvedHospitalId,
          from: { start: `${sourceMonth}-01`, granularity: "month" as const },
          to: { start: `${requestedCalendarTargetMonth ?? nextMonthKey(sourceMonth)}-01` },
        };
  }, [resolvedHospitalId, period, sourceMonth, requestedCalendarTargetMonth]);

  const sourceLabel = period.kind === "week" ? `semana ${weekLabel(period.weekStart)}` : monthLabel(sourceMonth);
  const targetLabel =
    period.kind === "week"
      ? `semana ${weekLabel(addDaysKey(period.weekStart, 7))}`
      : monthLabel(requestedCalendarTargetMonth ?? nextMonthKey(sourceMonth));
  const calendarTargetMonth =
    targetMonth ?? requestedCalendarTargetMonth ?? nextMonthKey(sourceMonth);
  // A escolha de hospital não identifica um setor. Para gestores com escopo
  // setorial, só replicamos quando o setor contextual selecionado pertence ao
  // hospital ativo; nunca inferimos um setor a partir dos turnos visíveis.
  const replicationSectorId =
    selectedScheduleContext &&
    selectedScheduleContext.hospitalId === resolvedHospitalId
      ? selectedScheduleContext.sectorId
      : null;
  const canReplicate = !!replicateInput && replicationSectorId !== null;
  const replicationUnavailableExplanation =
    selectedScheduleContext === null
      ? "Selecione um setor no filtro da agenda para replicar com segurança"
      : "O setor selecionado não pertence ao hospital escolhido";

  useEffect(() => {
    if (period.kind === "month") {
      setTargetMonth(requestedCalendarTargetMonth ?? nextMonthKey(sourceMonth));
    }
  }, [period, requestedCalendarTargetMonth, sourceMonth]);

  useEffect(() => {
    if (calendarOrigin === "templates" && calendarRule === "CUSTOM") {
      setCalendarRule("FULL");
      setSelectedShiftIds([]);
    }
  }, [calendarOrigin, calendarRule]);

  useEffect(() => {
    if (
      step !== "specialties" ||
      !serviceSpecialtyScopeKey ||
      !sectorServiceSpecialties.data ||
      serviceSpecialtiesInitializedFor === serviceSpecialtyScopeKey
    ) {
      return;
    }
    setSelectedServiceSpecialtyCodes(
      sectorServiceSpecialties.data.specialties.map((specialty) => specialty.code),
    );
    setServiceSpecialtiesInitializedFor(serviceSpecialtyScopeKey);
  }, [
    sectorServiceSpecialties.data,
    serviceSpecialtiesInitializedFor,
    serviceSpecialtyScopeKey,
    step,
  ]);

  function close() {
    setOpen(false);
    setStep("menu");
    setPreview(null);
    setIncludeAssignments(false);
    setCalendarRule("FULL");
    setSelectedShiftIds([]);
    setSelectedServiceSpecialtyCodes([]);
    setSpecialtySearch("");
    setServiceSpecialtiesInitializedFor(null);
  }

  function openMenu() {
    if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setOpen(true);
  }

  async function openEmptyStateCalendar() {
    openMenu();
    if (!replicateInput || !replicationSectorId) return;
    await startReplicate();
  }

  function openServiceSpecialties() {
    if (!selectedScheduleContext) {
      feedback.error("Selecione um setor na agenda para definir suas especialidades assistenciais.");
      return;
    }
    setSpecialtySearch("");
    setSelectedServiceSpecialtyCodes([]);
    setServiceSpecialtiesInitializedFor(null);
    setStep("specialties");
  }

  function toggleServiceSpecialty(code: string) {
    setSelectedServiceSpecialtyCodes((codes) =>
      codes.includes(code)
        ? codes.filter((selectedCode) => selectedCode !== code)
        : [...codes, code],
    );
  }

  async function saveServiceSpecialties() {
    if (!selectedScheduleContext) return;
    setStep("busy");
    try {
      const result = await replaceSectorServiceSpecialties.mutateAsync({
        hospitalId: selectedScheduleContext.hospitalId,
        sectorId: selectedScheduleContext.sectorId,
        medicalSpecialtyCodes: selectedServiceSpecialtyCodes,
      });
      await Promise.all([
        utils.scheduleContexts.getSectorServiceSpecialties.invalidate({
          hospitalId: selectedScheduleContext.hospitalId,
          sectorId: selectedScheduleContext.sectorId,
        }),
        utils.scheduleContexts.listMine.invalidate(),
        utils.scheduleContexts.listReadable.invalidate(),
      ]);
      onChanged?.();
      feedback.success(
        result.changed
          ? "Especialidades assistenciais do setor atualizadas. Elas não alteram a elegibilidade de médicos."
          : "Nenhuma alteração nas especialidades assistenciais do setor.",
      );
      setStep("menu");
    } catch (error) {
      feedback.error((error as Error).message);
      setStep("specialties");
    }
  }

  async function startReplicate() {
    if (!replicateInput || !replicationSectorId) return;
    setStep("busy");
    try {
      const r: any = period.kind === "month"
        ? await replicateMonthCalendar.mutateAsync({
            hospitalId: replicateInput.hospitalId,
            sectorId: replicationSectorId,
            scheduleContextId:
              selectedScheduleContext?.scheduleContextId ??
              selectedScheduleContext?.id,
            sourceMonth,
            targetMonth: calendarTargetMonth,
            rule: calendarRule,
            includeShiftIds: calendarRule === "CUSTOM" ? selectedShiftIds : undefined,
            dryRun: true,
          })
        : await replicate.mutateAsync({
            ...replicateInput,
            sectorId: replicationSectorId,
            dryRun: true,
          });
      setPreview({
        created: r.created,
        skipped: r.skipped,
        outOfRange: r.outOfRange,
        origin: r.origin,
        candidates: "candidates" in r ? r.candidates : undefined,
      });
      setStep("replicate");
    } catch (err) {
      feedback.error((err as Error).message);
      setStep("menu");
    }
  }

  async function confirmReplicate() {
    if (!replicateInput || !replicationSectorId) return;
    setStep("busy");
    try {
      const r: any = period.kind === "month"
        ? await replicateMonthCalendar.mutateAsync({
            hospitalId: replicateInput.hospitalId,
            sectorId: replicationSectorId,
            scheduleContextId:
              selectedScheduleContext?.scheduleContextId ??
              selectedScheduleContext?.id,
            sourceMonth,
            targetMonth: calendarTargetMonth,
            rule: calendarRule,
            includeShiftIds: calendarRule === "CUSTOM" ? selectedShiftIds : undefined,
          })
        : await replicate.mutateAsync({
            ...replicateInput,
            sectorId: replicationSectorId,
            includeAssignments,
            dryRun: false,
          });
      await utils.shifts.listAgenda.invalidate();
      await utils.shifts.hasMonthShifts.invalidate();
      onChanged?.();
      const parts = [`${r.created} turno${r.created === 1 ? "" : "s"} criado${r.created === 1 ? "" : "s"}`];
      if (r.skipped) parts.push(`${r.skipped} já existia${r.skipped === 1 ? "" : "m"}`);
      if (includeAssignments) parts.push(`${r.assignmentsCopied} alocaç${r.assignmentsCopied === 1 ? "ão" : "ões"} copiada${r.assignmentsCopied === 1 ? "" : "s"}`);
      if (r.conflicts) parts.push(`${r.conflicts} com conflito ficaram vagos`);
      const confirmedOrigin: CalendarOpenOrigin =
        r.origin === "templates" || r.origin === "previous-month"
          ? r.origin
          : calendarOrigin;
      feedback.success(
        period.kind === "month" && confirmedOrigin === "templates"
          ? `Calendário de ${monthLabel(calendarTargetMonth)} criado: ${parts.join(" · ")}.`
          : `Replicado para ${period.kind === "month" ? monthLabel(calendarTargetMonth) : targetLabel}: ${parts.join(" · ")}.`,
      );
      close();
    } catch (err) {
      feedback.error((err as Error).message);
      setStep("replicate");
    }
  }

  async function doPublish() {
    if (!resolvedHospitalId || !institutionId) return;
    const ok = await feedback.confirmDestructive(
      "Publicar escala",
      `Publicar a escala de ${monthLabel(monthKey)}? Os profissionais alocados passam a ver a escala como oficial e o Comunica+ é avisado.`,
      "Publicar",
    );
    if (!ok) return;
    setStep("busy");
    try {
      await publish.mutateAsync({ institutionId, hospitalId: resolvedHospitalId, yearMonth: monthKey });
      await utils.shifts.rosterStatus.invalidate();
      feedback.success(`Escala de ${monthLabel(monthKey)} publicada.`);
      close();
    } catch (err) {
      feedback.error((err as Error).message);
      setStep("menu");
    }
  }

  async function doLock() {
    if (!resolvedHospitalId || !institutionId) return;
    const ok = await feedback.confirmDestructive(
      "Bloquear escala",
      `Bloquear a escala de ${monthLabel(monthKey)}? Depois disso nenhuma alocação ou troca pode ser alterada neste mês.`,
      "Bloquear",
    );
    if (!ok) return;
    setStep("busy");
    try {
      await lock.mutateAsync({ institutionId, hospitalId: resolvedHospitalId, yearMonth: monthKey });
      await utils.shifts.rosterStatus.invalidate();
      feedback.success(`Escala de ${monthLabel(monthKey)} bloqueada.`);
      close();
    } catch (err) {
      feedback.error((err as Error).message);
      setStep("menu");
    }
  }

  const rosterStatus = roster?.status ?? "DRAFT";
  const openMonthName = MONTHS_PT[Number((requestedCalendarTargetMonth ?? calendarTargetMonth).slice(5, 7)) - 1];
  const previewOrigin: CalendarOpenOrigin =
    preview?.origin === "templates" || preview?.origin === "previous-month"
      ? preview.origin
      : calendarOrigin;
  const monthRuleOptions: [
    "FULL" | "REMOVE_WEEKENDS" | "REMOVE_NIGHTS" | "REMOVE_DAYS" | "CUSTOM",
    string,
  ][] =
    previewOrigin === "templates"
      ? [
          ["FULL", "Mês inteiro"],
          ["REMOVE_WEEKENDS", "Sem fins de semana"],
          ["REMOVE_NIGHTS", "Sem noturnos"],
          ["REMOVE_DAYS", "Sem diurnos"],
        ]
      : [
          ["FULL", "Mês inteiro"],
          ["REMOVE_WEEKENDS", "Sem fins de semana"],
          ["REMOVE_NIGHTS", "Sem noturnos"],
          ["REMOVE_DAYS", "Sem diurnos"],
          ["CUSTOM", "Personalizado"],
        ];

  const trigger =
    variant === "empty-state" ? (
      <View style={{ gap: theme.space[2], alignSelf: "stretch" }}>
        <AppButton
          title={`Abrir calendário de ${openMonthName}`}
          onPress={() => {
            void openEmptyStateCalendar();
          }}
          disabled={!canReplicate}
          fullWidth
        />
        {!canReplicate ? (
          <Text style={{ ...theme.text.caption, color: theme.colors.textSecondary }}>
            {replicationUnavailableExplanation}
          </Text>
        ) : null}
      </View>
    ) : variant === "strip" ? (
      <RosterStatusStrip monthKey={monthKey} status={rosterStatus} onPressActions={openMenu} />
    ) : (
      <Pressable
        onPress={openMenu}
        accessibilityRole="button"
        accessibilityLabel="Ações do gestor"
        hitSlop={4}
        style={({ pressed }) => ({
          flexDirection: "row",
          alignItems: "center",
          gap: theme.space[1],
          minHeight: theme.space[10] + theme.space[1],
          paddingHorizontal: theme.space[3],
          borderRadius: theme.radius.md,
          borderWidth: 1,
          borderColor: theme.colors.border,
          backgroundColor: theme.colors.surface,
          opacity: pressed ? 0.85 : 1,
        })}
      >
        <Settings2 size={16} color={theme.colors.textPrimary} />
        <Text style={{ ...theme.text.body, fontWeight: theme.weight.semibold, color: theme.colors.textPrimary }}>
          Ações
        </Text>
      </Pressable>
    );

  return (
    <>
      {trigger}

      <Modal visible={open} transparent animationType="fade" onRequestClose={close}>
        <Pressable
          onPress={close}
          accessibilityLabel="Fechar"
          style={{ flex: 1, backgroundColor: theme.colors.overlay, justifyContent: "flex-end" }}
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
            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
              <Text style={{ ...theme.text.title, fontWeight: theme.weight.bold, color: theme.colors.textPrimary }}>
                Ações do gestor
              </Text>
              <Pressable onPress={close} hitSlop={12} accessibilityLabel="Fechar">
                <X size={22} color={theme.colors.textSecondary} />
              </Pressable>
            </View>

            {/* Hospital (só aparece se houver mais de um) */}
            {hospitals && hospitals.length > 1 ? (
              <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                <View style={{ flexDirection: "row", gap: theme.space[2] }}>
                  {hospitals.map((h) => {
                    const selected = h.id === resolvedHospitalId;
                    return (
                      <Pressable
                        key={h.id}
                        onPress={() => setHospitalId(h.id)}
                        style={{
                          minHeight: theme.space[10],
                          justifyContent: "center",
                          paddingHorizontal: theme.space[3],
                          borderRadius: theme.radius.full,
                          borderWidth: 1,
                          borderColor: selected ? theme.colors.primary : theme.colors.border,
                          backgroundColor: selected ? theme.colors.primarySoft : theme.colors.surface,
                        }}
                      >
                        <Text style={{ ...theme.text.body, fontWeight: theme.weight.semibold, color: selected ? theme.colors.primary : theme.colors.textPrimary }}>
                          {h.name}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              </ScrollView>
            ) : null}

            {step === "busy" ? (
              <View style={{ alignItems: "center", paddingVertical: theme.space[6], gap: theme.space[3] }}>
                <ActivityIndicator size="large" color={theme.colors.primary} />
                <Text style={{ ...theme.text.body, color: theme.colors.textSecondary }}>Processando…</Text>
              </View>
            ) : step === "specialties" ? (
              <View style={{ gap: theme.space[4] }}>
                <View style={{ gap: theme.space[1] }}>
                  <Text style={{ ...theme.text.bodyLg, color: theme.colors.textPrimary, fontWeight: theme.weight.semibold }}>
                    Especialidades assistenciais
                  </Text>
                  <Text style={{ ...theme.text.body, color: theme.colors.textSecondary }}>
                    Descrevem o serviço deste setor. Não restringem convite, elegibilidade, alocação ou troca de médicos.
                  </Text>
                </View>

                {sectorServiceSpecialties.isLoading ? (
                  <View style={{ alignItems: "center", paddingVertical: theme.space[6], gap: theme.space[3] }}>
                    <ActivityIndicator color={theme.colors.primary} />
                    <Text style={{ ...theme.text.body, color: theme.colors.textSecondary }}>
                      Carregando especialidades do setor…
                    </Text>
                  </View>
                ) : sectorServiceSpecialties.isError ? (
                  <View style={{ gap: theme.space[3] }}>
                    <Text style={{ ...theme.text.body, color: theme.colors.danger }}>
                      Não foi possível carregar as especialidades deste setor.
                    </Text>
                    <AppButton
                      title="Tentar novamente"
                      variant="secondary"
                      onPress={() => {
                        void sectorServiceSpecialties.refetch();
                      }}
                    />
                  </View>
                ) : (
                  <>
                    <TextInput
                      value={specialtySearch}
                      onChangeText={setSpecialtySearch}
                      placeholder="Buscar especialidade"
                      placeholderTextColor={theme.colors.textMuted}
                      accessibilityLabel="Buscar especialidade assistencial"
                      style={{
                        minHeight: theme.space[11],
                        borderWidth: 1,
                        borderColor: theme.colors.border,
                        borderRadius: theme.radius.md,
                        paddingHorizontal: theme.space[3],
                        color: theme.colors.textPrimary,
                        backgroundColor: theme.colors.surface,
                        ...theme.text.body,
                      }}
                    />
                    <Text style={{ ...theme.text.caption, color: theme.colors.textSecondary }}>
                      {selectedServiceSpecialtyCodes.length} selecionada{selectedServiceSpecialtyCodes.length === 1 ? "" : "s"}
                    </Text>
                    <ScrollView style={{ maxHeight: theme.space[40] }} contentContainerStyle={{ gap: theme.space[1] }}>
                      {filteredServiceSpecialties.map((specialty) => {
                        const selected = selectedServiceSpecialtyCodes.includes(specialty.code);
                        return (
                          <Pressable
                            key={specialty.code}
                            onPress={() => toggleServiceSpecialty(specialty.code)}
                            accessibilityRole="checkbox"
                            accessibilityState={{ checked: selected }}
                            style={({ pressed }) => ({
                              minHeight: theme.space[11],
                              justifyContent: "center",
                              paddingHorizontal: theme.space[3],
                              borderRadius: theme.radius.md,
                              borderWidth: 1,
                              borderColor: selected ? theme.colors.primary : theme.colors.border,
                              backgroundColor: selected
                                ? theme.colors.primarySoft
                                : pressed
                                  ? theme.colors.surfaceAlt
                                  : theme.colors.surface,
                            })}
                          >
                            <Text style={{ ...theme.text.body, color: theme.colors.textPrimary }}>
                              {selected ? "✓ " : ""}{specialty.name}
                            </Text>
                            <Text style={{ ...theme.text.caption, color: theme.colors.textSecondary }}>
                              {specialty.code}
                            </Text>
                          </Pressable>
                        );
                      })}
                    </ScrollView>
                  </>
                )}

                <View style={{ flexDirection: "row", gap: theme.space[3] }}>
                  <View style={{ flex: 1 }}>
                    <AppButton title="Voltar" variant="secondary" onPress={() => setStep("menu")} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <AppButton
                      title="Salvar"
                      onPress={saveServiceSpecialties}
                      disabled={sectorServiceSpecialties.isLoading || sectorServiceSpecialties.isError || busy}
                    />
                  </View>
                </View>
              </View>
            ) : step === "replicate" && preview ? (
              <View style={{ gap: theme.space[4] }}>
                <Text style={{ ...theme.text.bodyLg, color: theme.colors.textPrimary }}>
                  {period.kind === "month"
                    ? calendarOpenPreviewTitle(
                        sourceLabel,
                        monthLabel(calendarTargetMonth),
                        previewOrigin,
                      )
                    : `Copiar ${sourceLabel} para ${targetLabel}:`}
                </Text>
                <View style={{ gap: theme.space[1] }}>
                  <Text style={{ ...theme.text.body, color: theme.colors.textPrimary, fontWeight: theme.weight.semibold }}>
                    {preview.created} turno{preview.created === 1 ? "" : "s"} novo{preview.created === 1 ? "" : "s"}
                  </Text>
                  {(preview.skipped ?? 0) > 0 ? (
                    <Text style={{ ...theme.text.body, color: theme.colors.textSecondary }}>
                      {preview.skipped} já exist{preview.skipped === 1 ? "e" : "em"} e não ser{preview.skipped === 1 ? "á" : "ão"} duplicado{preview.skipped === 1 ? "" : "s"}
                    </Text>
                  ) : null}
                  {(preview.outOfRange ?? 0) > 0 ? (
                    <Text style={{ ...theme.text.body, color: theme.colors.textSecondary }}>
                      {preview.outOfRange} cai{preview.outOfRange === 1 ? "" : "em"} fora do mês de destino e fica{preview.outOfRange === 1 ? "" : "m"} de fora
                    </Text>
                  ) : null}
                </View>
                {period.kind === "month" && calendarRule === "CUSTOM" && preview.candidates ? (
                  <View style={{ gap: theme.space[2] }}>
                    <Text style={{ ...theme.text.body, color: theme.colors.textSecondary }}>Selecione os turnos que entram no novo mês.</Text>
                    <ScrollView style={{ maxHeight: theme.space[32] }}>
                      {preview.candidates.map((candidate) => {
                        const selected = selectedShiftIds.includes(candidate.sourceShiftId);
                        return <Pressable key={candidate.sourceShiftId} onPress={() => setSelectedShiftIds((ids) => selected ? ids.filter((id) => id !== candidate.sourceShiftId) : [...ids, candidate.sourceShiftId])} style={{ minHeight: theme.space[10], justifyContent: "center", paddingHorizontal: theme.space[3], borderRadius: theme.radius.md, borderWidth: 1, borderColor: selected ? theme.colors.primary : theme.colors.border, backgroundColor: selected ? theme.colors.primarySoft : theme.colors.surface, marginBottom: theme.space[1] }}>
                          <Text style={{ ...theme.text.body, color: theme.colors.textPrimary }}>{selected ? "✓ " : ""}{candidate.label} · {candidate.startAt.slice(0, 10)}</Text>
                        </Pressable>;
                      })}
                    </ScrollView>
                  </View>
                ) : period.kind === "week" ? (
                  <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: theme.space[3] }}>
                    <Text style={{ ...theme.text.body, color: theme.colors.textPrimary, flex: 1 }}>
                      Copiar também as alocações (quem não tiver conflito)
                    </Text>
                    <Switch value={includeAssignments} onValueChange={setIncludeAssignments} trackColor={{ true: theme.colors.primary, false: theme.colors.border }} />
                  </View>
                ) : (
                  <Text style={{ ...theme.text.body, color: theme.colors.textSecondary }}>Os novos turnos serão criados vagos; nenhuma alocação será copiada.</Text>
                )}
                <View style={{ flexDirection: "row", gap: theme.space[3] }}>
                  <View style={{ flex: 1 }}>
                    <AppButton title="Voltar" variant="secondary" onPress={() => setStep("menu")} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <AppButton
                      title={calendarOpenConfirmTitle(
                        preview.created,
                        period.kind === "month" ? previewOrigin : "previous-month",
                      )}
                      onPress={confirmReplicate}
                      disabled={preview.created === 0 || busy || (period.kind === "month" && calendarRule === "CUSTOM" && selectedShiftIds.length === 0)}
                    />
                  </View>
                </View>
              </View>
            ) : (
              <View style={{ gap: theme.space[2] }}>
                <View
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: theme.space[2],
                    paddingVertical: theme.space[2],
                  }}
                >
                  <CalendarRange size={16} color={theme.colors.textSecondary} />
                  <Text style={{ ...theme.text.body, color: theme.colors.textSecondary }}>
                    {monthLabel(monthKey)} · escala {ROSTER_LABEL[rosterStatus]?.toLowerCase() ?? "rascunho"}
                  </Text>
                </View>

                {period.kind === "month" ? (
                  <View style={{ gap: theme.space[2], paddingVertical: theme.space[2] }}>
                    <Text style={{ ...theme.text.body, fontWeight: theme.weight.semibold, color: theme.colors.textPrimary }}>
                      Novo calendário mensal
                    </Text>
                    {requestedCalendarTargetMonth ? (
                      <Text style={{ ...theme.text.body, color: theme.colors.textSecondary }}>
                        {calendarOpenBaseHint(
                          monthLabel(calendarTargetMonth),
                          monthLabel(sourceMonth),
                          calendarOrigin,
                        )}
                      </Text>
                    ) : (
                    <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                      <View style={{ flexDirection: "row", gap: theme.space[2] }}>
                        {[nextMonthKey(sourceMonth), nextMonthKey(nextMonthKey(sourceMonth)), nextMonthKey(nextMonthKey(nextMonthKey(sourceMonth)))].map((key) => {
                          const selected = key === calendarTargetMonth;
                          return (
                            <Pressable key={key} onPress={() => setTargetMonth(key)} style={{ minHeight: theme.space[10], justifyContent: "center", paddingHorizontal: theme.space[3], borderRadius: theme.radius.full, borderWidth: 1, borderColor: selected ? theme.colors.primary : theme.colors.border, backgroundColor: selected ? theme.colors.primarySoft : theme.colors.surface }}>
                              <Text style={{ ...theme.text.caption, fontWeight: theme.weight.semibold, color: selected ? theme.colors.primary : theme.colors.textPrimary }}>{monthLabel(key)}</Text>
                            </Pressable>
                          );
                        })}
                      </View>
                    </ScrollView>
                    )}
                    <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                      <View style={{ flexDirection: "row", gap: theme.space[2] }}>
                        {monthRuleOptions.map(([rule, label]) => {
                          const selected = calendarRule === rule;
                          return <Pressable key={rule} onPress={() => { setCalendarRule(rule); setSelectedShiftIds([]); }} style={{ minHeight: theme.space[10], justifyContent: "center", paddingHorizontal: theme.space[3], borderRadius: theme.radius.full, borderWidth: 1, borderColor: selected ? theme.colors.primary : theme.colors.border, backgroundColor: selected ? theme.colors.primarySoft : theme.colors.surface }}>
                            <Text style={{ ...theme.text.caption, fontWeight: theme.weight.semibold, color: selected ? theme.colors.primary : theme.colors.textPrimary }}>{label}</Text>
                          </Pressable>;
                        })}
                      </View>
                    </ScrollView>
                  </View>
                ) : null}
                <MenuItem
                  icon={<CopyPlus size={20} color={theme.colors.primary} />}
                  title={
                    period.kind === "week"
                      ? "Replicar esta semana para a próxima"
                      : requestedCalendarTargetMonth
                        ? `Abrir calendário de ${openMonthName}`
                        : "Pré-visualizar novo calendário"
                  }
                  subtitle={
                    canReplicate
                      ? period.kind === "week"
                        ? `${sourceLabel} → ${targetLabel}`
                        : calendarOrigin === "templates"
                          ? `Modelos de horário → ${monthLabel(calendarTargetMonth)}`
                          : `${sourceLabel} → ${monthLabel(calendarTargetMonth)}`
                      : replicationUnavailableExplanation
                  }
                  onPress={startReplicate}
                  disabled={!canReplicate}
                />
                <MenuItem
                  icon={<Settings2 size={20} color={selectedScheduleContext ? theme.colors.primary : theme.colors.textMuted} />}
                  title="Especialidades do setor"
                  subtitle={
                    selectedScheduleContext
                      ? "Metadado assistencial; não bloqueia médicos"
                      : "Selecione um setor na agenda"
                  }
                  onPress={openServiceSpecialties}
                  disabled={!selectedScheduleContext}
                />
                <MenuItem
                  icon={<Send size={20} color={rosterStatus === "DRAFT" ? theme.colors.primary : theme.colors.textMuted} />}
                  title={`Publicar ${monthLabel(monthKey)}`}
                  subtitle={
                    rosterStatus === "DRAFT"
                      ? "Avisa os alocados e o Comunica+"
                      : `Já ${ROSTER_LABEL[rosterStatus]?.toLowerCase()}`
                  }
                  onPress={doPublish}
                  disabled={!resolvedHospitalId || rosterStatus !== "DRAFT"}
                />
                <MenuItem
                  icon={<Lock size={20} color={rosterStatus === "PUBLISHED" ? theme.colors.danger : theme.colors.textMuted} />}
                  title={`Bloquear ${monthLabel(monthKey)}`}
                  subtitle={
                    rosterStatus === "PUBLISHED"
                      ? "Congela alocações e trocas do mês"
                      : rosterStatus === "LOCKED"
                        ? "Já bloqueada"
                        : "Publique antes de bloquear"
                  }
                  onPress={doLock}
                  disabled={!resolvedHospitalId || rosterStatus !== "PUBLISHED"}
                />
              </View>
            )}
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

function MenuItem({
  icon,
  title,
  subtitle,
  onPress,
  disabled,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled }}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: theme.space[3],
        minHeight: theme.space[14],
        paddingHorizontal: theme.space[3],
        paddingVertical: theme.space[3],
        borderRadius: theme.radius.lg,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: pressed ? theme.colors.surfaceAlt : theme.colors.surface,
        opacity: disabled ? 0.5 : 1,
      })}
    >
      {icon}
      <View style={{ flex: 1 }}>
        <Text style={{ ...theme.text.bodyLg, fontWeight: theme.weight.semibold, color: theme.colors.textPrimary }}>
          {title}
        </Text>
        <Text style={{ ...theme.text.caption, color: theme.colors.textSecondary }}>{subtitle}</Text>
      </View>
    </Pressable>
  );
}

/**
 * Faixa do gestor: o estado da escala do mês lido ANTES do toque.
 * Rascunho = âmbar (publicar disponível); publicada = verde (bloquear
 * disponível, editar exige motivo); bloqueada = neutra com cadeado.
 */
function RosterStatusStrip({
  monthKey,
  status,
  onPressActions,
}: {
  monthKey: string;
  status: string;
  onPressActions: () => void;
}) {
  const [y, m] = monthKey.split("-").map(Number);
  const month = MONTHS_PT[m - 1];
  const monthTitle = `${month.charAt(0).toUpperCase()}${month.slice(1)}`;
  const label = ROSTER_LABEL[status]?.toLowerCase() ?? "rascunho";
  const tone =
    status === "PUBLISHED"
      ? { bg: theme.palette.success[50], border: theme.palette.success[200], fg: theme.palette.success[900], icon: theme.palette.success[700] }
      : status === "LOCKED"
        ? { bg: theme.colors.surfaceAlt, border: theme.colors.borderStrong, fg: theme.colors.textPrimary, icon: theme.colors.textSecondary }
        : { bg: theme.palette.warning[50], border: theme.palette.warning[200], fg: theme.palette.warning[900], icon: theme.palette.warning[700] };
  const Icon = status === "LOCKED" ? Lock : CalendarRange;
  const showYear = y !== new Date().getFullYear();

  return (
    <View
      accessibilityLabel={`Escala de ${month}${showYear ? ` de ${y}` : ""}: ${label}`}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: theme.space[2],
        minHeight: 36,
        paddingLeft: theme.space[2] + 2,
        paddingRight: theme.space[1],
        paddingVertical: theme.space[1],
        borderRadius: theme.radius.md + 1,
        backgroundColor: tone.bg,
        borderWidth: 1,
        borderColor: tone.border,
      }}
    >
      <Icon size={15} color={tone.icon} />
      <Text numberOfLines={1} style={{ flex: 1, minWidth: 0, ...theme.text.caption, fontSize: 12.5, fontWeight: theme.weight.semibold, color: tone.fg }}>
        {monthTitle}
        {showYear ? ` ${y}` : ""} · {label}
      </Text>
      <Pressable
        onPress={onPressActions}
        accessibilityRole="button"
        accessibilityLabel="Ações do gestor"
        hitSlop={4}
        style={({ pressed }) => ({
          flexDirection: "row",
          alignItems: "center",
          gap: theme.space[1] + 1,
          height: 28,
          paddingHorizontal: theme.space[2] + 2,
          borderRadius: theme.radius.md - 1,
          backgroundColor: theme.colors.surface,
          borderWidth: 1,
          borderColor: theme.colors.borderStrong,
          opacity: pressed ? 0.85 : 1,
        })}
      >
        <Settings2 size={14} color={theme.colors.textPrimary} />
        <Text style={{ ...theme.text.caption, fontSize: 12.5, fontWeight: theme.weight.bold, color: theme.colors.textPrimary }}>Ações</Text>
      </Pressable>
    </View>
  );
}

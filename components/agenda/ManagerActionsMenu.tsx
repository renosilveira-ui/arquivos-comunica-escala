// components/agenda/ManagerActionsMenu.tsx — ações do gestor na Agenda.
//
// Replicar semana/mês, publicar e bloquear o mês já existiam no servidor
// (shifts.replicateRange / publish / lock) sem nenhum botão na tela.
// Aqui: um único menu, contextual ao período que o gestor está vendo.
//
// Replicar faz um dryRun primeiro e mostra "12 novos · 3 já existem"
// antes de confirmar; o resultado vira toast e a Agenda recarrega.

import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Modal, Platform, Pressable, ScrollView, Switch, Text, View } from "react-native";
import * as Haptics from "expo-haptics";
import { CalendarRange, CopyPlus, Lock, Send, Settings2, X } from "lucide-react-native";
import { trpc } from "@/lib/trpc";
import { theme } from "@/lib/theme";
import { useActionFeedback } from "@/hooks/use-action-feedback";
import { AppButton } from "@/components/ui/AppButton";

export type ManagerPeriod =
  | { kind: "week"; weekStart: string } // YYYY-MM-DD (segunda)
  | { kind: "month"; monthKey: string }; // YYYY-MM

interface Props {
  institutionId: number | null;
  period: ManagerPeriod;
  onChanged?: () => void;
}

type Step = "menu" | "replicate" | "busy";

const MONTHS_PT = [
  "janeiro", "fevereiro", "março", "abril", "maio", "junho",
  "julho", "agosto", "setembro", "outubro", "novembro", "dezembro",
];

function addDaysKey(dateKey: string, days: number): string {
  const d = new Date(`${dateKey}T12:00:00`);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function nextMonthKey(monthKey: string): string {
  const [y, m] = monthKey.split("-").map(Number);
  const d = new Date(y, m, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
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

export function ManagerActionsMenu({ institutionId, period, onChanged }: Props) {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<Step>("menu");
  const [hospitalId, setHospitalId] = useState<number | null>(null);
  const [includeAssignments, setIncludeAssignments] = useState(false);
  const [preview, setPreview] = useState<{ created: number; skipped: number; outOfRange: number } | null>(null);
  const feedback = useActionFeedback();
  const utils = trpc.useUtils();

  const { data: hospitals } = trpc.hospitals.list.useQuery(undefined, { enabled: open, staleTime: 60_000 });
  useEffect(() => {
    if (!hospitalId && hospitals?.length) setHospitalId(hospitals[0].id);
  }, [hospitals, hospitalId]);

  const monthKey = period.kind === "month" ? period.monthKey : period.weekStart.slice(0, 7);
  const { data: roster } = trpc.shifts.rosterStatus.useQuery(
    { hospitalId: hospitalId ?? 0, yearMonth: monthKey },
    { enabled: open && !!hospitalId },
  );

  const replicate = trpc.shifts.replicateRange.useMutation();
  const publish = trpc.shifts.publish.useMutation();
  const lock = trpc.shifts.lock.useMutation();
  const busy = replicate.isPending || publish.isPending || lock.isPending;

  const replicateInput = useMemo(() => {
    if (!hospitalId) return null;
    return period.kind === "week"
      ? {
          hospitalId,
          from: { start: period.weekStart, granularity: "week" as const },
          to: { start: addDaysKey(period.weekStart, 7) },
        }
      : {
          hospitalId,
          from: { start: `${period.monthKey}-01`, granularity: "month" as const },
          to: { start: `${nextMonthKey(period.monthKey)}-01` },
        };
  }, [hospitalId, period]);

  const sourceLabel = period.kind === "week" ? `semana ${weekLabel(period.weekStart)}` : monthLabel(period.monthKey);
  const targetLabel =
    period.kind === "week"
      ? `semana ${weekLabel(addDaysKey(period.weekStart, 7))}`
      : monthLabel(nextMonthKey(period.monthKey));

  function close() {
    setOpen(false);
    setStep("menu");
    setPreview(null);
    setIncludeAssignments(false);
  }

  function openMenu() {
    if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setOpen(true);
  }

  async function startReplicate() {
    if (!replicateInput) return;
    setStep("busy");
    try {
      const r = await replicate.mutateAsync({ ...replicateInput, dryRun: true });
      setPreview({ created: r.created, skipped: r.skipped, outOfRange: r.outOfRange });
      setStep("replicate");
    } catch (err) {
      feedback.error((err as Error).message);
      setStep("menu");
    }
  }

  async function confirmReplicate() {
    if (!replicateInput) return;
    setStep("busy");
    try {
      const r = await replicate.mutateAsync({ ...replicateInput, includeAssignments, dryRun: false });
      await utils.shifts.listAgenda.invalidate();
      onChanged?.();
      const parts = [`${r.created} turno${r.created === 1 ? "" : "s"} criado${r.created === 1 ? "" : "s"}`];
      if (r.skipped) parts.push(`${r.skipped} já existia${r.skipped === 1 ? "" : "m"}`);
      if (includeAssignments) parts.push(`${r.assignmentsCopied} alocaç${r.assignmentsCopied === 1 ? "ão" : "ões"} copiada${r.assignmentsCopied === 1 ? "" : "s"}`);
      if (r.conflicts) parts.push(`${r.conflicts} com conflito ficaram vagos`);
      feedback.success(`Replicado para ${targetLabel}: ${parts.join(" · ")}.`);
      close();
    } catch (err) {
      feedback.error((err as Error).message);
      setStep("replicate");
    }
  }

  async function doPublish() {
    if (!hospitalId || !institutionId) return;
    const ok = await feedback.confirmDestructive(
      "Publicar escala",
      `Publicar a escala de ${monthLabel(monthKey)}? Os profissionais alocados passam a ver a escala como oficial e o Comunica+ é avisado.`,
      "Publicar",
    );
    if (!ok) return;
    setStep("busy");
    try {
      await publish.mutateAsync({ institutionId, hospitalId, yearMonth: monthKey });
      await utils.shifts.rosterStatus.invalidate();
      feedback.success(`Escala de ${monthLabel(monthKey)} publicada.`);
      close();
    } catch (err) {
      feedback.error((err as Error).message);
      setStep("menu");
    }
  }

  async function doLock() {
    if (!hospitalId || !institutionId) return;
    const ok = await feedback.confirmDestructive(
      "Bloquear escala",
      `Bloquear a escala de ${monthLabel(monthKey)}? Depois disso nenhuma alocação ou troca pode ser alterada neste mês.`,
      "Bloquear",
    );
    if (!ok) return;
    setStep("busy");
    try {
      await lock.mutateAsync({ institutionId, hospitalId, yearMonth: monthKey });
      await utils.shifts.rosterStatus.invalidate();
      feedback.success(`Escala de ${monthLabel(monthKey)} bloqueada.`);
      close();
    } catch (err) {
      feedback.error((err as Error).message);
      setStep("menu");
    }
  }

  const rosterStatus = roster?.status ?? "DRAFT";

  return (
    <>
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
                    const selected = h.id === hospitalId;
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
            ) : step === "replicate" && preview ? (
              <View style={{ gap: theme.space[4] }}>
                <Text style={{ ...theme.text.bodyLg, color: theme.colors.textPrimary }}>
                  Copiar a {sourceLabel} para a {targetLabel}:
                </Text>
                <View style={{ gap: theme.space[1] }}>
                  <Text style={{ ...theme.text.body, color: theme.colors.textPrimary, fontWeight: theme.weight.semibold }}>
                    {preview.created} turno{preview.created === 1 ? "" : "s"} novo{preview.created === 1 ? "" : "s"}
                  </Text>
                  {preview.skipped > 0 ? (
                    <Text style={{ ...theme.text.body, color: theme.colors.textSecondary }}>
                      {preview.skipped} já exist{preview.skipped === 1 ? "e" : "em"} e não ser{preview.skipped === 1 ? "á" : "ão"} duplicado{preview.skipped === 1 ? "" : "s"}
                    </Text>
                  ) : null}
                  {preview.outOfRange > 0 ? (
                    <Text style={{ ...theme.text.body, color: theme.colors.textSecondary }}>
                      {preview.outOfRange} cai{preview.outOfRange === 1 ? "" : "em"} fora do mês de destino e fica{preview.outOfRange === 1 ? "" : "m"} de fora
                    </Text>
                  ) : null}
                </View>
                <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: theme.space[3] }}>
                  <Text style={{ ...theme.text.body, color: theme.colors.textPrimary, flex: 1 }}>
                    Copiar também as alocações (quem não tiver conflito)
                  </Text>
                  <Switch
                    value={includeAssignments}
                    onValueChange={setIncludeAssignments}
                    trackColor={{ true: theme.colors.primary, false: theme.colors.border }}
                  />
                </View>
                <View style={{ flexDirection: "row", gap: theme.space[3] }}>
                  <View style={{ flex: 1 }}>
                    <AppButton title="Voltar" variant="secondary" onPress={() => setStep("menu")} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <AppButton
                      title={preview.created === 0 ? "Nada a copiar" : "Confirmar cópia"}
                      onPress={confirmReplicate}
                      disabled={preview.created === 0 || busy}
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

                <MenuItem
                  icon={<CopyPlus size={20} color={theme.colors.primary} />}
                  title={period.kind === "week" ? "Replicar esta semana para a próxima" : "Replicar este mês para o próximo"}
                  subtitle={`${sourceLabel} → ${targetLabel}`}
                  onPress={startReplicate}
                  disabled={!hospitalId}
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
                  disabled={!hospitalId || rosterStatus !== "DRAFT"}
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
                  disabled={!hospitalId || rosterStatus !== "PUBLISHED"}
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

import {
  Text,
  View,
  ScrollView,
  TouchableOpacity,
  Modal,
  TextInput,
  ActivityIndicator,
  Alert,
} from "react-native";
import { useState, useMemo } from "react";
import { Grid3X3, ChevronLeft, ChevronRight, Plus, Copy, X, User } from "lucide-react-native";

import { ScreenGradient } from "@/components/ui/ScreenGradient";
import { Badge, type BadgeVariant } from "@/components/ui/Badge";
import { useAuth } from "@/hooks/use-auth";
import { usePermissions } from "@/hooks/use-permissions";
import { trpc } from "@/lib/trpc";
import { theme } from "@/lib/theme";

/* ──────────────── helpers ──────────────── */

const DAY_LABELS = ["Seg", "Ter", "Qua", "Qui", "Sex", "Sáb", "Dom"] as const;
const SLOT_LABELS = ["Manhã", "Tarde", "Noite"] as const;

const CELL_WIDTH = 140;
const SLOT_HEIGHT = 90;
const HEADER_HEIGHT = 36;

/** Return Monday 00:00 of the week containing `d`. */
function getMonday(d: Date): Date {
  const copy = new Date(d);
  copy.setHours(0, 0, 0, 0);
  const day = copy.getDay(); // 0=Sun
  const diff = day === 0 ? -6 : 1 - day;
  copy.setDate(copy.getDate() + diff);
  return copy;
}

function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

function fmtDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function fmtTime(d: Date): string {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** Classify a shift start hour into a slot index (0=Manhã, 1=Tarde, 2=Noite). */
function classifyShift(hour: number): number {
  if (hour >= 7 && hour < 13) return 0;
  if (hour >= 13 && hour < 19) return 1;
  return 2;
}

/** Friendly time range for a slot. */
function slotTimeRange(slotIdx: number): string {
  if (slotIdx === 0) return "07:00–13:00";
  if (slotIdx === 1) return "13:00–19:00";
  return "19:00–07:00";
}

function borderColorForStatus(status: string): string {
  if (status === "OCUPADO") return theme.colors.success;
  if (status === "PENDENTE") return theme.colors.warning;
  return theme.colors.danger; // VAGO
}

function badgeVariantForStatus(status: string): BadgeVariant {
  if (status === "OCUPADO") return "success";
  if (status === "PENDENTE") return "warning";
  return "critical";
}

/* ──────────────── types ──────────────── */

type ShiftWithAssignments = {
  id: number;
  label: string;
  startAt: string;
  endAt: string;
  status: string;
  assignments: { professionalId: number; professionalName?: string }[];
};

type GridCell = {
  dayIndex: number;
  slotIndex: number;
  shifts: ShiftWithAssignments[];
  professionalNames: string[];
  status: string; // dominant status
  timeRange: string;
};

/* ──────────────── component ──────────────── */

export default function WeeklyScreen() {
  const { user } = useAuth();
  const { isManager } = usePermissions();
  const utils = trpc.useUtils();

  const [weekStart, setWeekStart] = useState(() => getMonday(new Date()));
  const [allocModalVisible, setAllocModalVisible] = useState(false);
  const [selectedCell, setSelectedCell] = useState<GridCell | null>(null);
  const [searchText, setSearchText] = useState("");
  const [replicating, setReplicating] = useState(false);

  /* ── queries ── */
  const periodStart = useMemo(() => weekStart.toISOString(), [weekStart]);
  const periodEnd = useMemo(() => addDays(weekStart, 7).toISOString(), [weekStart]);

  const { data: shiftsData, refetch } = trpc.shifts.listByPeriod.useQuery(
    { startDate: periodStart, endDate: periodEnd },
    { enabled: !!user?.id },
  );

  /* ── mutations ── */
  const replicateWeek = trpc.shifts.replicateWeek.useMutation({
    onSuccess: (data: { created: number }) => {
      Alert.alert("Sucesso", `${data.created} escalas replicadas para a próxima semana.`);
      utils.shifts.listByPeriod.invalidate();
    },
    onError: (err: { message: string }) => {
      Alert.alert("Erro", err.message);
    },
  });

  const assignDirect = trpc.editor.assignDirect.useMutation({
    onSuccess: () => {
      setAllocModalVisible(false);
      utils.shifts.listByPeriod.invalidate();
    },
    onError: (err: { message: string }) => {
      Alert.alert("Erro ao alocar", err.message);
    },
  });

  /* ── build grid ── */
  const grid: GridCell[][] = useMemo(() => {
    // 3 rows (slots) × 7 cols (days)
    const g: GridCell[][] = Array.from({ length: 3 }, (_, slotIdx) =>
      Array.from({ length: 7 }, (_, dayIdx) => ({
        dayIndex: dayIdx,
        slotIndex: slotIdx,
        shifts: [],
        professionalNames: [],
        status: "VAGO",
        timeRange: slotTimeRange(slotIdx),
      })),
    );

    if (!shiftsData) return g;

    for (const item of shiftsData as ShiftWithAssignments[]) {
      const start = new Date(item.startAt);
      const dayOfWeek = start.getDay(); // 0=Sun
      const dayIdx = dayOfWeek === 0 ? 6 : dayOfWeek - 1; // convert to Mon=0..Sun=6
      const slotIdx = classifyShift(start.getHours());

      if (dayIdx >= 0 && dayIdx < 7 && slotIdx >= 0 && slotIdx < 3) {
        const cell = g[slotIdx][dayIdx];
        cell.shifts.push(item);
        const names = (item.assignments || [])
          .map((a) => a.professionalName || `Prof #${a.professionalId}`)
          .filter(Boolean);
        cell.professionalNames.push(...names);

        // Dominant status priority: OCUPADO > PENDENTE > VAGO
        if (item.status === "OCUPADO") cell.status = "OCUPADO";
        else if (item.status === "PENDENTE" && cell.status !== "OCUPADO") cell.status = "PENDENTE";
      }
    }

    return g;
  }, [shiftsData]);

  /* ── week navigation ── */
  const goToPrevWeek = () => setWeekStart((prev) => addDays(prev, -7));
  const goToNextWeek = () => setWeekStart((prev) => addDays(prev, 7));

  const weekLabel = useMemo(() => {
    const end = addDays(weekStart, 6);
    const months = [
      "Jan", "Fev", "Mar", "Abr", "Mai", "Jun",
      "Jul", "Ago", "Set", "Out", "Nov", "Dez",
    ];
    const startMonth = months[weekStart.getMonth()];
    const endMonth = months[end.getMonth()];
    if (startMonth === endMonth) {
      return `${weekStart.getDate()} – ${end.getDate()} ${startMonth} ${weekStart.getFullYear()}`;
    }
    return `${weekStart.getDate()} ${startMonth} – ${end.getDate()} ${endMonth} ${weekStart.getFullYear()}`;
  }, [weekStart]);

  /* ── replicate handler ── */
  const handleReplicate = () => {
    Alert.alert(
      "Replicar Semana",
      `Copiar escalas da semana atual para a próxima semana?\n(${fmtDate(weekStart)} → ${fmtDate(addDays(weekStart, 7))})`,
      [
        { text: "Cancelar", style: "cancel" },
        {
          text: "Replicar",
          onPress: () => {
            setReplicating(true);
            replicateWeek.mutate(
              {
                fromStartDate: fmtDate(weekStart),
                toStartDate: fmtDate(addDays(weekStart, 7)),
                hospitalId: 1, // TODO: dynamic hospital filter
              },
              { onSettled: () => setReplicating(false) },
            );
          },
        },
      ],
    );
  };

  /* ── cell tap ── */
  const handleCellPress = (cell: GridCell) => {
    if (cell.status === "VAGO" && cell.shifts.length > 0) {
      setSelectedCell(cell);
      setSearchText("");
      setAllocModalVisible(true);
    }
  };

  /* ── access control ── */
  if (!isManager) {
    return (
      <ScreenGradient>
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
          <Text style={{ fontSize: 18, fontWeight: "600", color: theme.colors.textPrimary }}>
            Acesso Restrito
          </Text>
          <Text style={{ fontSize: 14, color: theme.colors.textSecondary, marginTop: 8 }}>
            Apenas gestores podem visualizar a grade semanal.
          </Text>
        </View>
      </ScreenGradient>
    );
  }

  /* ──────────────── render ──────────────── */

  return (
    <ScreenGradient>
      {/* Header */}
      <View style={{ marginBottom: 16, paddingHorizontal: 4 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 12 }}>
          <Grid3X3 size={28} color="#4DA3FF" />
          <Text style={{ fontSize: 28, fontWeight: "700", color: theme.colors.textPrimary }}>
            Escala Semanal
          </Text>
        </View>

        {/* Week navigation */}
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
          <TouchableOpacity onPress={goToPrevWeek} activeOpacity={0.7} style={{ padding: 8 }}>
            <ChevronLeft size={24} color={theme.colors.textSecondary} />
          </TouchableOpacity>
          <Text style={{ fontSize: 16, fontWeight: "600", color: theme.colors.textPrimary }}>
            {weekLabel}
          </Text>
          <TouchableOpacity onPress={goToNextWeek} activeOpacity={0.7} style={{ padding: 8 }}>
            <ChevronRight size={24} color={theme.colors.textSecondary} />
          </TouchableOpacity>
        </View>

        {/* Replicate button */}
        <TouchableOpacity
          onPress={handleReplicate}
          disabled={replicating}
          activeOpacity={0.7}
          style={{
            marginTop: 12,
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "center",
            gap: 8,
            paddingVertical: 10,
            paddingHorizontal: 16,
            borderRadius: theme.borderRadius.button,
            backgroundColor: "rgba(59,130,246,0.2)",
            borderWidth: 1,
            borderColor: "rgba(59,130,246,0.4)",
          }}
        >
          {replicating ? (
            <ActivityIndicator size="small" color={theme.colors.primary} />
          ) : (
            <Copy size={16} color={theme.colors.primary} />
          )}
          <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.primary }}>
            Replicar Semana
          </Text>
        </TouchableOpacity>
      </View>

      {/* Grid */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <View>
          {/* Day headers */}
          <View style={{ flexDirection: "row", marginLeft: 60 }}>
            {DAY_LABELS.map((label, dayIdx) => {
              const dayDate = addDays(weekStart, dayIdx);
              return (
                <View
                  key={dayIdx}
                  style={{
                    width: CELL_WIDTH,
                    height: HEADER_HEIGHT,
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <Text style={{ fontSize: 12, fontWeight: "700", color: theme.colors.textSecondary }}>
                    {dayDate.getDate()} {label}
                  </Text>
                </View>
              );
            })}
          </View>

          {/* Slot rows */}
          {SLOT_LABELS.map((slotLabel, slotIdx) => (
            <View key={slotIdx} style={{ flexDirection: "row" }}>
              {/* Slot label */}
              <View
                style={{
                  width: 60,
                  height: SLOT_HEIGHT,
                  justifyContent: "center",
                  alignItems: "center",
                }}
              >
                <Text style={{ fontSize: 11, fontWeight: "600", color: theme.colors.textMuted }}>
                  {slotLabel}
                </Text>
              </View>

              {/* Cells */}
              {grid[slotIdx].map((cell, dayIdx) => {
                const isEmpty = cell.shifts.length === 0;
                const bColor = isEmpty ? theme.colors.cardBorder : borderColorForStatus(cell.status);

                return (
                  <TouchableOpacity
                    key={dayIdx}
                    activeOpacity={0.7}
                    onPress={() => handleCellPress(cell)}
                    disabled={isEmpty}
                    style={{
                      width: CELL_WIDTH,
                      height: SLOT_HEIGHT,
                      borderWidth: 1.5,
                      borderColor: bColor,
                      borderRadius: theme.borderRadius.card,
                      backgroundColor: theme.colors.cardBg,
                      margin: 2,
                      padding: 6,
                      justifyContent: "space-between",
                    }}
                  >
                    {isEmpty ? (
                      <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
                        <Text style={{ fontSize: 11, color: theme.colors.textMuted }}>—</Text>
                      </View>
                    ) : cell.status === "VAGO" && cell.professionalNames.length === 0 ? (
                      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 4 }}>
                        <Plus size={18} color={theme.colors.danger} />
                        <Text style={{ fontSize: 10, color: theme.colors.danger }}>Vago</Text>
                      </View>
                    ) : (
                      <>
                        <View style={{ flex: 1 }}>
                          {cell.professionalNames.slice(0, 2).map((name, i) => (
                            <Text
                              key={i}
                              numberOfLines={1}
                              style={{ fontSize: 10, color: theme.colors.textPrimary }}
                            >
                              {name}
                            </Text>
                          ))}
                          {cell.professionalNames.length > 2 && (
                            <Text style={{ fontSize: 9, color: theme.colors.textMuted }}>
                              +{cell.professionalNames.length - 2}
                            </Text>
                          )}
                        </View>
                        <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
                          <Text style={{ fontSize: 9, color: theme.colors.textMuted }}>
                            {cell.timeRange}
                          </Text>
                          <Badge variant={badgeVariantForStatus(cell.status)} style={{ paddingHorizontal: 6, paddingVertical: 2 }}>
                            <Text style={{ fontSize: 8 }}>{cell.shifts.length}</Text>
                          </Badge>
                        </View>
                      </>
                    )}
                  </TouchableOpacity>
                );
              })}
            </View>
          ))}
        </View>
      </ScrollView>

      {/* Allocation Modal */}
      <Modal
        visible={allocModalVisible}
        transparent
        animationType="slide"
        onRequestClose={() => setAllocModalVisible(false)}
      >
        <View style={{ flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(0,0,0,0.5)" }}>
          <View
            style={{
              backgroundColor: theme.colors.cardBg,
              borderTopLeftRadius: 20,
              borderTopRightRadius: 20,
              padding: 20,
              minHeight: 320,
            }}
          >
            {/* Modal header */}
            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <Text style={{ fontSize: 18, fontWeight: "700", color: theme.colors.textPrimary }}>
                Alocar Profissional
              </Text>
              <TouchableOpacity onPress={() => setAllocModalVisible(false)}>
                <X size={24} color={theme.colors.textSecondary} />
              </TouchableOpacity>
            </View>

            {/* Shift info */}
            {selectedCell && (
              <View style={{ marginBottom: 16 }}>
                <Text style={{ fontSize: 14, color: theme.colors.textSecondary }}>
                  {DAY_LABELS[selectedCell.dayIndex]} — {SLOT_LABELS[selectedCell.slotIndex]} ({selectedCell.timeRange})
                </Text>
                <Text style={{ fontSize: 12, color: theme.colors.textMuted, marginTop: 4 }}>
                  {selectedCell.shifts.length} escala{selectedCell.shifts.length !== 1 ? "s" : ""} neste horário
                </Text>
              </View>
            )}

            {/* Search */}
            <TextInput
              placeholder="Buscar profissional..."
              placeholderTextColor={theme.colors.textMuted}
              value={searchText}
              onChangeText={setSearchText}
              style={{
                backgroundColor: theme.colors.inputBg,
                borderRadius: theme.borderRadius.input,
                paddingHorizontal: 14,
                paddingVertical: 10,
                fontSize: 14,
                color: theme.colors.textPrimary,
                marginBottom: 16,
              }}
            />

            {/* Placeholder: professional list would go here */}
            <View style={{ alignItems: "center", justifyContent: "center", paddingVertical: 32 }}>
              <User size={32} color={theme.colors.textMuted} />
              <Text style={{ fontSize: 14, color: theme.colors.textMuted, marginTop: 8, textAlign: "center" }}>
                Integração com lista de profissionais em breve.{"\n"}
                Use a tela de edição individual por enquanto.
              </Text>
            </View>
          </View>
        </View>
      </Modal>
    </ScreenGradient>
  );
}

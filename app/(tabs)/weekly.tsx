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

const CELL_WIDTH = 120;
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

/** Classify a shift by its label into a slot index (0=Manhã, 1=Tarde, 2=Noite). */
function classifyShift(label: string): number {
  if (label.includes("Manhã") || label.includes("Manha")) return 0;
  if (label.includes("Tarde")) return 1;
  return 2; // Noite
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
  startAt: string | Date;
  endAt: string | Date;
  status: string;
  assignments: { professionalId: number; professionalName?: string | null }[];
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

    for (const item of shiftsData) {
      const start = new Date(item.startAt);
      const dayOfWeek = start.getUTCDay(); // 0=Sun, UTC to match DB
      const dayIdx = dayOfWeek === 0 ? 6 : dayOfWeek - 1; // convert to Mon=0..Sun=6
      const slotIdx = classifyShift(item.label);

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

  const todayFmt = fmtDate(new Date());

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
    if (cell.shifts.length > 0) {
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
      <View style={{ paddingHorizontal: 4, marginBottom: 8 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 8 }}>
          <Grid3X3 size={24} color="#4DA3FF" />
          <Text style={{ fontSize: 22, fontWeight: "700", color: theme.colors.textPrimary }}>
            Escala Semanal
          </Text>
        </View>

        {/* Week navigation + replicate inline */}
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
          <View style={{ flexDirection: "row", alignItems: "center", flex: 1 }}>
            <TouchableOpacity onPress={goToPrevWeek} activeOpacity={0.7} style={{ padding: 6 }}>
              <ChevronLeft size={22} color={theme.colors.textSecondary} />
            </TouchableOpacity>
            <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }}>
              {weekLabel}
            </Text>
            <TouchableOpacity onPress={goToNextWeek} activeOpacity={0.7} style={{ padding: 6 }}>
              <ChevronRight size={22} color={theme.colors.textSecondary} />
            </TouchableOpacity>
          </View>
          <TouchableOpacity
            onPress={handleReplicate}
            disabled={replicating}
            activeOpacity={0.7}
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 4,
              paddingVertical: 6,
              paddingHorizontal: 10,
              borderRadius: 8,
              backgroundColor: "rgba(59,130,246,0.15)",
              borderWidth: 1,
              borderColor: "rgba(59,130,246,0.3)",
            }}
          >
            {replicating ? (
              <ActivityIndicator size="small" color={theme.colors.primary} />
            ) : (
              <Copy size={14} color={theme.colors.primary} />
            )}
            <Text style={{ fontSize: 12, fontWeight: "600", color: theme.colors.primary }}>
              Replicar
            </Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Grid — fills remaining vertical space */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flex: 1 }} contentContainerStyle={{ flexGrow: 1 }}>
        <View style={{ flex: 1 }}>
          {/* Day headers */}
          <View style={{ flexDirection: "row", marginLeft: 60 }}>
            {DAY_LABELS.map((label, dayIdx) => {
              const dayDate = addDays(weekStart, dayIdx);
              const isToday = fmtDate(dayDate) === todayFmt;
              return (
                <View
                  key={dayIdx}
                  style={{
                    width: CELL_WIDTH,
                    height: HEADER_HEIGHT,
                    alignItems: "center",
                    justifyContent: "center",
                    marginHorizontal: 2,
                  }}
                >
                  <Text
                    style={{
                      fontSize: 12,
                      fontWeight: "700",
                      color: isToday ? theme.colors.primary : theme.colors.textSecondary,
                    }}
                  >
                    {dayDate.getDate()} {label}
                  </Text>
                  {isToday && (
                    <View
                      style={{
                        width: 24,
                        height: 2,
                        backgroundColor: theme.colors.primary,
                        borderRadius: 1,
                        marginTop: 2,
                      }}
                    />
                  )}
                </View>
              );
            })}
          </View>

          {/* Slot rows — each row takes equal vertical space */}
          {SLOT_LABELS.map((slotLabel, slotIdx) => (
            <View key={slotIdx} style={{ flexDirection: "row", flex: 1 }}>
              {/* Slot label */}
              <View
                style={{
                  width: 60,
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
                const statusColor = isEmpty ? "transparent" : borderColorForStatus(cell.status);

                return (
                  <TouchableOpacity
                    key={dayIdx}
                    activeOpacity={0.7}
                    onPress={() => handleCellPress(cell)}
                    disabled={isEmpty}
                    style={{
                      width: CELL_WIDTH,
                      flex: 1,
                      minHeight: 120,
                      borderWidth: 1,
                      borderColor: theme.colors.cardBorder,
                      borderLeftWidth: 3,
                      borderLeftColor: statusColor,
                      borderRadius: theme.borderRadius.card,
                      backgroundColor: theme.colors.cardBg,
                      margin: 2,
                      padding: 8,
                      justifyContent: "space-between",
                    }}
                  >
                    {isEmpty ? (
                      <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
                        <Plus size={22} color={theme.colors.textMuted} strokeWidth={1.5} />
                      </View>
                    ) : cell.status === "VAGO" && cell.professionalNames.length === 0 ? (
                      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 6 }}>
                        <Plus size={28} color={theme.colors.danger} />
                        <Text style={{ fontSize: 11, fontWeight: "600", color: theme.colors.danger }}>Vago</Text>
                      </View>
                    ) : (
                      <>
                        <View style={{ flex: 1, gap: 2 }}>
                          {cell.professionalNames.slice(0, 3).map((name, i) => (
                            <Text
                              key={i}
                              numberOfLines={1}
                              style={{ fontSize: 11, fontWeight: "600", color: theme.colors.textPrimary }}
                            >
                              {name}
                            </Text>
                          ))}
                          {cell.professionalNames.length > 3 && (
                            <Text style={{ fontSize: 10, color: theme.colors.textMuted }}>
                              +{cell.professionalNames.length - 3}
                            </Text>
                          )}
                        </View>
                        <View style={{ gap: 4 }}>
                          <Text style={{ fontSize: 10, color: theme.colors.textMuted }}>
                            {cell.timeRange}
                          </Text>
                          <Badge variant={badgeVariantForStatus(cell.status)} style={{ paddingHorizontal: 6, paddingVertical: 2, alignSelf: "flex-start" }}>
                            <Text style={{ fontSize: 9 }}>{cell.shifts.length} escala{cell.shifts.length !== 1 ? "s" : ""}</Text>
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
                <Badge
                  variant={badgeVariantForStatus(selectedCell.status)}
                  style={{ marginTop: 6, alignSelf: "flex-start" }}
                >
                  {selectedCell.status} — {selectedCell.shifts.length} escala{selectedCell.shifts.length !== 1 ? "s" : ""}
                </Badge>

                {/* Show assigned professionals */}
                {selectedCell.professionalNames.length > 0 && (
                  <View style={{ marginTop: 12, gap: 6 }}>
                    <Text style={{ fontSize: 13, fontWeight: "600", color: theme.colors.textPrimary }}>
                      Profissionais:
                    </Text>
                    {selectedCell.professionalNames.map((name, i) => (
                      <View key={i} style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                        <User size={14} color={theme.colors.textSecondary} />
                        <Text style={{ fontSize: 13, color: theme.colors.textPrimary }}>{name}</Text>
                      </View>
                    ))}
                  </View>
                )}
              </View>
            )}

            {/* Search — only show for VAGO cells (allocation) */}
            {selectedCell?.status === "VAGO" && (
              <>
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
                <View style={{ alignItems: "center", justifyContent: "center", paddingVertical: 24 }}>
                  <User size={28} color={theme.colors.textMuted} />
                  <Text style={{ fontSize: 13, color: theme.colors.textMuted, marginTop: 8, textAlign: "center" }}>
                    Integração com lista de profissionais em breve.{"\n"}
                    Use a tela de edição individual por enquanto.
                  </Text>
                </View>
              </>
            )}
          </View>
        </View>
      </Modal>
    </ScreenGradient>
  );
}

import { Text, View, ScrollView, TouchableOpacity, RefreshControl, TextInput } from "react-native";
import { useState, useMemo } from "react";
import { Clock, MapPin, Plus, Search, CalendarDays, Clock3 } from "lucide-react-native";
import { useRouter } from "expo-router";
import * as Haptics from "expo-haptics";

import { ScreenGradient } from "@/components/ui/ScreenGradient";
import { TintedGlassCard } from "@/components/ui/TintedGlassCard";
import { Badge } from "@/components/ui/Badge";
import { useAuth } from "@/hooks/use-auth";
import { SHIFT_TIMES, type ShiftType } from "@/lib/demo-mode";
import { trpc } from "@/lib/trpc";
import { theme } from "@/lib/theme";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";

type ShiftWithDetails = {
  id: number;
  label: string;
  shiftType: ShiftType;
  startTime: Date;
  endTime: Date;
  status: string;
  hospitalId: number;
  sectorId: number;
  assignmentCount: number;
  professionalNames: string[];
};

const SLOT_LABELS = ["Manhã", "Tarde", "Noite"] as const;

function toDateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function classifySlot(label: string, startAt: Date): number {
  const normalized = (label || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  if (normalized.includes("manha") || normalized.includes("morning")) return 0;
  if (normalized.includes("tarde") || normalized.includes("afternoon")) return 1;
  if (normalized.includes("noite") || normalized.includes("night")) return 2;

  const hour = startAt.getHours();
  if (hour >= 6 && hour < 13) return 0;
  if (hour >= 13 && hour < 19) return 1;
  return 2;
}

export default function CalendarScreen() {
  const { user } = useAuth();
  const router = useRouter();
  const [selectedDate, setSelectedDate] = useState(new Date());
  const [refreshing, setRefreshing] = useState(false);
  const [selectedTurnFilter, setSelectedTurnFilter] = useState<ShiftType | "todos">("todos");
  const [searchShiftText, setSearchShiftText] = useState("");

  const selectedDateKey = useMemo(() => toDateKey(selectedDate), [selectedDate]);

  // Query period = entire visible month
  const periodStart = useMemo(() => {
    const d = new Date(selectedDate.getFullYear(), selectedDate.getMonth(), 1);
    return d.toISOString();
  }, [selectedDate]);
  const periodEnd = useMemo(() => {
    const d = new Date(selectedDate.getFullYear(), selectedDate.getMonth() + 1, 1);
    return d.toISOString();
  }, [selectedDate]);

  const { data: shiftsData, refetch } = trpc.shifts.listByPeriod.useQuery(
    { startDate: periodStart, endDate: periodEnd },
    { enabled: !!user?.id },
  );
  const { data: hospitalsData } = trpc.hospitals.list.useQuery(undefined, { enabled: !!user?.id });
  const { data: sectorsData } = trpc.sectors.list.useQuery(undefined, { enabled: !!user?.id });

  const allShifts: ShiftWithDetails[] = useMemo(() => {
    if (!shiftsData) return [];
    return shiftsData.map((item) => {
      const start = new Date(item.startAt);
      const hour = start.getHours();
      let shiftType: ShiftType = "manha";
      if (hour >= 7 && hour < 13) shiftType = "manha";
      else if (hour >= 13 && hour < 19) shiftType = "tarde";
      else shiftType = "noite";
      return {
        id: item.id,
        label: item.label,
        shiftType,
        startTime: start,
        endTime: new Date(item.endAt),
        status: item.status,
        hospitalId: item.hospitalId,
        sectorId: item.sectorId,
        assignmentCount: item.assignments.length,
        professionalNames: item.assignments
          .map((assignment) => assignment.professionalName)
          .filter((name): name is string => Boolean(name)),
      };
    });
  }, [shiftsData]);

  const hospitalsById = useMemo(() => {
    const map = new Map<number, string>();
    for (const h of hospitalsData || []) map.set(h.id, h.name);
    return map;
  }, [hospitalsData]);

  const sectorsById = useMemo(() => {
    const map = new Map<number, string>();
    for (const s of sectorsData || []) map.set(s.id, s.name);
    return map;
  }, [sectorsData]);

  const getBadgeVariant = (status: string) => {
    if (status === "OCUPADO") return "success";
    if (status === "PENDENTE") return "warning";
    return "critical"; // VAGO
  };

  const monthGridDates = useMemo(() => {
    const first = new Date(selectedDate.getFullYear(), selectedDate.getMonth(), 1);
    const day = first.getDay();
    const mondayOffset = day === 0 ? -6 : 1 - day;
    const gridStart = new Date(first);
    gridStart.setDate(first.getDate() + mondayOffset);

    return Array.from({ length: 42 }, (_, idx) => {
      const d = new Date(gridStart);
      d.setDate(gridStart.getDate() + idx);
      return d;
    });
  }, [selectedDate]);

  const radarByDate = useMemo(() => {
    const map = new Map<
      string,
      {
        slots: { hasAny: boolean; hasVacancy: boolean }[];
        shifts: Array<{
          id: number;
          label: string;
          status: string;
          startAt: string;
          endAt: string;
          hospitalName: string;
          sectorName: string;
          slotIndex: number;
          professionalNames: string[];
        }>;
      }
    >();

    for (const shift of allShifts) {
      const key = toDateKey(shift.startTime);
      const slotIndex = classifySlot(shift.label, shift.startTime);
      const status = String(shift.status || "VAGO");
      const entry = map.get(key) || {
        slots: [
          { hasAny: false, hasVacancy: false },
          { hasAny: false, hasVacancy: false },
          { hasAny: false, hasVacancy: false },
        ],
        shifts: [],
      };

      entry.slots[slotIndex].hasAny = true;
      if (status === "VAGO") entry.slots[slotIndex].hasVacancy = true;

      entry.shifts.push({
        id: shift.id,
        label: shift.label,
        status,
        startAt: shift.startTime.toISOString(),
        endAt: shift.endTime.toISOString(),
        hospitalName: hospitalsById.get(shift.hospitalId) || `Hospital #${shift.hospitalId}`,
        sectorName: sectorsById.get(shift.sectorId) || `Setor #${shift.sectorId}`,
        slotIndex,
        professionalNames: shift.professionalNames,
      });

      map.set(key, entry);
    }

    return map;
  }, [allShifts, hospitalsById, sectorsById]);

  const selectedDayShifts = useMemo(() => {
    const base = radarByDate.get(selectedDateKey)?.shifts || [];
    const term = searchShiftText.trim().toLowerCase();
    const filtered = term
      ? base.filter((s) =>
          `${s.label} ${s.hospitalName} ${s.sectorName} ${SLOT_LABELS[s.slotIndex]} ${s.status} ${s.professionalNames.join(" ")}`
            .toLowerCase()
            .includes(term),
        )
      : base;

    return filtered.sort(
      (a, b) => new Date(a.startAt).getTime() - new Date(b.startAt).getTime(),
    );
  }, [radarByDate, selectedDateKey, searchShiftText]);

  const slotFillColor = (hasAny: boolean, hasVacancy: boolean) => {
    if (hasVacancy) return "rgba(34,197,94,0.95)";
    if (hasAny) return "rgba(245,158,11,0.9)";
    return "rgba(148,163,184,0.2)";
  };

  // Filtrar escalas do dia selecionado
  const shiftsOnSelectedDate = useMemo(() => {
    return allShifts.filter((shift) => {
      return (
        shift.startTime.getFullYear() === selectedDate.getFullYear() &&
        shift.startTime.getMonth() === selectedDate.getMonth() &&
        shift.startTime.getDate() === selectedDate.getDate()
      );
    });
  }, [allShifts, selectedDate]);

  // Agrupar escalas por turno e aplicar filtro
  const shiftsByTurn = useMemo(() => {
    const groups: Record<ShiftType, ShiftWithDetails[]> = {
      manha: [],
      tarde: [],
      noite: [],
    };
    
    const filteredShifts = selectedTurnFilter === "todos" 
      ? shiftsOnSelectedDate 
      : shiftsOnSelectedDate.filter(s => s.shiftType === selectedTurnFilter);
    
    filteredShifts.forEach((shift) => {
      groups[shift.shiftType].push(shift);
    });
    
    return groups;
  }, [shiftsOnSelectedDate, selectedTurnFilter]);

  const onRefresh = async () => {
    setRefreshing(true);
    await refetch();
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setRefreshing(false);
  };

  return (
    <ScreenGradient>
      <ScrollView 
        contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 20, paddingBottom: 100 }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor="#4DA3FF"
            colors={["#4DA3FF"]}
          />
        }
      >
        {/* Header */}
        <View style={{ marginBottom: 24 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 8 }}>
            <CalendarDays size={28} color={theme.colors.accent} />
            <Text style={{ fontSize: 28, fontWeight: "700", color: theme.colors.textPrimary }}>
              Radar de Plantões
            </Text>
          </View>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 12, marginBottom: 8 }}>
            <Text style={{ fontSize: 16, color: theme.colors.textSecondary }}>
              Toque em um dia para ver os plantões de todos os hospitais
            </Text>
          </View>
        </View>

        <View style={{ marginBottom: 24 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 10 }}>
            <CalendarDays size={20} color={theme.colors.textPrimary} />
            <Text style={{ fontSize: 20, fontWeight: "700", color: theme.colors.textPrimary }}>
              Radar de Plantões
            </Text>
          </View>

          <TintedGlassCard style={{ marginBottom: 12 }}>
            <Text style={{ fontSize: 14, color: theme.colors.textSecondary, marginBottom: 10 }}>
              Toque em um dia para ver os plantões de todos os hospitais.
            </Text>

            <View style={{ flexDirection: "row", marginBottom: 8 }}>
              {["Seg", "Ter", "Qua", "Qui", "Sex", "Sáb", "Dom"].map((d) => (
                <Text key={d} style={{ flex: 1, textAlign: "center", fontSize: 11, fontWeight: "700", color: theme.colors.textSecondary }}>
                  {d}
                </Text>
              ))}
            </View>

            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
              {monthGridDates.map((d) => {
                const key = toDateKey(d);
                const selected = key === selectedDateKey;
                const inCurrentMonth = d.getMonth() === selectedDate.getMonth();
                const info = radarByDate.get(key);
                const slots = info?.slots || [
                  { hasAny: false, hasVacancy: false },
                  { hasAny: false, hasVacancy: false },
                  { hasAny: false, hasVacancy: false },
                ];

                return (
                  <TouchableOpacity
                    key={key}
                    onPress={() => setSelectedDate(d)}
                    activeOpacity={0.8}
                    style={{
                      width: "13.4%",
                      minWidth: 42,
                      borderRadius: 10,
                      borderWidth: selected ? 1.5 : 1,
                      borderColor: selected ? theme.colors.accent : theme.colors.border,
                      backgroundColor: selected ? "rgba(29,78,216,0.12)" : theme.colors.card,
                      paddingVertical: 6,
                      paddingHorizontal: 4,
                    }}
                  >
                    <Text
                      style={{
                        textAlign: "center",
                        fontSize: 12,
                        fontWeight: "700",
                        color: inCurrentMonth ? theme.colors.textPrimary : "#94A3B8",
                        marginBottom: 5,
                      }}
                    >
                      {d.getDate()}
                    </Text>
                    <View style={{ gap: 3 }}>
                      {slots.map((slot, idx) => (
                        <View
                          key={`${key}-${idx}`}
                          style={{
                            height: 5,
                            borderRadius: 999,
                            backgroundColor: slotFillColor(slot.hasAny, slot.hasVacancy),
                          }}
                        />
                      ))}
                    </View>
                  </TouchableOpacity>
                );
              })}
            </View>

            <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginTop: 10 }}>
              <View style={{ width: 10, height: 10, borderRadius: 999, backgroundColor: "rgba(34,197,94,0.95)" }} />
              <Text style={{ fontSize: 11, color: theme.colors.textSecondary }}>Com vaga</Text>
              <View style={{ width: 10, height: 10, borderRadius: 999, backgroundColor: "rgba(245,158,11,0.9)" }} />
              <Text style={{ fontSize: 11, color: theme.colors.textSecondary }}>Sem vaga</Text>
            </View>
          </TintedGlassCard>

          <TintedGlassCard>
            <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
              <Text style={{ fontSize: 18, fontWeight: "600", color: theme.colors.textPrimary }}>
                Plantões de {new Date(`${selectedDateKey}T00:00:00`).toLocaleDateString("pt-BR")}
              </Text>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                <Clock3 size={14} color={theme.colors.textSecondary} />
                <Text style={{ color: theme.colors.textSecondary, fontSize: 12 }}>
                  {selectedDayShifts.length} resultado{selectedDayShifts.length !== 1 ? "s" : ""}
                </Text>
              </View>
            </View>

            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 8,
                borderWidth: 1,
                borderColor: theme.colors.border,
                borderRadius: 10,
                backgroundColor: theme.colors.card,
                paddingHorizontal: 10,
                paddingVertical: 8,
                marginBottom: 12,
              }}
            >
              <Search size={16} color={theme.colors.textSecondary} />
              <TextInput
                value={searchShiftText}
                onChangeText={setSearchShiftText}
                placeholder="Pesquisar hospital, setor, turno..."
                placeholderTextColor={theme.colors.textSecondary}
                style={{ flex: 1, color: theme.colors.textPrimary, fontSize: 14, paddingVertical: 0 }}
              />
            </View>

            {selectedDayShifts.length === 0 ? (
              <Text style={{ color: theme.colors.textSecondary }}>
                Nenhum plantão encontrado para esse dia/filtro.
              </Text>
            ) : (
              <View style={{ gap: 8 }}>
                {selectedDayShifts.map((shift) => (
                  <TouchableOpacity
                    key={shift.id}
                    onPress={() => router.push({ pathname: "/edit-shift", params: { id: shift.id } })}
                    activeOpacity={0.8}
                    style={{
                      borderWidth: 1,
                      borderColor:
                        shift.status === "VAGO"
                          ? "rgba(239,68,68,0.85)"
                          : shift.status === "PENDENTE"
                            ? "rgba(245,158,11,0.85)"
                            : "rgba(34,197,94,0.85)",
                      borderRadius: 12,
                      padding: 10,
                      backgroundColor: "rgba(15,23,42,0.55)",
                    }}
                  >
                    <Text style={{ color: theme.colors.textPrimary, fontSize: 14, fontWeight: "700" }}>
                      {SLOT_LABELS[shift.slotIndex]} • {shift.label}
                    </Text>
                    <Text style={{ color: theme.colors.textSecondary, fontSize: 12, marginTop: 2 }}>
                      {shift.hospitalName} • {shift.sectorName}
                    </Text>
                    {shift.professionalNames.length > 0 ? (
                      <Text style={{ color: theme.colors.textSecondary, fontSize: 12, marginTop: 2 }}>
                        {shift.professionalNames.join(", ")}
                      </Text>
                    ) : null}
                    <Text style={{ color: theme.colors.textSecondary, fontSize: 12, marginTop: 2 }}>
                      {new Date(shift.startAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}–{new Date(shift.endAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })} • {shift.status}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            )}
          </TintedGlassCard>
        </View>

        {/* Filtro por Turno */}
        <View style={{ marginBottom: 24 }}>
          <Text style={{ fontSize: 16, fontWeight: "600", color: theme.colors.textPrimary, marginBottom: 12 }}>
            Filtrar por turno
          </Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            <View style={{ flexDirection: "row", gap: 12 }}>
              {(["todos", "manha", "tarde", "noite"] as const).map((turn) => (
                <TouchableOpacity
                  key={turn}
                  onPress={() => {
                    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                    setSelectedTurnFilter(turn);
                  }}
                  style={{
                    paddingHorizontal: 20,
                    paddingVertical: 10,
                    borderRadius: 16,
                    backgroundColor:
                      selectedTurnFilter === turn
                        ? "rgba(77,163,255,0.3)"
                        : theme.colors.card,
                    borderWidth: 2,
                    borderColor:
                      selectedTurnFilter === turn
                        ? "#4DA3FF"
                        : theme.colors.border,
                  }}
                  activeOpacity={0.7}
                >
                  <Text
                    style={{
                      fontSize: 14,
                      fontWeight: "600",
                      color: selectedTurnFilter === turn ? theme.colors.accent : theme.colors.textPrimary,
                    }}
                  >
                    {turn === "todos" ? "Todos" : turn === "manha" ? "Manhã" : turn === "tarde" ? "Tarde" : "Noite"}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          </ScrollView>
        </View>

        {/* Detalhes do Dia Selecionado */}
        <View style={{ marginBottom: 16 }}>
          <Text style={{ fontSize: 20, fontWeight: "600", color: theme.colors.textPrimary, marginBottom: 4 }}>
            {format(selectedDate, "EEEE, d 'de' MMMM", { locale: ptBR })}
          </Text>
          <Text style={{ fontSize: 14, color: theme.colors.textSecondary }}>
            {shiftsOnSelectedDate.length} {shiftsOnSelectedDate.length === 1 ? "escala" : "escalas"} neste dia
          </Text>
        </View>

        {/* Turnos do Dia */}
        {shiftsOnSelectedDate.length === 0 ? (
          <TintedGlassCard>
            <Text style={{ fontSize: 16, color: theme.colors.textSecondary, textAlign: "center" }}>
              Nenhuma escala neste dia
            </Text>
          </TintedGlassCard>
        ) : (
          <View style={{ gap: 16 }}>
            {/* Turno Manhã */}
            {shiftsByTurn.manha.length > 0 && (
              <View>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 12 }}>
                  <Clock size={20} color="#FFA500" />
                  <Text style={{ fontSize: 18, fontWeight: "600", color: theme.colors.textPrimary }}>
                    Manhã
                  </Text>
                  <Text style={{ fontSize: 14, color: theme.colors.textSecondary }}>
                    {SHIFT_TIMES.manha.hours}
                  </Text>
                </View>
                <View style={{ gap: 12 }}>
                  {shiftsByTurn.manha.map((shift) => (
                    <TintedGlassCard key={shift.id} onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); router.push({ pathname: "/edit-shift", params: { id: shift.id } }); }}>
                      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                          <MapPin size={18} color="#4DA3FF" />
                          <Text style={{ fontSize: 16, fontWeight: "600", color: theme.colors.textPrimary }}>
                            {shift.label}
                          </Text>
                        </View>
                        <Badge variant={getBadgeVariant(shift.status)}>
                          {shift.status}
                        </Badge>
                      </View>
                      {shift.assignmentCount > 0 && (
                        <Text style={{ fontSize: 13, color: theme.colors.textSecondary, marginTop: 4 }}>
                          {shift.assignmentCount} profissional{shift.assignmentCount !== 1 ? "is" : ""} alocado{shift.assignmentCount !== 1 ? "s" : ""}
                        </Text>
                      )}
                    </TintedGlassCard>
                  ))}
                </View>
              </View>
            )}

            {/* Turno Tarde */}
            {shiftsByTurn.tarde.length > 0 && (
              <View>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 12 }}>
                  <Clock size={20} color="#FFD700" />
                  <Text style={{ fontSize: 18, fontWeight: "600", color: theme.colors.textPrimary }}>
                    Tarde
                  </Text>
                  <Text style={{ fontSize: 14, color: theme.colors.textSecondary }}>
                    {SHIFT_TIMES.tarde.hours}
                  </Text>
                </View>
                <View style={{ gap: 12 }}>
                  {shiftsByTurn.tarde.map((shift) => (
                    <TintedGlassCard key={shift.id} onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); router.push({ pathname: "/edit-shift", params: { id: shift.id } }); }}>
                      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                          <MapPin size={18} color="#4DA3FF" />
                          <Text style={{ fontSize: 16, fontWeight: "600", color: theme.colors.textPrimary }}>
                            {shift.label}
                          </Text>
                        </View>
                        <Badge variant={getBadgeVariant(shift.status)}>
                          {shift.status}
                        </Badge>
                      </View>
                      {shift.assignmentCount > 0 && (
                        <Text style={{ fontSize: 13, color: theme.colors.textSecondary, marginTop: 4 }}>
                          {shift.assignmentCount} profissional{shift.assignmentCount !== 1 ? "is" : ""} alocado{shift.assignmentCount !== 1 ? "s" : ""}
                        </Text>
                      )}
                    </TintedGlassCard>
                  ))}
                </View>
              </View>
            )}

            {/* Turno Noite */}
            {shiftsByTurn.noite.length > 0 && (
              <View>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 12 }}>
                  <Clock size={20} color="#9370DB" />
                  <Text style={{ fontSize: 18, fontWeight: "600", color: theme.colors.textPrimary }}>
                    Noite
                  </Text>
                  <Text style={{ fontSize: 14, color: theme.colors.textSecondary }}>
                    {SHIFT_TIMES.noite.hours}
                  </Text>
                </View>
                <View style={{ gap: 12 }}>
                  {shiftsByTurn.noite.map((shift) => (
                    <TintedGlassCard key={shift.id} onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); router.push({ pathname: "/edit-shift", params: { id: shift.id } }); }}>
                      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                          <MapPin size={18} color="#4DA3FF" />
                          <Text style={{ fontSize: 16, fontWeight: "600", color: theme.colors.textPrimary }}>
                            {shift.label}
                          </Text>
                        </View>
                        <Badge variant={getBadgeVariant(shift.status)}>
                          {shift.status}
                        </Badge>
                      </View>
                      {shift.assignmentCount > 0 && (
                        <Text style={{ fontSize: 13, color: theme.colors.textSecondary, marginTop: 4 }}>
                          {shift.assignmentCount} profissional{shift.assignmentCount !== 1 ? "is" : ""} alocado{shift.assignmentCount !== 1 ? "s" : ""}
                        </Text>
                      )}
                    </TintedGlassCard>
                  ))}
                </View>
              </View>
            )}
          </View>
        )}
      </ScrollView>

      {/* Botão Flutuante para Criar Escala */}
      <TouchableOpacity
        onPress={() => {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
          router.push({
            pathname: "/create-shift",
            params: {
              preselectedDate: selectedDate.toISOString(),
              preselectedTurn: "manha", // Padrão: manhã
            },
          });
        }}
        style={{
          position: "absolute",
          bottom: 100,
          right: 20,
          width: 60,
          height: 60,
          borderRadius: 30,
          backgroundColor: "#4DA3FF",
          alignItems: "center",
          justifyContent: "center",
          shadowColor: "#000",
          shadowOffset: { width: 0, height: 4 },
          shadowOpacity: 0.3,
          shadowRadius: 8,
          elevation: 8,
        }}
        activeOpacity={0.8}
      >
        <Plus size={28} color="#FFFFFF" strokeWidth={3} />
      </TouchableOpacity>
    </ScreenGradient>
  );
}

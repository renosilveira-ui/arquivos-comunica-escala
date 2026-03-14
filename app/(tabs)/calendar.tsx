import { Text, View, ScrollView, TouchableOpacity, Animated, RefreshControl } from "react-native";
import { useState, useMemo, useRef } from "react";
import { Calendar, Clock, MapPin, Plus } from "lucide-react-native";
import { useRouter } from "expo-router";
import * as Haptics from "expo-haptics";

import { ScreenGradient } from "@/components/ui/ScreenGradient";
import { TintedGlassCard } from "@/components/ui/TintedGlassCard";
import { MonthCalendar } from "@/components/ui/MonthCalendar";
import { Badge } from "@/components/ui/Badge";
import { useAuth } from "@/hooks/use-auth";
import { SHIFT_TIMES, type ShiftType } from "@/lib/demo-mode";
import { trpc } from "@/lib/trpc";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";

type ShiftWithDetails = {
  id: number;
  label: string;
  shiftType: ShiftType;
  startTime: Date;
  endTime: Date;
  status: string;
  assignmentCount: number;
  professionalNames: string[];
};

export default function CalendarScreen() {
  const { user } = useAuth();
  const router = useRouter();
  const utils = trpc.useUtils();
  const [selectedDate, setSelectedDate] = useState(new Date());
  const [visibleMonth, setVisibleMonth] = useState(() => {
    const now = new Date();
    return { year: now.getFullYear(), month: now.getMonth() };
  });
  const [refreshing, setRefreshing] = useState(false);
  const [selectedTurnFilter, setSelectedTurnFilter] = useState<ShiftType | "todos">("todos");

  // Query period = entire visible month
  const periodStart = useMemo(() => {
    const d = new Date(visibleMonth.year, visibleMonth.month, 1);
    return d.toISOString();
  }, [visibleMonth]);
  const periodEnd = useMemo(() => {
    const d = new Date(visibleMonth.year, visibleMonth.month + 1, 0, 23, 59, 59);
    return d.toISOString();
  }, [visibleMonth]);

  const { data: shiftsData, refetch } = trpc.shifts.listByPeriod.useQuery(
    { startDate: periodStart, endDate: periodEnd },
    { enabled: !!user?.id },
  );

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
        assignmentCount: item.assignments.length,
        professionalNames: [],
      };
    });
  }, [shiftsData]);

  const getBadgeVariant = (status: string) => {
    if (status === "OCUPADO") return "success";
    if (status === "PENDENTE") return "warning";
    return "critical"; // VAGO
  };

  // Mapa de escalas por dia (para MarkedDates no MonthCalendar)
  const shiftsPerDay = useMemo(() => {
    const map = new Map<string, number>();
    allShifts.forEach((shift) => {
      const d = shift.startTime;
      const dateKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      map.set(dateKey, (map.get(dateKey) || 0) + 1);
    });
    return map;
  }, [allShifts]);

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
            <Calendar size={28} color="#4DA3FF" />
            <Text style={{ fontSize: 28, fontWeight: "700", color: "#FFFFFF" }}>
              Calendário
            </Text>
          </View>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 12, marginBottom: 8 }}>
            <Text style={{ fontSize: 16, color: "rgba(255,255,255,0.7)" }}>
              Selecione um dia para ver os turnos
            </Text>
          </View>
        </View>

        {/* Calendário Mensal */}
        <TintedGlassCard style={{ marginBottom: 24 }}>
          <MonthCalendar
            selectedDate={selectedDate}
            onSelectDate={setSelectedDate}
            shiftsPerDay={shiftsPerDay}
          />
        </TintedGlassCard>

        {/* Filtro por Turno */}
        <View style={{ marginBottom: 24 }}>
          <Text style={{ fontSize: 16, fontWeight: "600", color: "#FFFFFF", marginBottom: 12 }}>
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
                        : "rgba(255,255,255,0.05)",
                    borderWidth: 2,
                    borderColor:
                      selectedTurnFilter === turn
                        ? "#4DA3FF"
                        : "rgba(255,255,255,0.1)",
                  }}
                  activeOpacity={0.7}
                >
                  <Text
                    style={{
                      fontSize: 14,
                      fontWeight: "600",
                      color: selectedTurnFilter === turn ? "#4DA3FF" : "#FFFFFF",
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
          <Text style={{ fontSize: 20, fontWeight: "600", color: "#FFFFFF", marginBottom: 4 }}>
            {format(selectedDate, "EEEE, d 'de' MMMM", { locale: ptBR })}
          </Text>
          <Text style={{ fontSize: 14, color: "rgba(255,255,255,0.6)" }}>
            {shiftsOnSelectedDate.length} {shiftsOnSelectedDate.length === 1 ? "escala" : "escalas"} neste dia
          </Text>
        </View>

        {/* Turnos do Dia */}
        {shiftsOnSelectedDate.length === 0 ? (
          <TintedGlassCard>
            <Text style={{ fontSize: 16, color: "rgba(255,255,255,0.5)", textAlign: "center" }}>
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
                  <Text style={{ fontSize: 18, fontWeight: "600", color: "#FFFFFF" }}>
                    Manhã
                  </Text>
                  <Text style={{ fontSize: 14, color: "rgba(255,255,255,0.6)" }}>
                    {SHIFT_TIMES.manha.hours}
                  </Text>
                </View>
                <View style={{ gap: 12 }}>
                  {shiftsByTurn.manha.map((shift) => (
                    <TintedGlassCard key={shift.id} onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); router.push({ pathname: "/edit-shift", params: { id: shift.id } }); }}>
                      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                          <MapPin size={18} color="#4DA3FF" />
                          <Text style={{ fontSize: 16, fontWeight: "600", color: "#FFFFFF" }}>
                            {shift.label}
                          </Text>
                        </View>
                        <Badge variant={getBadgeVariant(shift.status)}>
                          {shift.status}
                        </Badge>
                      </View>
                      {shift.assignmentCount > 0 && (
                        <Text style={{ fontSize: 13, color: "rgba(255,255,255,0.6)", marginTop: 4 }}>
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
                  <Text style={{ fontSize: 18, fontWeight: "600", color: "#FFFFFF" }}>
                    Tarde
                  </Text>
                  <Text style={{ fontSize: 14, color: "rgba(255,255,255,0.6)" }}>
                    {SHIFT_TIMES.tarde.hours}
                  </Text>
                </View>
                <View style={{ gap: 12 }}>
                  {shiftsByTurn.tarde.map((shift) => (
                    <TintedGlassCard key={shift.id} onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); router.push({ pathname: "/edit-shift", params: { id: shift.id } }); }}>
                      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                          <MapPin size={18} color="#4DA3FF" />
                          <Text style={{ fontSize: 16, fontWeight: "600", color: "#FFFFFF" }}>
                            {shift.label}
                          </Text>
                        </View>
                        <Badge variant={getBadgeVariant(shift.status)}>
                          {shift.status}
                        </Badge>
                      </View>
                      {shift.assignmentCount > 0 && (
                        <Text style={{ fontSize: 13, color: "rgba(255,255,255,0.6)", marginTop: 4 }}>
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
                  <Text style={{ fontSize: 18, fontWeight: "600", color: "#FFFFFF" }}>
                    Noite
                  </Text>
                  <Text style={{ fontSize: 14, color: "rgba(255,255,255,0.6)" }}>
                    {SHIFT_TIMES.noite.hours}
                  </Text>
                </View>
                <View style={{ gap: 12 }}>
                  {shiftsByTurn.noite.map((shift) => (
                    <TintedGlassCard key={shift.id} onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); router.push({ pathname: "/edit-shift", params: { id: shift.id } }); }}>
                      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                          <MapPin size={18} color="#4DA3FF" />
                          <Text style={{ fontSize: 16, fontWeight: "600", color: "#FFFFFF" }}>
                            {shift.label}
                          </Text>
                        </View>
                        <Badge variant={getBadgeVariant(shift.status)}>
                          {shift.status}
                        </Badge>
                      </View>
                      {shift.assignmentCount > 0 && (
                        <Text style={{ fontSize: 13, color: "rgba(255,255,255,0.6)", marginTop: 4 }}>
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

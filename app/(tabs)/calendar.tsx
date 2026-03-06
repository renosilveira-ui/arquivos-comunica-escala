import { Text, View, ScrollView, TouchableOpacity, Animated, RefreshControl } from "react-native";
import { useState, useMemo, useEffect, useRef } from "react";
import { Calendar, Clock, MapPin, Plus } from "lucide-react-native";
import { useRouter } from "expo-router";
import * as Haptics from "expo-haptics";

import { ScreenGradient } from "@/components/ui/ScreenGradient";
import { TintedGlassCard } from "@/components/ui/TintedGlassCard";
import { MonthCalendar } from "@/components/ui/MonthCalendar";
import { Badge } from "@/components/ui/Badge";
import { useAuth } from "@/hooks/use-auth";
import { DEMO_SHIFTS, SHIFT_TIMES, type ShiftType, isDemoMode, getSelectedService, DEMO_SERVICES } from "@/lib/demo-mode";
import { trpc } from "@/lib/trpc";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";

type ShiftWithDetails = {
  id: number;
  sector: { id: number; name: string };
  shiftType: ShiftType;
  startTime: Date;
  endTime: Date;
  status: "confirmada" | "pendente" | "cancelada";
  notes: string | null;
  assignments?: Array<{ professionalId: number; professionalName: string; confirmed: boolean }>;
};

export default function CalendarScreen() {
  const { user } = useAuth();
  const router = useRouter();
  const utils = trpc.useUtils();
  const [selectedDate, setSelectedDate] = useState(new Date());
  const [isDemo, setIsDemo] = useState(false);
  const [selectedService, setSelectedService] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedTurnFilter, setSelectedTurnFilter] = useState<ShiftType | "todos">("todos");

  // Verificar modo demo e serviço selecionado
  useEffect(() => {
    async function init() {
      const demo = await isDemoMode();
      setIsDemo(demo);
      const service = await getSelectedService();
      setSelectedService(service);
    }
    init();
  }, []);

  // Buscar escalas do banco (apenas se não estiver em modo demo)
  const { data: shiftsData } = trpc.shifts.listByPeriod.useQuery(
    { 
      startDate: new Date(), 
      endDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) 
    },
    { enabled: !!user?.id && !isDemo }
  );

  // Usar dados demo ou dados reais (filtrados por serviço)
  const allShifts: ShiftWithDetails[] = useMemo(() => {
    if (isDemo) {
      // Filtrar por serviço (exceto Gestão que vê tudo)
      const filtered = selectedService === 8 
        ? DEMO_SHIFTS 
        : DEMO_SHIFTS.filter((s: any) => s.serviceId === selectedService);
      
      return filtered.map((item) => ({
        id: item.shift.id,
        sector: item.sector,
        shiftType: item.shiftType!,
        startTime: new Date(item.shift.startTime),
        endTime: new Date(item.shift.endTime),
        status: item.shift.status,
        notes: item.shift.notes,
        assignments: item.assignments,
      }));
    }
    
    if (!shiftsData) return [];
    
    return shiftsData.map((item) => {
      const start = new Date(item.shift.startTime);
      const hour = start.getHours();
      let shiftType: ShiftType = "manha";
      if (hour >= 7 && hour < 13) shiftType = "manha";
      else if (hour >= 13 && hour < 19) shiftType = "tarde";
      else shiftType = "noite";
      
      return {
        id: item.shift.id,
        sector: item.sector!,
        shiftType,
        startTime: start,
        endTime: new Date(item.shift.endTime),
        status: item.shift.status,
        notes: item.shift.notes,
        assignments: (item as any).assignments?.map((a: any) => ({
          professionalId: a.professionalId,
          professionalName: a.professional?.name || "Profissional",
          confirmed: a.confirmed,
        })),
      };
    });
  }, [isDemo, shiftsData]);

  // Calcular quantidade de escalas por dia
  const shiftsPerDay = useMemo(() => {
    const map = new Map<string, number>();
    allShifts.forEach((shift) => {
      const dateKey = `${shift.startTime.getFullYear()}-${String(shift.startTime.getMonth() + 1).padStart(2, "0")}-${String(shift.startTime.getDate()).padStart(2, "0")}`;
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

  const getBadgeVariant = (status: string) => {
    if (status === "confirmada") return "success";
    if (status === "cancelada") return "critical";
    return "warning";
  };

  const onRefresh = async () => {
    setRefreshing(true);
    // Simular atualização de dados (aguarda 1s)
    await new Promise(resolve => setTimeout(resolve, 1000));
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
            {selectedService && (
              <View style={{ 
                paddingHorizontal: 10, 
                paddingVertical: 4, 
                borderRadius: 10, 
                backgroundColor: "rgba(77,163,255,0.2)",
                borderWidth: 1,
                borderColor: "rgba(77,163,255,0.4)"
              }}>
                <Text style={{ fontSize: 12, fontWeight: "600", color: "#4DA3FF" }}>
                  {DEMO_SERVICES.find(s => s.id === selectedService)?.name}
                </Text>
              </View>
            )}
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
                    <TintedGlassCard key={shift.id}>
                      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                          <MapPin size={18} color="#4DA3FF" />
                          <Text style={{ fontSize: 16, fontWeight: "600", color: "#FFFFFF" }}>
                            {shift.sector.name}
                          </Text>
                        </View>
                        <Badge variant={getBadgeVariant(shift.status)}>
                          {shift.status}
                        </Badge>
                      </View>
                      {shift.assignments && shift.assignments.length > 0 && (
                        <View style={{ marginTop: 8, gap: 4 }}>
                          {shift.assignments.map((assignment, idx) => (
                            <Text key={idx} style={{ fontSize: 14, color: "rgba(255,255,255,0.7)" }}>
                              • {assignment.professionalName}
                            </Text>
                          ))}
                        </View>
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
                    <TintedGlassCard key={shift.id}>
                      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                          <MapPin size={18} color="#4DA3FF" />
                          <Text style={{ fontSize: 16, fontWeight: "600", color: "#FFFFFF" }}>
                            {shift.sector.name}
                          </Text>
                        </View>
                        <Badge variant={getBadgeVariant(shift.status)}>
                          {shift.status}
                        </Badge>
                      </View>
                      {shift.assignments && shift.assignments.length > 0 && (
                        <View style={{ marginTop: 8, gap: 4 }}>
                          {shift.assignments.map((assignment, idx) => (
                            <Text key={idx} style={{ fontSize: 14, color: "rgba(255,255,255,0.7)" }}>
                              • {assignment.professionalName}
                            </Text>
                          ))}
                        </View>
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
                    <TintedGlassCard key={shift.id}>
                      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                          <MapPin size={18} color="#4DA3FF" />
                          <Text style={{ fontSize: 16, fontWeight: "600", color: "#FFFFFF" }}>
                            {shift.sector.name}
                          </Text>
                        </View>
                        <Badge variant={getBadgeVariant(shift.status)}>
                          {shift.status}
                        </Badge>
                      </View>
                      {shift.assignments && shift.assignments.length > 0 && (
                        <View style={{ marginTop: 8, gap: 4 }}>
                          {shift.assignments.map((assignment, idx) => (
                            <Text key={idx} style={{ fontSize: 14, color: "rgba(255,255,255,0.7)" }}>
                              • {assignment.professionalName}
                            </Text>
                          ))}
                        </View>
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

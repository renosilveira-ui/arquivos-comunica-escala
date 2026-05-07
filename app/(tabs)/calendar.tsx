import { Text, View, ScrollView, TouchableOpacity, RefreshControl, TextInput } from "react-native";
import { useState, useMemo } from "react";
import { Plus, Search, CalendarDays, Clock3 } from "lucide-react-native";
import { useRouter } from "expo-router";
import * as Haptics from "expo-haptics";
import { ScreenGradient } from "@/components/ui/ScreenGradient";
import { TintedGlassCard } from "@/components/ui/TintedGlassCard";
import { ScreenContainer } from "@/components/ui/ScreenContainer";
import { useAuth } from "@/hooks/use-auth";
import { trpc } from "@/lib/trpc";
import { theme } from "@/lib/theme";

type Modality = "PLANTAO" | "SOBREAVISO";
type CoverageType = "URGENCIA_EMERGENCIA" | "ELETIVAS";

type ShiftWithDetails = {
  id: number;
  label: string;
  startTime: Date;
  endTime: Date;
  status: string;
  hospitalId: number;
  sectorId: number;
  professionalNames: string[];
  modality: Modality | null;
  coverageType: CoverageType | null;
};

const SLOT_LABELS = ["Manhã", "Tarde", "Noite"] as const;

function toDateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/**
 * Mapeia modality/coverage para o label tinted que aparece em cada
 * card. Mesma convenção dos PRs #69/#70 (Plantões em aberto e
 * Solicitações). Retorna null para rows legacy sem modality.
 */
function modalityBadge(modality: Modality | null, coverage: CoverageType | null): string | null {
  if (modality === "SOBREAVISO") return "Sobreaviso";
  if (modality !== "PLANTAO") return null;
  if (coverage === "URGENCIA_EMERGENCIA") return "Plantão · Urgência";
  if (coverage === "ELETIVAS") return "Plantão · Eletivas";
  return "Plantão";
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
  const [searchShiftText, setSearchShiftText] = useState("");

  const selectedDateKey = useMemo(() => toDateKey(selectedDate), [selectedDate]);

  const periodStart = useMemo(() => new Date(selectedDate.getFullYear(), selectedDate.getMonth(), 1).toISOString(), [selectedDate]);
  const periodEnd = useMemo(
    () => new Date(selectedDate.getFullYear(), selectedDate.getMonth() + 1, 1).toISOString(),
    [selectedDate],
  );

  const { data: shiftsData, refetch } = trpc.shifts.listByPeriod.useQuery(
    { startDate: periodStart, endDate: periodEnd },
    { enabled: !!user?.id },
  );
  const { data: hospitalsData } = trpc.hospitals.list.useQuery(undefined, { enabled: !!user?.id });
  const { data: sectorsData } = trpc.sectors.list.useQuery(undefined, { enabled: !!user?.id });

  const allShifts: ShiftWithDetails[] = useMemo(() => {
    if (!shiftsData) return [];
    return shiftsData.map((item) => {
      // Cast defensivo: shifts.listByPeriod usa Drizzle .select() na
      // tabela inteira, então as colunas adicionadas em PR #61 fluem,
      // mas o tipo do tRPC nem sempre infere em clients que não
      // regeneraram. Mesmo padrão de PRs #65/#67/#69/#70.
      const i = item as typeof item & {
        modality?: Modality | null;
        coverageType?: CoverageType | null;
      };
      return {
        id: i.id,
        label: i.label,
        startTime: new Date(i.startAt),
        endTime: new Date(i.endAt),
        status: i.status,
        hospitalId: i.hospitalId,
        sectorId: i.sectorId,
        professionalNames: i.assignments
          .map((assignment) => assignment.professionalName)
          .filter((name): name is string => Boolean(name)),
        modality: i.modality ?? null,
        coverageType: i.coverageType ?? null,
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
          modality: Modality | null;
          coverageType: CoverageType | null;
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
        modality: shift.modality,
        coverageType: shift.coverageType,
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
    return filtered.sort((a, b) => new Date(a.startAt).getTime() - new Date(b.startAt).getTime());
  }, [radarByDate, selectedDateKey, searchShiftText]);

  const slotFillColor = (hasAny: boolean, hasVacancy: boolean) => {
    if (hasVacancy) return theme.colors.success;
    if (hasAny) return theme.colors.warning;
    return theme.colors.border;
  };

  // T3 do audit: VAGO deixa de ser danger e vira neutro. Cores semânticas
  // continuam para PENDENTE (warning) e OCUPADO (success).
  const borderColorForStatus = (status: string) => {
    if (status === "VAGO") return theme.colors.border;
    if (status === "PENDENTE") return theme.colors.warning;
    return theme.colors.success;
  };

  const onRefresh = async () => {
    setRefreshing(true);
    await refetch();
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setRefreshing(false);
  };

  return (
    <ScreenGradient variant="light">
      <ScrollView
        contentContainerStyle={{ paddingBottom: 100 }}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.colors.primary} colors={[theme.colors.primary]} />
        }
      >
        <ScreenContainer>
          <View style={{ marginBottom: 24 }}>
            <Text style={{ fontSize: 34, fontWeight: "800", color: theme.colors.textPrimary }}>Agenda</Text>
            <Text style={{ fontSize: 15, color: theme.colors.textSecondary, marginTop: 4 }}>
              Radar de plantões por dia e turno.
            </Text>
          </View>

          <TintedGlassCard variant="light" style={{ marginBottom: 12 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 10 }}>
              <CalendarDays size={20} color={theme.colors.textPrimary} />
              <Text style={{ fontSize: 20, fontWeight: "700", color: theme.colors.textPrimary }}>Radar de Plantões</Text>
            </View>
            <Text style={{ fontSize: 14, color: theme.colors.textSecondary, marginBottom: 10 }}>
              Toque em um dia para ver os plantões de todos os hospitais.
            </Text>

            <View style={{ flexDirection: "row", marginBottom: 8 }}>
              {["Seg", "Ter", "Qua", "Qui", "Sex", "Sáb", "Dom"].map((d) => (
                <Text key={d} style={{ flex: 1, textAlign: "center", fontSize: 11, fontWeight: "700", color: theme.colors.textMuted }}>
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
                      borderColor: selected ? theme.colors.primary : theme.colors.border,
                      backgroundColor: selected ? theme.colors.primarySoft : theme.colors.surface,
                      paddingVertical: 6,
                      paddingHorizontal: 4,
                    }}
                  >
                    <Text
                      style={{
                        textAlign: "center",
                        fontSize: 12,
                        fontWeight: "700",
                        color: inCurrentMonth ? theme.colors.textPrimary : theme.colors.textDisabled,
                        marginBottom: 5,
                      }}
                    >
                      {d.getDate()}
                    </Text>
                    <View style={{ gap: 3 }}>
                      {slots.map((slot, idx) => (
                        <View key={`${key}-${idx}`} style={{ height: 5, borderRadius: 999, backgroundColor: slotFillColor(slot.hasAny, slot.hasVacancy) }} />
                      ))}
                    </View>
                  </TouchableOpacity>
                );
              })}
            </View>
          </TintedGlassCard>

          <TintedGlassCard variant="light">
            <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
              <Text style={{ fontSize: 18, fontWeight: "700", color: theme.colors.textPrimary }}>
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
                backgroundColor: theme.colors.surface,
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
                placeholderTextColor={theme.colors.textDisabled}
                style={{ flex: 1, color: theme.colors.textPrimary, fontSize: 14, paddingVertical: 0 }}
              />
            </View>

            {selectedDayShifts.length === 0 ? (
              <Text style={{ color: theme.colors.textSecondary }}>Nenhum plantão encontrado para esse dia/filtro.</Text>
            ) : (
              <View style={{ gap: 8 }}>
                {selectedDayShifts.map((shift) => {
                  const badge = modalityBadge(shift.modality, shift.coverageType);
                  return (
                    <TouchableOpacity
                      key={shift.id}
                      onPress={() => router.push({ pathname: "/edit-shift", params: { id: shift.id } })}
                      activeOpacity={0.8}
                      style={{
                        borderWidth: 1,
                        borderColor: borderColorForStatus(shift.status),
                        borderRadius: 12,
                        padding: 10,
                        backgroundColor: theme.colors.surface,
                      }}
                    >
                      <Text style={{ color: theme.colors.textPrimary, fontSize: 14, fontWeight: "700" }}>
                        {SLOT_LABELS[shift.slotIndex]} • {shift.label}
                      </Text>
                      {/* Badge de modalidade (PR #61 — exibido em
                          shift-details, vacancies e pending; agora
                          também na agenda diária). */}
                      {badge ? (
                        <View
                          style={{
                            alignSelf: "flex-start",
                            marginTop: 4,
                            paddingHorizontal: 8,
                            paddingVertical: 2,
                            borderRadius: 999,
                            backgroundColor: theme.colors.primarySoft,
                          }}
                        >
                          <Text style={{ color: theme.colors.primary, fontSize: 11, fontWeight: "600" }}>
                            {badge}
                          </Text>
                        </View>
                      ) : null}
                      <Text style={{ color: theme.colors.textSecondary, fontSize: 12, marginTop: 2 }}>
                        {shift.hospitalName} • {shift.sectorName}
                      </Text>
                      {shift.professionalNames.length > 0 ? (
                        <Text style={{ color: theme.colors.textSecondary, fontSize: 12, marginTop: 2 }}>{shift.professionalNames.join(", ")}</Text>
                      ) : null}
                      <Text style={{ color: theme.colors.textMuted, fontSize: 12, marginTop: 2 }}>
                        {new Date(shift.startAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}–
                        {new Date(shift.endAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })} • {shift.status}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            )}
          </TintedGlassCard>
        </ScreenContainer>
      </ScrollView>

      <TouchableOpacity
        onPress={() => {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
          router.push({
            pathname: "/create-shift",
            params: {
              preselectedDate: selectedDate.toISOString(),
              preselectedTurn: "manha",
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
          backgroundColor: theme.colors.primary,
          alignItems: "center",
          justifyContent: "center",
          ...theme.shadow.lg,
        }}
        activeOpacity={0.8}
      >
        <Plus size={28} color={theme.colors.surface} strokeWidth={3} />
      </TouchableOpacity>
    </ScreenGradient>
  );
}

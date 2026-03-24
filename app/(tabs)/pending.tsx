import { View, Text, TouchableOpacity, ActivityIndicator, Platform, Alert, ScrollView, TextInput } from "react-native";
import { ScreenGradient } from "@/components/ui/ScreenGradient";
import { ShiftFilters, type ShiftFilterValues } from "@/components/shift-filters";
import { trpc } from "@/lib/trpc";
import { useState, useCallback, useEffect, useMemo } from "react";
import { useRouter } from "expo-router";
import { Check, X, Clock, MapPin, User, Briefcase, ClipboardCheck, Lock, ArrowRightLeft, Search, Plus } from "lucide-react-native";
import * as Auth from "@/lib/_core/auth";
import { useAuth } from "@/hooks/use-auth";
import { useFilterDefaults } from "@/hooks/use-filter-defaults";

// ---------------------------------------------------------------------------
// Helpers for Available Swaps section
// ---------------------------------------------------------------------------

function getBaseUrl(): string {
  const envUrl = process.env.EXPO_PUBLIC_API_URL;
  if (envUrl) return envUrl;
  if (Platform.OS === "android") return "http://10.0.2.2:3000";
  return "http://localhost:3000";
}

async function swapFetch<T>(path: string, options?: RequestInit): Promise<{ ok: boolean; data: T | null }> {
  const url = getBaseUrl() + path;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options?.headers as Record<string, string>),
  };
  if (Platform.OS !== "web") {
    const token = await Auth.getSessionToken();
    if (token) headers["Authorization"] = "Bearer " + token;
  }
  const res = await fetch(url, { ...options, headers, credentials: Platform.OS === "web" ? "include" : undefined });
  let data: T | null = null;
  try { data = await res.json(); } catch {}
  return { ok: res.ok, data };
}

interface AvailableSwap {
  id: number;
  type: "SWAP" | "TRANSFER";
  reason: string | null;
  expiresAt: string | null;
  createdAt: string;
  fromProfessional: { name: string; role: string };
  fromShift: { id: number; label: string; startAt: string; endAt: string; hospitalName: string; sectorName: string };
  toShift: { id: number; label: string; startAt: string; endAt: string; hospitalName: string; sectorName: string } | null;
}

// 🔧 Função uiAlert para funcionar no web
const uiAlert = (title: string, message: string) => {
  if (Platform.OS === "web") {
    window.alert(`${title}\n\n${message}`);
  } else {
    Alert.alert(title, message);
  }
};

export default function PendingScreen() {
  const router = useRouter();
  const [refreshing, setRefreshing] = useState(false);
  const { user, isLoading: authLoading } = useAuth();
  const isAdminOrManager = user?.role === 'admin' || user?.role === 'manager';
  const [mySearch, setMySearch] = useState("");
  const [myDate, setMyDate] = useState(() => new Date().toISOString().split("T")[0]);

  // ── Available Swaps state ──
  const [availableSwaps, setAvailableSwaps] = useState<AvailableSwap[]>([]);
  const [swapsLoading, setSwapsLoading] = useState(false);
  const [swapActionId, setSwapActionId] = useState<number | null>(null);

  const fetchAvailableSwaps = useCallback(async () => {
    if (!user?.id) return;
    setSwapsLoading(true);
    const res = await swapFetch<any>(
      `/api/trpc/swaps.listAvailable?batch=1&input=${encodeURIComponent(JSON.stringify({ "0": { json: {} } }))}`,
    );
    const data: AvailableSwap[] = (res.data as any)?.[0]?.result?.data?.json ?? [];
    setAvailableSwaps(data);
    setSwapsLoading(false);
  }, [user?.id]);

  useEffect(() => { fetchAvailableSwaps(); }, [fetchAvailableSwaps]);

  const handleSwapAction = async (swapId: number, action: "accept" | "reject") => {
    setSwapActionId(swapId);
    const endpoint = action === "accept" ? "swaps.accept" : "swaps.reject";
    const res = await swapFetch<any>(`/api/trpc/${endpoint}?batch=1`, {
      method: "POST",
      body: JSON.stringify({ "0": { json: { swapRequestId: swapId } } }),
    });
    setSwapActionId(null);
    const result = (res.data as any)?.[0];
    if (result?.error) {
      uiAlert("Erro", result.error.json?.message ?? "Erro ao processar");
      return;
    }
    uiAlert("Sucesso", action === "accept" ? "Oferta aceita!" : "Oferta recusada!");
    fetchAvailableSwaps();
  };

  const fmtSwapDate = (iso: string) => {
    const d = new Date(iso);
    return d.toLocaleDateString("pt-BR", { weekday: "short", day: "2-digit", month: "short" });
  };

  const fmtSwapTime = (s: string, e: string) => {
    const sd = new Date(s); const ed = new Date(e);
    const p = (n: number) => String(n).padStart(2, "0");
    return `${p(sd.getHours())}:${p(sd.getMinutes())} – ${p(ed.getHours())}:${p(ed.getMinutes())}`;
  };
  
  // Buscar profissional associado ao usuário logado
  const { data: professional, isLoading: professionalLoading } =
    trpc.professionals.getByUserId.useQuery(
      { userId: user?.id ?? 0 },
      { enabled: !!user?.id },
    );

  // Buscar hospitais e setores para os filtros
  const { data: hospitalsData } = trpc.hospitals.list.useQuery(undefined, { enabled: !!user?.id });
  const { data: sectorsData } = trpc.sectors.list.useQuery(undefined, { enabled: !!user?.id });

  const hospitals = hospitalsData || [];
  const sectors = sectorsData || [];

  // Defaults inteligentes baseado em manager_scope
  const { defaults, isLoading: defaultsLoading } = useFilterDefaults({ hospitals, sectors });

  // Estado dos filtros
  const [filters, setFilters] = useState<ShiftFilterValues>({
    hospitalId: null,
    sectorId: null,
    date: new Date(),
    shiftLabel: null,
  });

  // Determinar se usuário pode ver "Todos os hospitais"
  const allowAllHospitals = professional?.userRole === "GESTOR_PLUS" || isAdminOrManager;
  
  // Buscar contadores de vagas/pendências (com cache de 60s)
  const { data: counts } = trpc.filters.summaryCounts.useQuery(
    {
      date: filters.date.toISOString().split("T")[0], // YYYY-MM-DD
    },
    { 
      enabled: !!user?.id,
      staleTime: 60 * 1000, // Cache de 60 segundos
    }
  );

  // Buscar pendências com filtros
  const { data: pendingAssignments, isLoading, refetch } = trpc.shiftAssignments.listPending.useQuery(
    {
      hospitalId: filters.hospitalId ?? undefined,
      sectorId: filters.sectorId ?? undefined,
      date: filters.date.toISOString().split("T")[0], // YYYY-MM-DD
      shiftLabel: filters.shiftLabel ?? undefined,
    },
    { enabled: !!user?.id }
  );

  const myShiftsStart = useMemo(() => {
    const d = new Date();
    d.setDate(d.getDate() - 30);
    return d.toISOString().split("T")[0];
  }, []);
  const myShiftsEnd = useMemo(() => {
    const d = new Date();
    d.setDate(d.getDate() + 90);
    return d.toISOString().split("T")[0];
  }, []);
  const { data: myShiftsData, isLoading: loadingMyShifts } = trpc.shifts.listByPeriod.useQuery(
    { startDate: myShiftsStart, endDate: myShiftsEnd },
    { enabled: !!user?.id && !!professional?.id }
  );

  const myShifts = useMemo(() => {
    if (!myShiftsData || !professional?.id) return [];
    const q = mySearch.trim().toLowerCase();
    const base = (myShiftsData as any[]).filter((shift) => {
      const assigned = (shift.assignments as any[]).some(
        (a: any) => a.professionalId === professional.id && a.isActive
      );
      if (!assigned) return false;
      const day = new Date(shift.startAt).toISOString().slice(0, 10);
      if (day !== myDate) return false;
      if (!q) return true;
      return `${shift.label} ${shift.status}`.toLowerCase().includes(q);
    });

    return base.sort(
      (a, b) => new Date(a.startAt).getTime() - new Date(b.startAt).getTime()
    );
  }, [myShiftsData, professional?.id, myDate, mySearch]);

  const quickDates = useMemo(() => {
    const now = new Date();
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(now);
      d.setDate(now.getDate() + i);
      return d;
    });
  }, []);

  const approveAssignment = trpc.shiftInstances.approveAssignment.useMutation({
    onSuccess: () => {
      refetch();
      Alert.alert("Sucesso", "Alocação aprovada com sucesso!");
    },
    onError: (error: any) => {
      Alert.alert("Erro", error.message);
    },
  });

  const rejectAssignment = trpc.shiftInstances.rejectAssignment.useMutation({
    onSuccess: () => {
      refetch();
      Alert.alert("Sucesso", "Alocação rejeitada com sucesso!");
    },
    onError: (error: any) => {
      Alert.alert("Erro", error.message);
    },
  });

  const handleApprove = (assignmentId: number, professionalName: string) => {
    let confirmed = true;
    if (Platform.OS === "web") {
      confirmed = window.confirm(`Aprovar alocação de ${professionalName}?`);
    }

    if (!confirmed) return;

    approveAssignment.mutate(
      { assignmentId },
      {
        onSuccess: () => {
          refetch();
          uiAlert("Sucesso", "Alocação aprovada!");
        },
        onError: (err: any) => {
          uiAlert("Erro", err?.message ?? "Falha ao aprovar");
        },
      }
    );
  };

  const handleReject = (assignmentId: number, professionalName: string) => {
    let confirmed = true;
    if (Platform.OS === "web") {
      confirmed = window.confirm(`Rejeitar alocação de ${professionalName}?`);
    }

    if (!confirmed) return;

    rejectAssignment.mutate(
      { assignmentId, reason: "Rejeitado pelo gestor" },
      {
        onSuccess: () => {
          refetch();
          uiAlert("Sucesso", "Alocação rejeitada!");
        },
        onError: (err: any) => {
          uiAlert("Erro", err?.message ?? "Falha ao rejeitar");
        },
      }
    );
  };

  const handleFiltersChange = useCallback((newFilters: ShiftFilterValues) => {
    setFilters(newFilters);
  }, []);

  const formatDate = (date: Date) => {
    return new Date(date).toLocaleDateString("pt-BR", {
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  if (authLoading) {
    return (
      <ScreenGradient>
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator size="large" color="#4DA3FF" />
          <Text className="mt-4 text-base" style={{ color: "rgba(255,255,255,0.6)" }}>Carregando autenticação...</Text>
        </View>
      </ScreenGradient>
    );
  }

  if (!user) {
    return (
      <ScreenGradient>
        <View className="flex-1 items-center justify-center">
          <ClipboardCheck size={64} color="#94A3B8" />
          <Text className="text-xl font-semibold mt-4" style={{ color: "#FFFFFF" }}>Autenticação Necessária</Text>
          <Text className="text-center mt-2" style={{ color: "rgba(255,255,255,0.6)" }}>Faça login para visualizar pendências</Text>
        </View>
      </ScreenGradient>
    );
  }

  if (!professionalLoading && user && !professional && !isAdminOrManager) {
    return (
      <ScreenGradient>
        <View className="flex-1 items-center justify-center">
          <ClipboardCheck size={64} color="#94A3B8" />
          <Text className="text-xl font-semibold mt-4" style={{ color: "#FFFFFF" }}>Profissional Não Encontrado</Text>
          <Text className="text-center mt-2" style={{ color: "rgba(255,255,255,0.6)" }}>Seu usuário não está associado a um profissional</Text>
        </View>
      </ScreenGradient>
    );
  }

  if (isLoading || authLoading || professionalLoading || loadingMyShifts) {
    return (
      <ScreenGradient>
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator size="large" color="#4DA3FF" />
          <Text className="mt-4 text-base" style={{ color: "rgba(255,255,255,0.6)" }}>Carregando pendências...</Text>
        </View>
      </ScreenGradient>
    );
  }

  const isManagerView =
    isAdminOrManager ||
    professional?.userRole === "GESTOR_MEDICO" ||
    professional?.userRole === "GESTOR_PLUS";

  if (!isManagerView) {
    return (
      <ScreenGradient>
        <ScrollView className="flex-1 px-5 py-4">
          <View className="mb-6 flex-row items-center justify-between">
            <View>
              <Text className="text-3xl font-bold" style={{ color: "#FFFFFF" }}>Meus Plantões</Text>
              <Text className="mt-1 text-base" style={{ color: "rgba(255,255,255,0.6)" }}>
                Gerencie troca ou repasse dos seus turnos
              </Text>
            </View>
            <TouchableOpacity
              onPress={() => router.push("/request-swap")}
              style={{
                width: 42,
                height: 42,
                borderRadius: 999,
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: "#2563EB",
              }}
            >
              <Plus size={20} color="#FFFFFF" />
            </TouchableOpacity>
          </View>

          <View className="mb-4">
            <View className="mb-3 flex-row items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2">
              <Search size={16} color="rgba(255,255,255,0.65)" />
              <TextInput
                value={mySearch}
                onChangeText={setMySearch}
                placeholder="Pesquisar por rótulo/status"
                placeholderTextColor="rgba(255,255,255,0.45)"
                style={{ flex: 1, color: "#FFFFFF", fontSize: 13, paddingVertical: 0 }}
              />
            </View>

            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              <View className="flex-row gap-2">
                {quickDates.map((d) => {
                  const key = d.toISOString().slice(0, 10);
                  const selected = key === myDate;
                  return (
                    <TouchableOpacity
                      key={key}
                      onPress={() => setMyDate(key)}
                      style={{
                        paddingHorizontal: 12,
                        paddingVertical: 8,
                        borderRadius: 999,
                        borderWidth: 1,
                        borderColor: selected ? "#3B82F6" : "rgba(255,255,255,0.16)",
                        backgroundColor: selected ? "rgba(59,130,246,0.2)" : "rgba(255,255,255,0.04)",
                      }}
                    >
                      <Text style={{ color: "#FFF", fontSize: 12, fontWeight: "600" }}>
                        {d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" })}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </ScrollView>
          </View>

          {myShifts.length === 0 ? (
            <View className="items-center justify-center py-16">
              <ClipboardCheck size={60} color="rgba(255,255,255,0.2)" />
              <Text className="mt-4 text-lg font-semibold" style={{ color: "rgba(255,255,255,0.65)" }}>
                Nenhum plantão seu neste dia
              </Text>
            </View>
          ) : (
            <View className="gap-3 pb-8">
              {myShifts.map((shift: any) => (
                <View
                  key={shift.id}
                  className="rounded-2xl border border-white/10 bg-white/5 p-4"
                >
                  <View className="mb-2 flex-row items-center justify-between">
                    <Text className="text-base font-semibold" style={{ color: "#FFFFFF" }}>
                      {shift.label}
                    </Text>
                    <View className="rounded-full bg-white/10 px-3 py-1">
                      <Text style={{ color: "#E2E8F0", fontSize: 11 }}>{shift.status}</Text>
                    </View>
                  </View>
                  <Text style={{ color: "rgba(255,255,255,0.72)", fontSize: 13 }}>
                    {formatDate(shift.startAt)} - {formatDate(shift.endAt)}
                  </Text>

                  <View className="mt-4 flex-row gap-2">
                    <TouchableOpacity
                      onPress={() =>
                        router.push({
                          pathname: "/request-swap",
                          params: { type: "SWAP", fromShiftId: String(shift.id) },
                        })
                      }
                      className="flex-1 rounded-xl bg-blue-500 py-3 items-center"
                    >
                      <Text style={{ color: "#FFF", fontWeight: "700" }}>Pedir Troca</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      onPress={() =>
                        router.push({
                          pathname: "/request-swap",
                          params: { type: "TRANSFER", fromShiftId: String(shift.id) },
                        })
                      }
                      className="flex-1 rounded-xl bg-amber-500 py-3 items-center"
                    >
                      <Text style={{ color: "#111827", fontWeight: "700" }}>Repassar</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              ))}
            </View>
          )}
        </ScrollView>
      </ScreenGradient>
    );
  }

  return (
    <ScreenGradient>
      <ScrollView className="flex-1 px-5 py-4">
        {/* Header */}
        <View className="mb-6">
          <Text className="text-3xl font-bold" style={{ color: "#FFFFFF" }}>Pendências</Text>
          <Text className="mt-1 text-base" style={{ color: "rgba(255,255,255,0.6)" }}>
            {pendingAssignments?.length || 0} alocações aguardando aprovação
          </Text>
        </View>

        {/* ── Trocas Disponíveis para Você ── */}
        {availableSwaps.length > 0 && (
          <View style={{ marginBottom: 24 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 14 }}>
              <ArrowRightLeft size={22} color="#3B82F6" />
              <Text style={{ color: "#F1F5F9", fontSize: 20, fontWeight: "700" }}>Trocas Disponíveis</Text>
              <View style={{ backgroundColor: "#3B82F6", borderRadius: 10, minWidth: 22, height: 22, alignItems: "center", justifyContent: "center", paddingHorizontal: 6 }}>
                <Text style={{ color: "#FFF", fontSize: 12, fontWeight: "700" }}>{availableSwaps.length}</Text>
              </View>
            </View>
            {availableSwaps.map((sw) => (
              <View
                key={sw.id}
                style={{
                  backgroundColor: "#141B2D",
                  borderRadius: 12,
                  borderWidth: 1,
                  borderColor: "rgba(148,163,184,0.15)",
                  padding: 14,
                  marginBottom: 10,
                }}
              >
                {/* Type badge */}
                <View style={{ flexDirection: "row", gap: 8, marginBottom: 8 }}>
                  <View style={{
                    paddingHorizontal: 10,
                    paddingVertical: 4,
                    borderRadius: 999,
                    backgroundColor: sw.type === "SWAP" ? "rgba(59,130,246,0.18)" : "rgba(245,158,11,0.18)",
                    borderWidth: 1,
                    borderColor: sw.type === "SWAP" ? "rgba(59,130,246,0.55)" : "rgba(245,158,11,0.55)",
                  }}>
                    <Text style={{ color: "#F2F6FF", fontSize: 11, fontWeight: "600" }}>
                      {sw.type === "SWAP" ? "TROCA" : "REPASSE"}
                    </Text>
                  </View>
                </View>

                {/* From info */}
                <Text style={{ color: "#F1F5F9", fontSize: 14, fontWeight: "600" }}>
                  {sw.fromProfessional.name}
                  <Text style={{ color: "#94A3B8", fontWeight: "400" }}>{" "}• {sw.fromProfessional.role}</Text>
                </Text>
                <Text style={{ color: "#94A3B8", fontSize: 13, marginTop: 4 }}>
                  {sw.fromShift.label} — {fmtSwapDate(sw.fromShift.startAt)} • {fmtSwapTime(sw.fromShift.startAt, sw.fromShift.endAt)}
                </Text>
                <Text style={{ color: "#64748B", fontSize: 12 }}>
                  {sw.fromShift.hospitalName} / {sw.fromShift.sectorName}
                </Text>

                {/* To shift if SWAP */}
                {sw.toShift && (
                  <View style={{ marginTop: 6, paddingLeft: 10, borderLeftWidth: 2, borderLeftColor: "#F59E0B" }}>
                    <Text style={{ color: "#94A3B8", fontSize: 12 }}>Quer em troca:</Text>
                    <Text style={{ color: "#F1F5F9", fontSize: 13 }}>
                      {sw.toShift.label} — {fmtSwapDate(sw.toShift.startAt)} • {fmtSwapTime(sw.toShift.startAt, sw.toShift.endAt)}
                    </Text>
                  </View>
                )}

                {sw.reason && (
                  <Text style={{ color: "#94A3B8", fontSize: 12, fontStyle: "italic", marginTop: 4 }}>"{sw.reason}"</Text>
                )}

                {/* Action buttons */}
                <View style={{ flexDirection: "row", gap: 10, marginTop: 12 }}>
                  <TouchableOpacity
                    onPress={() => handleSwapAction(sw.id, "accept")}
                    disabled={swapActionId === sw.id}
                    style={{
                      flex: 1,
                      flexDirection: "row",
                      alignItems: "center",
                      justifyContent: "center",
                      gap: 6,
                      paddingVertical: 10,
                      borderRadius: 10,
                      backgroundColor: "#22C55E",
                      opacity: swapActionId === sw.id ? 0.6 : 1,
                    }}
                  >
                    {swapActionId === sw.id ? (
                      <ActivityIndicator color="#FFF" size="small" />
                    ) : (
                      <>
                        <Check size={16} color="#FFF" />
                        <Text style={{ color: "#FFF", fontSize: 14, fontWeight: "600" }}>Aceitar</Text>
                      </>
                    )}
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={() => handleSwapAction(sw.id, "reject")}
                    disabled={swapActionId === sw.id}
                    style={{
                      flex: 1,
                      flexDirection: "row",
                      alignItems: "center",
                      justifyContent: "center",
                      gap: 6,
                      paddingVertical: 10,
                      borderRadius: 10,
                      backgroundColor: "#EF4444",
                      opacity: swapActionId === sw.id ? 0.6 : 1,
                    }}
                  >
                    <X size={16} color="#FFF" />
                    <Text style={{ color: "#FFF", fontSize: 14, fontWeight: "600" }}>Recusar</Text>
                  </TouchableOpacity>
                </View>
              </View>
            ))}
          </View>
        )}

        {/* Filtros */}
        <View className="mb-6">
          <ShiftFilters
            hospitals={hospitals}
            sectors={sectors}
            allowAllHospitals={allowAllHospitals}
            initialValues={defaults}
            onChange={handleFiltersChange}
            counts={counts}
          />
        </View>

        {/* Lista de pendências */}
        {pendingAssignments && pendingAssignments.length > 0 ? (
          <View className="gap-4 pb-6">
            {pendingAssignments.map((pending) => (
              <View
                key={pending.assignmentId}
                className="rounded-2xl bg-white/5 border border-white/10 p-4"
              >
                {/* Cabeçalho do card */}
                <View className="flex-row items-center justify-between mb-3">
                  <View className="flex-row items-center gap-2">
                    <User size={20} color="#4DA3FF" />
                    <Text className="text-lg font-semibold" style={{ color: "#FFFFFF" }}>
                      {pending.professionalName}
                    </Text>
                  </View>
                  <View className="rounded-full bg-amber-500/20 px-3 py-1">
                    <Text className="text-xs font-semibold" style={{ color: '#FBBF24' }}>
                      {pending.professionalRole}
                    </Text>
                  </View>
                </View>

                {/* Informações do turno */}
                <View className="gap-2 mb-4">
                  <View className="flex-row items-center gap-2">
                    <MapPin size={16} color="rgba(255,255,255,0.6)" />
                    <Text className="text-sm" style={{ color: "rgba(255,255,255,0.6)" }}>{pending.sectorName}</Text>
                  </View>
                  <View className="flex-row items-center gap-2">
                    <Clock size={16} color="rgba(255,255,255,0.6)" />
                    <Text className="text-sm" style={{ color: "rgba(255,255,255,0.6)" }}>
                      {formatDate(pending.shiftStartAt)} - {formatDate(pending.shiftEndAt)}
                    </Text>
                  </View>
                  <View className="flex-row items-center gap-2">
                    <Briefcase size={16} color="rgba(255,255,255,0.6)" />
                    <Text className="text-sm" style={{ color: "rgba(255,255,255,0.6)" }}>
                      {pending.assignmentType === "ON_DUTY"
                        ? "Plantão"
                        : pending.assignmentType === "BACKUP"
                        ? "Retaguarda"
                        : "Sobreaviso"}
                    </Text>
                  </View>
                </View>

                {/* Botões de ação ou mensagem de permissão */}
                {professional?.userRole === "USER" ? (
                  // 🔒 Usuário comum: mostrar mensagem de permissão
                  <View className="flex-row items-center justify-center gap-2 rounded-xl bg-white/5 border border-white/10 py-3 px-4">
                    <Lock size={18} color="rgba(255,255,255,0.4)" />
                    <Text className="text-sm font-medium" style={{ color: "rgba(255,255,255,0.6)" }}>
                      Somente gestores podem aprovar pendências
                    </Text>
                  </View>
                ) : (
                  // ✅ Gestor: mostrar botões de aprovação/rejeição
                  <View className="flex-row gap-3">
                    <TouchableOpacity
                      onPress={() =>
                        handleApprove(
                          pending.assignmentId,
                          pending.professionalName,
                        )
                      }
                      disabled={approveAssignment.isPending || rejectAssignment.isPending}
                      className="flex-1 flex-row items-center justify-center gap-2 rounded-xl bg-green-500 py-3 active:opacity-80"
                    >
                      <Check size={20} color="white" />
                      <Text className="text-base font-semibold" style={{ color: "#FFFFFF" }}>Aprovar</Text>
                    </TouchableOpacity>

                    <TouchableOpacity
                      onPress={() =>
                        handleReject(
                          pending.assignmentId,
                          pending.professionalName,
                        )
                      }
                      disabled={approveAssignment.isPending || rejectAssignment.isPending}
                      className="flex-1 flex-row items-center justify-center gap-2 rounded-xl bg-red-500 py-3 active:opacity-80"
                    >
                      <X size={20} color="white" />
                      <Text className="text-base font-semibold" style={{ color: "#FFFFFF" }}>Rejeitar</Text>
                    </TouchableOpacity>
                  </View>
                )}
              </View>
            ))}
          </View>
        ) : (
          <View className="flex-1 items-center justify-center py-20">
            <ClipboardCheck size={64} color="rgba(255,255,255,0.2)" />
            <Text className="mt-4 text-lg font-semibold" style={{ color: "rgba(255,255,255,0.6)" }}>
              Nenhuma pendência no momento
            </Text>
            <Text className="mt-1 text-sm" style={{ color: "rgba(255,255,255,0.4)" }}>
              Todas as alocações foram processadas
            </Text>
          </View>
        )}
      </ScrollView>
    </ScreenGradient>
  );
}

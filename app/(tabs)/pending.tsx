import { View, Text, TouchableOpacity, ActivityIndicator, Platform, Alert, ScrollView } from "react-native";
import { ScreenGradient } from "@/components/ui/ScreenGradient";
import { ShiftFilters, type ShiftFilterValues } from "@/components/shift-filters";
import { trpc } from "@/lib/trpc";
import { useState, useCallback, useEffect } from "react";
import { Check, X, Clock, MapPin, User, Briefcase, ClipboardCheck, Lock, ArrowRightLeft } from "lucide-react-native";
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
  const [refreshing, setRefreshing] = useState(false);
  const { user, isLoading: authLoading } = useAuth();
  const isAdminOrManager = user?.role === 'admin' || user?.role === 'manager';

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
  const { data: professional, isLoading: professionalLoading } = trpc.professionals.getByUserId.useQuery(
    { userId: user?.id || 0 },
    { enabled: !!user?.id }
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
  const allowAllHospitals = professional?.role === "GESTOR_PLUS" || isAdminOrManager;
  
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
    if (!professional?.id) {
      uiAlert("Erro Interno", "ID do gestor não encontrado para aprovação.");
      return;
    }

    let confirmed = true;
    if (Platform.OS === "web") {
      confirmed = window.confirm(`Aprovar alocação de ${professionalName}?`);
    }

    if (!confirmed) return;

    approveAssignment.mutate(
      { assignmentId, professionalId: professional.id },
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
    if (!professional?.id) {
      uiAlert("Erro Interno", "ID do gestor não encontrado para rejeição.");
      return;
    }

    let confirmed = true;
    if (Platform.OS === "web") {
      confirmed = window.confirm(`Rejeitar alocação de ${professionalName}?`);
    }

    if (!confirmed) return;

    rejectAssignment.mutate(
      { assignmentId, professionalId: professional.id, reason: "Rejeitado pelo gestor" },
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

  if (!professionalLoading && user && !professional) {
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

  if (isLoading || authLoading || professionalLoading) {
    return (
      <ScreenGradient>
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator size="large" color="#4DA3FF" />
          <Text className="mt-4 text-base" style={{ color: "rgba(255,255,255,0.6)" }}>Carregando pendências...</Text>
        </View>
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
                {professional?.role === "USER" ? (
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
                      onPress={() => handleApprove(pending.assignmentId, pending.professionalName)}
                      disabled={approveAssignment.isPending || rejectAssignment.isPending}
                      className="flex-1 flex-row items-center justify-center gap-2 rounded-xl bg-green-500 py-3 active:opacity-80"
                    >
                      <Check size={20} color="white" />
                      <Text className="text-base font-semibold" style={{ color: "#FFFFFF" }}>Aprovar</Text>
                    </TouchableOpacity>

                    <TouchableOpacity
                      onPress={() => handleReject(pending.assignmentId, pending.professionalName)}
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

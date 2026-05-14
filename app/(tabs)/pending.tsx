import {
  View,
  Text,
  TouchableOpacity,
  ActivityIndicator,
  Platform,
  Alert,
  ScrollView,
  TextInput,
} from "react-native";
import { ScreenGradient } from "@/components/ui/ScreenGradient";
import { ScreenContainer } from "@/components/ui/ScreenContainer";
import {
  ShiftFilters,
  type ShiftFilterValues,
} from "@/components/shift-filters";
import { trpc } from "@/lib/trpc";
import { useState, useCallback, useMemo } from "react";
import { useRouter } from "expo-router";
import {
  Check,
  X,
  Clock,
  MapPin,
  User,
  Briefcase,
  ClipboardCheck,
  Lock,
  ArrowRightLeft,
  Search,
  Plus,
} from "lucide-react-native";
import { useAuth } from "@/hooks/use-auth";
import { useFilterDefaults } from "@/hooks/use-filter-defaults";
import { theme } from "@/lib/theme";

// ---------------------------------------------------------------------------
// Helpers for Available Swaps section
// ---------------------------------------------------------------------------

interface AvailableSwap {
  id: number;
  type: "SWAP" | "TRANSFER" | "CESSAO";
  reason: string | null;
  expiresAt: Date | string | null;
  createdAt: Date | string;
  fromProfessional: { name: string; role: string };
  fromShift: {
    id: number;
    label: string;
    startAt: Date | string;
    endAt: Date | string;
    hospitalName: string;
    sectorName: string;
  };
  toShift: {
    id: number;
    label: string;
    startAt: Date | string;
    endAt: Date | string;
    hospitalName: string;
    sectorName: string;
  } | null;
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
  const { user, isLoading: authLoading } = useAuth();
  const utils = trpc.useUtils();
  const isAdminOrManager = user?.role === "admin" || user?.role === "manager";
  const [mySearch, setMySearch] = useState("");
  const [myDate, setMyDate] = useState(
    () => new Date().toISOString().split("T")[0],
  );

  // ── Available Swaps state ──
  const [swapActionId, setSwapActionId] = useState<number | null>(null);
  const { data: availableSwapsData } = trpc.swaps.listAvailable.useQuery(
    {},
    { enabled: !!user?.id },
  );
  const availableSwaps = (availableSwapsData ?? []) as AvailableSwap[];

  const acceptSwap = trpc.swaps.accept.useMutation({
    onSuccess: async () => {
      await Promise.all([
        utils.swaps.listAvailable.invalidate(),
        utils.swaps.list.invalidate(),
      ]);
      uiAlert("Sucesso", "Oferta aceita!");
    },
    onError: (error) => {
      uiAlert("Erro", error.message || "Erro ao aceitar oferta");
    },
    onSettled: () => setSwapActionId(null),
  });
  const rejectSwap = trpc.swaps.reject.useMutation({
    onSuccess: async () => {
      await Promise.all([
        utils.swaps.listAvailable.invalidate(),
        utils.swaps.list.invalidate(),
      ]);
      uiAlert("Sucesso", "Oferta recusada!");
    },
    onError: (error) => {
      uiAlert("Erro", error.message || "Erro ao recusar oferta");
    },
    onSettled: () => setSwapActionId(null),
  });

  const handleSwapAction = (
    swapId: number,
    action: "accept" | "reject",
  ) => {
    setSwapActionId(swapId);
    const input = { swapRequestId: swapId };
    if (action === "accept") acceptSwap.mutate(input);
    else rejectSwap.mutate(input);
  };

  const fmtSwapDate = (value: Date | string) => {
    const d = new Date(value);
    return d.toLocaleDateString("pt-BR", {
      weekday: "short",
      day: "2-digit",
      month: "short",
    });
  };

  const fmtSwapTime = (s: Date | string, e: Date | string) => {
    const sd = new Date(s);
    const ed = new Date(e);
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
  const { data: hospitalsData } = trpc.hospitals.list.useQuery(undefined, {
    enabled: !!user?.id,
  });
  const { data: sectorsData } = trpc.sectors.list.useQuery(undefined, {
    enabled: !!user?.id,
  });

  const hospitals = hospitalsData || [];
  const sectors = sectorsData || [];

  // Defaults inteligentes baseado em manager_scope
  const { defaults } = useFilterDefaults({
    hospitals,
    sectors,
  });

  // Estado dos filtros
  const [filters, setFilters] = useState<ShiftFilterValues>({
    hospitalId: null,
    sectorId: null,
    date: new Date(),
    shiftLabel: null,
  });

  // Filtro por modalidade (PR #68 — listPending aceita modality como input).
  // undefined = "Todos" (sem filtro).
  const [modalityFilter, setModalityFilter] = useState<
    "PLANTAO" | "SOBREAVISO" | undefined
  >(undefined);

  // Determinar se usuário pode ver "Todos os hospitais"
  const allowAllHospitals =
    professional?.userRole === "GESTOR_PLUS" || isAdminOrManager;

  // Buscar contadores de vagas/pendências (com cache de 60s)
  const { data: counts } = trpc.filters.summaryCounts.useQuery(
    {
      date: filters.date.toISOString().split("T")[0], // YYYY-MM-DD
    },
    {
      enabled: !!user?.id,
      staleTime: 60 * 1000, // Cache de 60 segundos
    },
  );

  // Buscar pendências com filtros
  const {
    data: pendingAssignments,
    isLoading,
    refetch,
  } = trpc.shiftAssignments.listPending.useQuery(
    {
      hospitalId: filters.hospitalId ?? undefined,
      sectorId: filters.sectorId ?? undefined,
      date: filters.date.toISOString().split("T")[0], // YYYY-MM-DD
      shiftLabel: filters.shiftLabel ?? undefined,
      modality: modalityFilter,
    },
    { enabled: !!user?.id },
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
  const { data: myShiftsData, isLoading: loadingMyShifts } =
    trpc.shifts.listByPeriod.useQuery(
      { startDate: myShiftsStart, endDate: myShiftsEnd },
      { enabled: !!user?.id && !!professional?.id },
    );

  const myShifts = useMemo(() => {
    if (!myShiftsData || !professional?.id) return [];
    const q = mySearch.trim().toLowerCase();
    const base = (myShiftsData as any[]).filter((shift) => {
      const assigned = (shift.assignments as any[]).some(
        (a: any) => a.professionalId === professional.id && a.isActive,
      );
      if (!assigned) return false;
      const day = new Date(shift.startAt).toISOString().slice(0, 10);
      if (day !== myDate) return false;
      if (!q) return true;
      return `${shift.label} ${shift.status}`.toLowerCase().includes(q);
    });

    return base.sort(
      (a, b) => new Date(a.startAt).getTime() - new Date(b.startAt).getTime(),
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
      },
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
      },
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

  const renderAvailableSwapsSection = () => {
    if (availableSwaps.length === 0) return null;

    return (
      <View style={{ marginBottom: 24 }}>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 10,
            marginBottom: 14,
          }}
        >
          <ArrowRightLeft size={22} color={theme.colors.primary} />
          <Text
            style={{
              color: theme.colors.textPrimary,
              fontSize: 20,
              fontWeight: "700",
            }}
          >
            Trocas Disponíveis
          </Text>
          <View
            style={{
              backgroundColor: theme.colors.primary,
              borderRadius: 10,
              minWidth: 22,
              height: 22,
              alignItems: "center",
              justifyContent: "center",
              paddingHorizontal: 6,
            }}
          >
            <Text
              style={{
                color: theme.colors.surface,
                fontSize: 12,
                fontWeight: "700",
              }}
            >
              {availableSwaps.length}
            </Text>
          </View>
        </View>

        {availableSwaps.map((sw) => (
          <View
            key={sw.id}
            style={{
              backgroundColor: theme.colors.surface,
              borderRadius: 12,
              borderWidth: 1,
              borderColor: theme.colors.border,
              padding: 14,
              marginBottom: 10,
            }}
          >
            <View style={{ flexDirection: "row", gap: 8, marginBottom: 8 }}>
              <View
                style={{
                  paddingHorizontal: 10,
                  paddingVertical: 4,
                  borderRadius: 999,
                  backgroundColor:
                    sw.type === "SWAP"
                      ? theme.colors.primarySoft
                      : theme.colors.warningSoft,
                  borderWidth: 1,
                  borderColor:
                    sw.type === "SWAP"
                      ? theme.palette.primary[200]
                      : theme.colors.warning,
                }}
              >
                <Text
                  style={{
                    color: theme.colors.textPrimary,
                    fontSize: 11,
                    fontWeight: "600",
                  }}
                >
                  {sw.type === "SWAP" ? "TROCA" : "REPASSE"}
                </Text>
              </View>
            </View>

            <Text
              style={{
                color: theme.colors.textPrimary,
                fontSize: 14,
                fontWeight: "600",
              }}
            >
              {sw.fromProfessional.name}
              <Text
                style={{
                  color: theme.colors.textDisabled,
                  fontWeight: "400",
                }}
              >
                {" "}
                • {sw.fromProfessional.role}
              </Text>
            </Text>
            <Text
              style={{
                color: theme.colors.textDisabled,
                fontSize: 13,
                marginTop: 4,
              }}
            >
              {sw.fromShift.label} — {fmtSwapDate(sw.fromShift.startAt)} •{" "}
              {fmtSwapTime(sw.fromShift.startAt, sw.fromShift.endAt)}
            </Text>
            <Text style={{ color: theme.colors.textMuted, fontSize: 12 }}>
              {sw.fromShift.hospitalName} / {sw.fromShift.sectorName}
            </Text>

            {sw.toShift && (
              <View
                style={{
                  marginTop: 6,
                  paddingLeft: 10,
                  borderLeftWidth: 2,
                  borderLeftColor: theme.colors.warning,
                }}
              >
                <Text style={{ color: theme.colors.textDisabled, fontSize: 12 }}>
                  Quer em troca:
                </Text>
                <Text style={{ color: theme.colors.textPrimary, fontSize: 13 }}>
                  {sw.toShift.label} — {fmtSwapDate(sw.toShift.startAt)} •{" "}
                  {fmtSwapTime(sw.toShift.startAt, sw.toShift.endAt)}
                </Text>
              </View>
            )}

            {sw.reason && (
              <Text
                style={{
                  color: theme.colors.textDisabled,
                  fontSize: 12,
                  fontStyle: "italic",
                  marginTop: 4,
                }}
              >{`"${sw.reason}"`}</Text>
            )}

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
                  backgroundColor: theme.colors.success,
                  opacity: swapActionId === sw.id ? 0.6 : 1,
                }}
              >
                {swapActionId === sw.id ? (
                  <ActivityIndicator color={theme.colors.surface} size="small" />
                ) : (
                  <>
                    <Check size={16} color={theme.colors.surface} />
                    <Text
                      style={{
                        color: theme.colors.surface,
                        fontSize: 14,
                        fontWeight: "600",
                      }}
                    >
                      Aceitar
                    </Text>
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
                  backgroundColor: theme.colors.danger,
                  opacity: swapActionId === sw.id ? 0.6 : 1,
                }}
              >
                <X size={16} color={theme.colors.surface} />
                <Text
                  style={{
                    color: theme.colors.surface,
                    fontSize: 14,
                    fontWeight: "600",
                  }}
                >
                  Recusar
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        ))}
      </View>
    );
  };

  if (authLoading) {
    return (
      <ScreenGradient>
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator size="large" color={theme.colors.primary} />
          <Text
            className="mt-4 text-base"
            style={{ color: theme.colors.textMuted }}
          >
            Carregando autenticação...
          </Text>
        </View>
      </ScreenGradient>
    );
  }

  if (!user) {
    return (
      <ScreenGradient>
        <View className="flex-1 items-center justify-center">
          <ClipboardCheck size={64} color={theme.colors.textDisabled} />
          <Text
            className="text-xl font-semibold mt-4"
            style={{ color: theme.colors.textPrimary }}
          >
            Autenticação Necessária
          </Text>
          <Text
            className="text-center mt-2"
            style={{ color: theme.colors.textMuted }}
          >
            Faça login para visualizar pendências
          </Text>
        </View>
      </ScreenGradient>
    );
  }

  if (!professionalLoading && user && !professional && !isAdminOrManager) {
    return (
      <ScreenGradient>
        <View className="flex-1 items-center justify-center">
          <ClipboardCheck size={64} color={theme.colors.textDisabled} />
          <Text
            className="text-xl font-semibold mt-4"
            style={{ color: theme.colors.textPrimary }}
          >
            Profissional Não Encontrado
          </Text>
          <Text
            className="text-center mt-2"
            style={{ color: theme.colors.textMuted }}
          >
            Seu usuário não está associado a um profissional
          </Text>
        </View>
      </ScreenGradient>
    );
  }

  if (isLoading || authLoading || professionalLoading || loadingMyShifts) {
    return (
      <ScreenGradient>
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator size="large" color={theme.colors.primary} />
          <Text
            className="mt-4 text-base"
            style={{ color: theme.colors.textMuted }}
          >
            Carregando pendências...
          </Text>
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
              <Text
                className="text-3xl font-bold"
                style={{ color: theme.colors.textPrimary }}
              >
                Meus Plantões
              </Text>
              <Text
                className="mt-1 text-base"
                style={{ color: theme.colors.textSecondary }}
              >
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
                backgroundColor: theme.colors.primary,
              }}
            >
              <Plus size={20} color={theme.colors.surface} />
            </TouchableOpacity>
          </View>

          <View className="mb-4">
            <View
              className="mb-3 flex-row items-center gap-2 rounded-xl border px-3 py-2"
              style={{
                borderColor: theme.colors.border,
                backgroundColor: theme.colors.surface,
              }}
            >
              <Search size={16} color={theme.colors.textSecondary} />
              <TextInput
                value={mySearch}
                onChangeText={setMySearch}
                placeholder="Pesquisar por rótulo/status"
                placeholderTextColor={theme.colors.textMuted}
                style={{
                  flex: 1,
                  color: theme.colors.textPrimary,
                  fontSize: 13,
                  paddingVertical: 0,
                }}
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
                        borderColor: selected
                          ? theme.colors.primary
                          : theme.colors.border,
                        backgroundColor: selected
                          ? theme.colors.primarySoft
                          : theme.colors.surface,
                      }}
                    >
                      <Text
                        style={{
                          color: selected
                            ? theme.palette.primary[700]
                            : theme.palette.neutral[700],
                          fontSize: 12,
                          fontWeight: "600",
                        }}
                      >
                        {d.toLocaleDateString("pt-BR", {
                          day: "2-digit",
                          month: "2-digit",
                        })}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </ScrollView>
          </View>

          {renderAvailableSwapsSection()}

          {myShifts.length === 0 ? (
            <View className="items-center justify-center py-16">
              <ClipboardCheck size={60} color={theme.colors.borderStrong} />
              <Text
                className="mt-4 text-lg font-semibold"
                style={{ color: theme.colors.textSecondary }}
              >
                Nenhum plantão seu neste dia
              </Text>
            </View>
          ) : (
            <View className="gap-3 pb-8">
              {myShifts.map((shift: any) => (
                <View
                  key={shift.id}
                  className="rounded-2xl border p-4"
                  style={{
                    borderColor: theme.colors.border,
                    backgroundColor: theme.colors.surface,
                  }}
                >
                  <View className="mb-2 flex-row items-center justify-between">
                    <Text
                      className="text-base font-semibold"
                      style={{ color: theme.colors.textPrimary }}
                    >
                      {shift.label}
                    </Text>
                    <View
                      className="rounded-full px-3 py-1"
                      style={{ backgroundColor: theme.colors.surfaceAlt }}
                    >
                      <Text
                        style={{
                          color: theme.palette.neutral[700],
                          fontSize: 11,
                        }}
                      >
                        {shift.status}
                      </Text>
                    </View>
                  </View>
                  <Text
                    style={{ color: theme.colors.textSecondary, fontSize: 13 }}
                  >
                    {formatDate(shift.startAt)} - {formatDate(shift.endAt)}
                  </Text>

                  <View className="mt-4 flex-row gap-2">
                    <TouchableOpacity
                      onPress={() =>
                        router.push({
                          pathname: "/request-swap",
                          params: {
                            type: "SWAP",
                            fromShiftId: String(shift.id),
                          },
                        })
                      }
                      style={{
                        flex: 1,
                        alignItems: "center",
                        borderRadius: theme.radius.md,
                        backgroundColor: theme.colors.primary,
                        paddingVertical: theme.space[3],
                      }}
                    >
                      <Text
                        style={{
                          color: theme.colors.surface,
                          fontWeight: "700",
                        }}
                      >
                        Pedir Troca
                      </Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      onPress={() =>
                        router.push({
                          pathname: "/request-swap",
                          params: {
                            type: "TRANSFER",
                            fromShiftId: String(shift.id),
                          },
                        })
                      }
                      style={{
                        flex: 1,
                        alignItems: "center",
                        borderRadius: theme.radius.md,
                        backgroundColor: theme.colors.warningSoft,
                        borderWidth: 1,
                        borderColor: theme.colors.warning,
                        paddingVertical: theme.space[3],
                      }}
                    >
                      <Text
                        style={{
                          color: theme.colors.textPrimary,
                          fontWeight: "700",
                        }}
                      >
                        Repassar
                      </Text>
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
    <ScreenGradient variant="light" scrollable>
      <ScreenContainer>
        {/* Header */}
        <View style={{ marginBottom: theme.space[6] }}>
          <Text
            style={{
              ...theme.text.titleLg,
              color: theme.colors.textPrimary,
              fontWeight: theme.weight.bold,
            }}
          >
            Solicitações
          </Text>
          <Text
            style={{
              ...theme.text.bodyLg,
              color: theme.colors.textSecondary,
              marginTop: theme.space[1],
            }}
          >
            {pendingAssignments?.length || 0} alocações aguardando aprovação
          </Text>
        </View>

        {renderAvailableSwapsSection()}

        {/* Filtros */}
        <View
          style={{
            marginBottom: theme.space[4],
            borderRadius: theme.radius.lg,
            borderWidth: 1,
            borderColor: theme.colors.border,
            backgroundColor: theme.colors.surface,
            padding: theme.space[4],
          }}
        >
          <ShiftFilters
            hospitals={hospitals}
            sectors={sectors}
            allowAllHospitals={allowAllHospitals}
            initialValues={defaults}
            onChange={handleFiltersChange}
            counts={counts}
          />
        </View>

        {/* Filtro por modalidade — passa direto pro listPending (PR #68) */}
        <View style={{ marginBottom: theme.space[6] }}>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ gap: theme.space[2] }}
          >
            {(
              [
                { value: undefined, label: "Todos" },
                { value: "PLANTAO" as const, label: "Plantão" },
                { value: "SOBREAVISO" as const, label: "Sobreaviso" },
              ] as const
            ).map((opt) => {
              const selected = modalityFilter === opt.value;
              return (
                <TouchableOpacity
                  key={String(opt.value ?? "TODOS")}
                  onPress={() => setModalityFilter(opt.value)}
                  activeOpacity={0.7}
                  accessibilityRole="button"
                  accessibilityLabel={`Filtrar por ${opt.label}`}
                  className="rounded-full px-4 py-2"
                  style={{
                    backgroundColor: selected
                      ? theme.colors.primary
                      : theme.colors.surfaceAlt,
                    borderWidth: 1,
                    borderColor: selected
                      ? theme.colors.primary
                      : theme.colors.border,
                  }}
                >
                  <Text
                    className="text-sm font-semibold"
                    style={{
                      color: selected
                        ? theme.colors.surface
                        : theme.colors.textPrimary,
                    }}
                  >
                    {opt.label}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </ScrollView>
        </View>

        {/* Lista de pendências */}
        {pendingAssignments && pendingAssignments.length > 0 ? (
          <View style={{ gap: theme.space[4], paddingBottom: theme.space[6] }}>
            {pendingAssignments.map((pending) => {
              // Cast defensivo enquanto o tipo do tRPC nem sempre infere os
              // 4 campos que listPending começou a expor em PR #68.
              const p = pending as typeof pending & {
                modality?: "PLANTAO" | "SOBREAVISO" | null;
                coverageType?: "URGENCIA_EMERGENCIA" | "ELETIVAS" | null;
              };
              const modalityBadge =
                p.modality === "SOBREAVISO"
                  ? "Sobreaviso"
                  : p.modality === "PLANTAO"
                    ? p.coverageType === "URGENCIA_EMERGENCIA"
                      ? "Plantão · Urgência"
                      : p.coverageType === "ELETIVAS"
                        ? "Plantão · Eletivas"
                        : "Plantão"
                    : null;
              return (
                <View
                  key={pending.assignmentId}
                  style={{
                    backgroundColor: theme.colors.surface,
                    borderColor: theme.colors.border,
                    borderWidth: 1,
                    borderRadius: theme.radius.lg,
                    padding: theme.space[4],
                  }}
                >
                  {/* Cabeçalho do card */}
                  <View className="flex-row items-center justify-between mb-3">
                    <View className="flex-row items-center gap-2">
                      <User size={20} color={theme.colors.primary} />
                      <Text
                        className="text-lg font-semibold"
                        style={{ color: theme.colors.textPrimary }}
                      >
                        {pending.professionalName}
                      </Text>
                    </View>
                    {/* Role badge — spec §6.5 prescreve neutral para metadata
                      tipo papel/função. Substitui o legado amber/20 + texto
                      amarelo claro que lia mal sobre fundo claro. */}
                    <View
                      className="rounded-full px-3 py-1"
                      style={{ backgroundColor: theme.colors.surfaceAlt }}
                    >
                      <Text
                        className="text-xs font-semibold"
                        style={{ color: theme.colors.textSecondary }}
                      >
                        {pending.professionalRole}
                      </Text>
                    </View>
                  </View>

                  {/* Badge de modalidade (PR #68 — listPending agora expõe) */}
                  {modalityBadge ? (
                    <View
                      className="self-start rounded-full px-2.5 py-1 mb-3"
                      style={{ backgroundColor: theme.colors.primarySoft }}
                    >
                      <Text
                        className="text-xs font-semibold"
                        style={{ color: theme.colors.primary }}
                      >
                        {modalityBadge}
                      </Text>
                    </View>
                  ) : null}

                  {/* Informações do turno */}
                  <View className="gap-2 mb-4">
                    <View className="flex-row items-center gap-2">
                      <MapPin size={16} color={theme.colors.textSecondary} />
                      <Text
                        className="text-sm"
                        style={{ color: theme.colors.textSecondary }}
                      >
                        {pending.sectorName}
                      </Text>
                    </View>
                    <View className="flex-row items-center gap-2">
                      <Clock size={16} color={theme.colors.textSecondary} />
                      <Text
                        className="text-sm"
                        style={{ color: theme.colors.textSecondary }}
                      >
                        {formatDate(pending.shiftStartAt)} -{" "}
                        {formatDate(pending.shiftEndAt)}
                      </Text>
                    </View>
                    <View className="flex-row items-center gap-2">
                      <Briefcase size={16} color={theme.colors.textSecondary} />
                      <Text
                        className="text-sm"
                        style={{ color: theme.colors.textSecondary }}
                      >
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
                    <View
                      className="flex-row items-center justify-center gap-2 rounded-xl border py-3 px-4"
                      style={{
                        backgroundColor: theme.colors.background,
                        borderColor: theme.colors.border,
                      }}
                    >
                      <Lock size={18} color={theme.colors.textMuted} />
                      <Text
                        className="text-sm font-medium"
                        style={{ color: theme.colors.textSecondary }}
                      >
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
                        disabled={
                          approveAssignment.isPending ||
                          rejectAssignment.isPending
                        }
                        activeOpacity={0.8}
                        style={{
                          flex: 1,
                          flexDirection: "row",
                          alignItems: "center",
                          justifyContent: "center",
                          gap: theme.space[2],
                          borderRadius: theme.radius.md,
                          backgroundColor: theme.colors.success,
                          paddingVertical: theme.space[3],
                          opacity:
                            approveAssignment.isPending ||
                            rejectAssignment.isPending
                              ? 0.6
                              : 1,
                        }}
                      >
                        <Check size={20} color={theme.colors.surface} />
                        <Text
                          className="text-base font-semibold"
                          style={{ color: theme.colors.surface }}
                        >
                          Aprovar
                        </Text>
                      </TouchableOpacity>

                      <TouchableOpacity
                        onPress={() =>
                          handleReject(
                            pending.assignmentId,
                            pending.professionalName,
                          )
                        }
                        disabled={
                          approveAssignment.isPending ||
                          rejectAssignment.isPending
                        }
                        activeOpacity={0.8}
                        style={{
                          flex: 1,
                          flexDirection: "row",
                          alignItems: "center",
                          justifyContent: "center",
                          gap: theme.space[2],
                          borderRadius: theme.radius.md,
                          backgroundColor: theme.colors.danger,
                          paddingVertical: theme.space[3],
                          opacity:
                            approveAssignment.isPending ||
                            rejectAssignment.isPending
                              ? 0.6
                              : 1,
                        }}
                      >
                        <X size={20} color={theme.colors.surface} />
                        <Text
                          className="text-base font-semibold"
                          style={{ color: theme.colors.surface }}
                        >
                          Rejeitar
                        </Text>
                      </TouchableOpacity>
                    </View>
                  )}
                </View>
              );
            })}
          </View>
        ) : (
          <View
            style={{
              alignItems: "center",
              justifyContent: "center",
              paddingVertical: theme.space[20],
            }}
          >
            <ClipboardCheck size={64} color={theme.colors.borderStrong} />
            <Text
              style={{
                ...theme.text.title,
                fontWeight: theme.weight.semibold,
                color: theme.colors.textPrimary,
                marginTop: theme.space[4],
              }}
            >
              Nenhuma solicitação no momento
            </Text>
            <Text
              style={{
                ...theme.text.body,
                color: theme.colors.textMuted,
                marginTop: theme.space[2],
                textAlign: "center",
                paddingHorizontal: theme.space[6],
              }}
            >
              As solicitações de plantão aparecem aqui quando profissionais
              pedem para assumir vagas.
            </Text>
          </View>
        )}
      </ScreenContainer>
    </ScreenGradient>
  );
}

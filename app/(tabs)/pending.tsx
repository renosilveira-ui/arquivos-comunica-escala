import { View, Text, TouchableOpacity, ActivityIndicator, Platform, Alert, ScrollView } from "react-native";
import { ScreenGradient } from "@/components/ui/ScreenGradient";
import { ShiftFilters, type ShiftFilterValues } from "@/components/shift-filters";
import { trpc } from "@/lib/trpc";
import { useState, useCallback } from "react";
import { Check, X, Clock, MapPin, User, Briefcase, ClipboardCheck, Lock } from "lucide-react-native";
import { useAuth } from "@/hooks/use-auth";
import { useFilterDefaults } from "@/hooks/use-filter-defaults";
import { useTestUserId } from "@/hooks/use-test-user-id";
import { TestUserBadge } from "@/components/test-user-badge";
import { DiagnosticBadge } from "@/components/diagnostic-badge";

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
  const testUserId = useTestUserId(); // 🧪 Adicionar para detectar modo de teste

  // ✅ Mostrar diagnóstico SEMPRE (inclusive quando não autenticado)
  const Diagnostics = () => (
    <View style={{ marginBottom: 12 }}>
      <DiagnosticBadge />
      <TestUserBadge />
    </View>
  );
  
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
  const allowAllHospitals = professional?.role === "GESTOR_PLUS";
  
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
    console.log(">>> CLIQUE DETECTADO NO BOTÃO APROVAR <<<");
    console.log("assignmentId:", assignmentId);
    console.log("professional (gestor):", professional);

    if (!professional?.id) {
      console.error("ERRO: professional.id ausente!");
      uiAlert("Erro Interno", "ID do gestor não encontrado para aprovação.");
      return;
    }

    // ✅ Confirmar de um jeito que funciona no web
    let confirmed = true;
    if (Platform.OS === "web") {
      confirmed = window.confirm(`Aprovar alocação de ${professionalName}?`);
    }

    if (!confirmed) {
      console.log("Aprovação cancelada pelo usuário");
      return;
    }

    console.log(">>> CHAMANDO MUTATION approveAssignment <<<", {
      assignmentId,
      professionalId: professional.id,
    });

    approveAssignment.mutate(
      { assignmentId, professionalId: professional.id },
      {
        onSuccess: () => {
          console.log("✅ approveAssignment onSuccess");
          refetch();
          uiAlert("Sucesso", "Alocação aprovada!");
        },
        onError: (err: any) => {
          console.error("❌ approveAssignment onError:", err);
          uiAlert("Erro", err?.message ?? "Falha ao aprovar");
        },
      }
    );
  };

  const handleReject = (assignmentId: number, professionalName: string) => {
    console.log(">>> CLIQUE DETECTADO NO BOTÃO REJEITAR <<<");
    console.log("assignmentId:", assignmentId);
    console.log("professional (gestor):", professional);

    if (!professional?.id) {
      console.error("ERRO: professional.id ausente!");
      uiAlert("Erro Interno", "ID do gestor não encontrado para rejeição.");
      return;
    }

    // ✅ Confirmar de um jeito que funciona no web
    let confirmed = true;
    if (Platform.OS === "web") {
      confirmed = window.confirm(`Rejeitar alocação de ${professionalName}?`);
    }

    if (!confirmed) {
      console.log("Rejeição cancelada pelo usuário");
      return;
    }

    console.log(">>> CHAMANDO MUTATION rejectAssignment <<<", {
      assignmentId,
      professionalId: professional.id,
    });

    rejectAssignment.mutate(
      { assignmentId, professionalId: professional.id, reason: "Rejeitado pelo gestor" },
      {
        onSuccess: () => {
          console.log("✅ rejectAssignment onSuccess");
          refetch();
          uiAlert("Sucesso", "Alocação rejeitada!");
        },
        onError: (err: any) => {
          console.error("❌ rejectAssignment onError:", err);
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

  // ✅ Se estiver carregando auth OU se tiver um testUserId mas o user ainda for null (transição)
  if (authLoading || (testUserId && !user)) {
    return (
      <ScreenGradient>
        <Diagnostics />
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator size="large" color="#4DA3FF" />
          <Text className="mt-4 text-base text-white/60">Carregando autenticação...</Text>
        </View>
      </ScreenGradient>
    );
  }

  // Só bloqueia se não for modo de teste E não tiver usuário
  if (!user && !testUserId) {
    return (
      <ScreenGradient>
        <Diagnostics />
        <View className="flex-1 items-center justify-center">
          <ClipboardCheck size={64} color="#94A3B8" />
          <Text className="text-xl font-semibold text-white mt-4">Autenticação Necessária</Text>
          <Text className="text-white/60 text-center mt-2">Faça login para visualizar pendências</Text>
        </View>
      </ScreenGradient>
    );
  }

  // Verificar se profissional foi encontrado
  if (!professionalLoading && user && !professional) {
    return (
      <ScreenGradient>
        <Diagnostics />
        <View className="flex-1 items-center justify-center">
          <ClipboardCheck size={64} color="#94A3B8" />
          <Text className="text-xl font-semibold text-white mt-4">Profissional Não Encontrado</Text>
          <Text className="text-white/60 text-center mt-2">Seu usuário não está associado a um profissional</Text>
        </View>
      </ScreenGradient>
    );
  }

  if (isLoading || authLoading || professionalLoading) {
    return (
      <ScreenGradient>
        <Diagnostics />
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator size="large" color="#4DA3FF" />
          <Text className="mt-4 text-base text-white/60">Carregando pendências...</Text>
        </View>
      </ScreenGradient>
    );
  }

  return (
    <ScreenGradient>
      <ScrollView className="flex-1 px-5 py-4">
        {/* Header */}
        <View className="mb-6">
          <Diagnostics />
          <Text className="text-3xl font-bold text-white mt-3">Pendências</Text>
          <Text className="mt-1 text-base text-white/60">
            {pendingAssignments?.length || 0} alocações aguardando aprovação
          </Text>
        </View>

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
                    <Text className="text-lg font-semibold text-white">
                      {pending.professionalName}
                    </Text>
                  </View>
                  <View className="rounded-full bg-amber-500/20 px-3 py-1">
                    <Text className="text-xs font-semibold text-amber-400">
                      {pending.professionalRole}
                    </Text>
                  </View>
                </View>

                {/* Informações do turno */}
                <View className="gap-2 mb-4">
                  <View className="flex-row items-center gap-2">
                    <MapPin size={16} color="rgba(255,255,255,0.6)" />
                    <Text className="text-sm text-white/60">{pending.sectorName}</Text>
                  </View>
                  <View className="flex-row items-center gap-2">
                    <Clock size={16} color="rgba(255,255,255,0.6)" />
                    <Text className="text-sm text-white/60">
                      {formatDate(pending.shiftStartAt)} - {formatDate(pending.shiftEndAt)}
                    </Text>
                  </View>
                  <View className="flex-row items-center gap-2">
                    <Briefcase size={16} color="rgba(255,255,255,0.6)" />
                    <Text className="text-sm text-white/60">
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
                    <Text className="text-sm font-medium text-white/60">
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
                      <Text className="text-base font-semibold text-white">Aprovar</Text>
                    </TouchableOpacity>

                    <TouchableOpacity
                      onPress={() => handleReject(pending.assignmentId, pending.professionalName)}
                      disabled={approveAssignment.isPending || rejectAssignment.isPending}
                      className="flex-1 flex-row items-center justify-center gap-2 rounded-xl bg-red-500 py-3 active:opacity-80"
                    >
                      <X size={20} color="white" />
                      <Text className="text-base font-semibold text-white">Rejeitar</Text>
                    </TouchableOpacity>
                  </View>
                )}
              </View>
            ))}
          </View>
        ) : (
          <View className="flex-1 items-center justify-center py-20">
            <ClipboardCheck size={64} color="rgba(255,255,255,0.2)" />
            <Text className="mt-4 text-lg font-semibold text-white/60">
              Nenhuma pendência no momento
            </Text>
            <Text className="mt-1 text-sm text-white/40">
              Todas as alocações foram processadas
            </Text>
          </View>
        )}
      </ScrollView>
    </ScreenGradient>
  );
}

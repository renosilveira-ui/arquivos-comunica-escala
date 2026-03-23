import { View, Text, ActivityIndicator, Platform, ScrollView } from "react-native";
import { ScreenGradient } from "@/components/ui/ScreenGradient";
import { ShiftFilters, type ShiftFilterValues } from "@/components/shift-filters";
import { trpc } from "@/lib/trpc";
import { useState, useCallback } from "react";
import { Briefcase, Clock, MapPin, Building2, Calendar, CheckCircle } from "lucide-react-native";
import { useAuth } from "@/hooks/use-auth";
import { useFilterDefaults } from "@/hooks/use-filter-defaults";
import { AppButton } from "@/components/ui/AppButton";
import { confirmAction } from "@/lib/ui/confirm";

export default function VacanciesScreen() {
  const { user, isLoading: authLoading } = useAuth();
  const isAdminOrManager = user?.role === 'admin' || user?.role === 'manager';
  
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

  // Buscar vagas disponíveis do backend com filtros
  const { data: vacanciesData, isLoading: vacanciesLoading, refetch: refetchVacancies } = trpc.shiftInstances.listVacancies.useQuery(
    {
      hospitalId: filters.hospitalId ?? undefined,
      sectorId: filters.sectorId ?? undefined,
      date: filters.date.toISOString().split("T")[0], // YYYY-MM-DD
      shiftLabel: filters.shiftLabel ?? undefined,
    },
    { enabled: !!user?.id }
  );

  const vacancies = (vacanciesData || []).map((v) => ({
    id: v.shiftInstanceId,
    date: new Date(v.startAt),
    startTime: new Date(v.startAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }),
    endTime: new Date(v.endAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }),
    shift: v.label,
    sector: v.sectorName,
    hospital: v.hospitalName,
    status: v.status as "VAGO" | "PENDENTE",
    canAssume: v.canAssume,
  }));

  const [assumedVacancies, setAssumedVacancies] = useState<Set<number>>(new Set());

  // Mutation para assumir vaga
  const assumeVacancyMutation = trpc.shiftAssignments.assumeVacancy.useMutation({
    onSuccess: () => {
      // Refetch vagas para atualizar lista
      refetchVacancies();
      if (Platform.OS === "web") {
        window.alert("Vaga assumida com sucesso!\n\nStatus: PENDENTE (aguardando aprovação do gestor)");
      }
    },
    onError: (error) => {
      if (Platform.OS === "web") {
        window.alert(`Erro ao assumir vaga: ${error.message}`);
      }
    },
  });

  const handleAssumeVacancy = async (vacancyId: number, vacancyDetails: string) => {
    console.log("[Vacancies] handleAssumeVacancy called", { vacancyId, vacancyDetails });
    
    if (!professional?.id) {
      if (Platform.OS === "web") {
        window.alert("Erro: Profissional não encontrado");
      }
      return;
    }

    // Confirmar ação usando helper cross-platform
    const confirmed = await confirmAction(`Assumir vaga: ${vacancyDetails}?\n\nAguardará aprovação do gestor.`);
    console.log("[Vacancies] confirmAction result:", confirmed);

    if (!confirmed) {
      console.log("[Vacancies] User cancelled");
      return;
    }

    console.log("[Vacancies] Calling assumeVacancyMutation.mutate");
    // Chamar mutation assumeVacancy
    assumeVacancyMutation.mutate({
      shiftInstanceId: vacancyId,
      assignmentType: "ON_DUTY",
    });
  };

  const handleFiltersChange = useCallback((newFilters: ShiftFilterValues) => {
    setFilters(newFilters);
  }, []);

  const formatDate = (date: Date) => {
    return new Date(date).toLocaleDateString("pt-BR", {
      day: "2-digit",
      month: "short",
      year: "numeric",
    });
  };

  if (authLoading || professionalLoading) {
    return (
      <ScreenGradient>
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator size="large" color="#4DA3FF" />
          <Text className="mt-4 text-base" style={{ color: "rgba(255,255,255,0.6)" }}>Carregando...</Text>
        </View>
      </ScreenGradient>
    );
  }

  if (!user) {
    return (
      <ScreenGradient>
        <View className="flex-1 items-center justify-center">
          <Briefcase size={64} color="#94A3B8" />
          <Text className="text-xl font-semibold mt-4" style={{ color: "#FFFFFF" }}>Autenticação Necessária</Text>
          <Text className="text-center mt-2" style={{ color: "rgba(255,255,255,0.6)" }}>Faça login para visualizar vagas</Text>
        </View>
      </ScreenGradient>
    );
  }

  if (!professional) {
    return (
      <ScreenGradient>
        <View className="flex-1 items-center justify-center">
          <Briefcase size={64} color="#94A3B8" />
          <Text className="text-xl font-semibold mt-4" style={{ color: "#FFFFFF" }}>Profissional Não Encontrado</Text>
          <Text className="text-center mt-2" style={{ color: "rgba(255,255,255,0.6)" }}>Seu usuário não está associado a um profissional</Text>
        </View>
      </ScreenGradient>
    );
  }

  return (
    <ScreenGradient>
      <ScrollView className="flex-1 px-5 py-4">
        {/* Header */}
        <View className="mb-6">
          <Text className="text-3xl font-bold" style={{ color: "#FFFFFF" }}>Vagas Disponíveis</Text>
          <Text className="mt-1 text-base" style={{ color: "rgba(255,255,255,0.6)" }}>
            {vacancies.length} turnos disponíveis para assumir
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

        {/* Loading state para vagas */}
        {vacanciesLoading && (
          <View className="flex-1 items-center justify-center py-20">
            <ActivityIndicator size="large" color="#4DA3FF" />
            <Text className="mt-4 text-base" style={{ color: "rgba(255,255,255,0.6)" }}>Carregando vagas...</Text>
          </View>
        )}

        {/* Lista de vagas */}
        {!vacanciesLoading && vacancies.length > 0 ? (
          <View className="gap-4 pb-6">
            {vacancies.map((vacancy) => {
              const isAssumed = assumedVacancies.has(vacancy.id);
              return (
                <View
                  key={vacancy.id}
                  className="rounded-2xl bg-white/5 border border-white/10 p-4"
                >
                  {/* Cabeçalho do card */}
                  <View className="flex-row items-center justify-between mb-3">
                    <View className="flex-row items-center gap-2">
                      <Briefcase size={20} color="#4DA3FF" />
                      <Text className="text-lg font-semibold" style={{ color: "#FFFFFF" }}>
                        {vacancy.shift}
                      </Text>
                    </View>
                    <View className={`rounded-full px-3 py-1 ${isAssumed ? "bg-amber-500/20" : "bg-green-500/20"}`}>
                      <Text className="text-xs font-semibold" style={{ color: isAssumed ? '#FBBF24' : '#4ADE80' }}>
                        {isAssumed ? "PENDENTE" : "VAGO"}
                      </Text>
                    </View>
                  </View>

                  {/* Informações do turno */}
                  <View className="gap-2 mb-4">
                    <View className="flex-row items-center gap-2">
                      <Calendar size={16} color="rgba(255,255,255,0.6)" />
                      <Text className="text-sm" style={{ color: "rgba(255,255,255,0.6)" }}>{formatDate(vacancy.date)}</Text>
                    </View>
                    <View className="flex-row items-center gap-2">
                      <Clock size={16} color="rgba(255,255,255,0.6)" />
                      <Text className="text-sm" style={{ color: "rgba(255,255,255,0.6)" }}>
                        {vacancy.startTime} - {vacancy.endTime}
                      </Text>
                    </View>
                    <View className="flex-row items-center gap-2">
                      <MapPin size={16} color="rgba(255,255,255,0.6)" />
                      <Text className="text-sm" style={{ color: "rgba(255,255,255,0.6)" }}>{vacancy.sector}</Text>
                    </View>
                    <View className="flex-row items-center gap-2">
                      <Building2 size={16} color="rgba(255,255,255,0.6)" />
                      <Text className="text-sm" style={{ color: "rgba(255,255,255,0.6)" }}>{vacancy.hospital}</Text>
                    </View>
                  </View>

                  {/* Botão de ação */}
                  {isAdminOrManager ? null : isAssumed ? (
                    <View className="flex-row items-center justify-center gap-2 rounded-xl bg-white/5 border border-white/10 py-3 px-4">
                      <CheckCircle size={18} color="rgba(251, 191, 36, 0.8)" />
                      <Text className="text-sm font-medium" style={{ color: '#FBBF24' }}>
                        Aguardando aprovação do gestor
                      </Text>
                    </View>
                  ) : (
                    <AppButton
                      title="Assumir Vaga"
                      variant="primary"
                      onPress={() =>
                        handleAssumeVacancy(
                          vacancy.id,
                          `${vacancy.shift} - ${vacancy.sector} (${formatDate(vacancy.date)})`
                        )
                      }
                    />
                  )}
                </View>
              );
            })}
          </View>
        ) : !vacanciesLoading ? (
          <View className="flex-1 items-center justify-center py-20">
            <Briefcase size={64} color="rgba(255,255,255,0.2)" />
            <Text className="mt-4 text-lg font-semibold" style={{ color: "rgba(255,255,255,0.6)" }}>
              Nenhuma vaga disponível
            </Text>
            <Text className="mt-1 text-sm" style={{ color: "rgba(255,255,255,0.4)" }}>
              Todas as vagas foram preenchidas
            </Text>
          </View>
        ) : null}
      </ScrollView>
    </ScreenGradient>
  );
}

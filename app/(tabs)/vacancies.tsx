import { View, Text, ActivityIndicator, Platform, ScrollView, TouchableOpacity } from "react-native";
import { ScreenGradient } from "@/components/ui/ScreenGradient";
import { ShiftFilters, type ShiftFilterValues } from "@/components/shift-filters";
import { trpc } from "@/lib/trpc";
import { useState, useCallback } from "react";
import { Briefcase, Clock, MapPin, Building2, Calendar, CheckCircle } from "lucide-react-native";
import { useAuth } from "@/hooks/use-auth";
import { useFilterDefaults } from "@/hooks/use-filter-defaults";
import { AppButton } from "@/components/ui/AppButton";
import { confirmAction } from "@/lib/ui/confirm";
import { ScreenContainer } from "@/components/ui/ScreenContainer";
import { theme } from "@/lib/theme";

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

  // Filtro adicional por modalidade (PR #66 — listVacancies aceita modality)
  const [modalityFilter, setModalityFilter] = useState<"PLANTAO" | "SOBREAVISO" | undefined>(undefined);

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

  // Buscar vagas disponíveis do backend com filtros
  // `modality` é aceito por listVacancies a partir de PR #66.
  const { data: vacanciesData, isLoading: vacanciesLoading, refetch: refetchVacancies } = trpc.shiftInstances.listVacancies.useQuery(
    {
      hospitalId: filters.hospitalId ?? undefined,
      sectorId: filters.sectorId ?? undefined,
      date: filters.date.toISOString().split("T")[0], // YYYY-MM-DD
      shiftLabel: filters.shiftLabel ?? undefined,
      modality: modalityFilter,
    },
    { enabled: !!user?.id }
  );

  const vacancies = (vacanciesData || []).map((v) => {
    // PR #66 expõe modality / coverageType / paymentModel / productivityCapBrl,
    // mas o tipo do tRPC pode ainda não estar inferindo no worktree do agente.
    // Cast defensivo (mesma estratégia usada em PR #65/#67).
    const item = v as typeof v & {
      modality?: "PLANTAO" | "SOBREAVISO" | null;
      coverageType?: "URGENCIA_EMERGENCIA" | "ELETIVAS" | null;
      paymentModel?: string | null;
      productivityCapBrl?: string | null;
    };
    return {
      id: v.shiftInstanceId,
      date: new Date(v.startAt),
      startTime: new Date(v.startAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }),
      endTime: new Date(v.endAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }),
      shift: v.label,
      sector: v.sectorName,
      hospital: v.hospitalName,
      status: v.status as "VAGO" | "PENDENTE",
      canAssume: v.canAssume,
      modality: item.modality ?? null,
      coverageType: item.coverageType ?? null,
      paymentModel: item.paymentModel ?? null,
      productivityCapBrl: item.productivityCapBrl ?? null,
    };
  });

  // Mapeia (modality, coverageType) → label PT-BR para o badge no card.
  // Retorna null para vagas legadas (modality null/undefined) — pulamos o badge.
  const formatModalityBadge = (
    modality: "PLANTAO" | "SOBREAVISO" | null,
    coverageType: "URGENCIA_EMERGENCIA" | "ELETIVAS" | null,
  ): string | null => {
    if (!modality) return null;
    if (modality === "SOBREAVISO") return "Sobreaviso";
    if (modality === "PLANTAO") {
      if (coverageType === "URGENCIA_EMERGENCIA") return "Plantão · Urgência";
      if (coverageType === "ELETIVAS") return "Plantão · Eletivas";
      return "Plantão";
    }
    return null;
  };

  const [assumedVacancies, setAssumedVacancies] = useState<Set<number>>(new Set());

  // Mutation para assumir vaga
  const assumeVacancyMutation = trpc.shiftAssignments.assumeVacancy.useMutation({
    onSuccess: () => {
      // Refetch vagas para atualizar lista
      refetchVacancies();
      if (Platform.OS === "web") {
        window.alert("Plantão assumido com sucesso!\n\nStatus: PENDENTE (aguardando aprovação do gestor)");
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
      <ScreenGradient variant="light">
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator size="large" color={theme.colors.primary} />
          <Text className="mt-4 text-base" style={{ color: theme.colors.textSecondary }}>Carregando...</Text>
        </View>
      </ScreenGradient>
    );
  }

  if (!user) {
    return (
      <ScreenGradient variant="light">
        <View className="flex-1 items-center justify-center">
          <Briefcase size={64} color={theme.colors.textDisabled} />
          <Text className="text-xl font-semibold mt-4" style={{ color: theme.colors.textPrimary }}>Autenticação Necessária</Text>
          <Text className="text-center mt-2" style={{ color: theme.colors.textSecondary }}>Faça login para visualizar vagas</Text>
        </View>
      </ScreenGradient>
    );
  }

  if (!professional) {
    return (
      <ScreenGradient variant="light">
        <View className="flex-1 items-center justify-center">
          <Briefcase size={64} color={theme.colors.textDisabled} />
          <Text className="text-xl font-semibold mt-4" style={{ color: theme.colors.textPrimary }}>Profissional Não Encontrado</Text>
          <Text className="text-center mt-2" style={{ color: theme.colors.textSecondary }}>Seu usuário não está associado a um profissional</Text>
        </View>
      </ScreenGradient>
    );
  }

  return (
    <ScreenGradient variant="light">
      <ScrollView className="flex-1 px-5 py-4">
        <ScreenContainer>
        {/* Header */}
        <View className="mb-6">
          <Text className="text-3xl font-bold" style={{ color: theme.colors.textPrimary }}>Plantões em aberto</Text>
          <Text className="mt-1 text-base" style={{ color: theme.colors.textSecondary }}>
            {vacancies.length} plantões aguardando profissional
          </Text>
        </View>

        {/* Filtros */}
        <View className="mb-6 rounded-2xl border bg-white p-4" style={{ borderColor: theme.colors.border }}>
          <ShiftFilters
            hospitals={hospitals}
            sectors={sectors}
            allowAllHospitals={allowAllHospitals}
            initialValues={defaults}
            onChange={handleFiltersChange}
            counts={counts}
          />
        </View>

        {/* Filtro por modalidade (chips) — PR #66 */}
        <View className="mb-6">
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ gap: 8, paddingRight: 8 }}
          >
            {([
              { label: "Todos", value: undefined },
              { label: "Plantão", value: "PLANTAO" as const },
              { label: "Sobreaviso", value: "SOBREAVISO" as const },
            ]).map((opt) => {
              const selected = modalityFilter === opt.value;
              return (
                <TouchableOpacity
                  key={opt.label}
                  onPress={() => setModalityFilter(opt.value)}
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  accessibilityLabel={`Filtrar por ${opt.label}`}
                  style={{
                    paddingHorizontal: 14,
                    paddingVertical: 8,
                    borderRadius: 999,
                    backgroundColor: selected ? theme.colors.primary : theme.colors.surfaceAlt,
                    borderWidth: 1,
                    borderColor: selected ? theme.colors.primary : theme.colors.border,
                  }}
                >
                  <Text
                    style={{
                      color: selected ? theme.colors.surface : theme.colors.textPrimary,
                      fontSize: 14,
                      fontWeight: "600",
                    }}
                  >
                    {opt.label}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </ScrollView>
        </View>

        {/* Loading state para vagas */}
        {vacanciesLoading && (
          <View className="flex-1 items-center justify-center py-20">
            <ActivityIndicator size="large" color={theme.colors.primary} />
            <Text className="mt-4 text-base" style={{ color: theme.colors.textSecondary }}>Carregando vagas...</Text>
          </View>
        )}

        {/* Lista de vagas */}
        {!vacanciesLoading && vacancies.length > 0 ? (
          <View className="gap-4 pb-6">
            {vacancies.map((vacancy) => {
              const isAssumed = assumedVacancies.has(vacancy.id);
              const modalityLabel = formatModalityBadge(vacancy.modality, vacancy.coverageType);
              return (
                <View
                  key={vacancy.id}
                  className="rounded-2xl border p-4"
                  style={{ backgroundColor: theme.colors.surface, borderColor: theme.colors.border }}
                >
                  {/* Cabeçalho do card */}
                  <View className="flex-row items-center justify-between mb-3">
                    <View className="flex-row items-center gap-2 flex-shrink">
                      <Briefcase size={20} color={theme.colors.primary} />
                      <Text className="text-lg font-semibold" style={{ color: theme.colors.textPrimary }}>
                        {vacancy.shift}
                      </Text>
                    </View>
                    {/* Status badge segue spec §6.5 + T3 do audit:
                        VAGO = neutral (não vermelho/verde); PENDENTE = warning. */}
                    <View
                      className="rounded-full px-3 py-1"
                      style={{
                        backgroundColor: isAssumed ? theme.colors.warningSoft : theme.colors.surfaceAlt,
                      }}
                    >
                      <Text
                        className="text-xs font-semibold"
                        style={{
                          color: isAssumed ? theme.palette.warning[700] : theme.colors.textSecondary,
                        }}
                      >
                        {isAssumed ? "PENDENTE" : "VAGO"}
                      </Text>
                    </View>
                  </View>

                  {/* Badge de modalidade (PR #66). Oculto em rows legadas sem modality. */}
                  {modalityLabel && (
                    <View className="mb-3 flex-row">
                      <View
                        style={{
                          paddingHorizontal: 10,
                          paddingVertical: 4,
                          borderRadius: 999,
                          backgroundColor: theme.colors.primarySoft,
                        }}
                      >
                        <Text
                          style={{
                            color: theme.colors.primary,
                            fontSize: 11,
                            fontWeight: "600",
                          }}
                        >
                          {modalityLabel}
                        </Text>
                      </View>
                    </View>
                  )}

                  {/* Informações do turno */}
                  <View className="gap-2 mb-4">
                    <View className="flex-row items-center gap-2">
                      <Calendar size={16} color={theme.colors.textSecondary} />
                      <Text className="text-sm" style={{ color: theme.colors.textSecondary }}>{formatDate(vacancy.date)}</Text>
                    </View>
                    <View className="flex-row items-center gap-2">
                      <Clock size={16} color={theme.colors.textSecondary} />
                      <Text className="text-sm" style={{ color: theme.colors.textSecondary }}>
                        {vacancy.startTime} - {vacancy.endTime}
                      </Text>
                    </View>
                    <View className="flex-row items-center gap-2">
                      <MapPin size={16} color={theme.colors.textSecondary} />
                      <Text className="text-sm" style={{ color: theme.colors.textSecondary }}>{vacancy.sector}</Text>
                    </View>
                    <View className="flex-row items-center gap-2">
                      <Building2 size={16} color={theme.colors.textSecondary} />
                      <Text className="text-sm" style={{ color: theme.colors.textSecondary }}>{vacancy.hospital}</Text>
                    </View>
                  </View>

                  {/* Botão de ação */}
                  {isAdminOrManager ? null : isAssumed ? (
                    <View
                      className="flex-row items-center justify-center gap-2 rounded-xl border py-3 px-4"
                      style={{
                        backgroundColor: theme.colors.warningSoft,
                        borderColor: theme.colors.warning,
                      }}
                    >
                      <CheckCircle size={18} color={theme.palette.warning[700]} />
                      <Text className="text-sm font-medium" style={{ color: theme.palette.warning[700] }}>
                        Aguardando aprovação do gestor
                      </Text>
                    </View>
                  ) : (
                    <AppButton
                      title="Assumir Plantão"
                      variant="primary"
                      size="lg"
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
            <Briefcase size={64} color={theme.colors.borderStrong} />
            <Text className="mt-4 text-lg font-semibold" style={{ color: theme.colors.textPrimary }}>
              Nenhum plantão em aberto
            </Text>
            <Text className="mt-2 text-sm text-center px-6" style={{ color: theme.colors.textMuted }}>
              Todos os plantões deste período já estão atribuídos. Tente outro hospital, setor ou data nos filtros acima.
            </Text>
          </View>
        ) : null}
        </ScreenContainer>
      </ScrollView>
    </ScreenGradient>
  );
}

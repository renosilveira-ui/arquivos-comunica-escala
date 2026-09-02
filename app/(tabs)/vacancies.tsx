import {
  ActivityIndicator,
  ScrollView,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { ScreenGradient } from "@/components/ui/ScreenGradient";
import { ShiftFilters, type ShiftFilterValues } from "@/components/shift-filters";
import { trpc } from "@/lib/trpc";
import { toLocalISODateString } from "@/lib/datetime-utils";
import { formatHospitalTime } from "@/lib/hospital-time";
import { useState, useCallback, useRef } from "react";
import { Briefcase, Clock, MapPin, Building2, Calendar } from "lucide-react-native";
import { useAuth } from "@/hooks/use-auth";
import { useFilterDefaults } from "@/hooks/use-filter-defaults";
import { AppButton } from "@/components/ui/AppButton";
import { confirmAction } from "@/lib/ui/confirm";
import { ScreenContainer } from "@/components/ui/ScreenContainer";
import { theme } from "@/lib/theme";
import { QueryErrorState } from "@/components/ui/QueryErrorState";
import { useActionFeedback } from "@/hooks/use-action-feedback";
import { ShiftStatusBadge } from "@/components/ui/ShiftStatusBadge";
import { Surface } from "@/components/ui/Surface";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { SkeletonList } from "@/components/ui/Skeleton";
import { usePermissions } from "@/hooks/use-permissions";
import { useOperationalQueryRefresh } from "@/hooks/use-operational-query-refresh";
import { useNativeOperationalQueryRecovery } from "@/hooks/use-native-operational-query-recovery";
import {
  canDisplayOperationalListCount,
  resolveOperationalListState,
  resolveVacanciesGateState,
} from "@/lib/operational-screen-state";
import { presentQueryError } from "@/lib/query-error-presentation";

const EMPTY_HOSPITALS: { id: number; name: string }[] = [];
const EMPTY_SECTORS: { id: number; hospitalId: number; name: string }[] = [];

export default function VacanciesScreen() {
  const { user, isLoading: authLoading } = useAuth();
  const {
    isGlobalAdmin,
    roleInInstitution,
    isLoading: permissionsLoading,
  } = usePermissions();
  
  // Buscar profissional associado ao usuário logado
  const {
    data: professional,
    isLoading: professionalLoading,
    isError: professionalHasError,
    error: professionalError,
    refetch: refetchProfessional,
  } =
    trpc.professionals.getByUserId.useQuery(
      { userId: user?.id ?? 0 },
      { enabled: !!user?.id },
    );

  // Buscar hospitais e setores para os filtros
  const {
    data: hospitalsData,
    isError: hospitalsHasError,
    error: hospitalsError,
    refetch: refetchHospitals,
  } = trpc.hospitals.list.useQuery(undefined, { enabled: !!user?.id });
  const {
    data: sectorsData,
    isError: sectorsHasError,
    error: sectorsError,
    refetch: refetchSectors,
  } = trpc.sectors.list.useQuery(undefined, { enabled: !!user?.id });

  const hospitals = hospitalsData ?? EMPTY_HOSPITALS;
  const sectors = sectorsData ?? EMPTY_SECTORS;

  // Defaults inteligentes baseado em manager_scope
  const {
    defaults,
    isLoading: managerScopeLoading,
    isError: managerScopeHasError,
    error: managerScopeError,
    refetch: refetchManagerScope,
  } = useFilterDefaults({ hospitals, sectors });

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
  const allowAllHospitals = isGlobalAdmin || roleInInstitution === "GESTOR_PLUS";
  const {
    captureLease,
    isLeaseCurrent,
    refreshVacancyQueries,
  } = useOperationalQueryRefresh();

  // Buscar contadores de vagas/pendências (com cache de 60s)
  const {
    data: counts,
    isError: countsHasError,
  } = trpc.filters.summaryCounts.useQuery(
    {
      date: toLocalISODateString(filters.date), // YYYY-MM-DD (dia local)
    },
    { 
      enabled: !!user?.id,
      staleTime: 60 * 1000, // Cache de 60 segundos
    }
  );

  // Buscar vagas disponíveis do backend com filtros
  // `modality` é aceito por listVacancies a partir de PR #66.
  const {
    data: vacanciesData,
    isLoading: vacanciesLoading,
    isPending: vacanciesPending,
    isError: vacanciesError,
    error: vacanciesQueryError,
    refetch: refetchVacancies,
  } = trpc.shiftInstances.listVacancies.useQuery(
    {
      hospitalId: filters.hospitalId ?? undefined,
      sectorId: filters.sectorId ?? undefined,
      date: toLocalISODateString(filters.date), // YYYY-MM-DD (dia local)
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
      startTime: formatHospitalTime(v.startAt),
      endTime: formatHospitalTime(v.endAt),
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
  const vacanciesContentState = resolveOperationalListState({
    isLoading: vacanciesLoading,
    isPending: vacanciesPending,
    isError: vacanciesError,
    hasResolvedData: vacanciesData !== undefined,
    itemCount: vacancies.length,
    error: vacanciesQueryError,
  });
  // Contadores são afirmações sobre a lista inteira. Eles só aparecem com
  // estado confirmado (READY/EMPTY) e quando a própria query está íntegra.
  const safeFilterCounts =
    !countsHasError && canDisplayOperationalListCount(vacanciesContentState)
      ? counts
      : undefined;
  const vacanciesSubtitle = canDisplayOperationalListCount(vacanciesContentState)
    ? `${vacancies.length} plantão${vacancies.length === 1 ? "" : "ões"} aguardando profissional`
    : vacanciesContentState === "LOADING"
      ? "Buscando plantões sem profissional…"
      : vacanciesContentState === "ERROR"
        ? "A quantidade de plantões ainda não pôde ser confirmada."
        : "Aguardando a confirmação dos plantões em aberto…";
  const vacanciesGateState = resolveVacanciesGateState({
    authLoading,
    permissionsLoading,
    professionalLoading,
    filtersLoading: !!user && managerScopeLoading,
    hasUser: !!user,
    hasProfessional: !!professional,
    // Cache de perfil não autoriza manter ações se o servidor acabou de
    // revogar o acesso. Para falhas transitórias não ligadas a autorização,
    // o perfil previamente confirmado pode continuar visível.
    professionalUnavailable:
      professionalHasError &&
      (!professional || presentQueryError(professionalError).kind === "ACCESS"),
    filtersUnavailable:
      managerScopeHasError ||
      (hospitalsHasError &&
        (!hospitalsData || presentQueryError(hospitalsError).kind === "ACCESS")) ||
      (sectorsHasError &&
        (!sectorsData || presentQueryError(sectorsError).kind === "ACCESS")),
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

  // Feedback igual em web e nativo (antes só o web recebia retorno).
  const feedback = useActionFeedback();
  const assumeVacancyMutation = trpc.shiftAssignments.assumeVacancy.useMutation();
  const [assumeVacancyBusy, setAssumeVacancyBusy] = useState(false);
  const assumeVacancyLockRef = useRef(false);

  const handleAssumeVacancy = async (vacancyId: number, vacancyDetails: string) => {
    if (assumeVacancyLockRef.current) return;
    console.log("[Vacancies] handleAssumeVacancy called", { vacancyId, vacancyDetails });
    
    if (!professional?.id) {
      feedback.error("Seu cadastro de profissional não foi encontrado. Fale com o gestor.");
      return;
    }

    const refreshLease = captureLease();
    if (!refreshLease) {
      feedback.error("Sua sessão ou instituição mudou. Atualize a tela antes de solicitar a vaga.");
      return;
    }

    // Confirmar ação usando helper cross-platform
    const confirmed = await confirmAction(`Assumir vaga: ${vacancyDetails}?\n\nAguardará aprovação do gestor.`);
    console.log("[Vacancies] confirmAction result:", confirmed);

    if (!confirmed) {
      console.log("[Vacancies] User cancelled");
      return;
    }

    if (assumeVacancyLockRef.current || !isLeaseCurrent(refreshLease)) {
      return;
    }

    assumeVacancyLockRef.current = true;
    setAssumeVacancyBusy(true);
    console.log("[Vacancies] Calling assumeVacancyMutation.mutate");
    try {
      await assumeVacancyMutation.mutateAsync({
        shiftInstanceId: vacancyId,
        assignmentType: "ON_DUTY",
      });
    } catch (error) {
      if (isLeaseCurrent(refreshLease)) {
        feedback.error(
          error instanceof Error
            ? error.message
            : "Não foi possível solicitar o plantão.",
        );
      }
      assumeVacancyLockRef.current = false;
      setAssumeVacancyBusy(false);
      return;
    }

    // Mantém o bloqueio até a reconciliação terminar, mas não atrasa o
    // feedback de uma solicitação já aceita pelo servidor.
    const refreshPromise = refreshVacancyQueries(refreshLease);
    if (isLeaseCurrent(refreshLease)) {
      feedback.success("Solicitação enviada — aguardando aprovação do gestor.");
    }
    try {
      await refreshPromise;
    } catch {
      // A mutação já foi aceita. A próxima renderização expõe eventual falha
      // de leitura sem transformar a confirmação do servidor em erro da ação.
    } finally {
      assumeVacancyLockRef.current = false;
      setAssumeVacancyBusy(false);
    }
  };

  const handleFiltersChange = useCallback((newFilters: ShiftFilterValues) => {
    setFilters(newFilters);
  }, []);

  useNativeOperationalQueryRecovery({
    captureLease,
    refresh: refreshVacancyQueries,
  });

  const formatDate = (date: Date) => {
    return new Date(date).toLocaleDateString("pt-BR", {
      day: "2-digit",
      month: "short",
      year: "numeric",
    });
  };

  if (vacanciesGateState === "LOADING") {
    return (
      <ScreenGradient variant="light">
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator size="large" color={theme.colors.primary} />
          <Text className="mt-4 text-base" style={{ color: theme.colors.textSecondary }}>Carregando...</Text>
        </View>
      </ScreenGradient>
    );
  }

  if (vacanciesGateState === "AUTH_REQUIRED") {
    return (
      <ScreenGradient variant="light">
        <View className="flex-1 items-center justify-center">
          <Briefcase size={64} color={theme.colors.textMuted} />
          <Text className="text-xl font-semibold mt-4" style={{ color: theme.colors.textPrimary }}>Autenticação Necessária</Text>
          <Text className="text-center mt-2" style={{ color: theme.colors.textSecondary }}>Faça login para visualizar vagas</Text>
        </View>
      </ScreenGradient>
    );
  }

  if (vacanciesGateState === "PROFESSIONAL_UNAVAILABLE") {
    return (
      <ScreenGradient variant="light">
        <QueryErrorState
          title="Não foi possível confirmar seu cadastro profissional"
          error={professionalError}
          onRetry={() => refetchProfessional()}
        />
      </ScreenGradient>
    );
  }

  if (vacanciesGateState === "MISSING_PROFESSIONAL") {
    return (
      <ScreenGradient variant="light">
        <View className="flex-1 items-center justify-center">
          <Briefcase size={64} color={theme.colors.textMuted} />
          <Text className="text-xl font-semibold mt-4" style={{ color: theme.colors.textPrimary }}>Profissional Não Encontrado</Text>
          <Text className="text-center mt-2" style={{ color: theme.colors.textSecondary }}>Seu usuário não está associado a um profissional</Text>
        </View>
      </ScreenGradient>
    );
  }

  if (vacanciesGateState === "FILTERS_UNAVAILABLE") {
    return (
      <ScreenGradient variant="light">
        <QueryErrorState
          title="Não foi possível carregar os filtros de vagas"
          error={managerScopeError ?? hospitalsError ?? sectorsError}
          onRetry={() => {
            void Promise.all([
              refetchManagerScope(),
              refetchHospitals(),
              refetchSectors(),
            ]);
          }}
        />
      </ScreenGradient>
    );
  }

  return (
    <ScreenGradient variant="light" scrollable>
        <ScreenContainer>
        <SectionHeader
          size="page"
          title="Plantões em aberto"
          subtitle={vacanciesSubtitle}
          style={{ marginBottom: theme.space[5] }}
        />

        <Surface level="card" style={{ marginBottom: theme.space[4] }}>
          <ShiftFilters
            hospitals={hospitals}
            sectors={sectors}
            allowAllHospitals={allowAllHospitals}
            initialValues={defaults}
            onChange={handleFiltersChange}
            counts={safeFilterCounts}
          />
        </Surface>

        {/* Filtro por modalidade (chips) — PR #66 */}
        <View style={{ marginBottom: theme.space[5] }}>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ gap: theme.space[2], paddingRight: theme.space[2] }}
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
                    minHeight: theme.space[10],
                    justifyContent: "center",
                    paddingHorizontal: theme.space[4],
                    paddingVertical: theme.space[2],
                    borderRadius: theme.radius.full,
                    backgroundColor: selected ? theme.colors.primary : theme.colors.surfaceAlt,
                    borderWidth: 1,
                    borderColor: selected ? theme.colors.primary : theme.colors.border,
                  }}
                >
                  <Text
                    style={{
                      ...theme.text.body,
                      color: selected ? theme.colors.onDark.text : theme.colors.textPrimary,
                      fontWeight: theme.weight.semibold,
                    }}
                  >
                    {opt.label}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </ScrollView>
        </View>

        {/* Carregando: skeleton com a forma dos cards */}
        {vacanciesContentState === "LOADING" ? <SkeletonList count={3} /> : null}

        {/* Lista de vagas */}
        {vacanciesContentState === "UNRESOLVED" ? (
          <QueryErrorState
            title="Ainda estamos aguardando a resposta sobre os plantões"
            description="A lista ainda não foi confirmada pelo sistema. Tente novamente para atualizar."
            onRetry={() => refetchVacancies()}
          />
        ) : vacanciesContentState === "READY" ? (
          <View style={{ gap: theme.space[4], paddingBottom: theme.space[6] }}>
            {vacancies.map((vacancy) => {
              const modalityLabel = formatModalityBadge(vacancy.modality, vacancy.coverageType);
              return (
                <Surface key={vacancy.id} level="card">
                  {/* Cabeçalho do card */}
                  <View className="flex-row items-center justify-between mb-3">
                    <View className="flex-row items-center gap-2 flex-shrink">
                      <Briefcase size={20} color={theme.colors.primary} />
                      <Text style={{ ...theme.text.titleSm, fontWeight: theme.weight.semibold, color: theme.colors.textPrimary }}>
                        {vacancy.shift}
                      </Text>
                    </View>
                    {/* Vaga é ação possível aqui → tom danger (lib/shift-status). */}
                    <ShiftStatusBadge status="VAGO" context="actionable" />
                  </View>

                  {/* Badge de modalidade (PR #66). Oculto em rows legadas sem modality. */}
                  {modalityLabel && (
                    <View className="mb-3 flex-row">
                      <View
                        style={{
                          paddingHorizontal: theme.space[2],
                          height: theme.space[5],
                          justifyContent: "center",
                          borderRadius: theme.radius.full,
                          backgroundColor: theme.colors.primarySoft,
                        }}
                      >
                        <Text
                          style={{
                            ...theme.text.caption,
                            color: theme.palette.primary[700],
                            fontWeight: theme.weight.semibold,
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
                  <AppButton
                    title={assumeVacancyBusy ? "Enviando…" : "Assumir plantão"}
                    variant="primary"
                    size="lg"
                    disabled={!vacancy.canAssume || assumeVacancyBusy}
                    onPress={() =>
                      handleAssumeVacancy(
                        vacancy.id,
                        `${vacancy.shift} - ${vacancy.sector} (${formatDate(vacancy.date)})`
                      )
                    }
                  />
                </Surface>
              );
            })}
          </View>
        ) : vacanciesContentState === "ERROR" ? (
          // Erro não pode afirmar "todos os plantões atribuídos".
          <QueryErrorState
            title="Não foi possível carregar os plantões em aberto"
            error={vacanciesQueryError}
            onRetry={() => refetchVacancies()}
          />
        ) : vacanciesContentState === "EMPTY" ? (
          <View style={{ alignItems: "center", justifyContent: "center", paddingVertical: theme.space[20] }}>
            <Briefcase size={64} color={theme.colors.borderStrong} />
            <Text style={{ ...theme.text.title, fontWeight: theme.weight.semibold, color: theme.colors.textPrimary, marginTop: theme.space[4] }}>
              Nenhum plantão em aberto
            </Text>
            <Text style={{ ...theme.text.body, color: theme.colors.textMuted, marginTop: theme.space[2], textAlign: "center", paddingHorizontal: theme.space[6] }}>
              Todos os plantões deste período já estão atribuídos. Tente outro hospital, setor ou data nos filtros acima.
            </Text>
          </View>
        ) : null}
        </ScreenContainer>
    </ScreenGradient>
  );
}

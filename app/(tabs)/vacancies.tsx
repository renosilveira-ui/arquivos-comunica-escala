import {
  ActivityIndicator,
  Pressable,
  Text,
  View,
} from "react-native";
import { ScreenGradient } from "@/components/ui/ScreenGradient";
import {
  ShiftFilters,
  type ShiftFilterValues,
} from "@/components/shift-filters";
import { trpc } from "@/lib/trpc";
import {
  fromLocalISODateString,
  toLocalISODateString,
} from "@/lib/datetime-utils";
import { formatHospitalTime } from "@/lib/hospital-time";
import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { useLocalSearchParams, useRouter } from "expo-router";
import {
  Briefcase,
  MapPin,
  Building2,
} from "lucide-react-native";
import { useAuth } from "@/hooks/use-auth";
import { useFilterDefaults } from "@/hooks/use-filter-defaults";
import { useTenantScopedShiftFilters } from "@/hooks/use-tenant-scoped-shift-filters";
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
import { getActiveTenantSnapshot, useTenantState } from "@/lib/tenant-state";
import {
  canDisplayOperationalListCount,
  resolveOperationalListState,
  resolveVacanciesGateState,
} from "@/lib/operational-screen-state";
import { presentQueryError } from "@/lib/query-error-presentation";
import {
  VACANCY_PUSH_ROUTE_PARAM,
  clearVacancyPushRouteParams,
  isVacancyPushIntentConsumptionFenceCurrent,
  isVacancyPushIntentPublicationCurrent,
  matchVacancyPushIntentPublicationForRoute,
  parseVacancyPushIntentId,
  resolveVacancyPushIntentRouteState,
  vacancyPushIntentNotificationFence,
} from "@/lib/vacancy-push-route";
import { deriveVacancyDashboard } from "@/lib/vacancy-dashboard";

const EMPTY_HOSPITALS: { id: number; name: string }[] = [];
const EMPTY_SECTORS: { id: number; hospitalId: number; name: string }[] = [];

export default function VacanciesScreen() {
  const router = useRouter();
  const routeParams = useLocalSearchParams<{
    vacancyIntentId?: string | string[];
  }>();
  const {
    user,
    isLoading: authLoading,
    isSessionAuthorizationCurrent,
    sessionValidation,
  } = useAuth();
  const { activeInstitutionId, tenantRevision } = useTenantState();
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
  } = trpc.professionals.getByUserId.useQuery(
    { userId: user?.id ?? 0 },
    { enabled: !!user?.id },
  );

  // Buscar hospitais e setores para os filtros
  const {
    data: hospitalsData,
    isLoading: hospitalsLoading,
    isError: hospitalsHasError,
    error: hospitalsError,
    refetch: refetchHospitals,
  } = trpc.hospitals.list.useQuery(undefined, { enabled: !!user?.id });
  const {
    data: sectorsData,
    isLoading: sectorsLoading,
    isError: sectorsHasError,
    error: sectorsError,
    refetch: refetchSectors,
  } = trpc.sectors.list.useQuery(undefined, { enabled: !!user?.id });

  const hospitals = hospitalsData ?? EMPTY_HOSPITALS;
  const sectors = sectorsData ?? EMPTY_SECTORS;
  const filtersTopologyReady =
    hospitalsData !== undefined &&
    sectorsData !== undefined &&
    !hospitalsHasError &&
    !sectorsHasError &&
    !hospitalsLoading &&
    !sectorsLoading;

  // Defaults inteligentes baseado em manager_scope
  const {
    defaults,
    defaultsReady,
    isLoading: managerScopeLoading,
    isError: managerScopeHasError,
    error: managerScopeError,
    refetch: refetchManagerScope,
  } = useFilterDefaults({
    institutionId: activeInstitutionId,
    tenantRevision,
    hospitals,
    sectors,
    topologyReady: filtersTopologyReady,
  });

  const {
    filters,
    setFilters,
    tenantKey: activeTenantKey,
  } = useTenantScopedShiftFilters({
    institutionId: activeInstitutionId,
    tenantRevision,
    defaults,
    defaultsReady,
  });
  const [vacancyIntentNotice, setVacancyIntentNotice] = useState<string | null>(
    null,
  );
  const handledVacancyIntentRef = useRef<string | null>(null);
  const consumedVacancyIntentPublicationRef = useRef<{
    userId: number;
    sessionGeneration: number;
    shiftInstanceId: number;
    generation: number;
  } | null>(null);

  const vacancyIntentShiftInstanceId = parseVacancyPushIntentId(
    routeParams[VACANCY_PUSH_ROUTE_PARAM],
  );
  const vacancyIntentUserId = user?.id ?? null;
  const vacancyIntentSessionGeneration =
    vacancyIntentUserId !== null &&
    sessionValidation.status === "VERIFIED" &&
    sessionValidation.userId === vacancyIntentUserId &&
    sessionValidation.isCurrent() &&
    Number.isSafeInteger(sessionValidation.ticket.generation) &&
    sessionValidation.ticket.generation >= 0
      ? sessionValidation.ticket.generation
      : null;
  const publishedVacancyIntent = vacancyPushIntentNotificationFence.current();
  const matchingPublishedVacancyIntent =
    matchVacancyPushIntentPublicationForRoute(
      publishedVacancyIntent,
      vacancyIntentUserId,
      vacancyIntentSessionGeneration,
      vacancyIntentShiftInstanceId,
    );
  const vacancyIntentGeneration =
    matchingPublishedVacancyIntent?.generation ?? null;
  const vacancyIntentPublicationSessionGeneration =
    matchingPublishedVacancyIntent?.sessionGeneration ?? null;
  const vacancyIntentConsumptionFenceRef = useRef({
    userId: vacancyIntentUserId,
    sessionGeneration: vacancyIntentSessionGeneration,
    tenantId: activeInstitutionId,
    tenantRevision,
    intentShiftInstanceId: vacancyIntentShiftInstanceId,
    intentGeneration: vacancyIntentGeneration,
  });
  vacancyIntentConsumptionFenceRef.current = {
    userId: vacancyIntentUserId,
    sessionGeneration: vacancyIntentSessionGeneration,
    tenantId: activeInstitutionId,
    tenantRevision,
    intentShiftInstanceId: vacancyIntentShiftInstanceId,
    intentGeneration: vacancyIntentGeneration,
  };
  const vacancyIntentResolutionTenant = {
    institutionId: activeInstitutionId,
    revision: tenantRevision,
  };
  const vacancyIntentCurrentTenant = getActiveTenantSnapshot();
  const {
    data: vacancyIntentData,
    isFetching: vacancyIntentFetching,
    isError: vacancyIntentHasError,
    error: vacancyIntentError,
    refetch: refetchVacancyIntent,
  } = trpc.shiftInstances.resolveVacancyIntent.useQuery(
    {
      // Tenant + revision make A → B → A a distinct query key. The server
      // verifies the tenant against the canonical request context.
      shiftInstanceId: vacancyIntentShiftInstanceId ?? 1,
      expectedTenantId: activeInstitutionId ?? 1,
      requestTenantRevision: tenantRevision,
    },
    {
      enabled:
        !!user?.id &&
        activeInstitutionId !== null &&
        vacancyIntentShiftInstanceId !== null,
      refetchOnMount: "always",
      staleTime: 0,
    },
  );
  const vacancyIntentRouteState = resolveVacancyPushIntentRouteState({
    intentShiftInstanceId: vacancyIntentShiftInstanceId,
    resolutionTenant: vacancyIntentResolutionTenant,
    currentTenant: vacancyIntentCurrentTenant,
    isFetching: vacancyIntentFetching,
    isError: vacancyIntentHasError,
    data: vacancyIntentData,
  });

  // Filtro adicional por modalidade (PR #66 — listVacancies aceita modality)
  const [modalityFilter, setModalityFilter] = useState<
    "PLANTAO" | "SOBREAVISO" | undefined
  >(undefined);

  // Determinar se usuário pode ver "Todos os hospitais"
  const allowAllHospitals =
    isGlobalAdmin || roleInInstitution === "GESTOR_PLUS";
  const {
    captureLease,
    isLeaseCurrent,
    refreshVisibleVacancyQueries,
    refreshVacancyMutationQueries,
  } = useOperationalQueryRefresh();

  // Buscar vagas disponíveis do backend com filtros
  // `modality` é aceito por listVacancies a partir de PR #66.
  const {
    data: vacancyPopulationData,
    isLoading: vacanciesLoading,
    isPending: vacanciesPending,
    isError: vacanciesError,
    error: vacanciesQueryError,
    refetch: refetchVacancies,
  } = trpc.shiftInstances.listVacancies.useQuery(
    {
      date: toLocalISODateString(filters.date), // YYYY-MM-DD (dia local)
      shiftLabel: filters.shiftLabel ?? undefined,
      modality: modalityFilter,
    },
    { enabled: !!user?.id },
  );

  const vacancyDashboard = useMemo(
    () =>
      deriveVacancyDashboard(vacancyPopulationData ?? [], {
        hospitalId: filters.hospitalId,
        sectorId: filters.sectorId,
      }),
    [filters.hospitalId, filters.sectorId, vacancyPopulationData],
  );
  const vacanciesData = vacancyDashboard.visibleRows;

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
    hasResolvedData: vacancyPopulationData !== undefined,
    itemCount: vacancies.length,
    error: vacanciesQueryError,
  });
  // Contadores são afirmações sobre a lista inteira. Eles só aparecem com
  // estado confirmado (READY/EMPTY) e quando a própria query está íntegra.
  const safeFilterCounts = canDisplayOperationalListCount(vacanciesContentState)
    ? vacancyDashboard.counts
    : undefined;
  const vacanciesSubtitle = canDisplayOperationalListCount(
    vacanciesContentState,
  )
    ? `${vacancies.length} ${vacancies.length === 1 ? "plantão" : "plantões"} aguardando profissional`
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
        (!hospitalsData ||
          presentQueryError(hospitalsError).kind === "ACCESS")) ||
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
  const assumeVacancyMutation =
    trpc.shiftAssignments.assumeVacancy.useMutation();
  const [assumeVacancyBusy, setAssumeVacancyBusy] = useState(false);
  const [assumeVacancyId, setAssumeVacancyId] = useState<number | null>(null);
  const assumeVacancyLockRef = useRef(false);

  const handleAssumeVacancy = async (
    vacancyId: number,
    vacancyDetails: string,
  ) => {
    if (assumeVacancyLockRef.current) return;
    console.log("[Vacancies] handleAssumeVacancy called", {
      vacancyId,
      vacancyDetails,
    });

    if (!professional?.id) {
      feedback.error(
        "Seu cadastro de profissional não foi encontrado. Fale com o gestor.",
      );
      return;
    }

    const refreshLease = captureLease();
    if (!refreshLease) {
      feedback.error(
        "Sua sessão ou instituição mudou. Atualize a tela antes de solicitar a vaga.",
      );
      return;
    }

    // Confirmar ação usando helper cross-platform
    const confirmed = await confirmAction(
      `Assumir vaga: ${vacancyDetails}?\n\nAguardará aprovação do gestor.`,
    );
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
    setAssumeVacancyId(vacancyId);
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
      setAssumeVacancyId(null);
      return;
    }

    // Mantém o bloqueio até a reconciliação terminar, mas não atrasa o
    // feedback de uma solicitação já aceita pelo servidor.
    const refreshPromise = refreshVacancyMutationQueries(refreshLease);
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
      setAssumeVacancyId(null);
    }
  };

  const handleFiltersChange = useCallback(
    (newFilters: ShiftFilterValues) => {
      setFilters(newFilters);
    },
    [setFilters],
  );

  // A seleção efetiva já é neutra no render que troca A → B. Este efeito só
  // encerra os artefatos visuais da intenção anterior após a nova revisão.
  useEffect(() => {
    handledVacancyIntentRef.current = null;
    setVacancyIntentNotice(null);
  }, [activeTenantKey]);

  useEffect(() => {
    if (vacancyIntentShiftInstanceId === null) {
      const consumedPublication = consumedVacancyIntentPublicationRef.current;
      if (consumedPublication !== null) {
        vacancyPushIntentNotificationFence.clearIfCurrent(consumedPublication);
        consumedVacancyIntentPublicationRef.current = null;
      }
      handledVacancyIntentRef.current = null;
      return;
    }
    // Uma nova intenção substitui qualquer aviso de alvo indisponível anterior.
    setVacancyIntentNotice(null);
  }, [vacancyIntentShiftInstanceId]);

  useEffect(() => {
    const capturedConsumptionFence = {
      userId: vacancyIntentUserId,
      sessionGeneration: vacancyIntentSessionGeneration,
      tenantId: activeInstitutionId,
      tenantRevision,
      intentShiftInstanceId: vacancyIntentShiftInstanceId,
      intentGeneration: vacancyIntentGeneration,
    };
    const capturedNotificationPublication =
      vacancyIntentShiftInstanceId === null ||
      vacancyIntentGeneration === null ||
      vacancyIntentUserId === null ||
      vacancyIntentPublicationSessionGeneration === null
        ? null
        : {
            userId: vacancyIntentUserId,
            sessionGeneration: vacancyIntentPublicationSessionGeneration,
            shiftInstanceId: vacancyIntentShiftInstanceId,
            generation: vacancyIntentGeneration,
          };
    const isConsumptionFenceCurrent = () => {
      if (!isSessionAuthorizationCurrent()) return false;
      // O módulo do tenant publica B antes do rerender React. Leia-o de novo
      // em toda mutação para que um efeito A já agendado não sobreviva à troca.
      const liveTenant = getActiveTenantSnapshot();
      return (
        isVacancyPushIntentConsumptionFenceCurrent(capturedConsumptionFence, {
          userId: vacancyIntentConsumptionFenceRef.current.userId,
          sessionGeneration:
            vacancyIntentConsumptionFenceRef.current.sessionGeneration,
          tenantId: liveTenant.institutionId,
          tenantRevision: liveTenant.revision,
          intentShiftInstanceId:
            vacancyIntentConsumptionFenceRef.current.intentShiftInstanceId,
          intentGeneration:
            vacancyIntentConsumptionFenceRef.current.intentGeneration,
        }) &&
        isVacancyPushIntentPublicationCurrent(
          capturedNotificationPublication,
          vacancyPushIntentNotificationFence.current(),
          vacancyIntentConsumptionFenceRef.current.userId,
          vacancyIntentConsumptionFenceRef.current.sessionGeneration,
        )
      );
    };
    if (
      vacancyIntentShiftInstanceId === null ||
      activeInstitutionId === null ||
      (vacancyIntentRouteState.kind !== "READY" &&
        vacancyIntentRouteState.kind !== "UNAVAILABLE")
    ) {
      return;
    }
    if (!isConsumptionFenceCurrent()) return;

    const intentKey = `${activeInstitutionId}:${tenantRevision}:${vacancyIntentSessionGeneration ?? "unverified"}:${vacancyIntentShiftInstanceId}:${vacancyIntentGeneration ?? "external"}`;
    if (handledVacancyIntentRef.current === intentKey) return;
    if (!isConsumptionFenceCurrent()) return;
    handledVacancyIntentRef.current = intentKey;

    if (vacancyIntentRouteState.kind === "READY") {
      const nextFilters: ShiftFilterValues = {
        hospitalId: vacancyIntentRouteState.selection.hospitalId,
        sectorId: vacancyIntentRouteState.selection.sectorId,
        date: fromLocalISODateString(vacancyIntentRouteState.selection.date),
        shiftLabel: null,
      };
      // A seleção controlada atualiza UI e queries na mesma renderização, sem
      // remontar a aba e sem deixar filtros anteriores do tenant no meio.
      if (!isConsumptionFenceCurrent()) return;
      setFilters(nextFilters);
      if (!isConsumptionFenceCurrent()) return;
      setModalityFilter(undefined);
      if (!isConsumptionFenceCurrent()) return;
      setVacancyIntentNotice(null);
    } else {
      // A resposta negativa é deliberadamente genérica: não revela se o ID
      // existiu, foi ocupado, revogado ou pertence a outra topologia.
      if (!isConsumptionFenceCurrent()) return;
      setVacancyIntentNotice("Esta vaga não está mais disponível.");
    }

    // Remove só a intenção já consumida. Uma nova notificação muda o param e
    // executa este efeito mesmo com a aba de Vagas já montada.
    if (!isConsumptionFenceCurrent()) return;
    router.setParams(clearVacancyPushRouteParams());
    if (capturedNotificationPublication !== null) {
      consumedVacancyIntentPublicationRef.current =
        capturedNotificationPublication;
    }
  }, [
    activeInstitutionId,
    isSessionAuthorizationCurrent,
    router,
    setFilters,
    tenantRevision,
    vacancyIntentGeneration,
    vacancyIntentPublicationSessionGeneration,
    vacancyIntentSessionGeneration,
    vacancyIntentRouteState,
    vacancyIntentShiftInstanceId,
    vacancyIntentUserId,
  ]);

  useNativeOperationalQueryRecovery({
    captureLease,
    refresh: refreshVisibleVacancyQueries,
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
      <ScreenGradient variant="light" scrollable>
        <ScreenContainer>
          <SectionHeader
            size="page"
            eyebrow="Plantões em aberto"
            title="Vagas"
            subtitle="Confirmando seu acesso e os filtros desta instituição…"
            style={{ marginBottom: theme.space[5] }}
          />
          <SkeletonList count={3} />
        </ScreenContainer>
      </ScreenGradient>
    );
  }

  if (vacanciesGateState === "AUTH_REQUIRED") {
    return (
      <ScreenGradient variant="light">
        <View className="flex-1 items-center justify-center">
          <Briefcase size={64} color={theme.colors.textMuted} />
          <Text
            className="text-xl font-semibold mt-4"
            style={{ color: theme.colors.textPrimary }}
          >
            Autenticação Necessária
          </Text>
          <Text
            className="text-center mt-2"
            style={{ color: theme.colors.textSecondary }}
          >
            Faça login para visualizar vagas
          </Text>
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
          <Text
            className="text-xl font-semibold mt-4"
            style={{ color: theme.colors.textPrimary }}
          >
            Profissional Não Encontrado
          </Text>
          <Text
            className="text-center mt-2"
            style={{ color: theme.colors.textSecondary }}
          >
            Seu usuário não está associado a um profissional
          </Text>
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
          eyebrow="Plantões em aberto"
          title="Vagas"
          subtitle={vacanciesSubtitle}
          style={{ marginBottom: theme.space[5] }}
        />

        {vacancyIntentRouteState.kind === "LOADING" ? (
          <Surface level="card" style={{ marginBottom: theme.space[4] }}>
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: theme.space[3],
              }}
            >
              <ActivityIndicator size="small" color={theme.colors.brand} />
              <Text
                style={{
                  ...theme.text.body,
                  color: theme.colors.textSecondary,
                }}
              >
                Abrindo a vaga avisada…
              </Text>
            </View>
          </Surface>
        ) : null}

        {vacancyIntentRouteState.kind === "ERROR" ? (
          <Surface level="card" style={{ marginBottom: theme.space[4] }}>
            <QueryErrorState
              title="Não foi possível abrir a vaga avisada"
              error={vacancyIntentError}
              onRetry={() => refetchVacancyIntent()}
            />
          </Surface>
        ) : null}

        {vacancyIntentNotice ? (
          <Surface level="card" style={{ marginBottom: theme.space[4] }}>
            <Text
              style={{ ...theme.text.body, color: theme.colors.textSecondary }}
            >
              {vacancyIntentNotice}
            </Text>
          </Surface>
        ) : null}

        <Surface level="card" style={{ marginBottom: theme.space[4] }}>
          <ShiftFilters
            hospitals={hospitals}
            sectors={sectors}
            allowAllHospitals={allowAllHospitals}
            persistenceInstitutionId={activeInstitutionId}
            value={filters}
            onChange={handleFiltersChange}
            counts={safeFilterCounts}
          />
        </Surface>

        {/* Filtro por modalidade: segmento compacto, sem rolagem horizontal. */}
        <Surface padded="compact" level="card" style={{ marginBottom: theme.space[5] }}>
          <Text
            style={{
              ...theme.text.eyebrow,
              fontWeight: theme.weight.bold,
              color: theme.colors.textMuted,
              textTransform: "uppercase",
              marginBottom: theme.space[2],
            }}
          >
            Modalidade
          </Text>
          <View
            style={{
              flexDirection: "row",
              padding: 2,
              borderRadius: theme.radius.lg,
              borderWidth: 1,
              borderColor: theme.colors.borderStrong,
              backgroundColor: theme.colors.surfaceAlt,
            }}
          >
            {[
              { label: "Todos", value: undefined },
              { label: "Plantão", value: "PLANTAO" as const },
              { label: "Sobreaviso", value: "SOBREAVISO" as const },
            ].map((opt) => {
              const selected = modalityFilter === opt.value;
              return (
                <Pressable
                  key={opt.label}
                  onPress={() => setModalityFilter(opt.value)}
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  accessibilityLabel={`Filtrar por ${opt.label}`}
                  style={({ pressed }) => ({
                    flex: 1,
                    minHeight: theme.space[10],
                    justifyContent: "center",
                    alignItems: "center",
                    paddingHorizontal: theme.space[1],
                    paddingVertical: theme.space[2],
                    borderRadius: theme.radius.md,
                    backgroundColor: selected
                      ? theme.colors.surface
                      : "transparent",
                    borderWidth: selected ? 1 : 0,
                    borderColor: selected
                      ? theme.colors.borderStrong
                      : "transparent",
                    opacity: pressed ? 0.8 : 1,
                    ...(selected ? theme.shadow.sm : {}),
                  })}
                >
                  <Text
                    style={{
                      ...theme.text.body,
                      color: selected
                        ? theme.colors.brand
                        : theme.colors.textSecondary,
                      fontWeight: selected ? theme.weight.bold : theme.weight.medium,
                    }}
                  >
                    {opt.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </Surface>

        {/* Carregando: skeleton com a forma dos cards */}
        {vacanciesContentState === "LOADING" ? (
          <SkeletonList count={3} />
        ) : null}

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
              const modalityLabel = formatModalityBadge(
                vacancy.modality,
                vacancy.coverageType,
              );
              return (
                <Surface
                  key={vacancy.id}
                  level="card"
                  padded={false}
                  style={{
                    borderColor: theme.colors.borderStrong,
                    borderLeftWidth: 4,
                    borderLeftColor: theme.colors.statusVagoActionable,
                    ...theme.shadow.sm,
                  }}
                >
                  <View style={{ padding: theme.space[4], gap: theme.space[3] }}>
                    <View style={{ flexDirection: "row", alignItems: "center", gap: theme.space[2] }}>
                      {modalityLabel ? (
                        <View
                          style={{
                            paddingHorizontal: theme.space[2],
                            minHeight: theme.space[5],
                            justifyContent: "center",
                            borderRadius: theme.radius.md,
                            backgroundColor: theme.colors.surfaceAlt,
                            borderWidth: 1,
                            borderColor: theme.colors.borderStrong,
                          }}
                        >
                          <Text
                            style={{
                              ...theme.text.caption,
                              color: theme.colors.textSecondary,
                              fontWeight: theme.weight.semibold,
                            }}
                          >
                            {modalityLabel}
                          </Text>
                        </View>
                      ) : null}
                      <View style={{ marginLeft: "auto" }}>
                        <ShiftStatusBadge status="VAGO" context="actionable" />
                      </View>
                    </View>

                    <View style={{ gap: theme.space[1] }}>
                      <Text
                        style={{
                          ...theme.text.eyebrow,
                          fontWeight: theme.weight.bold,
                          color: theme.colors.textMuted,
                          textTransform: "uppercase",
                        }}
                      >
                        {formatDate(vacancy.date)}
                      </Text>
                      <Text
                        style={{
                          ...theme.text.titleLg,
                          fontFamily: theme.fontFamily.mono,
                          fontWeight: theme.weight.bold,
                          color: theme.colors.textPrimary,
                        }}
                      >
                        {vacancy.startTime}–{vacancy.endTime}
                      </Text>
                      <Text
                        style={{
                          ...theme.text.titleSm,
                          fontWeight: theme.weight.semibold,
                          color: theme.colors.textPrimary,
                        }}
                      >
                        {vacancy.shift}
                      </Text>
                    </View>

                    <View style={{ gap: theme.space[2] }}>
                      <View style={{ flexDirection: "row", alignItems: "center", gap: theme.space[2] }}>
                        <MapPin size={16} color={theme.colors.textSecondary} />
                        <Text style={{ ...theme.text.body, color: theme.colors.textSecondary, flex: 1 }}>
                          {vacancy.sector}
                        </Text>
                      </View>
                      <View style={{ flexDirection: "row", alignItems: "center", gap: theme.space[2] }}>
                        <Building2 size={16} color={theme.colors.textSecondary} />
                        <Text style={{ ...theme.text.body, color: theme.colors.textSecondary, flex: 1 }}>
                          {vacancy.hospital}
                        </Text>
                      </View>
                    </View>
                  </View>

                  <View
                    style={{
                      padding: theme.space[3],
                      gap: theme.space[2],
                      borderTopWidth: 1,
                      borderTopColor: theme.colors.border,
                      backgroundColor: theme.colors.surfaceAlt,
                    }}
                  >
                    <AppButton
                      title={
                        assumeVacancyBusy && assumeVacancyId === vacancy.id
                          ? "Enviando…"
                          : "Solicitar plantão"
                      }
                      variant="brand"
                      size="lg"
                      disabled={!vacancy.canAssume || assumeVacancyBusy}
                      onPress={() =>
                        handleAssumeVacancy(
                          vacancy.id,
                          `${vacancy.shift} - ${vacancy.sector} (${formatDate(vacancy.date)})`,
                        )
                      }
                    />
                    <Text
                      style={{
                        ...theme.text.caption,
                        color: theme.colors.textSecondary,
                        textAlign: "center",
                      }}
                    >
                      {vacancy.canAssume
                        ? "O gestor confirma a solicitação antes de incluir o plantão na sua agenda."
                        : "Seu vínculo atual não permite solicitar esta vaga."}
                    </Text>
                  </View>
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
          <View
            style={{
              alignItems: "center",
              justifyContent: "center",
              paddingVertical: theme.space[20],
            }}
          >
            <Briefcase size={64} color={theme.colors.borderStrong} />
            <Text
              style={{
                ...theme.text.title,
                fontWeight: theme.weight.semibold,
                color: theme.colors.textPrimary,
                marginTop: theme.space[4],
              }}
            >
              Nenhum plantão em aberto
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
              Todos os plantões deste período já estão atribuídos. Tente outro
              hospital, setor ou data nos filtros acima.
            </Text>
          </View>
        ) : null}
      </ScreenContainer>
    </ScreenGradient>
  );
}

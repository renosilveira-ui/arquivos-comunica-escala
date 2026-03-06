import { ScreenGradient } from "@/components/ui/ScreenGradient";
import { ShiftFilters, type ShiftFilterValues } from "@/components/shift-filters";
import { trpc } from "@/lib/trpc";
import { useState, useCallback } from "react";
import { View, Text, ScrollView, ActivityIndicator, RefreshControl } from "react-native";
import { BarChart3, Clock, AlertTriangle, TrendingUp } from "lucide-react-native";
import { useAuth } from "@/hooks/use-auth";
import { useFilterDefaults } from "@/hooks/use-filter-defaults";
import { TestUserBadge } from "@/components/test-user-badge";
import { DiagnosticBadge } from "@/components/diagnostic-badge";
import { useRouter } from "expo-router";
import { TintedGlassCard } from "@/components/ui/TintedGlassCard";
import { Typography } from "@/constants/typography";

export default function DashboardScreen() {
  const { user, loading: authLoading } = useAuth();
  const router = useRouter();
  
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

  // Buscar resumo do dashboard (com cache de 60s)
  const { data: summary, isLoading: summaryLoading } = trpc.dashboard.getSummary.useQuery(
    {
      hospitalId: filters.hospitalId ?? undefined,
      sectorId: filters.sectorId ?? undefined,
      date: filters.date.toISOString().split("T")[0], // YYYY-MM-DD
      shiftLabel: filters.shiftLabel ?? undefined,
    },
    { 
      enabled: !!user?.id,
      staleTime: 60 * 1000, // Cache de 60 segundos
    }
  );

  // Buscar contadores para os filtros (com cache de 60s)
  const { data: counts } = trpc.filters.summaryCounts.useQuery(
    {
      date: filters.date.toISOString().split("T")[0], // YYYY-MM-DD
    },
    { 
      enabled: !!user?.id,
      staleTime: 60 * 1000, // Cache de 60 segundos
    }
  );

  const handleFiltersChange = useCallback((newFilters: ShiftFilterValues) => {
    setFilters(newFilters);
  }, []);

  if (authLoading || professionalLoading) {
    return (
      <ScreenGradient>
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator size="large" color="#fff" />
        </View>
      </ScreenGradient>
    );
  }

  // Dados resumo
  const totalShifts = summary?.totalShifts ?? 0;
  const pendingCount = summary?.pendingCount ?? 0;
  const confirmedCount = summary?.confirmedCount ?? 0;
  const vacancyCount = summary?.vacancyCount ?? 0;

  return (
    <ScreenGradient>
      <ScrollView className="flex-1 px-4 pt-6" showsVerticalScrollIndicator={false}>
        {/* Header */}
        <View className="mb-6">
          <Text className={`${Typography.titleMain} text-white`}>Dashboard</Text>
          <Text className={`${Typography.textSubtext} text-white/70 mt-1`}>
            Resumo das escalas
          </Text>
          <TestUserBadge />
          <DiagnosticBadge />
        </View>

        {/* Filtros */}
        <ShiftFilters
          hospitals={hospitals}
          sectors={sectors}
          initialValues={filters}
          onChange={handleFiltersChange}
          allowAllHospitals={allowAllHospitals ?? false}
          counts={counts}
        />

        {/* KPI Cards */}
        {summaryLoading ? (
          <ActivityIndicator size="large" color="#fff" className="mt-8" />
        ) : (
          <View className="mt-4 gap-3">
            <TintedGlassCard>
              <View className="flex-row items-center gap-3 p-4">
                <BarChart3 size={24} color="#60A5FA" />
                <View>
                  <Text className={`${Typography.textLabel} text-white/60`}>Total de Plantões</Text>
                  <Text className={`${Typography.titleSection} text-white`}>{totalShifts}</Text>
                </View>
              </View>
            </TintedGlassCard>

            <TintedGlassCard>
              <View className="flex-row items-center gap-3 p-4">
                <Clock size={24} color="#FBBF24" />
                <View>
                  <Text className={`${Typography.textLabel} text-white/60`}>Pendentes</Text>
                  <Text className={`${Typography.titleSection} text-white`}>{pendingCount}</Text>
                </View>
              </View>
            </TintedGlassCard>

            <TintedGlassCard>
              <View className="flex-row items-center gap-3 p-4">
                <TrendingUp size={24} color="#34D399" />
                <View>
                  <Text className={`${Typography.textLabel} text-white/60`}>Confirmados</Text>
                  <Text className={`${Typography.titleSection} text-white`}>{confirmedCount}</Text>
                </View>
              </View>
            </TintedGlassCard>

            <TintedGlassCard>
              <View className="flex-row items-center gap-3 p-4">
                <AlertTriangle size={24} color="#F87171" />
                <View>
                  <Text className={`${Typography.textLabel} text-white/60`}>Vagas Abertas</Text>
                  <Text className={`${Typography.titleSection} text-white`}>{vacancyCount}</Text>
                </View>
              </View>
            </TintedGlassCard>
          </View>
        )}

        <View className="h-8" />
      </ScrollView>
    </ScreenGradient>
  );
}
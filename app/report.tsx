import { useState, useEffect } from "react";
import { Text, View, TouchableOpacity, ActivityIndicator } from "react-native";
import { ScreenGradient } from "@/components/ui/ScreenGradient";
import { TintedGlassCard } from "@/components/ui/TintedGlassCard";
import { Badge } from "@/components/ui/Badge";
import { QueryErrorState } from "@/components/ui/QueryErrorState";
import { theme } from "@/lib/theme";
import { useAuth } from "@/hooks/use-auth";
import { trpc } from "@/lib/trpc";
import { useRouter } from "expo-router";
import * as Haptics from "expo-haptics";
import { ChevronLeft, FileText, Download, Calendar } from "lucide-react-native";
import { isDemoMode, DEMO_SHIFTS } from "@/lib/demo-mode";
import { formatDateBR } from "@/lib/datetime";
import { formatHospitalTime, formatHospitalTimeRange } from "@/lib/hospital-time";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale/pt-BR";
import { toLocalISODateString } from "@/lib/datetime-utils";
import {
  REPORT_SHIFTS_EMPTY_TITLE,
  REPORT_SHIFTS_ERROR_TITLE,
  REPORT_SHIFTS_LOADING_LABEL,
  canDisplayReportStatistics,
  reportShiftsSurface,
  resolveReportShiftsState,
} from "@/lib/report-shifts-state";

type UnifiedShift = {
  id: number;
  startTime: Date;
  endTime: Date;
  status: "confirmada" | "pendente" | "cancelada";
  turnLabel: string;
  sectorName: string;
};

type ReportApiShift = {
  id: number;
  startAt: Date | string;
  endAt: Date | string;
  status: string;
  sectorId: number;
};

function turnLabelFromStart(start: Date): string {
  const hour = Number(formatHospitalTime(start).slice(0, 2));
  return hour >= 7 && hour < 13 ? "Manhã" : hour >= 13 && hour < 19 ? "Tarde" : "Noite";
}

function mapApiShift(item: ReportApiShift): UnifiedShift {
  const start = new Date(item.startAt);
  const status: UnifiedShift["status"] =
    item.status === "OCUPADO" ? "confirmada" : item.status === "PENDENTE" ? "pendente" : "cancelada";
  return {
    id: item.id,
    startTime: start,
    endTime: new Date(item.endAt),
    status,
    turnLabel: turnLabelFromStart(start),
    // TODO: acrescentar nome real do setor quando endpoint retornar join/setor no payload de report.
    sectorName: `Setor #${item.sectorId}`,
  };
}

function mapDemoShifts(
  items: typeof DEMO_SHIFTS,
  selectedMonth: number,
  selectedYear: number,
): UnifiedShift[] {
  return items
    .filter((s) => {
      const shiftDate = new Date(s.shift.startTime);
      return (
        shiftDate.getMonth() === selectedMonth &&
        shiftDate.getFullYear() === selectedYear
      );
    })
    .map((item) => ({
      id: item.shift.id,
      startTime: new Date(item.shift.startTime),
      endTime: new Date(item.shift.endTime),
      status: item.shift.status,
      turnLabel: item.shiftType === "manha" ? "Manhã" : item.shiftType === "tarde" ? "Tarde" : "Noite",
      sectorName: item.sector?.name || "Setor não definido",
    }));
}

/**
 * Tela de Relatório de Escalas
 * Mostra estatísticas e permite exportação em PDF
 */
export default function ReportScreen() {
  const { user } = useAuth();
  const router = useRouter();
  const [isDemo, setIsDemo] = useState(false);
  const [selectedMonth, setSelectedMonth] = useState(new Date().getMonth());
  const [selectedYear, setSelectedYear] = useState(new Date().getFullYear());

  useEffect(() => {
    isDemoMode().then(setIsDemo);
  }, []);

  const startDate = new Date(selectedYear, selectedMonth, 1);
  const endDate = new Date(selectedYear, selectedMonth + 1, 0);
  const startDateIso = toLocalISODateString(startDate);
  const endDateIso = toLocalISODateString(endDate);

  const {
    data: apiShifts,
    isLoading: apiLoading,
    isPending: apiPending,
    isError: apiError,
    error: apiQueryError,
    refetch: refetchShifts,
  } = trpc.shifts.listByPeriod.useQuery(
    { startDate: startDateIso, endDate: endDateIso },
    { enabled: !!user?.id && !isDemo },
  );

  const demoShifts = isDemo
    ? mapDemoShifts(DEMO_SHIFTS, selectedMonth, selectedYear)
    : [];

  const contentState = resolveReportShiftsState({
    isDemo,
    demoCount: demoShifts.length,
    isLoading: apiLoading,
    isPending: apiPending,
    isError: apiError,
    data: apiShifts,
    error: apiQueryError,
  });
  const surface = reportShiftsSurface(contentState);

  const shifts: UnifiedShift[] = isDemo
    ? demoShifts
    : canDisplayReportStatistics(contentState) && Array.isArray(apiShifts)
      ? apiShifts.map(mapApiShift)
      : [];

  const totalShifts = shifts.length;
  const confirmedShifts = shifts.filter((s) => s.status === "confirmada").length;
  const pendingShifts = shifts.filter((s) => s.status === "pendente").length;
  const canceledShifts = shifts.filter((s) => s.status === "cancelada").length;

  const totalHours = shifts.reduce((acc: number, item) => {
    const start = new Date(item.startTime);
    const end = new Date(item.endTime);
    const hours = (end.getTime() - start.getTime()) / (1000 * 60 * 60);
    return acc + hours;
  }, 0);

  const shiftsByTurn = shifts.reduce<Record<string, number>>((acc, item) => {
    const turn = item.turnLabel;
    acc[turn] = (acc[turn] || 0) + 1;
    return acc;
  }, {});

  const handleBack = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    router.back();
  };

  const handleExportPDF = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    if (isDemo) {
      alert("📄 Exportação de PDF disponível apenas com login");
      return;
    }
    // TODO: Implementar exportação PDF
    alert("📄 Funcionalidade de exportação PDF em desenvolvimento");
  };

  const handlePreviousMonth = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    if (selectedMonth === 0) {
      setSelectedMonth(11);
      setSelectedYear(selectedYear - 1);
    } else {
      setSelectedMonth(selectedMonth - 1);
    }
  };

  const handleNextMonth = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    if (selectedMonth === 11) {
      setSelectedMonth(0);
      setSelectedYear(selectedYear + 1);
    } else {
      setSelectedMonth(selectedMonth + 1);
    }
  };

  if (!user && !isDemo) {
    return (
      <ScreenGradient scrollable={false}>
        <View className="flex-1 justify-center items-center">
          <Text className="text-lg" style={{ color: theme.colors.textMuted }}>Faça login para continuar</Text>
        </View>
      </ScreenGradient>
    );
  }

  return (
    <ScreenGradient scrollable>
      <View className="gap-6">
        <View className="flex-row items-center justify-between">
          <TouchableOpacity
            onPress={handleBack}
            className="w-10 h-10 items-center justify-center"
            style={{ marginLeft: -8 }}
          >
            <ChevronLeft size={28} color={theme.colors.textPrimary} />
          </TouchableOpacity>
          <View className="flex-1 items-center">
            <View className="flex-row items-center gap-2">
              <FileText size={24} color={theme.colors.textPrimary} />
              <Text className="text-2xl font-bold" style={{ color: theme.colors.textPrimary }}>Relatório de Escalas</Text>
            </View>
          </View>
          <View className="w-10" />
        </View>

        <TintedGlassCard variant="light">
          <View className="flex-row items-center justify-between">
            <TouchableOpacity
              onPress={handlePreviousMonth}
              className="w-10 h-10 items-center justify-center"
            >
              <Text className="text-2xl" style={{ color: theme.colors.textPrimary }}>←</Text>
            </TouchableOpacity>
            <View className="flex-1 items-center">
              <Text className="text-xl font-bold" style={{ color: theme.colors.textPrimary }}>
                {format(new Date(selectedYear, selectedMonth), "MMMM 'de' yyyy", { locale: ptBR })}
              </Text>
            </View>
            <TouchableOpacity
              onPress={handleNextMonth}
              className="w-10 h-10 items-center justify-center"
            >
              <Text className="text-2xl" style={{ color: theme.colors.textPrimary }}>→</Text>
            </TouchableOpacity>
          </View>
        </TintedGlassCard>

        {surface.kind === "LOADING" ? (
          <View className="items-center py-12">
            <ActivityIndicator size="large" color={theme.colors.primary} />
            <Text className="text-base mt-4" style={{ color: theme.colors.textMuted }}>
              {REPORT_SHIFTS_LOADING_LABEL}
            </Text>
          </View>
        ) : surface.kind === "ERROR" ? (
          <QueryErrorState
            title={REPORT_SHIFTS_ERROR_TITLE}
            error={apiQueryError}
            onRetry={() => {
              void refetchShifts();
            }}
          />
        ) : surface.showStatistics ? (
          <>
            <View className="gap-4">
              <Text className="text-2xl font-bold" style={{ color: theme.colors.textPrimary }}>Resumo do Mês</Text>
              <View className="flex-row gap-4">
                <View className="flex-1">
                  <TintedGlassCard variant="light">
                    <Text className="text-sm" style={{ color: theme.colors.textMuted }}>Total de Escalas</Text>
                    <Text className="text-4xl font-bold mt-2" style={{ color: theme.colors.textPrimary }}>{totalShifts}</Text>
                  </TintedGlassCard>
                </View>
                <View className="flex-1">
                  <TintedGlassCard variant="light">
                    <Text className="text-sm" style={{ color: theme.colors.textMuted }}>Total de Horas</Text>
                    <Text className="text-4xl font-bold mt-2" style={{ color: theme.colors.textPrimary }}>
                      {Math.round(totalHours)}h
                    </Text>
                  </TintedGlassCard>
                </View>
              </View>

              <View className="flex-row gap-4">
                <View className="flex-1">
                  <TintedGlassCard variant="light">
                    <Badge variant="success">Confirmadas</Badge>
                    <Text className="text-3xl font-bold mt-2" style={{ color: theme.colors.textPrimary }}>{confirmedShifts}</Text>
                  </TintedGlassCard>
                </View>
                <View className="flex-1">
                  <TintedGlassCard variant="light">
                    <Badge variant="warning">Pendentes</Badge>
                    <Text className="text-3xl font-bold mt-2" style={{ color: theme.colors.textPrimary }}>{pendingShifts}</Text>
                  </TintedGlassCard>
                </View>
                <View className="flex-1">
                  <TintedGlassCard variant="light">
                    <Badge variant="critical">Canceladas</Badge>
                    <Text className="text-3xl font-bold mt-2" style={{ color: theme.colors.textPrimary }}>{canceledShifts}</Text>
                  </TintedGlassCard>
                </View>
              </View>
            </View>

            <View className="gap-4">
              <Text className="text-2xl font-bold" style={{ color: theme.colors.textPrimary }}>Distribuição por Turno</Text>
              <TintedGlassCard variant="light">
                <View className="gap-3">
                  <View className="flex-row justify-between items-center py-2">
                    <Text className="text-lg" style={{ color: theme.colors.textPrimary }}>Manhã (7h-13h)</Text>
                    <Text className="text-2xl font-bold" style={{ color: theme.colors.textPrimary }}>
                      {shiftsByTurn["Manhã"] || 0}
                    </Text>
                  </View>
                  <View className="flex-row justify-between items-center py-2 border-t" style={{ borderColor: theme.colors.border }}>
                    <Text className="text-lg" style={{ color: theme.colors.textPrimary }}>Tarde (13h-19h)</Text>
                    <Text className="text-2xl font-bold" style={{ color: theme.colors.textPrimary }}>
                      {shiftsByTurn["Tarde"] || 0}
                    </Text>
                  </View>
                  <View className="flex-row justify-between items-center py-2 border-t" style={{ borderColor: theme.colors.border }}>
                    <Text className="text-lg" style={{ color: theme.colors.textPrimary }}>Noite (19h-7h)</Text>
                    <Text className="text-2xl font-bold" style={{ color: theme.colors.textPrimary }}>
                      {shiftsByTurn["Noite"] || 0}
                    </Text>
                  </View>
                </View>
              </TintedGlassCard>
            </View>

            <TouchableOpacity
              onPress={handleExportPDF}
              activeOpacity={0.7}
              style={{
                backgroundColor: theme.colors.primary,
                borderRadius: 16,
                paddingVertical: 16,
                paddingHorizontal: 24,
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "center",
                gap: 12,
              }}
            >
              <Download size={24} color={theme.colors.surface} />
              <Text className="text-lg font-bold" style={{ color: theme.colors.surface }}>Exportar Relatório (PDF)</Text>
            </TouchableOpacity>

            <View className="gap-4">
              <Text className="text-2xl font-bold" style={{ color: theme.colors.textPrimary }}>Escalas do Mês</Text>
              {shifts.length > 0 ? (
                <View className="gap-3">
                  {shifts.slice(0, 10).map((shift, index: number) => {
                    const startDate = new Date(shift.startTime);
                    const endDate = new Date(shift.endTime);

                    return (
                      <TintedGlassCard variant="light" key={index}>
                        <View className="flex-row justify-between items-start mb-2">
                          <View className="flex-1">
                            <Text className="text-lg font-semibold" style={{ color: theme.colors.textPrimary }}>
                              {shift.sectorName}
                            </Text>
                            <Text className="text-base mt-1" style={{ color: theme.colors.textSecondary }}>
                              {formatDateBR(startDate)}
                              {" • "}
                              {shift.turnLabel || "Turno não definido"}
                            </Text>
                          </View>
                          <Badge
                            variant={
                              shift.status === "confirmada"
                                ? "success"
                                : shift.status === "cancelada"
                                ? "critical"
                                : "warning"
                            }
                          >
                            {shift.status === "confirmada"
                              ? "Confirmada"
                              : shift.status === "cancelada"
                              ? "Cancelada"
                              : "Pendente"}
                          </Badge>
                        </View>
                        <Text className="text-sm" style={{ color: theme.colors.textMuted }}>
                          {formatHospitalTimeRange(startDate, endDate)}
                        </Text>
                      </TintedGlassCard>
                    );
                  })}
                  {shifts.length > 10 && (
                    <Text className="text-base text-center mt-2" style={{ color: theme.colors.textMuted }}>
                      + {shifts.length - 10} escalas
                    </Text>
                  )}
                </View>
              ) : (
                <TintedGlassCard variant="light" className="items-center py-8">
                  <Calendar size={48} color={theme.colors.textMuted} />
                  <Text className="text-base mt-3" style={{ color: theme.colors.textMuted }}>
                    {REPORT_SHIFTS_EMPTY_TITLE}
                  </Text>
                </TintedGlassCard>
              )}
            </View>
          </>
        ) : null}

        <View className="h-8" />
      </View>
    </ScreenGradient>
  );
}

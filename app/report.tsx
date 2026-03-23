import { useState, useEffect } from "react";
import { Text, View, TouchableOpacity, ActivityIndicator, ScrollView } from "react-native";
import { ScreenGradient } from "@/components/ui/ScreenGradient";
import { TintedGlassCard } from "@/components/ui/TintedGlassCard";
import { Badge } from "@/components/ui/Badge";
import { useAuth } from "@/hooks/use-auth";
import { trpc } from "@/lib/trpc";
import { useRouter } from "expo-router";
import * as Haptics from "expo-haptics";
import { ChevronLeft, FileText, Download, Calendar, Clock, Users } from "lucide-react-native";
import { isDemoMode, DEMO_SHIFTS } from "@/lib/demo-mode";
import { formatDateBR } from "@/lib/datetime";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";

type UnifiedShift = {
  id: number;
  startTime: Date;
  endTime: Date;
  status: "confirmada" | "pendente" | "cancelada";
  turnLabel: string;
  sectorName: string;
};

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

  // Verificar modo demo
  useEffect(() => {
    isDemoMode().then(setIsDemo);
  }, []);

  // Buscar escalas do mês (API ou demo)
  const startDate = new Date(selectedYear, selectedMonth, 1);
  const endDate = new Date(selectedYear, selectedMonth + 1, 0);
  const startDateIso = startDate.toISOString().slice(0, 10);
  const endDateIso = endDate.toISOString().slice(0, 10);

  const { data: apiShifts, isLoading: apiLoading } = trpc.shifts.listByPeriod.useQuery(
    { startDate: startDateIso, endDate: endDateIso },
    { enabled: !!user?.id && !isDemo }
  );

  // Dados demo
  const demoShifts = isDemo
    ? DEMO_SHIFTS.filter((s) => {
        const shiftDate = new Date(s.shift.startTime);
        return (
          shiftDate.getMonth() === selectedMonth &&
          shiftDate.getFullYear() === selectedYear
        );
      })
    : [];

  const shifts: UnifiedShift[] = isDemo
    ? demoShifts.map((item) => ({
        id: item.shift.id,
        startTime: new Date(item.shift.startTime),
        endTime: new Date(item.shift.endTime),
        status: item.shift.status,
        turnLabel: item.shiftType === "manha" ? "Manhã" : item.shiftType === "tarde" ? "Tarde" : "Noite",
        sectorName: item.sector?.name || "Setor não definido",
      }))
    : (apiShifts || []).map((item) => {
        const start = new Date(item.startAt);
        const hour = start.getHours();
        const turnLabel = hour >= 7 && hour < 13 ? "Manhã" : hour >= 13 && hour < 19 ? "Tarde" : "Noite";
        const status: UnifiedShift["status"] =
          item.status === "OCUPADO" ? "confirmada" : item.status === "PENDENTE" ? "pendente" : "cancelada";
        return {
          id: item.id,
          startTime: start,
          endTime: new Date(item.endAt),
          status,
          turnLabel,
          // TODO: acrescentar nome real do setor quando endpoint retornar join/setor no payload de report.
          sectorName: `Setor #${item.sectorId}`,
        };
      });
  const isLoading = isDemo ? false : apiLoading;

  // Calcular estatísticas
  const totalShifts = shifts.length;
  const confirmedShifts = shifts.filter((s) => s.status === "confirmada").length;
  const pendingShifts = shifts.filter((s) => s.status === "pendente").length;
  const canceledShifts = shifts.filter((s) => s.status === "cancelada").length;

  // Calcular total de horas
  const totalHours = shifts.reduce((acc: number, item) => {
    const start = new Date(item.startTime);
    const end = new Date(item.endTime);
    const hours = (end.getTime() - start.getTime()) / (1000 * 60 * 60);
    return acc + hours;
  }, 0);

  // Distribuição por turno
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
          <Text className="text-lg text-slate-600">Faça login para continuar</Text>
        </View>
      </ScreenGradient>
    );
  }

  return (
    <ScreenGradient scrollable>
      <View className="gap-6">
        {/* Header */}
        <View className="flex-row items-center justify-between">
          <TouchableOpacity
            onPress={handleBack}
            className="w-10 h-10 items-center justify-center"
            style={{ marginLeft: -8 }}
          >
            <ChevronLeft size={28} color="#0F172A" />
          </TouchableOpacity>
          <View className="flex-1 items-center">
            <View className="flex-row items-center gap-2">
              <FileText size={24} color="#0F172A" />
              <Text className="text-2xl font-bold text-slate-900">Relatório de Escalas</Text>
            </View>
          </View>
          <View className="w-10" />
        </View>

        {/* Seletor de Mês */}
        <TintedGlassCard>
          <View className="flex-row items-center justify-between">
            <TouchableOpacity
              onPress={handlePreviousMonth}
              className="w-10 h-10 items-center justify-center"
            >
              <Text className="text-2xl text-slate-900">←</Text>
            </TouchableOpacity>
            <View className="flex-1 items-center">
              <Text className="text-xl font-bold text-slate-900">
                {format(new Date(selectedYear, selectedMonth), "MMMM 'de' yyyy", { locale: ptBR })}
              </Text>
            </View>
            <TouchableOpacity
              onPress={handleNextMonth}
              className="w-10 h-10 items-center justify-center"
            >
              <Text className="text-2xl text-slate-900">→</Text>
            </TouchableOpacity>
          </View>
        </TintedGlassCard>

        {isLoading ? (
          <View className="items-center py-12">
            <ActivityIndicator size="large" color="#4DA3FF" />
            <Text className="text-base text-slate-600 mt-4">Carregando dados...</Text>
          </View>
        ) : (
          <>
            {/* Estatísticas Gerais */}
            <View className="gap-4">
              <Text className="text-2xl font-bold text-slate-900">Resumo do Mês</Text>
              <View className="flex-row gap-4">
                <View className="flex-1">
                  <TintedGlassCard>
                    <Text className="text-sm text-slate-600">Total de Escalas</Text>
                    <Text className="text-4xl font-bold text-slate-900 mt-2">{totalShifts}</Text>
                  </TintedGlassCard>
                </View>
                <View className="flex-1">
                  <TintedGlassCard>
                    <Text className="text-sm text-slate-600">Total de Horas</Text>
                    <Text className="text-4xl font-bold text-slate-900 mt-2">
                      {Math.round(totalHours)}h
                    </Text>
                  </TintedGlassCard>
                </View>
              </View>

              {/* Status das Escalas */}
              <View className="flex-row gap-4">
                <View className="flex-1">
                  <TintedGlassCard>
                    <Badge variant="success">Confirmadas</Badge>
                    <Text className="text-3xl font-bold text-slate-900 mt-2">{confirmedShifts}</Text>
                  </TintedGlassCard>
                </View>
                <View className="flex-1">
                  <TintedGlassCard>
                    <Badge variant="warning">Pendentes</Badge>
                    <Text className="text-3xl font-bold text-slate-900 mt-2">{pendingShifts}</Text>
                  </TintedGlassCard>
                </View>
                <View className="flex-1">
                  <TintedGlassCard>
                    <Badge variant="critical">Canceladas</Badge>
                    <Text className="text-3xl font-bold text-slate-900 mt-2">{canceledShifts}</Text>
                  </TintedGlassCard>
                </View>
              </View>
            </View>

            {/* Distribuição por Turno */}
            <View className="gap-4">
              <Text className="text-2xl font-bold text-slate-900">Distribuição por Turno</Text>
              <TintedGlassCard>
                <View className="gap-3">
                  <View className="flex-row justify-between items-center py-2">
                    <Text className="text-lg text-slate-900">Manhã (7h-13h)</Text>
                    <Text className="text-2xl font-bold text-slate-900">
                      {shiftsByTurn["Manhã"] || 0}
                    </Text>
                  </View>
                  <View className="flex-row justify-between items-center py-2 border-t border-white/10">
                    <Text className="text-lg text-slate-900">Tarde (13h-19h)</Text>
                    <Text className="text-2xl font-bold text-slate-900">
                      {shiftsByTurn["Tarde"] || 0}
                    </Text>
                  </View>
                  <View className="flex-row justify-between items-center py-2 border-t border-white/10">
                    <Text className="text-lg text-slate-900">Noite (19h-7h)</Text>
                    <Text className="text-2xl font-bold text-slate-900">
                      {shiftsByTurn["Noite"] || 0}
                    </Text>
                  </View>
                </View>
              </TintedGlassCard>
            </View>

            {/* Botão de Exportar PDF */}
            <TouchableOpacity
              onPress={handleExportPDF}
              activeOpacity={0.7}
              style={{
                backgroundColor: "#3B82F6",
                borderRadius: 16,
                paddingVertical: 16,
                paddingHorizontal: 24,
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "center",
                gap: 12,
              }}
            >
              <Download size={24} color="#0F172A" />
              <Text className="text-lg font-bold text-slate-900">Exportar Relatório (PDF)</Text>
            </TouchableOpacity>

            {/* Lista de Escalas do Mês */}
            <View className="gap-4">
              <Text className="text-2xl font-bold text-slate-900">Escalas do Mês</Text>
              {shifts.length > 0 ? (
                <View className="gap-3">
                  {shifts.slice(0, 10).map((shift, index: number) => {
                    const startDate = new Date(shift.startTime);
                    const endDate = new Date(shift.endTime);

                    return (
                      <TintedGlassCard key={index}>
                        <View className="flex-row justify-between items-start mb-2">
                          <View className="flex-1">
                            <Text className="text-lg font-semibold text-slate-900">
                              {shift.sectorName}
                            </Text>
                            <Text className="text-base text-slate-600 mt-1">
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
                        <Text className="text-sm text-slate-500">
                          {startDate.toLocaleTimeString("pt-BR", {
                            hour: "2-digit",
                            minute: "2-digit",
                          })}{" "}
                          -{" "}
                          {endDate.toLocaleTimeString("pt-BR", {
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </Text>
                      </TintedGlassCard>
                    );
                  })}
                  {shifts.length > 10 && (
                    <Text className="text-base text-slate-500 text-center mt-2">
                      + {shifts.length - 10} escalas
                    </Text>
                  )}
                </View>
              ) : (
                <TintedGlassCard className="items-center py-8">
                  <Calendar size={48} color="#94A3B8" />
                  <Text className="text-base text-slate-500 mt-3">
                    Nenhuma escala neste mês
                  </Text>
                </TintedGlassCard>
              )}
            </View>
          </>
        )}

        {/* Espaçamento inferior */}
        <View className="h-8" />
      </View>
    </ScreenGradient>
  );
}

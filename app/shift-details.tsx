import { useState, useEffect } from "react";
import { Text, View, TouchableOpacity, ActivityIndicator } from "react-native";
import { ScreenGradient } from "@/components/ui/ScreenGradient";
import { TintedGlassCard } from "@/components/ui/TintedGlassCard";
import { Badge } from "@/components/ui/Badge";
import { theme } from "@/lib/theme";
import { useAuth } from "@/hooks/use-auth";
import { trpc } from "@/lib/trpc";
import { useRouter, useLocalSearchParams } from "expo-router";
import * as Haptics from "expo-haptics";
import { ChevronLeft, Clock, Calendar, Users, CheckCircle2, AlertCircle } from "lucide-react-native";
import { isDemoMode, DEMO_SHIFTS } from "@/lib/demo-mode";
import { formatDateBR } from "@/lib/datetime";

/**
 * Tela de Detalhes da Escala
 * Mostra informações completas da escala e lista de profissionais alocados
 */
export default function ShiftDetailsScreen() {
  const { user } = useAuth();
  const router = useRouter();
  const params = useLocalSearchParams();
  const shiftId = Number(params.id);
  const [isDemo, setIsDemo] = useState(false);

  // Verificar modo demo
  useEffect(() => {
    isDemoMode().then(setIsDemo);
  }, []);

  // Buscar detalhes da escala (API ou demo)
  const { data: apiShiftData, isLoading: apiLoading } = trpc.shifts.get.useQuery(
    { id: shiftId },
    { enabled: !!user?.id && !isDemo }
  );

  // Dados demo
  const demoShiftData = isDemo
    ? DEMO_SHIFTS.find((s) => s.shift.id === shiftId)
    : null;

  const shiftData: any = isDemo
    ? demoShiftData
      ? {
          shift: {
            ...demoShiftData.shift,
            startAt: demoShiftData.shift.startTime,
            endAt: demoShiftData.shift.endTime,
          },
          sector: demoShiftData.sector,
          assignments: (demoShiftData as any).assignments || [],
        }
      : null
    : apiShiftData
      ? {
          shift: apiShiftData,
          // TODO: incluir dados completos de setor (nome/categoria/cor) no backend se necessário para esta tela.
          sector: null,
          assignments: apiShiftData.assignments || [],
        }
      : null;

  const isLoading = isDemo ? false : apiLoading;

  const handleBack = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    router.back();
  };

  const handleConfirmPresence = () => {
    if (!user) return;
    if (isDemo) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      return; // Modo demo: apenas feedback visual
    }
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    // TODO: endpoint de confirmação de presença não existe no router tRPC atual.
    alert("Confirmação de presença ainda não disponível neste ambiente.");
  };

  const handleEdit = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    router.push(`/edit-shift?id=${shiftId}`);
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

  if (isLoading) {
    return (
      <ScreenGradient scrollable={false}>
        <View className="flex-1 justify-center items-center gap-4">
          <ActivityIndicator size="large" color={theme.colors.primary} />
          <Text className="text-base" style={{ color: theme.colors.textMuted }}>Carregando detalhes...</Text>
        </View>
      </ScreenGradient>
    );
  }

  if (!shiftData?.shift) {
    return (
      <ScreenGradient scrollable={false}>
        <View className="flex-1 justify-center items-center gap-6">
          <AlertCircle size={64} color={theme.colors.textMuted} />
          <Text className="text-lg" style={{ color: theme.colors.textMuted }}>Escala não encontrada</Text>
          <TouchableOpacity
            onPress={handleBack}
            className="rounded-2xl px-8 h-14 justify-center"
            style={{ backgroundColor: theme.colors.primary }}
            activeOpacity={0.7}
          >
            <Text className="text-lg font-semibold" style={{ color: "#FFFFFF" }}>Voltar</Text>
          </TouchableOpacity>
        </View>
      </ScreenGradient>
    );
  }

  const { shift, sector, assignments } = shiftData;
  const startDate = new Date(shift.startAt ?? shift.startTime);
  const endDate = new Date(shift.endAt ?? shift.endTime);

  // Verificar se usuário está alocado nesta escala
  const userAssignment = assignments?.find((a: any) => a.professionalId === user?.id || a.userId === user?.id);
  const isUserAssigned = !!userAssignment;

  return (
    <ScreenGradient scrollable>
      <View className="gap-6">
        {/* Header com botão voltar */}
        <View className="flex-row items-center gap-4">
          <TouchableOpacity
            onPress={handleBack}
            activeOpacity={0.7}
            className="w-10 h-10 items-center justify-center"
          >
            <ChevronLeft size={28} color={theme.colors.textPrimary} />
          </TouchableOpacity>
          <View className="flex-1">
            <Text className="text-3xl font-bold" style={{ color: theme.colors.textPrimary }}>Detalhes da Escala</Text>
          </View>
        </View>

        {/* Card de Informações da Escala */}
        <TintedGlassCard className="gap-6">
          {/* Setor */}
          <View className="flex-row items-center gap-4">
            <View
              className="w-12 h-12 rounded-2xl items-center justify-center"
              style={{ backgroundColor: sector?.color || theme.colors.primary }}
            >
              <Calendar size={24} color="#FFFFFF" />
            </View>
            <View className="flex-1">
              <Text className="text-sm mb-1" style={{ color: theme.colors.textMuted }}>Setor</Text>
              <Text className="text-2xl font-bold" style={{ color: theme.colors.textPrimary }}>
                {sector?.name || "Não definido"}
              </Text>
              <Text className="text-sm capitalize mt-1" style={{ color: theme.colors.textMuted }}>{sector?.category}</Text>
            </View>
          </View>

          {/* Data e Horário */}
          <View className="gap-4">
            <View>
              <Text className="text-sm mb-2" style={{ color: theme.colors.textMuted }}>Data</Text>
              <Text className="text-lg font-semibold" style={{ color: theme.colors.textPrimary }}>
                {formatDateBR(startDate)}
              </Text>
            </View>

            <View className="flex-row gap-4">
              <View className="flex-1">
                <Text className="text-sm mb-2" style={{ color: theme.colors.textMuted }}>Início</Text>
                <View className="flex-row items-center gap-2">
                  <Clock size={18} color={theme.colors.textMuted} />
                  <Text className="text-lg font-semibold" style={{ color: theme.colors.textPrimary }}>
                    {startDate.toLocaleTimeString("pt-BR", {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </Text>
                </View>
              </View>
              <View className="flex-1">
                <Text className="text-sm mb-2" style={{ color: theme.colors.textMuted }}>Término</Text>
                <View className="flex-row items-center gap-2">
                  <Clock size={18} color={theme.colors.textMuted} />
                  <Text className="text-lg font-semibold" style={{ color: theme.colors.textPrimary }}>
                    {endDate.toLocaleTimeString("pt-BR", {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </Text>
                </View>
              </View>
            </View>

            {/* Duração */}
            <View>
              <Text className="text-sm mb-2" style={{ color: theme.colors.textMuted }}>Duração</Text>
              <Text className="text-lg font-semibold" style={{ color: theme.colors.textPrimary }}>
                {Math.round((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60))} horas
              </Text>
            </View>
          </View>

          {/* Status */}
          <View className="pt-4 border-t" style={{ borderColor: theme.colors.border }}>
            <Text className="text-sm mb-3" style={{ color: theme.colors.textMuted }}>Status</Text>
            <Badge
              variant={
                (shift.status === "confirmada" || shift.status === "OCUPADO")
                  ? "success"
                  : (shift.status === "cancelada" || shift.status === "VAGO")
                  ? "critical"
                  : "warning"
              }
            >
              {(shift.status === "confirmada" || shift.status === "OCUPADO")
                ? "Confirmada"
                : (shift.status === "cancelada" || shift.status === "VAGO")
                ? "Cancelada"
                : "Pendente"}
            </Badge>
          </View>

          {/* Observações */}
          {shift.notes && (
            <View className="pt-4 border-t" style={{ borderColor: theme.colors.border }}>
              <Text className="text-sm mb-2" style={{ color: theme.colors.textMuted }}>Observações</Text>
              <Text className="text-base" style={{ color: theme.colors.textSecondary }}>{shift.notes}</Text>
            </View>
          )}
        </TintedGlassCard>

        {/* Lista de Profissionais Alocados */}
        <View>
          <View className="flex-row items-center gap-3 mb-4">
            <Users size={24} color={theme.colors.textPrimary} />
            <Text className="text-2xl font-bold" style={{ color: theme.colors.textPrimary }}>
              Profissionais ({assignments?.length || 0})
            </Text>
          </View>

          {assignments && assignments.length > 0 ? (
            <View className="gap-3">
              {assignments.map((assignment: any, index: number) => (
                <TintedGlassCard key={index}>
                  <View className="flex-row items-center justify-between">
                    <View className="flex-1">
                      <View className="flex-row items-center gap-2 mb-1">
                        <Text className="text-lg font-semibold" style={{ color: theme.colors.textPrimary }}>
                          {assignment.professionalName || `Profissional #${assignment.userId || assignment.professionalId}`}
                        </Text>
                        {assignment.isSubstitute && (
                          <Badge variant="neutral">
                            <Text className="text-xs font-semibold" style={{ color: theme.colors.primary }}>Substituto</Text>
                          </Badge>
                        )}
                      </View>
                      {assignment.confirmedAt && (
                        <Text className="text-sm mt-1" style={{ color: theme.colors.textMuted }}>
                          Confirmado em{" "}
                          {formatDateBR(assignment.confirmedAt)}
                        </Text>
                      )}
                    </View>
                    {assignment.confirmed || assignment.confirmedAt ? (
                      <View className="flex-row items-center gap-2">
                        <CheckCircle2 size={20} color={theme.colors.success} />
                        <Badge variant="success">Confirmado</Badge>
                      </View>
                    ) : (
                      <Badge variant="warning">Pendente</Badge>
                    )}
                  </View>
                </TintedGlassCard>
              ))}
            </View>
          ) : (
            <TintedGlassCard className="items-center py-8">
              <Users size={48} color={theme.colors.textMuted} />
              <Text className="text-base mt-3" style={{ color: theme.colors.textMuted }}>Nenhum profissional alocado</Text>
            </TintedGlassCard>
          )}
        </View>

        {/* Botão de Confirmar Presença */}
        {shift.status !== "cancelada" && shift.status !== "VAGO" && user && (
          <TouchableOpacity
            onPress={handleConfirmPresence}
            className="rounded-2xl h-16 items-center justify-center"
            style={{
              backgroundColor: theme.colors.success,
            }}
            activeOpacity={0.8}
          >
            <View className="flex-row items-center gap-3">
              <CheckCircle2 size={24} color="#FFFFFF" />
              <Text className="text-xl font-bold" style={{ color: "#FFFFFF" }}>Confirmar Presença</Text>
            </View>
          </TouchableOpacity>
        )}

        {/* Botões de Ação */}
        {shift.status !== "cancelada" && (
          <View className="gap-4">
            {/* Botão de Editar */}
            <TouchableOpacity
              onPress={handleEdit}
              className="rounded-2xl h-14 items-center justify-center"
              style={{
                backgroundColor: theme.colors.surfaceAlt,
                borderWidth: 1,
                borderColor: theme.colors.border,
              }}
              activeOpacity={0.7}
            >
              <Text className="text-lg font-semibold" style={{ color: theme.colors.textPrimary }}>Editar Escala</Text>
            </TouchableOpacity>

            {/* Botão de Solicitar Troca */}
            <TouchableOpacity
              onPress={() => {
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                router.push(`/request-swap?id=${shiftId}`);
              }}
              className="rounded-2xl h-14 items-center justify-center"
              style={{
                backgroundColor: "rgba(37,99,235,0.08)",
                borderWidth: 1,
                borderColor: theme.colors.primary,
              }}
              activeOpacity={0.7}
            >
              <Text className="text-lg font-semibold" style={{ color: theme.colors.primary }}>Solicitar Troca de Plantão</Text>
            </TouchableOpacity>

            {/* Botão de Confirmação de Presença */}
            {isUserAssigned && !userAssignment?.confirmedAt && !userAssignment?.confirmed && (
              <TouchableOpacity
                onPress={handleConfirmPresence}
                className="rounded-2xl h-14 items-center justify-center"
                style={{ backgroundColor: theme.colors.primary }}
                activeOpacity={0.7}
              >
                <Text className="text-lg font-semibold" style={{ color: "#FFFFFF" }}>Confirmar Presença</Text>
              </TouchableOpacity>
            )}
          </View>
        )}
      </View>
    </ScreenGradient>
  );
}

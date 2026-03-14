import { useState, useEffect } from "react";
import { Text, View, TouchableOpacity, ActivityIndicator, FlatList } from "react-native";
import { ScreenGradient } from "@/components/ui/ScreenGradient";
import { TintedGlassCard } from "@/components/ui/TintedGlassCard";
import { Badge } from "@/components/ui/Badge";
import { useAuth } from "@/hooks/use-auth";
import { usePermissions } from "@/hooks/use-permissions";
import { useRouter } from "expo-router";
import * as Haptics from "expo-haptics";
import { ChevronLeft, CheckCircle, XCircle, Calendar, Clock, User } from "lucide-react-native";
import { isDemoMode } from "@/lib/demo-mode";
import { sendLocalNotification } from "@/lib/notifications";
import { formatDateBR } from "@/lib/datetime";

/**
 * Tela de Aprovação de Trocas de Plantão
 * Lista de solicitações pendentes com botões Aprovar/Rejeitar
 */
export default function ApproveSwapsScreen() {
  const { user } = useAuth();
  const { can } = usePermissions();
  const router = useRouter();
  const [isDemo, setIsDemo] = useState(false);
  const [swapRequests, setSwapRequests] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  // Guard: somente admin/manager podem aprovar trocas
  useEffect(() => {
    if (!can("approve:swaps")) router.back();
  }, []);

  // Verificar modo demo
  useEffect(() => {
    isDemoMode().then(setIsDemo);
  }, []);

  // Carregar solicitações de troca (demo)
  useEffect(() => {
    if (isDemo) {
      // Dados demo de solicitações pendentes
      setSwapRequests([
        {
          id: 1,
          requestedBy: { name: "Dr. Carlos Santos" },
          requestedTo: { name: user?.name || "Você" },
          shift: {
            date: "2026-02-15",
            shift: "Manhã",
            startTime: "07:00",
            endTime: "13:00",
            sector: { name: "Anestesia" },
          },
          reason: "Compromisso familiar urgente",
          status: "pending",
          createdAt: new Date("2026-02-12T10:00:00"),
        },
        {
          id: 2,
          requestedBy: { name: "Dra. Maria Oliveira" },
          requestedTo: { name: user?.name || "Você" },
          shift: {
            date: "2026-02-18",
            shift: "Tarde",
            startTime: "13:00",
            endTime: "19:00",
            sector: { name: "Cirurgia" },
          },
          reason: "Viagem médica - congresso",
          status: "pending",
          createdAt: new Date("2026-02-11T15:30:00"),
        },
      ]);
      setLoading(false);
    }
  }, [isDemo, user]);

  const handleApprove = async (requestId: number) => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    
    const request = swapRequests.find((r) => r.id === requestId);
    if (request) {
      // Notificar solicitante
      await sendLocalNotification(
        "Troca de Plantão Aprovada",
        `${request.requestedTo.name} aceitou sua solicitação de troca para ${request.shift.date}.`,
        { type: 'swap_approved' }
      );
    }

    // Remover da lista
    setSwapRequests((prev) => prev.filter((r) => r.id !== requestId));
  };

  const handleReject = async (requestId: number) => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    
    const request = swapRequests.find((r) => r.id === requestId);
    if (request) {
      // Notificar solicitante
      await sendLocalNotification(
        "Troca de Plantão Recusada",
        `${request.requestedTo.name} não pode aceitar sua solicitação de troca para ${request.shift.date}.`,
        { type: 'swap_rejected' }
      );
    }

    // Remover da lista
    setSwapRequests((prev) => prev.filter((r) => r.id !== requestId));
  };

  const handleBack = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    router.back();
  };

  if (!user && !isDemo) {
    return (
      <ScreenGradient scrollable={false}>
        <View className="flex-1 justify-center items-center">
          <Text className="text-lg text-white/70">Faça login para continuar</Text>
        </View>
      </ScreenGradient>
    );
  }

  return (
    <ScreenGradient scrollable={false}>
      <View className="flex-1 gap-6">
        {/* Header com botão voltar */}
        <View className="flex-row items-center gap-4">
          <TouchableOpacity
            onPress={handleBack}
            activeOpacity={0.7}
            className="w-10 h-10 items-center justify-center"
          >
            <ChevronLeft size={28} color="#FFFFFF" />
          </TouchableOpacity>
          <View className="flex-1">
            <Text className="text-3xl font-bold text-white">Aprovar Trocas</Text>
            <Text className="text-base text-white/50 mt-1">
              {swapRequests.length} solicitações pendentes
            </Text>
          </View>
        </View>

        {/* Lista de Solicitações */}
        {loading ? (
          <View className="flex-1 justify-center items-center">
            <ActivityIndicator size="large" color="#4DA3FF" />
          </View>
        ) : swapRequests.length === 0 ? (
          <View className="flex-1 justify-center items-center">
            <Text className="text-lg text-white/50">Nenhuma solicitação pendente</Text>
          </View>
        ) : (
          <FlatList
            data={swapRequests}
            keyExtractor={(item) => item.id.toString()}
            contentContainerStyle={{ gap: 16, paddingBottom: 16 }}
            renderItem={({ item }) => (
              <TintedGlassCard className="gap-4">
                {/* Cabeçalho */}
                <View className="flex-row items-center justify-between">
                  <View className="flex-row items-center gap-3">
                    <User size={20} color="#FFFFFF" />
                    <Text className="text-lg font-semibold text-white">
                      {item.requestedBy.name}
                    </Text>
                  </View>
                  <Badge variant="warning">Pendente</Badge>
                </View>

                {/* Informações da Escala */}
                <View className="gap-3">
                  <View className="flex-row items-center gap-3">
                    <Calendar size={18} color="rgba(255,255,255,0.5)" />
                    <Text className="text-base text-white/70">
                      {formatDateBR(item.shift.date)}
                    </Text>
                  </View>

                  <View className="flex-row items-center gap-3">
                    <Clock size={18} color="rgba(255,255,255,0.5)" />
                    <Text className="text-base text-white/70">
                      {item.shift.shift} ({item.shift.startTime} - {item.shift.endTime})
                    </Text>
                  </View>

                  <View className="flex-row items-center gap-3">
                    <View
                      className="w-[18px] h-[18px] rounded-full"
                      style={{ backgroundColor: "rgba(77,163,255,0.3)" }}
                    />
                    <Text className="text-base text-white/70">{item.shift.sector.name}</Text>
                  </View>
                </View>

                {/* Motivo */}
                {item.reason && (
                  <View className="p-3 rounded-xl" style={{ backgroundColor: "rgba(255,255,255,0.05)" }}>
                    <Text className="text-sm text-white/50 mb-1">Motivo:</Text>
                    <Text className="text-base text-white">{item.reason}</Text>
                  </View>
                )}

                {/* Botões de Ação */}
                <View className="flex-row gap-3 mt-2">
                  <TouchableOpacity
                    onPress={() => handleApprove(item.id)}
                    className="flex-1 flex-row items-center justify-center gap-2 bg-[#22C55E] rounded-2xl h-12"
                    activeOpacity={0.7}
                  >
                    <CheckCircle size={20} color="#FFFFFF" />
                    <Text className="text-base font-semibold text-white">Aprovar</Text>
                  </TouchableOpacity>

                  <TouchableOpacity
                    onPress={() => handleReject(item.id)}
                    className="flex-1 flex-row items-center justify-center gap-2 rounded-2xl h-12"
                    style={{ backgroundColor: "rgba(239,68,68,0.9)" }}
                    activeOpacity={0.7}
                  >
                    <XCircle size={20} color="#FFFFFF" />
                    <Text className="text-base font-semibold text-white">Recusar</Text>
                  </TouchableOpacity>
                </View>
              </TintedGlassCard>
            )}
          />
        )}
      </View>
    </ScreenGradient>
  );
}

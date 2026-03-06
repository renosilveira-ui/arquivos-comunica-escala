import { useState } from "react";
import { Text, View, TouchableOpacity, ScrollView, ActivityIndicator, TextInput } from "react-native";
import { ScreenGradient } from "@/components/ui/ScreenGradient";
import { TintedGlassCard } from "@/components/ui/TintedGlassCard";
import { Badge } from "@/components/ui/Badge";
import { useAuth } from "@/hooks/use-auth";
import { trpc } from "@/lib/trpc";
import { useRouter } from "expo-router";
import * as Haptics from "expo-haptics";
import { Settings, Plus, TrendingUp, Calendar, Lock, RefreshCw, FileText } from "lucide-react-native";
import { formatDateBR } from "@/lib/datetime";

/**
 * Tela de Administração
 * Dashboard administrativo para gestores criarem e gerenciarem escalas
 */
export default function AdminScreen() {
  const { user } = useAuth();
  const router = useRouter();
  const [searchQuery, setSearchQuery] = useState("");

  // Buscar setores
  const { data: sectors, isLoading: loadingSectors } = trpc.sectors.list.useQuery();

  // Buscar escalas futuras (próximos 30 dias)
  const startDate = new Date();
  const endDate = new Date();
  endDate.setDate(endDate.getDate() + 30);

  const { data: upcomingShifts, isLoading: loadingShifts } = trpc.shifts.listByPeriod.useQuery({
    startDate,
    endDate,
  });

  const handleCreateShift = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    router.push("/create-shift");
  };

  const handleApproveSwaps = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    router.push("/approve-swaps");
  };

  const handleReport = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    router.push("/report");
  };

  if (!user) {
    return (
      <ScreenGradient scrollable={false}>
        <View className="flex-1 justify-center items-center">
          <Text className="text-lg text-white/70">Faça login para continuar</Text>
        </View>
      </ScreenGradient>
    );
  }

  // TODO: Verificar se usuário é admin - por enquanto permitir acesso a todos
  const isAdmin = true; // user.role === "admin";

  if (!isAdmin) {
    return (
      <ScreenGradient scrollable={false}>
        <View className="flex-1 justify-center items-center gap-4">
          <Lock size={48} color="rgba(255,255,255,0.5)" />
          <Text className="text-lg text-white/70">Acesso restrito a administradores</Text>
        </View>
      </ScreenGradient>
    );
  }

  return (
    <ScreenGradient scrollable>
      <View className="gap-6">
        {/* Header */}
        <View className="gap-2">
          <View className="flex-row items-center gap-3">
            <Settings size={28} color="#FFFFFF" />
            <Text className="text-3xl font-bold text-white">Administração</Text>
          </View>
          <Text className="text-lg text-white/70">Gerenciar escalas e setores</Text>
        </View>

        {/* Campo de Busca */}
        <TintedGlassCard>
          <View className="flex-row items-center gap-3">
            <Text className="text-white/50">🔍</Text>
            <TextInput
              placeholder="Buscar profissional, setor ou período..."
              placeholderTextColor="rgba(255,255,255,0.5)"
              value={searchQuery}
              onChangeText={setSearchQuery}
              style={{
                flex: 1,
                fontSize: 16,
                color: "#FFFFFF",
                paddingVertical: 8,
              }}
            />
          </View>
        </TintedGlassCard>

        {/* Ações Rápidas */}
        <View className="gap-4">
          <TouchableOpacity
            onPress={handleCreateShift}
            activeOpacity={0.7}
          >
            <TintedGlassCard>
              <View className="items-center py-4">
                <View className="w-16 h-16 rounded-full items-center justify-center mb-4" style={{ backgroundColor: "#3B82F6" }}>
                  <Plus size={32} color="#FFFFFF" />
                </View>
                <Text className="text-2xl font-bold text-white">Criar Nova Escala</Text>
                <Text className="text-base text-white/70 mt-2 text-center">
                  Alocar profissionais em setores e horários
                </Text>
              </View>
            </TintedGlassCard>
          </TouchableOpacity>

          <TouchableOpacity
            onPress={handleApproveSwaps}
            activeOpacity={0.7}
          >
            <TintedGlassCard>
              <View className="flex-row items-center gap-4 py-3">
                <View className="w-12 h-12 rounded-full items-center justify-center" style={{ backgroundColor: "rgba(59,130,246,0.2)" }}>
                  <RefreshCw size={24} color="#3B82F6" />
                </View>
                <View className="flex-1">
                  <Text className="text-xl font-bold text-white">Aprovar Trocas de Plantão</Text>
                  <Text className="text-base text-white/70 mt-1">
                    Gerenciar solicitações pendentes
                  </Text>
                </View>
              </View>
            </TintedGlassCard>
          </TouchableOpacity>

          <TouchableOpacity
            onPress={handleReport}
            activeOpacity={0.7}
          >
            <TintedGlassCard>
              <View className="flex-row items-center gap-4 py-3">
                <View className="w-12 h-12 rounded-full items-center justify-center" style={{ backgroundColor: "rgba(59,130,246,0.2)" }}>
                  <FileText size={24} color="#3B82F6" />
                </View>
                <View className="flex-1">
                  <Text className="text-xl font-bold text-white">Relatório de Escalas</Text>
                  <Text className="text-base text-white/70 mt-1">
                    Estatísticas e exportação PDF
                  </Text>
                </View>
              </View>
            </TintedGlassCard>
          </TouchableOpacity>
        </View>

        {/* Estatísticas */}
        <View className="gap-4">
          <View className="flex-row items-center gap-2">
            <TrendingUp size={20} color="#FFFFFF" />
            <Text className="text-2xl font-bold text-white">Estatísticas</Text>
          </View>
          <View className="flex-row gap-4">
            <View className="flex-1">
              <TintedGlassCard>
                <Text className="text-base text-white/70">Total de Setores</Text>
                {loadingSectors ? (
                  <ActivityIndicator size="small" color="#3B82F6" className="mt-2" />
                ) : (
                  <Text className="text-4xl font-bold text-white mt-2">
                    {sectors?.length || 0}
                  </Text>
                )}
              </TintedGlassCard>
            </View>
            <View className="flex-1">
              <TintedGlassCard>
                <Text className="text-base text-white/70">Escalas Futuras</Text>
                {loadingShifts ? (
                  <ActivityIndicator size="small" color="#3B82F6" className="mt-2" />
                ) : (
                  <Text className="text-4xl font-bold text-white mt-2">
                    {upcomingShifts?.length || 0}
                  </Text>
                )}
              </TintedGlassCard>
            </View>
          </View>
        </View>

        {/* Setores */}
        <View className="gap-4">
          <Text className="text-2xl font-bold text-white">Setores Cadastrados</Text>
          {loadingSectors ? (
            <TintedGlassCard>
              <View className="items-center py-4">
                <ActivityIndicator size="small" color="#3B82F6" />
              </View>
            </TintedGlassCard>
          ) : sectors && sectors.length > 0 ? (
            <TintedGlassCard>
              <View className="gap-3">
                {sectors.slice(0, 10).map((sector) => (
                  <View
                    key={sector.id}
                    className="flex-row items-center justify-between py-3"
                    style={{
                      borderBottomWidth: 1,
                      borderBottomColor: "rgba(255,255,255,0.08)",
                    }}
                  >
                    <View className="flex-row items-center gap-3 flex-1">
                      <View
                        className="w-3 h-3 rounded-full"
                        style={{ backgroundColor: sector.color }}
                      />
                      <View className="flex-1">
                        <Text className="text-lg font-semibold text-white">
                          {sector.name}
                        </Text>
                        <Text className="text-base text-white/70 capitalize">{sector.category}</Text>
                      </View>
                    </View>
                    <View className="px-3 py-1 rounded-full" style={{ backgroundColor: "rgba(59,130,246,0.2)" }}>
                      <Text className="text-sm font-semibold text-white">
                        {sector.minStaffCount} min
                      </Text>
                    </View>
                  </View>
                ))}
                {sectors.length > 10 && (
                  <Text className="text-base text-white/50 text-center mt-2">
                    + {sectors.length - 10} setores
                  </Text>
                )}
              </View>
            </TintedGlassCard>
          ) : (
            <TintedGlassCard>
              <View className="items-center py-8">
                <Settings size={48} color="rgba(255,255,255,0.3)" />
                <Text className="text-lg text-white/50 mt-4">Nenhum setor cadastrado</Text>
              </View>
            </TintedGlassCard>
          )}
        </View>

        {/* Próximas Escalas */}
        <View className="gap-4">
          <View className="flex-row items-center gap-2">
            <Calendar size={20} color="#FFFFFF" />
            <Text className="text-2xl font-bold text-white">Próximas Escalas</Text>
          </View>
          {loadingShifts ? (
            <TintedGlassCard>
              <View className="items-center py-4">
                <ActivityIndicator size="small" color="#3B82F6" />
              </View>
            </TintedGlassCard>
          ) : upcomingShifts && upcomingShifts.length > 0 ? (
            <View className="gap-3">
              {upcomingShifts.slice(0, 5).map((item) => {
                if (!item.shift) return null;
                const shift = item.shift;
                const sector = item.sector;
                const startDate = new Date(shift.startTime);
                const endDate = new Date(shift.endTime);

                return (
                  <TintedGlassCard key={shift.id}>
                    <View className="flex-row justify-between items-start mb-2">
                      <View className="flex-1">
                        <Text className="text-lg font-semibold text-white">
                          {sector?.name || "Setor não definido"}
                        </Text>
                        <Text className="text-base text-white/70 mt-1">
                          {formatDateBR(startDate)}
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
                    <Text className="text-base text-white/70">
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
            </View>
          ) : (
            <TintedGlassCard>
              <View className="items-center py-8">
                <Calendar size={48} color="rgba(255,255,255,0.3)" />
                <Text className="text-lg text-white/50 mt-4">Nenhuma escala programada</Text>
              </View>
            </TintedGlassCard>
          )}
        </View>

        {/* Espaçamento inferior */}
        <View className="h-8" />
      </View>
    </ScreenGradient>
  );
}

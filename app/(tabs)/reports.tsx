import { View, Text, ScrollView, ActivityIndicator } from "react-native";
import { ScreenGradient } from "@/components/ui/ScreenGradient";
import { TintedGlassCard } from "@/components/ui/TintedGlassCard";
import { useAuth } from "@/hooks/use-auth";
import { FileText, BarChart3, Calendar, Users } from "lucide-react-native";

/**
 * Tela de Relatórios
 * 
 * Placeholder profissional para futura implementação de:
 * - Relatórios de escalas por período
 * - Estatísticas de alocação por setor
 * - Exportação de dados (PDF/Excel)
 * - Análise de cobertura e gaps
 */
export default function ReportsScreen() {
  const { user, isLoading: authLoading } = useAuth();

  if (authLoading) {
    return (
      <ScreenGradient>
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator size="large" color="#fff" />
        </View>
      </ScreenGradient>
    );
  }

  if (!user) {
    return (
      <ScreenGradient>
        <View className="flex-1 items-center justify-center px-5">
          <Text className="text-lg text-center" style={{ color: "#0F172A" }}>
            Faça login para acessar os relatórios
          </Text>
        </View>
      </ScreenGradient>
    );
  }

  return (
    <ScreenGradient>
      <ScrollView className="flex-1" contentContainerStyle={{ paddingHorizontal: 20, paddingVertical: 24 }}>
        {/* Header */}
        <View className="mb-6">
          <Text className="text-3xl font-bold" style={{ color: "#0F172A" }}>Relatórios</Text>
          <Text className="text-base mt-1" style={{ color: "#475569" }}>
            Análises e estatísticas de escalas
          </Text>
        </View>

        {/* Placeholder Cards */}
        <View className="gap-4">
          {/* Card 1: Relatório de Escalas */}
          <TintedGlassCard className="p-5">
            <View className="flex-row items-center mb-3">
              <View className="w-12 h-12 rounded-full bg-blue-500/20 items-center justify-center mr-3">
                <FileText size={24} color="#3B82F6" />
              </View>
              <View className="flex-1">
                <Text className="text-lg font-semibold" style={{ color: "#0F172A" }}>Relatório de Escalas</Text>
                <Text className="text-sm" style={{ color: "#475569" }}>Por período e setor</Text>
              </View>
            </View>
            <Text className="text-base leading-relaxed" style={{ color: "#475569" }}>
              Visualize e exporte relatórios detalhados de escalas por período, incluindo alocações, 
              pendências e estatísticas de cobertura.
            </Text>
          </TintedGlassCard>

          {/* Card 2: Estatísticas de Alocação */}
          <TintedGlassCard className="p-5">
            <View className="flex-row items-center mb-3">
              <View className="w-12 h-12 rounded-full bg-green-500/20 items-center justify-center mr-3">
                <BarChart3 size={24} color="#10B981" />
              </View>
              <View className="flex-1">
                <Text className="text-lg font-semibold" style={{ color: "#0F172A" }}>Estatísticas de Alocação</Text>
                <Text className="text-sm" style={{ color: "#475569" }}>Análise por setor e profissional</Text>
              </View>
            </View>
            <Text className="text-base leading-relaxed" style={{ color: "#475569" }}>
              Analise a distribuição de turnos por setor, profissional e tipo de alocação 
              (Plantão, Retaguarda, Sobreaviso).
            </Text>
          </TintedGlassCard>

          {/* Card 3: Análise de Cobertura */}
          <TintedGlassCard className="p-5">
            <View className="flex-row items-center mb-3">
              <View className="w-12 h-12 rounded-full bg-yellow-500/20 items-center justify-center mr-3">
                <Calendar size={24} color="#F59E0B" />
              </View>
              <View className="flex-1">
                <Text className="text-lg font-semibold" style={{ color: "#0F172A" }}>Análise de Cobertura</Text>
                <Text className="text-sm" style={{ color: "#475569" }}>Gaps e vagas por período</Text>
              </View>
            </View>
            <Text className="text-base leading-relaxed" style={{ color: "#475569" }}>
              Identifique gaps de cobertura, vagas não preenchidas e períodos com baixa alocação 
              para planejamento estratégico.
            </Text>
          </TintedGlassCard>

          {/* Card 4: Relatório de Profissionais */}
          <TintedGlassCard className="p-5">
            <View className="flex-row items-center mb-3">
              <View className="w-12 h-12 rounded-full bg-purple-500/20 items-center justify-center mr-3">
                <Users size={24} color="#A855F7" />
              </View>
              <View className="flex-1">
                <Text className="text-lg font-semibold" style={{ color: "#0F172A" }}>Relatório de Profissionais</Text>
                <Text className="text-sm" style={{ color: "#475569" }}>Horas e turnos por profissional</Text>
              </View>
            </View>
            <Text className="text-base leading-relaxed" style={{ color: "#475569" }}>
              Visualize total de horas trabalhadas, distribuição de turnos e histórico de alocações 
              por profissional.
            </Text>
          </TintedGlassCard>

          {/* Nota de Desenvolvimento */}
          <TintedGlassCard className="p-5 border border-white/10">
            <Text className="text-sm text-center leading-relaxed" style={{ color: "#475569" }}>
              <Text className="font-semibold" style={{ color: "#475569" }}>Em desenvolvimento:</Text> Esta tela será expandida com 
              funcionalidades completas de relatórios, filtros avançados e exportação em múltiplos formatos.
            </Text>
          </TintedGlassCard>
        </View>
      </ScrollView>
    </ScreenGradient>
  );
}

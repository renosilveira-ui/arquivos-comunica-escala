import { useState, useEffect } from "react";
import { Text, View, TouchableOpacity, ScrollView, TextInput, Alert } from "react-native";
import { ScreenGradient } from "@/components/ui/ScreenGradient";
import { TintedGlassCard } from "@/components/ui/TintedGlassCard";
import { Badge } from "@/components/ui/Badge";
import { useAuth } from "@/hooks/use-auth";
import { trpc } from "@/lib/trpc";
import { useRouter, useLocalSearchParams } from "expo-router";
import * as Haptics from "expo-haptics";
import { ChevronLeft, RefreshCw, Users, Send } from "lucide-react-native";
import { isDemoMode, DEMO_SHIFTS, getSelectedService, DEMO_SERVICES } from "@/lib/demo-mode";
import { notifyShiftChange } from "@/lib/notifications";
import { formatDateBR, formatTimeBR } from "@/lib/datetime";

/**
 * Tela de Solicitação de Troca de Plantão
 * Permite profissionais solicitarem troca com colegas do mesmo serviço
 */
export default function RequestSwapScreen() {
  const { user } = useAuth();
  const router = useRouter();
  const params = useLocalSearchParams();
  const shiftId = Number(params.id);
  const [isDemo, setIsDemo] = useState(false);
  const [selectedService, setSelectedService] = useState<number | null>(null);
  const [selectedColleague, setSelectedColleague] = useState<number | null>(null);
  const [reason, setReason] = useState("");

  // Verificar modo demo e serviço selecionado
  useEffect(() => {
    async function init() {
      const demo = await isDemoMode();
      setIsDemo(demo);
      const service = await getSelectedService();
      setSelectedService(service);
    }
    init();
  }, []);

  // Buscar escala
  const { data: shiftData } = trpc.shifts.get.useQuery(
    { id: shiftId },
    { enabled: !isDemo }
  );

  const demoShift = isDemo ? DEMO_SHIFTS.find(s => s.shift.id === shiftId) : null;
  const shift = isDemo ? demoShift?.shift : shiftData?.shift;

  // Buscar colegas do mesmo serviço (simulado em demo)
  const colleagues = isDemo
    ? [
        { id: 2, name: "Dr. Carlos Silva", specialty: "Anestesia" },
        { id: 3, name: "Dra. Ana Costa", specialty: "Anestesia" },
        { id: 4, name: "Dr. Pedro Santos", specialty: "Anestesia" },
      ]
    : [];

  // Mutation para solicitar troca (comentado até API estar disponível)
  // const requestSwap = trpc.shifts.requestSwap.useMutation({
  //   onSuccess: () => {
  //     Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  //     Alert.alert(
  //       "Solicitação Enviada",
  //       "Seu colega receberá uma notificação para aprovar a troca.",
  //       [{ text: "OK", onPress: () => router.back() }]
  //     );
  //   },
  //   onError: (error: any) => {
  //     Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
  //     Alert.alert("Erro", error.message);
  //   },
  // });

  const handleRequestSwap = () => {
    if (!shift) return;

    if (!selectedColleague) {
      Alert.alert("Atenção", "Selecione um colega para trocar o plantão.");
      return;
    }

    if (!reason.trim()) {
      Alert.alert("Atenção", "Informe o motivo da troca.");
      return;
    }

    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

    // Simular envio (API não disponível ainda)
    const oldDate = new Date(shift.startTime);
    const newDate = new Date(shift.startTime);
    notifyShiftChange("Solicitação de Troca", oldDate, newDate);
    Alert.alert(
      "Solicitação Enviada",
      "Seu colega receberá uma notificação para aprovar a troca.",
      [{ text: "OK", onPress: () => router.back() }]
    );
  };

  if (!shift) {
    return (
      <ScreenGradient scrollable={false}>
        <View className="flex-1 justify-center items-center">
          <Text className="text-lg text-white/70">Carregando...</Text>
        </View>
      </ScreenGradient>
    );
  }

  return (
    <ScreenGradient scrollable>
      <View className="gap-6">
        {/* Header */}
        <View>
          <TouchableOpacity
            onPress={() => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              router.back();
            }}
            className="flex-row items-center gap-2 mb-4"
          >
            <ChevronLeft size={24} color="#FFFFFF" />
            <Text className="text-lg text-white">Voltar</Text>
          </TouchableOpacity>

          <View className="flex-row items-center gap-3 mb-2">
            <RefreshCw size={28} color="#4DA3FF" />
            <Text className="text-3xl font-bold text-white">Solicitar Troca</Text>
          </View>
          <Text className="text-lg text-white/70">
            Encontre um colega para trocar o plantão
          </Text>
        </View>

        {/* Informações da Escala */}
        <TintedGlassCard>
          <Text className="text-lg font-semibold text-white mb-3">Plantão a ser trocado</Text>
          <View className="gap-2">
            <Text className="text-base text-white/70">
              Data: {formatDateBR(shift.startTime)}
            </Text>
            <Text className="text-base text-white/70">
              Horário: {formatTimeBR(shift.startTime)} - {formatTimeBR(shift.endTime)}
            </Text>
          </View>
        </TintedGlassCard>

        {/* Selecionar Colega */}
        <View>
          <View className="flex-row items-center gap-2 mb-4">
            <Users size={20} color="#FFFFFF" />
            <Text className="text-2xl font-bold text-white">Selecionar Colega</Text>
          </View>
          <View className="gap-3">
            {colleagues.map((colleague) => (
              <TouchableOpacity
                key={colleague.id}
                onPress={() => {
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  setSelectedColleague(colleague.id);
                }}
                activeOpacity={0.7}
              >
                <TintedGlassCard
                  style={{
                    borderWidth: 2,
                    borderColor: selectedColleague === colleague.id ? "#4DA3FF" : "transparent",
                  }}
                >
                  <View className="flex-row items-center justify-between">
                    <View>
                      <Text className="text-lg font-semibold text-white">{colleague.name}</Text>
                      <Text className="text-base text-white/70 mt-1">{colleague.specialty}</Text>
                    </View>
                    {selectedColleague === colleague.id && (
                      <Badge variant="neutral">Selecionado</Badge>
                    )}
                  </View>
                </TintedGlassCard>
              </TouchableOpacity>
            ))}
          </View>
        </View>

        {/* Motivo da Troca */}
        <View>
          <Text className="text-2xl font-bold text-white mb-4">Motivo da Troca</Text>
          <TintedGlassCard>
            <TextInput
              placeholder="Ex: Compromisso familiar, viagem, etc."
              placeholderTextColor="rgba(255,255,255,0.5)"
              value={reason}
              onChangeText={setReason}
              multiline
              numberOfLines={4}
              style={{
                fontSize: 16,
                color: "#FFFFFF",
                minHeight: 100,
                textAlignVertical: "top",
              }}
            />
          </TintedGlassCard>
        </View>

        {/* Botão Enviar Solicitação */}
        <TouchableOpacity
          onPress={handleRequestSwap}
          className="rounded-2xl h-16 items-center justify-center"
          style={{
            backgroundColor: "#4DA3FF",
          }}
          activeOpacity={0.8}
        >
          <View className="flex-row items-center gap-3">
            <Send size={24} color="#FFFFFF" />
            <Text className="text-xl font-bold text-white">Enviar Solicitação</Text>
          </View>
        </TouchableOpacity>
      </View>
    </ScreenGradient>
  );
}

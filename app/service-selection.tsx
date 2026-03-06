import { ScrollView, Text, TouchableOpacity, View } from "react-native";
import { useRouter } from "expo-router";
import { useState } from "react";
import { 
  Syringe, 
  Stethoscope, 
  HeartPulse, 
  Baby, 
  Bone, 
  Heart, 
  Briefcase,
  Scissors
} from "lucide-react-native";

import { ScreenGradient } from "@/components/ui/ScreenGradient";
import { TintedGlassCard } from "@/components/ui/TintedGlassCard";
import { DEMO_SERVICES, setSelectedService } from "@/lib/demo-mode";
import * as Haptics from "expo-haptics";

const iconMap: Record<string, any> = {
  syringe: Syringe,
  scalpel: Scissors,
  "heart-pulse": HeartPulse,
  stethoscope: Stethoscope,
  baby: Baby,
  bone: Bone,
  heart: Heart,
  briefcase: Briefcase,
};

/**
 * Tela de Seleção de Serviço/Especialidade
 * 
 * Primeira tela após login ou modo demo
 * Permite selecionar o serviço para filtrar escalas
 */
export default function ServiceSelectionScreen() {
  const router = useRouter();
  const [selectedId, setSelectedId] = useState<number | null>(null);

  const handleSelectService = async (serviceId: number) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setSelectedId(serviceId);
    
    // Salvar serviço selecionado
    await setSelectedService(serviceId);
    
    // Navegar para a tela principal
    setTimeout(() => {
      router.replace("/(tabs)");
    }, 300);
  };

  return (
    <ScreenGradient>
      <ScrollView contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 60, paddingBottom: 100 }}>
        {/* Header */}
        <View style={{ marginBottom: 32, alignItems: "center" }}>
          <Text style={{ fontSize: 32, fontWeight: "700", color: "#FFFFFF", textAlign: "center", marginBottom: 12 }}>
            Selecione seu Serviço
          </Text>
          <Text style={{ fontSize: 16, color: "rgba(255,255,255,0.7)", textAlign: "center", lineHeight: 24 }}>
            Você verá apenas as escalas do serviço selecionado
          </Text>
        </View>

        {/* Grid de Serviços */}
        <View style={{ gap: 16 }}>
          {DEMO_SERVICES.map((service) => {
            const Icon = iconMap[service.icon] || Stethoscope;
            const isSelected = selectedId === service.id;
            const isGestao = service.id === 8;

            return (
              <TouchableOpacity
                key={service.id}
                onPress={() => handleSelectService(service.id)}
                activeOpacity={0.7}
              >
                <TintedGlassCard
                  style={{
                    borderWidth: isSelected ? 2 : 1,
                    borderColor: isSelected ? "#4DA3FF" : "rgba(255,255,255,0.12)",
                    backgroundColor: isSelected ? "rgba(77,163,255,0.15)" : "rgba(255,255,255,0.08)",
                  }}
                >
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 16 }}>
                    <View
                      style={{
                        width: 56,
                        height: 56,
                        borderRadius: 28,
                        backgroundColor: isSelected ? "#4DA3FF" : "rgba(77,163,255,0.2)",
                        alignItems: "center",
                        justifyContent: "center",
                      }}
                    >
                      <Icon size={28} color="#FFFFFF" />
                    </View>
                    
                    <View style={{ flex: 1 }}>
                      <Text style={{ fontSize: 20, fontWeight: "600", color: "#FFFFFF", marginBottom: 4 }}>
                        {service.name}
                      </Text>
                      {isGestao && (
                        <Text style={{ fontSize: 14, color: "rgba(255,255,255,0.6)" }}>
                          Visibilidade de todos os setores
                        </Text>
                      )}
                    </View>

                    {isSelected && (
                      <View
                        style={{
                          width: 24,
                          height: 24,
                          borderRadius: 12,
                          backgroundColor: "#4DA3FF",
                          alignItems: "center",
                          justifyContent: "center",
                        }}
                      >
                        <Text style={{ fontSize: 16, color: "#FFFFFF", fontWeight: "700" }}>✓</Text>
                      </View>
                    )}
                  </View>
                </TintedGlassCard>
              </TouchableOpacity>
            );
          })}
        </View>

        {/* Nota */}
        <View style={{ marginTop: 32, paddingHorizontal: 16 }}>
          <Text style={{ fontSize: 14, color: "rgba(255,255,255,0.5)", textAlign: "center", lineHeight: 20 }}>
            Você poderá trocar de serviço a qualquer momento nas configurações do perfil
          </Text>
        </View>
      </ScrollView>
    </ScreenGradient>
  );
}

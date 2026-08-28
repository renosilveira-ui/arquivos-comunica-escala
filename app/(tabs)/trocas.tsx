// app/(tabs)/trocas.tsx — aba "Trocas" do médico.
//
// Antes, a única porta para aceitar uma troca era tocar numa oferta no
// Panorama (a aba Solicitações é escondida para não-gestores) e "Minhas
// ofertas" ficava enterrada no Perfil. Aqui tudo junto: oferecer um
// plantão, responder às ofertas dos colegas e acompanhar as minhas.

import { Platform, ScrollView, Text, TouchableOpacity, View, useWindowDimensions } from "react-native";
import { useRouter } from "expo-router";
import * as Haptics from "expo-haptics";
import { ArrowRightLeft, ChevronRight, Inbox, Send } from "lucide-react-native";
import { ScreenGradient } from "@/components/ui/ScreenGradient";
import { ScreenContainer } from "@/components/ui/ScreenContainer";
import { AppButton } from "@/components/ui/AppButton";
import { AvailableSwapsList } from "@/components/swaps/AvailableSwapsList";
import { theme } from "@/lib/theme";

const MOBILE_BREAKPOINT = 768;

export default function TrocasScreen() {
  const router = useRouter();
  const { width } = useWindowDimensions();
  const isDesktop = Platform.OS === "web" && width >= MOBILE_BREAKPOINT;

  const go = (path: string) => {
    if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    router.push(path as any);
  };

  return (
    <ScreenGradient variant="light">
      <ScreenContainer flex={!isDesktop} scrollPage={isDesktop}>
        <ScrollView
          contentContainerStyle={{ gap: theme.space[6], paddingBottom: theme.space[20] }}
          showsVerticalScrollIndicator={false}
        >
          <View style={{ gap: theme.space[2] }}>
            <Text style={{ ...theme.text.display, fontWeight: theme.weight.bold, color: theme.colors.textPrimary }}>
              Trocas
            </Text>
            <Text style={{ ...theme.text.body, color: theme.colors.textSecondary }}>
              Ofereça um plantão seu, responda às ofertas dos colegas e acompanhe o que está pendente.
            </Text>
          </View>

          <AppButton title="Oferecer um plantão" onPress={() => go("/request-swap")} size="lg" />

          <AvailableSwapsList showEmpty />

          <View style={{ gap: theme.space[3] }}>
            <Text style={{ ...theme.text.title, fontWeight: theme.weight.bold, color: theme.colors.textPrimary }}>
              Minhas
            </Text>
            <LinkCard
              icon={<Send size={20} color={theme.colors.primary} />}
              title="Minhas ofertas"
              subtitle="Plantões que você ofereceu — quem assumir leva na hora"
              onPress={() => go("/my-offers")}
            />
            <LinkCard
              icon={<Inbox size={20} color={theme.colors.primary} />}
              title="Minhas candidaturas"
              subtitle="Ofertas e vagas que você assumiu ou pediu"
              onPress={() => go("/my-applications")}
            />
            <LinkCard
              icon={<ArrowRightLeft size={20} color={theme.colors.primary} />}
              title="Plantões em aberto"
              subtitle="Vagas sem profissional que você pode assumir"
              onPress={() => go("/(tabs)/vacancies")}
            />
          </View>
        </ScrollView>
      </ScreenContainer>
    </ScreenGradient>
  );
}

function LinkCard({
  icon,
  title,
  subtitle,
  onPress,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.75}
      accessibilityRole="button"
      accessibilityLabel={title}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: theme.space[3],
        minHeight: theme.space[14],
        padding: theme.space[4],
        borderRadius: theme.radius.lg,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface,
      }}
    >
      <View
        style={{
          width: theme.space[10],
          height: theme.space[10],
          borderRadius: theme.radius.full,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: theme.colors.primarySoft,
        }}
      >
        {icon}
      </View>
      <View style={{ flex: 1 }}>
        <Text style={{ ...theme.text.bodyLg, fontWeight: theme.weight.semibold, color: theme.colors.textPrimary }}>
          {title}
        </Text>
        <Text style={{ ...theme.text.caption, color: theme.colors.textMuted }}>{subtitle}</Text>
      </View>
      <ChevronRight size={20} color={theme.colors.textMuted} />
    </TouchableOpacity>
  );
}

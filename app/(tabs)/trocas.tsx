// app/(tabs)/trocas.tsx — central operacional do médico.
//
// As três filas pertencem ao mesmo fluxo: o que espera resposta do usuário,
// o que ele ofereceu e o que ele pediu. Mantê-las em segmentos evita rotas
// duplicadas no Perfil. As filas secundárias só são montadas após a primeira
// visita e permanecem prontas para a próxima alternância.

import { useCallback, useState } from "react";
import {
  Platform,
  Pressable,
  ScrollView,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import { useRouter } from "expo-router";
import * as Haptics from "expo-haptics";
import { Info } from "lucide-react-native";

import MyApplicationsScreen from "@/app/my-applications";
import MyOffersScreen from "@/app/my-offers";
import { AvailableSwapsList } from "@/components/swaps/AvailableSwapsList";
import { AppButton } from "@/components/ui/AppButton";
import { ScreenContainer } from "@/components/ui/ScreenContainer";
import { ScreenGradient } from "@/components/ui/ScreenGradient";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { Surface } from "@/components/ui/Surface";
import { useNativeOperationalQueryRecovery } from "@/hooks/use-native-operational-query-recovery";
import { useOperationalQueryRefresh } from "@/hooks/use-operational-query-refresh";
import { theme } from "@/lib/theme";

const MOBILE_BREAKPOINT = 768;

type SwapSegment = "available" | "offers" | "applications";

const SEGMENTS: { key: SwapSegment; label: string }[] = [
  { key: "available", label: "Disponíveis" },
  { key: "offers", label: "Ofertas" },
  { key: "applications", label: "Candidaturas" },
];

export default function TrocasScreen() {
  const router = useRouter();
  const { width } = useWindowDimensions();
  const isDesktop = Platform.OS === "web" && width >= MOBILE_BREAKPOINT;
  const [segment, setSegment] = useState<SwapSegment>("available");
  const [counts, setCounts] = useState<Partial<Record<SwapSegment, number>>>({});
  const [visited, setVisited] = useState<Partial<Record<SwapSegment, boolean>>>({
    available: true,
  });
  const { captureLease, refreshSwapQueries } = useOperationalQueryRefresh();

  useNativeOperationalQueryRecovery({
    captureLease,
    refresh: refreshSwapQueries,
  });

  const selectSegment = useCallback((next: SwapSegment) => {
    if (Platform.OS !== "web") void Haptics.selectionAsync();
    setVisited((current) =>
      current[next] ? current : { ...current, [next]: true },
    );
    setSegment(next);
  }, []);

  const setSegmentCount = useCallback((key: SwapSegment, count: number) => {
    setCounts((current) =>
      current[key] === count ? current : { ...current, [key]: count },
    );
  }, []);
  const publishAvailableCount = useCallback(
    (count: number) => setSegmentCount("available", count),
    [setSegmentCount],
  );
  const publishOfferCount = useCallback(
    (count: number) => setSegmentCount("offers", count),
    [setSegmentCount],
  );
  const publishApplicationCount = useCallback(
    (count: number) => setSegmentCount("applications", count),
    [setSegmentCount],
  );

  const offerShift = () => {
    if (Platform.OS !== "web") {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
    router.push("/request-swap" as never);
  };

  const content = (
    <>
      <SectionHeader
        size="page"
        eyebrow="Central operacional"
        title="Trocas"
        subtitle="Responda ao que espera você e acompanhe cada etapa sem sair desta tela."
      />

      <AppButton
        title="Oferecer meu plantão"
        onPress={offerShift}
        variant="brand"
        size="lg"
      />

      <View
        accessibilityRole="tablist"
        style={{
          flexDirection: "row",
          padding: 2,
          borderRadius: theme.radius.lg,
          borderWidth: 1,
          borderColor: theme.colors.borderStrong,
          backgroundColor: theme.colors.surfaceAlt,
        }}
      >
        {SEGMENTS.map((item) => {
          const selected = item.key === segment;
          const count = counts[item.key];
          return (
            <Pressable
              key={item.key}
              onPress={() => selectSegment(item.key)}
              accessibilityRole="tab"
              accessibilityState={{ selected }}
              accessibilityLabel={`${item.label}${count ? `, ${count} pendência${count === 1 ? "" : "s"}` : ""}`}
              style={({ pressed }) => ({
                flex: 1,
                minHeight: theme.space[10],
                paddingHorizontal: theme.space[1],
                borderRadius: theme.radius.md,
                backgroundColor: selected ? theme.colors.surface : "transparent",
                borderWidth: selected ? 1 : 0,
                borderColor: theme.colors.borderStrong,
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "center",
                gap: theme.space[1],
                opacity: pressed ? 0.8 : 1,
                ...(selected ? theme.shadow.sm : {}),
              })}
            >
              <Text
                numberOfLines={1}
                style={{
                  ...theme.text.caption,
                  fontWeight: selected ? theme.weight.bold : theme.weight.medium,
                  color: selected ? theme.colors.brand : theme.colors.textSecondary,
                }}
              >
                {item.label}
              </Text>
              {count ? (
                <View
                  accessibilityElementsHidden
                  importantForAccessibility="no-hide-descendants"
                  style={{
                    minWidth: 18,
                    height: 18,
                    paddingHorizontal: theme.space[1],
                    borderRadius: theme.radius.full,
                    backgroundColor:
                      item.key === "available"
                        ? theme.colors.danger
                        : theme.colors.brand,
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <Text
                    style={{
                      ...theme.text.caption,
                      fontSize: 10,
                      lineHeight: 12,
                      fontFamily: theme.fontFamily.mono,
                      fontWeight: theme.weight.bold,
                      color: theme.colors.onDark.text,
                    }}
                  >
                    {count > 99 ? "99+" : count}
                  </Text>
                </View>
              ) : null}
            </Pressable>
          );
        })}
      </View>

      <View style={{ display: segment === "available" ? "flex" : "none" }}>
        <View style={{ gap: theme.space[4] }}>
          <AvailableSwapsList
            showEmpty
            showHeader={false}
            onCountChange={publishAvailableCount}
          />
          <Surface padded="compact" level="card">
            <View style={{ flexDirection: "row", gap: theme.space[2] }}>
              <Info size={17} color={theme.colors.textSecondary} />
              <Text style={{ ...theme.text.caption, color: theme.colors.textSecondary, flex: 1 }}>
                Ao aceitar, o pedido passa para Candidaturas até a conclusão prevista pelo fluxo da oferta.
              </Text>
            </View>
          </Surface>
        </View>
      </View>

      {visited.offers ? (
        <View style={{ display: segment === "offers" ? "flex" : "none" }}>
          <MyOffersScreen
            embedded
            onCountChange={publishOfferCount}
          />
        </View>
      ) : null}

      {visited.applications ? (
        <View style={{ display: segment === "applications" ? "flex" : "none" }}>
          <MyApplicationsScreen
            embedded
            onCountChange={publishApplicationCount}
            onExploreAvailable={() => selectSegment("available")}
          />
        </View>
      ) : null}
    </>
  );

  return (
    <ScreenGradient variant="light">
      <ScreenContainer flex={!isDesktop} scrollPage={isDesktop}>
        {isDesktop ? (
          <View style={{ gap: theme.space[5], paddingBottom: theme.space[20] }}>
            {content}
          </View>
        ) : (
          <ScrollView
            contentContainerStyle={{ gap: theme.space[5], paddingBottom: theme.space[20] }}
            showsVerticalScrollIndicator={false}
          >
            {content}
          </ScrollView>
        )}
      </ScreenContainer>
    </ScreenGradient>
  );
}

import { useMemo } from "react";
import { Linking, TouchableOpacity, View } from "react-native";
import { Text } from "@/components/ui/Text";

import { useAuth } from "@/hooks/use-auth";
import { buildWeatherGreeting } from "@/lib/weather-greeting";
import { theme } from "@/lib/theme";
import { trpc } from "@/lib/trpc";

/**
 * Saudação do topo do app, com o clima de onde o médico está.
 *
 * ## A regra que manda no desenho
 *
 * **A saudação nunca depende do clima.** Sem WeatherKit configurado, sem
 * endereço cadastrado, sem internet — o médico ainda é cumprimentado pelo
 * nome. Um cabeçalho que some quando um provedor externo cai vira um buraco
 * na tela, e buraco na tela parece defeito do app.
 *
 * Por isso não há `isLoading` aqui: a saudação aparece no primeiro frame, e a
 * linha do clima entra depois se existir. Esqueleto de carregamento para uma
 * linha de ornamento custaria mais atenção do que a informação vale.
 *
 * ## Atribuição
 *
 * A licença da Apple exige que a tela que mostra o dado exiba a marca
 * "Apple Weather" e o link para a página legal — por isso ela não sai. O que
 * o PO pediu (12/09/2026) foi que a fonte não dividisse a linha com a
 * saudação: a atribuição fica numa linha própria, miúda e sem sublinhado,
 * ainda tocável (abre a página legal) e ainda anunciada como link ao leitor
 * de tela. Ela vem do provedor, não é fixa no código, e só aparece quando há
 * dado de verdade — atribuir o que não foi exibido seria ruído.
 */
export function WeatherGreeting() {
  const { user } = useAuth();

  const conditions = trpc.weather.localConditions.useQuery(undefined, {
    // O clima de um bairro não muda a cada troca de aba. O servidor ainda tem
    // cache próprio; este evita até a ida.
    staleTime: 15 * 60 * 1000,
    refetchOnWindowFocus: false,
    // Ornamento não faz retry: falhou, a saudação vai sozinha.
    retry: false,
  });

  const view = useMemo(() => {
    const data = conditions.data;
    return buildWeatherGreeting({
      hour: new Date().getHours(),
      name: user?.name,
      condition: data?.available ? data.condition : null,
      temperatureCelsius: data?.available ? data.temperatureCelsius : null,
    });
  }, [conditions.data, user?.name]);

  const attribution =
    conditions.data?.available && view.weather
      ? conditions.data.attribution
      : null;

  return (
    <View style={{ gap: 2, marginBottom: theme.space[3] }}>
      <Text
        accessibilityRole="header"
        style={{
          fontSize: theme.text.titleLg.fontSize,
          fontWeight: "700",
          color: theme.colors.textPrimary,
        }}
      >
        {view.greeting}
      </Text>

      {view.weather ? (
        <Text
          style={{
            fontSize: theme.text.body.fontSize,
            color: theme.colors.textSecondary,
          }}
        >
          {view.weather}
        </Text>
      ) : null}

      {attribution ? (
        <TouchableOpacity
          onPress={() => {
            void Linking.openURL(attribution.legalPageUrl);
          }}
          accessibilityRole="link"
          accessibilityLabel={`Fonte do clima: ${attribution.providerName}. Abre a página de atribuição legal.`}
          // Alvo de toque de 44 pt sem inflar a linha: a legenda tem 16 pt
          // de altura e o hitSlop completa o restante.
          hitSlop={{ top: 14, bottom: 14, left: 8, right: 8 }}
          style={{ alignSelf: "flex-start" }}
        >
          <Text
            style={{
              fontSize: theme.text.caption.fontSize,
              lineHeight: theme.text.caption.lineHeight,
              color: theme.colors.textMuted,
            }}
          >
            {attribution.providerName}
          </Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

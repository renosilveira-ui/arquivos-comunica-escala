import { useCallback, useMemo, useRef, useState } from "react";
import { Text, TextInput, TouchableOpacity, View } from "react-native";
import { BellRing, MapPin, Trash2 } from "lucide-react-native";

import { AppButton } from "@/components/ui/AppButton";
import { ListRow } from "@/components/ui/ListRow";
import { QueryErrorState } from "@/components/ui/QueryErrorState";
import { ScreenContainer } from "@/components/ui/ScreenContainer";
import { ScreenGradient } from "@/components/ui/ScreenGradient";
import { SkeletonList } from "@/components/ui/Skeleton";
import { useActionFeedback } from "@/hooks/use-action-feedback";
import { useLocationOrigin } from "@/hooks/use-location-origin";
import { AUTOMATIC_ORIGIN_LABEL } from "@/lib/integration-providers";
import { LOCATION_ACCESS } from "@/lib/location-origin";
import { theme } from "@/lib/theme";
import { trpc } from "@/lib/trpc";

/**
 * Aviso de aproximação de plantão.
 *
 * Recurso da CONTA: não lê instituição nem papel. O médico sai de casa uma
 * vez, e o destino pode ser qualquer hospital dos vínculos dele.
 *
 * A tela tem UMA decisão obrigatória — ligar ou não. O endereço é opcional e
 * só serve para o aviso saber o trânsito; sem ele o aviso sai igual, dizendo
 * que não sabe. Perguntar folga de chegada ou tempo de trajeto transferiria
 * para o médico uma conta que o sistema tem os dados para fazer.
 *
 * A copy é explícita sobre privacidade porque o endereço é o dado mais
 * sensível que o sistema toca: guardado cifrado, nunca em lista, apagável.
 * Dizer isso na tela é o que permite consentir de verdade.
 */

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <View style={{ gap: theme.space[2] }}>
      <Text
        style={{
          fontSize: theme.text.titleSm.fontSize,
          fontWeight: "600",
          color: theme.colors.textPrimary,
        }}
      >
        {title}
      </Text>
      {description ? (
        <Text
          style={{
            fontSize: theme.text.body.fontSize,
            lineHeight: theme.text.body.lineHeight,
            color: theme.colors.textSecondary,
          }}
        >
          {description}
        </Text>
      ) : null}
      {children}
    </View>
  );
}

export default function DepartureAlertsScreen() {
  const feedback = useActionFeedback();
  const utils = trpc.useUtils();
  const statusQuery = trpc.departure.status.useQuery(undefined, {
    staleTime: 15_000,
  });

  /**
   * A próxima gravação de preferências veio do interruptor?
   *
   * Escolher um endereço grava as mesmas preferências, e anunciar "aviso
   * ligado" ali seria confirmar algo que o médico não fez.
   */
  const fromToggle = useRef(false);
  const [search, setSearch] = useState("");
  const [pendingPlaceId, setPendingPlaceId] = useState<string | null>(null);
  const [originLabel, setOriginLabel] = useState("Casa");

  const sessionQuery = trpc.departure.newSearchSession.useQuery(undefined, {
    // Um token por abertura de tela: agrupa as teclas numa cobrança só.
    staleTime: Infinity,
    enabled: statusQuery.data?.mapsAvailable === true,
  });

  const suggestionsQuery = trpc.departure.searchPlaces.useQuery(
    {
      query: search.trim(),
      sessionToken: sessionQuery.data?.sessionToken ?? "",
    },
    {
      enabled:
        statusQuery.data?.mapsAvailable === true &&
        Boolean(sessionQuery.data?.sessionToken) &&
        search.trim().length >= 3,
      staleTime: 30_000,
    },
  );

  const savePreferences = trpc.departure.savePreferences.useMutation({
    onSuccess: async (_result, variables) => {
      await utils.departure.status.invalidate();
      if (fromToggle.current) {
        fromToggle.current = false;
        feedback.success(
          variables.enabled ? "Aviso ligado." : "Aviso desligado.",
        );
      }
    },
    onError: (error) => {
      fromToggle.current = false;
      feedback.error(error.message);
    },
  });

  const saveOrigin = trpc.departure.saveTravelOrigin.useMutation({
    onSuccess: async () => {
      await utils.departure.status.invalidate();
      setSearch("");
      setPendingPlaceId(null);
      feedback.success("Endereço salvo.");
    },
    onError: (error) => feedback.error(error.message),
  });

  const deleteOrigin = trpc.departure.deleteTravelOrigin.useMutation({
    onSuccess: async () => {
      await utils.departure.status.invalidate();
      feedback.success("Endereço apagado.");
    },
    onError: (error) => feedback.error(error.message),
  });

  const status = statusQuery.data;

  // Desligar a localização apaga a origem automática no servidor: não faz
  // sentido guardar onde a pessoa estava depois que ela pediu para parar.
  const location = useLocationOrigin({
    onDisabled: async () => {
      const automatic = statusQuery.data?.origins.find(
        (origin) => origin.label === AUTOMATIC_ORIGIN_LABEL,
      );
      if (automatic) {
        await deleteOrigin.mutateAsync({ originId: automatic.id });
      }
    },
  });
  /**
   * Estado exibido do interruptor.
   *
   * Enquanto a mutação está no ar, vale o que o médico acabou de escolher —
   * não o que o servidor ainda devolve. Um interruptor que só se move depois
   * do round-trip parece quebrado num 3G de corredor de hospital.
   */
  const enabled =
    savePreferences.isPending && savePreferences.variables
      ? savePreferences.variables.enabled
      : (status?.enabled ?? false);
  const busy =
    savePreferences.isPending || saveOrigin.isPending || deleteOrigin.isPending;

  const toggle = useCallback(
    (next: boolean) => {
      if (!status) return;
      fromToggle.current = true;
      savePreferences.mutate({
        enabled: next,
        travelOriginId: status.travelOriginId,
      });
    },
    [status, savePreferences],
  );

  const chooseOrigin = useCallback(
    (originId: number) => {
      if (!status) return;
      fromToggle.current = false;
      savePreferences.mutate({
        enabled: status.enabled,
        travelOriginId: originId,
      });
    },
    [status, savePreferences],
  );

  const removeOrigin = useCallback(
    async (originId: number, label: string) => {
      const confirmed = await feedback.confirmDestructive(
        "Apagar endereço",
        `"${label}" será removido da sua conta. O aviso continua chegando, mas sem estimativa de trânsito.`,
        "Apagar",
      );
      if (!confirmed) return;
      deleteOrigin.mutate({ originId });
    },
    [feedback, deleteOrigin],
  );

  const suggestions = useMemo(
    () => suggestionsQuery.data?.suggestions ?? [],
    [suggestionsQuery.data],
  );

  if (statusQuery.isLoading) {
    return (
      <ScreenGradient>
        <ScreenContainer>
          <SkeletonList count={3} />
        </ScreenContainer>
      </ScreenGradient>
    );
  }

  if (statusQuery.isError || !status) {
    return (
      <ScreenGradient>
        <ScreenContainer>
          <QueryErrorState
            title="Não foi possível carregar o aviso de plantão"
            error={statusQuery.error}
            onRetry={() => {
              statusQuery.refetch();
            }}
          />
        </ScreenContainer>
      </ScreenGradient>
    );
  }

  return (
    <ScreenGradient>
      <ScreenContainer>
        <View style={{ gap: theme.space[5], paddingBottom: theme.space[10] }}>
          <View style={{ gap: theme.space[2] }}>
            <Text
              style={{
                fontSize: theme.text.titleLg.fontSize,
                fontWeight: "700",
                color: theme.colors.textPrimary,
              }}
            >
              Aviso de plantão
            </Text>
            <Text
              style={{
                fontSize: theme.text.body.fontSize,
                lineHeight: theme.text.body.lineHeight,
                color: theme.colors.textSecondary,
              }}
            >
              Uma hora antes de cada plantão você recebe um aviso com o tempo de
              trânsito estimado e a previsão do tempo.
            </Text>
          </View>

          <ListRow
            title="Receber o aviso"
            subtitle={
              enabled
                ? "Ligado para todos os seus plantões."
                : "Desligado. Nenhum aviso será enviado."
            }
            Icon={BellRing}
            tone={enabled ? "brand" : "default"}
            toggle={{
              value: enabled,
              onValueChange: toggle,
              accessibilityLabel: "Receber aviso de plantão",
            }}
          />

          {/* A origem é do APARELHO. O médico não digita endereço: liga a
              localização uma vez e o app passa a saber de onde ele sai —
              inclusive com o app fechado, que é quando o aviso precisa. O
              endereço digitado continua existindo, mas só aparece como
              plano B, quando a localização não está completa. */}
          <Section
            title={location.guidance.title}
            description={location.guidance.body}
          >
            {location.access === LOCATION_ACCESS.always ? (
              <AppButton
                title={location.busy ? "Aguarde…" : "Desligar localização"}
                onPress={() => {
                  void location.disable();
                }}
                variant="ghost"
                fullWidth
                disabled={busy || location.busy}
              />
            ) : location.access === LOCATION_ACCESS.unknown ? (
              <AppButton
                title={
                  location.busy
                    ? "Aguarde…"
                    : (location.guidance.action ?? "Usar minha localização")
                }
                onPress={() => {
                  void location.enable();
                }}
                variant="primary"
                fullWidth
                disabled={busy || location.busy}
              />
            ) : location.guidance.action ? (
              <AppButton
                title={location.guidance.action}
                onPress={() => {
                  void location.openSettings();
                }}
                variant="secondary"
                fullWidth
                disabled={busy || location.busy}
              />
            ) : null}
          </Section>

          {location.access !== LOCATION_ACCESS.always ? (
            <Section
              title="Prefere informar um endereço?"
              description="Plano B, para quem não quer liberar a localização. Serve só para calcular o trânsito. Guardamos protegido, nunca aparece em lista, e você pode apagar quando quiser."
            >
              {status.origins.length > 0 ? (
                <View style={{ gap: theme.space[2] }}>
                  {status.origins
                    .filter((origin) => origin.label !== AUTOMATIC_ORIGIN_LABEL)
                    .map((origin) => (
                      <View
                        key={origin.id}
                        style={{
                          flexDirection: "row",
                          alignItems: "center",
                          gap: theme.space[3],
                          minHeight: 44,
                          paddingHorizontal: theme.space[3],
                          borderRadius: theme.radius.md,
                          borderWidth: 1,
                          borderColor:
                            status.travelOriginId === origin.id
                              ? theme.colors.primary
                              : theme.colors.border,
                          backgroundColor: theme.colors.surface,
                        }}
                      >
                        <MapPin size={18} color={theme.colors.textSecondary} />
                        <TouchableOpacity
                          style={{
                            flex: 1,
                            minHeight: 44,
                            justifyContent: "center",
                          }}
                          onPress={() => chooseOrigin(origin.id)}
                          accessibilityRole="button"
                          accessibilityLabel={`Usar ${origin.label} para calcular o trânsito`}
                        >
                          <Text
                            style={{
                              fontSize: theme.text.body.fontSize,
                              fontWeight: "600",
                              color: theme.colors.textPrimary,
                            }}
                          >
                            {origin.label}
                          </Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                          onPress={() => removeOrigin(origin.id, origin.label)}
                          disabled={busy}
                          accessibilityRole="button"
                          accessibilityLabel={`Apagar ${origin.label}`}
                          style={{
                            width: 44,
                            height: 44,
                            alignItems: "center",
                            justifyContent: "center",
                          }}
                        >
                          <Trash2 size={18} color={theme.colors.danger} />
                        </TouchableOpacity>
                      </View>
                    ))}
                </View>
              ) : null}

              {status.mapsAvailable ? (
                <View style={{ gap: theme.space[2] }}>
                  <TextInput
                    value={search}
                    onChangeText={setSearch}
                    placeholder="Buscar endereço…"
                    placeholderTextColor={theme.colors.textDisabled}
                    accessibilityLabel="Buscar endereço de origem"
                    style={{
                      minHeight: 44,
                      paddingHorizontal: theme.space[3],
                      borderRadius: theme.radius.md,
                      borderWidth: 1,
                      borderColor: theme.colors.border,
                      backgroundColor: theme.colors.surface,
                      color: theme.colors.textPrimary,
                      fontSize: theme.text.body.fontSize,
                    }}
                  />
                  {suggestionsQuery.isError ? (
                    <QueryErrorState
                      title="Não foi possível buscar endereços"
                      error={suggestionsQuery.error}
                      onRetry={() => {
                        suggestionsQuery.refetch();
                      }}
                    />
                  ) : null}
                  {suggestions.map((suggestion) => (
                    <TouchableOpacity
                      key={suggestion.placeId}
                      onPress={() => setPendingPlaceId(suggestion.placeId)}
                      accessibilityRole="button"
                      accessibilityLabel={`Escolher ${suggestion.primaryText}`}
                      style={{
                        minHeight: 44,
                        justifyContent: "center",
                        paddingHorizontal: theme.space[3],
                        borderRadius: theme.radius.md,
                        borderWidth: 1,
                        borderColor:
                          pendingPlaceId === suggestion.placeId
                            ? theme.colors.primary
                            : theme.colors.border,
                        backgroundColor: theme.colors.surface,
                      }}
                    >
                      <Text
                        style={{
                          fontSize: theme.text.body.fontSize,
                          color: theme.colors.textPrimary,
                        }}
                      >
                        {suggestion.primaryText}
                      </Text>
                      <Text
                        style={{
                          fontSize: theme.text.caption.fontSize,
                          color: theme.colors.textMuted,
                        }}
                      >
                        {suggestion.secondaryText}
                      </Text>
                    </TouchableOpacity>
                  ))}

                  {pendingPlaceId ? (
                    <View style={{ gap: theme.space[2] }}>
                      <TextInput
                        value={originLabel}
                        onChangeText={setOriginLabel}
                        accessibilityLabel="Nome deste endereço"
                        maxLength={60}
                        style={{
                          minHeight: 44,
                          paddingHorizontal: theme.space[3],
                          borderRadius: theme.radius.md,
                          borderWidth: 1,
                          borderColor: theme.colors.border,
                          backgroundColor: theme.colors.surface,
                          color: theme.colors.textPrimary,
                          fontSize: theme.text.body.fontSize,
                        }}
                      />
                      <Text
                        style={{
                          fontSize: theme.text.caption.fontSize,
                          color: theme.colors.textSecondary,
                        }}
                      >
                        Ao salvar, você autoriza o Escala+ a guardar este
                        endereço cifrado e usá-lo apenas para calcular o tempo
                        de trânsito até o hospital.
                      </Text>
                      <AppButton
                        title={
                          saveOrigin.isPending ? "Salvando…" : "Salvar endereço"
                        }
                        onPress={() =>
                          saveOrigin.mutate({
                            label: originLabel.trim() || "Casa",
                            placeId: pendingPlaceId,
                            consent: true,
                            makeDefault: true,
                          })
                        }
                        variant="primary"
                        fullWidth
                        disabled={busy}
                      />
                    </View>
                  ) : null}
                </View>
              ) : (
                <Text
                  style={{
                    fontSize: theme.text.body.fontSize,
                    color: theme.colors.textSecondary,
                  }}
                >
                  A busca de endereços ainda não está disponível nesta
                  instalação. O aviso continua chegando uma hora antes de cada
                  plantão, sem a estimativa de trânsito.
                </Text>
              )}
            </Section>
          ) : null}
        </View>
      </ScreenContainer>
    </ScreenGradient>
  );
}

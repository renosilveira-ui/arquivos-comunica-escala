import { useCallback, useMemo, useState } from "react";
import { Text, TextInput, TouchableOpacity, View } from "react-native";
import { Car, Footprints, MapPin, Train, Trash2 } from "lucide-react-native";

import { AppButton } from "@/components/ui/AppButton";
import { QueryErrorState } from "@/components/ui/QueryErrorState";
import { ScreenContainer } from "@/components/ui/ScreenContainer";
import { ScreenGradient } from "@/components/ui/ScreenGradient";
import { SkeletonList } from "@/components/ui/Skeleton";
import { useActionFeedback } from "@/hooks/use-action-feedback";
import { theme } from "@/lib/theme";
import { trpc } from "@/lib/trpc";

/**
 * Aviso de "hora de sair".
 *
 * Recurso da CONTA: não lê instituição nem papel. O médico sai de casa uma
 * vez, e o destino pode ser qualquer hospital dos vínculos dele.
 *
 * A tela é explícita sobre privacidade porque o dado é o mais sensível que o
 * sistema toca: o endereço é guardado cifrado, nunca aparece em lista, e há
 * um botão para apagá-lo. Dizer isso na tela não é decoração — é o que
 * permite ao usuário consentir de verdade.
 */

const TRAVEL_MODES = [
  { value: "DRIVING" as const, label: "Carro", Icon: Car },
  { value: "TRANSIT" as const, label: "Transporte", Icon: Train },
  { value: "WALKING" as const, label: "A pé", Icon: Footprints },
];

const MARGIN_OPTIONS = [0, 10, 15, 30, 45, 60];

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

function Chip({
  label,
  selected,
  onPress,
  accessibilityLabel,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
  accessibilityLabel?: string;
}) {
  return (
    <TouchableOpacity
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={accessibilityLabel ?? label}
      style={{
        minHeight: 36,
        paddingHorizontal: theme.space[3],
        justifyContent: "center",
        borderRadius: theme.radius.full,
        borderWidth: 1,
        borderColor: selected ? theme.colors.primary : theme.colors.border,
        backgroundColor: selected
          ? theme.colors.primarySoft
          : theme.colors.surface,
      }}
    >
      <Text
        style={{
          fontSize: theme.text.body.fontSize,
          fontWeight: selected ? "600" : "500",
          color: selected ? theme.colors.primary : theme.colors.textSecondary,
        }}
      >
        {label}
      </Text>
    </TouchableOpacity>
  );
}

export default function DepartureAlertsScreen() {
  const feedback = useActionFeedback();
  const utils = trpc.useUtils();
  const statusQuery = trpc.departure.status.useQuery(undefined, {
    staleTime: 15_000,
  });

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
    onSuccess: async () => {
      await utils.departure.status.invalidate();
      feedback.success("Preferências salvas.");
    },
    onError: (error) => feedback.error(error.message),
  });

  const saveOrigin = trpc.departure.saveTravelOrigin.useMutation({
    onSuccess: async () => {
      await utils.departure.status.invalidate();
      setSearch("");
      setPendingPlaceId(null);
      feedback.success("Origem salva.");
    },
    onError: (error) => feedback.error(error.message),
  });

  const deleteOrigin = trpc.departure.deleteTravelOrigin.useMutation({
    onSuccess: async () => {
      await utils.departure.status.invalidate();
      feedback.success("Origem apagada.");
    },
    onError: (error) => feedback.error(error.message),
  });

  const status = statusQuery.data;
  const busy =
    savePreferences.isPending || saveOrigin.isPending || deleteOrigin.isPending;

  const persist = useCallback(
    (
      overrides: Partial<{
        enabled: boolean;
        travelMode: "DRIVING" | "WALKING" | "TRANSIT";
        arrivalMarginMinutes: number;
        fallbackTravelMinutes: number;
        travelOriginId: number | null;
      }>,
    ) => {
      if (!status) return;
      savePreferences.mutate({
        enabled: status.enabled,
        travelMode: status.travelMode,
        arrivalMarginMinutes: status.arrivalMarginMinutes,
        fallbackTravelMinutes: status.fallbackTravelMinutes,
        travelOriginId: status.travelOriginId,
        ...overrides,
      });
    },
    [status, savePreferences],
  );

  const removeOrigin = useCallback(
    async (originId: number, label: string) => {
      const confirmed = await feedback.confirmDestructive(
        "Apagar origem",
        `"${label}" será removida da sua conta. O aviso passa a usar o tempo fixo até você cadastrar outra.`,
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
          <SkeletonList count={4} />
        </ScreenContainer>
      </ScreenGradient>
    );
  }

  if (statusQuery.isError || !status) {
    return (
      <ScreenGradient>
        <ScreenContainer>
          <QueryErrorState
            title="Não foi possível carregar o aviso de saída"
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
              Hora de sair
            </Text>
            <Text
              style={{
                fontSize: theme.text.body.fontSize,
                lineHeight: theme.text.body.lineHeight,
                color: theme.colors.textSecondary,
              }}
            >
              Avisamos quando sair de casa para chegar ao plantão, considerando
              o trânsito e a previsão do tempo.
            </Text>
          </View>

          <Section title="Receber o aviso">
            <Chip
              label={status.enabled ? "Ligado" : "Desligado"}
              selected={status.enabled}
              onPress={() => persist({ enabled: !status.enabled })}
              accessibilityLabel={
                status.enabled
                  ? "Aviso de saída ligado. Toque para desligar."
                  : "Aviso de saída desligado. Toque para ligar."
              }
            />
          </Section>

          <Section
            title="Chegar com antecedência"
            description="Quanto tempo antes do início do plantão você quer estar lá."
          >
            <View
              style={{
                flexDirection: "row",
                flexWrap: "wrap",
                gap: theme.space[2],
              }}
            >
              {MARGIN_OPTIONS.map((minutes) => (
                <Chip
                  key={minutes}
                  label={minutes === 0 ? "Na hora" : `${minutes} min`}
                  selected={status.arrivalMarginMinutes === minutes}
                  onPress={() => persist({ arrivalMarginMinutes: minutes })}
                />
              ))}
            </View>
          </Section>

          <Section title="Como você vai">
            <View style={{ flexDirection: "row", gap: theme.space[2] }}>
              {TRAVEL_MODES.map((mode) => (
                <Chip
                  key={mode.value}
                  label={mode.label}
                  selected={status.travelMode === mode.value}
                  onPress={() => persist({ travelMode: mode.value })}
                />
              ))}
            </View>
          </Section>

          <Section
            title="De onde você sai"
            description="Guardamos o endereço cifrado. Ele nunca aparece em lista e você pode apagá-lo quando quiser."
          >
            {status.origins.length > 0 ? (
              <View style={{ gap: theme.space[2] }}>
                {status.origins.map((origin) => (
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
                      onPress={() => persist({ travelOriginId: origin.id })}
                      accessibilityRole="button"
                      accessibilityLabel={`Usar ${origin.label} como origem`}
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
                      accessibilityLabel="Nome desta origem"
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
                      Ao salvar, você autoriza o Escala+ a guardar este endereço
                      cifrado e usá-lo apenas para calcular a hora de sair.
                    </Text>
                    <AppButton
                      title={
                        saveOrigin.isPending ? "Salvando…" : "Salvar origem"
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
                A busca de endereços ainda não está disponível nesta instalação.
                Sem origem cadastrada, o aviso usa um tempo fixo de trajeto.
              </Text>
            )}
          </Section>

          <Section
            title="Quando não dá para consultar o trânsito"
            description="Tempo de trajeto assumido. O aviso sai mesmo assim, avisando que a estimativa é fixa."
          >
            <View
              style={{
                flexDirection: "row",
                flexWrap: "wrap",
                gap: theme.space[2],
              }}
            >
              {[20, 30, 40, 60, 90].map((minutes) => (
                <Chip
                  key={minutes}
                  label={`${minutes} min`}
                  selected={status.fallbackTravelMinutes === minutes}
                  onPress={() => persist({ fallbackTravelMinutes: minutes })}
                />
              ))}
            </View>
          </Section>
        </View>
      </ScreenContainer>
    </ScreenGradient>
  );
}

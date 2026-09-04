/**
 * Seletor UX de destinatário para REPASSE (TRANSFER/CESSAO).
 * SWAP não monta este componente.
 *
 * A lista é projeção. A escrita continua em `swaps.offer` /
 * `createSwapOffer`. Homônimos irresolvidos não são selecionáveis.
 */
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { QueryErrorState } from "@/components/ui/QueryErrorState";
import {
  directedOfferRecipientCopy,
  directedOfferRecipientLabel,
  unresolvedHomonymGroupLabel,
  type DirectedOfferAudience,
  type EligibleOfferRecipientListView,
} from "@/lib/directed-offer-recipient-picker";
import { resolveOperationalListState } from "@/lib/operational-screen-state";
import { theme } from "@/lib/theme";

type Props = {
  list: EligibleOfferRecipientListView | null;
  isLoading: boolean;
  isPending: boolean;
  isError: boolean;
  hasResolvedData: boolean;
  error: unknown;
  audience: DirectedOfferAudience;
  onSelectOpen: () => void;
  onSelectRecipient: (professionalId: number) => void;
  onRetry: () => void;
};

export function DirectedOfferRecipientPicker({
  list,
  isLoading,
  isPending,
  isError,
  hasResolvedData,
  error,
  audience,
  onSelectOpen,
  onSelectRecipient,
  onRetry,
}: Props) {
  const recipients = list?.recipients ?? [];
  const unresolved = list?.unresolvedHomonymGroups ?? [];
  const state = resolveOperationalListState({
    isLoading,
    isPending,
    isError: isError || (hasResolvedData && list == null),
    hasResolvedData: hasResolvedData && list != null,
    itemCount: recipients.length,
    error,
  });

  return (
    <View style={{ gap: theme.space[3] }}>
      <Text
        style={{
          ...theme.text.title,
          color: theme.colors.textPrimary,
          fontWeight: theme.weight.semibold,
        }}
      >
        {directedOfferRecipientCopy.sectionTitle}
      </Text>

      {state === "LOADING" || state === "UNRESOLVED" ? (
        <View
          style={{
            minHeight: 44,
            flexDirection: "row",
            alignItems: "center",
            gap: theme.space[3],
          }}
        >
          <ActivityIndicator color={theme.colors.primary} />
          <Text style={{ ...theme.text.body, color: theme.colors.textSecondary }}>
            {state === "LOADING"
              ? directedOfferRecipientCopy.loading
              : directedOfferRecipientCopy.unresolved}
          </Text>
        </View>
      ) : null}

      {state === "ERROR" ? (
        <QueryErrorState
          title={directedOfferRecipientCopy.errorTitle}
          error={error}
          onRetry={onRetry}
        />
      ) : null}

      {state === "READY" || state === "EMPTY" ? (
        <>
          <AudienceOption
            selected={audience.kind === "open"}
            title={directedOfferRecipientCopy.openLabel}
            subtitle={directedOfferRecipientCopy.openHint}
            onPress={onSelectOpen}
          />

          {state === "EMPTY" ? (
            <Text
              style={{ ...theme.text.body, color: theme.colors.textSecondary }}
            >
              {directedOfferRecipientCopy.emptySelectable}
            </Text>
          ) : null}

          {recipients.map((recipient) => (
            <AudienceOption
              key={recipient.professionalId}
              selected={
                audience.kind === "directed" &&
                audience.professionalId === recipient.professionalId
              }
              title={directedOfferRecipientLabel(recipient)}
              onPress={() => onSelectRecipient(recipient.professionalId)}
            />
          ))}

          {unresolved.length > 0 ? (
            <View
              style={{
                gap: theme.space[2],
                padding: theme.space[4],
                borderRadius: theme.radius.lg,
                backgroundColor: theme.colors.warningSoft,
                borderWidth: 1,
                borderColor: theme.colors.warning,
              }}
            >
              <Text
                style={{
                  ...theme.text.body,
                  color: theme.palette.warning[700],
                  fontWeight: theme.weight.semibold,
                }}
              >
                {directedOfferRecipientCopy.unresolvedHeading}
              </Text>
              {unresolved.map((group, index) => (
                <View key={`${group.displayName}:${group.qualification}:${index}`}>
                  <Text
                    style={{
                      ...theme.text.body,
                      color: theme.palette.warning[700],
                    }}
                  >
                    {unresolvedHomonymGroupLabel(group)}
                    {group.count > 1 ? ` (${group.count})` : ""}
                  </Text>
                  {group.reason ? (
                    <Text
                      style={{
                        ...theme.text.caption,
                        color: theme.palette.warning[700],
                        marginTop: theme.space[1],
                      }}
                    >
                      {group.reason}
                    </Text>
                  ) : null}
                </View>
              ))}
            </View>
          ) : null}
        </>
      ) : null}
    </View>
  );
}

function AudienceOption({
  selected,
  title,
  subtitle,
  onPress,
}: {
  selected: boolean;
  title: string;
  subtitle?: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      style={{
        minHeight: 44,
        paddingVertical: theme.space[3],
        paddingHorizontal: theme.space[4],
        borderRadius: theme.radius.lg,
        backgroundColor: selected
          ? theme.colors.primarySoft
          : theme.colors.surface,
        borderWidth: 1.5,
        borderColor: selected ? theme.colors.primary : theme.colors.border,
        justifyContent: "center",
      }}
    >
      <Text
        style={{
          ...theme.text.bodyLg,
          color: selected
            ? theme.palette.primary[700]
            : theme.colors.textPrimary,
          fontWeight: theme.weight.semibold,
        }}
      >
        {title}
      </Text>
      {subtitle ? (
        <Text
          style={{
            ...theme.text.caption,
            color: selected
              ? theme.palette.primary[700]
              : theme.colors.textMuted,
            marginTop: theme.space[1],
          }}
        >
          {subtitle}
        </Text>
      ) : null}
    </Pressable>
  );
}

import { useMemo, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  Text,
  View,
} from "react-native";
import { Check, ChevronDown, Layers3, X } from "lucide-react-native";
import { theme } from "@/lib/theme";
import {
  groupScheduleContexts,
  type ScheduleContextOption,
} from "@/lib/schedule-context-selection";

type ScheduleContextSelectorProps = Readonly<{
  contexts: readonly ScheduleContextOption[];
  selectedContextId: number | null;
  onSelect: (contextId: number | null) => void;
  loading?: boolean;
  disabled?: boolean;
  allContextsLabel?: string;
  allContextsSubtitle?: string;
}>;

export function ScheduleContextSelector({
  contexts,
  selectedContextId,
  onSelect,
  loading = false,
  disabled = false,
  allContextsLabel = "Todos os meus setores",
  allContextsSubtitle = "Visão geral das escalas que você pode acessar",
}: ScheduleContextSelectorProps) {
  const [open, setOpen] = useState(false);
  const selected =
    contexts.find((context) => context.id === selectedContextId) ?? null;
  const hierarchy = useMemo(() => groupScheduleContexts(contexts), [contexts]);
  const isDisabled = disabled || loading || contexts.length === 0;
  const triggerLabel = loading
    ? "Carregando escalas..."
    : contexts.length === 0
      ? "Nenhuma escala disponível"
      : (selected?.displayName ?? allContextsLabel);

  const close = () => setOpen(false);
  const choose = (contextId: number | null) => {
    onSelect(contextId);
    close();
  };

  return (
    <>
      <Pressable
        onPress={() => setOpen(true)}
        disabled={isDisabled}
        accessibilityRole="button"
        accessibilityLabel={`Escala exibida: ${triggerLabel}`}
        accessibilityState={{ disabled: isDisabled, expanded: open }}
        style={({ pressed }) => ({
          minHeight: theme.space[10] + theme.space[1],
          flexDirection: "row",
          alignItems: "center",
          gap: theme.space[2],
          paddingHorizontal: theme.space[3],
          borderRadius: theme.radius.md + 1,
          borderWidth: 1,
          borderColor: selected
            ? theme.colors.primary
            : theme.colors.borderStrong,
          backgroundColor: selected
            ? theme.colors.primarySoft
            : theme.colors.surface,
          opacity: isDisabled ? 0.7 : pressed ? 0.85 : 1,
        })}
      >
        {loading ? (
          <ActivityIndicator size="small" color={theme.colors.primary} />
        ) : (
          <Layers3 size={16} color={theme.colors.brand} />
        )}
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text
            style={{
              ...theme.text.caption,
              color: theme.colors.textMuted,
              fontWeight: theme.weight.semibold,
            }}
          >
            Escala exibida
          </Text>
          <Text
            numberOfLines={1}
            style={{
              ...theme.text.body,
              color: theme.colors.textPrimary,
              fontWeight: theme.weight.semibold,
            }}
          >
            {triggerLabel}
          </Text>
        </View>
        {!isDisabled ? (
          <ChevronDown size={16} color={theme.colors.textSecondary} />
        ) : null}
      </Pressable>

      <Modal
        visible={open}
        transparent
        animationType="fade"
        onRequestClose={close}
      >
        <Pressable
          onPress={close}
          accessibilityLabel="Fechar seleção de escala"
          style={{
            flex: 1,
            justifyContent: "flex-end",
            backgroundColor: theme.colors.overlay,
          }}
        >
          <Pressable
            onPress={() => undefined}
            style={{
              width: "100%",
              maxWidth: theme.spacing.contentMaxWidth / 2,
              maxHeight: "80%",
              alignSelf: "center",
              gap: theme.space[4],
              padding: theme.space[5],
              paddingBottom: theme.space[10],
              borderTopLeftRadius: theme.radius["2xl"],
              borderTopRightRadius: theme.radius["2xl"],
              backgroundColor: theme.colors.surface,
            }}
          >
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: theme.space[3],
              }}
            >
              <View style={{ flex: 1 }}>
                <Text
                  style={{
                    ...theme.text.title,
                    color: theme.colors.textPrimary,
                    fontWeight: theme.weight.bold,
                  }}
                >
                  Qual escala você quer ver?
                </Text>
                <Text
                  style={{ ...theme.text.body, color: theme.colors.textMuted }}
                >
                  Escolha o hospital e o setor que deseja visualizar.
                </Text>
              </View>
              <Pressable
                onPress={close}
                hitSlop={12}
                accessibilityLabel="Fechar"
              >
                <X size={22} color={theme.colors.textSecondary} />
              </Pressable>
            </View>

            <ScrollView showsVerticalScrollIndicator={false}>
              <View style={{ gap: theme.space[2] }}>
                <ContextOption
                  title={allContextsLabel}
                  subtitle={allContextsSubtitle}
                  selected={selectedContextId === null}
                  onPress={() => choose(null)}
                />
                {hierarchy.map((hospital) => (
                  <View
                    key={hospital.hospitalId}
                    style={{ gap: theme.space[2] }}
                  >
                    <Text
                      style={{
                        ...theme.text.eyebrow,
                        marginTop: theme.space[2],
                        color: theme.colors.textMuted,
                        fontWeight: theme.weight.bold,
                        textTransform: "uppercase",
                      }}
                    >
                      {hospital.hospitalName}
                    </Text>
                    {hospital.sectors.flatMap((sector) =>
                      sector.contexts.map((context) => (
                        <ContextOption
                          key={context.id}
                          title={
                            context.qualificationKind === "SECTOR_POLICY"
                              ? context.displayName
                              : `${sector.sectorName} · ${context.qualificationName}`
                          }
                          subtitle={
                            context.qualificationKind === "SECTOR_POLICY"
                              ? context.hospitalName
                              : context.qualificationCode
                          }
                          selected={context.id === selectedContextId}
                          onPress={() => choose(context.id)}
                        />
                      )),
                    )}
                  </View>
                ))}
              </View>
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

function ContextOption({
  title,
  subtitle,
  selected,
  onPress,
}: Readonly<{
  title: string;
  subtitle: string;
  selected: boolean;
  onPress: () => void;
}>) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityState={{ checked: selected }}
      style={({ pressed }) => ({
        minHeight: theme.space[14],
        flexDirection: "row",
        alignItems: "center",
        gap: theme.space[3],
        paddingHorizontal: theme.space[4],
        paddingVertical: theme.space[3],
        borderRadius: theme.radius.lg,
        borderWidth: 1,
        borderColor: selected ? theme.colors.primary : theme.colors.border,
        backgroundColor: selected
          ? theme.colors.primarySoft
          : theme.colors.surfaceAlt,
        opacity: pressed ? 0.82 : 1,
      })}
    >
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text
          style={{
            ...theme.text.bodyLg,
            color: theme.colors.textPrimary,
            fontWeight: theme.weight.semibold,
          }}
        >
          {title}
        </Text>
        <Text style={{ ...theme.text.body, color: theme.colors.textMuted }}>
          {subtitle}
        </Text>
      </View>
      {selected ? <Check size={20} color={theme.colors.primary} /> : null}
    </Pressable>
  );
}

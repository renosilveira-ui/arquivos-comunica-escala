import { useMemo, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import * as Haptics from "expo-haptics";
import { X } from "lucide-react-native";
import { trpc } from "@/lib/trpc";
import { theme } from "@/lib/theme";
import { useActionFeedback } from "@/hooks/use-action-feedback";
import { AppButton } from "@/components/ui/AppButton";
import { QueryErrorState } from "@/components/ui/QueryErrorState";
import {
  createSectorScaleButtonTitle,
  createSectorScaleConfirmTitle,
  createSectorScaleDescription,
  createSectorScaleModalTitle,
  createSectorScaleNamePlaceholder,
  createSectorScaleNewSectorLabel,
  createSectorScaleToast,
} from "@/lib/create-sector-scale";

interface Props {
  onCreated?: (result: { scheduleContextId: number }) => void;
}

export function CreateSectorScaleButton({ onCreated }: Props) {
  const [open, setOpen] = useState(false);
  const [hospitalId, setHospitalId] = useState<number | null>(null);
  const [sectorId, setSectorId] = useState<number | null>(null);
  const [creatingNew, setCreatingNew] = useState(false);
  const [sectorName, setSectorName] = useState("");
  const feedback = useActionFeedback();
  const utils = trpc.useUtils();
  const topology = trpc.scheduleContexts.listManageableTopology.useQuery(
    undefined,
    { enabled: open },
  );
  const ensureScale = trpc.scheduleContexts.ensureDefaultSectorScale.useMutation();

  const selectedHospital = useMemo(
    () => topology.data?.find((hospital) => hospital.id === hospitalId) ?? null,
    [topology.data, hospitalId],
  );

  function close() {
    setOpen(false);
    setHospitalId(null);
    setSectorId(null);
    setCreatingNew(false);
    setSectorName("");
  }

  function openModal() {
    if (Platform.OS !== "web") {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    }
    setOpen(true);
  }

  async function confirm() {
    if (!hospitalId) {
      feedback.error("Escolha o hospital.");
      return;
    }
    if (!sectorId && !creatingNew) {
      feedback.error("Escolha o setor ou crie um novo.");
      return;
    }
    try {
      const result = await ensureScale.mutateAsync({
        hospitalId,
        sectorId: creatingNew ? undefined : (sectorId ?? undefined),
        sectorName: creatingNew ? sectorName.trim() : undefined,
      });
      await Promise.all([
        utils.scheduleContexts.listMine.invalidate(),
        utils.scheduleContexts.listManageableTopology.invalidate(),
        utils.hospitals.list.invalidate(),
        utils.sectors.list.invalidate(),
      ]);
      onCreated?.({ scheduleContextId: result.scheduleContextId });
      feedback.success(createSectorScaleToast(result.sectorName));
      close();
    } catch (err) {
      feedback.error((err as Error).message);
    }
  }

  const canConfirm =
    hospitalId !== null &&
    (creatingNew ? sectorName.trim().length >= 2 : sectorId !== null);

  return (
    <>
      <AppButton
        title={createSectorScaleButtonTitle()}
        onPress={openModal}
        fullWidth
      />

      <Modal visible={open} transparent animationType="fade" onRequestClose={close}>
        <Pressable
          onPress={close}
          accessibilityLabel="Fechar"
          style={{
            flex: 1,
            backgroundColor: theme.colors.overlay,
            justifyContent: "flex-end",
          }}
        >
          <Pressable
            onPress={() => {}}
            style={{
              backgroundColor: theme.colors.surface,
              borderTopLeftRadius: theme.radius["2xl"],
              borderTopRightRadius: theme.radius["2xl"],
              padding: theme.space[6],
              paddingBottom: theme.space[10],
              gap: theme.space[4],
              maxHeight: "85%",
              width: "100%",
              maxWidth: theme.spacing.contentMaxWidth / 2,
              alignSelf: "center",
            }}
          >
            <View
              style={{
                flexDirection: "row",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <Text
                style={{
                  ...theme.text.title,
                  fontWeight: theme.weight.bold,
                  color: theme.colors.textPrimary,
                }}
              >
                {createSectorScaleModalTitle()}
              </Text>
              <Pressable onPress={close} hitSlop={12} accessibilityLabel="Fechar">
                <X size={22} color={theme.colors.textSecondary} />
              </Pressable>
            </View>

            <Text style={{ ...theme.text.body, color: theme.colors.textSecondary }}>
              {createSectorScaleDescription()}
            </Text>

            {topology.isError ? (
              <QueryErrorState
                title="Não foi possível carregar hospitais e setores"
                onRetry={() => {
                  void topology.refetch();
                }}
              />
            ) : topology.isLoading ? (
              <View
                style={{
                  alignItems: "center",
                  paddingVertical: theme.space[4],
                  gap: theme.space[3],
                }}
              >
                <ActivityIndicator size="large" color={theme.colors.primary} />
              </View>
            ) : (
              <ScrollView style={{ maxHeight: 360 }} keyboardShouldPersistTaps="handled">
                <View style={{ gap: theme.space[3] }}>
                  <Text
                    style={{
                      ...theme.text.caption,
                      fontWeight: theme.weight.semibold,
                      color: theme.colors.textMuted,
                    }}
                  >
                    Hospital
                  </Text>
                  {(topology.data ?? []).map((hospital) => {
                    const selected = hospitalId === hospital.id;
                    return (
                      <Pressable
                        key={hospital.id}
                        onPress={() => {
                          setHospitalId(hospital.id);
                          setSectorId(null);
                          setCreatingNew(false);
                        }}
                        accessibilityRole="button"
                        accessibilityState={{ selected }}
                        style={{
                          minHeight: theme.space[10] + theme.space[1],
                          justifyContent: "center",
                          paddingHorizontal: theme.space[3],
                          paddingVertical: theme.space[2],
                          borderRadius: theme.radius.lg,
                          borderWidth: 1,
                          borderColor: selected
                            ? theme.colors.primary
                            : theme.colors.border,
                          backgroundColor: selected
                            ? theme.colors.primarySoft
                            : theme.colors.surface,
                        }}
                      >
                        <Text
                          style={{
                            ...theme.text.bodyLg,
                            fontWeight: theme.weight.semibold,
                            color: selected
                              ? theme.colors.primary
                              : theme.colors.textPrimary,
                          }}
                        >
                          {hospital.name}
                        </Text>
                      </Pressable>
                    );
                  })}

                  {selectedHospital ? (
                    <>
                      <Text
                        style={{
                          ...theme.text.caption,
                          fontWeight: theme.weight.semibold,
                          color: theme.colors.textMuted,
                        }}
                      >
                        Setor
                      </Text>
                      {selectedHospital.sectors.map((sector) => {
                        const selected = !creatingNew && sectorId === sector.id;
                        return (
                          <Pressable
                            key={sector.id}
                            onPress={() => {
                              setSectorId(sector.id);
                              setCreatingNew(false);
                            }}
                            accessibilityRole="button"
                            accessibilityState={{ selected }}
                            style={{
                              minHeight: theme.space[10] + theme.space[1],
                              justifyContent: "center",
                              paddingHorizontal: theme.space[3],
                              paddingVertical: theme.space[2],
                              borderRadius: theme.radius.lg,
                              borderWidth: 1,
                              borderColor: selected
                                ? theme.colors.primary
                                : theme.colors.border,
                              backgroundColor: selected
                                ? theme.colors.primarySoft
                                : theme.colors.surface,
                            }}
                          >
                            <Text
                              style={{
                                ...theme.text.bodyLg,
                                fontWeight: theme.weight.semibold,
                                color: selected
                                  ? theme.colors.primary
                                  : theme.colors.textPrimary,
                              }}
                            >
                              {sector.name}
                              {sector.hasSchedule ? " · já tem escala" : ""}
                            </Text>
                          </Pressable>
                        );
                      })}
                      {selectedHospital.canCreateSector ? (
                        <Pressable
                          onPress={() => {
                            setCreatingNew(true);
                            setSectorId(null);
                          }}
                          accessibilityRole="button"
                          accessibilityState={{ selected: creatingNew }}
                          style={{
                            minHeight: theme.space[10] + theme.space[1],
                            justifyContent: "center",
                            paddingHorizontal: theme.space[3],
                            paddingVertical: theme.space[2],
                            borderRadius: theme.radius.lg,
                            borderWidth: 1,
                            borderColor: creatingNew
                              ? theme.colors.primary
                              : theme.colors.border,
                            backgroundColor: creatingNew
                              ? theme.colors.primarySoft
                              : theme.colors.surface,
                          }}
                        >
                          <Text
                            style={{
                              ...theme.text.bodyLg,
                              fontWeight: theme.weight.semibold,
                              color: creatingNew
                                ? theme.colors.primary
                                : theme.colors.textPrimary,
                            }}
                          >
                            {createSectorScaleNewSectorLabel()}
                          </Text>
                        </Pressable>
                      ) : null}
                      {creatingNew ? (
                        <TextInput
                          value={sectorName}
                          onChangeText={setSectorName}
                          placeholder={createSectorScaleNamePlaceholder()}
                          placeholderTextColor={theme.colors.textMuted}
                          style={{
                            minHeight: theme.space[10] + theme.space[1],
                            borderRadius: theme.radius.lg,
                            backgroundColor: theme.colors.surfaceAlt,
                            borderWidth: 1,
                            borderColor: theme.colors.border,
                            paddingHorizontal: theme.space[3],
                            ...theme.text.body,
                            color: theme.colors.textPrimary,
                          }}
                        />
                      ) : null}
                    </>
                  ) : null}
                </View>
              </ScrollView>
            )}

            {ensureScale.isPending ? (
              <View
                style={{
                  alignItems: "center",
                  paddingVertical: theme.space[4],
                  gap: theme.space[3],
                }}
              >
                <ActivityIndicator size="large" color={theme.colors.primary} />
                <Text style={{ ...theme.text.body, color: theme.colors.textSecondary }}>
                  Criando escala do setor…
                </Text>
              </View>
            ) : (
              <AppButton
                title={createSectorScaleConfirmTitle()}
                onPress={() => {
                  void confirm();
                }}
                disabled={!canConfirm || ensureScale.isPending || topology.isError}
                fullWidth
              />
            )}
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

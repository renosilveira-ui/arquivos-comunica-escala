import { useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Platform,
  Pressable,
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
import {
  createHospitalButtonTitle,
  createHospitalConfirmTitle,
  createHospitalDescription,
  createHospitalModalTitle,
  createHospitalNamePlaceholder,
  createHospitalToast,
} from "@/lib/create-hospital";

interface Props {
  onCreated?: (result: { hospitalId: number }) => void;
}

export function CreateHospitalButton({ onCreated }: Props) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const feedback = useActionFeedback();
  const utils = trpc.useUtils();
  const createHospital = trpc.hospitals.create.useMutation();

  function close() {
    setOpen(false);
    setName("");
  }

  function openModal() {
    if (Platform.OS !== "web") {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    }
    setOpen(true);
  }

  async function confirm() {
    const trimmed = name.trim();
    if (trimmed.length < 2) {
      feedback.error("Informe o nome do hospital (pelo menos 2 caracteres).");
      return;
    }
    try {
      const result = await createHospital.mutateAsync({ name: trimmed });
      await Promise.all([
        utils.scheduleContexts.listManageableTopology.invalidate(),
        utils.hospitals.list.invalidate(),
        utils.sectors.list.invalidate(),
      ]);
      onCreated?.({ hospitalId: result.id });
      feedback.success(createHospitalToast(result.name));
      close();
    } catch (err) {
      feedback.error((err as Error).message);
    }
  }

  const canConfirm = name.trim().length >= 2;

  return (
    <>
      <AppButton
        title={createHospitalButtonTitle()}
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
                {createHospitalModalTitle()}
              </Text>
              <Pressable onPress={close} hitSlop={12} accessibilityLabel="Fechar">
                <X size={22} color={theme.colors.textSecondary} />
              </Pressable>
            </View>

            <Text style={{ ...theme.text.body, color: theme.colors.textSecondary }}>
              {createHospitalDescription()}
            </Text>

            <TextInput
              value={name}
              onChangeText={setName}
              placeholder={createHospitalNamePlaceholder()}
              placeholderTextColor={theme.colors.textMuted}
              autoFocus
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

            {createHospital.isPending ? (
              <View
                style={{
                  alignItems: "center",
                  paddingVertical: theme.space[4],
                  gap: theme.space[3],
                }}
              >
                <ActivityIndicator size="large" color={theme.colors.primary} />
                <Text style={{ ...theme.text.body, color: theme.colors.textSecondary }}>
                  Criando hospital…
                </Text>
              </View>
            ) : (
              <AppButton
                title={createHospitalConfirmTitle()}
                onPress={() => {
                  void confirm();
                }}
                disabled={!canConfirm || createHospital.isPending}
                fullWidth
              />
            )}
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

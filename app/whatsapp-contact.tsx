import { useEffect, useState } from "react";
import {
  View,
  Text,
  TextInput,
  ActivityIndicator,
  TouchableOpacity,
  KeyboardAvoidingView,
  Platform,
} from "react-native";
import { useRouter } from "expo-router";
import * as Haptics from "expo-haptics";
import { ChevronLeft, ShieldCheck, ShieldAlert } from "lucide-react-native";
import { ScreenGradient } from "@/components/ui/ScreenGradient";
import { ScreenContainer } from "@/components/ui/ScreenContainer";
import { AppButton } from "@/components/ui/AppButton";
import { Surface } from "@/components/ui/Surface";
import { theme } from "@/lib/theme";
import { trpc } from "@/lib/trpc";
import { useActionFeedback } from "@/hooks/use-action-feedback";

/**
 * Perfil → WhatsApp.
 * V1: cadastrar/alterar E.164. Verificação (Twilio Verify) vem no Incremento 2B —
 * o botão fica desabilitado sem fingir fluxo de OTP.
 */
export default function WhatsAppContactScreen() {
  const router = useRouter();
  const feedback = useActionFeedback();
  const utils = trpc.useUtils();
  const contactQuery = trpc.profile.getWhatsAppContact.useQuery();
  const setMutation = trpc.profile.setWhatsAppContact.useMutation({
    onSuccess: async () => {
      await utils.profile.getWhatsAppContact.invalidate();
    },
  });
  const deactivateMutation = trpc.profile.deactivateWhatsAppContact.useMutation({
    onSuccess: async () => {
      await utils.profile.getWhatsAppContact.invalidate();
    },
  });

  const [phone, setPhone] = useState("");
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    if (contactQuery.data?.status === "missing") {
      setEditing(true);
    }
  }, [contactQuery.data?.status]);

  const handleBack = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    router.back();
  };

  const handleSave = async () => {
    try {
      await setMutation.mutateAsync({ phone });
      feedback.success(
        "WhatsApp salvo. A verificação estará disponível em breve.",
      );
      setEditing(false);
      setPhone("");
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Não foi possível salvar o WhatsApp.";
      feedback.error(message);
    }
  };

  const handleDeactivate = async () => {
    const ok = await feedback.confirmDestructive(
      "Remover WhatsApp?",
      "O número deixa de ficar associado à sua conta. Você poderá cadastrar outro depois.",
      "Remover",
    );
    if (!ok) return;
    try {
      await deactivateMutation.mutateAsync();
      feedback.success("WhatsApp removido.");
      setEditing(true);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Não foi possível remover o WhatsApp.";
      feedback.error(message);
    }
  };

  const data = contactQuery.data;
  const busy = setMutation.isPending || deactivateMutation.isPending;

  return (
    <ScreenGradient scrollable>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScreenContainer>
          <TouchableOpacity
            onPress={handleBack}
            accessibilityRole="button"
            accessibilityLabel="Voltar ao perfil"
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: theme.space[1],
              minHeight: 44,
              marginBottom: theme.space[4],
            }}
          >
            <ChevronLeft size={22} color={theme.colors.textPrimary} />
            <Text
              style={{
                ...theme.text.body,
                color: theme.colors.textPrimary,
                fontWeight: theme.weight.medium,
              }}
            >
              Voltar
            </Text>
          </TouchableOpacity>

          <Text
            style={{
              ...theme.text.title,
              fontWeight: theme.weight.bold,
              color: theme.colors.textPrimary,
              marginBottom: theme.space[2],
            }}
          >
            WhatsApp
          </Text>
          <Text
            style={{
              ...theme.text.body,
              color: theme.colors.textSecondary,
              marginBottom: theme.space[5],
            }}
          >
            Cadastre o número que você usará para solicitar troca ou cessão pelo
            WhatsApp. A verificação chega em uma próxima etapa.
          </Text>

          {contactQuery.isLoading ? (
            <ActivityIndicator color={theme.colors.primary} />
          ) : contactQuery.isError ? (
            <Surface style={{ gap: theme.space[3] }}>
              <Text
                style={{
                  ...theme.text.body,
                  color: theme.palette.danger[700],
                }}
              >
                Não foi possível carregar o WhatsApp.
              </Text>
              <AppButton
                title="Tentar de novo"
                onPress={() => {
                  void contactQuery.refetch();
                }}
              />
            </Surface>
          ) : (
            <Surface style={{ gap: theme.space[3] }}>
              {data?.status === "missing" || editing ? (
                <>
                  <Text
                    style={{
                      ...theme.text.titleSm,
                      fontWeight: theme.weight.semibold,
                      color: theme.colors.textPrimary,
                    }}
                  >
                    {data?.status === "missing"
                      ? "WhatsApp não cadastrado"
                      : "Alterar número"}
                  </Text>
                  <TextInput
                    value={phone}
                    onChangeText={setPhone}
                    placeholder="(85) 99999-9999"
                    placeholderTextColor={theme.colors.textMuted}
                    keyboardType="phone-pad"
                    autoComplete="tel"
                    editable={!busy}
                    style={{
                      ...theme.text.body,
                      color: theme.colors.textPrimary,
                      borderWidth: 1,
                      borderColor: theme.colors.border,
                      borderRadius: theme.radius.md,
                      paddingHorizontal: theme.space[3],
                      paddingVertical: theme.space[3],
                      minHeight: 44,
                    }}
                    accessibilityLabel="Número de WhatsApp"
                  />
                  <AppButton
                    title={
                      setMutation.isPending ? "Salvando…" : "Salvar WhatsApp"
                    }
                    onPress={() => {
                      void handleSave();
                    }}
                    disabled={busy || phone.trim().length < 8}
                  />
                  {data?.status !== "missing" ? (
                    <AppButton
                      title="Cancelar"
                      variant="ghost"
                      onPress={() => {
                        setEditing(false);
                        setPhone("");
                      }}
                      disabled={busy}
                    />
                  ) : null}
                </>
              ) : (
                <>
                  <View
                    style={{
                      flexDirection: "row",
                      alignItems: "center",
                      gap: theme.space[2],
                    }}
                  >
                    {data?.verified ? (
                      <ShieldCheck
                        size={20}
                        color={theme.palette.success[700]}
                      />
                    ) : (
                      <ShieldAlert
                        size={20}
                        color={theme.palette.warning[700]}
                      />
                    )}
                    <Text
                      style={{
                        ...theme.text.titleSm,
                        fontWeight: theme.weight.semibold,
                        color: theme.colors.textPrimary,
                      }}
                    >
                      {data?.verified
                        ? "WhatsApp verificado"
                        : "Não verificado"}
                    </Text>
                  </View>
                  <Text
                    style={{
                      ...theme.text.body,
                      fontFamily: theme.fontFamily.mono,
                      color: theme.colors.textPrimary,
                    }}
                  >
                    {data?.maskedAddress}
                  </Text>
                  <AppButton
                    title="Verificar WhatsApp"
                    variant="secondary"
                    disabled
                    onPress={() => undefined}
                  />
                  <Text
                    style={{
                      ...theme.text.caption,
                      color: theme.colors.textMuted,
                    }}
                  >
                    A verificação por código chega na próxima etapa (Twilio
                    Verify). Não há OTP nesta versão.
                  </Text>
                  <AppButton
                    title="Alterar número"
                    variant="ghost"
                    onPress={() => setEditing(true)}
                    disabled={busy}
                  />
                  <AppButton
                    title={
                      deactivateMutation.isPending
                        ? "Removendo…"
                        : "Remover WhatsApp"
                    }
                    variant="danger"
                    onPress={() => {
                      void handleDeactivate();
                    }}
                    disabled={busy}
                  />
                </>
              )}
            </Surface>
          )}
        </ScreenContainer>
      </KeyboardAvoidingView>
    </ScreenGradient>
  );
}

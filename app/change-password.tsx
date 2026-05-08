import { useState } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
  Alert,
} from "react-native";
import { useRouter } from "expo-router";
import * as Haptics from "expo-haptics";
import { ChevronLeft, KeyRound, Check, AlertCircle } from "lucide-react-native";
import { ScreenGradient } from "@/components/ui/ScreenGradient";
import { theme } from "@/lib/theme";
import { useAuth } from "@/hooks/use-auth";
import { authApi } from "@/lib/_core/api";

/**
 * Tela "Alterar minha senha". Acessível via Perfil → Alterar senha.
 *
 * Fluxo:
 *   1. Usuário digita senha atual + nova + confirmação
 *   2. Validação client-side (≥8 chars, confirma bate, distinta da atual)
 *   3. POST /api/auth/change-password
 *   4. Sucesso: feedback + volta pro perfil. Sessão atual permanece
 *      válida (server não invalida cookie no change-password — assim o
 *      usuário não é deslogado bruscamente).
 *
 * Limitação conhecida: outras sessões em outros dispositivos NÃO são
 * invalidadas. Se o usuário trocou a senha por desconfiar de
 * comprometimento, ainda precisa fazer logout manual nos outros
 * dispositivos. Frente futura: revogação de sessões antigas.
 */

export default function ChangePasswordScreen() {
  const router = useRouter();
  const { user, isLoading: authLoading } = useAuth();

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [focusedField, setFocusedField] = useState<"current" | "new" | "confirm" | null>(null);

  const handleBack = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    router.back();
  };

  const handleSubmit = async () => {
    setErrorMsg(null);
    setSuccessMsg(null);

    if (!currentPassword || !newPassword || !confirmPassword) {
      setErrorMsg("Preencha todos os campos.");
      return;
    }
    if (newPassword.length < 8) {
      setErrorMsg("A nova senha precisa ter ao menos 8 caracteres.");
      return;
    }
    if (newPassword !== confirmPassword) {
      setErrorMsg("A confirmação não bate com a nova senha.");
      return;
    }
    if (newPassword === currentPassword) {
      setErrorMsg("A nova senha precisa ser diferente da atual.");
      return;
    }

    setSubmitting(true);
    try {
      const result = await authApi.changePassword(currentPassword, newPassword);
      if (!result.ok) {
        setErrorMsg(result.error ?? "Erro ao alterar senha.");
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        setSubmitting(false);
        return;
      }
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setSuccessMsg("Senha alterada com sucesso.");
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      // Pequeno delay para o usuário ver o feedback antes de voltar.
      setTimeout(() => router.back(), 1200);
    } catch (err: any) {
      setErrorMsg(err?.message ?? "Erro inesperado.");
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      setSubmitting(false);
    }
  };

  if (authLoading) {
    return (
      <ScreenGradient>
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator size="large" color={theme.colors.primary} />
        </View>
      </ScreenGradient>
    );
  }

  if (!user) {
    return (
      <ScreenGradient>
        <View className="flex-1 items-center justify-center">
          <AlertCircle size={48} color={theme.colors.textMuted} />
          <Text className="mt-4 text-lg" style={{ color: theme.colors.textMuted }}>
            Faça login para alterar a senha
          </Text>
        </View>
      </ScreenGradient>
    );
  }

  return (
    <ScreenGradient>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 20, paddingBottom: 40 }}>
          {/* Header */}
          <View className="flex-row items-center gap-3 mb-2">
            <TouchableOpacity
              onPress={handleBack}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel="Voltar"
            >
              <ChevronLeft size={28} color={theme.colors.textPrimary} />
            </TouchableOpacity>
            <Text className="text-3xl font-bold" style={{ color: theme.colors.textPrimary }}>
              Alterar senha
            </Text>
          </View>
          <Text className="text-sm mb-6" style={{ color: theme.colors.textMuted }}>
            Mínimo 8 caracteres. Use uma senha que você lembre — não há recuperação por e-mail nesta conta de teste.
          </Text>

          <View
            className="rounded-2xl p-5 gap-4"
            style={{
              backgroundColor: theme.colors.surface,
              borderWidth: 1,
              borderColor: theme.colors.border,
            }}
          >
            {/* Senha atual */}
            <View>
              <Text className="text-sm mb-2" style={{ color: theme.colors.textSecondary, fontWeight: "500" }}>
                Senha atual
              </Text>
              <TextInput
                value={currentPassword}
                onChangeText={setCurrentPassword}
                secureTextEntry
                autoComplete="current-password"
                returnKeyType="next"
                onFocus={() => setFocusedField("current")}
                onBlur={() => setFocusedField(null)}
                placeholderTextColor={theme.colors.textMuted}
                placeholder="Sua senha atual"
                style={{
                  backgroundColor: theme.colors.surface,
                  borderRadius: 8,
                  borderWidth: 1.5,
                  borderColor:
                    focusedField === "current" ? theme.colors.primary : theme.colors.border,
                  paddingHorizontal: 14,
                  paddingVertical: 12,
                  fontSize: 15,
                  color: theme.colors.textPrimary,
                }}
              />
            </View>

            {/* Nova senha */}
            <View>
              <Text className="text-sm mb-2" style={{ color: theme.colors.textSecondary, fontWeight: "500" }}>
                Nova senha
              </Text>
              <TextInput
                value={newPassword}
                onChangeText={setNewPassword}
                secureTextEntry
                autoComplete="new-password"
                returnKeyType="next"
                onFocus={() => setFocusedField("new")}
                onBlur={() => setFocusedField(null)}
                placeholderTextColor={theme.colors.textMuted}
                placeholder="Mínimo 8 caracteres"
                style={{
                  backgroundColor: theme.colors.surface,
                  borderRadius: 8,
                  borderWidth: 1.5,
                  borderColor:
                    focusedField === "new" ? theme.colors.primary : theme.colors.border,
                  paddingHorizontal: 14,
                  paddingVertical: 12,
                  fontSize: 15,
                  color: theme.colors.textPrimary,
                }}
              />
            </View>

            {/* Confirmação */}
            <View>
              <Text className="text-sm mb-2" style={{ color: theme.colors.textSecondary, fontWeight: "500" }}>
                Confirmar nova senha
              </Text>
              <TextInput
                value={confirmPassword}
                onChangeText={setConfirmPassword}
                secureTextEntry
                autoComplete="new-password"
                returnKeyType="done"
                onSubmitEditing={handleSubmit}
                onFocus={() => setFocusedField("confirm")}
                onBlur={() => setFocusedField(null)}
                placeholderTextColor={theme.colors.textMuted}
                placeholder="Repita a nova senha"
                style={{
                  backgroundColor: theme.colors.surface,
                  borderRadius: 8,
                  borderWidth: 1.5,
                  borderColor:
                    focusedField === "confirm" ? theme.colors.primary : theme.colors.border,
                  paddingHorizontal: 14,
                  paddingVertical: 12,
                  fontSize: 15,
                  color: theme.colors.textPrimary,
                }}
              />
            </View>

            {/* Erro */}
            {errorMsg ? (
              <View
                style={{
                  backgroundColor: theme.colors.dangerSoft,
                  borderRadius: 8,
                  padding: 12,
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 8,
                }}
              >
                <AlertCircle size={18} color={theme.palette.danger[600]} />
                <Text style={{ color: theme.palette.danger[600], fontSize: 14, flex: 1 }}>
                  {errorMsg}
                </Text>
              </View>
            ) : null}

            {/* Sucesso */}
            {successMsg ? (
              <View
                style={{
                  backgroundColor: theme.colors.successSoft,
                  borderRadius: 8,
                  padding: 12,
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 8,
                }}
              >
                <Check size={18} color={theme.palette.success[700]} />
                <Text style={{ color: theme.palette.success[700], fontSize: 14, flex: 1 }}>
                  {successMsg}
                </Text>
              </View>
            ) : null}

            {/* CTA */}
            <TouchableOpacity
              onPress={handleSubmit}
              disabled={submitting}
              activeOpacity={0.85}
              accessibilityRole="button"
              accessibilityLabel="Salvar nova senha"
              style={{
                backgroundColor: theme.colors.primary,
                height: 48,
                borderRadius: 8,
                alignItems: "center",
                justifyContent: "center",
                flexDirection: "row",
                gap: 8,
                opacity: submitting ? 0.7 : 1,
                marginTop: 4,
              }}
            >
              {submitting ? (
                <ActivityIndicator color={theme.colors.surface} />
              ) : (
                <>
                  <KeyRound size={18} color={theme.colors.surface} />
                  <Text style={{ color: theme.colors.surface, fontSize: 16, fontWeight: "600" }}>
                    Alterar senha
                  </Text>
                </>
              )}
            </TouchableOpacity>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </ScreenGradient>
  );
}

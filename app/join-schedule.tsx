import { useState } from "react";
import { ActivityIndicator, Text, TextInput, View } from "react-native";
import { useRouter } from "expo-router";
import { ScreenGradient } from "@/components/ui/ScreenGradient";
import { ScreenContainer } from "@/components/ui/ScreenContainer";
import { AppButton } from "@/components/ui/AppButton";
import { theme } from "@/lib/theme";
import { authApi } from "@/lib/_core/api";
import { trpc } from "@/lib/trpc";
import { uiAlert } from "@/lib/ui/alert";

export default function JoinScheduleScreen() {
  const router = useRouter();
  const utils = trpc.useUtils();
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const handleJoin = async () => {
    if (!code.trim()) {
      uiAlert("Convite", "Cole o código que o gestor enviou.");
      return;
    }
    setSubmitting(true);
    try {
      const result = await authApi.redeemInvite(code.trim());
      if (!result.ok) {
        uiAlert("Não foi possível entrar", result.error ?? "Convite inválido");
        return;
      }
      await Promise.all([
        utils.scheduleContexts.listMine.invalidate(),
        utils.professionals.getMyCapabilities.invalidate(),
      ]);
      uiAlert(
        "Escala liberada",
        result.hospitalName && result.sectorName
          ? `Você entrou em ${result.hospitalName} — ${result.sectorName}.`
          : "O convite foi aceito.",
      );
      router.back();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <ScreenGradient scrollable>
      <ScreenContainer>
        <Text
          style={{
            ...theme.text.title,
            fontWeight: theme.weight.bold,
            color: theme.colors.textPrimary,
            marginBottom: theme.space[2],
          }}
        >
          Entrar em outra escala
        </Text>
        <Text
          style={{
            ...theme.text.body,
            color: theme.colors.textSecondary,
            marginBottom: theme.space[5],
          }}
        >
          Se você também cobre outro setor, peça o convite daquele setor ao
          gestor e cole aqui. A especialidade precisa ser aceita na escala.
        </Text>
        <Text
          style={{
            fontSize: 11,
            fontWeight: "600",
            color: theme.colors.textDisabled,
            letterSpacing: 1.5,
            textTransform: "uppercase",
            marginBottom: 6,
          }}
        >
          Convite
        </Text>
        <TextInput
          value={code}
          onChangeText={setCode}
          autoCapitalize="characters"
          autoCorrect={false}
          placeholder="ABCD-EFGH"
          placeholderTextColor={theme.colors.textMuted}
          style={{
            backgroundColor: theme.colors.surface,
            borderRadius: 10,
            borderWidth: 1.5,
            borderColor: theme.colors.border,
            paddingHorizontal: 16,
            paddingVertical: 14,
            fontSize: 16,
            color: theme.colors.textPrimary,
            marginBottom: theme.space[4],
          }}
        />
        <AppButton
          title={submitting ? "Entrando..." : "Entrar na escala"}
          onPress={handleJoin}
          disabled={submitting}
          fullWidth
        />
        {submitting ? (
          <View style={{ marginTop: theme.space[3] }}>
            <ActivityIndicator color={theme.colors.primary} />
          </View>
        ) : null}
      </ScreenContainer>
    </ScreenGradient>
  );
}

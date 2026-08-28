// Botão central da barra inferior: microfone navy elevado, anel de
// papel e sombra de floating. Não é aba — é comando.

import { Pressable, Text, View } from "react-native";
import { Mic } from "lucide-react-native";
import { theme } from "@/lib/theme";

export function VoiceTabTrigger({
  onPress,
  listening = false,
}: {
  onPress: () => void;
  listening?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel="Comando de voz"
      accessibilityState={{ busy: listening }}
      style={({ pressed }) => ({
        alignItems: "center",
        justifyContent: "flex-end",
        width: theme.space[20],
        marginTop: -theme.space[6],
        opacity: pressed ? 0.9 : 1,
      })}
    >
      <View
        style={{
          width: theme.space[14],
          height: theme.space[14],
          borderRadius: theme.radius.full,
          backgroundColor: listening
            ? theme.colors.danger
            : theme.colors.brand,
          borderWidth: 4,
          borderColor: theme.colors.surface,
          alignItems: "center",
          justifyContent: "center",
          ...theme.shadow.lg,
        }}
      >
        <Mic size={24} color={theme.colors.onDark.text} />
      </View>
      <Text
        style={{
          ...theme.text.caption,
          marginTop: theme.space[1],
          fontWeight: theme.weight.bold,
          color: listening ? theme.colors.danger : theme.colors.brand,
        }}
      >
        Voz
      </Text>
    </Pressable>
  );
}

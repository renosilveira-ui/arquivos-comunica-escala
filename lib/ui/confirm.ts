import { Platform, Alert } from "react-native";

/**
 * Cross-platform confirmation dialog.
 * - Web: uses window.confirm()
 * - Native: uses Alert.alert()
 */
export async function confirmAction(message: string): Promise<boolean> {
  if (Platform.OS === "web") {
    return window.confirm(message);
  }

  return new Promise((resolve) => {
    Alert.alert("Confirmar", message, [
      { text: "Cancelar", style: "cancel", onPress: () => resolve(false) },
      { text: "OK", onPress: () => resolve(true) },
    ]);
  });
}

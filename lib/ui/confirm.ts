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

/**
 * Confirmação de ação IRREVERSÍVEL (aprovar/rejeitar/aceitar troca,
 * remover alocação). Promise<boolean> nos dois ambientes — o caller faz
 * `if (!(await confirmDestructive(...))) return;` sem branch por plataforma.
 */
export function confirmDestructive(
  title: string,
  message: string,
  confirmLabel = "Confirmar",
): Promise<boolean> {
  if (Platform.OS === "web") {
    return Promise.resolve(window.confirm(`${title}\n\n${message}`));
  }
  return new Promise((resolve) => {
    Alert.alert(
      title,
      message,
      [
        { text: "Cancelar", style: "cancel", onPress: () => resolve(false) },
        { text: confirmLabel, style: "destructive", onPress: () => resolve(true) },
      ],
      { cancelable: true, onDismiss: () => resolve(false) },
    );
  });
}

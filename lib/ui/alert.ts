// lib/ui/alert.ts — Alert cross-platform.
//
// Alert.alert do React Native é NO-OP no react-native-web: a chamada
// silenciosamente não mostra nada e os callbacks nunca disparam —
// telas que dependiam do onPress do "OK" para navegar simplesmente
// morriam no web (audit de contraste/UX 2026-08, findings em
// confirm-duty, nominate-replacement e edit-shift).
//
// - uiAlert: informativo com callback opcional. Web = window.alert
//   (bloqueante; callback roda após fechar).
// - uiConfirmDestructive: confirmação de 2 botões. Web =
//   window.confirm. Native = Alert.alert com estilo destructive.
//
// Para confirmações genéricas já existe lib/ui/confirm.ts
// (confirmAction) — mantido; este módulo cobre alert-com-callback.

import { Alert, Platform } from "react-native";

export function uiAlert(title: string, message: string, onOk?: () => void): void {
  if (Platform.OS === "web") {
    window.alert(`${title}\n\n${message}`);
    onOk?.();
    return;
  }
  Alert.alert(title, message, [{ text: "OK", onPress: onOk }]);
}

export function uiConfirmDestructive(
  title: string,
  message: string,
  confirmLabel: string,
  onConfirm: () => void,
): void {
  if (Platform.OS === "web") {
    if (window.confirm(`${title}\n\n${message}`)) onConfirm();
    return;
  }
  Alert.alert(title, message, [
    { text: "Cancelar", style: "cancel" },
    { text: confirmLabel, style: "destructive", onPress: onConfirm },
  ]);
}

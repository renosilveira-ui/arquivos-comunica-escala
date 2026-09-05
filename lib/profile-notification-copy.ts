/**
 * Copy read-only da seção Notificações no Perfil.
 *
 * Não há preferência granular persistida. A UI não pode parecer um
 * controle de tipos de aviso.
 */
export const PROFILE_NOTIFICATION_COPY = {
  sectionTitle: "Notificações",
  sectionEyebrow: "Avisos",
  rowTitle: "Avisos operacionais",
  body: "Os avisos operacionais do Escala+ são enviados conforme sua participação nas escalas e as permissões de notificação do dispositivo.",
  deviceHint:
    "Você pode alterar a permissão geral de notificações nas configurações do aparelho.",
} as const;

export const PROFILE_NOTIFICATION_ACCESSIBILITY_LABEL = [
  PROFILE_NOTIFICATION_COPY.rowTitle,
  PROFILE_NOTIFICATION_COPY.body,
  PROFILE_NOTIFICATION_COPY.deviceHint,
].join(". ");

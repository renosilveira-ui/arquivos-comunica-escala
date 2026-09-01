import * as Notifications from "expo-notifications";
import { shouldPresentForegroundNotification } from "./notification-foreground-subject";

export const HIDE_FOREGROUND_NOTIFICATION = Object.freeze({
  shouldShowAlert: false,
  shouldPlaySound: false,
  shouldSetBadge: false,
  shouldShowBanner: false,
  shouldShowList: false,
});

export const PRESENT_FOREGROUND_NOTIFICATION = Object.freeze({
  shouldShowAlert: true,
  shouldPlaySound: true,
  shouldSetBadge: true,
  shouldShowBanner: true,
  shouldShowList: true,
});

// Único handler process-wide. Em foreground, payload sem recipient ou sem
// sujeito VERIFIED fica silencioso: o listener de rotas não é uma barreira de
// apresentação visual e pode montar tarde durante a troca A → B.
Notifications.setNotificationHandler({
  handleNotification: async (notification) =>
    shouldPresentForegroundNotification(notification.request.content.data)
      ? PRESENT_FOREGROUND_NOTIFICATION
      : HIDE_FOREGROUND_NOTIFICATION,
});
